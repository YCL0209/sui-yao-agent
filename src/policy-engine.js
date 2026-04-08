/**
 * 穗鈅助手 — Policy Engine
 *
 * 在 skill 執行前做 deterministic 檢查。
 * 三層檢查：角色權限 → 風險等級 → 任務範圍。
 * 結果只有三種：allow / deny / require_confirmation。
 *
 * @version 1.0.0
 */

// 高風險 skill — 子 agent 不能自行執行，需回報主 agent
const DANGEROUS_SKILLS = new Set([
  // 先放這些，之後隨時可以加
]);

// 需要用戶確認的 skill — 子 agent 可以執行，但要先問用戶
const CONFIRM_REQUIRED_SKILLS = new Set([
  'create-order',      // 建單前確認
]);

/**
 * 檢查 skill 是否允許執行
 *
 * @param {string} skillName — 要執行的 skill 名稱
 * @param {Object} agentDef — agent 定義（從 agent-registry 取得）
 * @param {Object} [briefing] — 子任務的 briefing（可選，用於任務範圍檢查）
 * @param {Object} [userPermissions] — 用戶權限物件（auth.getPermissions 回傳）
 * @returns {{ action: 'allow'|'deny'|'require_confirmation', reason: string }}
 */
function evaluate(skillName, agentDef, briefing = null, userPermissions = null) {
  // 第零層：用戶權限（如果有傳入 userPermissions）
  if (userPermissions) {
    const auth = require('./auth');
    if (!auth.canUseSkill(userPermissions, skillName)) {
      return {
        action: 'deny',
        reason: `用戶角色「${userPermissions.role}」無權使用「${skillName}」`,
      };
    }
  }

  // 第一層：角色權限
  if (!agentDef.allowedSkills.includes(skillName)) {
    return {
      action: 'deny',
      reason: `Agent「${agentDef.name}」無權使用 skill「${skillName}」`,
    };
  }

  // 第二層：風險等級
  if (DANGEROUS_SKILLS.has(skillName)) {
    return {
      action: 'deny',
      reason: `Skill「${skillName}」為高風險操作，需主 agent 處理`,
    };
  }

  if (CONFIRM_REQUIRED_SKILLS.has(skillName)) {
    return {
      action: 'require_confirmation',
      reason: `Skill「${skillName}」需要用戶確認後才能執行`,
    };
  }

  // 第三層：任務範圍（如果 briefing 有指定限制）
  if (briefing && briefing.constraints) {
    // 檢查 briefing.constraints 裡是否有 blockedSkills
    if (briefing.blockedSkills && briefing.blockedSkills.includes(skillName)) {
      return {
        action: 'deny',
        reason: `本次任務明確禁止使用「${skillName}」`,
      };
    }
  }

  return { action: 'allow', reason: '' };
}

/**
 * 新增高風險 skill（動態配置）
 */
function addDangerousSkill(skillName) {
  DANGEROUS_SKILLS.add(skillName);
}

/**
 * 新增需確認 skill（動態配置）
 */
function addConfirmRequiredSkill(skillName) {
  CONFIRM_REQUIRED_SKILLS.add(skillName);
}

/**
 * 查詢某 skill 的風險等級
 * @returns {'safe'|'confirm'|'dangerous'}
 */
function getRiskLevel(skillName) {
  if (DANGEROUS_SKILLS.has(skillName)) return 'dangerous';
  if (CONFIRM_REQUIRED_SKILLS.has(skillName)) return 'confirm';
  return 'safe';
}

module.exports = { evaluate, addDangerousSkill, addConfirmRequiredSkill, getRiskLevel };
