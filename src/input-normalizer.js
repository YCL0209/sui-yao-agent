/**
 * 穗鈅助手 — 輸入正規化（Phase I1：多平台）
 *
 * 把各平台的 raw 訊息物件轉成 adapter-interface 的 raw 形式：
 *   { chatId, userId, profile, textContent, attachments, messageId, replyToId?, timestamp }
 *
 * Adapter 的 handleIncoming(raw) 會把這個 raw 加上 platform 等欄位變成 normalizedMsg。
 *
 * @version 2.0.0
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

function mimeExtension(mime) {
  const map = {
    'application/pdf': '.pdf',
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
  };
  return map[mime] || '';
}

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
}

// ============================================================
// Telegram
// ============================================================

/**
 * @param {Object} msg - Telegram message 物件
 * @param {Object} bot - TelegramBot 實例（getFileLink 用）
 * @returns {Promise<Object>} adapter raw 形式
 */
async function normalizeTelegramInput(msg, bot) {
  ensureTmpDir();

  const chatId = String(msg.chat.id);
  const from = msg.from || {};
  const textContent = msg.text || msg.caption || '';
  const attachments = [];

  // PDF / document
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

  return {
    chatId,
    userId: String(from.id || msg.chat.id),
    profile: {
      firstName:    from.first_name    || '',
      lastName:     from.last_name     || '',
      username:     from.username      || '',
      languageCode: from.language_code || '',
    },
    textContent,
    attachments,
    messageId: String(msg.message_id),
    replyToId: msg.reply_to_message ? String(msg.reply_to_message.message_id) : null,
    timestamp: new Date((msg.date || Math.floor(Date.now() / 1000)) * 1000),
  };
}

// ============================================================
// Discord（Step 10/11 啟用）
// ============================================================

/**
 * @param {Object} msg - discord.js Message 物件
 * @param {Object} client - discord.js Client（取 botId 清 mention 用）
 * @returns {Promise<Object>} adapter raw 形式
 */
async function normalizeDiscordInput(msg, client) {
  ensureTmpDir();

  const attachments = [];

  // 下載 Discord CDN 上的附件
  if (msg.attachments && msg.attachments.size > 0) {
    for (const att of msg.attachments.values()) {
      const mimeType = att.contentType || 'application/octet-stream';
      const type = getAttachmentType(mimeType);
      const ext = path.extname(att.name || '') || mimeExtension(mimeType);
      const localName = `${msg.channel.id}-${Date.now()}${ext}`;
      const filePath = path.join(TMP_DIR, localName);

      const res = await fetch(att.url);
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(filePath, buffer);

      attachments.push({
        type,
        filePath,
        originalName: att.name || localName,
        fileSize: att.size || buffer.length,
        mimeType,
      });
    }
  }

  // 清掉 @bot mention
  const botId = client?.user?.id;
  let textContent = msg.content || '';
  if (botId) {
    textContent = textContent.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
  }

  return {
    chatId: msg.channel.id,
    userId: msg.author.id,
    profile: {
      username:      msg.author.username       || '',
      discriminator: msg.author.discriminator  || '',
      avatarUrl:     msg.author.displayAvatarURL?.() || '',
    },
    textContent,
    attachments,
    messageId: msg.id,
    replyToId: msg.reference?.messageId || null,
    timestamp: msg.createdAt || new Date(),
  };
}

// ============================================================
// Export
// ============================================================

module.exports = {
  normalizeTelegramInput,
  normalizeDiscordInput,
  // 兼容舊 API（doc-agent 重構過後不再用，此處留著避免外部 require 立即斷掉）
  normalizeInput: normalizeTelegramInput,
};
