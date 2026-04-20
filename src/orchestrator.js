/**
 * 穗鈅助手 — Orchestrator（訊息處理核心；Phase I1）
 *
 * 從 bot-server 抽出 agent loop 與相關 helper。
 *
 * 本步驟（Step 6）暫時保持向下相容簽名：
 *   handleMessage(userId, userMessage, chatId, permissions)
 *     → { reply, reply_markup?, images? }
 *
 * 後續步驟會：
 *   - Step 7: 改 saveHistory/loadHistory 用 (platform, chatId) 複合 key
 *   - Step 8: auth 改 platform 參數
 *   - Step 9: 改成 class Orchestrator + handleMessage(normalizedMsg)
 *
 * @version 1.0.0
 */

const config = require('./config');
const llm = require('./llm-adapter');
const promptLoader = require('./prompt-loader');
const { loadAllSkills } = require('./skill-loader');
const toolExecutor = require('./tool-executor');
const memoryManager = require('./memory-manager');
const dailyLog = require('./daily-log');
const session = require('./session');
const mongo = require('../lib/mongodb-tools');
const ism = require('./interactive-session');

// 載入 agents（觸發 ISM/agentRegistry 註冊）
require('./agents/order-agent');
require('./agents/doc-agent');
require('./agents/reminder-agent');
require('./agents/admin-agent');

// 載入 skill definitions（給 LLM function calling 用）
const { definitions } = loadAllSkills();
console.log(`[orchestrator] 載入 ${definitions.length} 個 skill definitions`);

// ============================================================
// 高風險操作確認 ISM handler
// ============================================================

ism.registerHandler('danger-confirm', {
  ttl: 2 * 60 * 1000, // 2 分鐘

  async onStart({ session: _s }) {
    return { text: '' }; // 已經在 agent loop 回覆了
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
        return {
          text: result.summary || '✅ 操作已執行。',
          done: true,
        };
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
// 對話歷史 — MongoDB 持久化（Step 6 暫保留 Number key；Step 7 改複合 key）
// ============================================================

async function getHistory(chatId) {
  const db = await mongo.getDb();
  const doc = await db.collection('conversations').findOne({
    platform: 'telegram',
    chatId: String(chatId),
  });
  return doc?.messages || [];
}

async function saveHistory(chatId, userId, messages) {
  const db = await mongo.getDb();
  const maxMessages = config.conversation?.maxMessages || 200;
  const trimmed = messages.length > maxMessages
    ? messages.slice(-maxMessages)
    : messages;

  await db.collection('conversations').updateOne(
    { platform: 'telegram', chatId: String(chatId) },
    {
      $set: {
        platform: 'telegram',
        userId,
        messages: trimmed,
        updatedAt: new Date(),
      },
      $setOnInsert: { chatId: String(chatId), createdAt: new Date() },
    },
    { upsert: true }
  );
}

async function clearHistory(chatId) {
  const db = await mongo.getDb();
  await db.collection('conversations').deleteOne({
    platform: 'telegram',
    chatId: String(chatId),
  });
}

function stripTs(messages) {
  return messages.map(m => {
    const { ts, ...rest } = m;
    return rest;
  });
}

// ============================================================
// [記憶] / [日誌] 標記解析
// 支援 [記憶:高] [記憶] [記憶:低] 三級重要性
// ============================================================

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

// ============================================================
// Tool Call 容錯：本地模型可能把 tool call 混進文字內容
// ============================================================

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
        return {
          id: `rescued_${Date.now()}`,
          type: 'function',
          function: { name, arguments: args },
        };
      }
    }

    const tagMatch = content.match(/"name"\s*:\s*"([\w-]+)"[\s\S]*?"arguments"\s*:\s*(\{[^}]*\})/);
    if (tagMatch) {
      const name = tagMatch[1];
      const args = tagMatch[2];
      if (knownSkills.includes(name)) {
        JSON.parse(args);
        return {
          id: `rescued_${Date.now()}`,
          type: 'function',
          function: { name, arguments: args },
        };
      }
    }
  } catch (err) {
    console.warn('[orchestrator] tryRescueToolCall 解析失敗:', err.message);
  }

  return null;
}

// ============================================================
// Agent 迴圈
// ============================================================

/**
 * 處理單次訊息的完整 Agent 迴圈
 *
 * @param {string} userId
 * @param {string} userMessage
 * @param {string|number} chatId
 * @param {Object|null} permissions
 * @returns {Promise<{ reply: string, reply_markup?: Object, images?: Array }>}
 */
async function handleMessage(userId, userMessage, chatId, permissions = null) {
  // 1. 組裝 system prompt
  const systemPrompt = await promptLoader.loadSystemPrompt(userId, userMessage);

  // 2. 從 MongoDB 取得對話歷史
  const history = await getHistory(chatId);
  history.push({ role: 'user', content: userMessage, ts: new Date() });

  // 3. 組 messages（剝 ts 送 LLM）
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
      messages: currentMessages,
      tools: definitions.length > 0 ? definitions : undefined,
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

      // 高風險操作需要確認 → 啟動 ISM session，直接回傳按鈕
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
          reply: `⚠️ 高風險操作確認\n\n操作：${confirmData.description}\n\n確定要執行嗎？`,
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ 確定執行', callback_data: 'danger-confirm:execute' },
                { text: '❌ 取消', callback_data: 'danger-confirm:cancel' },
              ],
            ],
          },
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

    if (hasImages) {
      history.push({ role: 'assistant', content: hasImages.text, ts: new Date() });
      saveHistory(chatId, userId, history).catch(err =>
        console.error('[orchestrator] 對話歷史儲存失敗:', err.message)
      );
      return { reply: hasImages.text, images: hasImages.localPaths };
    }

    if (hasReplyMarkup) {
      const text = hasReplyMarkup.data || hasReplyMarkup.summary || '';
      history.push({ role: 'assistant', content: text, ts: new Date() });
      saveHistory(chatId, userId, history).catch(err =>
        console.error('[orchestrator] 對話歷史儲存失敗:', err.message)
      );
      return { reply: text, reply_markup: hasReplyMarkup.reply_markup };
    }

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
          .catch(err => console.error('[orchestrator] 記憶存入失敗:', err.message))
      ),
      ...logs.map(log =>
        dailyLog.appendLog(userId, { type: 'note', content: log })
          .catch(err => console.error('[orchestrator] 日誌存入失敗:', err.message))
      ),
    ]).catch(() => {});
  }

  // 7. 更新對話歷史
  history.push({ role: 'assistant', content: finalReply, ts: new Date() });

  while (history.length > config.session.maxRounds * 2) {
    history.shift();
  }

  saveHistory(chatId, userId, history).catch(err =>
    console.error('[orchestrator] 對話歷史儲存失敗:', err.message)
  );

  if (!reply && (memories.length > 0 || logs.length > 0)) {
    return { reply: '已記住。' };
  }
  return { reply: reply ?? finalReply };
}

module.exports = {
  handleMessage,
  parseMemoryTags,
  tryRescueToolCall,
  getHistory,
  saveHistory,
  clearHistory,
  stripTs,
  definitions,
};
