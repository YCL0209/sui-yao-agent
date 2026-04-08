/**
 * 穗鈅助手 — 通用多步驟互動 Session 管理
 *
 * 任何需要 Telegram inline button 互動的功能都用這個模組。
 * Agent 透過 registerHandler 註冊自己的互動邏輯，
 * bot-server 透過 handleCallback / handleTextInput 統一分發。
 *
 * callback_data 格式約定：{agentName}:{action}:{payload}
 * 例如：order:type:sales, order:confirm, doc:retry
 *
 * @version 1.0.0
 */

const config = require('./config');

const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 分鐘

// 已註冊的 agent handler
// { [agentName]: { onStart, onCallback, onTextInput, onTimeout, ttl } }
const _handlers = new Map();

// 活躍的 sessions
// key: chatId (number or string)
// value: { id, agentName, chatId, userId, step, data, createdAt, updatedAt, ttl }
const _sessions = new Map();

// ========================================
// 註冊
// ========================================

/**
 * 註冊一個 agent 的互動 handler
 *
 * @param {string} agentName — agent 名稱（必須唯一，用於 callback_data 前綴）
 * @param {Object} handler
 * @param {Function} handler.onStart(context) — 開始互動時呼叫，回傳 { text, reply_markup }
 * @param {Function} handler.onCallback(session, action, payload, context) — 按鈕回調
 * @param {Function} [handler.onTextInput(session, text, context)] — 用戶打字時
 * @param {Function} [handler.onTimeout(session)] — 超時清理
 * @param {number} [handler.ttl] — 存活時間 ms（預設 10 分鐘）
 */
function registerHandler(agentName, handler) {
  if (!handler.onStart || !handler.onCallback) {
    throw new Error(`Agent「${agentName}」的 handler 缺少 onStart 或 onCallback`);
  }
  _handlers.set(agentName, {
    onStart: handler.onStart,
    onCallback: handler.onCallback,
    onTextInput: handler.onTextInput || null,
    onTimeout: handler.onTimeout || null,
    ttl: handler.ttl || SESSION_TIMEOUT_MS,
  });
}

// ========================================
// Session 生命週期
// ========================================

/**
 * 開始一個新的互動 session
 *
 * @param {string} agentName
 * @param {Object} params
 * @param {string|number} params.chatId
 * @param {string} params.userId
 * @param {Object} [params.initialData] — 初始資料
 * @returns {Promise<Object>} — onStart 的回傳值（text + reply_markup）
 */
async function startSession(agentName, { chatId, userId, initialData = {} }) {
  const handler = _handlers.get(agentName);
  if (!handler) {
    throw new Error(`找不到 agent handler：${agentName}`);
  }

  // 如果同一個 chatId 有進行中的 session，先清除
  if (_sessions.has(chatId)) {
    const oldSession = _sessions.get(chatId);
    const oldHandler = _handlers.get(oldSession.agentName);
    if (oldHandler && oldHandler.onTimeout) {
      try { await oldHandler.onTimeout(oldSession); } catch (_) {}
    }
  }

  const sess = {
    id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    agentName,
    chatId,
    userId,
    step: 'start',
    data: { ...initialData },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ttl: handler.ttl,
  };
  _sessions.set(chatId, sess);

  // 呼叫 handler 的 onStart
  const result = await handler.onStart({
    session: sess,
    userId,
    chatId,
  });

  return result;
}

/**
 * 處理 callback_query
 *
 * @param {string} callbackData — Telegram callback_data，格式：{agentName}:{action}:{payload}
 * @param {Object} params — { chatId, userId, messageId }
 * @returns {Promise<Object|null>} — handler 的回傳值，或 null（無對應 session）
 */
async function handleCallback(callbackData, { chatId, userId, messageId }) {
  // 解析 callback_data
  const parts = callbackData.split(':');
  const agentName = parts[0];
  const action = parts[1] || '';
  const payload = parts.slice(2).join(':') || '';

  const handler = _handlers.get(agentName);
  if (!handler) return null;

  const sess = _sessions.get(chatId);
  if (!sess || sess.agentName !== agentName) return null;

  // 更新時間
  sess.updatedAt = Date.now();

  const result = await handler.onCallback(sess, action, payload, {
    chatId,
    userId,
    messageId,
  });

  // 如果 handler 回傳 done: true，清除 session
  if (result && result.done) {
    _sessions.delete(chatId);
  }

  return result;
}

/**
 * 處理用戶打字輸入（在有 active session 時攔截）
 *
 * @param {string|number} chatId
 * @param {string} text
 * @param {Object} params — { userId }
 * @returns {Promise<Object|null>} — handler 的回傳值，或 null（無對應 session 或不攔截）
 */
async function handleTextInput(chatId, text, { userId }) {
  const sess = _sessions.get(chatId);
  if (!sess) return null;

  const handler = _handlers.get(sess.agentName);
  if (!handler || !handler.onTextInput) return null;

  sess.updatedAt = Date.now();

  const result = await handler.onTextInput(sess, text, { chatId, userId });

  if (result && result.done) {
    _sessions.delete(chatId);
  }

  return result;
}

/**
 * 檢查某 chatId 是否有進行中的 session
 */
function hasActiveSession(chatId) {
  return _sessions.has(chatId);
}

/**
 * 取得某 chatId 的 session（用於外部判斷）
 */
function getSession(chatId) {
  return _sessions.get(chatId) || null;
}

/**
 * 手動刪除 session
 */
function deleteSession(chatId) {
  _sessions.delete(chatId);
}

// ========================================
// 定時清理過期 session
// ========================================

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [chatId, sess] of _sessions) {
    if (now - sess.updatedAt > sess.ttl) {
      const handler = _handlers.get(sess.agentName);
      if (handler && handler.onTimeout) {
        handler.onTimeout(sess).catch(() => {});
      }
      _sessions.delete(chatId);
      console.log(`[interactive-session] Session 過期清除: ${sess.agentName} (chat: ${chatId})`);
    }
  }
}

// 每分鐘清理一次
const _cleanupInterval = setInterval(cleanExpiredSessions, 60 * 1000);

// 讓 Node.js 不會因為 setInterval 而不退出
if (_cleanupInterval.unref) _cleanupInterval.unref();

module.exports = {
  registerHandler,
  startSession,
  handleCallback,
  handleTextInput,
  hasActiveSession,
  getSession,
  deleteSession,
  cleanExpiredSessions,
};
