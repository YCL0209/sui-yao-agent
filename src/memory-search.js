/**
 * 穗鈅助手 — 語意搜尋引擎
 *
 * 根據當前對話搜尋相關記憶，使用向量 embedding + 餘弦相似度。
 * 綜合評分：語意相關度 + 重要性 + 新鮮度 + 使用頻率。
 *
 * @version 2.0.0
 */

const mongo = require('../lib/mongodb-tools');
const llm = require('./llm-adapter');
const config = require('./config');

// ============================================================
// Embedding 快取
// ============================================================

const embeddingCache = new Map();
const CACHE_MAX_SIZE = 100;

async function getEmbeddingCached(text) {
  if (embeddingCache.has(text)) return embeddingCache.get(text);
  const embedding = await llm.getEmbedding(text);
  embeddingCache.set(text, embedding);
  if (embeddingCache.size > CACHE_MAX_SIZE) {
    const firstKey = embeddingCache.keys().next().value;
    embeddingCache.delete(firstKey);
  }
  return embedding;
}

// ============================================================
// 餘弦相似度
// ============================================================

function cosineSimilarity(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  if (a.length !== b.length) return 0;

  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ============================================================
// 綜合評分
// ============================================================

function calculateScore(memory, cosineSim) {
  const semanticScore = cosineSim;
  const importanceScore = memory.importance || 0.5;

  // 新鮮度衰減（90 天半衰期）
  const daysSinceCreated = (Date.now() - new Date(memory.createdAt).getTime()) / 86400000;
  const recencyScore = Math.exp(-daysSinceCreated / 90);

  // 使用頻率（上限 1）
  const accessScore = Math.min((memory.accessCount || 0) / 10, 1);

  return (
    semanticScore * 0.6 +
    importanceScore * 0.2 +
    recencyScore * 0.1 +
    accessScore * 0.1
  );
}

// ============================================================
// 搜尋
// ============================================================

/**
 * 語意搜尋用戶的長期記憶
 *
 * @param {string} userId
 * @param {string} query - 搜尋查詢文字
 * @param {number} [topK] - 最多回傳幾筆
 * @param {Object} [options] - { category: string } 可選預過濾
 * @returns {Array<{ id, content, category, score, createdAt }>}
 */
async function searchMemories(userId, query, topK, options = {}) {
  const k = topK || config.memory.searchTopK;
  const minSimilarity = config.memory.minSimilarity;

  // 1. 把 query 轉成向量（走快取）
  let queryEmbedding;
  try {
    queryEmbedding = await getEmbeddingCached(query);
  } catch (err) {
    console.warn('[memory-search] embedding 失敗，改用關鍵字搜尋:', err.message);
    return keywordSearch(userId, query, k);
  }

  // 2. 從 memories collection 取出用戶記憶
  const db = await mongo.getDb();
  const doc = await db.collection('memories').findOne({ userId });
  if (!doc || !doc.memories || doc.memories.length === 0) return [];

  // 3. 預過濾（可選 category）
  let candidates = doc.memories.filter(m => m.embedding && m.embedding.length > 0);
  if (options.category) {
    candidates = candidates.filter(m => m.category === options.category);
  }

  // 4. 計算綜合分數，取 top K
  const scored = candidates.map(m => ({
    id: m.id,
    content: m.content,
    category: m.category,
    createdAt: m.createdAt,
    score: calculateScore(m, cosineSimilarity(queryEmbedding, m.embedding)),
  }));

  const results = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .filter(m => m.score > minSimilarity);

  // 5. Fire-and-forget 更新命中記憶的 accessCount + lastAccessedAt
  if (results.length > 0) {
    updateAccessStats(userId, results.map(r => r.id)).catch(err =>
      console.warn('[memory-search] accessCount 更新失敗:', err.message)
    );
  }

  return results;
}

// ============================================================
// 命中統計更新
// ============================================================

async function updateAccessStats(userId, memoryIds) {
  const db = await mongo.getDb();
  const now = new Date();
  for (const memId of memoryIds) {
    await db.collection('memories').updateOne(
      { userId, 'memories.id': memId },
      {
        $inc: { 'memories.$.accessCount': 1 },
        $set: { 'memories.$.lastAccessedAt': now },
      }
    );
  }
}

// ============================================================
// 關鍵字搜尋（embedding 失敗時的 fallback）
// ============================================================

async function keywordSearch(userId, query, topK) {
  const db = await mongo.getDb();
  const doc = await db.collection('memories').findOne({ userId });
  if (!doc || !doc.memories) return [];

  const keywords = query.toLowerCase().split(/\s+/);

  return doc.memories
    .map(m => {
      const text = m.content.toLowerCase();
      const matchCount = keywords.filter(k => text.includes(k)).length;
      return {
        id: m.id,
        content: m.content,
        category: m.category,
        createdAt: m.createdAt,
        score: matchCount / keywords.length,
      };
    })
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ============================================================
// Export
// ============================================================

module.exports = {
  searchMemories,
  cosineSimilarity,
  calculateScore,
};
