/**
 * 穗鈅助手 — 產品 RAG 搜尋引擎
 *
 * 三層匹配：品號精確 → 品名/別名包含 → 語意向量搜尋
 * 支援自動學習別名，提高未來匹配率。
 *
 * @version 1.0.0
 */

const mongo = require('../lib/mongodb-tools');
const llm = require('./llm-adapter');
const config = require('./config');
const { cosineSimilarity } = require('./memory-search');

// ============================================================
// Embedding 快取（共用 memory-search 的邏輯）
// ============================================================

const embeddingCache = new Map();
const CACHE_MAX_SIZE = 200;

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
// 三層搜尋
// ============================================================

/**
 * 搜尋產品（三層匹配）
 *
 * @param {string} query - 用戶輸入的品名/品號
 * @returns {Array<{ match: string, product: Object, score: number }>}
 */
async function searchProduct(query) {
  const db = await mongo.getDb();
  const trimmed = query.trim();

  // 第一層：品號精確匹配
  const byCode = await db.collection('products').findOne({
    active: true,
    productId: { $regex: `^${escapeRegex(trimmed)}$`, $options: 'i' },
  });
  if (byCode) {
    return [{ match: 'exact_code', product: stripEmbedding(byCode), score: 1.0 }];
  }

  // 第二層：品名/別名包含匹配
  const pattern = escapeRegex(trimmed);
  const byName = await db.collection('products').find({
    active: true,
    $or: [
      { name: { $regex: pattern, $options: 'i' } },
      { aliases: { $regex: pattern, $options: 'i' } },
    ],
  }).limit(5).toArray();

  if (byName.length > 0) {
    return byName.map(p => ({ match: 'exact_name', product: stripEmbedding(p), score: 0.95 }));
  }

  // 第三層：語意搜尋
  let queryEmbedding;
  try {
    queryEmbedding = await getEmbeddingCached(trimmed);
  } catch (err) {
    console.warn('[product-search] embedding 失敗:', err.message);
    return [];
  }

  const allProducts = await db.collection('products')
    .find({ active: true, embedding: { $exists: true, $ne: [] } })
    .toArray();

  const topK = config.product.searchTopK;
  const scored = allProducts
    .map(p => ({
      match: 'semantic',
      product: stripEmbedding(p),
      score: cosineSimilarity(queryEmbedding, p.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored;
}

/**
 * 根據門檻分類搜尋結果
 *
 * @param {Array} results - searchProduct 的回傳
 * @returns {{ autoMatch: Array, candidates: Array, noMatch: boolean }}
 */
function classifyResults(results) {
  const { autoMatchThreshold, candidateThreshold, minThreshold } = config.product;

  const autoMatch = results.filter(r => r.score >= autoMatchThreshold);
  const candidates = results.filter(r => r.score >= candidateThreshold && r.score < autoMatchThreshold);
  const below = results.every(r => r.score < minThreshold);

  return { autoMatch, candidates, noMatch: below || results.length === 0 };
}

// ============================================================
// 自動學習別名
// ============================================================

/**
 * 學習新別名（用戶輸入跟匹配產品名不同時）
 *
 * @param {string} productId - 產品品號
 * @param {string} alias - 新的別名
 */
async function learnAlias(productId, alias) {
  const db = await mongo.getDb();
  const product = await db.collection('products').findOne({ productId });
  if (!product) return;

  // 已存在則跳過
  if (product.name === alias) return;
  if (product.aliases && product.aliases.includes(alias)) return;

  // 加入別名 + 重新生成 embedding
  const newAliases = [...(product.aliases || []), alias];
  const textForEmbedding = [product.name, ...newAliases].join(' ');

  let embedding = product.embedding;
  try {
    embedding = await getEmbeddingCached(textForEmbedding);
  } catch (err) {
    console.warn('[product-search] 別名 embedding 更新失敗:', err.message);
  }

  await db.collection('products').updateOne(
    { productId },
    {
      $push: { aliases: alias },
      $set: { embedding, updatedAt: new Date() },
    }
  );

  console.log(`[product-search] 學習別名: ${productId} += "${alias}"`);
}

// ============================================================
// 工具
// ============================================================

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripEmbedding(product) {
  const { embedding, ...rest } = product;
  return rest;
}

// ============================================================
// Export
// ============================================================

module.exports = {
  searchProduct,
  classifyResults,
  learnAlias,
  getEmbeddingCached,
};
