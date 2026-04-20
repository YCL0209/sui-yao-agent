/**
 * 穗鈅助手 — 用戶認證與權限管理（Phase I1：多平台支援）
 *
 * 每次訊息進來時：
 * 1. 查 users collection（依 platform + chatId 複合 key），確認用戶存在且 active
 * 2. 不存在 → 自動註冊（pending）+ 通知 admin
 * 3. pending → 回覆「審核中」
 * 4. blocked → 不回覆
 * 5. active → 回傳用戶資訊和權限
 *
 * @version 2.0.0
 */

const mongo = require('../lib/mongodb-tools');

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

// 用戶快取（key = `${platform}:${chatId}`，TTL 5 分鐘）
const _userCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function makeUserId(platform, chatId) {
  return `${platform}:${chatId}`;
}

function cacheKey(platform, chatId) {
  return `${platform}:${chatId}`;
}

/**
 * 認證用戶：查詢或自動註冊
 *
 * @param {Object} args
 * @param {'telegram'|'discord'} args.platform
 * @param {string|number} args.chatId
 * @param {Object} [args.profile]  — { firstName, lastName, username, languageCode, discriminator, avatarUrl }
 * @returns {Promise<{ status, user, permissions?, chatId, platform }>}
 */
async function authenticate({ platform, chatId, profile = {} }) {
  if (!platform) throw new Error('auth.authenticate: platform required');
  if (chatId == null) throw new Error('auth.authenticate: chatId required');

  const chatIdStr = String(chatId);
  const key = cacheKey(platform, chatIdStr);

  // 快取檢查
  const cached = _userCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    touchUser(platform, chatIdStr).catch(() => {});
    return cached.result;
  }

  const db = await mongo.getDb();
  let user = await db.collection('users').findOne({ platform, chatId: chatIdStr });

  // 用戶不存在 → 自動註冊
  if (!user) {
    user = {
      platform,
      chatId: chatIdStr,
      userId: makeUserId(platform, chatIdStr),
      profile: {
        firstName:     profile.firstName     || '',
        lastName:      profile.lastName      || '',
        username:      profile.username      || '',
        languageCode:  profile.languageCode  || '',
        discriminator: profile.discriminator || '',
        avatarUrl:     profile.avatarUrl     || '',
      },
      role: 'user',
      status: 'pending',
      createdAt: new Date(),
      lastActiveAt: new Date(),
    };
    await db.collection('users').insertOne(user);

    const result = { status: 'new', user, chatId: chatIdStr, platform };
    _userCache.set(key, { result, ts: Date.now() });
    return result;
  }

  // pending → 等審核
  if (user.status === 'pending') {
    const result = { status: 'pending', user, chatId: chatIdStr, platform };
    _userCache.set(key, { result, ts: Date.now() });
    return result;
  }

  // blocked → 不回覆
  if (user.status === 'blocked') {
    const result = { status: 'blocked', user, chatId: chatIdStr, platform };
    _userCache.set(key, { result, ts: Date.now() });
    return result;
  }

  // active → 回傳權限
  const permissions = getPermissions(user);
  const result = { status: 'active', user, permissions, chatId: chatIdStr, platform };
  _userCache.set(key, { result, ts: Date.now() });

  // 更新 lastActiveAt + profile（fire-and-forget）
  touchUser(platform, chatIdStr, profile).catch(() => {});

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
  if (permissions.skills && permissions.skills.includes('*')) return true;
  if (permissions.skills && permissions.skills.includes(skillName)) return true;
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
async function touchUser(platform, chatId, profile) {
  const db = await mongo.getDb();
  const update = { $set: { lastActiveAt: new Date() } };
  if (profile && typeof profile === 'object') {
    if ('firstName'     in profile) update.$set['profile.firstName']     = profile.firstName     || '';
    if ('lastName'      in profile) update.$set['profile.lastName']      = profile.lastName      || '';
    if ('username'      in profile) update.$set['profile.username']      = profile.username      || '';
    if ('languageCode'  in profile) update.$set['profile.languageCode']  = profile.languageCode  || '';
    if ('discriminator' in profile) update.$set['profile.discriminator'] = profile.discriminator || '';
    if ('avatarUrl'     in profile) update.$set['profile.avatarUrl']     = profile.avatarUrl     || '';
  }
  await db.collection('users').updateOne(
    { platform, chatId: String(chatId) },
    update
  );
}

/**
 * 審核用戶（核准/封鎖）
 */
async function approveUser(platform, chatId, action, role, approvedBy) {
  const db = await mongo.getDb();
  const filter = { platform, chatId: String(chatId) };

  if (action === 'approve') {
    await db.collection('users').updateOne(
      filter,
      { $set: { status: 'active', role: role || 'user', approvedAt: new Date(), approvedBy } }
    );
    _userCache.delete(cacheKey(platform, chatId));
    return true;
  }

  if (action === 'block') {
    await db.collection('users').updateOne(
      filter,
      { $set: { status: 'blocked' } }
    );
    _userCache.delete(cacheKey(platform, chatId));
    return true;
  }

  return false;
}

/**
 * 修改用戶角色
 */
async function setUserRole(platform, chatId, newRole) {
  if (!ROLE_PERMISSIONS[newRole]) return false;
  const db = await mongo.getDb();
  await db.collection('users').updateOne(
    { platform, chatId: String(chatId) },
    { $set: { role: newRole } }
  );
  _userCache.delete(cacheKey(platform, chatId));
  return true;
}

/**
 * 列出所有用戶（filter 可帶 platform: 'telegram' 等條件）
 */
async function listUsers(filter = {}) {
  const db = await mongo.getDb();
  return db.collection('users').find(filter).sort({ createdAt: -1 }).toArray();
}

/**
 * 清除用戶快取（角色變更後需要）
 */
function clearCache(platform, chatId) {
  if (platform && chatId != null) {
    _userCache.delete(cacheKey(platform, chatId));
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
  touchUser,
  makeUserId,
  ROLE_PERMISSIONS,
};
