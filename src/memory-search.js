/**
 * 穗鈅助手 — 語意搜尋引擎
 *
 * 根據當前對話搜尋相關記憶，使用向量 embedding + 餘弦相似度。
 * 跨層搜尋：長期記憶 + 每日日誌都能搜到。
 *
 * @version 1.0.0
 */

const mongo = require('../lib/mongodb-tools');
const llm = require('./llm-adapter');
const config = require('./config');

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
// 搜尋
// ============================================================

/**
 * 語意搜尋用戶的長期記憶
 *
 * @param {string} userId
 * @param {string} query - 搜尋查詢文字
 * @param {number} [topK] - 最多回傳幾筆
 * @returns {Array<{ id, content, category, score, createdAt }>}
 */
async function searchMemories(userId, query, topK) {
  const k = topK || config.memory.searchTopK;
  const minSimilarity = config.memory.minSimilarity;

  // 1. 把 query 轉成向量
  let queryEmbedding;
  try {
    queryEmbedding = await llm.getEmbedding(query);
  } catch (err) {
    console.warn('[memory-search] embedding 失敗，改用關鍵字搜尋:', err.message);
    return keywordSearch(userId, query, k);
  }

  // 2. 從 memories collection 取出用戶記憶
  const db = await mongo.getDb();
  const doc = await db.collection('memories').findOne({ userId });
  if (!doc || !doc.memories || doc.memories.length === 0) return [];

  // 3. 計算相似度，取 top K
  const scored = doc.memories
    .filter(m => m.embedding && m.embedding.length > 0)
    .map(m => ({
      id: m.id,
      content: m.content,
      category: m.category,
      createdAt: m.createdAt,
      score: cosineSimilarity(queryEmbedding, m.embedding),
    }));

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .filter(m => m.score > minSimilarity);
}

// ============================================================
// 關鍵字搜尋（embedding 失敗時的 fallback）
// ============================================================

function keywordSearch(userId, query, topK) {
  // 同步 fallback：簡單的文字包含匹配
  return (async () => {
    const db = await mongo.getDb();
    const doc = await db.collection('memories').findOne({ userId });
    if (!doc || !doc.memories) return [];

    const keywords = query.toLowerCase().split(/\s+/);

    return doc.memories
      .map(m => {
        const text = m.content.toLowerCase();
        const matchCount = keywords.filter(k => text.includes(k)).length;
        return { ...m, score: matchCount / keywords.length };
      })
      .filter(m => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ embedding, ...rest }) => rest); // 不返回 embedding
  })();
}

// ============================================================
// Export
// ============================================================

module.exports = {
  searchMemories,
  cosineSimilarity,
};
