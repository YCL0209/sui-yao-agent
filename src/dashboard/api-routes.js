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
    const { identifier } = JSON.parse(body || '{}');
    const result = await authWeb.requestVerifyCode(identifier);

    if (result.success) {
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
    const { identifier, code } = JSON.parse(body || '{}');

    const users = await auth.listUsers();
    const target = String(identifier).toLowerCase().replace('@', '');
    const user = users.find(u =>
      String(u.chatId) === String(identifier)
      || (u.profile?.username || '').toLowerCase() === target
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

  // PUT /api/memories/:id — 更新 importance / content
  if (pathname.match(/^\/api\/memories\/[^/]+$/) && req.method === 'PUT') {
    const memId = pathname.split('/')[3];
    const body = await readBody(req);
    const { importance, content } = JSON.parse(body || '{}');
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
    const { role, status } = JSON.parse(body || '{}');

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
