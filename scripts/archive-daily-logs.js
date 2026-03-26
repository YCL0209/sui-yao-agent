#!/usr/bin/env node
/**
 * archive-daily-logs.js — 清理過期的 daily_logs
 *
 * 將超過 30 天的日誌搬到 archived_daily_logs collection。
 * 支援 --dry-run 參數（只顯示，不執行）。
 *
 * @version 1.0.0
 */

if (!process.env.HOME) {
  process.env.HOME = '/Users/liaoyacheng';
}

const mongo = require('../lib/mongodb-tools');
const config = require('../src/config');

const DRY_RUN = process.argv.includes('--dry-run');
const RETENTION_DAYS = config.memory?.dailyLogRetentionDays || 30;

async function main() {
  const db = await mongo.getDb();

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
  const cutoffStr = cutoffDate.toISOString().split('T')[0];

  const oldLogs = await db.collection('daily_logs')
    .find({ date: { $lt: cutoffStr } })
    .toArray();

  console.log(`找到 ${oldLogs.length} 筆超過 ${RETENTION_DAYS} 天的日誌（cutoff: ${cutoffStr}）`);

  if (oldLogs.length === 0) {
    console.log('沒有需要歸檔的日誌');
    return;
  }

  if (DRY_RUN) {
    console.log('[dry-run] 以下日誌會被歸檔：');
    for (const log of oldLogs) {
      console.log(`  - ${log.userId} / ${log.date} (${log.entries?.length || 0} 筆)`)
    }
    console.log('[dry-run] 不會實際執行');
    return;
  }

  // 搬到 archived_daily_logs
  if (oldLogs.length > 0) {
    await db.collection('archived_daily_logs').insertMany(oldLogs);
    const ids = oldLogs.map(l => l._id);
    const result = await db.collection('daily_logs').deleteMany({ _id: { $in: ids } });
    console.log(`✅ 已歸檔 ${result.deletedCount} 筆日誌到 archived_daily_logs`);
  }
}

main()
  .catch(err => {
    console.error('[archive] fatal:', err.message);
    process.exit(1);
  })
  .finally(() => mongo.close());
