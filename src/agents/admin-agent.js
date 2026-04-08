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

const MESSAGES = {
  newUserNotify: (profile, chatId) => {
    const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || '未知';
    const username = profile.username ? `@${profile.username}` : '無';
    return `👤 新用戶申請\n\n姓名：${name}\nUsername：${username}\nChat ID：${chatId}\n\n請選擇操作：`;
  },
  approved: (name, role) => `✅ 已核准「${name}」為 ${role}`,
  blocked: (name) => `🚫 已封鎖「${name}」`,
  pendingReply: '⏳ 您的帳號正在審核中，請稍候。',
  welcomeAfterApproval: '✅ 您的帳號已通過審核！現在可以開始使用穗鈅助手了。',
};

function approvalButtons(chatId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ 核准（一般）', callback_data: `admin:approve:${chatId}:user` },
        { text: '✅ 核准（高級）', callback_data: `admin:approve:${chatId}:advanced` },
      ],
      [
        { text: '🚫 封鎖', callback_data: `admin:block:${chatId}` },
      ],
    ],
  };
}

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
 * 發送新用戶審核通知給 admin
 * 由 bot-server 呼叫（不走 ISM 的 startSession，因為是推播給 admin 不是回覆用戶）
 */
function getNewUserNotification(user) {
  const profile = user.profile || {};
  return {
    text: MESSAGES.newUserNotify(profile, user.chatId),
    reply_markup: approvalButtons(user.chatId),
  };
}

module.exports = {
  MESSAGES,
  getNewUserNotification,
  approvalButtons,
};
