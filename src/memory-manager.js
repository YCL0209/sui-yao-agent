/**
 * 穗鈅助手 — 長期記憶管理
 *
 * MongoDB memories collection，每個用戶一份文件，內含記憶陣列。
 * 儲存時自動生成 embedding 向量（供語意搜尋用）。
 *
 * @version 1.0.0
 */

const { v4: uuidv4 } = require('crypto');
const mongo = require('../lib/mongodb-tools');
const llm = require('./llm-adapter');
const config = require('./config');

// ============================================================
// 記憶 CRUD
// ============================================================

/**
 * 儲存一條記憶
 * @param {string} userId
 * @param {string} content - 記憶內容
 * @param {string} [source='對話推斷'] - 來源（對話推斷 / 用戶要求 / pre-flush）
 * @param {Object} [options] - 額外選項 { category, importance }
 */
async function saveMemory(userId, content, source = '對話推斷', options = {}) {
  // 相容舊呼叫方式：saveMemory(userId, content, source, 'fact')
  let category, importance;
  if (typeof options === 'string') {
    category = options;
    importance = undefined;
  } else {
    category = options.category || 'fact';
    importance = options.importance;
  }

  // 預設 importance 依 source 判斷
  if (importance === undefined) {
    if (source === '用戶要求') importance = 0.8;
    else if (source === 'LLM 回覆') importance = 0.6;
    else if (source === 'pre-flush') importance = 0.5;
    else importance = 0.5;
  }
  const db = await mongo.getDb();

  // 去重：檢查是否已有相同或高度相似的記憶
  const doc = await db.collection('memories').findOne({ userId });
  if (doc && doc.memories && doc.memories.length > 0) {
    // 1. 完全相同文字 → 跳過
    const exactMatch = doc.memories.find(m => m.content.trim() === content.trim());
    if (exactMatch) {
      console.log('[memory-manager] 跳過重複記憶（完全相同）:', content.substring(0, 40));
      return exactMatch.id;
    }

    // 2. 語意相似度 > 0.9 → 跳過
    let newEmbedding;
    try {
      newEmbedding = await llm.getEmbedding(content);
    } catch (_) {
      newEmbedding = null;
    }

    if (newEmbedding) {
      const { cosineSimilarity } = require('./memory-search');
      for (const m of doc.memories) {
        if (m.embedding && m.embedding.length > 0) {
          const sim = cosineSimilarity(newEmbedding, m.embedding);
          if (sim > 0.9) {
            console.log(`[memory-manager] 跳過重複記憶（相似度 ${sim.toFixed(3)}）:`, content.substring(0, 40));
            return m.id;
          }
        }
      }

      // embedding 已生成，直接用
      var embedding = newEmbedding;
    }
  }

  // 生成 embedding（如果上面沒有生成過）
  if (typeof embedding === 'undefined') {
    embedding = [];
    try {
      embedding = await llm.getEmbedding(content);
    } catch (err) {
      console.warn('[memory-manager] embedding 生成失敗，存入空向量:', err.message);
    }
  }

  const memoryDoc = {
    id: generateId(),
    content,
    category,
    createdAt: new Date(),
    source,
    embedding,
    importance,
    accessCount: 0,
    lastAccessedAt: null,
    embeddingModel: `${config.embedding.provider}/${config.embedding.model}`,
  };

  await db.collection('memories').updateOne(
    { userId },
    {
      $push: { memories: memoryDoc },
      $setOnInsert: { userId },
    },
    { upsert: true }
  );

  // 檢查是否超過上限，超過則淘汰最舊的
  await enforceLimit(userId);

  return memoryDoc.id;
}

/**
 * 取得用戶的所有記憶
 */
async function getMemories(userId) {
  const db = await mongo.getDb();
  const doc = await db.collection('memories').findOne({ userId });
  return doc?.memories || [];
}

/**
 * 刪除一條記憶
 */
async function deleteMemory(userId, memoryId) {
  const db = await mongo.getDb();
  await db.collection('memories').updateOne(
    { userId },
    { $pull: { memories: { id: memoryId } } }
  );
}

/**
 * 更新一條記憶的內容（重新生成 embedding）
 */
async function updateMemory(userId, memoryId, newContent) {
  const db = await mongo.getDb();

  let embedding = [];
  try {
    embedding = await llm.getEmbedding(newContent);
  } catch (err) {
    console.warn('[memory-manager] embedding 更新失敗:', err.message);
  }

  await db.collection('memories').updateOne(
    { userId, 'memories.id': memoryId },
    {
      $set: {
        'memories.$.content': newContent,
        'memories.$.embedding': embedding,
        'memories.$.updatedAt': new Date(),
      },
    }
  );
}

// ============================================================
// 記憶上限管理
// ============================================================

async function enforceLimit(userId) {
  const db = await mongo.getDb();
  const doc = await db.collection('memories').findOne({ userId });
  if (!doc || !doc.memories) return;

  const maxCount = config.memory.maxCount;
  if (doc.memories.length <= maxCount) return;

  // 綜合分數淘汰：importance 0.4 + recency 0.3 + access 0.3
  const scored = doc.memories.map(m => {
    const importance = m.importance || 0.5;
    const daysSince = (Date.now() - new Date(m.createdAt).getTime()) / 86400000;
    const recency = Math.exp(-daysSince / 90); // 90 天半衰期
    const access = Math.min((m.accessCount || 0) / 10, 1);

    const score = importance * 0.4 + recency * 0.3 + access * 0.3;
    return { memory: m, score };
  });

  // 分數高的留，分數低的砍
  scored.sort((a, b) => b.score - a.score);
  const kept = scored.slice(0, maxCount).map(s => s.memory);
  const dropped = scored.slice(maxCount);

  await db.collection('memories').updateOne(
    { userId },
    { $set: { memories: kept } }
  );

  // log 被淘汰的記憶（方便確認沒砍錯）
  const droppedCount = dropped.length;
  const droppedSamples = dropped.slice(0, 3).map(d =>
    `${d.memory.content.substring(0, 30)}... (score: ${d.score.toFixed(3)})`
  ).join(', ');
  console.log(`[memory-manager] ${userId}: 淘汰 ${droppedCount} 條低分記憶 [${droppedSamples}]`);
}

// ============================================================
// 連線管理（方便測試）
// ============================================================

async function connect() {
  await mongo.getDb();
}

async function close() {
  await mongo.close();
}

// ============================================================
// 工具
// ============================================================

function generateId() {
  // 簡單的 unique id
  return 'mem_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

// ============================================================
// Export
// ============================================================

module.exports = {
  saveMemory,
  getMemories,
  deleteMemory,
  updateMemory,
  connect,
  close,
};
