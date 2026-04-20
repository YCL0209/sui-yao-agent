/**
 * 穗鈅助手 — MongoDB 索引建立腳本
 *
 * 確保所有 collection 的索引存在。
 * 用法：node scripts/ensure-indexes.js
 * 也可以在 bot-server 啟動時 require 呼叫 ensureAllIndexes()。
 *
 * @version 1.0.0
 */

const mongo = require('../lib/mongodb-tools');
const appConfig = require('../src/config');

/**
 * 安全建立索引：若已存在同 key 但不同名（IndexOptionsConflict, code 85），跳過。
 * 其他錯誤照常拋出。
 */
async function safeCreateIndexes(collection, specs) {
  for (const spec of specs) {
    try {
      await collection.createIndexes([spec]);
    } catch (err) {
      if (err.code === 85 || err.code === 86) {
        // 85 IndexOptionsConflict / 86 IndexKeySpecsConflict
        // 同 key 不同名（通常是 MongoDB 預設名）→ 視為已存在，跳過
        console.log(`  ↪ ${collection.collectionName}.${spec.name}: 已存在（不同名），跳過`);
      } else {
        throw err;
      }
    }
  }
}

/**
 * Upsert admin 用戶（跨平台）
 */
async function ensureAdmin(db, platform, chatId) {
  const chatIdStr = String(chatId);
  await db.collection('users').updateOne(
    { platform, chatId: chatIdStr },
    {
      $setOnInsert: {
        platform,
        chatId: chatIdStr,
        userId: `${platform}:${chatIdStr}`,
        profile: { firstName: 'Admin' },
        role: 'admin',
        status: 'active',
        createdAt: new Date(),
        approvedAt: new Date(),
        approvedBy: 'system',
      }
    },
    { upsert: true }
  );
}

async function ensureAllIndexes() {
  const db = await mongo.getDb();
  console.log('[ensure-indexes] 開始建立索引...');

  // 記憶系統
  await safeCreateIndexes(db.collection('memories'), [
    { key: { userId: 1 }, name: 'idx_userId', unique: true },
  ]);

  await safeCreateIndexes(db.collection('daily_logs'), [
    { key: { userId: 1, date: -1 }, name: 'idx_user_date' },
  ]);

  await safeCreateIndexes(db.collection('archived_daily_logs'), [
    { key: { userId: 1, date: -1 }, name: 'idx_user_date' },
  ]);

  await safeCreateIndexes(db.collection('shared_memory'), [
    { key: { key: 1 }, name: 'idx_key', unique: true },
  ]);

  // 對話歷史（I1：複合 key，支援多平台）
  await safeCreateIndexes(db.collection('conversations'), [
    { key: { platform: 1, chatId: 1 }, name: 'platform_chatId_unique', unique: true },
  ]);

  // 業務資料
  await safeCreateIndexes(db.collection('products'), [
    { key: { productId: 1 }, name: 'idx_productId', unique: true },
    { key: { erpId: 1 }, name: 'idx_erpId' },
    { key: { active: 1 }, name: 'idx_active' },
  ]);

  await safeCreateIndexes(db.collection('parsed_documents'), [
    { key: { 'source.fileHash': 1 }, name: 'idx_fileHash', unique: true },
  ]);

  // 任務與排程
  await safeCreateIndexes(db.collection('reminders'), [
    { key: { status: 1, remindAt: 1 }, name: 'idx_status_remindAt' },
    { key: { userId: 1 }, name: 'idx_userId' },
  ]);

  await safeCreateIndexes(db.collection('scheduled_tasks'), [
    { key: { status: 1 }, name: 'idx_status' },
    { key: { taskId: 1 }, name: 'idx_taskId' },
  ]);

  await safeCreateIndexes(db.collection('task_requests'), [
    { key: { status: 1, createdAt: 1 }, name: 'idx_status_created' },
  ]);

  await safeCreateIndexes(db.collection('task_results'), [
    { key: { createdAt: -1 }, name: 'idx_created_desc' },
  ]);

  // 通知
  await safeCreateIndexes(db.collection('notifications'), [
    { key: { userId: 1, createdAt: -1 }, name: 'idx_user_created' },
  ]);

  await safeCreateIndexes(db.collection('notified_log'), [
    { key: { email: 1, messageId: 1 }, name: 'idx_email_messageId' },
  ]);

  // 子 Agent 系統
  await safeCreateIndexes(db.collection('sub_tasks'), [
    { key: { parentTaskId: 1 }, name: 'idx_parent_task' },
    { key: { assignedAgent: 1, status: 1 }, name: 'idx_agent_status' },
    { key: { createdAt: 1 }, name: 'idx_created' },
    { key: { 'context.userId': 1 }, name: 'idx_user' },
  ]);

  // 可觀測性
  await safeCreateIndexes(db.collection('execution_logs'), [
    { key: { timestamp: -1 }, name: 'idx_timestamp_desc' },
    { key: { userId: 1, timestamp: -1 }, name: 'idx_user_timestamp' },
    { key: { skill: 1, status: 1 }, name: 'idx_skill_status' },
  ]);

  // 用戶（H1 多用戶 + 權限；I1 複合 key 多平台）
  await safeCreateIndexes(db.collection('users'), [
    { key: { platform: 1, chatId: 1 }, name: 'platform_chatId_unique', unique: true },
    { key: { userId: 1 }, name: 'idx_userId', unique: true },
    { key: { status: 1 }, name: 'idx_status' },
    { key: { role: 1 }, name: 'idx_role' },
  ]);

  // 確保 admin 用戶存在（chatId 統一為 String，支援多平台）
  if (appConfig.telegram.adminChatId) {
    await ensureAdmin(db, 'telegram', appConfig.telegram.adminChatId);
    console.log('[ensure-indexes] ✅ Telegram admin 用戶已確認');
  }

  const discordAdmins = appConfig.discord.adminUserIds || [];
  if (discordAdmins.length > 0) {
    for (const id of discordAdmins) {
      await ensureAdmin(db, 'discord', id);
    }
    console.log(`[ensure-indexes] ✅ Discord admin 用戶已確認 (${discordAdmins.length})`);
  }

  // 確保系統排程任務存在（部署時自動建好）
  const systemTasks = [
    {
      taskId: 'reminder',
      type: 'reminder',
      interval: 60000,       // 每分鐘掃到期提醒
    },
    {
      taskId: 'archive-logs',
      type: 'archive-logs',
      interval: 86400000,    // 24 小時歸檔舊日誌
    },
    {
      taskId: 'db-cleanup',
      type: 'db-cleanup',
      interval: 86400000,    // 24 小時清理過期資料
    },
  ];

  for (const t of systemTasks) {
    await db.collection('scheduled_tasks').updateOne(
      { taskId: t.taskId },
      {
        $setOnInsert: {
          taskId: t.taskId,
          type: t.type,
          status: 'active',
          interval: t.interval,
          config: {},
          lastRunAt: new Date(0),
          createdAt: new Date(),
        }
      },
      { upsert: true }
    );
  }
  console.log('[ensure-indexes] ✅ 系統排程任務已確認 (reminder, archive-logs, db-cleanup)');

  console.log('[ensure-indexes] ✅ 所有索引處理完成');
}

// CLI 模式
if (require.main === module) {
  ensureAllIndexes()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[ensure-indexes] ❌ 失敗:', err);
      process.exit(1);
    });
}

module.exports = { ensureAllIndexes };
