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

// ============================================================
// 啟動
// ============================================================

// 載入 skill definitions（給 LLM function calling 用）
const { definitions } = loadAllSkills();
console.log(`[bot-server] 載入 ${definitions.length} 個 skill definitions`);

// 對話歷史快取（per chat）
const chatHistories = new Map();

// Concurrency 控制：per-chatId Promise chain，同一用戶訊息序列化處理
const chatLocks = new Map();

// ============================================================
// [記憶] / [日誌] 標記解析
// ============================================================

/**
 * 解析回覆中的 [記憶] 和 [日誌] 標記
 *
 * @param {string} text - LLM 回覆文字
 * @returns {{ reply: string, memories: string[], logs: string[] }}
 */
function parseMemoryTags(text) {
  if (!text) return { reply: '', memories: [], logs: [] };

  const memories = [];
  const logs = [];

  // 只匹配行首的標記（^ + m flag）
  const memoryMatches = text.match(/^\[記憶\]\s+(.+)$/gm) || [];
  for (const m of memoryMatches) {
    const content = m.replace(/^\[記憶\]\s+/, '').trim();
    if (content) memories.push(content);
  }

  const logMatches = text.match(/^\[日誌\]\s+(.+)$/gm) || [];
  for (const l of logMatches) {
    const content = l.replace(/^\[日誌\]\s+/, '').trim();
    if (content) logs.push(content);
  }

  // 只移除行首的標記行，句中出現的保留原文
  const reply = text
    .replace(/^\[記憶\]\s+.+$/gm, '')
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
async function handleMessage(userId, userMessage, chatId) {
  // 1. 組裝 system prompt
  const systemPrompt = await promptLoader.loadSystemPrompt(userId, userMessage);

  // 2. 取得或建立對話歷史
  if (!chatHistories.has(chatId)) {
    chatHistories.set(chatId, []);
  }
  const history = chatHistories.get(chatId);

  // 加入用戶訊息
  history.push({ role: 'user', content: userMessage });

  // 3. 組裝 messages
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history,
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

      const result = await toolExecutor.execute(toolCall, { userId, chatId });

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
      history.push({ role: 'assistant', content: hasImages.text });
      return { reply: hasImages.text, images: hasImages.localPaths };
    }

    // 含 reply_markup 的結果直接回傳，不再經過 LLM
    if (hasReplyMarkup) {
      const text = hasReplyMarkup.data || hasReplyMarkup.summary || '';
      history.push({ role: 'assistant', content: text });
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
        memoryManager.saveMemory(userId, mem, 'LLM 回覆')
          .catch(err => console.error('[bot-server] 記憶存入失敗:', err.message))
      ),
      ...logs.map(log =>
        dailyLog.appendLog(userId, { type: 'note', content: log })
          .catch(err => console.error('[bot-server] 日誌存入失敗:', err.message))
      ),
    ]).catch(() => {});
  }

  // 7. 更新對話歷史
  history.push({ role: 'assistant', content: finalReply });

  // 限制歷史長度
  while (history.length > config.session.maxRounds * 2) {
    history.shift();
  }

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
  const bot = new TelegramBot(config.telegram.botToken, { polling: true });

  // ---- callback_query handler（Inline keyboard 按鈕） ----
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    console.log(`[bot] callback_query: ${data} (chat: ${chatId})`);

    try {
      if (data.startsWith('order_pickcustomer:')) {
        // 用戶選擇客戶（PDF 兩個公司都搜不到時）
        const choice = data.split(':')[1]; // 'sender' or 'receiver'
        const sess = createOrderSkill.orderSessions.get(chatId);
        if (sess && sess._parsedFromDoc) {
          const parsed = sess._parsedFromDoc;
          const amb = parsed._ambiguous;
          parsed.customerName = choice === 'sender' ? amb.sender : amb.receiver;
          parsed.type = choice === 'sender' ? 'purchase' : 'sales';
          delete parsed._ambiguous;
          createOrderSkill.orderSessions.delete(chatId);
          const userId = `telegram:${chatId}`;
          const llmAdapter = require('./llm-adapter');
          const result = await createOrderSkill.startFromParsed(chatId, parsed, { userId, chatId, llm: llmAdapter });
          if (result) await sendSkillResult(bot, chatId, result);
        }
      } else if (data.startsWith('order_')) {
        const result = await createOrderSkill.handleCallback(chatId, data);
        await sendSkillResult(bot, chatId, result);
        // 如果結果包含圖片，用本地檔案路徑逐一發送
        if (result && result.images && result.images.length > 0) {
          const fs = require('fs');
          for (const img of result.images) {
            try {
              const filePath = img.localPath || img.url;
              await bot.sendPhoto(chatId, fs.createReadStream(filePath), { caption: img.caption || '' });
            } catch (imgErr) {
              console.error('[bot-server] 發送圖片失敗:', imgErr.message);
            }
          }
        }
      }
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

    // ---- 非文字訊息處理（PDF / 圖片 → 自動建單） ----
    if (!text) {
      if (msg.document || msg.photo) {
        const prev = chatLocks.get(chatId) || Promise.resolve();
        const current = prev.then(async () => {
          try {
            await bot.sendChatAction(chatId, 'typing');
            const docParser = require('./document-parser');
            const fs = require('fs');
            const path = require('path');
            const tmpDir = '/tmp/sui-yao-uploads';
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

            let extractedText = '';
            let sourceType = '';

            if (msg.document && msg.document.mime_type === 'application/pdf') {
              // PDF 處理
              sourceType = 'PDF';
              const fileLink = await bot.getFileLink(msg.document.file_id);
              const res = await fetch(fileLink);
              const buffer = Buffer.from(await res.arrayBuffer());
              const filePath = path.join(tmpDir, `${chatId}-${Date.now()}.pdf`);
              fs.writeFileSync(filePath, buffer);
              extractedText = await docParser.parsePDF(filePath);
              console.log('[bot-server] PDF 提取文字:', extractedText.substring(0, 500));
              fs.unlinkSync(filePath);
            } else if (msg.photo) {
              // 圖片處理（取最大解析度）
              sourceType = '圖片';
              const photo = msg.photo[msg.photo.length - 1];
              const fileLink = await bot.getFileLink(photo.file_id);
              const res = await fetch(fileLink);
              const buffer = Buffer.from(await res.arrayBuffer());
              const filePath = path.join(tmpDir, `${chatId}-${Date.now()}.jpg`);
              fs.writeFileSync(filePath, buffer);
              extractedText = await docParser.parseImage(filePath);
              fs.unlinkSync(filePath);
            } else {
              await bot.sendMessage(chatId, '目前只支援 PDF 和圖片檔案。');
              return;
            }

            if (!extractedText || extractedText.trim().length < 10) {
              await bot.sendMessage(chatId, `無法從${sourceType}中提取有效內容。`);
              return;
            }

            await bot.sendMessage(chatId, `📄 已接收${sourceType}，正在解析...`);

            // LLM 結構化解析
            const llmAdapter = require('./llm-adapter');
            const parsed = await docParser.extractOrderFromText(extractedText, llmAdapter);

            if (!parsed || (!parsed.items?.length && !parsed.customerName)) {
              await bot.sendMessage(chatId, `無法從${sourceType}中辨識訂單資訊。\n\n提取的內容：\n${extractedText.substring(0, 500)}`);
              return;
            }

            // 都搜不到 → 按鈕問用戶哪個是客戶
            if (parsed._ambiguous) {
              const { sender, receiver } = parsed._ambiguous;
              // 暫存 parsed 到 session
              const sess = createOrderSkill.createSession
                ? createOrderSkill.orderSessions
                : null;
              if (sess) {
                sess.set(chatId, { step: 'pick_customer', _parsedFromDoc: parsed, createdAt: Date.now() });
              }
              const itemsSummary = parsed.items.map(i => `  • ${i.name} ×${i.quantity} @${i.price}`).join('\n');
              await sendReply(bot, chatId,
                `📄 已解析 ${parsed.items.length} 個品項：\n${itemsSummary}\n\n無法自動判斷客戶，請選擇：`,
                {
                  inline_keyboard: [
                    [{ text: sender, callback_data: `order_pickcustomer:sender` }],
                    [{ text: receiver, callback_data: `order_pickcustomer:receiver` }],
                    [{ text: '❌ 取消', callback_data: 'order_cancel' }],
                  ],
                }
              );
              return;
            }

            // 走建單流程
            const result = await createOrderSkill.startFromParsed(chatId, parsed, { userId, chatId, llm: llmAdapter });
            if (result) {
              await sendSkillResult(bot, chatId, result);
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
      chatHistories.delete(chatId);
      createOrderSkill.deleteSession(chatId);
      await bot.sendMessage(chatId, '🔄 對話已重置');
      return;
    }

    // /start 指令
    if (text === '/start') {
      await bot.sendMessage(chatId, '👋 你好！我是穗鈅助手，有什麼可以幫你的？');
      return;
    }

    // Concurrency 控制：同一 chatId 的訊息排隊處理
    const prev = chatLocks.get(chatId) || Promise.resolve();
    const current = prev.then(async () => {
      try {
        await bot.sendChatAction(chatId, 'typing');

        // ---- 建單 session 攔截：有 active session 時直接走 skill ----
        const orderSession = createOrderSkill.getSession(chatId);
        if (orderSession && (orderSession.step === 'customer' || orderSession.step === 'items')) {
          const result = await createOrderSkill.handleTextInput(chatId, text);
          if (result) {
            await sendSkillResult(bot, chatId, result);
            return;
          }
          // result 為 null 表示 session 不處理，繼續走 LLM
        }

        // ---- 同步產品關鍵詞攔截 ----
        if (/同步產品|sync.?products?/i.test(text)) {
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

        // ---- 建立訂單關鍵詞直接攔截（不依賴 LLM tool calling） ----
        if (/建立訂單|建單|開單|下訂單/.test(text)) {
          const orderResult = await createOrderSkill.run(
            { message: text },
            { userId, chatId, llm: require('./llm-adapter') }
          );
          if (orderResult) {
            await sendSkillResult(bot, chatId, orderResult);
            return;
          }
        }

        const result = await handleMessage(userId, text, chatId);

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
    console.log(`   Agent 迴圈上限: ${config.agent.maxLoop} 次\n`);
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
