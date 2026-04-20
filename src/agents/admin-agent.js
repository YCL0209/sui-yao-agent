/**
 * 穗鈅助手 — 管理員審核 Agent
 *
 * 新用戶註冊時推送通知給 admin，按按鈕審核。
 * 審核 callback 不走 ISM session（直接由 bot-server callback handler 處理），
 * 但仍註冊 ISM handler 以便未來擴展。
 *
 * callback_data 格式：admin:{action}:{chatId}[:{role}]
 *
 * @version 1.0.0
 */

const ism = require('../interactive-session');
const agentRegistry = require('../agent-registry');
const config = require('../config');

const MESSAGES = {
  // I2 v3：純文字通知 + Dashboard 連結（無按鈕）
  newUserNotifyWithDashboard: (user, dashboardUrl) => {
    const profile = user.profile || {};
    const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || '未知';
    const username = profile.username ? `@${profile.username}` : '無';
    const platformLabel = user.platform === 'discord' ? 'Discord' : 'Telegram';
    return `👤 新用戶申請\n\n`
      + `姓名：${name}\n`
      + `Username：${username}\n`
      + `平台：${platformLabel}\n`
      + `Chat ID：${user.chatId}\n\n`
      + `請登入 Dashboard 處理：\n${dashboardUrl}/#users`;
  },
  approved: (name, role) => `✅ 已核准「${name}」為 ${role}`,
  blocked: (name) => `🚫 已封鎖「${name}」`,
  pendingReply: '⏳ 您的帳號正在審核中，請稍候。',
  welcomeAfterApproval: '✅ 您的帳號已通過審核！現在可以開始使用穗鈅助手了。',
  // I2 v3：Discord 用戶專用歡迎詞（channel 尚未建好）
  welcomeAfterApprovalDiscord:
    '✅ 您的帳號已通過審核！\n\n'
    + '管理員正在為您建立專屬操作 channel，請稍候。\n'
    + '建好後會再通知您。\n\n'
    + '您也可以直接在這裡（DM）跟我對話，處理日常工作。',
};

// ISM stub handler（目前未使用，預留給未來功能）
const adminHandler = {
  ttl: 60 * 60 * 1000,
  async onStart() {
    return { text: '' };
  },
  async onCallback() {
    return { text: '', done: true };
  },
};

ism.registerHandler('admin', adminHandler);

agentRegistry.register({
  name: 'admin',
  description: '管理員審核 agent — 新用戶核准/封鎖',
  systemPrompt: '管理員 agent（目前只用於 ISM 註冊預留，實際審核走 callback handler 短路）。',
  allowedSkills: [],
  messages: MESSAGES,
});

/**
 * 組新用戶審核通知（純文字 + Dashboard 連結，無按鈕）
 * orchestrator._handleNewUser 呼叫，廣播給 admin
 */
function getNewUserNotification(user) {
  return {
    text: MESSAGES.newUserNotifyWithDashboard(user, config.dashboard.publicUrl),
  };
}

module.exports = {
  MESSAGES,
  getNewUserNotification,
};
