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

// ============================================================
// 啟動
// ============================================================

// 載入 skill definitions（給 LLM function calling 用）
const { definitions } = loadAllSkills();
console.log(`[bot-server] 載入 ${definitions.length} 個 skill definitions`);

// 對話歷史快取（per chat）
const chatHistories = new Map();

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

  const memoryMatches = text.match(/\[記憶\]\s*(.+)/g) || [];
  for (const m of memoryMatches) {
    const content = m.replace(/\[記憶\]\s*/, '').trim();
    if (content) memories.push(content);
  }

  const logMatches = text.match(/\[日誌\]\s*(.+)/g) || [];
  for (const l of logMatches) {
    const content = l.replace(/\[日誌\]\s*/, '').trim();
    if (content) logs.push(content);
  }

  // 從回覆中移除標記行
  const reply = text
    .replace(/\[記憶\]\s*.+/g, '')
    .replace(/\[日誌\]\s*.+/g, '')
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
 * @returns {Promise<string>} 最終回覆
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
    // 呼叫 LLM
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

    for (const toolCall of response.tool_calls) {
      const funcName = toolCall.function?.name || 'unknown';
      console.log(`[bot-server] Agent loop ${loop + 1}: 執行 ${funcName}`);

      const result = await toolExecutor.execute(toolCall, { userId, chatId });

      // 把 tool 結果塞回 messages（OpenAI 標準格式）
      currentMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          success: result.success,
          summary: result.summary,
          data: result.data,
        }),
      });
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

  // 存入記憶和日誌
  for (const mem of memories) {
    try {
      await memoryManager.saveMemory(userId, mem, 'LLM 回覆');
    } catch (err) {
      console.error('[bot-server] 記憶存入失敗:', err.message);
    }
  }
  for (const log of logs) {
    try {
      await dailyLog.appendLog(userId, { type: 'note', content: log });
    } catch (err) {
      console.error('[bot-server] 日誌存入失敗:', err.message);
    }
  }

  // 7. 更新對話歷史
  history.push({ role: 'assistant', content: finalReply });

  // 限制歷史長度
  while (history.length > config.session.maxRounds * 2) {
    history.shift();
  }

  return reply || finalReply;
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

function startBot() {
  const bot = new TelegramBot(config.telegram.botToken, { polling: true });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = `telegram:${chatId}`;
    const text = msg.text;

    // 忽略非文字訊息
    if (!text) return;

    // reset 指令
    if (text === '/reset' || text === '/new') {
      chatHistories.delete(chatId);
      await bot.sendMessage(chatId, '🔄 對話已重置');
      return;
    }

    // /start 指令
    if (text === '/start') {
      await bot.sendMessage(chatId, '👋 你好！我是穗鈅助手，有什麼可以幫你的？');
      return;
    }

    try {
      // 發送「正在輸入」狀態
      await bot.sendChatAction(chatId, 'typing');

      const reply = await handleMessage(userId, text, chatId);

      if (reply) {
        // Telegram 訊息長度限制 4096
        if (reply.length > 4000) {
          const chunks = reply.match(/[\s\S]{1,4000}/g) || [reply];
          for (const chunk of chunks) {
            await bot.sendMessage(chatId, chunk);
          }
        } else {
          await bot.sendMessage(chatId, reply);
        }
      }
    } catch (err) {
      console.error(`[bot-server] 處理訊息失敗 (chat: ${chatId}):`, err);
      await bot.sendMessage(chatId, '抱歉，處理時發生錯誤，請稍後再試。');
      await notifyError(bot, err, `Chat: ${chatId}\nMessage: ${text}`);
    }
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
