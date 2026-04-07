/**
 * 穗鈅助手 — 文件處理 Agent
 *
 * 處理 PDF / 圖片的分類、解析、結構化。
 * 解析完成後如果是訂單類文件，交給 order-agent 接手建單。
 *
 * 互動場景：
 * - _ambiguous（兩個公司名無法判斷客戶時，按鈕讓用戶選）
 *
 * callback_data 格式：doc:{action}:{payload}
 *
 * @version 1.0.0
 */

const ism = require('../interactive-session');
const agentRegistry = require('../agent-registry');
const { normalizeInput } = require('../input-normalizer');
const { classifyDocument, computeFileHash, updateDocumentStatus } = require('../document-classifier');
const { getDocType } = require('../doc-classification');

// ========================================
// 面向用戶的文字（調教在這裡改）
// ========================================

const MESSAGES = {
  classifying: '📄 正在辨識文件類型...',
  recognized: (label, confidence) => `📄 文件辨識結果\n類型：${label}\n信心度：${confidence}%\n\n正在為您解析內容...`,
  recognizedCategory: (category) => `📄 文件辨識結果\n類別：${category}\n\n正在為您解析內容...`,
  unknownTrying: '📄 無法辨識此文件類型，嘗試為您解析...',
  nonOrderDoc: (label) => `✅ 已辨識為${label}，已記錄。\n目前尚未支援自動處理此類型單據。`,
  unsupportedFormat: '目前只支援 PDF 和圖片檔案。',
  extractFailed: (sourceType) => `無法從${sourceType}中提取有效內容。`,
  parseFailed: (sourceType, preview) => `無法從${sourceType}中辨識訂單資訊。\n\n提取的內容：\n${preview}`,
  processFailed: (reason) => `處理失敗：${reason}`,
  ambiguousPrompt: (itemCount, itemsSummary) =>
    `📄 已解析 ${itemCount} 個品項：\n${itemsSummary}\n\n無法自動判斷客戶，請選擇：`,
  ambiguousExpired: '建單流程已過期，請重新傳送文件。',
  cancelled: '❌ 已取消。',
};

// 訂單類文件類型
const ORDER_DOC_TYPES = new Set(['quotation', 'purchase_order']);

// ========================================
// 核心處理函式
// ========================================

/**
 * 處理一個文件/圖片訊息
 *
 * 這是 doc-agent 的主入口。bot-server 收到 PDF/圖片後直接呼叫這個。
 * 不走 ISM 的 onStart（因為文件處理的「開始」是收到檔案，不是用戶打字或按按鈕）。
 *
 * @param {Object} msg — Telegram message 物件
 * @param {Object} bot — TelegramBot instance（用於下載檔案）
 * @param {Object} context — { chatId, userId }
 * @returns {Promise<Object|null>} — { text, reply_markup?, _startOrder?, _parsed? } 或 null
 */
async function handleDocument(msg, bot, context) {
  const { chatId, userId } = context;
  const fs = require('fs');
  const docParser = require('../document-parser');
  const llmAdapter = require('../llm-adapter');

  // 1. 正規化輸入
  const input = await normalizeInput(msg, bot);

  // 2. 分類文件
  const classification = await classifyDocument(input);
  console.log(`[doc-agent] 分類結果: category=${classification.category}, docType=${classification.docType}, confidence=${classification.confidence}`);

  // 3. 非訂單類文件 → 記錄但不解析
  if (classification.docType && !ORDER_DOC_TYPES.has(classification.docType)) {
    const typeDef = getDocType(classification.docType);
    const label = typeDef ? typeDef.label : classification.docType;
    const att = input.attachments[0];
    if (att) try { fs.unlinkSync(att.filePath); } catch (_) {}
    return { text: MESSAGES.nonOrderDoc(label) };
  }

  // 4. unknown 且無商業內容 → 跳過
  if (classification.category === 'unknown' && !classification.hasBusinessContent) {
    console.log('[doc-agent] 非商業內容圖片，跳過');
    const att = input.attachments[0];
    const fh = att ? computeFileHash(att.filePath) : null;
    if (fh) updateDocumentStatus(fh, 'skipped', { reason: '非商業內容' }).catch(() => {});
    if (att) try { fs.unlinkSync(att.filePath); } catch (_) {}
    return null; // null = 不回覆（跳過生活照等）
  }

  // 5. 回覆分類結果
  let classificationText = '';
  if (classification.category === 'unknown') {
    classificationText = MESSAGES.unknownTrying;
  } else if (classification.docType) {
    const typeDef = getDocType(classification.docType);
    const label = typeDef ? typeDef.label : classification.docType;
    const pct = Math.round(classification.confidence * 100);
    classificationText = MESSAGES.recognized(label, pct);
  } else {
    classificationText = MESSAGES.recognizedCategory(classification.category);
  }

  // 6. 檢查附件格式
  const attachment = input.attachments[0];
  const fileHash = attachment ? computeFileHash(attachment.filePath) : null;

  if (!attachment || (attachment.type !== 'pdf' && attachment.type !== 'image')) {
    return { text: classificationText + '\n\n' + MESSAGES.unsupportedFormat };
  }

  // 7. 提取文字
  let extractedText = '';
  let sourceType = '';

  if (attachment.type === 'pdf') {
    sourceType = 'PDF';
    extractedText = await docParser.parsePDF(attachment.filePath);
    console.log('[doc-agent] PDF 提取文字:', extractedText.substring(0, 500));
  } else {
    sourceType = '圖片';
    extractedText = await docParser.parseImage(attachment.filePath);
  }

  // 清理暫存檔
  try { fs.unlinkSync(attachment.filePath); } catch (_) {}

  if (!extractedText || extractedText.trim().length < 10) {
    if (fileHash) updateDocumentStatus(fileHash, 'parse_failed', { reason: '無法提取有效內容' }).catch(() => {});
    return { text: classificationText + '\n\n' + MESSAGES.extractFailed(sourceType) };
  }

  // 8. LLM 結構化解析
  const parsed = await docParser.extractOrderFromText(extractedText, llmAdapter);

  if (!parsed || (!parsed.items?.length && !parsed.customerName)) {
    if (fileHash) updateDocumentStatus(fileHash, 'parse_failed', { reason: '無法辨識訂單資訊', extractedText: extractedText.substring(0, 500) }).catch(() => {});
    return { text: classificationText + '\n\n' + MESSAGES.parseFailed(sourceType, extractedText.substring(0, 500)) };
  }

  // 解析成功
  if (fileHash) updateDocumentStatus(fileHash, 'parsed', parsed).catch(() => {});

  // 9. _ambiguous：兩個公司名無法判斷 → 開 ISM session 等用戶選
  if (parsed._ambiguous) {
    const { sender, receiver } = parsed._ambiguous;

    // 用 ISM 開一個 doc session 暫存 parsed
    await ism.startSession('doc', { chatId, userId, initialData: { parsed } });

    const itemsSummary = parsed.items.map(i => `  • ${i.name} ×${i.quantity} @${i.price}`).join('\n');
    return {
      text: classificationText + '\n\n' + MESSAGES.ambiguousPrompt(parsed.items.length, itemsSummary),
      reply_markup: {
        inline_keyboard: [
          [{ text: sender, callback_data: 'doc:pickcustomer:sender' }],
          [{ text: receiver, callback_data: 'doc:pickcustomer:receiver' }],
          [{ text: '❌ 取消', callback_data: 'doc:cancel' }],
        ],
      },
    };
  }

  // 10. 解析完成，標記交給 bot-server 啟動 order session
  return {
    text: classificationText,
    _startOrder: true,
    _parsed: parsed,
  };
}

// ========================================
// ISM Handler（只用於 _ambiguous 的按鈕互動）
// ========================================

const docHandler = {
  ttl: 5 * 60 * 1000, // 5 分鐘（比 order session 短，只是等一個按鈕）

  // doc session 不需要 onStart（handleDocument 直接建 session）
  // ISM 要求必須有 onStart，留空 stub
  async onStart({ session }) {
    return { text: '' };
  },

  async onCallback(session, action, payload, context) {
    const { chatId, userId } = context;

    // cancel
    if (action === 'cancel') {
      return { text: MESSAGES.cancelled, done: true };
    }

    // pickcustomer:{sender|receiver}
    if (action === 'pickcustomer') {
      const choice = payload; // 'sender' or 'receiver'
      const parsed = session.data.parsed;

      if (!parsed || !parsed._ambiguous) {
        return { text: MESSAGES.ambiguousExpired, done: true };
      }

      const amb = parsed._ambiguous;
      parsed.customerName = choice === 'sender' ? amb.sender : amb.receiver;
      parsed.type = choice === 'sender' ? 'purchase' : 'sales';
      delete parsed._ambiguous;

      // 清除 doc session，啟動 order session
      // 回傳特殊標記讓 bot-server 知道要啟動 order
      return {
        text: '',
        done: true,
        _startOrder: true,
        _parsed: parsed,
        _chatId: chatId,
        _userId: userId,
      };
    }

    return { text: MESSAGES.cancelled, done: true };
  },

  async onTimeout(session) {
    console.log(`[doc-agent] Session 超時: chat=${session.chatId}`);
  },
};

// ========================================
// 註冊
// ========================================

ism.registerHandler('doc', docHandler);

agentRegistry.register({
  name: 'doc',
  description: '文件處理 agent — PDF/圖片分類、解析、結構化',
  systemPrompt: '你是穗鈅助手的文件處理模組。',
  allowedSkills: [],  // doc-agent 不直接呼叫 skill，它呼叫 document-parser 和 classifier
  messages: MESSAGES,
});

// ========================================
// Export
// ========================================

module.exports = {
  MESSAGES,
  handleDocument,
};
