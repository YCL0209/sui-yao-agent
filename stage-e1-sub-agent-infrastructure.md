# 階段 E1：子 Agent 基礎設施

> 穗鈅助手已完成 Phase 1~5 + 階段 A~D（bug 修復、部署、建單互動、RAG 品項系統）。
> 本階段建立子 agent 架構的底層基礎設施，**不動現有功能**，純新增模組。
> 完成後進入 E2（主 Agent 改造）和 E3（訂單 Agent 拆分）。

---

## 專案位置

```
~/sui-yao-agent/
├── src/
│   ├── bot-server.js              # 現有，本階段不動
│   ├── tool-executor.js           # 現有，本階段不動
│   ├── skill-loader.js            # 現有，本階段不動
│   ├── session.js                 # 現有，本階段不動
│   ├── config.js                  # 修改：新增 subAgent 設定區塊
│   ├── sub-agent-executor.js      # ⚡ 新建：子 agent 執行引擎
│   ├── policy-engine.js           # ⚡ 新建：權限 + 風險檢查
│   ├── interactive-session.js     # ⚡ 新建：通用多步驟互動管理
│   └── agent-registry.js          # ⚡ 新建：agent 定義註冊中心
├── skills/                        # 現有，本階段不動
├── lib/mongodb-tools/             # 現有
└── .env                           # 不動
```

---

## 設計原則（Claude Code 必讀）

1. **Agent 管決策和互動，Skill 管執行邏輯** — Agent 決定「什麼時候做什麼」，Skill 負責「怎麼做」。Skill 裡不能有面向用戶的文字。
2. **確定性規則不靠 prompt** — 權限檢查、風險攔截、操作限制全部由 policy-engine 在程式碼層保證，不寫在 system prompt 裡。
3. **子 agent 的 context 與主 agent 隔離** — 子 agent 有自己的 system prompt、messages、tool 列表，不繼承主 agent 的對話歷史。
4. **主 agent 只看結果，不看過程** — 子 agent 的完整 LLM 對話記錄存在 sub_tasks.execution_context 裡，主 agent 只讀 sub_tasks.result。
5. **所有模組都是可獨立測試的** — 每個新檔案 export 清晰的函式，不依賴 Telegram bot instance。

---

## 本階段任務（5 項）

---

### E1.1：config.js 新增 subAgent 設定

**檔案**：`src/config.js`

**在 config 物件裡新增 subAgent 區塊**（加在 `agent` 區塊下面）：

```javascript
// 子 Agent 系統
subAgent: {
  maxIterations:  parseInt(process.env.SUB_AGENT_MAX_ITERATIONS)  || 5,
  defaultTimeout: parseInt(process.env.SUB_AGENT_DEFAULT_TIMEOUT) || 30000,
  defaultModel:   process.env.SUB_AGENT_DEFAULT_MODEL              || process.env.DEFAULT_MODEL || 'gpt-4o-mini',
},
```

不需要在 `.env` 裡加新變數，用預設值就好。之後需要時再加。

---

### E1.2：agent-registry.js — Agent 定義註冊中心

**檔案**：`src/agent-registry.js`

**職責**：管理所有 agent 的定義（system prompt、可用 skill、模型、風險等級等），提供註冊和查詢介面。

**完整規格**：

```javascript
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
```

---

### E1.3：policy-engine.js — 權限與風險檢查

**檔案**：`src/policy-engine.js`

**職責**：在子 agent 呼叫 skill 之前，做三層 deterministic 檢查：
1. 角色權限：這個 agent 能不能用這個 skill
2. 風險等級：這個 skill 是安全 / 需確認 / 禁止
3. 任務範圍：briefing 裡有沒有額外限制

**完整規格**：

```javascript
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
 * @returns {{ action: 'allow'|'deny'|'require_confirmation', reason: string }}
 */
function evaluate(skillName, agentDef, briefing = null) {
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
```

---

### E1.4：sub-agent-executor.js — 子 Agent 執行引擎

**檔案**：`src/sub-agent-executor.js`

**職責**：這是子 agent 架構的核心。接收結構化 briefing，組裝獨立 context，跑 LLM + tool calling 迴圈，寫入 execution log，驗證結果，回傳結構化 result。

**它跟現有 bot-server.js 的 handleMessage() 的差異**：
- handleMessage 的 context 來自用戶對話歷史 + 全域 system prompt
- sub-agent-executor 的 context 來自 agent 定義的 systemPrompt + briefing，完全獨立
- sub-agent-executor 只暴露 briefing 裡指定的 skill，不是所有 skill
- sub-agent-executor 每次 skill 呼叫前過 policy-engine
- sub-agent-executor 結束後跑 verify hook 並寫入 MongoDB

**完整規格**：

```javascript
/**
 * 穗鈅助手 — Sub-Agent 執行引擎
 *
 * 核心模組：接收 briefing，在隔離 context 中執行子 agent。
 *
 * 流程：
 *   1. 從 agent-registry 取得 agent 定義
 *   2. 組裝獨立的 messages（agent systemPrompt + briefing）
 *   3. 只載入 agent 被允許的 skill definitions
 *   4. 跑 LLM + tool calling 迴圈
 *   5. 每次 tool call 前過 policy-engine
 *   6. 結束後跑 verify hook
 *   7. 寫入 MongoDB sub_tasks
 *   8. 回傳結構化 result
 *
 * @version 1.0.0
 */

const config = require('./config');
const llm = require('./llm-adapter');
const { loadAllSkills } = require('./skill-loader');
const agentRegistry = require('./agent-registry');
const policyEngine = require('./policy-engine');
const mongo = require('../lib/mongodb-tools');

/**
 * 執行子 agent
 *
 * @param {Object} options
 * @param {string} options.agentName — agent 名稱（必須已在 registry 註冊）
 * @param {Object} options.briefing — 結構化任務描述
 * @param {string} options.briefing.goal — 任務目標（自然語言）
 * @param {string[]} [options.briefing.constraints] — 限制條件
 * @param {Object} [options.briefing.data] — 傳入的資料
 * @param {string[]} [options.briefing.blockedSkills] — 本次任務禁用的 skill
 * @param {Object} [options.context] — 上層 context（userId、chatId 等）
 * @param {string} [options.parentTaskId] — 父任務 ID（用於關聯）
 * @returns {Promise<Object>} — { status, summary, data, artifacts, verification, subTaskId }
 */
async function execute({ agentName, briefing, context = {}, parentTaskId = null }) {
  const startTime = Date.now();

  // 1. 取得 agent 定義
  const agentDef = agentRegistry.get(agentName);
  if (!agentDef) {
    return {
      status: 'failed',
      summary: `找不到 agent 定義：${agentName}`,
      data: null,
      verification: null,
      subTaskId: null,
    };
  }

  // 2. 寫入 sub_tasks（狀態：in_progress）
  const db = await mongo.getDb();
  const subTaskDoc = {
    parentTaskId,
    assignedAgent: agentName,
    briefing,
    context: { userId: context.userId, chatId: context.chatId },
    status: 'in_progress',
    result: null,
    executionContext: {
      skillCalls: [],
      llmTurns: 0,
      errors: [],
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const insertResult = await db.collection('sub_tasks').insertOne(subTaskDoc);
  const subTaskId = insertResult.insertedId.toString();

  // 3. 載入此 agent 被允許的 skill definitions
  const { skills, definitions: allDefs } = loadAllSkills();
  const allowedDefs = allDefs.filter(d =>
    agentDef.allowedSkills.includes(d.function.name)
  );

  // 4. 組裝獨立 messages
  const model = agentDef.model || config.subAgent.defaultModel;
  const maxIter = agentDef.maxIterations || config.subAgent.maxIterations;

  const briefingText = formatBriefing(briefing);
  let messages = [
    { role: 'system', content: agentDef.systemPrompt },
    { role: 'user', content: briefingText },
  ];

  // 5. LLM + tool calling 迴圈
  let finalResult = null;

  for (let i = 0; i < maxIter; i++) {
    let response;
    try {
      response = await llm.chat({
        model,
        messages,
        tools: allowedDefs.length > 0 ? allowedDefs : undefined,
      });
    } catch (err) {
      await updateSubTask(db, subTaskId, {
        status: 'failed',
        'executionContext.errors': [{ turn: i, error: err.message }],
      });
      return {
        status: 'failed',
        summary: `LLM 呼叫失敗：${err.message}`,
        data: null,
        verification: null,
        subTaskId,
      };
    }

    // 更新 LLM 輪數
    await db.collection('sub_tasks').updateOne(
      { _id: insertResult.insertedId },
      { $inc: { 'executionContext.llmTurns': 1 } }
    );

    // 無 tool_call → agent 已回覆，迴圈結束
    if (!response.tool_calls || response.tool_calls.length === 0) {
      finalResult = {
        content: response.content || '',
      };
      break;
    }

    // 有 tool_call → 執行
    messages.push({
      role: 'assistant',
      content: response.content || null,
      tool_calls: response.tool_calls,
    });

    for (const toolCall of response.tool_calls) {
      const funcName = toolCall.function?.name || 'unknown';
      const argsStr = toolCall.function?.arguments || '{}';
      let args;
      try {
        args = JSON.parse(argsStr);
      } catch {
        args = {};
      }

      // Policy 檢查
      const policy = policyEngine.evaluate(funcName, agentDef, briefing);

      if (policy.action === 'deny') {
        // 被拒絕 → 告訴 LLM 這個 skill 不能用
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            success: false,
            summary: `操作被拒絕：${policy.reason}`,
          }),
        });

        // 記錄
        await db.collection('sub_tasks').updateOne(
          { _id: insertResult.insertedId },
          { $push: { 'executionContext.skillCalls': {
            skill: funcName, input: args, output: null,
            policyAction: 'deny', policyReason: policy.reason,
            timestamp: new Date(),
          }}}
        );
        continue;
      }

      // 執行 skill
      const skill = skills[funcName];
      let skillResult;
      const skillStart = Date.now();

      try {
        skillResult = await skill.run(args, { ...context, llm });
      } catch (err) {
        skillResult = { success: false, summary: `執行失敗：${err.message}` };
      }

      const skillDuration = Date.now() - skillStart;

      // 記錄 skill 呼叫
      await db.collection('sub_tasks').updateOne(
        { _id: insertResult.insertedId },
        { $push: { 'executionContext.skillCalls': {
          skill: funcName,
          input: args,
          output: { success: skillResult.success, summary: skillResult.summary },
          policyAction: policy.action,
          durationMs: skillDuration,
          timestamp: new Date(),
        }}}
      );

      // 回傳結果給 LLM
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          success: skillResult.success !== false,
          summary: skillResult.summary || '',
          data: typeof skillResult.data === 'string' ? skillResult.data : skillResult.summary,
        }),
      });
    }

    // 最後一輪強制結束
    if (i === maxIter - 1) {
      const forcedResponse = await llm.chat({ model, messages });
      finalResult = { content: forcedResponse.content || '（子任務達到迴圈上限）' };
    }
  }

  // 6. 解析最終結果
  const content = finalResult?.content || '';
  const summary = content.length > 500 ? content.substring(0, 500) + '...' : content;

  // 7. Verify hook
  let verification = null;
  if (agentDef.verify) {
    try {
      verification = await agentDef.verify(finalResult, briefing);
    } catch (err) {
      verification = { passed: false, error: err.message, checks: [] };
    }
  }

  // 8. 更新 sub_tasks
  const totalDuration = Date.now() - startTime;
  await updateSubTask(db, subTaskId, {
    status: verification ? (verification.passed ? 'completed' : 'needs_review') : 'completed',
    result: {
      summary,
      content,
      verification,
    },
    durationMs: totalDuration,
    updatedAt: new Date(),
  });

  return {
    status: verification ? (verification.passed ? 'completed' : 'needs_review') : 'completed',
    summary,
    data: finalResult,
    verification,
    subTaskId,
  };
}

// ========================================
// 輔助函式
// ========================================

/**
 * 將 briefing 物件格式化為自然語言（給 LLM 讀）
 */
function formatBriefing(briefing) {
  const parts = [];

  parts.push(`## 任務目標\n${briefing.goal}`);

  if (briefing.constraints && briefing.constraints.length > 0) {
    parts.push(`## 限制條件\n${briefing.constraints.map(c => `- ${c}`).join('\n')}`);
  }

  if (briefing.data) {
    parts.push(`## 輸入資料\n\`\`\`json\n${JSON.stringify(briefing.data, null, 2)}\n\`\`\``);
  }

  parts.push('\n請根據以上任務目標和限制，使用可用的工具完成任務。完成後回覆結果摘要。');

  return parts.join('\n\n');
}

/**
 * 更新 sub_task 文件
 */
async function updateSubTask(db, subTaskId, updates) {
  const { ObjectId } = require('mongodb');
  await db.collection('sub_tasks').updateOne(
    { _id: new ObjectId(subTaskId) },
    { $set: updates }
  );
}

module.exports = { execute, formatBriefing };
```

---

### E1.5：interactive-session.js — 通用多步驟互動管理

**檔案**：`src/interactive-session.js`

**職責**：取代現在 create-order 裡的 `orderSessions` Map。所有需要按鈕互動的功能都透過它管理 session 生命週期。

**它跟現在 create-order 的 orderSessions 差異**：
- orderSessions 是專屬 create-order 的 Map，只有建單能用
- InteractiveSessionManager 是通用的，任何 agent 都可以註冊
- callback_query 路由從硬寫 `order_` 前綴變成自動依 agentName 分發

**完整規格**：

```javascript
/**
 * 穗鈅助手 — 通用多步驟互動 Session 管理
 *
 * 任何需要 Telegram inline button 互動的功能都用這個模組。
 * Agent 透過 registerHandler 註冊自己的互動邏輯，
 * bot-server 透過 handleCallback / handleTextInput 統一分發。
 *
 * callback_data 格式約定：{agentName}:{action}:{payload}
 * 例如：order:type:sales, order:confirm, doc:retry
 *
 * @version 1.0.0
 */

const config = require('./config');

const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 分鐘

// 已註冊的 agent handler
// { [agentName]: { onStart, onCallback, onTextInput, onTimeout, ttl } }
const _handlers = new Map();

// 活躍的 sessions
// key: chatId (number or string)
// value: { id, agentName, chatId, userId, step, data, createdAt, updatedAt, ttl }
const _sessions = new Map();

// ========================================
// 註冊
// ========================================

/**
 * 註冊一個 agent 的互動 handler
 *
 * @param {string} agentName — agent 名稱（必須唯一，用於 callback_data 前綴）
 * @param {Object} handler
 * @param {Function} handler.onStart(context) — 開始互動時呼叫，回傳 { text, reply_markup }
 * @param {Function} handler.onCallback(session, action, payload, context) — 按鈕回調
 * @param {Function} [handler.onTextInput(session, text, context)] — 用戶打字時
 * @param {Function} [handler.onTimeout(session)] — 超時清理
 * @param {number} [handler.ttl] — 存活時間 ms（預設 10 分鐘）
 */
function registerHandler(agentName, handler) {
  if (!handler.onStart || !handler.onCallback) {
    throw new Error(`Agent「${agentName}」的 handler 缺少 onStart 或 onCallback`);
  }
  _handlers.set(agentName, {
    onStart: handler.onStart,
    onCallback: handler.onCallback,
    onTextInput: handler.onTextInput || null,
    onTimeout: handler.onTimeout || null,
    ttl: handler.ttl || SESSION_TIMEOUT_MS,
  });
}

// ========================================
// Session 生命週期
// ========================================

/**
 * 開始一個新的互動 session
 *
 * @param {string} agentName
 * @param {Object} params
 * @param {string|number} params.chatId
 * @param {string} params.userId
 * @param {Object} [params.initialData] — 初始資料
 * @returns {Promise<Object>} — onStart 的回傳值（text + reply_markup）
 */
async function startSession(agentName, { chatId, userId, initialData = {} }) {
  const handler = _handlers.get(agentName);
  if (!handler) {
    throw new Error(`找不到 agent handler：${agentName}`);
  }

  // 如果同一個 chatId 有進行中的 session，先清除
  if (_sessions.has(chatId)) {
    const oldSession = _sessions.get(chatId);
    const oldHandler = _handlers.get(oldSession.agentName);
    if (oldHandler && oldHandler.onTimeout) {
      try { await oldHandler.onTimeout(oldSession); } catch (_) {}
    }
  }

  const sess = {
    id: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    agentName,
    chatId,
    userId,
    step: 'start',
    data: { ...initialData },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ttl: handler.ttl,
  };
  _sessions.set(chatId, sess);

  // 呼叫 handler 的 onStart
  const result = await handler.onStart({
    session: sess,
    userId,
    chatId,
  });

  return result;
}

/**
 * 處理 callback_query
 *
 * @param {string} callbackData — Telegram callback_data，格式：{agentName}:{action}:{payload}
 * @param {Object} params — { chatId, userId, messageId }
 * @returns {Promise<Object|null>} — handler 的回傳值，或 null（無對應 session）
 */
async function handleCallback(callbackData, { chatId, userId, messageId }) {
  // 解析 callback_data
  const parts = callbackData.split(':');
  const agentName = parts[0];
  const action = parts[1] || '';
  const payload = parts.slice(2).join(':') || '';

  const handler = _handlers.get(agentName);
  if (!handler) return null;

  const sess = _sessions.get(chatId);
  if (!sess || sess.agentName !== agentName) return null;

  // 更新時間
  sess.updatedAt = Date.now();

  const result = await handler.onCallback(sess, action, payload, {
    chatId,
    userId,
    messageId,
  });

  // 如果 handler 回傳 done: true，清除 session
  if (result && result.done) {
    _sessions.delete(chatId);
  }

  return result;
}

/**
 * 處理用戶打字輸入（在有 active session 時攔截）
 *
 * @param {string|number} chatId
 * @param {string} text
 * @param {Object} params — { userId }
 * @returns {Promise<Object|null>} — handler 的回傳值，或 null（無對應 session 或不攔截）
 */
async function handleTextInput(chatId, text, { userId }) {
  const sess = _sessions.get(chatId);
  if (!sess) return null;

  const handler = _handlers.get(sess.agentName);
  if (!handler || !handler.onTextInput) return null;

  sess.updatedAt = Date.now();

  const result = await handler.onTextInput(sess, text, { chatId, userId });

  if (result && result.done) {
    _sessions.delete(chatId);
  }

  return result;
}

/**
 * 檢查某 chatId 是否有進行中的 session
 */
function hasActiveSession(chatId) {
  return _sessions.has(chatId);
}

/**
 * 取得某 chatId 的 session（用於外部判斷）
 */
function getSession(chatId) {
  return _sessions.get(chatId) || null;
}

/**
 * 手動刪除 session
 */
function deleteSession(chatId) {
  _sessions.delete(chatId);
}

// ========================================
// 定時清理過期 session
// ========================================

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [chatId, sess] of _sessions) {
    if (now - sess.updatedAt > sess.ttl) {
      const handler = _handlers.get(sess.agentName);
      if (handler && handler.onTimeout) {
        handler.onTimeout(sess).catch(() => {});
      }
      _sessions.delete(chatId);
      console.log(`[interactive-session] Session 過期清除: ${sess.agentName} (chat: ${chatId})`);
    }
  }
}

// 每分鐘清理一次
const _cleanupInterval = setInterval(cleanExpiredSessions, 60 * 1000);

// 讓 Node.js 不會因為 setInterval 而不退出
if (_cleanupInterval.unref) _cleanupInterval.unref();

module.exports = {
  registerHandler,
  startSession,
  handleCallback,
  handleTextInput,
  hasActiveSession,
  getSession,
  deleteSession,
  cleanExpiredSessions,
};
```

---

## MongoDB 索引建立

本階段需要建立 `sub_tasks` collection 的索引。在 bot-server.js 啟動流程中加入（或另建一個 init script）：

```javascript
// 確保 sub_tasks 索引存在
async function ensureIndexes() {
  const db = await mongo.getDb();

  await db.collection('sub_tasks').createIndexes([
    { key: { parentTaskId: 1 }, name: 'idx_parent_task' },
    { key: { assignedAgent: 1, status: 1 }, name: 'idx_agent_status' },
    { key: { createdAt: 1 }, name: 'idx_created' },
    { key: { 'context.userId': 1 }, name: 'idx_user' },
  ]);
}
```

**此函式可以先寫在 sub-agent-executor.js 裡 export，E2 階段再接入啟動流程。**

---

## 驗證清單

完成後逐項確認：

### E1.1 config
```bash
node -e "const c = require('./src/config'); console.log('subAgent:', JSON.stringify(c.subAgent))"
# 預期：{ maxIterations: 5, defaultTimeout: 30000, defaultModel: 'gpt-4o-mini' }
```

### E1.2 agent-registry
```bash
node -e "
const reg = require('./src/agent-registry');
reg.register({
  name: 'test',
  systemPrompt: 'You are a test agent.',
  allowedSkills: ['check-email'],
});
console.log('registered:', reg.list());
console.log('get:', reg.get('test').name);
reg.clear();
console.log('after clear:', reg.list());
console.log('✅ agent-registry OK');
"
```

### E1.3 policy-engine
```bash
node -e "
const policy = require('./src/policy-engine');
const agentDef = { name: 'test', allowedSkills: ['check-email', 'create-order'] };

// 允許的 skill
const r1 = policy.evaluate('check-email', agentDef);
console.log('check-email:', r1.action);  // allow

// 需確認的 skill
const r2 = policy.evaluate('create-order', agentDef);
console.log('create-order:', r2.action);  // require_confirmation

// 未授權的 skill
const r3 = policy.evaluate('print-label', agentDef);
console.log('print-label:', r3.action);   // deny

console.log('✅ policy-engine OK');
"
```

### E1.4 sub-agent-executor
```bash
node -e "
const executor = require('./src/sub-agent-executor');
const { formatBriefing } = executor;

const text = formatBriefing({
  goal: '查詢最新的未讀信件',
  constraints: ['只查最近 24 小時', '不要回覆信件'],
  data: { account: 'info@sui-yao.com' },
});
console.log(text);
console.log('✅ formatBriefing OK');
"
# 預期：輸出格式化的 briefing 文字
# 注意：不需要真的執行 execute()，那需要 MongoDB 連線和 LLM API
```

### E1.5 interactive-session
```bash
node -e "
const ism = require('./src/interactive-session');

// 註冊假 handler
ism.registerHandler('test', {
  onStart: async (ctx) => ({ text: '開始', reply_markup: null }),
  onCallback: async (sess, action) => {
    if (action === 'done') return { text: '完成', done: true };
    return { text: '繼續' };
  },
  onTextInput: async (sess, text) => ({ text: '收到: ' + text }),
});

(async () => {
  // 開始 session
  const start = await ism.startSession('test', { chatId: 123, userId: 'u1' });
  console.log('start:', start.text);
  console.log('hasSession:', ism.hasActiveSession(123));

  // callback
  const cb = await ism.handleCallback('test:next:', { chatId: 123, userId: 'u1' });
  console.log('callback:', cb.text);

  // text input
  const ti = await ism.handleTextInput(123, '你好', { userId: 'u1' });
  console.log('textInput:', ti.text);

  // done
  const done = await ism.handleCallback('test:done:', { chatId: 123, userId: 'u1' });
  console.log('done:', done.text, done.done);
  console.log('hasSession after done:', ism.hasActiveSession(123));

  console.log('✅ interactive-session OK');
})();
"
```

---

## 注意事項

1. **本階段完全不動 bot-server.js、create-order、任何現有 skill** — 純新增檔案。現有功能必須照常運作。
2. **sub-agent-executor.js 用 `require('../lib/mongodb-tools')` 取得 DB 連線**，跟其他模組一致。
3. **所有新檔案都用 `module.exports`**，不用 ES module（跟專案一致）。
4. **每個檔案開頭都要有 JSDoc 區塊**，說明職責和版本號（跟專案風格一致）。
5. **完成後跑 `node src/bot-server.js` 確認啟動正常**，新模組不會影響現有功能。

---

## 下一步

E1 完成後，進入階段 E2（主 Agent 改造），將 bot-server.js 的 callback 路由改為 InteractiveSessionManager，並讓 handleMessage 支援 delegate 給子 agent。
