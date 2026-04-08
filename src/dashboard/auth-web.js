/**
 * 穗鈅助手 — Dashboard 登入驗證
 *
 * 流程：
 * 1. 用戶在 Dashboard 輸入 Telegram username 或 chatId
 * 2. 後端產生 6 位驗證碼，透過 bot 發到用戶的 Telegram
 * 3. 用戶在 Dashboard 輸入驗證碼
 * 4. 驗證通過 → 發 session token
 *
 * 只有 admin 和 advanced 能登入 Dashboard。
 *
 * @version 1.0.0
 */

const crypto = require('crypto');
const auth = require('../auth');
const config = require('../config');

// 暫存驗證碼：{ chatId: { code, expiresAt, attempts, userId, role } }
const _pendingCodes = new Map();

// 暫存 session token：{ token: { chatId, userId, role, expiresAt } }
const _sessions = new Map();

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 小時
const MAX_ATTEMPTS = 5;

/**
 * 產生驗證碼並回傳 chatId（由 API route 呼叫）
 * @param {string} identifier — Telegram username（不含@）或 chatId
 * @returns {Promise<{ success, chatId, displayName, error? }>}
 */
async function requestVerifyCode(identifier) {
  const users = await auth.listUsers();
  const target = String(identifier).toLowerCase().replace('@', '');
  const user = users.find(u => {
    return String(u.chatId) === String(identifier)
      || (u.profile?.username || '').toLowerCase() === target;
  });

  if (!user) {
    return { success: false, error: '找不到此用戶' };
  }

  if (user.status !== 'active') {
    return { success: false, error: '此帳號尚未啟用' };
  }

  // 只有 admin 和 advanced 能登入 Dashboard
  if (user.role === 'user') {
    return { success: false, error: '權限不足，無法登入 Dashboard' };
  }

  // 產生 6 位數字驗證碼
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const ttl = config.dashboard.verifyCodeTTL || 300000;

  _pendingCodes.set(user.chatId, {
    code,
    expiresAt: Date.now() + ttl,
    attempts: 0,
    userId: user.userId,
    role: user.role,
  });

  return {
    success: true,
    chatId: user.chatId,
    displayName: [user.profile?.firstName, user.profile?.lastName].filter(Boolean).join(' ') || 'Admin',
  };
}

/**
 * 驗證碼比對
 * @param {number} chatId
 * @param {string} code
 * @returns {{ success, token?, error? }}
 */
function verifyCode(chatId, code) {
  const pending = _pendingCodes.get(Number(chatId));

  if (!pending) {
    return { success: false, error: '未找到驗證碼，請重新請求' };
  }

  if (Date.now() > pending.expiresAt) {
    _pendingCodes.delete(Number(chatId));
    return { success: false, error: '驗證碼已過期，請重新請求' };
  }

  pending.attempts++;
  if (pending.attempts > MAX_ATTEMPTS) {
    _pendingCodes.delete(Number(chatId));
    return { success: false, error: '嘗試次數過多，請重新請求' };
  }

  if (pending.code !== String(code)) {
    return { success: false, error: `驗證碼錯誤（剩餘 ${MAX_ATTEMPTS - pending.attempts} 次）` };
  }

  // 驗證通過 → 發 token
  _pendingCodes.delete(Number(chatId));
  const token = crypto.randomBytes(32).toString('hex');

  _sessions.set(token, {
    chatId: Number(chatId),
    userId: pending.userId,
    role: pending.role,
    expiresAt: Date.now() + SESSION_TTL,
  });

  return { success: true, token };
}

/**
 * 驗證 session token
 * @param {string} token
 * @returns {{ valid, session? }}
 */
function validateToken(token) {
  if (!token) return { valid: false };
  const session = _sessions.get(token);
  if (!session) return { valid: false };
  if (Date.now() > session.expiresAt) {
    _sessions.delete(token);
    return { valid: false };
  }
  return { valid: true, session };
}

/**
 * 登出
 */
function logout(token) {
  _sessions.delete(token);
}

/**
 * 定時清理過期的 session 和驗證碼
 */
function cleanup() {
  const now = Date.now();
  for (const [chatId, pending] of _pendingCodes) {
    if (now > pending.expiresAt) _pendingCodes.delete(chatId);
  }
  for (const [token, session] of _sessions) {
    if (now > session.expiresAt) _sessions.delete(token);
  }
}

const _cleanupInterval = setInterval(cleanup, 60000);
if (_cleanupInterval.unref) _cleanupInterval.unref();

module.exports = {
  requestVerifyCode,
  verifyCode,
  validateToken,
  logout,
  _pendingCodes, // 給 api-routes 發驗證碼時讀取
};
