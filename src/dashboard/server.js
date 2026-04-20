/**
 * 穗鈅助手 — Dashboard HTTP + WebSocket Server
 *
 * 跟 bot-server 同進程，共用 MongoDB 連線。
 * 預設綁定 127.0.0.1，不對外暴露。
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
let _adapters = null;

/**
 * 啟動 Dashboard server
 * @param {Object} adapters — { telegram?: TelegramAdapter, discord?: DiscordAdapter }
 */
function start(adapters) {
  _adapters = adapters || {};
  const port = config.dashboard.port;
  const host = config.dashboard.host;

  _server = http.createServer(async (req, res) => {
    const pathname = require('url').parse(req.url).pathname;

    // API 路由
    if (pathname.startsWith('/api/')) {
      try {
        await apiRoutes.handleRequest(req, res, _adapters);
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
  const reqPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(publicDir, reqPath);

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
