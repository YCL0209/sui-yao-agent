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
const orderAgent = require('./agents/order-agent'); // 觸發 ISM/agentRegistry 註冊
const { normalizeInput } = require('./input-normalizer');
const { classifyDocument, computeFileHash, updateDocumentStatus } = require('./document-classifier');

// 文件解析「客戶不明確」的暫存（key: chatId, value: { parsed, ts }）
// _ambiguous 流程：用戶按 sender/receiver 後從這裡讀取再啟動 order session
const _pendingDocParsed = new Map();

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
    const userId = `telegram:${chatId}`;

    console.log(`[bot] callback_query: ${data} (chat: ${chatId})`);

    try {
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

        // 文件解析「客戶不明確」：sender/receiver 選擇
        else if (data.startsWith('order:pickcustomer:')) {
          const choice = data.split(':')[2]; // 'sender' or 'receiver'
          const pending = _pendingDocParsed.get(chatId);
          if (pending && pending.parsed && pending.parsed._ambiguous) {
            const parsed = pending.parsed;
            const amb = parsed._ambiguous;
            parsed.customerName = choice === 'sender' ? amb.sender : amb.receiver;
            parsed.type = choice === 'sender' ? 'purchase' : 'sales';
            delete parsed._ambiguous;
            _pendingDocParsed.delete(chatId);
            const startResult = await orderAgent.startOrderSession(chatId, userId, { parsed });
            if (startResult) {
              await sendReply(bot, chatId, startResult.text, startResult.reply_markup);
            }
          } else {
            await sendReply(bot, chatId, '建單流程已過期，請重新傳送文件。');
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

            // 正規化輸入
            const input = await normalizeInput(msg, bot);

            // 分類文件
            const classification = await classifyDocument(input);
            console.log(`[分類結果] category=${classification.category}, docType=${classification.docType}, confidence=${classification.confidence}, reasoning=${classification.reasoning}`);

            // docType 路由判斷
            const { getDocType } = require('./doc-classification');
            const ORDER_DOC_TYPES = new Set(['quotation', 'purchase_order']);

            if (classification.docType && !ORDER_DOC_TYPES.has(classification.docType)) {
              // 非訂單類文件 → 記錄但不解析
              const typeDef = getDocType(classification.docType);
              const label = typeDef ? typeDef.label : classification.docType;
              await bot.sendMessage(chatId, `✅ 已辨識為${label}，已記錄。\n目前尚未支援自動處理此類型單據。`);
              // 清理暫存檔
              const att = input.attachments[0];
              if (att) try { fs.unlinkSync(att.filePath); } catch (_) {}
              return;
            }

            // unknown 且無商業內容 → 跳過（生活照、人物照等）
            if (classification.category === 'unknown' && !classification.hasBusinessContent) {
              console.log('[bot-server] 非商業內容圖片，跳過處理');
              const att = input.attachments[0];
              const fh = att ? computeFileHash(att.filePath) : null;
              if (fh) updateDocumentStatus(fh, 'skipped', { reason: '非商業內容' }).catch(() => {});
              if (att) try { fs.unlinkSync(att.filePath); } catch (_) {}
              return;
            }

            // 回覆分類結果（quotation / purchase_order / unknown+有商業內容）
            if (classification.category === 'unknown') {
              await bot.sendMessage(chatId, '📄 無法辨識此文件類型，嘗試為您解析...');
            } else if (classification.docType) {
              const typeDef = getDocType(classification.docType);
              const label = typeDef ? typeDef.label : classification.docType;
              const pct = Math.round(classification.confidence * 100);
              await bot.sendMessage(chatId, `📄 文件辨識結果\n類型：${label}\n信心度：${pct}%\n\n正在為您解析內容...`);
            } else {
              await bot.sendMessage(chatId, `📄 文件辨識結果\n類別：${classification.category}\n\n正在為您解析內容...`);
            }

            const attachment = input.attachments[0];
            const fileHash = attachment ? computeFileHash(attachment.filePath) : null;

            if (!attachment || (attachment.type !== 'pdf' && attachment.type !== 'image')) {
              await bot.sendMessage(chatId, '目前只支援 PDF 和圖片檔案。');
              return;
            }

            let extractedText = '';
            let sourceType = '';

            if (attachment.type === 'pdf') {
              sourceType = 'PDF';
              extractedText = await docParser.parsePDF(attachment.filePath);
              console.log('[bot-server] PDF 提取文字:', extractedText.substring(0, 500));
            } else {
              sourceType = '圖片';
              extractedText = await docParser.parseImage(attachment.filePath);
            }

            // 清理暫存檔
            try { fs.unlinkSync(attachment.filePath); } catch (_) {}

            if (!extractedText || extractedText.trim().length < 10) {
              if (fileHash) updateDocumentStatus(fileHash, 'parse_failed', { reason: '無法提取有效內容' }).catch(() => {});
              await bot.sendMessage(chatId, `無法從${sourceType}中提取有效內容。`);
              return;
            }

            // LLM 結構化解析
            const llmAdapter = require('./llm-adapter');
            const parsed = await docParser.extractOrderFromText(extractedText, llmAdapter);

            if (!parsed || (!parsed.items?.length && !parsed.customerName)) {
              if (fileHash) updateDocumentStatus(fileHash, 'parse_failed', { reason: '無法辨識訂單資訊', extractedText: extractedText.substring(0, 500) }).catch(() => {});
              await bot.sendMessage(chatId, `無法從${sourceType}中辨識訂單資訊。\n\n提取的內容：\n${extractedText.substring(0, 500)}`);
              return;
            }

            // 解析成功 → 更新 parsed_documents
            if (fileHash) updateDocumentStatus(fileHash, 'parsed', parsed).catch(() => {});

            // 都搜不到 → 按鈕問用戶哪個是客戶
            if (parsed._ambiguous) {
              const { sender, receiver } = parsed._ambiguous;
              // 暫存 parsed 到 bot-server 內部 Map（解法 A）
              _pendingDocParsed.set(chatId, { parsed, ts: Date.now() });
              const itemsSummary = parsed.items.map(i => `  • ${i.name} ×${i.quantity} @${i.price}`).join('\n');
              await sendReply(bot, chatId,
                `📄 已解析 ${parsed.items.length} 個品項：\n${itemsSummary}\n\n無法自動判斷客戶，請選擇：`,
                {
                  inline_keyboard: [
                    [{ text: sender, callback_data: 'order:pickcustomer:sender' }],
                    [{ text: receiver, callback_data: 'order:pickcustomer:receiver' }],
                    [{ text: '❌ 取消', callback_data: 'order:cancel' }],
                  ],
                }
              );
              return;
            }

            // 走建單流程（透過 ISM）
            const result = await orderAgent.startOrderSession(chatId, userId, { parsed });
            if (result) {
              await sendReply(bot, chatId, result.text, result.reply_markup);
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
      ism.deleteSession(chatId);
      _pendingDocParsed.delete(chatId);
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

        // ---- 建立訂單關鍵詞直接攔截（透過 ISM 啟動 order session） ----
        if (/建立訂單|建單|開單|下訂單/.test(text)) {
          const result = await orderAgent.startOrderSession(chatId, userId, {});
          if (result) {
            await sendReply(bot, chatId, result.text, result.reply_markup);
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
