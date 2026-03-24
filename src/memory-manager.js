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
 * @param {string} [category='fact'] - 分類（contact / preference / fact / workflow）
 */
async function saveMemory(userId, content, source = '對話推斷', category = 'fact') {
  const db = await mongo.getDb();

  // 生成 embedding
  let embedding = [];
  try {
    embedding = await llm.getEmbedding(content);
  } catch (err) {
    console.warn('[memory-manager] embedding 生成失敗，存入空向量:', err.message);
  }

  const memoryDoc = {
    id: generateId(),
    content,
    category,
    createdAt: new Date(),
    source,
    embedding,
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

  // 按建立時間排序，保留最新的 maxCount 條
  const sorted = doc.memories
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const kept = sorted.slice(0, maxCount);

  await db.collection('memories').updateOne(
    { userId },
    { $set: { memories: kept } }
  );

  console.log(`[memory-manager] ${userId}: 淘汰 ${doc.memories.length - maxCount} 條舊記憶`);
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
