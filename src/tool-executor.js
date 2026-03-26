/**
 * 穗鈅助手 — Tool Calling 執行器
 *
 * 接收 LLM 的 tool_call，執行對應 skill，自動寫入 daily-log。
 * 支援強模型（直接指定 skill）和弱模型（透過 system-router 分派）。
 *
 * @version 1.0.0
 */

const config = require('./config');
const dailyLog = require('./daily-log');
const { loadAllSkills } = require('./skill-loader');

// 快取已載入的 skills
let _skills = null;

function getSkills() {
  if (!_skills) {
    const result = loadAllSkills();
    _skills = result.skills;
  }
  return _skills;
}

// ============================================================
// 執行 Tool Call
// ============================================================

/**
 * 執行一個 tool_call
 *
 * @param {Object} toolCall - LLM 回傳的 tool_call
 *   { id, type, function: { name, arguments } }
 * @param {Object} [context] - 執行上下文 { userId, sessionId, ... }
 * @returns {Promise<{ success, data, summary, skillName }>}
 */
async function execute(toolCall, context = {}) {
  const funcName = toolCall.function?.name || toolCall.name;
  const argsStr = toolCall.function?.arguments || toolCall.arguments || '{}';

  let args;
  try {
    args = typeof argsStr === 'string' ? JSON.parse(argsStr) : argsStr;
  } catch {
    return {
      success: false,
      data: null,
      summary: `參數解析失敗: ${argsStr}`,
      skillName: funcName,
    };
  }

  const skills = getSkills();
  const skill = skills[funcName];

  if (!skill) {
    return {
      success: false,
      data: null,
      summary: `找不到 skill: ${funcName}`,
      skillName: funcName,
    };
  }

  const startMs = Date.now();

  try {
    const result = await skill.run(args, { ...context, llm: require('./llm-adapter') });
    const durationMs = Date.now() - startMs;

    // 自動寫入 daily-log
    const userId = context.userId || 'system';
    try {
      await dailyLog.appendLog(userId, {
        type: 'task',
        content: `執行 ${funcName}: ${result.summary || '完成'}`,
        relatedSkill: funcName,
      });
    } catch (logErr) {
      console.warn('[tool-executor] daily-log 寫入失敗:', logErr.message);
    }

    return {
      success: result.success !== false,
      data: result.data,
      summary: result.summary || '',
      reply_markup: result.reply_markup || null,
      localPaths: result.localPaths || null,
      skillName: funcName,
      durationMs,
    };

  } catch (err) {
    const durationMs = Date.now() - startMs;

    // 錯誤也寫入 daily-log
    const userId = context.userId || 'system';
    try {
      await dailyLog.appendLog(userId, {
        type: 'event',
        content: `${funcName} 執行失敗: ${err.message}`,
        relatedSkill: funcName,
      });
    } catch (_) {
      // ignore log failure
    }

    return {
      success: false,
      data: null,
      summary: `執行失敗: ${err.message}`,
      skillName: funcName,
      durationMs,
    };
  }
}

/**
 * 重設 skills 快取（新增 skill 後需要重載）
 */
function resetCache() {
  _skills = null;
}

// ============================================================
// Export
// ============================================================

module.exports = {
  execute,
  getSkills,
  resetCache,
};
