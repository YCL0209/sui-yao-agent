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

const https = require('https');
const mongo = require('../lib/mongodb-tools');
const { runNotify } = require('../skills/check-email');
const appConfig = require('../src/config');
const RETENTION_DAYS = appConfig.memory?.dailyLogRetentionDays || 30;

// ========================================
// Telegram 推播（輕量版，不依賴 node-telegram-bot-api）
// ========================================

function sendTelegram(chatId, text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ chat_id: chatId, text });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${appConfig.telegram.botToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ========================================
// Reminder: 計算下次觸發時間
// ========================================

function calcNextRemindAt(reminder) {
  const now = new Date();
  const repeat = reminder.repeat;
  if (!repeat) return null;

  switch (repeat.type) {
    case 'daily': {
      const next = new Date(reminder.remindAt);
      while (next <= now) next.setDate(next.getDate() + 1);
      return next;
    }
    case 'weekly': {
      const next = new Date(reminder.remindAt);
      while (next <= now) next.setDate(next.getDate() + 7);
      return next;
    }
    case 'monthly': {
      const next = new Date(reminder.remindAt);
      while (next <= now) next.setMonth(next.getMonth() + 1);
      return next;
    }
    case 'interval': {
      const ms = repeat.intervalMs || 3600000;
      return new Date(now.getTime() + ms);
    }
    default:
      return null;
  }
}

// ========================================
// Handler Registry
// ========================================

const handlers = {
  'email-check': async (config) => {
    const chatId = config.telegramChatId;
    if (!chatId) throw new Error('missing telegramChatId in config');
    return await runNotify(chatId);
  },

  'reminder': async (taskConfig, task) => {
    const db = await mongo.getDb();

    // 查詢到期且 pending 的 reminders
    const now = new Date();
    const query = {
      status: 'pending',
      remindAt: { $lte: now }
    };
    if (taskConfig.userId) {
      query.userId = taskConfig.userId;
    }

    const reminders = await db.collection('reminders')
      .find(query).toArray();

    if (reminders.length === 0) {
      return { ok: true, count: 0, notified: false };
    }

    let delivered = 0;
    for (const rem of reminders) {
      // 發送 Telegram 提醒
      const chatId = taskConfig.telegramChatId;
      if (chatId) {
        await sendTelegram(chatId, `⏰ 提醒：${rem.content}`);
      }

      if (rem.repeat) {
        // 重複提醒：更新 remindAt 到下次觸發
        const nextAt = calcNextRemindAt(rem);
        if (nextAt) {
          await db.collection('reminders').updateOne(
            { _id: rem._id },
            { $set: { remindAt: nextAt, deliveredAt: now } }
          );
        } else {
          await db.collection('reminders').updateOne(
            { _id: rem._id },
            { $set: { status: 'done', deliveredAt: now } }
          );
        }
      } else {
        // 單次提醒：標記完成
        await db.collection('reminders').updateOne(
          { _id: rem._id },
          { $set: { status: 'done', deliveredAt: now } }
        );
      }
      delivered++;
    }

    return { ok: true, count: delivered, notified: delivered > 0 };
  },

  'archive-logs': async () => {
    const db = await mongo.getDb();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];

    const oldLogs = await db.collection('daily_logs')
      .find({ date: { $lt: cutoffStr } }).toArray();

    if (oldLogs.length === 0) {
      return { ok: true, archived: 0, notified: false };
    }

    await db.collection('archived_daily_logs').insertMany(oldLogs);
    const ids = oldLogs.map(l => l._id);
    const result = await db.collection('daily_logs').deleteMany({ _id: { $in: ids } });

    return { ok: true, archived: result.deletedCount, notified: false };
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
        result = await handler(task.config || {}, task);
        if (task.type === 'reminder') {
          summary = result.count > 0
            ? `delivered ${result.count} reminders`
            : 'no pending reminders';
        } else if (task.type === 'archive-logs') {
          summary = result.archived > 0
            ? `archived ${result.archived} old logs`
            : 'no logs to archive';
        } else {
          summary = result.notified
            ? `pushed ${result.newCount} new emails`
            : 'no new emails';
        }
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
