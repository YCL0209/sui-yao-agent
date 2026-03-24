#!/usr/bin/env node
/**
 * scheduler.js — 通用定時引擎
 *
 * 系統 cron 每分鐘觸發，掃描 MongoDB scheduled_tasks，
 * 判斷到期的任務並執行對應 handler。不經過 LLM，零成本。
 *
 * @version 3.0.0
 */

// 確保 HOME 環境變數存在（cron 環境需要）
if (!process.env.HOME) {
  process.env.HOME = '/Users/liaoyacheng';
}

const mongo = require('../lib/mongodb-tools');
const { runNotify } = require('../skills/check-email');

// ========================================
// Handler Registry
// ========================================

const handlers = {
  'email-check': async (config) => {
    const chatId = config.telegramChatId;
    if (!chatId) throw new Error('missing telegramChatId in config');
    return await runNotify(chatId);
  }
};

// ========================================
// Main
// ========================================

async function main() {
  const db = await mongo.getDb();

  try {
    const tasks = await db.collection('scheduled_tasks')
      .find({ status: 'active' }).toArray();

    if (tasks.length === 0) return;

    const now = Date.now();

    for (const task of tasks) {
      const elapsed = now - new Date(task.lastRunAt).getTime();
      if (elapsed < task.interval) continue;

      const handler = handlers[task.type];
      if (!handler) {
        console.error(`[scheduler] unknown type: ${task.type}, skipping`);
        continue;
      }

      const startMs = Date.now();
      let result;
      let status = 'success';
      let summary = '';

      try {
        result = await handler(task.config || {});
        summary = result.notified
          ? `pushed ${result.newCount} new emails`
          : 'no new emails';
      } catch (err) {
        status = 'error';
        summary = err.message;
        result = { ok: false, error: err.message };
      }

      const durationMs = Date.now() - startMs;

      await db.collection('scheduled_tasks').updateOne(
        { taskId: task.taskId },
        { $set: { lastRunAt: new Date(), lastResult: summary } }
      );

      await db.collection('task_results').insertOne({
        requestId: task.taskId,
        scriptId: task.type,
        status,
        summary,
        details: result || {},
        executedAt: new Date(),
        durationMs
      });

      if (status === 'success') {
        console.log(`[scheduler] ${task.taskId}: ${summary}`);
      } else {
        console.error(`[scheduler] ${task.taskId} error: ${summary}`);
      }
    }
  } finally {
    await mongo.close();
  }
}

main().catch(err => {
  console.error(`[scheduler] fatal: ${err.message}`);
  mongo.close().catch(() => {});
  process.exit(1);
});
