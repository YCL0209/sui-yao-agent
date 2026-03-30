/**
 * 簡易 Logger — 為所有 console 輸出加上時間戳記
 */

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

module.exports = {
  log: (...args) => console.log(`[${timestamp()}]`, ...args),
  warn: (...args) => console.warn(`[${timestamp()}]`, ...args),
  error: (...args) => console.error(`[${timestamp()}]`, ...args),
};
