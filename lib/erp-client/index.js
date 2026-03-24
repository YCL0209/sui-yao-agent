/**
 * ERP Client — 共用 ERP API 認證模組
 *
 * 從 create-order / generate-pdf / print-label 三個 skill 抽出的共用邏輯。
 * 提供 JWT token 管理（cache + refresh + re-auth）和帶認證的 API 呼叫。
 *
 * @version 1.0.0
 */

const config = require('../../src/config');

// ========================================
// Token State（模組級快取）
// ========================================

let jwtToken = null;
let sessionId = null;
let tokenExpiry = 0;

// ========================================
// Authentication
// ========================================

/**
 * 確保有有效的 JWT token
 * 快取中有效 → 直接用；即將過期 → refresh；過期 → 重新登入
 */
async function ensureAuthenticated() {
  const now = Date.now();

  // Token 仍有效（留 1 分鐘 buffer）
  if (jwtToken && now < tokenExpiry - 60000) {
    return jwtToken;
  }

  // 嘗試 refresh
  if (sessionId && jwtToken) {
    try {
      const res = await fetch(`${config.erp.apiUrl}/api/auth/refresh-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwtToken}`
        },
        body: JSON.stringify({ sessionId })
      });

      const data = await res.json();
      if (data.success) {
        jwtToken = data.data.token;
        tokenExpiry = now + (data.data.expiresIn * 1000);
        console.log('[ERP] Token refreshed successfully');
        return jwtToken;
      }
    } catch (e) {
      console.warn('[ERP] Token refresh failed, re-authenticating...', e.message);
    }
  }

  // 重新登入
  console.log('[ERP] Authenticating as bot account...');
  const res = await fetch(`${config.erp.apiUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taxId: config.erp.taxId,
      email: config.erp.botEmail,
      password: config.erp.botPassword
    })
  });

  const data = await res.json();

  if (!data.success) {
    throw new Error(`ERP authentication failed: ${data.message}`);
  }

  jwtToken = data.data.token;
  sessionId = data.data.sessionId;
  tokenExpiry = now + (data.data.expiresIn * 1000);

  console.log('[ERP] Authenticated successfully, token valid for', data.data.expiresIn, 'seconds');
  return jwtToken;
}

// ========================================
// API 呼叫
// ========================================

/**
 * 帶認證的 ERP API 呼叫
 * @param {string} apiPath - API 路徑（例如 '/api/orders'）
 * @param {object} options - fetch options（method, body, headers 等）
 */
async function erpFetch(apiPath, options = {}) {
  const token = await ensureAuthenticated();

  const url = `${config.erp.apiUrl}${apiPath}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...options.headers,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    console.error('[ERP] API error:', response.status, data);
  }

  return data;
}

/**
 * 重設認證狀態（用於測試）
 */
function resetAuth() {
  jwtToken = null;
  sessionId = null;
  tokenExpiry = 0;
}

// ========================================
// Export
// ========================================

module.exports = {
  ensureAuthenticated,
  erpFetch,
  resetAuth,
};
