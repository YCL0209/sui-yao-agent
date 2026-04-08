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
  if (!permissions) return false;
  // admin 全部可用
  if (permissions.skills && permissions.skills.includes('*')) return true;
  // 檢查角色權限
  if (permissions.skills && permissions.skills.includes(skillName)) return true;
  // 檢查個人覆寫
  if (permissions.overrides && permissions.overrides[skillName] === true) return true;
  return false;
}

/**
 * 檢查用戶是否能存取某筆資料
 */
function canAccessData(permissions, dataOwnerId, currentUserId) {
  if (!permissions) return false;
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
 * 審核用戶（核准/封鎖）
 */
async function approveUser(chatId, action, role, approvedBy) {
  const db = await mongo.getDb();

  if (action === 'approve') {
    await db.collection('users').updateOne(
      { chatId: Number(chatId) },
      { $set: { status: 'active', role: role || 'user', approvedAt: new Date(), approvedBy } }
    );
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
