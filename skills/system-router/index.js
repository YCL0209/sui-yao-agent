/**
 * System Router Skill (v3)
 *
 * 意圖路由器 — 接收 LLM 分類結果，驗證 type 後分派到對應 skill。
 * v3：改為直接 require skills（不再用 child_process.execSync）。
 *
 * @version 1.0.0
 */

const mongo = require('../../lib/mongodb-tools');

const VALID_TYPES = ['email', 'erp', 'reminder', 'query', 'chat'];

// ========================================
// Lazy-load skills（避免循環依賴）
// ========================================

let _skills = null;
function getSkills() {
  if (!_skills) {
    _skills = {
      email: require('../check-email'),
      reminder: require('../set-reminder'),
      erp: require('../create-order'),
    };
  }
  return _skills;
}

// ========================================
// Route Handlers
// ========================================

async function handleQuery(params, userId) {
  const db = await mongo.getDb();
  const source = params.source || 'notifications';

  if (source === 'task_status') {
    const query = { status: { $in: ['pending', 'claimed'] } };
    const tasks = await db.collection('task_requests')
      .find(query).sort({ createdAt: 1 }).limit(20).toArray();
    for (const t of tasks) t._id = t._id.toString();
    return { ok: true, action: 'query', data: { count: tasks.length, tasks } };
  }

  if (source === 'scheduled_tasks') {
    const query = {};
    if (userId) query.userId = userId;
    const tasks = await db.collection('scheduled_tasks')
      .find(query).sort({ createdAt: 1 }).toArray();
    for (const t of tasks) t._id = t._id.toString();
    return { ok: true, action: 'query', data: { count: tasks.length, tasks } };
  }

  if (source === 'pause_task') {
    const result = await db.collection('scheduled_tasks').updateOne(
      { taskId: params.taskId },
      { $set: { status: 'paused', updatedAt: new Date() } }
    );
    return { ok: true, action: 'query', data: { modified: result.modifiedCount, message: '已暫停' } };
  }

  if (source === 'resume_task') {
    const result = await db.collection('scheduled_tasks').updateOne(
      { taskId: params.taskId },
      { $set: { status: 'active', updatedAt: new Date() } }
    );
    return { ok: true, action: 'query', data: { modified: result.modifiedCount, message: '已恢復' } };
  }

  if (source === 'update_interval') {
    const result = await db.collection('scheduled_tasks').updateOne(
      { taskId: params.taskId },
      { $set: { interval: parseInt(params.interval), updatedAt: new Date() } }
    );
    return { ok: true, action: 'query', data: { modified: result.modifiedCount, message: '已更新間隔' } };
  }

  if (source === 'create_task') {
    const doc = {
      taskId: `${params.taskType}-user-${userId}`,
      userId,
      taskType: params.taskType,
      status: 'active',
      interval: parseInt(params.interval),
      config: params.config || {},
      activeHours: params.activeHours || { start: "09:00", end: "21:00" },
      timezone: params.timezone || "Asia/Taipei",
      lastRunAt: null,
      lastResult: null,
      createdAt: new Date()
    };
    const result = await db.collection('scheduled_tasks').insertOne(doc);
    return { ok: true, action: 'query', data: { inserted: result.insertedId.toString(), taskId: doc.taskId, message: '已建立定時任務' } };
  }

  if (source === 'delete_task') {
    const result = await db.collection('scheduled_tasks').deleteOne({ taskId: params.taskId });
    return { ok: true, action: 'query', data: { deleted: result.deletedCount, message: '已刪除' } };
  }

  if (source === 'cancel_reminder') {
    const { ObjectId } = require('mongodb');
    let filter;
    if (params.reminderId) {
      filter = { _id: new ObjectId(params.reminderId) };
    } else if (params.content) {
      filter = { content: { $regex: params.content, $options: 'i' }, status: 'pending' };
    } else {
      return { ok: false, error: '需要 reminderId 或 content 來取消提醒' };
    }
    const result = await db.collection('reminders').updateOne(
      filter,
      { $set: { status: 'cancelled', cancelledAt: new Date() } }
    );
    return { ok: true, action: 'query', data: { modified: result.modifiedCount, message: result.modifiedCount ? '已取消提醒' : '找不到符合的提醒' } };
  }

  if (source === 'list_reminders') {
    const reminders = await db.collection('reminders')
      .find({ status: 'pending', userId: userId || undefined })
      .sort({ remindAt: 1 }).limit(20).toArray();
    for (const r of reminders) r._id = r._id.toString();
    return { ok: true, action: 'query', data: { count: reminders.length, reminders } };
  }

  // default: scan notifications
  const query = { delivered: false };
  if (userId) query.userId = userId;
  const notifications = await db.collection('notifications')
    .find(query).sort({ createdAt: 1 }).limit(50).toArray();
  for (const n of notifications) n._id = n._id.toString();
  return { ok: true, action: 'query', data: { count: notifications.length, notifications } };
}

async function handleSkillExec(type, params, userId) {
  const skills = getSkills();
  const skill = skills[type];

  if (!skill) {
    return { ok: false, error: `type "${type}" not supported for skill exec` };
  }

  const db = await mongo.getDb();

  // Log task request
  const taskDoc = {
    type, status: 'executing',
    userId: userId || null, params, context: {},
    createdAt: new Date(), claimedBy: 'system-router', claimedAt: new Date()
  };
  const taskResult = await db.collection('task_requests').insertOne(taskDoc);
  const taskId = taskResult.insertedId.toString();

  const startMs = Date.now();

  try {
    // Normalize params for reminder skill
    if (type === 'reminder') {
      if (params.message && !params.content) params.content = params.message;
      if (params.date && !params.remindAt) params.remindAt = params.date;
      if (params.time && !params.remindAt) params.remindAt = params.time;
      if (params.text && !params.content) params.content = params.text;
    }

    // Call skill's run() method
    const result = await skill.run(
      { ...params, userId },
      { userId }
    );

    const durationMs = Date.now() - startMs;
    const summary = result.summary || JSON.stringify(result.data);

    // Log result
    await db.collection('task_results').insertOne({
      requestId: taskId,
      scriptId: type,
      status: 'success',
      summary,
      details: result.data || {},
      executedAt: new Date(),
      durationMs
    });

    await db.collection('task_requests').updateOne(
      { _id: taskResult.insertedId },
      { $set: { status: 'completed', completedAt: new Date() } }
    );

    return { ok: true, action: 'result', data: { summary, taskId } };

  } catch (err) {
    const durationMs = Date.now() - startMs;
    const errorMsg = err.message;

    await db.collection('task_results').insertOne({
      requestId: taskId,
      scriptId: type,
      status: 'error',
      summary: '',
      details: { error: errorMsg },
      executedAt: new Date(),
      durationMs
    });

    await db.collection('task_requests').updateOne(
      { _id: taskResult.insertedId },
      { $set: { status: 'error', completedAt: new Date() } }
    );

    return { ok: false, error: errorMsg, data: { taskId } };
  }
}

function handleChat() {
  return { ok: true, action: 'chat' };
}

// ========================================
// Main Router
// ========================================

async function route(intent, userId) {
  const type = intent.type;
  const params = intent.params || {};

  if (!VALID_TYPES.includes(type)) {
    return { ok: false, action: 'chat', error: `invalid type: ${type}`, validTypes: VALID_TYPES };
  }

  switch (type) {
    case 'query':    return await handleQuery(params, userId);
    case 'email':    return await handleSkillExec('email', params, userId);
    case 'reminder': return await handleSkillExec('reminder', params, userId);
    case 'erp':      return await handleSkillExec('erp', params, userId);
    case 'chat':     return handleChat();
  }
}

// ========================================
// v3 Standard Interface
// ========================================

module.exports = {
  name: 'system-router',
  description: '意圖路由器 — 分派意圖到對應 skill（email、erp、reminder、query、chat）',
  version: '1.0.0',

  definition: {
    name: 'system-router',
    description: '接收意圖分類結果，路由到對應處理邏輯',
    parameters: {
      type: 'object',
      properties: {
        type:   { type: 'string', enum: VALID_TYPES, description: '意圖類型' },
        params: { type: 'object', description: '意圖參數' }
      },
      required: ['type']
    }
  },

  async run(args, context) {
    const userId = context?.userId || args.userId || null;
    const intent = { type: args.type, params: args.params || {} };
    const result = await route(intent, userId);
    return {
      success: result.ok !== false,
      data: result,
      summary: result.data?.summary || result.data?.message || result.action || ''
    };
  },

  // Legacy exports
  route,
  handleQuery,
};

// ========================================
// CLI Entry Point
// ========================================

if (require.main === module) {
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

  const args = parseArgs(process.argv.slice(2));
  const userId = args.userId || null;

  let intent;
  try {
    intent = JSON.parse(args.intent);
  } catch {
    console.log(JSON.stringify({ ok: true, action: 'chat', fallback: true, reason: 'invalid intent JSON' }));
    process.exit(0);
  }

  route(intent, userId)
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(err => {
      console.log(JSON.stringify({ ok: false, error: err.message }));
      process.exit(1);
    })
    .finally(() => mongo.close());
}
