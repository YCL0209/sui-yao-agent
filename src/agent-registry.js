/**
 * 穗鈅助手 — Agent 定義註冊中心
 *
 * 管理所有子 agent 的定義，包含 system prompt、可用 skill、模型設定。
 * 其他模組透過 registry.get(name) 取得 agent 定義。
 *
 * @version 1.0.0
 */

// Agent 定義的資料結構（每個 agent 必須符合這個格式）：
//
// {
//   name: string,              — agent 識別名（唯一）
//   description: string,       — 簡短說明
//   systemPrompt: string,      — 這個 agent 的專屬 system prompt
//   allowedSkills: string[],   — 它能使用的 skill 名稱列表
//   model: string|null,        — 指定模型（null 則用 config.subAgent.defaultModel）
//   maxIterations: number|null,— 最大 tool calling 迴圈次數（null 則用 config 預設）
//   messages: Object|null,     — 面向用戶的文字模板（互動型 agent 用）
//   parsePrompt: string|null,  — LLM 解析用的 prompt（如訂單解析、文件解析）
//   verify: Function|null,     — 驗證函式 async (result, briefing) => { passed, checks }
// }

const _agents = new Map();

/**
 * 註冊一個 agent 定義
 * @param {Object} agentDef — 符合上述格式的 agent 定義
 * @throws {Error} 如果 name 重複或缺少必要欄位
 */
function register(agentDef) {
  // 驗證必要欄位
  if (!agentDef.name) throw new Error('Agent 定義缺少 name');
  if (!agentDef.systemPrompt) throw new Error(`Agent ${agentDef.name} 缺少 systemPrompt`);
  if (!agentDef.allowedSkills || !Array.isArray(agentDef.allowedSkills)) {
    throw new Error(`Agent ${agentDef.name} 缺少 allowedSkills 陣列`);
  }
  if (_agents.has(agentDef.name)) {
    throw new Error(`Agent ${agentDef.name} 已註冊，不可重複`);
  }

  _agents.set(agentDef.name, {
    name: agentDef.name,
    description: agentDef.description || '',
    systemPrompt: agentDef.systemPrompt,
    allowedSkills: agentDef.allowedSkills,
    model: agentDef.model || null,
    maxIterations: agentDef.maxIterations || null,
    messages: agentDef.messages || null,
    parsePrompt: agentDef.parsePrompt || null,
    verify: agentDef.verify || null,
  });
}

/**
 * 取得 agent 定義
 * @param {string} name
 * @returns {Object|null}
 */
function get(name) {
  return _agents.get(name) || null;
}

/**
 * 列出所有已註冊的 agent 名稱
 * @returns {string[]}
 */
function list() {
  return Array.from(_agents.keys());
}

/**
 * 取消註冊（主要用於測試）
 */
function unregister(name) {
  _agents.delete(name);
}

/**
 * 清空所有註冊（主要用於測試）
 */
function clear() {
  _agents.clear();
}

module.exports = { register, get, list, unregister, clear };
