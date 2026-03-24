/**
 * MongoDB Tools - Agent Hub CLI
 *
 * 提供所有模組存取資料庫的工具。
 * 用法（CLI）：node index.js <command> [--option value ...]
 * 用法（require）：const { getDb, close } = require('./lib/mongodb-tools');
 * 輸出：JSON
 *
 * @version 3.0.0 — 改用 config.mongo 取得連線設定
 */

const { MongoClient, ObjectId } = require('mongodb');
const config = require('../../src/config');

const MONGO_URI = config.mongo.uri;
const DB_NAME = config.mongo.dbName;

// ========================================
// MongoDB Connection
// ========================================

let client = null;

async function getDb() {
  if (!client) {
    client = new MongoClient(MONGO_URI);
    await client.connect();
  }
  return client.db(DB_NAME);
}

async function close() {
  if (client) {
    await client.close();
    client = null;
  }
}

// ========================================
// Parse CLI Arguments
// ========================================

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
      args[key] = val;
      if (val !== true) i++;
    }
  }
  return args;
}

function jsonParse(str) {
  try { return JSON.parse(str); } catch { return str; }
}

function output(data) {
  console.log(JSON.stringify(data, null, 2));
}

// ========================================
// Commands
// ========================================

async function writeTask(args) {
  const db = await getDb();
  const doc = {
    type: args.type,
    status: 'pending',
    userId: args.userId || null,
    params: jsonParse(args.params || '{}'),
    context: jsonParse(args.context || '{}'),
    createdAt: new Date(),
    claimedBy: null,
    claimedAt: null
  };
  const result = await db.collection('task_requests').insertOne(doc);
  output({ ok: true, taskId: result.insertedId.toString() });
}

async function claimTask(args) {
  const db = await getDb();
  const result = await db.collection('task_requests').findOneAndUpdate(
    { type: args.type, status: 'pending' },
    { $set: { status: 'claimed', claimedBy: args.agentId, claimedAt: new Date() } },
    { sort: { createdAt: 1 }, returnDocument: 'after' }
  );
  if (result) {
    result._id = result._id.toString();
    output({ ok: true, task: result });
  } else {
    output({ ok: true, task: null });
  }
}

async function writeResult(args) {
  const db = await getDb();
  const doc = {
    requestId: args.requestId,
    agentId: args.agentId,
    summary: args.summary || '',
    details: jsonParse(args.details || '{}'),
    createdAt: new Date()
  };
  const result = await db.collection('task_results').insertOne(doc);

  if (args.requestId) {
    try {
      await db.collection('task_requests').updateOne(
        { _id: new ObjectId(args.requestId) },
        { $set: { status: 'completed', completedAt: new Date() } }
      );
    } catch {
      // requestId might not be a valid ObjectId, skip
    }
  }

  output({ ok: true, resultId: result.insertedId.toString() });
}

async function pushNotification(args) {
  const db = await getDb();
  const doc = {
    userId: args.userId,
    type: args.type || 'general',
    priority: args.priority || 'normal',
    payload: jsonParse(args.payload || '{}'),
    source: args.source || 'unknown',
    delivered: false,
    createdAt: new Date(),
    deliveredAt: null
  };
  const result = await db.collection('notifications').insertOne(doc);
  output({ ok: true, notificationId: result.insertedId.toString() });
}

async function checkNotified(args) {
  const db = await getDb();
  const doc = await db.collection('notified_log').findOne({
    userId: args.userId,
    threadId: args.threadId
  });
  output({ ok: true, notified: !!doc });
}

async function markNotified(args) {
  const db = await getDb();
  try {
    await db.collection('notified_log').insertOne({
      userId: args.userId,
      threadId: args.threadId,
      source: args.source || 'unknown',
      notifiedAt: new Date()
    });
    output({ ok: true, created: true });
  } catch (err) {
    if (err.code === 11000) {
      output({ ok: true, created: false, message: 'already notified' });
    } else {
      throw err;
    }
  }
}

async function scanNotifications(args) {
  const db = await getDb();
  const query = { delivered: false };
  if (args.userId) {
    query.userId = args.userId;
  }
  const notifications = await db.collection('notifications')
    .find(query)
    .sort({ createdAt: 1 })
    .limit(50)
    .toArray();

  for (const n of notifications) {
    n._id = n._id.toString();
  }
  output({ ok: true, count: notifications.length, notifications });
}

async function markDelivered(args) {
  const db = await getDb();
  const result = await db.collection('notifications').updateOne(
    { _id: new ObjectId(args.notificationId) },
    { $set: { delivered: true, deliveredAt: new Date() } }
  );
  output({ ok: true, modified: result.modifiedCount });
}

// ========================================
// Additional utility commands
// ========================================

async function getResults(args) {
  const db = await getDb();
  const query = {};
  if (args.requestId) query.requestId = args.requestId;
  if (args.agentId) query.agentId = args.agentId;

  const results = await db.collection('task_results')
    .find(query)
    .sort({ createdAt: -1 })
    .limit(parseInt(args.limit) || 10)
    .toArray();

  for (const r of results) {
    r._id = r._id.toString();
  }
  output({ ok: true, count: results.length, results });
}

async function getPendingTasks(args) {
  const db = await getDb();
  const query = { status: 'pending' };
  if (args.type) query.type = args.type;

  const tasks = await db.collection('task_requests')
    .find(query)
    .sort({ createdAt: 1 })
    .limit(parseInt(args.limit) || 20)
    .toArray();

  for (const t of tasks) {
    t._id = t._id.toString();
  }
  output({ ok: true, count: tasks.length, tasks });
}

// ========================================
// Timeout Stale Tasks
// ========================================

async function timeoutStaleTasks(args) {
  const db = await getDb();
  const timeoutMs = parseInt(args.timeoutMs) || 300000;
  const cutoff = new Date(Date.now() - timeoutMs);

  const staleTasks = await db.collection('task_requests')
    .find({ status: 'claimed', claimedAt: { $lt: cutoff } })
    .toArray();

  let timedOut = 0;
  for (const task of staleTasks) {
    await db.collection('task_requests').updateOne(
      { _id: task._id },
      { $set: { status: 'error', error: { message: 'execution timeout' }, errorAt: new Date() } }
    );

    if (task.userId) {
      await db.collection('notifications').insertOne({
        userId: task.userId,
        type: 'task_timeout',
        priority: 'normal',
        payload: { summary: `任務執行超時（${task.type}），請重試`, taskId: task._id.toString() },
        source: 'system',
        delivered: false,
        createdAt: new Date(),
        deliveredAt: null
      });
    }
    timedOut++;
  }

  output({ ok: true, timedOut, checked: staleTasks.length });
}

// ========================================
// Shared Memory
// ========================================

async function setMemory(args) {
  const db = await getDb();
  await db.collection('shared_memory').updateOne(
    { userId: args.userId || 'global', key: args.key },
    { $set: { value: jsonParse(args.value), updatedAt: new Date() } },
    { upsert: true }
  );
  output({ ok: true });
}

async function getMemory(args) {
  const db = await getDb();
  const doc = await db.collection('shared_memory').findOne({
    userId: args.userId || 'global',
    key: args.key
  });
  output({ ok: true, value: doc ? doc.value : null });
}

// ========================================
// Scheduled Tasks
// ========================================

async function listScheduledTasks(args) {
  const db = await getDb();
  const query = {};
  if (args.userId) query.userId = args.userId;
  if (args.status) query.status = args.status;

  const tasks = await db.collection('scheduled_tasks')
    .find(query).sort({ createdAt: 1 }).toArray();
  for (const t of tasks) t._id = t._id.toString();
  output({ ok: true, count: tasks.length, tasks });
}

async function updateScheduledTask(args) {
  const db = await getDb();
  const update = {};
  if (args.status) update.status = args.status;
  if (args.interval) update.interval = parseInt(args.interval);
  update.updatedAt = new Date();

  const result = await db.collection('scheduled_tasks').updateOne(
    { taskId: args.taskId },
    { $set: update }
  );
  output({ ok: true, matched: result.matchedCount, modified: result.modifiedCount });
}

async function updateTaskLastRun(args) {
  const db = await getDb();
  const result = await db.collection('scheduled_tasks').updateOne(
    { taskId: args.taskId },
    { $set: { lastRunAt: new Date(), lastResult: args.lastResult || null } }
  );
  output({ ok: true, matched: result.matchedCount, modified: result.modifiedCount });
}

// ========================================
// CLI Entry
// ========================================

const COMMANDS = {
  'write-task': writeTask,
  'claim-task': claimTask,
  'write-result': writeResult,
  'push-notification': pushNotification,
  'check-notified': checkNotified,
  'mark-notified': markNotified,
  'scan-notifications': scanNotifications,
  'mark-delivered': markDelivered,
  'get-results': getResults,
  'get-pending-tasks': getPendingTasks,
  'timeout-stale-tasks': timeoutStaleTasks,
  'set-memory': setMemory,
  'get-memory': getMemory,
  'list-scheduled-tasks': listScheduledTasks,
  'update-scheduled-task': updateScheduledTask,
  'update-task-last-run': updateTaskLastRun
};

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parseArgs(argv.slice(1));

  if (!command || !COMMANDS[command]) {
    output({
      ok: false,
      error: `Unknown command: ${command}`,
      available: Object.keys(COMMANDS)
    });
    process.exit(1);
  }

  try {
    await COMMANDS[command](args);
  } catch (err) {
    output({ ok: false, error: err.message });
    process.exit(1);
  } finally {
    await close();
  }
}

// ========================================
// Module Exports
// ========================================

module.exports = {
  getDb, close, parseArgs, jsonParse, output,
  writeTask, claimTask, writeResult,
  pushNotification, checkNotified, markNotified,
  scanNotifications, markDelivered,
  getResults, getPendingTasks,
  timeoutStaleTasks,
  setMemory, getMemory,
  listScheduledTasks, updateScheduledTask, updateTaskLastRun,
  COMMANDS
};

if (require.main === module) {
  main();
}
