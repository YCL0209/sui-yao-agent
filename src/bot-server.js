/**
 * 穗鈅助手 — Bot Server（核心）
 *
 * Telegram bot + Agent 迴圈，串接所有模組。
 *
 * 訊息處理流程：
 *   用戶訊息 → prompt-loader 組裝 system prompt
 *   → llm-adapter.chat() 呼叫 LLM（含 tools）
 *   → Agent 迴圈（tool_call → tool-executor → 結果回饋 → 直到一般回覆）
 *   → 解析 [記憶]/[日誌] 標記 → 回覆用戶
 *
 * @version 1.0.0
 */

const TelegramBot = require('node-telegram-bot-api');
const config = require('./config');
const llm = require('./llm-adapter');
const promptLoader = require('./prompt-loader');
const { loadAllSkills } = require('./skill-loader');
const toolExecutor = require('./tool-executor');
const memoryManager = require('./memory-manager');
const dailyLog = require('./daily-log');
const session = require('./session');
const mongo = require('../lib/mongodb-tools');
const createOrderSkill = require('../skills/create-order');
const ism = require('./interactive-session');
const orderAgent = require('./agents/order-agent');       // 觸發 ISM/agentRegistry 註冊
const docAgent = require('./agents/doc-agent');           // 觸發 ISM/agentRegistry 註冊
const reminderAgent = require('./agents/reminder-agent'); // 觸發 ISM/agentRegistry 註冊
const adminAgent = require('./agents/admin-agent');       // 觸發 ISM/agentRegistry 註冊
const auth = require('./auth');
const dashboard = require('./dashboard/server');
const wsManager = require('./dashboard/ws-manager');

// ============================================================
// 啟動
// ============================================================

// 載入 skill definitions（給 LLM function calling 用）
const { definitions } = loadAllSkills();
console.log(`[bot-server] 載入 ${definitions.length} 個 skill definitions`);

// Concurrency 控制：per-chatId Promise chain，同一用戶訊息序列化處理
const chatLocks = new Map();

// ============================================================
// 對話歷史 — MongoDB 持久化
// ============================================================

/**
 * 從 MongoDB 取得對話歷史
 * @param {number|string} chatId
 * @returns {Promise<Array>} messages 陣列
 */
async function getHistory(chatId) {
  const db = await mongo.getDb();
  const doc = await db.collection('conversations').findOne({ chatId: Number(chatId) });
  return doc?.messages || [];
}

/**
 * 儲存對話歷史到 MongoDB
 * @param {number|string} chatId
 * @param {string} userId
 * @param {Array} messages — 完整的 messages 陣列
 */
async function saveHistory(chatId, userId, messages) {
  const db = await mongo.getDb();
  const maxMessages = config.conversation?.maxMessages || 200;
  const trimmed = messages.length > maxMessages
    ? messages.slice(-maxMessages)
    : messages;

  await db.collection('conversations').updateOne(
    { chatId: Number(chatId) },
    {
      $set: {
        userId,
        messages: trimmed,
        updatedAt: new Date(),
      },
      $setOnInsert: { chatId: Number(chatId) },
    },
    { upsert: true }
  );
}

/**
 * 清除對話歷史
 * @param {number|string} chatId
 */
async function clearHistory(chatId) {
  const db = await mongo.getDb();
  await db.collection('conversations').deleteOne({ chatId: Number(chatId) });
}

/**
 * 從 messages 陣列剝掉 ts 欄位（送 LLM 用，OpenAI 不需要 ts）
 * @param {Array} messages
 * @returns {Array}
 */
function stripTs(messages) {
  return messages.map(m => {
    const { ts, ...rest } = m;
    return rest;
  });
}

// ============================================================
// [記憶] / [日誌] 標記解析
// ============================================================

/**
 * 解析回覆中的 [記憶] 和 [日誌] 標記
 *
 * @param {string} text - LLM 回覆文字
 * @returns {{ reply: string, memories: string[], logs: string[] }}
 */
/**
 * 解析回覆中的 [記憶] 和 [日誌] 標記
 * 支援 [記憶:高] [記憶] [記憶:低] 三級重要性
 *
 * @param {string} text - LLM 回覆文字
 * @returns {{ reply: string, memories: Array<{content, importance}>, logs: string[] }}
 */
function parseMemoryTags(text) {
  if (!text) return { reply: '', memories: [], logs: [] };

  const memories = [];
  const logs = [];

  // 匹配 [記憶]、[記憶:高]、[記憶:低]
  const memoryMatches = text.match(/^\[記憶(?::([高低]))?\]\s+(.+)$/gm) || [];
  for (const m of memoryMatches) {
    const parsed = m.match(/^\[記憶(?::([高低]))?\]\s+(.+)$/);
    if (parsed) {
      const level = parsed[1]; // '高' | '低' | undefined
      const content = parsed[2].trim();
      let importance;
      if (level === '高') importance = 0.9;
      else if (level === '低') importance = 0.3;
      else importance = 0.6; // 沒標等級，預設 0.6
      if (content) memories.push({ content, importance });
    }
  }

  const logMatches = text.match(/^\[日誌\]\s+(.+)$/gm) || [];
  for (const l of logMatches) {
    const content = l.replace(/^\[日誌\]\s+/, '').trim();
    if (content) logs.push(content);
  }

  // 移除行首的標記行（包含新格式）
  const reply = text
    .replace(/^\[記憶(?::(?:高|低))?\]\s+.+$/gm, '')
    .replace(/^\[日誌\]\s+.+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { reply, memories, logs };
}

// ============================================================
// Agent 迴圈
// ============================================================

/**
 * 處理單次訊息的完整 Agent 迴圈
 *
 * @param {string} userId - 用戶 ID
 * @param {string} userMessage - 用戶訊息
 * @param {string} chatId - Telegram chat ID
 * @returns {Promise<{ reply: string, reply_markup?: Object }>} 最終回覆
 */
async function handleMessage(userId, userMessage, chatId, permissions = null) {
  // 1. 組裝 system prompt
  const systemPrompt = await promptLoader.loadSystemPrompt(userId, userMessage);

  // 2. 從 MongoDB 取得對話歷史
  const history = await getHistory(chatId);

  // 加入用戶訊息（含 ts，DB 保留；送 LLM 時會剝掉）
  history.push({ role: 'user', content: userMessage, ts: new Date() });

  // 3. 組裝 messages（剝掉 ts，乾淨送 LLM）
  const messages = [
    { role: 'system', content: systemPrompt },
    ...stripTs(history),
  ];

  // 4. 智慧截斷（帶 pre-flush）
  const trimmedMessages = await session.trimHistoryWithFlush(messages, userId);

  // 5. Agent 迴圈
  const maxLoop = config.agent.maxLoop;
  let currentMessages = [...trimmedMessages];
  let finalReply = '';

  for (let loop = 0; loop < maxLoop; loop++) {
    const response = await llm.chat({
      model: config.llm.defaultModel,
      messages: currentMessages,
      tools: definitions.length > 0 ? definitions : undefined,
    });

    // 一般回覆（無 tool_call）→ 結束迴圈
    if (!response.tool_calls || response.tool_calls.length === 0) {
      finalReply = response.content || '';
      break;
    }

    // 有 tool_call → 執行
    // 先把 assistant 的 tool_calls 回覆加入 messages
    currentMessages.push({
      role: 'assistant',
      content: response.content || null,
      tool_calls: response.tool_calls,
    });

    let hasReplyMarkup = null;
    let hasImages = null;

    for (const toolCall of response.tool_calls) {
      const funcName = toolCall.function?.name || 'unknown';
      console.log(`[bot-server] Agent loop ${loop + 1}: 執行 ${funcName}`);

      const result = await toolExecutor.execute(toolCall, { userId, chatId, permissions });

      // 如果 tool 結果含 reply_markup（互動式按鈕），直接回傳給用戶
      if (result.data && typeof result.data === 'object' && result.data.reply_markup) {
        hasReplyMarkup = result.data;
      } else if (result.reply_markup) {
        hasReplyMarkup = result;
      }

      // 如果 tool 結果含 localPaths（圖片），記錄下來
      if (result.localPaths && result.localPaths.length > 0) {
        hasImages = { localPaths: result.localPaths, text: result.data || result.summary };
      }

      // 把 tool 結果塞回 messages（OpenAI 標準格式）
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

    // 含圖片的結果直接回傳，不再經過 LLM
    if (hasImages) {
      history.push({ role: 'assistant', content: hasImages.text, ts: new Date() });
      saveHistory(chatId, userId, history).catch(err =>
        console.error('[bot-server] 對話歷史儲存失敗:', err.message)
      );
      return { reply: hasImages.text, images: hasImages.localPaths };
    }

    // 含 reply_markup 的結果直接回傳，不再經過 LLM
    if (hasReplyMarkup) {
      const text = hasReplyMarkup.data || hasReplyMarkup.summary || '';
      history.push({ role: 'assistant', content: text, ts: new Date() });
      saveHistory(chatId, userId, history).catch(err =>
        console.error('[bot-server] 對話歷史儲存失敗:', err.message)
      );
      return { reply: text, reply_markup: hasReplyMarkup.reply_markup };
    }

    // 如果到達最後一輪，強制取得回覆
    if (loop === maxLoop - 1) {
      console.warn(`[bot-server] Agent 迴圈達到上限 (${maxLoop})，強制結束`);
      const finalResponse = await llm.chat({
        model: config.llm.defaultModel,
        messages: currentMessages,
      });
      finalReply = finalResponse.content || '（處理完成，但無法生成回覆）';
    }
  }

  // 6. 解析 [記憶] / [日誌] 標記
  const { reply, memories, logs } = parseMemoryTags(finalReply);

  // 存入記憶和日誌（fire-and-forget，不阻塞回覆）
  if (memories.length > 0 || logs.length > 0) {
    Promise.all([
      ...memories.map(mem =>
        memoryManager.saveMemory(userId, mem.content, 'LLM 回覆', { importance: mem.importance })
          .catch(err => console.error('[bot-server] 記憶存入失敗:', err.message))
      ),
      ...logs.map(log =>
        dailyLog.appendLog(userId, { type: 'note', content: log })
          .catch(err => console.error('[bot-server] 日誌存入失敗:', err.message))
      ),
    ]).catch(() => {});
  }

  // 7. 更新對話歷史
  history.push({ role: 'assistant', content: finalReply, ts: new Date() });

  // 限制歷史長度（記憶體層級截斷；DB 端 saveHistory 也會用 maxMessages 截）
  while (history.length > config.session.maxRounds * 2) {
    history.shift();
  }

  // 寫回 DB（fire-and-forget，不阻塞回覆）
  saveHistory(chatId, userId, history).catch(err =>
    console.error('[bot-server] 對話歷史儲存失敗:', err.message)
  );

  // reply 為空字串但有記憶/日誌被存入時，回覆確認訊息
  if (!reply && (memories.length > 0 || logs.length > 0)) {
    return { reply: '已記住。' };
  }
  return { reply: reply ?? finalReply };
}

// ============================================================
// 錯誤通知
// ============================================================

async function notifyError(bot, error, context = '') {
  if (!config.error.notifyEnabled) return;
  if (!config.telegram.adminChatId) return;

  try {
    const msg = `⚠️ 穗鈅助手錯誤\n\n${context}\n${error.message || error}`.slice(0, 4000);
    await bot.sendMessage(config.telegram.adminChatId, msg);
  } catch (_) {
    // 通知失敗就算了
  }
}

// ============================================================
// Telegram Bot 啟動
// ============================================================

// ============================================================
// 回覆輔助（支援 reply_markup）
// ============================================================

/**
 * 送出回覆，支援 inline keyboard
 * @param {TelegramBot} bot
 * @param {number} chatId
 * @param {string} text - 回覆文字
 * @param {Object} [replyMarkup] - Telegram reply_markup
 */
async function sendReply(bot, chatId, text, replyMarkup) {
  if (!text) return;
  const opts = replyMarkup ? { reply_markup: replyMarkup } : {};
  const MAX_LEN = 4096;
  if (text.length > MAX_LEN) {
    const chunks = text.match(/[\s\S]{1,4096}/g) || [text];
    for (let i = 0; i < chunks.length; i++) {
      // 只在最後一塊帶按鈕
      const chunkOpts = (i === chunks.length - 1) ? opts : {};
      await bot.sendMessage(chatId, chunks[i], chunkOpts);
    }
  } else {
    await bot.sendMessage(chatId, text, opts);
  }
}

/**
 * 送出 skill 結果（自動處理 reply_markup）
 */
async function sendSkillResult(bot, chatId, result) {
  if (!result) return;
  const text = result.data || result.summary || '';
  await sendReply(bot, chatId, text, result.reply_markup);
}

function startBot() {
  // 啟動時確保所有 MongoDB 索引存在（冪等）
  const { ensureAllIndexes } = require('../scripts/ensure-indexes');
  ensureAllIndexes().catch(err =>
    console.error('[bot-server] ensureAllIndexes 失敗:', err.message)
  );

  const bot = new TelegramBot(config.telegram.botToken, { polling: true });

  // ---- callback_query handler（Inline keyboard 按鈕） ----
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const userId = `telegram:${chatId}`;

    console.log(`[bot] callback_query: ${data} (chat: ${chatId})`);

    try {
      // ======== Admin 審核 callback 短路（不走 ISM）========
      if (data.startsWith('admin:')) {
        const adminChatId = Number(config.telegram.adminChatId);
        if (chatId !== adminChatId) {
          await bot.answerCallbackQuery(query.id, { text: '無權限' });
          return;
        }
        const parts = data.split(':');
        const action = parts[1];
        const targetChatId = Number(parts[2]);
        const role = parts[3] || 'user';

        if (action === 'approve') {
          const roleName = role === 'advanced' ? '高級用戶' : '一般用戶';
          await auth.approveUser(targetChatId, 'approve', role, userId);
          await sendReply(bot, chatId, `✅ 已核准 ${targetChatId} 為${roleName}`);
          try { await bot.sendMessage(targetChatId, adminAgent.MESSAGES.welcomeAfterApproval); } catch (_) {}
        } else if (action === 'block') {
          await auth.approveUser(targetChatId, 'block', null, userId);
          await sendReply(bot, chatId, `🚫 已封鎖 ${targetChatId}`);
        } else if (action === 'setrole') {
          const newRole = parts[3] || 'user';
          const roleLabels = { admin: '管理員', advanced: '高級用戶', user: '一般用戶' };
          await auth.setUserRole(targetChatId, newRole);
          await sendReply(bot, chatId, `✅ 已將 ${targetChatId} 角色改為「${roleLabels[newRole] || newRole}」`);
          try { await bot.sendMessage(targetChatId, `📢 您的角色已更新為「${roleLabels[newRole] || newRole}」。`); } catch (_) {}
        }

        try {
          await bot.editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: chatId, message_id: query.message.message_id }
          );
        } catch (_) {}
        await bot.answerCallbackQuery(query.id);
        return;
      }

      // ======== 主路徑：交給 ISM ========
      const result = await ism.handleCallback(data, {
        chatId,
        userId,
        messageId: query.message.message_id,
      });

      if (result) {
        if (result.text) {
          await sendReply(bot, chatId, result.text, result.reply_markup);
        }
        if (result.images && result.images.length > 0) {
          const fs = require('fs');
          for (const img of result.images) {
            try {
              const filePath = img.localPath || img;
              await bot.sendPhoto(chatId, fs.createReadStream(filePath), { caption: img.caption || '' });
            } catch (imgErr) {
              console.error('[bot-server] 發送圖片失敗:', imgErr.message);
            }
          }
        }
        // doc-agent 的 pickcustomer callback 完成後，啟動 order session
        if (result._startOrder && result._parsed) {
          const targetChatId = result._chatId || chatId;
          const targetUserId = result._userId || userId;
          const orderResult = await orderAgent.startOrderSession(targetChatId, targetUserId, { parsed: result._parsed });
          if (orderResult && orderResult.text) {
            await sendReply(bot, targetChatId, orderResult.text, orderResult.reply_markup);
          }
        }
      } else {
        // ======== Fallback：session 外的 callback ========

        // PDF 按鈕：在 order:confirm 回傳 done:true 之後才按，session 已清除
        if (data.startsWith('order:pdf:')) {
          const parts = data.split(':');
          const pdfType = parts[2];
          const orderRef = parts.slice(3).join(':');
          if (pdfType === 'skip') {
            await sendReply(bot, chatId, '好的，如需要再告訴我。');
          } else {
            try {
              const pdfResult = await createOrderSkill.generatePDF(orderRef, pdfType, { userId, chatId });
              if (pdfResult && pdfResult.localPaths) {
                await sendReply(bot, chatId, pdfResult.text);
                const fs = require('fs');
                for (const img of pdfResult.localPaths) {
                  try {
                    await bot.sendPhoto(chatId, fs.createReadStream(img.localPath || img), { caption: img.caption || '' });
                  } catch (imgErr) {
                    console.error('[bot-server] 發送圖片失敗:', imgErr.message);
                  }
                }
              } else {
                await sendReply(bot, chatId, pdfResult?.text || 'PDF 生成完成');
              }
            } catch (err) {
              await sendReply(bot, chatId, `PDF 生成失敗：${err.message}`);
            }
          }
        }

        // 殭屍按鈕兜底：session 已過期或未知 callback
        else {
          await sendReply(bot, chatId, '⏰ 此操作已過期，請重新開始。');
        }
      }

      // 統一清除按鈕（每個 callback 按完，原訊息的按鈕都拿掉）
      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          { chat_id: chatId, message_id: query.message.message_id }
        );
      } catch (_) {}

      // 回應 Telegram（移除按鈕上的 loading）
      await bot.answerCallbackQuery(query.id);
    } catch (err) {
      console.error(`[bot-server] callback_query 處理失敗:`, err);
      await bot.answerCallbackQuery(query.id, { text: '處理失敗，請重試' });
      await notifyError(bot, err, `Callback: ${data}\nChat: ${chatId}`);
    }
  });

  // ---- message handler ----
  bot.on('message', async (msg) => {
    console.log('[bot] 收到:', msg.text);
    const chatId = msg.chat.id;
    const userId = `telegram:${chatId}`;
    const text = msg.text;

    // /id 指令：在認證閘之前處理，讓所有人（含 pending/blocked）都能查自己的 chatId
    if (text === '/id') {
      const from = msg.from || {};
      const lines = [
        `🆔 你的 Telegram 資訊`,
        ``,
        `Chat ID：\`${chatId}\``,
        from.first_name ? `名稱：${[from.first_name, from.last_name].filter(Boolean).join(' ')}` : null,
        from.username ? `Username：@${from.username}` : `Username：（未設定）`,
      ].filter(Boolean).join('\n');
      try { await bot.sendMessage(chatId, lines, { parse_mode: 'Markdown' }); } catch (_) {
        await bot.sendMessage(chatId, lines);
      }
      return;
    }

    // ======== 認證閘 ========
    const authResult = await auth.authenticate(msg);

    if (authResult.status === 'new') {
      await bot.sendMessage(chatId, adminAgent.MESSAGES.pendingReply);
      const notification = adminAgent.getNewUserNotification(authResult.user);
      const adminChatId = config.telegram.adminChatId;
      if (adminChatId) {
        await sendReply(bot, Number(adminChatId), notification.text, notification.reply_markup);
      }
      // Dashboard 推播
      try { wsManager.broadcast('new_user', { user: authResult.user }); } catch (_) {}
      return;
    }
    if (authResult.status === 'pending') {
      await bot.sendMessage(chatId, adminAgent.MESSAGES.pendingReply);
      return;
    }
    if (authResult.status === 'blocked') {
      return; // 不回覆
    }

    const permissions = authResult.permissions;
    // ========================

    // ---- 非文字訊息處理（PDF / 圖片 → doc-agent） ----
    if (!text) {
      if (msg.document || msg.photo) {
        // 文件建單需要 create-order 權限
        if (!auth.canUseSkill(permissions, 'create-order')) {
          await bot.sendMessage(chatId, '您沒有文件建單的權限。');
          return;
        }
        const prev = chatLocks.get(chatId) || Promise.resolve();
        const current = prev.then(async () => {
          try {
            await bot.sendChatAction(chatId, 'typing');

            const result = await docAgent.handleDocument(msg, bot, { chatId, userId });

            if (!result) return; // null = 跳過（非商業內容）

            // 送出分類/解析結果
            if (result.text) {
              await sendReply(bot, chatId, result.text, result.reply_markup);
            }

            // doc-agent 標記要啟動 order session
            if (result._startOrder && result._parsed) {
              const orderResult = await orderAgent.startOrderSession(chatId, userId, { parsed: result._parsed });
              if (orderResult && orderResult.text) {
                await sendReply(bot, chatId, orderResult.text, orderResult.reply_markup);
              }
            }
          } catch (err) {
            console.error(`[bot-server] 文件處理失敗:`, err);
            await bot.sendMessage(chatId, `處理失敗：${err.message}`);
            await notifyError(bot, err, `Document/Photo\nChat: ${chatId}`);
          }
        });
        chatLocks.set(chatId, current.catch(() => {}));
      }
      return;
    }

    // reset 指令（同時清除建單 session）
    if (text === '/reset' || text === '/new') {
      clearHistory(chatId).catch(err =>
        console.error('[bot-server] 清除對話歷史失敗:', err.message)
      );
      ism.deleteSession(chatId);
      await bot.sendMessage(chatId, '🔄 對話已重置');
      return;
    }

    // /start 指令
    if (text === '/start') {
      await bot.sendMessage(chatId, '👋 你好！我是穗鈅助手，有什麼可以幫你的？');
      return;
    }

    // ---- Admin 用戶管理指令（只有 admin chatId 能用） ----
    const isAdminChat = chatId === Number(config.telegram.adminChatId);
    if (isAdminChat) {
      // 用戶列表
      if (/^(用戶列表|使用者列表|list ?users?)$/i.test(text)) {
        const users = await auth.listUsers();
        if (users.length === 0) {
          await sendReply(bot, chatId, '目前沒有用戶。');
          return;
        }
        const roleLabels = { admin: '👑管理員', advanced: '⭐高級', user: '👤一般' };
        const statusLabels = { active: '✅', pending: '⏳', blocked: '🚫' };
        const lines = users.map(u => {
          const name = [u.profile?.firstName, u.profile?.lastName].filter(Boolean).join(' ') || '未知';
          const username = u.profile?.username ? `@${u.profile.username}` : '';
          const role = roleLabels[u.role] || u.role;
          const status = statusLabels[u.status] || u.status;
          return `${status} ${name} ${username}\n   角色：${role} | ID：${u.chatId}`;
        }).join('\n\n');
        await sendReply(bot, chatId, `📋 用戶列表（${users.length} 人）：\n\n${lines}`);
        return;
      }

      // 升級用戶 / 封鎖用戶 / 解封用戶
      const adminCmdMatch = text.match(/^(升級用戶|封鎖用戶|解封用戶)\s*(.+)$/);
      if (adminCmdMatch) {
        const cmd = adminCmdMatch[1];
        const searchName = adminCmdMatch[2].trim();
        const filter = cmd === '解封用戶' ? { status: 'blocked' } : {};
        const users = await auth.listUsers(filter);
        const matches = users.filter(u => {
          const name = [u.profile?.firstName, u.profile?.lastName].filter(Boolean).join(' ');
          const username = u.profile?.username || '';
          return name.includes(searchName) || username.includes(searchName) || String(u.chatId) === searchName;
        });

        if (matches.length === 0) {
          await sendReply(bot, chatId, `找不到用戶「${searchName}」`);
          return;
        }
        if (matches.length > 1) {
          const list = matches.map(u => `${u.profile?.firstName || ''} (${u.chatId})`).join('\n');
          await sendReply(bot, chatId, `找到多位用戶，請用 Chat ID 指定：\n${list}`);
          return;
        }

        const target = matches[0];
        const targetName = [target.profile?.firstName, target.profile?.lastName].filter(Boolean).join(' ') || target.chatId;

        if (cmd === '升級用戶') {
          await sendReply(bot, chatId, `選擇「${targetName}」的新角色：`, {
            inline_keyboard: [
              [
                { text: '👤 一般用戶', callback_data: `admin:setrole:${target.chatId}:user` },
                { text: '⭐ 高級用戶', callback_data: `admin:setrole:${target.chatId}:advanced` },
              ],
              [{ text: '👑 管理員', callback_data: `admin:setrole:${target.chatId}:admin` }],
            ],
          });
        } else if (cmd === '封鎖用戶') {
          await auth.approveUser(target.chatId, 'block', null, userId);
          await sendReply(bot, chatId, `🚫 已封鎖「${targetName}」`);
        } else if (cmd === '解封用戶') {
          await auth.approveUser(target.chatId, 'approve', target.role || 'user', userId);
          await sendReply(bot, chatId, `✅ 已解封「${targetName}」`);
        }
        return;
      }
    }

    // Concurrency 控制：同一 chatId 的訊息排隊處理
    const prev = chatLocks.get(chatId) || Promise.resolve();
    const current = prev.then(async () => {
      try {
        await bot.sendChatAction(chatId, 'typing');

        // ---- ISM session 攔截：有 active session 時直接走 agent handler ----
        if (ism.hasActiveSession(chatId)) {
          const result = await ism.handleTextInput(chatId, text, { userId });
          if (result) {
            if (result.text) await sendReply(bot, chatId, result.text, result.reply_markup);
            if (result.images && result.images.length > 0) {
              const fs = require('fs');
              for (const img of result.images) {
                try {
                  await bot.sendPhoto(chatId, fs.createReadStream(img.localPath || img), { caption: img.caption || '' });
                } catch (imgErr) {
                  console.error('[bot-server] 發送圖片失敗:', imgErr.message);
                }
              }
            }
            return;
          }
          // result 為 null → ISM 不攔截，繼續走 LLM
        }

        // ---- 同步產品關鍵詞攔截（需 system-router 權限）----
        if (/同步產品|sync.?products?/i.test(text)) {
          if (!auth.canUseSkill(permissions, 'system-router')) {
            await sendReply(bot, chatId, '您沒有此操作的權限。');
            return;
          }
          const { syncProducts } = require('../scripts/sync-products');
          await sendReply(bot, chatId, '🔄 開始同步產品...');
          try {
            const stats = await syncProducts();
            await sendReply(bot, chatId,
              `✅ 產品同步完成\n新增: ${stats.added} | 更新: ${stats.updated} | 停用: ${stats.deactivated} | 跳過: ${stats.skipped} | 失敗: ${stats.failed}`
            );
          } catch (err) {
            await sendReply(bot, chatId, `❌ 同步失敗: ${err.message}`);
          }
          return;
        }

        // ---- 建立訂單關鍵詞直接攔截（需 create-order 權限）----
        if (/建立訂單|建單|開單|下訂單/.test(text)) {
          if (!auth.canUseSkill(permissions, 'create-order')) {
            await sendReply(bot, chatId, '您沒有建立訂單的權限。');
            return;
          }
          const result = await orderAgent.startOrderSession(chatId, userId, {});
          if (result) {
            await sendReply(bot, chatId, result.text, result.reply_markup);
            return;
          }
        }

        // ---- 查看提醒關鍵詞攔截 ----
        if (/查看提醒|我的提醒|有哪些提醒|提醒列表|list.?remind/i.test(text)) {
          const result = await reminderAgent.startReminderList(chatId, userId);
          if (result) {
            await sendReply(bot, chatId, result.text, result.reply_markup);
            return;
          }
        }

        const result = await handleMessage(userId, text, chatId, permissions);

        if (result && result.reply) {
          await sendReply(bot, chatId, result.reply, result.reply_markup);
        }
        // Agent loop 回傳的圖片
        if (result && result.images && result.images.length > 0) {
          const fs = require('fs');
          for (const img of result.images) {
            try {
              await bot.sendPhoto(chatId, fs.createReadStream(img.localPath), { caption: img.caption || '' });
            } catch (imgErr) {
              console.error('[bot-server] 發送圖片失敗:', imgErr.message);
            }
          }
        }
      } catch (err) {
        console.error(`[bot-server] 處理訊息失敗 (chat: ${chatId}):`, err);
        await bot.sendMessage(chatId, '抱歉，處理時發生錯誤，請稍後再試。');
        await notifyError(bot, err, `Chat: ${chatId}\nMessage: ${text}`);
      }
    });
    chatLocks.set(chatId, current.catch(() => {}));
  });

  bot.on('polling_error', (err) => {
    console.error('[bot-server] Polling error:', err.message);
  });

  // 啟動完成
  bot.getMe().then(me => {
    console.log(`\n🤖 穗鈅助手已啟動`);
    console.log(`   Bot: @${me.username}`);
    console.log(`   Model: ${config.llm.defaultModel}`);
    console.log(`   Skills: ${definitions.length} 個`);
    console.log(`   Agent 迴圈上限: ${config.agent.maxLoop} 次`);

    // 啟動 Dashboard server（HTTP + WebSocket）
    dashboard.start(bot);

    // 設定 tool-executor 執行 hook → 推送到 dashboard ws
    toolExecutor.setOnExecuteHook((event) => {
      try {
        wsManager.broadcast('new_log', event);
      } catch (_) {}
    });

    console.log('');
  });

  return bot;
}

// ============================================================
// 主程式
// ============================================================

if (require.main === module) {
  startBot();
}

// ============================================================
// Export（供測試和其他模組使用）
// ============================================================

module.exports = {
  parseMemoryTags,
  handleMessage,
  startBot,
};
