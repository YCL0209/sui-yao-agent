/**
 * 穗鈅助手 — 文件分類器
 *
 * 接收 normalizedInput，用 Vision API 或一般 LLM 判斷文件類別與類型。
 * 分類定義來自 doc-classification.js。
 * 分類結果存入 MongoDB parsed_documents，並支援 fileHash 快取。
 *
 * @version 1.1.0
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const config = require('./config');
const mongo = require('../lib/mongodb-tools');
const { getClassificationPrompt, createClassificationResult } = require('./doc-classification');

const TMP_DIR = '/tmp/sui-yao-classify';

// ============================================================
// 主函式
// ============================================================

/**
 * 分類文件。
 * @param {import('./input-normalizer').NormalizedInput} input
 * @returns {Promise<import('./doc-classification').ClassificationResult>}
 */
async function classifyDocument(input) {
  const attachment = input.attachments && input.attachments[0];
  const textContent = input.textContent || null;
  const metadata = input.metadata || {};

  // 無附件也無文字 → 直接 unknown
  if (!attachment && !textContent) {
    return createClassificationResult({ category: 'unknown', confidence: 0 });
  }

  // 有附件 → 計算 fileHash，查快取
  let fileHash = null;
  if (attachment) {
    fileHash = computeFileHash(attachment.filePath);

    const cached = await findByHash(fileHash);
    if (cached) {
      console.log(`[分類快取命中] fileHash=${fileHash}`);
      return createClassificationResult(cached.classification);
    }
  }

  // 呼叫 LLM 分類
  let classification;
  try {
    if (attachment) {
      classification = await classifyWithVision(attachment, textContent);
    } else {
      classification = await classifyWithText(textContent);
    }
  } catch (err) {
    console.error('[document-classifier] 分類失敗:', err.message);
    classification = createClassificationResult({ category: 'unknown', confidence: 0 });
  }

  // 有附件時存入 MongoDB（等待完成，確保後續 update 能找到紀錄）
  if (attachment && fileHash) {
    try {
      await saveClassification(fileHash, attachment, metadata, classification);
    } catch (err) {
      console.error('[document-classifier] MongoDB 存入失敗:', err.message);
    }
  }

  return classification;
}

// ============================================================
// fileHash 計算
// ============================================================

function computeFileHash(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ============================================================
// MongoDB 快取查詢
// ============================================================

async function findByHash(fileHash) {
  try {
    const db = await mongo.getDb();
    return await db.collection('parsed_documents').findOne({ 'source.fileHash': fileHash });
  } catch (err) {
    console.error('[document-classifier] 快取查詢失敗:', err.message);
    return null;
  }
}

// ============================================================
// MongoDB 存入
// ============================================================

async function saveClassification(fileHash, attachment, metadata, classification) {
  const db = await mongo.getDb();
  const col = db.collection('parsed_documents');

  const doc = {
    source: {
      channel: 'telegram',
      fileHash,
      fileName: attachment.originalName,
      senderId: metadata.senderId || null,
      senderName: metadata.senderName || null,
      messageId: metadata.messageId || null,
      receivedAt: metadata.timestamp || new Date(),
    },
    classification: {
      category: classification.category,
      docType: classification.docType,
      confidence: classification.confidence,
      language: classification.language,
      reasoning: classification.reasoning,
      hasBusinessContent: classification.hasBusinessContent,
      classifiedAt: new Date(),
      model: config.llm.strongModel || 'gpt-4o',
    },
    parsed: null,
    status: 'classified',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    await col.insertOne(doc);
  } catch (err) {
    if (err.code === 11000) {
      // fileHash 重複 → 更新現有紀錄
      await col.updateOne(
        { 'source.fileHash': fileHash },
        { $set: { classification: doc.classification, updatedAt: new Date() } },
      );
    } else {
      throw err;
    }
  }
}

// ============================================================
// 索引初始化
// ============================================================

let indexesEnsured = false;

async function ensureIndexes() {
  if (indexesEnsured) return;
  try {
    const db = await mongo.getDb();
    const col = db.collection('parsed_documents');
    await Promise.all([
      col.createIndex({ 'source.fileHash': 1 }, { unique: true }),
      col.createIndex({ 'classification.docType': 1, createdAt: 1 }),
      col.createIndex({ status: 1 }),
      col.createIndex({ 'source.senderId': 1, createdAt: 1 }),
    ]);
    indexesEnsured = true;
  } catch (err) {
    console.error('[document-classifier] 索引建立失敗:', err.message);
  }
}

// 模組載入時非同步建索引
ensureIndexes();

// ============================================================
// Vision 分類（有附件）
// ============================================================

async function classifyWithVision(attachment, textContent) {
  let imagePath = null;
  let needsCleanup = false;

  try {
    if (attachment.type === 'pdf') {
      imagePath = pdfToFirstPageImage(attachment.filePath);
      needsCleanup = true;
    } else if (attachment.type === 'image') {
      imagePath = attachment.filePath;
    } else {
      // 非 PDF 非圖片的附件，無法 vision
      return createClassificationResult({
        category: 'attachment',
        confidence: 0.5,
        reasoning: '非圖片/PDF 附件，無法進行視覺分類',
      });
    }

    const imageBuffer = fs.readFileSync(imagePath);
    const base64 = imageBuffer.toString('base64');
    const ext = path.extname(imagePath).toLowerCase().replace('.', '');
    const mimeType = ext === 'png' ? 'image/png'
      : ext === 'webp' ? 'image/webp'
      : 'image/jpeg';

    // 組裝 user content
    const userContent = [];
    if (textContent) {
      userContent.push({ type: 'text', text: `附帶文字：${textContent}` });
    } else {
      userContent.push({ type: 'text', text: '請根據圖片內容分類' });
    }
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${base64}` },
    });

    return await callLLM([
      { role: 'system', content: getClassificationPrompt() },
      { role: 'user', content: userContent },
    ]);
  } finally {
    if (needsCleanup && imagePath) {
      try { fs.unlinkSync(imagePath); } catch (_) {}
    }
  }
}

// ============================================================
// 文字分類（無附件）
// ============================================================

async function classifyWithText(textContent) {
  return await callLLM([
    { role: 'system', content: getClassificationPrompt() },
    { role: 'user', content: textContent },
  ]);
}

// ============================================================
// LLM 呼叫
// ============================================================

async function callLLM(messages) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.llm.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: config.llm.strongModel || 'gpt-4o',
      messages,
      temperature: 0,
      max_tokens: 500,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Vision API ${res.status}: ${err}`);
  }

  const data = await res.json();
  const content = (data.choices[0]?.message?.content || '').trim();

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('[document-classifier] LLM 回傳非 JSON:', content);
    return createClassificationResult({ category: 'unknown', confidence: 0 });
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return createClassificationResult(parsed);
  } catch (e) {
    console.error('[document-classifier] JSON 解析失敗:', e.message, content);
    return createClassificationResult({ category: 'unknown', confidence: 0 });
  }
}

// ============================================================
// PDF → 第一頁圖片
// ============================================================

function pdfToFirstPageImage(pdfPath) {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

  const prefix = path.join(TMP_DIR, `classify-${Date.now()}`);
  execSync(`pdftoppm -jpeg -r 250 -l 1 "${pdfPath}" "${prefix}"`);

  const files = fs.readdirSync(TMP_DIR)
    .filter(f => f.startsWith(path.basename(prefix)) && (f.endsWith('.jpg') || f.endsWith('.png')))
    .sort();

  if (files.length === 0) {
    throw new Error('pdftoppm 未產生圖片');
  }

  // 只用第一頁，清理其餘
  const firstPage = path.join(TMP_DIR, files[0]);
  for (let i = 1; i < files.length; i++) {
    try { fs.unlinkSync(path.join(TMP_DIR, files[i])); } catch (_) {}
  }

  return firstPage;
}

// ============================================================
// Export
// ============================================================

/**
 * 更新 parsed_documents 的解析狀態。
 * @param {string} fileHash
 * @param {'parsed'|'parse_failed'} status
 * @param {Object|string} parsedData - 解析結果或失敗原因
 */
async function updateDocumentStatus(fileHash, status, parsedData) {
  try {
    const db = await mongo.getDb();
    const result = await db.collection('parsed_documents').findOneAndUpdate(
      { 'source.fileHash': fileHash },
      { $set: { status, parsed: parsedData, updatedAt: new Date() } },
    );
    console.log(`[parsed_documents] 更新 fileHash=${fileHash.substring(0, 12)}..., result=${result ? 'matched' : 'not_found'}`);
  } catch (err) {
    console.error('[document-classifier] 狀態更新失敗:', err.message);
  }
}

module.exports = { classifyDocument, computeFileHash, updateDocumentStatus };
