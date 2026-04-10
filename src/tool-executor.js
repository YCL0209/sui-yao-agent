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
const mongo = require('../lib/mongodb-tools');

// 快取已載入的 skills
let _skills = null;

// 執行後 hook（給 dashboard ws 推送用）
let _onExecute = null;
function setOnExecuteHook(fn) { _onExecute = fn; }

function getSkills() {
  if (!_skills) {
    const result = loadAllSkills();
    _skills = result.skills;
  }
  return _skills;
}

// ============================================================
// 結構化 Execution Log
// ============================================================

/**
 * 寫入結構化 execution log（fire-and-forget）
 * @param {Object} entry
 */
async function writeExecutionLog(entry) {
  const db = await mongo.getDb();
  await db.collection('execution_logs').insertOne({
    ...entry,
    timestamp: new Date(),
  });
}

/**
 * 清理 input 中的敏感資訊（避免 log 裡出現密碼、token 等）
 * @param {Object} args
 * @returns {Object} 清理後的 args
 */
function sanitizeInput(args) {
  if (!args || typeof args !== 'object') return args;
  const sanitized = { ...args };
  const sensitiveKeys = ['password', 'token', 'secret', 'apiKey', 'api_key'];
  for (const key of sensitiveKeys) {
    if (sanitized[key]) sanitized[key] = '***';
  }
  return sanitized;
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

  // 用戶權限檢查（如果 context 有帶 permissions；scheduler 等內部呼叫不帶 → 跳過）
  if (context.permissions) {
    const auth = require('./auth');
    if (!auth.canUseSkill(context.permissions, funcName)) {
      return {
        success: false,
        data: null,
        summary: `您沒有使用「${funcName}」的權限。`,
        skillName: funcName,
      };
    }
  }

  // 高風險操作檢查（程式碼層強制，不靠 prompt；確認後重新執行時跳過）
  if (context.permissions && !context._skipHighRisk) {
    const policyEngine = require('./policy-engine');
    const riskCheck = policyEngine.checkHighRisk(funcName, args);
    if (riskCheck.isHighRisk) {
      return {
        success: false,
        data: null,
        summary: `⚠️ 此操作為「${riskCheck.description}」，需要確認後才能執行。`,
        skillName: funcName,
        _requireConfirmation: true,
        _confirmData: {
          skill: funcName,
          args,
          description: riskCheck.description,
        },
      };
    }
  }

  const startMs = Date.now();
  const userId = context.userId || 'system';

  try {
    const result = await skill.run(args, { ...context, llm: require('./llm-adapter') });
    const durationMs = Date.now() - startMs;

    // 自動寫入 daily-log（人類可讀摘要）
    try {
      await dailyLog.appendLog(userId, {
        type: 'task',
        content: `執行 ${funcName}: ${result.summary || '完成'}`,
        relatedSkill: funcName,
      });
    } catch (logErr) {
      console.warn('[tool-executor] daily-log 寫入失敗:', logErr.message);
    }

    // 寫入 execution_logs（結構化紀錄，fire-and-forget）
    writeExecutionLog({
      userId,
      chatId: context.chatId || null,
      skill: funcName,
      input: sanitizeInput(args),
      output: {
        success: result.success !== false,
        summary: result.summary || '',
        hasData: !!result.data,
        hasReplyMarkup: !!result.reply_markup,
      },
      status: 'success',
      durationMs,
    }).catch(err => console.warn('[tool-executor] execution-log 寫入失敗:', err.message));

    // 通知 hook（dashboard ws 推送用）
    if (_onExecute) {
      try {
        _onExecute({
          skill: funcName,
          status: 'success',
          summary: result.summary || '',
          durationMs,
          userId,
          chatId: context.chatId || null,
        });
      } catch (_) {}
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
    try {
      await dailyLog.appendLog(userId, {
        type: 'event',
        content: `${funcName} 執行失敗: ${err.message}`,
        relatedSkill: funcName,
      });
    } catch (_) {
      // ignore log failure
    }

    // 寫入 execution_logs
    writeExecutionLog({
      userId,
      chatId: context.chatId || null,
      skill: funcName,
      input: sanitizeInput(args),
      output: null,
      status: 'error',
      error: err.message,
      durationMs,
    }).catch(logErr => console.warn('[tool-executor] execution-log 寫入失敗:', logErr.message));

    // 通知 hook（dashboard ws 推送用）
    if (_onExecute) {
      try {
        _onExecute({
          skill: funcName,
          status: 'error',
          error: err.message,
          durationMs,
          userId,
          chatId: context.chatId || null,
        });
      } catch (_) {}
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
  setOnExecuteHook,
};
