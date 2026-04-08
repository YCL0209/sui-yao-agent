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

/**
 * 確保 sub_tasks collection 索引存在
 * 本階段 export 但不接入啟動流程，留給 E2 階段呼叫。
 */
async function ensureIndexes() {
  const db = await mongo.getDb();

  await db.collection('sub_tasks').createIndexes([
    { key: { parentTaskId: 1 }, name: 'idx_parent_task' },
    { key: { assignedAgent: 1, status: 1 }, name: 'idx_agent_status' },
    { key: { createdAt: 1 }, name: 'idx_created' },
    { key: { 'context.userId': 1 }, name: 'idx_user' },
  ]);
}

module.exports = { execute, formatBriefing, ensureIndexes };
