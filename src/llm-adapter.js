/**
 * 穗鈅助手 — LLM 統一介面
 *
 * 支援 OpenAI API 和 Ollama API，統一 chat / embedding 呼叫方式。
 * Ollama 不支援 function calling 時自動降級為字串解析。
 *
 * 用法：
 *   const llm = require('./llm-adapter');
 *   const resp = await llm.chat({ model, messages, tools });
 *   const vec  = await llm.getEmbedding('文字');
 *
 * @version 1.0.0
 */

const config = require('./config');

// ============================================================
// 內部工具
// ============================================================

/**
 * 判斷是否為 Ollama 模型
 */
function isOllama(model) {
  return config.isOllamaModel(model);
}

/**
 * 解析 Ollama model name（去掉 ollama/ 前綴）
 */
function ollamaModelName(model) {
  return model.replace(/^ollama\//, '');
}

// ============================================================
// OpenAI Chat Completion
// ============================================================

async function openaiChat({ model, messages, tools, temperature }) {
  const body = {
    model,
    messages,
    temperature: temperature ?? 0.7,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.llm.openaiApiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${err}`);
  }

  const data = await res.json();
  const choice = data.choices[0];
  const msg = choice.message;

  return {
    content: msg.content || null,
    tool_calls: msg.tool_calls || null,
    role: msg.role,
    usage: data.usage,
    finish_reason: choice.finish_reason,
  };
}

// ============================================================
// Ollama Chat Completion
// ============================================================

async function ollamaChat({ model, messages, tools, temperature }) {
  const ollamaModel = model ? ollamaModelName(model) : config.ollama.chatModel;
  const baseUrl = config.ollama.baseUrl; // 已含 /v1

  // OpenAI 相容介面
  const body = {
    model: ollamaModel,
    messages,
    temperature: temperature ?? 0.7,
    stream: false,
  };

  // 只有當 tools 存在時才嘗試原生 function calling
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  console.log('[ollama] request model:', body.model, 'tools count:', body.tools?.length || 0);
  console.log('[ollama] request body tail:', JSON.stringify(body).slice(-500));

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ollama',  // Ollama 不需要真 key，但 header 要有
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ollama API ${res.status}: ${err}`);
  }

  const data = await res.json();
  const choice = data.choices[0];
  const msg = choice.message;
  console.log('[ollama] response finish_reason:', choice.finish_reason, 'has_tool_calls:', !!msg.tool_calls, 'content_preview:', (msg.content || '').substring(0, 200));

  // 如果有 tools 但 Ollama 沒回 tool_calls，嘗試字串解析降級
  if (tools && tools.length > 0 && !msg.tool_calls && msg.content) {
    const parsed = parseCommandFromText(msg.content, tools);
    if (parsed) {
      return {
        content: null,
        tool_calls: [{
          id: `fallback_${Date.now()}`,
          type: 'function',
          function: parsed,
        }],
        role: 'assistant',
        usage: data.usage || null,
        finish_reason: 'tool_calls',
        _fallback: true,
      };
    }
  }

  return {
    content: msg.content || null,
    tool_calls: msg.tool_calls || null,
    role: msg.role,
    usage: data.usage || null,
    finish_reason: choice.finish_reason,
  };
}

// ============================================================
// Ollama Function Calling 降級：字串解析
// ============================================================

/**
 * 從 LLM 的文字回覆中解析命令意圖
 *
 * 支援格式：
 *   命令: check-email
 *   命令: set-reminder {"content":"開會","remindAt":"2026-03-25T09:00"}
 *   COMMAND: check-email
 *   /check-email
 *   /check-email {"content":"..."}
 *
 * @param {string} text - LLM 回覆文字
 * @param {Array} [tools] - 可用的 tools 定義（用於驗證 name 是否合法）
 * @returns {{ name: string, arguments: string } | null}
 */
function parseCommandFromText(text, tools) {
  if (!text) return null;

  // 模式 1: 命令: skill-name {...}
  const cmdMatch = text.match(/(?:命令|COMMAND|command)[:：]\s*(\S+)(?:\s+(.+))?/i);
  if (cmdMatch) {
    const name = cmdMatch[1].trim();
    const argsStr = cmdMatch[2]?.trim() || '{}';
    if (isValidToolName(name, tools)) {
      return { name, arguments: tryParseJson(argsStr) };
    }
  }

  // 模式 2: /skill-name {...}
  const slashMatch = text.match(/\/(\S+)(?:\s+(.+))?/);
  if (slashMatch) {
    const name = slashMatch[1].trim();
    const argsStr = slashMatch[2]?.trim() || '{}';
    if (isValidToolName(name, tools)) {
      return { name, arguments: tryParseJson(argsStr) };
    }
  }

  // 模式 3: JSON 格式 {"name":"...","arguments":...}
  const jsonMatch = text.match(/\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (obj.name && isValidToolName(obj.name, tools)) {
        const args = typeof obj.arguments === 'string' ? obj.arguments : JSON.stringify(obj.arguments || {});
        return { name: obj.name, arguments: args };
      }
    } catch (_) {
      // JSON parse failed, continue
    }
  }

  return null;
}

function isValidToolName(name, tools) {
  if (!tools || tools.length === 0) return true; // 沒有 tools 定義時不驗證
  return tools.some(t => {
    const toolName = t.function?.name || t.name;
    return toolName === name;
  });
}

function tryParseJson(str) {
  try {
    JSON.parse(str);
    return str;
  } catch {
    return '{}';
  }
}

// ============================================================
// 統一 Chat 介面
// ============================================================

/**
 * 判斷錯誤是否可以 fallback（連線失敗、5xx、rate limit）
 */
function isFallbackableError(err) {
  const msg = err.message || '';
  if (msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT')) return true;
  if (/\b5\d{2}\b/.test(msg)) return true;  // 5xx
  if (msg.includes('rate_limit') || msg.includes('429')) return true;
  return false;
}

/**
 * 統一 Chat Completion 呼叫
 *
 * 根據 CHAT_PROVIDER 決定主要 provider，失敗時自動 fallback。
 * 若 model 明確指定 ollama/ 前綴，強制走 Ollama。
 *
 * @param {Object} options
 * @param {string} [options.model] - 模型名稱（預設依 provider 決定）
 * @param {Array} options.messages - OpenAI 格式 messages
 * @param {Array} [options.tools] - function calling tools 定義
 * @param {number} [options.temperature] - 溫度（預設 0.7）
 * @returns {Promise<{ content, tool_calls, role, usage, finish_reason }>}
 */
async function chat(options) {
  const explicitModel = options.model;

  // 明確指定 ollama/ 前綴 → 強制走 Ollama，不 fallback
  if (explicitModel && isOllama(explicitModel)) {
    return ollamaChat({ ...options, model: explicitModel });
  }

  const provider = config.llm.chatProvider;

  // 根據 provider 決定模型名稱
  const model = provider === 'ollama'
    ? config.ollama.chatModel                          // qwen2.5:7b
    : (explicitModel || config.llm.defaultModel);      // gpt-4o-mini

  const primary = provider === 'ollama' ? ollamaChat : openaiChat;
  const fallback = provider === 'ollama' ? openaiChat : ollamaChat;
  const primaryLabel = provider === 'ollama' ? 'Ollama' : 'OpenAI';
  const fallbackLabel = provider === 'ollama' ? 'OpenAI' : 'Ollama';

  try {
    return await primary({ ...options, model });
  } catch (err) {
    if (isFallbackableError(err)) {
      // fallback 用對方的預設模型
      const fallbackModel = provider === 'ollama'
        ? config.llm.defaultModel
        : config.ollama.chatModel;
      console.warn(`[llm-adapter] ${primaryLabel} 呼叫失敗 (${err.message})，fallback 到 ${fallbackLabel} (${fallbackModel})`);
      return fallback({ ...options, model: fallbackModel });
    }
    throw err; // 非 fallback 類錯誤（如 400 參數錯誤），直接拋出
  }
}

// ============================================================
// Embedding API
// ============================================================

/**
 * 取得文字的 embedding 向量
 *
 * @param {string} text - 要 embed 的文字
 * @param {Object} [options]
 * @param {string} [options.provider] - 'openai' 或 'ollama'（預設 config.embedding.provider）
 * @returns {Promise<number[]>} - embedding 向量
 */
async function getEmbedding(text, options = {}) {
  const provider = options.provider || config.llm.embedProvider;

  if (provider === 'ollama') {
    return ollamaEmbedding(text);
  }

  return openaiEmbedding(text);
}

async function openaiEmbedding(text) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.llm.openaiApiKey}`,
    },
    body: JSON.stringify({
      model: config.embedding.model,
      input: text,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI Embedding API ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.data[0].embedding;
}

async function ollamaEmbedding(text) {
  // baseUrl 已含 /v1，embedding 要用原生 API（去掉 /v1）
  const ollamaBase = config.ollama.baseUrl.replace(/\/v1\/?$/, '');
  const res = await fetch(`${ollamaBase}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.embedding.ollamaModel,
      prompt: text,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Ollama Embedding API ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.embedding;
}

// ============================================================
// Export
// ============================================================

module.exports = {
  chat,
  getEmbedding,
  parseCommandFromText,
};
