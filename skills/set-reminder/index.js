/**
 * Set Reminder Skill (v3)
 *
 * 設定提醒事項，寫入 MongoDB reminders collection。
 * 支援單次提醒和重複提醒（daily / weekly / monthly / interval）。
 *
 * @version 1.0.0
 */

const mongo = require('../../lib/mongodb-tools');

// ========================================
// Core Logic
// ========================================

async function createReminder(args) {
  const userId = args.userId || null;
  const content = args.content || '';
  const remindAt = args.remindAt ? new Date(args.remindAt) : null;

  if (!content) {
    return { success: false, data: null, summary: '缺少提醒內容' };
  }

  // 解析 repeat 參數
  let repeat = null;
  if (args.repeat) {
    repeat = { type: args.repeat };
    if (args.weekdays) {
      repeat.weekdays = typeof args.weekdays === 'string'
        ? args.weekdays.split(',').map(Number)
        : args.weekdays;
    }
    if (args.dayOfMonth) {
      repeat.dayOfMonth = parseInt(args.dayOfMonth);
    }
    if (args.intervalMs) {
      repeat.intervalMs = parseInt(args.intervalMs);
    }
  }

  const db = await mongo.getDb();

  const doc = {
    userId,
    content,
    remindAt,
    repeat,
    status: 'pending',
    createdAt: new Date(),
    deliveredAt: null
  };

  const result = await db.collection('reminders').insertOne(doc);

  const repeatLabels = {
    daily: '每天',
    weekly: `每週${(repeat?.weekdays || []).map(d => '日一二三四五六'[d % 7]).join('、')}`,
    monthly: `每月 ${repeat?.dayOfMonth || ''} 號`,
    interval: `每 ${repeat?.intervalMs ? Math.round(repeat.intervalMs / 60000) + ' 分鐘' : '?'}`
  };
  const repeatText = repeat ? `\n🔁 重複：${repeatLabels[repeat.type] || repeat.type}` : '';

  const summary = remindAt
    ? `✅ 已設定提醒：「${content}」\n⏰ 提醒時間：${remindAt.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}${repeatText}`
    : `✅ 已設定提醒：「${content}」\n⏰ 提醒時間：未指定${repeatText}`;

  return {
    success: true,
    data: { reminderId: result.insertedId.toString() },
    summary
  };
}

// ========================================
// v3 Standard Interface
// ========================================

module.exports = {
  name: 'set-reminder',
  description: '設定提醒事項（單次或重複）',
  version: '1.0.0',

  definition: {
    name: 'set-reminder',
    description: '設定提醒事項，寫入 MongoDB',
    parameters: {
      type: 'object',
      properties: {
        content:    { type: 'string', description: '提醒內容' },
        remindAt:   { type: 'string', description: 'ISO 8601 日期時間' },
        repeat:     { type: 'string', enum: ['daily', 'weekly', 'monthly', 'interval'], description: '重複類型' },
        weekdays:   { type: 'string', description: '週幾（逗號分隔，0=日 1=一 ...）' },
        dayOfMonth: { type: 'number', description: '每月幾號' },
        intervalMs: { type: 'number', description: '間隔毫秒數' }
      },
      required: ['content']
    }
  },

  async run(args, context) {
    const result = await createReminder({
      ...args,
      userId: context?.userId || args.userId || null
    });
    return result;
  },

  // Legacy export
  createReminder,
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
  createReminder(args)
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(err => {
      console.log(JSON.stringify({ success: false, data: null, summary: err.message }));
      process.exit(1);
    })
    .finally(() => mongo.close());
}
