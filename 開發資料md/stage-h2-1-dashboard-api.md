# 階段 H2-1：Dashboard API 層 + WebSocket + Telegram 登入

> H1 多用戶權限系統已完成。本階段建立 Dashboard 的後端基礎：
> 1. bot-server 內建 HTTP server（localhost:3001）
> 2. REST API（提醒、記憶、logs、對話、用戶、系統狀態）
> 3. WebSocket 即時推送
> 4. Telegram 驗證碼登入

---

## 專案位置

```
~/sui-yao-agent/  (main 分支)
├── src/
│   ├── dashboard/                     # ⚡ 新建目錄
│   │   ├── server.js                  # ⚡ HTTP + WebSocket server
│   │   ├── api-routes.js              # ⚡ REST API 路由
│   │   ├── ws-manager.js              # ⚡ WebSocket 連線管理 + 事件推送
│   │   └── auth-web.js                # ⚡ Telegram 驗證碼登入
│   ├── bot-server.js                  # 🔧 修改：啟動時一起啟動 dashboard server
│   └── config.js                      # 🔧 修改：新增 dashboard 設定
├── public/                            # ⚡ 新建目錄（H2-2 前端用，本階段先建空的）
│   └── .gitkeep
└── package.json                       # 🔧 修改：加 ws 套件
```

---

## 設計原則

1. **Dashboard server 跟 bot-server 同進程**：共用 MongoDB 連線和所有模組 reference，不需要 IPC
2. **只綁 localhost**：內網用，不對外暴露
3. **API 全部走 admin 權限**：Dashboard 只有 admin 能登入，API 不需要細分角色
4. **WebSocket 推送是補充，不是唯一**：前端也可以定時 polling API，WebSocket 斷了不影響基本功能

---

## Step 1：安裝依賴

```bash
cd ~/sui-yao-agent
npm install ws --save
```

`ws` 是 Node.js 最成熟的 WebSocket 套件，零外部依賴。

---

## Step 2：config.js 新增 dashboard 設定

```javascript
// 在 config 物件裡加上（放在 cleanup 區塊後面）：

// Dashboard
dashboard: {
  port:          parseInt(process.env.DASHBOARD_PORT)           || 3001,
  host:          process.env.DASHBOARD_HOST                      || '127.0.0.1',
  sessionSecret: process.env.DASHBOARD_SESSION_SECRET            || 'sui-yao-dashboard-' + Date.now(),
  verifyCodeTTL: parseInt(process.env.DASHBOARD_VERIFY_CODE_TTL) || 300000,  // 5 分鐘
},
```

---

## Step 3：src/dashboard/auth-web.js — Telegram 驗證碼登入

```javascript
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

// 暫存驗證碼：{ chatId: { code, expiresAt, attempts } }
const _pendingCodes = new Map();

// 暫存 session token：{ token: { chatId, userId, role, expiresAt } }
const _sessions = new Map();

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 小時
const MAX_ATTEMPTS = 5;

/**
 * 產生驗證碼並回傳 chatId（由 API route 呼叫）
 * @param {string} identifier — Telegram username（不含@）或 chatId
 * @returns {Promise<{ success, chatId, error? }>}
 */
async function requestVerifyCode(identifier) {
  // 搜尋用戶
  const users = await auth.listUsers();
  const user = users.find(u => {
    return String(u.chatId) === identifier
      || (u.profile?.username || '').toLowerCase() === identifier.toLowerCase().replace('@', '');
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

  if (pending.code !== code) {
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

setInterval(cleanup, 60000);

module.exports = {
  requestVerifyCode,
  verifyCode,
  validateToken,
  logout,
  _pendingCodes, // 給 bot-server 發驗證碼時讀取
};
```

---

## Step 4：src/dashboard/ws-manager.js — WebSocket 管理

```javascript
/**
 * 穗鈅助手 — WebSocket 連線管理
 *
 * 管理所有 Dashboard 的 WebSocket 連線，推送即時事件。
 *
 * 事件類型：
 * - new_log      — 新的 execution log
 * - new_reminder — 提醒被觸發
 * - new_user     — 新用戶註冊
 * - status       — 系統狀態更新
 *
 * @version 1.0.0
 */

const WebSocket = require('ws');
const authWeb = require('./auth-web');

let _wss = null;

/**
 * 初始化 WebSocket server
 * @param {http.Server} httpServer
 */
function init(httpServer) {
  _wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

  _wss.on('connection', (ws, req) => {
    // 從 query string 取得 token 驗證
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    const { valid, session } = authWeb.validateToken(token);

    if (!valid) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    ws._session = session;
    console.log(`[ws] Dashboard 連線: ${session.userId}`);

    ws.on('close', () => {
      console.log(`[ws] Dashboard 斷線: ${session.userId}`);
    });

    // 心跳
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });

  // 心跳檢測（30 秒）
  const interval = setInterval(() => {
    if (!_wss) return;
    _wss.clients.forEach(ws => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  _wss.on('close', () => clearInterval(interval));
}

/**
 * 推送事件給所有已連線的 Dashboard
 * @param {string} type — 事件類型
 * @param {Object} data — 事件資料
 */
function broadcast(type, data) {
  if (!_wss) return;
  const message = JSON.stringify({ type, data, timestamp: new Date().toISOString() });

  _wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}

/**
 * 取得連線數
 */
function getConnectionCount() {
  if (!_wss) return 0;
  let count = 0;
  _wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) count++;
  });
  return count;
}

module.exports = { init, broadcast, getConnectionCount };
```

---

## Step 5：src/dashboard/api-routes.js — REST API

```javascript
/**
 * 穗鈅助手 — Dashboard REST API
 *
 * 所有路由都需要 token 認證（除了 /api/auth/*）。
 * API 只給 admin/advanced 用，不需要細分權限。
 *
 * @version 1.0.0
 */

const url = require('url');
const mongo = require('../../lib/mongodb-tools');
const auth = require('../auth');
const memoryManager = require('../memory-manager');
const authWeb = require('./auth-web');
const wsManager = require('./ws-manager');
const config = require('../config');

/**
 * 處理 API 請求
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {TelegramBot} bot — 發驗證碼用
 */
async function handleRequest(req, res, bot) {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  // CORS（本機用，寬鬆）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ========== 登入相關（不需要 token）==========

  // POST /api/auth/request-code — 請求驗證碼
  if (pathname === '/api/auth/request-code' && req.method === 'POST') {
    const body = await readBody(req);
    const { identifier } = JSON.parse(body);
    const result = await authWeb.requestVerifyCode(identifier);

    if (result.success) {
      // 透過 bot 發驗證碼到用戶的 Telegram
      const pending = authWeb._pendingCodes.get(result.chatId);
      if (pending && bot) {
        try {
          await bot.sendMessage(result.chatId, `🔐 Dashboard 登入驗證碼：${pending.code}\n\n5 分鐘內有效，請勿分享。`);
        } catch (err) {
          return sendJSON(res, 500, { success: false, error: '驗證碼發送失敗' });
        }
      }
      return sendJSON(res, 200, { success: true, displayName: result.displayName });
    }
    return sendJSON(res, 400, result);
  }

  // POST /api/auth/verify — 驗證碼比對
  if (pathname === '/api/auth/verify' && req.method === 'POST') {
    const body = await readBody(req);
    const { identifier, code } = JSON.parse(body);

    // 用 identifier 找 chatId
    const users = await auth.listUsers();
    const user = users.find(u =>
      String(u.chatId) === identifier
      || (u.profile?.username || '').toLowerCase() === identifier.toLowerCase().replace('@', '')
    );
    if (!user) return sendJSON(res, 400, { success: false, error: '找不到用戶' });

    const result = authWeb.verifyCode(user.chatId, code);
    return sendJSON(res, result.success ? 200 : 400, result);
  }

  // POST /api/auth/logout
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = getToken(req);
    if (token) authWeb.logout(token);
    return sendJSON(res, 200, { success: true });
  }

  // ========== 以下路由需要 token ==========

  const token = getToken(req);
  const { valid, session } = authWeb.validateToken(token);
  if (!valid) {
    return sendJSON(res, 401, { error: 'Unauthorized' });
  }

  const db = await mongo.getDb();

  // ========== 系統狀態 ==========

  // GET /api/status
  if (pathname === '/api/status' && req.method === 'GET') {
    const [
      userCount,
      reminderCount,
      memoryDoc,
      logCount,
      convCount,
    ] = await Promise.all([
      db.collection('users').countDocuments(),
      db.collection('reminders').countDocuments({ status: 'pending' }),
      db.collection('memories').findOne({ userId: session.userId }),
      db.collection('execution_logs').countDocuments(),
      db.collection('conversations').countDocuments(),
    ]);

    return sendJSON(res, 200, {
      bot: { name: config.app.name, version: config.app.version, model: config.llm.defaultModel },
      users: userCount,
      pendingReminders: reminderCount,
      memories: memoryDoc?.memories?.length || 0,
      executionLogs: logCount,
      conversations: convCount,
      dashboard: { wsConnections: wsManager.getConnectionCount() },
      uptime: process.uptime(),
    });
  }

  // ========== 提醒 ==========

  // GET /api/reminders?status=pending&userId=xxx
  if (pathname === '/api/reminders' && req.method === 'GET') {
    const filter = {};
    if (query.status) filter.status = query.status;
    if (query.userId) filter.userId = query.userId;
    // admin 看所有，其他只看自己
    if (session.role !== 'admin') filter.userId = session.userId;

    const reminders = await db.collection('reminders')
      .find(filter).sort({ remindAt: 1 }).limit(100).toArray();
    reminders.forEach(r => r._id = r._id.toString());
    return sendJSON(res, 200, { reminders });
  }

  // DELETE /api/reminders/:id
  if (pathname.startsWith('/api/reminders/') && req.method === 'DELETE') {
    const { ObjectId } = require('mongodb');
    const id = pathname.split('/')[3];
    const result = await db.collection('reminders').updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: 'cancelled', cancelledAt: new Date() } }
    );
    return sendJSON(res, 200, { success: result.modifiedCount > 0 });
  }

  // ========== 記憶 ==========

  // GET /api/memories?userId=xxx
  if (pathname === '/api/memories' && req.method === 'GET') {
    const targetUserId = (session.role === 'admin' && query.userId) ? query.userId : session.userId;
    const memories = await memoryManager.getMemories(targetUserId);
    return sendJSON(res, 200, { memories, userId: targetUserId });
  }

  // PUT /api/memories/:id — 更新 importance
  if (pathname.match(/^\/api\/memories\/[^/]+$/) && req.method === 'PUT') {
    const memId = pathname.split('/')[3];
    const body = await readBody(req);
    const { importance, content } = JSON.parse(body);
    const targetUserId = (session.role === 'admin' && query.userId) ? query.userId : session.userId;

    if (importance !== undefined) {
      await db.collection('memories').updateOne(
        { userId: targetUserId, 'memories.id': memId },
        { $set: { 'memories.$.importance': Number(importance) } }
      );
    }
    if (content !== undefined) {
      await memoryManager.updateMemory(targetUserId, memId, content);
    }
    return sendJSON(res, 200, { success: true });
  }

  // DELETE /api/memories/:id
  if (pathname.match(/^\/api\/memories\/[^/]+$/) && req.method === 'DELETE') {
    const memId = pathname.split('/')[3];
    const targetUserId = (session.role === 'admin' && query.userId) ? query.userId : session.userId;
    await memoryManager.deleteMemory(targetUserId, memId);
    return sendJSON(res, 200, { success: true });
  }

  // ========== Execution Logs ==========

  // GET /api/logs?limit=50&skill=xxx&status=xxx
  if (pathname === '/api/logs' && req.method === 'GET') {
    const filter = {};
    if (query.skill) filter.skill = query.skill;
    if (query.status) filter.status = query.status;
    if (session.role !== 'admin') filter.userId = session.userId;

    const limit = Math.min(parseInt(query.limit) || 50, 200);
    const logs = await db.collection('execution_logs')
      .find(filter).sort({ timestamp: -1 }).limit(limit).toArray();
    logs.forEach(l => l._id = l._id.toString());
    return sendJSON(res, 200, { logs });
  }

  // ========== 對話歷史 ==========

  // GET /api/conversations?userId=xxx
  if (pathname === '/api/conversations' && req.method === 'GET') {
    const filter = {};
    if (session.role !== 'admin') filter.userId = session.userId;
    else if (query.userId) filter.userId = query.userId;

    const conversations = await db.collection('conversations')
      .find(filter).sort({ updatedAt: -1 }).limit(20).toArray();
    conversations.forEach(c => c._id = c._id.toString());
    return sendJSON(res, 200, { conversations });
  }

  // GET /api/conversations/:chatId
  if (pathname.match(/^\/api\/conversations\/\d+$/) && req.method === 'GET') {
    const targetChatId = Number(pathname.split('/')[3]);
    const conv = await db.collection('conversations').findOne({ chatId: targetChatId });
    if (!conv) return sendJSON(res, 404, { error: 'Not found' });
    conv._id = conv._id.toString();
    return sendJSON(res, 200, conv);
  }

  // ========== 用戶管理 ==========

  // GET /api/users
  if (pathname === '/api/users' && req.method === 'GET') {
    if (session.role !== 'admin') return sendJSON(res, 403, { error: 'Forbidden' });
    const users = await auth.listUsers();
    users.forEach(u => u._id = u._id.toString());
    return sendJSON(res, 200, { users });
  }

  // PUT /api/users/:chatId — 修改角色/狀態
  if (pathname.match(/^\/api\/users\/\d+$/) && req.method === 'PUT') {
    if (session.role !== 'admin') return sendJSON(res, 403, { error: 'Forbidden' });
    const targetChatId = Number(pathname.split('/')[3]);
    const body = await readBody(req);
    const { role, status } = JSON.parse(body);

    if (role) await auth.setUserRole(targetChatId, role);
    if (status === 'blocked') await auth.approveUser(targetChatId, 'block');
    if (status === 'active') await auth.approveUser(targetChatId, 'approve', role || 'user', session.userId);

    return sendJSON(res, 200, { success: true });
  }

  // ========== 404 ==========
  return sendJSON(res, 404, { error: 'Not found' });
}

// ========== 輔助函式 ==========

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function getToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  // 也支援 query string（WebSocket 用）
  const parsedUrl = url.parse(req.url, true);
  return parsedUrl.query.token || null;
}

module.exports = { handleRequest };
```

---

## Step 6：src/dashboard/server.js — HTTP + WebSocket 啟動

```javascript
/**
 * 穗鈅助手 — Dashboard HTTP + WebSocket Server
 *
 * 跟 bot-server 同進程，共用 MongoDB 連線。
 * 綁定 localhost，不對外暴露。
 *
 * @version 1.0.0
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const apiRoutes = require('./api-routes');
const wsManager = require('./ws-manager');

let _server = null;
let _bot = null;

/**
 * 啟動 Dashboard server
 * @param {TelegramBot} bot — Telegram bot instance（發驗證碼用）
 */
function start(bot) {
  _bot = bot;
  const port = config.dashboard.port;
  const host = config.dashboard.host;

  _server = http.createServer(async (req, res) => {
    const pathname = require('url').parse(req.url).pathname;

    // API 路由
    if (pathname.startsWith('/api/')) {
      try {
        await apiRoutes.handleRequest(req, res, _bot);
      } catch (err) {
        console.error('[dashboard] API error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
      return;
    }

    // 靜態檔案（public/ 目錄）
    serveStatic(req, res);
  });

  // 初始化 WebSocket
  wsManager.init(_server);

  _server.listen(port, host, () => {
    console.log(`   Dashboard: http://${host}:${port}`);
  });

  return _server;
}

/**
 * 提供靜態檔案
 */
function serveStatic(req, res) {
  const publicDir = path.join(__dirname, '../../public');
  let filePath = path.join(publicDir, req.url === '/' ? 'index.html' : req.url);

  // 安全檢查：不允許路徑穿越
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // 找不到靜態檔案 → 回傳 index.html（SPA fallback）
      fs.readFile(path.join(publicDir, 'index.html'), (err2, html) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function stop() {
  if (_server) _server.close();
}

module.exports = { start, stop };
```

---

## Step 7：bot-server.js 整合

### 7.1 啟動 dashboard

在 `startBot()` 函式裡，Telegram bot 啟動之後，加上 dashboard 啟動：

```javascript
// 在 bot.getMe().then(...) 的 console.log 之後加上：

// 啟動 Dashboard
const dashboard = require('./dashboard/server');
const dashboardServer = dashboard.start(bot);
```

### 7.2 在關鍵位置加 WebSocket 推送

在 bot-server.js 裡需要即時推送的地方加上 `wsManager.broadcast()`：

```javascript
const wsManager = require('./dashboard/ws-manager');

// (a) 新用戶註冊時
if (authResult.status === 'new') {
  // ... 現有邏輯 ...
  wsManager.broadcast('new_user', { user: authResult.user });
}

// (b) tool-executor 執行完 skill 後（在 tool-executor.js 裡）
// 在 writeExecutionLog 之後加上：
wsManager.broadcast('new_log', {
  skill: funcName,
  status: 'success',
  summary: result.summary,
  durationMs,
  timestamp: new Date().toISOString(),
});
```

**注意**：tool-executor.js 裡 require ws-manager 會有路徑問題，建議用 event emitter 解耦：

```javascript
// 簡單做法：在 tool-executor.js export 一個 event hook
// bot-server.js 啟動時設定 hook

// tool-executor.js 加上：
let _onExecute = null;
function setOnExecuteHook(fn) { _onExecute = fn; }

// 在 execute() 成功後：
if (_onExecute) _onExecute({ skill: funcName, status: 'success', summary: result.summary, durationMs });

module.exports = { execute, getSkills, resetCache, setOnExecuteHook };

// bot-server.js 啟動時：
toolExecutor.setOnExecuteHook((event) => {
  wsManager.broadcast('new_log', event);
});
```

---

## Step 8：建立 public/ 目錄

```bash
mkdir -p ~/sui-yao-agent/public
touch ~/sui-yao-agent/public/.gitkeep
```

H2-2 會在這裡放前端檔案。目前先放一個佔位的 index.html：

```html
<!-- public/index.html -->
<!DOCTYPE html>
<html><body><h1>穗鈅助手 Dashboard</h1><p>建構中...</p></body></html>
```

---

## 驗證

### 語法檢查

```bash
node -c src/dashboard/server.js && echo '✅ server' || echo '❌'
node -c src/dashboard/api-routes.js && echo '✅ api-routes' || echo '❌'
node -c src/dashboard/ws-manager.js && echo '✅ ws-manager' || echo '❌'
node -c src/dashboard/auth-web.js && echo '✅ auth-web' || echo '❌'
node -c src/bot-server.js && echo '✅ bot-server' || echo '❌'
node -c src/tool-executor.js && echo '✅ tool-executor' || echo '❌'
```

### 模組載入

```bash
node -e "
const authWeb = require('./src/dashboard/auth-web');
console.log('requestVerifyCode:', typeof authWeb.requestVerifyCode === 'function' ? '✅' : '❌');
console.log('verifyCode:', typeof authWeb.verifyCode === 'function' ? '✅' : '❌');
console.log('validateToken:', typeof authWeb.validateToken === 'function' ? '✅' : '❌');
"
```

### API 測試（bot 啟動後）

```bash
# 系統狀態（需要先拿 token，或暫時跳過 auth 測試）
curl http://127.0.0.1:3001/api/status
# 預期：401 Unauthorized（沒帶 token）

# 確認 server 有啟動
curl -s http://127.0.0.1:3001/ | head -1
# 預期：<!DOCTYPE html>
```

### 完整登入流程測試

1. 啟動 bot-server（會一起啟動 dashboard）
2. 瀏覽器開 `http://127.0.0.1:3001`（看到建構中頁面）
3. `curl -X POST http://127.0.0.1:3001/api/auth/request-code -H 'Content-Type: application/json' -d '{"identifier":"你的chatId"}'`
4. 你的 Telegram 收到 6 位驗證碼
5. `curl -X POST http://127.0.0.1:3001/api/auth/verify -H 'Content-Type: application/json' -d '{"identifier":"你的chatId","code":"123456"}'`
6. 拿到 token
7. `curl -H 'Authorization: Bearer {token}' http://127.0.0.1:3001/api/status`
8. 回傳系統狀態 JSON

---

## 注意事項

1. **ws 套件需要 npm install**：`npm install ws --save`，這是唯一新增的依賴。
2. **Dashboard 綁 127.0.0.1**：只有本機能訪問。如果要從其他電腦訪問（例如手機），改 host 為 `0.0.0.0`，但要注意安全。
3. **驗證碼發送依賴 bot instance**：`api-routes.js` 的 `handleRequest` 接收 bot 參數，用 `bot.sendMessage` 發驗證碼。
4. **tool-executor 的 WebSocket 推送用 hook 解耦**：避免 tool-executor 直接 require dashboard 模組，保持分層乾淨。
5. **H2-2 會替換 public/index.html**：目前只是佔位，前端在下一階段做。

---

## API 總覽

| Method | Path | 說明 | 認證 |
|---|---|---|---|
| POST | /api/auth/request-code | 請求驗證碼 | 不需要 |
| POST | /api/auth/verify | 驗證碼比對 | 不需要 |
| POST | /api/auth/logout | 登出 | 不需要 |
| GET | /api/status | 系統狀態 | 需要 |
| GET | /api/reminders | 提醒列表 | 需要 |
| DELETE | /api/reminders/:id | 取消提醒 | 需要 |
| GET | /api/memories | 記憶列表 | 需要 |
| PUT | /api/memories/:id | 更新記憶 | 需要 |
| DELETE | /api/memories/:id | 刪除記憶 | 需要 |
| GET | /api/logs | Execution logs | 需要 |
| GET | /api/conversations | 對話列表 | 需要 |
| GET | /api/conversations/:chatId | 單一對話歷史 | 需要 |
| GET | /api/users | 用戶列表 | 需要(admin) |
| PUT | /api/users/:chatId | 修改用戶 | 需要(admin) |
| WS | /ws?token=xxx | WebSocket 即時推送 | 需要 |
