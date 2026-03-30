#!/usr/bin/env node
/**
 * 穗鈅助手 — ERP 產品同步腳本
 *
 * 從 ERP 拉取產品列表，同步到 MongoDB products collection。
 * 每筆產品生成 embedding 向量，供 RAG 搜尋用。
 *
 * 用法：
 *   node scripts/sync-products.js            # 增量同步
 *   node scripts/sync-products.js --full     # 全量同步（重新生成所有 embedding）
 *   node scripts/sync-products.js --dry-run  # 只看報告不寫入
 *
 * @version 1.0.0
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const mongo = require('../lib/mongodb-tools');
const { erpFetch } = require('../lib/erp-client');
const llm = require('../src/llm-adapter');
const config = require('../src/config');

// ============================================================
// 同步主邏輯
// ============================================================

async function syncProducts(options = {}) {
  const { full = false, dryRun = false } = options;
  const stats = { added: 0, updated: 0, deactivated: 0, skipped: 0, failed: 0 };

  console.log(`\n🔄 開始${full ? '全量' : '增量'}同步產品${dryRun ? '（試跑模式）' : ''}...\n`);

  // Step 1：從 ERP 拉產品
  const erpResult = await erpFetch('/api/products');
  if (!erpResult.success || !erpResult.data) {
    console.error('❌ 無法取得 ERP 產品列表:', erpResult.message || 'unknown');
    return stats;
  }

  const erpProducts = Array.isArray(erpResult.data) ? erpResult.data : [];
  console.log(`📦 ERP 共 ${erpProducts.length} 筆產品\n`);

  const db = await mongo.getDb();
  const erpIds = new Set();

  // Step 2：逐筆比對
  for (const ep of erpProducts) {
    erpIds.add(ep._id);
    try {
      const existing = await db.collection('products').findOne({ erpId: ep._id });

      if (!existing) {
        // 新產品
        if (!dryRun) {
          let embedding = [];
          try {
            embedding = await llm.getEmbedding(ep.name || '');
          } catch (err) {
            console.warn(`   ⚠️ embedding 失敗: ${ep.name}`, err.message);
          }

          await db.collection('products').insertOne({
            productId: ep.productCode || ep._id,
            name: ep.name || '',
            aliases: [],
            category: ep.category || 'uncategorized',
            unitPrice: ep.price || 0,
            unit: ep.unit || '個',
            spec: ep.spec || '',
            erpId: ep._id,
            supplier: ep.supplier || '',
            active: true,
            embedding,
            embeddingModel: `${config.embedding.provider}/${config.embedding.model}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            syncedFromERP: true,
          });
        }
        console.log(`   ➕ 新增: ${ep.name} (${ep.productCode || ep._id})`);
        stats.added++;

      } else if (full || ep.name !== existing.name || ep.price !== existing.unitPrice) {
        // 有變動或 full 模式
        if (!dryRun) {
          const textForEmbedding = [ep.name, ...(existing.aliases || [])].join(' ');
          let embedding = existing.embedding;
          try {
            embedding = await llm.getEmbedding(textForEmbedding);
          } catch (err) {
            console.warn(`   ⚠️ embedding 更新失敗: ${ep.name}`, err.message);
          }

          await db.collection('products').updateOne(
            { erpId: ep._id },
            {
              $set: {
                name: ep.name || existing.name,
                unitPrice: ep.price ?? existing.unitPrice,
                unit: ep.unit || existing.unit,
                spec: ep.spec || existing.spec,
                category: ep.category || existing.category,
                embedding,
                embeddingModel: `${config.embedding.provider}/${config.embedding.model}`,
                updatedAt: new Date(),
              },
            }
          );
        }
        console.log(`   🔄 更新: ${ep.name}`);
        stats.updated++;

      } else {
        stats.skipped++;
      }
    } catch (err) {
      console.error(`   ❌ 失敗: ${ep.name || ep._id}`, err.message);
      stats.failed++;
    }
  }

  // Step 3：停用 ERP 已刪除的產品
  if (!dryRun && erpIds.size > 0) {
    const result = await db.collection('products').updateMany(
      { syncedFromERP: true, erpId: { $nin: [...erpIds] }, active: true },
      { $set: { active: false, updatedAt: new Date() } }
    );
    stats.deactivated = result.modifiedCount;
  }

  // Step 4：報告
  console.log('\n📊 同步報告：');
  console.log(`   新增: ${stats.added} 筆`);
  console.log(`   更新: ${stats.updated} 筆`);
  console.log(`   停用: ${stats.deactivated} 筆`);
  console.log(`   跳過: ${stats.skipped} 筆（無變動）`);
  console.log(`   失敗: ${stats.failed} 筆`);
  if (dryRun) console.log('\n   ⚠️ 試跑模式，未實際寫入');
  console.log('');

  return stats;
}

// ============================================================
// CLI
// ============================================================

if (require.main === module) {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const dryRun = args.includes('--dry-run');

  syncProducts({ full, dryRun })
    .then(() => {
      console.log('✅ 同步完成');
      process.exit(0);
    })
    .catch(err => {
      console.error('❌ 同步失敗:', err);
      process.exit(1);
    });
}

module.exports = { syncProducts };
