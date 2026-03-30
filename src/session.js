/**
 * 穗鈅助手 — 對話歷史管理（含 pre-flush）
 *
 * 每個 user+channel 一個 session。
 * 智慧截斷：system prompt 保留 + 最新對話優先。
 * 截斷前觸發 pre-flush，讓 LLM 先把重要資訊存進記憶。
 *
 * @version 1.0.0
 */

const config = require('./config');
const llm = require('./llm-adapter');
const memoryManager = require('./memory-manager');
const dailyLog = require('./daily-log');

// preFlush 防重複鎖
const flushInProgress = new Set();

// ============================================================
// Token 估算
// ============================================================

/**
 * 粗估 token 數（中文 1 字 ≈ 2 token，英文 1 word ≈ 1.3 token）
 */
function estimateTokens(text) {
  if (!text) return 0;
  // 簡易估算：字元數 * 1.5
  return Math.ceil(text.length * 1.5);
}

// ============================================================
// 智慧截斷
// ============================================================

/**
 * 截斷對話歷史，保留 system prompt + 最新對話
 *
 * @param {Array} messages - 完整 messages 陣列（第一則是 system）
 * @param {string} [userId] - 用戶 ID（pre-flush 用）
 * @param {Object} [llmAdapter] - LLM adapter（pre-flush 用，預設用內建的）
 * @returns {Array} 截斷後的 messages
 */
function trimHistory(messages, userId, llmAdapter) {
  if (!messages || messages.length <= 1) return messages;

  const tokenLimit = config.session.tokenLimit;
  const systemMsg = messages[0];
  const history = messages.slice(1);

  const systemTokens = estimateTokens(systemMsg.content);
  let historyTokens = history.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  // 如果沒超過限制，原樣返回
  if (systemTokens + historyTokens <= tokenLimit) {
    return messages;
  }

  // 從最新的往回加，直到超過上限
  const kept = [];
  let keptTokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(history[i].content);
    if (systemTokens + keptTokens + msgTokens > tokenLimit) break;
    keptTokens += msgTokens;
    kept.unshift(history[i]);
  }

  // 至少保留最後一條用戶訊息
  if (kept.length === 0 && history.length > 0) {
    kept.push(history[history.length - 1]);
  }

  // 如果有被截斷，加上提示
  if (kept.length < history.length) {
    const droppedCount = history.length - kept.length;
    kept.unshift({
      role: 'system',
      content: `[先前有 ${droppedCount} 則對話已省略，重要資訊已存入記憶]`,
    });
  }

  return [systemMsg, ...kept];
}

// ============================================================
// Pre-flush：截斷前讓 LLM 把重要資訊沖進記憶
// ============================================================

/**
 * 截斷前讓 LLM 整理重要資訊存入記憶
 *
 * @param {string} userId
 * @param {Array} history - 對話歷史（不含 system prompt）
 * @param {Object} [llmAdapter] - LLM adapter（預設用內建的）
 */
async function preFlush(userId, history, llmAdapter) {
  const adapter = llmAdapter || llm;

  if (!history || history.length === 0) return;

  // 防重複：同一用戶不會同時跑兩次 flush
  if (flushInProgress.has(userId)) {
    console.log('[session] preFlush 已在執行中，跳過:', userId);
    return;
  }
  flushInProgress.add(userId);

  const flushMessages = [
    {
      role: 'system',
      content: '對話即將被截斷。請檢查以下對話歷史，將任何值得長期記住的資訊整理出來。\n' +
               '用以下格式輸出：\n' +
               '[記憶] 持久事實或偏好\n' +
               '[日誌] 今日事件記錄\n' +
               '如果沒有需要保存的，回覆 NO_REPLY',
    },
    ...history.slice(-20), // 只取最近 20 輪
    { role: 'user', content: '請整理需要保存的記憶。' },
  ];

  try {
    const response = await adapter.chat({
      model: config.llm.defaultModel,
      messages: flushMessages,
      temperature: 0.3,
    });

    if (response.content && response.content !== 'NO_REPLY') {
      // 解析 [記憶] 標記
      const memoryLines = response.content.match(/\[記憶\]\s*(.+)/g) || [];
      const logLines = response.content.match(/\[日誌\]\s*(.+)/g) || [];

      // fire-and-forget，不阻塞截斷流程
      const writes = [];
      for (const line of memoryLines) {
        const content = line.replace('[記憶]', '').trim();
        if (content) {
          writes.push(memoryManager.saveMemory(userId, content, 'pre-flush')
            .catch(err => console.error('[session] pre-flush 記憶存入失敗:', err.message)));
        }
      }
      for (const line of logLines) {
        const content = line.replace('[日誌]', '').trim();
        if (content) {
          writes.push(dailyLog.appendLog(userId, { type: 'note', content })
            .catch(err => console.error('[session] pre-flush 日誌存入失敗:', err.message)));
        }
      }
      Promise.all(writes).catch(() => {});

      const saved = memoryLines.length + logLines.length;
      if (saved > 0) {
        console.log(`[session] pre-flush: ${userId} 存入 ${memoryLines.length} 條記憶, ${logLines.length} 條日誌`);
      }
    }
  } catch (err) {
    console.error('[session] pre-flush 失敗:', err.message);
  } finally {
    flushInProgress.delete(userId);
  }
}

/**
 * 帶 pre-flush 的智慧截斷
 *
 * @param {Array} messages
 * @param {string} userId
 * @param {Object} [llmAdapter]
 * @returns {Promise<Array>} 截斷後的 messages
 */
async function trimHistoryWithFlush(messages, userId, llmAdapter) {
  if (!messages || messages.length <= 1) return messages;

  const tokenLimit = config.session.tokenLimit;
  const flushThreshold = config.session.flushThreshold;
  const systemMsg = messages[0];
  const history = messages.slice(1);

  const systemTokens = estimateTokens(systemMsg.content);
  const historyTokens = history.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  // 超過閾值時觸發背景 flush（不 await，不阻塞回覆）
  const totalTokens = systemTokens + historyTokens;
  console.log('[session] flush check:', totalTokens, '/', tokenLimit);
  if (totalTokens > tokenLimit * flushThreshold) {
    preFlush(userId, history, llmAdapter).catch(err =>
      console.error('[session] 背景 preFlush 失敗:', err.message)
    );
  }

  // 然後截斷
  return trimHistory(messages, userId, llmAdapter);
}

// ============================================================
// Export
// ============================================================

module.exports = {
  estimateTokens,
  trimHistory,
  preFlush,
  trimHistoryWithFlush,
};
