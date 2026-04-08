/**
 * 穗鈅助手 — 提醒確認互動 Agent
 *
 * LLM 呼叫 set-reminder 時，不直接寫入 MongoDB，
 * 改為顯示確認按鈕讓用戶確認內容和時間。
 *
 * callback_data 格式：reminder:{action}:{payload}
 *
 * @version 1.0.0
 */

const ism = require('../interactive-session');
const agentRegistry = require('../agent-registry');

// ========================================
// 面向用戶的文字（調教在這裡改）
// ========================================

const MESSAGES = {
  confirm: (content, timeStr, repeatStr) => {
    let text = `⏰ 提醒確認：\n\n內容：${content}\n時間：${timeStr}`;
    if (repeatStr) text += `\n🔁 重複：${repeatStr}`;
    text += '\n\n確認設定嗎？';
    return text;
  },
  created: (summary) => summary, // 直接用 createReminder 回傳的 summary
  cancelled: '❌ 已取消提醒設定。',
  askNewTime: '請輸入新的提醒時間（例如：明天下午三點、4/15 09:00）：',
  timeParseHint: '無法解析時間，請用以下格式：\n• 明天下午三點\n• 2026-04-15 09:00\n• 4/15 14:30',
  expired: '提醒設定已過期，請重新告訴我。',
  noTime: '（未指定時間）',
};

// ========================================
// 按鈕模板
// ========================================

function confirmButtons() {
  return {
    inline_keyboard: [
      [
        { text: '✅ 確認', callback_data: 'reminder:confirm' },
        { text: '✏️ 改時間', callback_data: 'reminder:edittime' },
      ],
      [
        { text: '❌ 取消', callback_data: 'reminder:cancel' },
      ],
    ],
  };
}

// ========================================
// 時間格式化
// ========================================

function formatTime(remindAt) {
  if (!remindAt) return MESSAGES.noTime;
  const d = new Date(remindAt);
  if (isNaN(d.getTime())) return MESSAGES.noTime;
  return d.toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRepeat(repeat) {
  if (!repeat) return null;
  const labels = {
    daily: '每天',
    weekly: `每週${(repeat.weekdays || []).map(d => '日一二三四五六'[d % 7]).join('、')}`,
    monthly: `每月 ${repeat.dayOfMonth || ''} 號`,
    interval: `每 ${repeat.intervalMs ? Math.round(repeat.intervalMs / 60000) + ' 分鐘' : '?'}`,
  };
  return labels[repeat.type] || repeat.type;
}

// ========================================
// ISM Handler
// ========================================

const reminderHandler = {
  ttl: 5 * 60 * 1000, // 5 分鐘

  // ---- 開始互動：顯示確認按鈕 ----
  async onStart({ session }) {
    const { content, remindAt, repeat } = session.data;
    const timeStr = formatTime(remindAt);
    const repeatStr = formatRepeat(repeat);

    session.step = 'confirm';

    return {
      text: MESSAGES.confirm(content, timeStr, repeatStr),
      reply_markup: confirmButtons(),
    };
  },

  // ---- 按鈕回調 ----
  async onCallback(session, action, payload, context) {

    // 取消
    if (action === 'cancel') {
      return { text: MESSAGES.cancelled, done: true };
    }

    // 確認 → 寫入 DB
    if (action === 'confirm') {
      // lazy require 避免循環依賴
      const reminderSkill = require('../../skills/set-reminder');
      const result = await reminderSkill.createReminder({
        userId: session.userId,
        content: session.data.content,
        remindAt: session.data.remindAt,
        repeat: session.data.repeat?.type || null,
        weekdays: session.data.repeat?.weekdays || null,
        dayOfMonth: session.data.repeat?.dayOfMonth || null,
        intervalMs: session.data.repeat?.intervalMs || null,
      });

      if (result.success) {
        return { text: MESSAGES.created(result.summary), done: true };
      }
      return { text: `設定失敗：${result.summary}`, done: true };
    }

    // 改時間 → 進入文字輸入模式
    if (action === 'edittime') {
      session.step = 'edit_time';
      return { text: MESSAGES.askNewTime };
    }

    return { text: MESSAGES.expired, done: true };
  },

  // ---- 文字輸入（改時間用） ----
  async onTextInput(session, text, context) {
    if (session.step !== 'edit_time') return null;

    const trimmed = text.trim();

    // 取消
    if (/^(取消|cancel)$/i.test(trimmed)) {
      return { text: MESSAGES.cancelled, done: true };
    }

    // 嘗試解析時間
    // 先試 ISO 格式
    let newDate = new Date(trimmed);

    // 如果不是有效日期，嘗試常見中文格式
    if (isNaN(newDate.getTime())) {
      newDate = parseChineseTime(trimmed);
    }

    if (!newDate || isNaN(newDate.getTime())) {
      return { text: MESSAGES.timeParseHint };
    }

    // 更新時間，重新顯示確認
    session.data.remindAt = newDate.toISOString();
    session.step = 'confirm';

    const timeStr = formatTime(newDate);
    const repeatStr = formatRepeat(session.data.repeat);

    return {
      text: MESSAGES.confirm(session.data.content, timeStr, repeatStr),
      reply_markup: confirmButtons(),
    };
  },

  async onTimeout(session) {
    console.log(`[reminder-agent] Session 超時: chat=${session.chatId}`);
  },
};

// ========================================
// 中文時間解析（簡易版）
// ========================================

/**
 * 解析常見中文時間表達
 * 支援：「明天下午三點」「4/15 09:00」「下午 2:30」等
 * 複雜的時間解析交給 LLM，這裡只處理用戶手動輸入改時間的場景
 */
function parseChineseTime(text) {
  const now = new Date();

  // 「4/15 09:00」「4/15 14:30」
  const slashMatch = text.match(/(\d{1,2})\/(\d{1,2})\s*(\d{1,2}):(\d{2})/);
  if (slashMatch) {
    const d = new Date(now.getFullYear(), parseInt(slashMatch[1]) - 1, parseInt(slashMatch[2]),
      parseInt(slashMatch[3]), parseInt(slashMatch[4]));
    if (d < now) d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  // 「4/15」（不帶時間，預設 09:00）
  const dateOnlyMatch = text.match(/(\d{1,2})\/(\d{1,2})$/);
  if (dateOnlyMatch) {
    const d = new Date(now.getFullYear(), parseInt(dateOnlyMatch[1]) - 1, parseInt(dateOnlyMatch[2]), 9, 0);
    if (d < now) d.setFullYear(d.getFullYear() + 1);
    return d;
  }

  // 「明天」「後天」+ 可選的時間
  let dayOffset = 0;
  if (text.includes('明天')) dayOffset = 1;
  else if (text.includes('後天')) dayOffset = 2;

  let hour = 9, minute = 0; // 預設早上 9 點
  if (text.includes('下午') || text.includes('晚上')) {
    const hMatch = text.match(/(\d{1,2})(?::(\d{2}))?/);
    if (hMatch) {
      hour = parseInt(hMatch[1]);
      if (hour < 12 && text.includes('下午')) hour += 12;
      minute = hMatch[2] ? parseInt(hMatch[2]) : 0;
    } else {
      hour = text.includes('晚上') ? 20 : 14;
    }
  } else if (text.includes('早上') || text.includes('上午')) {
    const hMatch = text.match(/(\d{1,2})(?::(\d{2}))?/);
    if (hMatch) {
      hour = parseInt(hMatch[1]);
      minute = hMatch[2] ? parseInt(hMatch[2]) : 0;
    } else {
      hour = 9;
    }
  } else {
    // 純數字時間 「14:30」「3點」
    const hMatch = text.match(/(\d{1,2})(?::(\d{2})|\s*點)/);
    if (hMatch) {
      hour = parseInt(hMatch[1]);
      minute = hMatch[2] ? parseInt(hMatch[2]) : 0;
    }
  }

  if (dayOffset > 0) {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, minute, 0, 0);
    return d;
  }

  // 如果有解析到時間但沒有日期偏移，假設是今天（如果已過就是明天）
  const hMatch = text.match(/(\d{1,2})(?::(\d{2})|\s*點)/);
  if (hMatch) {
    const d = new Date(now);
    d.setHours(hour, minute, 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1);
    return d;
  }

  return null; // 解析失敗
}

// ========================================
// 註冊
// ========================================

ism.registerHandler('reminder', reminderHandler);

agentRegistry.register({
  name: 'reminder',
  description: '提醒設定確認 agent — 顯示確認按鈕讓用戶確認後才寫入',
  systemPrompt: '你是穗鈅助手的提醒設定模組。',
  allowedSkills: ['set-reminder'],
  messages: MESSAGES,
});

// ========================================
// Export
// ========================================

module.exports = {
  MESSAGES,
  formatTime,
  formatRepeat,
  startReminderSession: async (chatId, userId, initialData = {}) => {
    return ism.startSession('reminder', { chatId, userId, initialData });
  },
};
