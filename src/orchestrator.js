/**
 * 穗鈅助手 — Orchestrator（訊息處理核心）
 *
 * 平台無關。Adapter 把 raw 訊息標準化為 normalizedMsg 後丟進來，
 * 取回平台無關的 normalizedResponse（{ text, buttons, images }）。
 *
 * @version 2.0.0
 */

const config = require('./config');
const llm = require('./llm-adapter');
const promptLoader = require('./prompt-loader');
const { loadAllSkills } = require('./skill-loader');
const toolExecutor = require('./tool-executor');
const memoryManager = require('./memory-manager');
const dailyLog = require('./daily-log');
const session = require('./session');
const ism = require('./interactive-session');
const auth = require('./auth');

// 載入 agents（觸發 ISM/agentRegistry 註冊）
const orderAgent = require('./agents/order-agent');
const docAgent = require('./agents/doc-agent');
const reminderAgent = require('./agents/reminder-agent');
const adminAgent = require('./agents/admin-agent');

// ============================================================
// danger-confirm ISM handler — 高風險操作確認
// ============================================================

ism.registerHandler('danger-confirm', {
  ttl: 2 * 60 * 1000,

  async onStart() {
    return { text: '' };
  },

  async onCallback(s, action) {
    if (action === 'cancel') {
      return { text: '❌ 已取消操作。', done: true };
    }
    if (action === 'execute') {
      const { skill, args } = s.data;
      try {
        const result = await toolExecutor.execute(
          { function: { name: skill, arguments: JSON.stringify(args) } },
          { userId: s.userId, chatId: s.chatId, _skipHighRisk: true }
        );
        return { text: result.summary || '✅ 操作已執行。', done: true };
      } catch (err) {
        return { text: `執行失敗：${err.message}`, done: true };
      }
    }
    return { text: '', done: true };
  },

  async onTimeout(s) {
    console.log(`[danger-confirm] 確認超時: chat=${s.chatId}`);
  },
});

// ============================================================
// 純函式 helper
// ============================================================

function stripTs(messages) {
  return messages.map(m => {
    const { ts, ...rest } = m;
    return rest;
  });
}

function parseMemoryTags(text) {
  if (!text) return { reply: '', memories: [], logs: [] };

  const memories = [];
  const logs = [];

  const memoryMatches = text.match(/^\[記憶(?::([高低]))?\]\s+(.+)$/gm) || [];
  for (const m of memoryMatches) {
    const parsed = m.match(/^\[記憶(?::([高低]))?\]\s+(.+)$/);
    if (parsed) {
      const level = parsed[1];
      const content = parsed[2].trim();
      let importance;
      if (level === '高') importance = 0.9;
      else if (level === '低') importance = 0.3;
      else importance = 0.6;
      if (content) memories.push({ content, importance });
    }
  }

  const logMatches = text.match(/^\[日誌\]\s+(.+)$/gm) || [];
  for (const l of logMatches) {
    const content = l.replace(/^\[日誌\]\s+/, '').trim();
    if (content) logs.push(content);
  }

  const reply = text
    .replace(/^\[記憶(?::(?:高|低))?\]\s+.+$/gm, '')
    .replace(/^\[日誌\]\s+.+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { reply, memories, logs };
}

function tryRescueToolCall(content) {
  if (!content) return null;
  try {
    const knownSkills = ['set-reminder', 'create-order', 'check-email', 'generate-pdf', 'print-label', 'system-router'];

    const jsonMatch = content.match(/\{\s*"name"\s*:\s*"([\w-]+)"\s*,\s*"arguments"\s*:\s*(\{[^}]*\})\s*\}/);
    if (jsonMatch) {
      const name = jsonMatch[1];
      const args = jsonMatch[2];
      if (knownSkills.includes(name)) {
        JSON.parse(args);
        return { id: `rescued_${Date.now()}`, type: 'function', function: { name, arguments: args } };
      }
    }
    const tagMatch = content.match(/"name"\s*:\s*"([\w-]+)"[\s\S]*?"arguments"\s*:\s*(\{[^}]*\})/);
    if (tagMatch) {
      const name = tagMatch[1];
      const args = tagMatch[2];
      if (knownSkills.includes(name)) {
        JSON.parse(args);
        return { id: `rescued_${Date.now()}`, type: 'function', function: { name, arguments: args } };
      }
    }
  } catch (err) {
    console.warn('[orchestrator] tryRescueToolCall 解析失敗:', err.message);
  }
  return null;
}

// Telegram inline_keyboard → 平台無關 buttons
function inlineKeyboardToButtons(replyMarkup) {
  if (!replyMarkup?.inline_keyboard) return null;
  return replyMarkup.inline_keyboard.map(row =>
    row.map(btn => ({ text: btn.text, data: btn.callback_data }))
  );
}

// 把 ISM / agent 回的 { text, reply_markup, images } 轉平台無關
function normalizeAgentResult(result) {
  if (!result) return null;
  const out = { text: result.text || '' };
  const buttons = inlineKeyboardToButtons(result.reply_markup);
  if (buttons) out.buttons = buttons;
  // select_menu（Discord 專用；Telegram adapter 忽略此欄位）
  if (result.reply_markup?.select_menu) {
    out.selectMenu = result.reply_markup.select_menu;
  }
  if (Array.isArray(result.images) && result.images.length > 0) {
    out.images = result.images.map(img => ({
      localPath: img.localPath || img,
      caption: img.caption || '',
    }));
  }
  return out;
}

// ============================================================
// Orchestrator class
// ============================================================

class Orchestrator {
  constructor() {
    const { definitions } = loadAllSkills();
    this.skillDefinitions = definitions;
    console.log(`[orchestrator] 載入 ${definitions.length} 個 skill definitions`);
  }

  // ============================================================
  // 主入口：處理 normalized 訊息
  // ============================================================

  /**
   * @param {Object} normalizedMsg - { platform, chatId, userId, profile, textContent, attachments, messageId, ... }
   * @returns {Promise<{ text, buttons?, images?, _broadcast? } | null>}
   *   _broadcast: 額外要發到別的 chat 的訊息（例如新用戶通知 admin）
   */
  async handleMessage(normalizedMsg) {
    const { platform, chatId, userId, textContent, attachments, profile, messageId } = normalizedMsg;

    // 1. /id：認證閘前處理（pending/blocked 也能用）
    if (textContent === '/id') {
      return this._handleIdCommand(normalizedMsg);
    }

    // 2. 認證閘
    const authResult = await auth.authenticate({ platform, chatId, profile });

    if (authResult.status === 'new') {
      // 新用戶：回 pending；附帶 broadcast 給 admin
      return this._handleNewUser(authResult, platform);
    }
    if (authResult.status === 'pending') {
      return { text: adminAgent.MESSAGES.pendingReply };
    }
    if (authResult.status === 'blocked') {
      return null;
    }
    const permissions = authResult.permissions;

    // 3. /reset, /start：平台無關指令
    if (textContent === '/reset' || textContent === '/new') {
      await session.clearHistory(platform, chatId).catch(err =>
        console.error('[orchestrator] 清除對話歷史失敗:', err.message));
      ism.deleteSession(chatId);
      return { text: '🔄 對話已重置' };
    }
    if (textContent === '/start') {
      return { text: '👋 你好！我是穗鈅助手，有什麼可以幫你的？' };
    }

    // 4. 附件處理（PDF / 圖片）
    if (attachments && attachments.length > 0) {
      return this._handleAttachments(normalizedMsg, permissions);
    }

    // 5. 沒文字、也沒附件：忽略
    if (!textContent || !textContent.trim()) {
      return null;
    }

    // 6. ISM session 攔截
    if (ism.hasActiveSession(chatId)) {
      const result = await ism.handleTextInput(chatId, textContent, { userId });
      if (result) {
        return normalizeAgentResult(result);
      }
      // null → 不攔截，繼續走主路徑
    }

    // 7. 關鍵詞攔截
    const intercepted = await this._handleKeywords(normalizedMsg, permissions);
    if (intercepted) return intercepted;

    // 8. Agent loop
    return this._runAgentLoop(normalizedMsg, permissions);
  }

  // ============================================================
  // Callback 入口：來自 button 點擊
  // ============================================================

  /**
   * @param {string} platform
   * @param {string} chatId
   * @param {string} userId
   * @param {string} callbackData - 'agentName:action:payload'
   * @param {string} messageId    - 平台訊息 id（用於 clear button）
   * @returns {Promise<{ text, buttons?, images? } | null>}
   */
  async handleCallback(platform, chatId, userId, callbackData, messageId) {
    const result = await ism.handleCallback(callbackData, { chatId, userId, messageId });

    if (!result) {
      // session 外的 callback：order:pdf:* fallback
      if (callbackData.startsWith('order:pdf:')) {
        return this._handlePdfFallback(callbackData, { platform, chatId, userId });
      }
      return { text: '⏰ 此操作已過期，請重新開始。' };
    }

    const normalized = normalizeAgentResult(result);

    // doc-agent 的 _ambiguous 選好客戶後，鏈到 order session
    if (result._startOrder && result._parsed) {
      const targetChatId = result._chatId || chatId;
      const targetUserId = result._userId || userId;
      const orderResult = await orderAgent.startOrderSession(targetChatId, targetUserId, { parsed: result._parsed });
      if (orderResult) {
        const orderNormalized = normalizeAgentResult(orderResult);
        // 合併 doc-agent 的 text（通常是空字串）+ order 的 text
        const combinedText = [normalized?.text, orderNormalized?.text].filter(Boolean).join('\n\n');
        return {
          text: combinedText,
          buttons: orderNormalized?.buttons || normalized?.buttons,
          selectMenu: orderNormalized?.selectMenu || normalized?.selectMenu,
          images: orderNormalized?.images || normalized?.images,
        };
      }
    }

    return normalized;
  }

  setOnExecuteHook(fn) {
    toolExecutor.setOnExecuteHook(fn);
  }

  // ============================================================
  // 私有：分流 helper
  // ============================================================

  _handleIdCommand(normalizedMsg) {
    const { platform, chatId, profile } = normalizedMsg;
    const lines = [
      `🆔 你的 ${platform} 資訊`,
      ``,
      `Chat ID：\`${chatId}\``,
    ];
    const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
    if (name) lines.push(`名稱：${name}`);
    if (profile.username) {
      lines.push(`Username：@${profile.username}`);
    } else {
      lines.push(`Username：（未設定）`);
    }
    return { text: lines.join('\n') };
  }

  _handleNewUser(authResult, _platform) {
    // broadcast 以 admin 接收端為準，不以申請者 platform
    // 否則 Discord 用戶申請時會把 Telegram adminChatId 送到 Discord adapter，訊息發不出去
    const notification = adminAgent.getNewUserNotification(authResult.user);
    const broadcasts = [];

    if (config.telegram.adminChatId) {
      broadcasts.push({
        platform: 'telegram',
        chatId: config.telegram.adminChatId,
        text: notification.text,
      });
    } else if (config.discord.adminUserIds?.length > 0) {
      // 只有 Discord admin 時才 fallback（避免兩個平台重複通知）
      broadcasts.push({
        platform: 'discord',
        chatId: config.discord.adminUserIds[0],
        text: notification.text,
      });
    }

    return {
      text: adminAgent.MESSAGES.pendingReply,
      _broadcast: broadcasts,
      _newUser: authResult.user,    // adapter 可推給 dashboard ws
    };
  }

  async _handleAttachments(normalizedMsg, permissions) {
    const { platform, chatId, userId, attachments, textContent } = normalizedMsg;

    if (!auth.canUseSkill(permissions, 'create-order')) {
      return { text: '您沒有文件建單的權限。' };
    }

    const docInput = { textContent, attachments };
    const docResult = await docAgent.handleDocument(docInput, { chatId, userId });

    if (!docResult) return null;   // null = 跳過（生活照之類）

    const docNormalized = normalizeAgentResult(docResult);

    // doc-agent 標記要直接啟動 order session（無 _ambiguous 路徑）
    if (docResult._startOrder && docResult._parsed) {
      const orderResult = await orderAgent.startOrderSession(chatId, userId, { parsed: docResult._parsed });
      if (orderResult) {
        const orderNormalized = normalizeAgentResult(orderResult);
        return {
          text: [docNormalized?.text, orderNormalized?.text].filter(Boolean).join('\n\n'),
          buttons: orderNormalized?.buttons,
          selectMenu: orderNormalized?.selectMenu,
          images: orderNormalized?.images,
        };
      }
    }

    return docNormalized;
  }

  async _handleKeywords(normalizedMsg, permissions) {
    const { chatId, userId, textContent } = normalizedMsg;

    // 同步產品（system-router 權限）
    if (/同步產品|sync.?products?/i.test(textContent)) {
      if (!auth.canUseSkill(permissions, 'system-router')) {
        return { text: '您沒有此操作的權限。' };
      }
      try {
        const { syncProducts } = require('../scripts/sync-products');
        const stats = await syncProducts();
        return {
          text: `✅ 產品同步完成\n新增: ${stats.added} | 更新: ${stats.updated} | 停用: ${stats.deactivated} | 跳過: ${stats.skipped} | 失敗: ${stats.failed}`,
        };
      } catch (err) {
        return { text: `❌ 同步失敗: ${err.message}` };
      }
    }

    // 建立訂單
    if (/建立訂單|建單|開單|下訂單/.test(textContent)) {
      if (!auth.canUseSkill(permissions, 'create-order')) {
        return { text: '您沒有建立訂單的權限。' };
      }
      const result = await orderAgent.startOrderSession(chatId, userId, {});
      if (result) return normalizeAgentResult(result);
    }

    // 查看提醒
    if (/查看提醒|我的提醒|有哪些提醒|提醒列表|list.?remind/i.test(textContent)) {
      const result = await reminderAgent.startReminderList(chatId, userId);
      if (result) return normalizeAgentResult(result);
    }

    return null;
  }

  async _handlePdfFallback(callbackData, ctx) {
    const createOrderSkill = require('../skills/create-order');
    const parts = callbackData.split(':');
    const pdfType = parts[2];
    const orderRef = parts.slice(3).join(':');

    if (pdfType === 'skip') {
      return { text: '好的，如需要再告訴我。' };
    }
    try {
      const pdfResult = await createOrderSkill.generatePDF(orderRef, pdfType, { userId: ctx.userId, chatId: ctx.chatId });
      const out = { text: pdfResult?.text || pdfResult?.data || 'PDF 生成完成' };
      if (pdfResult?.localPaths?.length > 0) {
        out.images = pdfResult.localPaths.map(p => ({
          localPath: p.localPath || p,
          caption: p.caption || '',
        }));
      }
      return out;
    } catch (err) {
      return { text: `PDF 生成失敗：${err.message}` };
    }
  }

  // ============================================================
  // Agent loop（LLM + tools）
  // ============================================================

  async _runAgentLoop(normalizedMsg, permissions) {
    const { platform, chatId, userId, textContent } = normalizedMsg;

    // 1. system prompt
    const systemPrompt = await promptLoader.loadSystemPrompt(userId, textContent);

    // 2. 對話歷史
    const { messages: historyFromDb } = await session.loadHistory(platform, chatId);
    const history = [...historyFromDb];
    history.push({ role: 'user', content: textContent, ts: new Date() });

    // 3. 組 messages
    const messages = [
      { role: 'system', content: systemPrompt },
      ...stripTs(history),
    ];

    // 4. 智慧截斷
    const trimmedMessages = await session.trimHistoryWithFlush(messages, userId);

    // 5. Agent loop
    const maxLoop = config.agent.maxLoop;
    let currentMessages = [...trimmedMessages];
    let finalReply = '';

    for (let loop = 0; loop < maxLoop; loop++) {
      const response = await llm.chat({
        messages: currentMessages,
        tools: this.skillDefinitions.length > 0 ? this.skillDefinitions : undefined,
      });

      if (!response.tool_calls || response.tool_calls.length === 0) {
        const rescued = tryRescueToolCall(response.content);
        if (rescued) {
          console.log(`[orchestrator] 從文字內容中救回 tool_call: ${rescued.function.name}`);
          response.tool_calls = [rescued];
        } else {
          finalReply = response.content || '';
          break;
        }
      }

      currentMessages.push({
        role: 'assistant',
        content: response.content || null,
        tool_calls: response.tool_calls,
      });

      let hasReplyMarkup = null;
      let hasImages = null;

      for (const toolCall of response.tool_calls) {
        const funcName = toolCall.function?.name || 'unknown';
        console.log(`[orchestrator] Agent loop ${loop + 1}: 執行 ${funcName}`);

        const result = await toolExecutor.execute(toolCall, { userId, chatId, permissions });

        // 高風險確認 → 啟動 ISM session 直接回按鈕
        if (result._requireConfirmation) {
          const confirmData = result._confirmData;
          await ism.startSession('danger-confirm', {
            chatId,
            userId,
            initialData: {
              skill: confirmData.skill,
              args: confirmData.args,
              description: confirmData.description,
            },
          });
          return {
            text: `⚠️ 高風險操作確認\n\n操作：${confirmData.description}\n\n確定要執行嗎？`,
            buttons: [[
              { text: '✅ 確定執行', data: 'danger-confirm:execute' },
              { text: '❌ 取消',     data: 'danger-confirm:cancel' },
            ]],
          };
        }

        if (result.data && typeof result.data === 'object' && result.data.reply_markup) {
          hasReplyMarkup = result.data;
        } else if (result.reply_markup) {
          hasReplyMarkup = result;
        }

        if (result.localPaths && result.localPaths.length > 0) {
          hasImages = { localPaths: result.localPaths, text: result.data || result.summary };
        }

        currentMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            success: result.success,
            summary: result.summary,
            data: typeof result.data === 'string' ? result.data : result.summary,
          }),
        });
      }

      // 含圖片 → 直接回，不再走 LLM
      if (hasImages) {
        history.push({ role: 'assistant', content: hasImages.text, ts: new Date() });
        session.saveHistory(platform, chatId, userId, history).catch(err =>
          console.error('[orchestrator] 對話歷史儲存失敗:', err.message));
        return {
          text: hasImages.text,
          images: hasImages.localPaths.map(p => ({
            localPath: p.localPath || p,
            caption: p.caption || '',
          })),
        };
      }

      // 含 reply_markup → 直接回
      if (hasReplyMarkup) {
        const text = hasReplyMarkup.data || hasReplyMarkup.summary || '';
        history.push({ role: 'assistant', content: text, ts: new Date() });
        session.saveHistory(platform, chatId, userId, history).catch(err =>
          console.error('[orchestrator] 對話歷史儲存失敗:', err.message));
        return {
          text,
          buttons: inlineKeyboardToButtons(hasReplyMarkup.reply_markup),
        };
      }

      // 達上限 → 強制結束
      if (loop === maxLoop - 1) {
        console.warn(`[orchestrator] Agent 迴圈達到上限 (${maxLoop})，強制結束`);
        const finalResponse = await llm.chat({ messages: currentMessages });
        finalReply = finalResponse.content || '（處理完成，但無法生成回覆）';
      }
    }

    // 6. 解析 [記憶] / [日誌]
    const { reply, memories, logs } = parseMemoryTags(finalReply);

    if (memories.length > 0 || logs.length > 0) {
      Promise.all([
        ...memories.map(mem =>
          memoryManager.saveMemory(userId, mem.content, 'LLM 回覆', { importance: mem.importance })
            .catch(err => console.error('[orchestrator] 記憶存入失敗:', err.message))),
        ...logs.map(log =>
          dailyLog.appendLog(userId, { type: 'note', content: log })
            .catch(err => console.error('[orchestrator] 日誌存入失敗:', err.message))),
      ]).catch(() => {});
    }

    // 7. 對話歷史 update
    history.push({ role: 'assistant', content: finalReply, ts: new Date() });
    while (history.length > config.session.maxRounds * 2) history.shift();
    session.saveHistory(platform, chatId, userId, history).catch(err =>
      console.error('[orchestrator] 對話歷史儲存失敗:', err.message));

    if (!reply && (memories.length > 0 || logs.length > 0)) {
      return { text: '已記住。' };
    }
    return { text: reply || finalReply };
  }
}

module.exports = new Orchestrator();
