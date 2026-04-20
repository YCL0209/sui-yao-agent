/**
 * 穗鈅助手 — Dashboard 登入驗證（Phase I1 多平台）
 *
 * 流程：
 * 1. 用戶在 Dashboard 輸入 username 或 chatId
 * 2. 後端找出 user 並產生 6 位驗證碼，透過對應平台的 adapter 發給用戶
 * 3. 用戶在 Dashboard 輸入驗證碼
 * 4. 驗證通過 → 發 session token
 *
 * 只有 admin 和 advanced 能登入 Dashboard。
 *
 * @version 2.0.0
 */

const crypto = require('crypto');
const auth = require('../auth');
const config = require('../config');

// key = `${platform}:${chatId}`
const _pendingCodes = new Map();
const _sessions = new Map();

// Rate limit
const _rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 3;

const SESSION_TTL = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function makeKey(platform, chatId) {
  return `${platform}:${chatId}`;
}

function checkRateLimit(identifier) {
  const now = Date.now();
  const key = String(identifier).toLowerCase();
  const record = _rateLimits.get(key);
  if (!record || now - record.start > RATE_LIMIT_WINDOW) {
    _rateLimits.set(key, { start: now, count: 1 });
    return true;
  }
  record.count++;
  return record.count <= RATE_LIMIT_MAX;
}

/**
 * 由 identifier 找 user（支援 chatId、username、username#discriminator）
 */
async function findUser(identifier) {
  const users = await auth.listUsers();
  const target = String(identifier).toLowerCase().replace('@', '');
  return users.find(u =>
    String(u.chatId) === String(identifier)
    || (u.profile?.username || '').toLowerCase() === target
  );
}

/**
 * 產生驗證碼
 * @returns {Promise<{ success, chatId, platform, displayName, error? }>}
 */
async function requestVerifyCode(identifier) {
  if (!checkRateLimit(identifier)) {
    return { success: false, error: '請求過於頻繁，請稍後再試' };
  }

  const user = await findUser(identifier);
  if (!user) return { success: false, error: '找不到此用戶' };
  if (user.status !== 'active') return { success: false, error: '此帳號尚未啟用' };
  if (user.role === 'user') return { success: false, error: '權限不足，無法登入 Dashboard' };

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const ttl = config.dashboard.verifyCodeTTL || 300000;
  const platform = user.platform || 'telegram';
  const chatId = String(user.chatId);

  _pendingCodes.set(makeKey(platform, chatId), {
    code,
    expiresAt: Date.now() + ttl,
    attempts: 0,
    userId: user.userId,
    role: user.role,
    platform,
    chatId,
  });

  return {
    success: true,
    chatId,
    platform,
    displayName: [user.profile?.firstName, user.profile?.lastName].filter(Boolean).join(' ')
                  || user.profile?.username
                  || 'Admin',
  };
}

/**
 * 驗證碼比對
 * @param {string} platform
 * @param {string} chatId
 * @param {string} code
 */
function verifyCode(platform, chatId, code) {
  const key = makeKey(platform, String(chatId));
  const pending = _pendingCodes.get(key);

  if (!pending) {
    return { success: false, error: '未找到驗證碼，請重新請求' };
  }

  if (Date.now() > pending.expiresAt) {
    _pendingCodes.delete(key);
    return { success: false, error: '驗證碼已過期，請重新請求' };
  }

  pending.attempts++;
  if (pending.attempts > MAX_ATTEMPTS) {
    _pendingCodes.delete(key);
    return { success: false, error: '嘗試次數過多，請重新請求' };
  }

  if (pending.code !== String(code)) {
    return { success: false, error: `驗證碼錯誤（剩餘 ${MAX_ATTEMPTS - pending.attempts} 次）` };
  }

  // 驗證通過
  _pendingCodes.delete(key);
  const token = crypto.randomBytes(32).toString('hex');

  _sessions.set(token, {
    chatId: String(chatId),
    platform,
    userId: pending.userId,
    role: pending.role,
    expiresAt: Date.now() + SESSION_TTL,
  });

  return { success: true, token };
}

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

function logout(token) {
  _sessions.delete(token);
}

function cleanup() {
  const now = Date.now();
  for (const [k, pending] of _pendingCodes) {
    if (now > pending.expiresAt) _pendingCodes.delete(k);
  }
  for (const [token, session] of _sessions) {
    if (now > session.expiresAt) _sessions.delete(token);
  }
  for (const [k, record] of _rateLimits) {
    if (now - record.start > RATE_LIMIT_WINDOW) _rateLimits.delete(k);
  }
}

const _cleanupInterval = setInterval(cleanup, 60000);
if (_cleanupInterval.unref) _cleanupInterval.unref();

module.exports = {
  requestVerifyCode,
  verifyCode,
  validateToken,
  logout,
  findUser,
  _pendingCodes,
};
