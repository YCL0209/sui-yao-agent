/**
 * error-notify.js — 錯誤通知
 *
 * 透過 Telegram Bot API 發送錯誤通知給 admin。
 *
 * @version 1.0.0
 */

const https = require('https');
const config = require('./config');

/**
 * 發送通知到 Telegram admin chat
 *
 * @param {string} message - 通知內容
 * @returns {Promise<object>}
 */
function send(message) {
  const botToken = config.telegram.botToken;
  const chatId = config.telegram.adminChatId;

  if (!botToken || !chatId) {
    console.warn('[error-notify] 缺少 botToken 或 adminChatId，跳過通知');
    return Promise.resolve({ ok: false, reason: 'missing config' });
  }

  const timestamp = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const text = `⚠️ 穗鈅助手通知\n\n${message}\n\n🕐 ${timestamp}`.slice(0, 4000);

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ chat_id: chatId, text });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Telegram API parse error: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { send };
