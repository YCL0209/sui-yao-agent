/**
 * 穗鈅助手 — Phase I1 一次性遷移
 *
 * conversations + users：
 *   1. 缺 platform 欄位 → 補 'telegram'
 *   2. chatId Number → String
 *   3. drop idx_chatId（單欄唯一），create platform_chatId_unique（複合唯一）
 *
 * 冪等：可重複執行不會壞。
 *
 * 用法：node scripts/migrate-add-platform.js
 *
 * @version 1.0.0
 */

const mongo = require('../lib/mongodb-tools');

async function migrate() {
  const db = await mongo.getDb();

  for (const colName of ['conversations', 'users']) {
    const col = db.collection(colName);

    console.log(`\n[${colName}] 開始遷移...`);

    // 1. 補 platform 欄位
    const r1 = await col.updateMany(
      { platform: { $exists: false } },
      { $set: { platform: 'telegram' } }
    );
    console.log(`  ↪ platform 補欄: ${r1.modifiedCount} docs`);

    // 2. chatId Number → String
    const cur = col.find({ chatId: { $type: 'number' } });
    let n = 0;
    for await (const doc of cur) {
      await col.updateOne(
        { _id: doc._id },
        { $set: { chatId: String(doc.chatId) } }
      );
      n++;
    }
    console.log(`  ↪ chatId Number→String: ${n} docs`);

    // 3. 重建 index
    const indexes = await col.indexes();
    for (const idx of indexes) {
      if (idx.name === 'idx_chatId' || idx.name === 'chatId_1') {
        try {
          await col.dropIndex(idx.name);
          console.log(`  ↪ dropped index: ${idx.name}`);
        } catch (err) {
          console.log(`  ↪ drop ${idx.name} 失敗（可能不存在）: ${err.message}`);
        }
      }
    }

    try {
      await col.createIndex(
        { platform: 1, chatId: 1 },
        { unique: true, name: 'platform_chatId_unique' }
      );
      console.log(`  ↪ created index: platform_chatId_unique`);
    } catch (err) {
      if (err.code === 85 || err.code === 86) {
        console.log(`  ↪ platform_chatId_unique 已存在，跳過`);
      } else {
        throw err;
      }
    }
  }

  console.log('\n✅ 遷移完成');
  await mongo.close();
}

migrate().catch(err => {
  console.error('❌ 遷移失敗:', err);
  process.exit(1);
});
