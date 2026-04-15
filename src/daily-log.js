/**
 * 穗鈅助手 — 每日記憶日誌
 *
 * MongoDB daily_logs collection，每日每用戶一份文件。
 * Skill 執行完自動 append，LLM 的 [日誌] 標記也會寫入。
 * 載入範圍：今天 + 昨天。30 天後歸檔。
 *
 * @version 1.0.0
 */

const mongo = require('../lib/mongodb-tools');

// ============================================================
// 寫入
// ============================================================

/**
 * 新增一條日誌到今天的記錄
 * @param {string} userId
 * @param {Object} entry - { type, content, relatedSkill }
 *   type: 'task' | 'decision' | 'event' | 'note'
 */
async function appendLog(userId, entry) {
  const db = await mongo.getDb();
  const today = new Date().toISOString().split('T')[0];

  // 去重：同一天內完全相同的 content → 跳過
  if (entry.content) {
    const existing = await db.collection('daily_logs').findOne({
      userId,
      date: today,
      'entries.content': entry.content.trim(),
    });
    if (existing) {
      console.log('[daily-log] 跳過重複日誌:', entry.content.substring(0, 40));
      return;
    }
  }

  await db.collection('daily_logs').updateOne(
    { userId, date: today },
    {
      $push: {
        entries: {
          ...entry,
          time: new Date(),
        },
      },
      $setOnInsert: { userId, date: today },
    },
    { upsert: true }
  );
}

// ============================================================
// 讀取（只載入今天 + 昨天）
// ============================================================

/**
 * 載入最近的日誌（今天 + 昨天）
 * @param {string} userId
 * @returns {string} 格式化的日誌文字
 */
async function loadRecentLogs(userId) {
  const db = await mongo.getDb();
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  const logs = await db.collection('daily_logs')
    .find({ userId, date: { $in: [today, yesterday] } })
    .sort({ date: -1 })
    .toArray();

  if (!logs.length) return '（今天尚無活動記錄）';

  return logs.map(log => {
    const header = `## ${log.date}`;
    const items = (log.entries || []).map(e => {
      const time = e.time ? new Date(e.time).toTimeString().slice(0, 5) : '??:??';
      return `- [${time}] ${e.content}`;
    }).join('\n');
    return `${header}\n${items}`;
  }).join('\n\n');
}

/**
 * 只載入今天的日誌（Ollama 精簡版用）
 * @param {string} userId
 * @returns {string} 格式化的日誌文字
 */
async function loadTodayLogs(userId) {
  const db = await mongo.getDb();
  const today = new Date().toISOString().split('T')[0];

  const log = await db.collection('daily_logs')
    .findOne({ userId, date: today });

  if (!log || !log.entries?.length) return '（今天尚無活動記錄）';

  const items = log.entries.map(e => {
    const time = e.time ? new Date(e.time).toTimeString().slice(0, 5) : '??:??';
    return `- [${time}] ${e.content}`;
  }).join('\n');

  return items;
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

// 暴露 db 存取（測試用）
Object.defineProperty(module.exports, 'db', {
  get: () => {
    // 返回一個 promise-like proxy 讓測試可以直接操作 collection
    return {
      collection: (name) => {
        // 這個會在 getDb() 之後才能用
        const client = require('../lib/mongodb-tools');
        // 同步取得已連線的 db（假設已呼叫過 connect）
        let _db = null;
        return {
          insertOne: async (doc) => {
            _db = _db || await client.getDb();
            return _db.collection(name).insertOne(doc);
          },
          find: async (query) => {
            _db = _db || await client.getDb();
            return _db.collection(name).find(query);
          },
        };
      },
    };
  },
});

// ============================================================
// Export
// ============================================================

module.exports = {
  appendLog,
  loadRecentLogs,
  loadTodayLogs,
  connect,
  close,
};
