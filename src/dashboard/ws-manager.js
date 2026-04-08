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
  if (interval.unref) interval.unref();

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
