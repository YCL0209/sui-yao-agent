# 階段 H1：多用戶 + 權限系統

> G1 已完成（DB 清理機制）。本階段加入多用戶支援和權限控制。
> 核心原則：非 admin 用戶彼此完全不可見，只能操作自己的資料。

---

## 專案位置

```
~/sui-yao-agent/  (main 分支)
├── src/
│   ├── auth.js                    # ⚡ 新建：用戶認證 + 權限檢查
│   ├── bot-server.js              # 🔧 修改：訊息入口加認證層
│   ├── policy-engine.js           # 🔧 修改：整合用戶權限
│   ├── config.js                  # 🔧 修改：新增 auth 設定
│   └── agents/
│       └── admin-agent.js         # ⚡ 新建：用戶審核互動 agent
├── scripts/
│   └── ensure-indexes.js          # 🔧 修改：加 users collection 索引
├── prompts/
│   └── rules.md                   # 🔧 小改：加權限相關行為規則
└── docs/
    └── mongodb-schema.md          # 🔧 修改：加 users + roles 說明
```

---

## 一、角色定義

### 三個角色

| 角色 | 說明 | 可用功能 | 資料範圍 |
|---|---|---|---|
| `admin` | 管理員（你） | 全功能 + 用戶管理 | 所有人 |
| `advanced` | 高級用戶 | 全功能 | 只有自己 |
| `user` | 一般用戶 | 對話 + 提醒 | 只有自己 |

### 權限矩陣

| 功能 | admin | advanced | user |
|---|---|---|---|
| 一般對話 | ✅ | ✅ | ✅ |
| 設提醒 / 查看提醒 | ✅ | ✅ | ✅ |
| 建立訂單 | ✅ | ✅ | ❌ |
| 文件解析建單 | ✅ | ✅ | ❌ |
| 查信 | ✅ | ✅ | ❌ |
| 列印標籤 | ✅ | ✅ | ❌ |
| 生成 PDF | ✅ | ✅ | ❌ |
| 同步產品 | ✅ | ✅ | ❌ |
| 查看其他人的資料 | ✅ | ❌ | ❌ |
| 修改其他人的資料 | ✅ | ❌ | ❌ |
| 審核用戶 | ✅ | ❌ | ❌ |
| 修改角色 | ✅ | ❌ | ❌ |

### 權限對應 skill

```javascript
const ROLE_PERMISSIONS = {
  admin: {
    skills: ['*'],  // 全部
    dataScope: 'all',
    canManageUsers: true,
  },
  advanced: {
    skills: ['create-order', 'check-email', 'set-reminder', 'generate-pdf', 'print-label', 'system-router'],
    dataScope: 'own',
    canManageUsers: false,
  },
  user: {
    skills: ['set-reminder'],
    dataScope: 'own',
    canManageUsers: false,
  },
};
```

---

## 二、MongoDB 資料結構

### users collection

```javascript
{
  chatId: 8331678146,                    // Telegram chat ID（number，唯一）
  userId: "telegram:8331678146",         // 系統用 userId
  
  // Telegram 資訊（自動從 msg.from 抓取）
  profile: {
    firstName: "亞丞",
    lastName: "Liao",
    username: "yacheng",
    languageCode: "zh-hant",
  },
  
  // 角色與狀態
  role: "user",                          // admin | advanced | user
  status: "active",                      // active | pending | blocked
  
  // 自定義權限覆寫（可選，大部分情況不需要）
  overrides: {},                         // { "create-order": true } ← 額外開放某個 skill
  
  // 時間戳
  createdAt: ISODate,
  approvedAt: ISODate,                   // 審核通過時間
  approvedBy: "telegram:8331678146",     // 誰審核的
  lastActiveAt: ISODate,                 // 最後活動時間
}
```

### admin 用戶的初始化

你（admin）不走審核流程，在 ensure-indexes.js 裡自動建立：

```javascript
// ensure-indexes.js 裡加上
await db.collection('users').updateOne(
  { chatId: Number(appConfig.telegram.adminChatId) },
  {
    $setOnInsert: {
      chatId: Number(appConfig.telegram.adminChatId),
      userId: `telegram:${appConfig.telegram.adminChatId}`,
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
```

---

## 三、核心模組：src/auth.js

```javascript
/**
 * 穗鈅助手 — 用戶認證與權限管理
 *
 * 每次訊息進來時：
 * 1. 查 users collection，確認用戶存在且 active
 * 2. 不存在 → 自動註冊（pending）+ 通知 admin
 * 3. pending → 回覆「審核中」
 * 4. blocked → 不回覆
 * 5. active → 回傳用戶資訊和權限
 *
 * @version 1.0.0
 */

const mongo = require('../lib/mongodb-tools');
const config = require('./config');

// 角色權限定義
const ROLE_PERMISSIONS = {
  admin: {
    skills: ['*'],
    dataScope: 'all',
    canManageUsers: true,
  },
  advanced: {
    skills: ['create-order', 'check-email', 'set-reminder', 'generate-pdf', 'print-label', 'system-router'],
    dataScope: 'own',
    canManageUsers: false,
  },
  user: {
    skills: ['set-reminder'],
    dataScope: 'own',
    canManageUsers: false,
  },
};

// 用戶快取（減少 DB 查詢，TTL 5 分鐘）
const _userCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

/**
 * 認證用戶：查詢或自動註冊
 *
 * @param {Object} msg — Telegram message 物件
 * @returns {Promise<{ status, user, permissions } | { status: 'pending'|'blocked'|'new' }>}
 */
async function authenticate(msg) {
  const chatId = msg.chat.id;
  const from = msg.from || {};

  // 快取檢查
  const cached = _userCache.get(chatId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    // 更新 lastActiveAt（fire-and-forget）
    touchUser(chatId).catch(() => {});
    return cached.result;
  }

  const db = await mongo.getDb();
  let user = await db.collection('users').findOne({ chatId: Number(chatId) });

  // 用戶不存在 → 自動註冊
  if (!user) {
    user = {
      chatId: Number(chatId),
      userId: `telegram:${chatId}`,
      profile: {
        firstName: from.first_name || '',
        lastName: from.last_name || '',
        username: from.username || '',
        languageCode: from.language_code || '',
      },
      role: 'user',
      status: 'pending',
      createdAt: new Date(),
      lastActiveAt: new Date(),
    };
    await db.collection('users').insertOne(user);

    const result = { status: 'new', user, chatId };
    _userCache.set(chatId, { result, ts: Date.now() });
    return result;
  }

  // pending → 等審核
  if (user.status === 'pending') {
    const result = { status: 'pending', user, chatId };
    _userCache.set(chatId, { result, ts: Date.now() });
    return result;
  }

  // blocked → 不回覆
  if (user.status === 'blocked') {
    const result = { status: 'blocked', user, chatId };
    _userCache.set(chatId, { result, ts: Date.now() });
    return result;
  }

  // active → 回傳權限
  const permissions = getPermissions(user);
  const result = { status: 'active', user, permissions, chatId };
  _userCache.set(chatId, { result, ts: Date.now() });

  // 更新 lastActiveAt + profile（fire-and-forget）
  touchUser(chatId, from).catch(() => {});

  return result;
}

/**
 * 取得用戶的權限
 */
function getPermissions(user) {
  const rolePerms = ROLE_PERMISSIONS[user.role] || ROLE_PERMISSIONS.user;
  const overrides = user.overrides || {};

  return {
    role: user.role,
    skills: rolePerms.skills,
    dataScope: rolePerms.dataScope,
    canManageUsers: rolePerms.canManageUsers,
    overrides,
  };
}

/**
 * 檢查用戶是否有權限使用某個 skill
 */
function canUseSkill(permissions, skillName) {
  // admin 全部可用
  if (permissions.skills.includes('*')) return true;

  // 檢查角色權限
  if (permissions.skills.includes(skillName)) return true;

  // 檢查個人覆寫
  if (permissions.overrides[skillName] === true) return true;

  return false;
}

/**
 * 檢查用戶是否能存取某筆資料
 */
function canAccessData(permissions, dataOwnerId, currentUserId) {
  if (permissions.dataScope === 'all') return true;
  return dataOwnerId === currentUserId;
}

/**
 * 更新用戶活動時間 + profile
 */
async function touchUser(chatId, from) {
  const db = await mongo.getDb();
  const update = { $set: { lastActiveAt: new Date() } };
  if (from) {
    update.$set['profile.firstName'] = from.first_name || '';
    update.$set['profile.lastName'] = from.last_name || '';
    update.$set['profile.username'] = from.username || '';
  }
  await db.collection('users').updateOne({ chatId: Number(chatId) }, update);
}

/**
 * 審核用戶（核准/拒絕/封鎖）
 */
async function approveUser(chatId, action, role, approvedBy) {
  const db = await mongo.getDb();

  if (action === 'approve') {
    await db.collection('users').updateOne(
      { chatId: Number(chatId) },
      { $set: { status: 'active', role: role || 'user', approvedAt: new Date(), approvedBy } }
    );
    // 清快取
    _userCache.delete(chatId);
    return true;
  }

  if (action === 'block') {
    await db.collection('users').updateOne(
      { chatId: Number(chatId) },
      { $set: { status: 'blocked' } }
    );
    _userCache.delete(chatId);
    return true;
  }

  return false;
}

/**
 * 修改用戶角色
 */
async function setUserRole(chatId, newRole) {
  if (!ROLE_PERMISSIONS[newRole]) return false;
  const db = await mongo.getDb();
  await db.collection('users').updateOne(
    { chatId: Number(chatId) },
    { $set: { role: newRole } }
  );
  _userCache.delete(chatId);
  return true;
}

/**
 * 列出所有用戶
 */
async function listUsers(filter = {}) {
  const db = await mongo.getDb();
  return db.collection('users').find(filter).sort({ createdAt: -1 }).toArray();
}

/**
 * 清除用戶快取（角色變更後需要）
 */
function clearCache(chatId) {
  if (chatId) {
    _userCache.delete(chatId);
  } else {
    _userCache.clear();
  }
}

module.exports = {
  authenticate,
  getPermissions,
  canUseSkill,
  canAccessData,
  approveUser,
  setUserRole,
  listUsers,
  clearCache,
  ROLE_PERMISSIONS,
};
```

---

## 四、admin-agent.js — 用戶審核互動

**檔案**：`src/agents/admin-agent.js`

```javascript
/**
 * 穗鈅助手 — 管理員審核 Agent
 *
 * 新用戶註冊時推送通知給 admin，按按鈕審核。
 * callback_data 格式：admin:{action}:{chatId}:{role}
 *
 * @version 1.0.0
 */

const ism = require('../interactive-session');
const agentRegistry = require('../agent-registry');
const auth = require('../auth');
const config = require('../config');

const MESSAGES = {
  newUserNotify: (profile, chatId) => {
    const name = [profile.firstName, profile.lastName].filter(Boolean).join(' ') || '未知';
    const username = profile.username ? `@${profile.username}` : '無';
    return `👤 新用戶申請\n\n姓名：${name}\nUsername：${username}\nChat ID：${chatId}\n\n請選擇操作：`;
  },
  approved: (name, role) => `✅ 已核准「${name}」為 ${role}`,
  blocked: (name) => `🚫 已封鎖「${name}」`,
  userNotified: '已通知用戶。',
  pendingReply: '⏳ 您的帳號正在審核中，請稍候。',
  blockedReply: '',  // 不回覆
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

// ISM handler
const adminHandler = {
  ttl: 60 * 60 * 1000, // 1 小時（審核不急）

  async onStart({ session }) {
    return { text: '' };
  },

  async onCallback(session, action, payload, context) {
    const parts = payload.split(':');

    // approve:{chatId}:{role}
    if (action === 'approve') {
      const targetChatId = Number(parts[0]);
      const role = parts[1] || 'user';
      const roleName = role === 'advanced' ? '高級用戶' : '一般用戶';

      await auth.approveUser(targetChatId, 'approve', role, context.userId);

      return {
        text: MESSAGES.approved(session.data.userName || targetChatId, roleName),
        done: true,
        // 標記要通知被核准的用戶
        _notifyUser: { chatId: targetChatId, text: MESSAGES.welcomeAfterApproval },
      };
    }

    // block:{chatId}
    if (action === 'block') {
      const targetChatId = Number(parts[0]);

      await auth.approveUser(targetChatId, 'block', null, context.userId);

      return {
        text: MESSAGES.blocked(session.data.userName || targetChatId),
        done: true,
      };
    }

    return { text: '', done: true };
  },
};

ism.registerHandler('admin', adminHandler);

agentRegistry.register({
  name: 'admin',
  description: '管理員審核 agent — 新用戶核准/封鎖',
  systemPrompt: '',
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
    _userName: [profile.firstName, profile.lastName].filter(Boolean).join(' ') || '未知',
  };
}

module.exports = {
  MESSAGES,
  getNewUserNotification,
};
```

---

## 五、bot-server.js 改動

### 5.1 新增 require

```javascript
const auth = require('./auth');
const adminAgent = require('./agents/admin-agent');
```

### 5.2 message handler 加認證層

在 message handler 最前面（`bot.on('message', async (msg) => {` 之後），所有處理邏輯之前，加上認證檢查：

```javascript
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = `telegram:${chatId}`;
  const text = msg.text;

  // ======== 認證檢查 ========
  const authResult = await auth.authenticate(msg);

  // 新用戶 → 自動註冊 + 通知 admin
  if (authResult.status === 'new') {
    await bot.sendMessage(chatId, adminAgent.MESSAGES.pendingReply);
    // 通知 admin
    const notification = adminAgent.getNewUserNotification(authResult.user);
    const adminChatId = config.telegram.adminChatId;
    if (adminChatId) {
      await sendReply(bot, Number(adminChatId), notification.text, notification.reply_markup);
    }
    return;
  }

  // 審核中
  if (authResult.status === 'pending') {
    await bot.sendMessage(chatId, adminAgent.MESSAGES.pendingReply);
    return;
  }

  // 封鎖
  if (authResult.status === 'blocked') {
    return; // 不回覆
  }

  // ======== 以下是 active 用戶，正常處理 ========
  const currentUser = authResult.user;
  const permissions = authResult.permissions;

  // ... 現有的處理邏輯 ...
```

### 5.3 skill 呼叫前加權限檢查

在 tool-executor 呼叫前，或在 handleMessage 的 agent 迴圈裡，加權限檢查。

最簡單的做法是在 `tool-executor.js` 的 `execute()` 裡加一層：

```javascript
// tool-executor.js 的 execute() 開頭加上：
// 如果 context 裡帶了 permissions，檢查權限
if (context.permissions && !auth.canUseSkill(context.permissions, funcName)) {
  return {
    success: false,
    data: null,
    summary: `您沒有使用「${funcName}」的權限。`,
    skillName: funcName,
  };
}
```

然後 bot-server.js 裡呼叫 handleMessage 和 tool-executor 時，把 permissions 帶進 context：

```javascript
// handleMessage 呼叫
const result = await handleMessage(userId, text, chatId, permissions);

// tool-executor 呼叫（在 handleMessage 裡面）
const result = await toolExecutor.execute(toolCall, { userId, chatId, permissions });
```

### 5.4 關鍵詞攔截加權限檢查

現有的關鍵詞攔截（建單、同步產品等）加權限判斷：

```javascript
// 建立訂單關鍵詞
if (/建立訂單|建單|開單|下訂單/.test(text)) {
  if (!auth.canUseSkill(permissions, 'create-order')) {
    await sendReply(bot, chatId, '您沒有建立訂單的權限。');
    return;
  }
  // ... 現有邏輯 ...
}

// 同步產品
if (/同步產品|sync.?products?/i.test(text)) {
  if (!auth.canUseSkill(permissions, 'system-router')) {
    await sendReply(bot, chatId, '您沒有此操作的權限。');
    return;
  }
  // ... 現有邏輯 ...
}
```

### 5.5 Admin 用戶管理指令

在關鍵詞攔截區加上 admin 專用指令（只有 adminChatId 能觸發）：

```javascript
// ---- Admin 用戶管理指令（只有 admin 能用） ----
const isAdmin = chatId === Number(config.telegram.adminChatId);

if (isAdmin) {
  // 用戶列表
  if (/用戶列表|使用者列表|list.?users?/i.test(text)) {
    const users = await auth.listUsers();
    if (users.length === 0) {
      await sendReply(bot, chatId, '目前沒有用戶。');
      return;
    }
    const roleLabels = { admin: '👑管理員', advanced: '⭐高級', user: '👤一般' };
    const statusLabels = { active: '✅', pending: '⏳', blocked: '🚫' };
    const lines = users.map(u => {
      const name = [u.profile?.firstName, u.profile?.lastName].filter(Boolean).join(' ') || '未知';
      const username = u.profile?.username ? `@${u.profile.username}` : '';
      const role = roleLabels[u.role] || u.role;
      const status = statusLabels[u.status] || u.status;
      return `${status} ${name} ${username}\n   角色：${role} | ID：${u.chatId}`;
    }).join('\n\n');
    await sendReply(bot, chatId, `📋 用戶列表（${users.length} 人）：\n\n${lines}`);
    return;
  }

  // 升級用戶
  const upgradeMatch = text.match(/升級用戶\s*(.+)/);
  if (upgradeMatch) {
    const searchName = upgradeMatch[1].trim();
    const users = await auth.listUsers({ status: 'active' });
    const matches = users.filter(u => {
      const name = [u.profile?.firstName, u.profile?.lastName].filter(Boolean).join(' ');
      const username = u.profile?.username || '';
      return name.includes(searchName) || username.includes(searchName) || String(u.chatId) === searchName;
    });

    if (matches.length === 0) {
      await sendReply(bot, chatId, `找不到用戶「${searchName}」`);
      return;
    }
    if (matches.length > 1) {
      const list = matches.map(u => `${u.profile?.firstName || ''} (${u.chatId})`).join('\n');
      await sendReply(bot, chatId, `找到多位用戶，請用 Chat ID 指定：\n${list}`);
      return;
    }

    const target = matches[0];
    const targetName = [target.profile?.firstName, target.profile?.lastName].filter(Boolean).join(' ') || target.chatId;
    await sendReply(bot, chatId, `選擇「${targetName}」的新角色：`, {
      inline_keyboard: [
        [
          { text: '👤 一般用戶', callback_data: `admin:setrole:${target.chatId}:user` },
          { text: '⭐ 高級用戶', callback_data: `admin:setrole:${target.chatId}:advanced` },
        ],
        [
          { text: '👑 管理員', callback_data: `admin:setrole:${target.chatId}:admin` },
        ],
      ],
    });
    return;
  }

  // 封鎖用戶
  const blockMatch = text.match(/封鎖用戶\s*(.+)/);
  if (blockMatch) {
    const searchName = blockMatch[1].trim();
    const users = await auth.listUsers();
    const matches = users.filter(u => {
      const name = [u.profile?.firstName, u.profile?.lastName].filter(Boolean).join(' ');
      const username = u.profile?.username || '';
      return name.includes(searchName) || username.includes(searchName) || String(u.chatId) === searchName;
    });

    if (matches.length === 0) {
      await sendReply(bot, chatId, `找不到用戶「${searchName}」`);
      return;
    }
    if (matches.length === 1) {
      const target = matches[0];
      const targetName = [target.profile?.firstName, target.profile?.lastName].filter(Boolean).join(' ') || target.chatId;
      await auth.approveUser(target.chatId, 'block', null, userId);
      await sendReply(bot, chatId, `🚫 已封鎖「${targetName}」`);
      return;
    }
    const list = matches.map(u => `${u.profile?.firstName || ''} (${u.chatId})`).join('\n');
    await sendReply(bot, chatId, `找到多位用戶，請用 Chat ID 指定：\n${list}`);
    return;
  }

  // 解封用戶
  const unblockMatch = text.match(/解封用戶\s*(.+)/);
  if (unblockMatch) {
    const searchName = unblockMatch[1].trim();
    const users = await auth.listUsers({ status: 'blocked' });
    const matches = users.filter(u => {
      const name = [u.profile?.firstName, u.profile?.lastName].filter(Boolean).join(' ');
      const username = u.profile?.username || '';
      return name.includes(searchName) || username.includes(searchName) || String(u.chatId) === searchName;
    });

    if (matches.length === 0) {
      await sendReply(bot, chatId, `找不到已封鎖的用戶「${searchName}」`);
      return;
    }
    if (matches.length === 1) {
      const target = matches[0];
      const targetName = [target.profile?.firstName, target.profile?.lastName].filter(Boolean).join(' ') || target.chatId;
      await auth.approveUser(target.chatId, 'approve', target.role || 'user', userId);
      await sendReply(bot, chatId, `✅ 已解封「${targetName}」`);
      return;
    }
    const list = matches.map(u => `${u.profile?.firstName || ''} (${u.chatId})`).join('\n');
    await sendReply(bot, chatId, `找到多位用戶，請用 Chat ID 指定：\n${list}`);
    return;
  }
}
```

同時在 callback handler 的 `admin:` 分支裡加上 `setrole` 處理：

```javascript
// 在 admin callback handler 裡，approve 和 block 之後加上：
} else if (action === 'setrole') {
  const targetChatId = Number(parts[2]);
  const newRole = parts[3] || 'user';
  const roleLabels = { admin: '管理員', advanced: '高級用戶', user: '一般用戶' };
  await auth.setUserRole(targetChatId, newRole);
  await sendReply(bot, chatId, `✅ 已將 ${targetChatId} 角色改為「${roleLabels[newRole] || newRole}」`);
  // 通知被修改的用戶
  await bot.sendMessage(targetChatId, `📢 您的角色已更新為「${roleLabels[newRole] || newRole}」。`).catch(() => {});
}
```

### Admin 指令總覽

| 指令 | 說明 | 範例 |
|---|---|---|
| `用戶列表` | 列出所有用戶 + 角色 + 狀態 | `用戶列表` |
| `升級用戶 XXX` | 搜尋用戶 → 按鈕選角色 | `升級用戶 王大明` 或 `升級用戶 9912345678` |
| `封鎖用戶 XXX` | 封鎖用戶 | `封鎖用戶 @username` |
| `解封用戶 XXX` | 解除封鎖 | `解封用戶 王大明` |

只有 admin（你的 chatId）能觸發這些指令。其他人說「用戶列表」會被當成一般對話送給 LLM。

---

### 5.6 callback handler 加認證

callback handler 也要認證（防止 pending/blocked 用戶按舊按鈕）：

```javascript
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const userId = `telegram:${chatId}`;

  // ---- admin 審核的 callback（admin 自己按的，不需要檢查被審核者的狀態） ----
  if (data.startsWith('admin:')) {
    const adminChatId = Number(config.telegram.adminChatId);
    if (chatId !== adminChatId) {
      await bot.answerCallbackQuery(query.id, { text: '無權限' });
      return;
    }

    // 解析 admin:approve:12345:advanced 或 admin:block:12345
    const parts = data.split(':');
    const action = parts[1];
    const targetChatId = Number(parts[2]);
    const role = parts[3] || 'user';

    if (action === 'approve') {
      const roleName = role === 'advanced' ? '高級用戶' : '一般用戶';
      await auth.approveUser(targetChatId, 'approve', role, userId);
      await sendReply(bot, chatId, `✅ 已核准 ${targetChatId} 為${roleName}`);
      // 通知被核准的用戶
      await bot.sendMessage(targetChatId, '✅ 您的帳號已通過審核！現在可以開始使用穗鈅助手了。');
    } else if (action === 'block') {
      await auth.approveUser(targetChatId, 'block', null, userId);
      await sendReply(bot, chatId, `🚫 已封鎖 ${targetChatId}`);
    }

    try {
      await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id });
    } catch (_) {}
    await bot.answerCallbackQuery(query.id);
    return;
  }

  // ---- 一般 callback：檢查用戶狀態 ----
  // 這裡可以簡化為只查快取，不需要完整 authenticate
  // ... 現有的 ISM 處理 ...
```

### 5.7 文件處理加權限

```javascript
// 非文字訊息（PDF/圖片）加權限檢查
if (!text) {
  if (msg.document || msg.photo) {
    if (!auth.canUseSkill(permissions, 'create-order')) {
      // user 角色不能用文件建單，但可以讓 bot 知道收到了
      await bot.sendMessage(chatId, '您沒有文件建單的權限。');
      return;
    }
    // ... 現有的 doc-agent 處理 ...
  }
}
```

---

## 六、policy-engine.js 整合

在 `evaluate()` 裡加一層用戶權限檢查：

```javascript
// policy-engine.js 的 evaluate() 最前面加上：

// 第零層：用戶權限（如果有傳入 userPermissions）
if (options && options.userPermissions) {
  const auth = require('./auth');
  if (!auth.canUseSkill(options.userPermissions, skillName)) {
    return {
      action: 'deny',
      reason: `用戶角色「${options.userPermissions.role}」無權使用「${skillName}」`,
    };
  }
}
```

---

## 七、ensure-indexes.js 加 users 索引

```javascript
// users collection
await safeCreateIndexes(db.collection('users'), [
  { key: { chatId: 1 }, name: 'idx_chatId', unique: true },
  { key: { userId: 1 }, name: 'idx_userId', unique: true },
  { key: { status: 1 }, name: 'idx_status' },
  { key: { role: 1 }, name: 'idx_role' },
]);

// 確保 admin 用戶存在
if (appConfig.telegram.adminChatId) {
  await db.collection('users').updateOne(
    { chatId: Number(appConfig.telegram.adminChatId) },
    {
      $setOnInsert: {
        chatId: Number(appConfig.telegram.adminChatId),
        userId: `telegram:${appConfig.telegram.adminChatId}`,
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
  console.log('[ensure-indexes] ✅ admin 用戶已確認');
}
```

---

## 八、handleMessage 改動

`handleMessage` 函式簽名加 `permissions` 參數：

```javascript
// 原來
async function handleMessage(userId, userMessage, chatId) {

// 改為
async function handleMessage(userId, userMessage, chatId, permissions) {
```

在 agent 迴圈裡，tool-executor 呼叫時帶入 permissions：

```javascript
const result = await toolExecutor.execute(toolCall, { userId, chatId, permissions });
```

---

## 驗證

### 語法檢查

```bash
node -c src/auth.js && echo '✅ auth' || echo '❌'
node -c src/agents/admin-agent.js && echo '✅ admin-agent' || echo '❌'
node -c src/bot-server.js && echo '✅ bot-server' || echo '❌'
node -c src/policy-engine.js && echo '✅ policy-engine' || echo '❌'
node -c src/tool-executor.js && echo '✅ tool-executor' || echo '❌'
```

### 模組載入

```bash
node -e "
const auth = require('./src/auth');
console.log('authenticate:', typeof auth.authenticate === 'function' ? '✅' : '❌');
console.log('canUseSkill:', typeof auth.canUseSkill === 'function' ? '✅' : '❌');
console.log('approveUser:', typeof auth.approveUser === 'function' ? '✅' : '❌');
console.log('ROLE_PERMISSIONS:', Object.keys(auth.ROLE_PERMISSIONS).join(', '));
"
```

### admin 用戶確認

```bash
node scripts/ensure-indexes.js
# 確認輸出有 '✅ admin 用戶已確認'

node -e "
const mongo = require('./lib/mongodb-tools');
(async () => {
  const db = await mongo.getDb();
  const admin = await db.collection('users').findOne({ role: 'admin' });
  console.log('admin:', admin ? '✅ ' + admin.userId : '❌ 不存在');
  await mongo.close();
})();
"
```

### Telegram 測試

| # | 操作 | 預期 |
|---|------|------|
| **你（admin）** |||
| 1 | 你發任何訊息 | 正常使用，不受影響（admin 已在 DB） |
| 2 | 你建單、查信、設提醒 | 全部正常 |
| **新用戶** |||
| 3 | 用另一支手機（或請同事）私訊 bot | bot 回覆「審核中」 |
| 4 | 你收到審核通知 | 顯示新用戶資訊 + 核准按鈕 |
| 5 | 你按「核准（一般）」 | 對方收到「已通過審核」 |
| 6 | 對方發「你好」 | 正常對話 ✅ |
| 7 | 對方發「建立訂單」 | 回覆「您沒有建立訂單的權限」 ❌ |
| 8 | 對方發「提醒我明天開會」 | 正常設提醒 ✅ |
| **Admin 用戶管理指令** |||
| 9 | 你發「用戶列表」 | 列出所有用戶 + 角色 + 狀態 |
| 10 | 你發「升級用戶 王大明」 | 顯示角色選擇按鈕 |
| 11 | 按「⭐ 高級用戶」 | 用戶角色改為 advanced，對方收到通知 |
| 12 | 對方現在發「建立訂單」 | 正常建單 ✅（已升級為 advanced） |
| 13 | 你發「封鎖用戶 王大明」 | 用戶被封鎖 |
| 14 | 對方發訊息 | 不回覆 |
| 15 | 你發「解封用戶 王大明」 | 用戶解封 |
| 16 | 一般用戶發「用戶列表」 | 當成一般對話，不會觸發管理指令 |

---

## 注意事項

1. **你的現有資料不受影響**：你（admin）的 chatId 在 ensure-indexes 自動建立，所有現有的 memories、conversations、reminders 都帶了你的 userId，不需要遷移。
2. **快取機制**：auth.js 有 5 分鐘 TTL 快取，角色變更後用 `clearCache(chatId)` 清除。`approveUser` 和 `setUserRole` 裡已自動清除。
3. **admin 審核的 callback 不走 ISM**：直接在 callback handler 裡處理，因為審核按鈕是推給 admin 的獨立訊息，不需要 session 狀態。
4. **handleMessage 簽名改了**：要確保所有呼叫的地方都帶上 permissions 參數。
5. **向後相容**：如果 context 裡沒有 permissions（例如 scheduler 觸發的 skill），tool-executor 會跳過權限檢查，不會擋排程任務。
