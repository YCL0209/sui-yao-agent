/**
 * 穗鈅助手 — 輸入正規化
 *
 * 把 Telegram 訊息物件轉成統一輸入結構，
 * 讓下游模組不需要直接處理 Telegram API 格式。
 *
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');

const TMP_DIR = '/tmp/sui-yao-uploads';

// ============================================================
// MIME → attachment type 對應
// ============================================================

function getAttachmentType(mimeType) {
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType && mimeType.startsWith('image/')) return 'image';
  return 'other';
}

// ============================================================
// normalizeInput
// ============================================================

/**
 * 把 Telegram 訊息物件正規化為統一輸入結構。
 * 呼叫時需傳入 bot 實例（用於取得檔案連結並下載）。
 *
 * @param {Object} msg - Telegram message 物件
 * @param {Object} bot - TelegramBot 實例
 * @returns {Promise<NormalizedInput>}
 *
 * @typedef {Object} NormalizedInput
 * @property {'telegram'} source
 * @property {string|null} textContent
 * @property {Array<Attachment>} attachments
 * @property {InputMetadata} metadata
 *
 * @typedef {Object} Attachment
 * @property {'pdf'|'image'|'other'} type
 * @property {string} filePath
 * @property {string} originalName
 * @property {number} fileSize
 * @property {string} mimeType
 *
 * @typedef {Object} InputMetadata
 * @property {string} senderId
 * @property {string} senderName
 * @property {string} chatId
 * @property {number} messageId
 * @property {Date} timestamp
 */
async function normalizeInput(msg, bot) {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

  const chatId = String(msg.chat.id);
  const from = msg.from || {};

  const metadata = {
    senderId: String(from.id || chatId),
    senderName: [from.first_name, from.last_name].filter(Boolean).join(' ') || '',
    chatId,
    messageId: msg.message_id,
    timestamp: new Date((msg.date || Math.floor(Date.now() / 1000)) * 1000),
  };

  const textContent = msg.text || msg.caption || null;
  const attachments = [];

  // PDF 或其他文件
  if (msg.document) {
    const doc = msg.document;
    const mimeType = doc.mime_type || 'application/octet-stream';
    const ext = path.extname(doc.file_name || '') || mimeExtension(mimeType);
    const localName = `${chatId}-${Date.now()}${ext}`;
    const filePath = path.join(TMP_DIR, localName);

    const fileLink = await bot.getFileLink(doc.file_id);
    const res = await fetch(fileLink);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    attachments.push({
      type: getAttachmentType(mimeType),
      filePath,
      originalName: doc.file_name || localName,
      fileSize: doc.file_size || buffer.length,
      mimeType,
    });
  }

  // 圖片（取最大解析度）
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    const localName = `${chatId}-${Date.now()}.jpg`;
    const filePath = path.join(TMP_DIR, localName);

    const fileLink = await bot.getFileLink(photo.file_id);
    const res = await fetch(fileLink);
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    attachments.push({
      type: 'image',
      filePath,
      originalName: localName,
      fileSize: photo.file_size || buffer.length,
      mimeType: 'image/jpeg',
    });
  }

  return { source: 'telegram', textContent, attachments, metadata };
}

// ============================================================
// 輔助
// ============================================================

function mimeExtension(mime) {
  const map = {
    'application/pdf': '.pdf',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
  };
  return map[mime] || '';
}

// ============================================================
// Export
// ============================================================

module.exports = { normalizeInput };
