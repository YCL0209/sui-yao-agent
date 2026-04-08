# 階段 F2 + E6：提醒管理 + Execution Log

> E1~F1 已完成並 merge 到 main。本階段做兩件事：
> 1. F2：讓用戶能查看、修改、刪除已設的提醒（補完提醒功能）
> 2. E6：在 tool-executor 加結構化 execution log（系統可觀測性）

---

## 專案位置

```
~/sui-yao-agent/  (main 分支)
├── src/
│   ├── agents/
│   │   └── reminder-agent.js      # 🔧 修改：加入查看/刪除的互動流程
│   ├── bot-server.js              # 🔧 小改：關鍵詞攔截加「查看提醒」
│   ├── tool-executor.js           # 🔧 修改：加結構化 execution log 寫入
│   └── config.js                  # 不動
├── skills/
│   ├── set-reminder/index.js      # 🔧 修改：加 listReminders / cancelReminder export
│   └── system-router/index.js     # 現有（已有 list_reminders / cancel_reminder，參考用）
├── prompts/
│   └── rules.md                   # 🔧 小改：加提醒管理的觸發規則
├── scripts/
│   └── ensure-indexes.js          # 🔧 小改：加 execution_logs 索引
└── docs/
    └── mongodb-schema.md          # 🔧 小改：加 execution_logs collection 說明
```

---

## Part 1：F2 — 提醒管理

### 現況分析

system-router 裡已經有 `list_reminders` 和 `cancel_reminder` 邏輯（約第 102-125 行），但問題是：
1. 它們藏在 system-router 的 query handler 裡，LLM 不一定知道怎麼觸發
2. 沒有友善的格式化（直接回傳 JSON）
3. 沒有互動式的刪除流程（用戶要知道 reminderId 才能刪）

### 設計方案

把提醒管理加到兩個地方：
1. `set-reminder/index.js` 新增工具函式：`listReminders`、`cancelReminder`、`updateReminder`
2. `reminder-agent.js` 新增查看/刪除的互動流程（按鈕選擇要刪哪個）
3. LLM 可以透過自然語言觸發（「我有哪些提醒」「取消開會的提醒」）

### Step 1：set-reminder/index.js 新增工具函式

在 `createReminder` 函式下面，`module.exports` 之前，新增三個函式：

```javascript
// ========================================
// 提醒查詢
// ========================================

/**
 * 查詢用戶的待執行提醒
 * @param {string} userId
 * @returns {Promise<Array>} — 格式化的提醒列表
 */
async function listReminders(userId) {
  const db = await mongo.getDb();
  const reminders = await db.collection('reminders')
    .find({ userId, status: 'pending' })
    .sort({ remindAt: 1 })
    .limit(20)
    .toArray();

  return reminders.map(r => ({
    id: r._id.toString(),
    content: r.content,
    remindAt: r.remindAt,
    repeat: r.repeat,
    createdAt: r.createdAt,
  }));
}

/**
 * 取消一個提醒
 * @param {string} reminderId — MongoDB _id
 * @returns {Promise<boolean>} — 是否成功
 */
async function cancelReminder(reminderId) {
  const { ObjectId } = require('mongodb');
  const db = await mongo.getDb();
  const result = await db.collection('reminders').updateOne(
    { _id: new ObjectId(reminderId), status: 'pending' },
    { $set: { status: 'cancelled', cancelledAt: new Date() } }
  );
  return result.modifiedCount > 0;
}

/**
 * 修改提醒時間
 * @param {string} reminderId
 * @param {string} newRemindAt — ISO 8601
 * @returns {Promise<boolean>}
 */
async function updateReminderTime(reminderId, newRemindAt) {
  const { ObjectId } = require('mongodb');
  const db = await mongo.getDb();
  const result = await db.collection('reminders').updateOne(
    { _id: new ObjectId(reminderId), status: 'pending' },
    { $set: { remindAt: new Date(newRemindAt), updatedAt: new Date() } }
  );
  return result.modifiedCount > 0;
}
```

然後在 `module.exports` 裡加上這三個 export：

```javascript
// 在現有的 export 裡加上：
listReminders,
cancelReminder,
updateReminderTime,
```

### Step 2：reminder-agent.js 加入查看/管理流程

在 reminder-agent.js 裡新增：

#### 2.1 MESSAGES 新增管理相關文字

在現有 MESSAGES 物件裡加上：

```javascript
// 在 MESSAGES 裡新增：
noReminders: '目前沒有待執行的提醒。',
reminderList: (items) => {
  if (items.length === 0) return '目前沒有待執行的提醒。';
  const lines = items.map((r, i) => {
    const time = r.remindAt
      ? new Date(r.remindAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit' })
      : '未指定時間';
    const repeatStr = r.repeat ? ` 🔁${r.repeat.type}` : '';
    return `${i + 1}. 「${r.content}」\n   ⏰ ${time}${repeatStr}`;
  }).join('\n\n');
  return `📋 你的提醒（${items.length} 個）：\n\n${lines}`;
},
cancelledReminder: (content) => `✅ 已取消提醒：「${content}」`,
cancelFailed: '找不到此提醒或已取消。',
```

#### 2.2 新增按鈕模板

```javascript
function reminderListButtons(reminders) {
  const buttons = reminders.slice(0, 5).map(r => {
    const shortContent = r.content.length > 20 ? r.content.substring(0, 20) + '...' : r.content;
    return [
      { text: `❌ ${shortContent}`, callback_data: `reminder:delete:${r.id}` },
    ];
  });
  buttons.push([{ text: '⬅️ 關閉', callback_data: 'reminder:close' }]);
  return { inline_keyboard: buttons };
}
```

#### 2.3 在 ISM handler 的 onCallback 加入新 action

在 reminderHandler 的 `onCallback` 裡，現有的 cancel/confirm/edittime 之後加上：

```javascript
// delete:{reminderId} — 從列表中刪除一個提醒
if (action === 'delete') {
  const reminderId = payload;
  const reminderSkill = require('../../skills/set-reminder');
  
  // 先找到這個提醒的內容（用於回覆）
  const reminders = await reminderSkill.listReminders(session.userId);
  const target = reminders.find(r => r.id === reminderId);
  const content = target ? target.content : '未知';
  
  const success = await reminderSkill.cancelReminder(reminderId);
  if (success) {
    // 刪完後重新列出剩餘的
    const remaining = await reminderSkill.listReminders(session.userId);
    if (remaining.length === 0) {
      return { text: MESSAGES.cancelledReminder(content) + '\n\n' + MESSAGES.noReminders, done: true };
    }
    return {
      text: MESSAGES.cancelledReminder(content) + '\n\n' + MESSAGES.reminderList(remaining),
      reply_markup: reminderListButtons(remaining),
    };
  }
  return { text: MESSAGES.cancelFailed };
}

// close — 關閉列表
if (action === 'close') {
  return { text: '', done: true };
}
```

#### 2.4 新增 startReminderList export

在 module.exports 裡加上：

```javascript
// 讓 bot-server 能啟動提醒列表（用於關鍵詞攔截）
startReminderList: async (chatId, userId) => {
  const reminderSkill = require('../../skills/set-reminder');
  const reminders = await reminderSkill.listReminders(userId);
  
  if (reminders.length === 0) {
    // 沒有提醒，不需要開 ISM session
    return { text: MESSAGES.noReminders };
  }
  
  // 開 ISM session 讓用戶可以互動刪除
  return ism.startSession('reminder', {
    chatId,
    userId,
    initialData: { _mode: 'list', reminders },
  });
},
```

#### 2.5 修改 onStart 支援 list 模式

修改 reminderHandler 的 `onStart`，讓它判斷是「設定確認」還是「查看列表」：

```javascript
async onStart({ session }) {
  // 查看列表模式
  if (session.data._mode === 'list') {
    const reminders = session.data.reminders || [];
    session.step = 'list';
    return {
      text: MESSAGES.reminderList(reminders),
      reply_markup: reminderListButtons(reminders),
    };
  }
  
  // 設定確認模式（原本的邏輯）
  const { content, remindAt, repeat } = session.data;
  const timeStr = formatTime(remindAt);
  const repeatStr = formatRepeat(repeat);
  session.step = 'confirm';
  return {
    text: MESSAGES.confirm(content, timeStr, repeatStr),
    reply_markup: confirmButtons(),
  };
},
```

### Step 3：bot-server.js 加關鍵詞攔截

在 message handler 裡，現有的「建立訂單」關鍵詞攔截附近，加上：

```javascript
// ---- 查看提醒關鍵詞攔截 ----
if (/查看提醒|我的提醒|有哪些提醒|提醒列表|list.?remind/i.test(text)) {
  const result = await reminderAgent.startReminderList(chatId, userId);
  if (result) {
    await sendReply(bot, chatId, result.text, result.reply_markup);
    return;
  }
}
```

同時在頂部 require 區塊確認 reminderAgent 已引入（F1 應該已經加了）：

```javascript
const reminderAgent = require('./agents/reminder-agent');
```

### Step 4：rules.md 加提醒管理觸發規則

在 `## Skill 觸發規則` 區塊的提醒相關規則下面加上：

```markdown
- 查看提醒、我的提醒、有哪些提醒 → 查詢提醒列表
- 取消提醒、刪除提醒 → 用戶需要先看列表，選擇要取消哪個
```

---

## Part 2：E6 — Execution Log

### 設計

在 tool-executor.js 的 `execute()` 裡，每次 skill 呼叫都多寫一筆到 MongoDB `execution_logs` collection。跟 daily_log 不同的是，execution_log 是**結構化的機器可讀紀錄**，不是人類摘要。

### Step 5：tool-executor.js 加 execution log

在 `execute()` 函式裡，success 和 error 兩個分支都加一段寫入 execution_logs 的邏輯。

修改後的 execute 函式：

```javascript
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
  const userId = context.userId || 'system';

  try {
    const result = await skill.run(args, { ...context, llm: require('./llm-adapter') });
    const durationMs = Date.now() - startMs;

    // 寫入 daily-log（人類可讀摘要）
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

    // 寫入 daily-log
    try {
      await dailyLog.appendLog(userId, {
        type: 'event',
        content: `${funcName} 執行失敗: ${err.message}`,
        relatedSkill: funcName,
      });
    } catch (_) {}

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
    }).catch(err => console.warn('[tool-executor] execution-log 寫入失敗:', err.message));

    return {
      success: false,
      data: null,
      summary: `執行失敗: ${err.message}`,
      skillName: funcName,
      durationMs,
    };
  }
}
```

在 execute 函式上面加上輔助函式：

```javascript
const mongo = require('../lib/mongodb-tools');

/**
 * 寫入結構化 execution log
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
```

### Step 6：ensure-indexes.js 加 execution_logs 索引

在 `ensureAllIndexes` 函式裡加上：

```javascript
// Execution logs
await safeCreateIndexes(db.collection('execution_logs'), [
  { key: { timestamp: -1 }, name: 'idx_timestamp_desc' },
  { key: { userId: 1, timestamp: -1 }, name: 'idx_user_timestamp' },
  { key: { skill: 1, status: 1 }, name: 'idx_skill_status' },
]);
```

### Step 7：mongodb-schema.md 加 execution_logs 說明

在文件的「五、子 Agent 系統」區塊下面加上：

```markdown
### 六、可觀測性

#### execution_logs
- **用途**：每次 skill 呼叫的結構化紀錄（入參、出參、耗時、成敗）
- **寫入者**：tool-executor.js（每次 execute 自動寫入）
- **讀取者**：管理介面（未來）、除錯查詢
- **Schema**：
  ```javascript
  {
    userId: "telegram:8331678146",
    chatId: 8331678146,
    skill: "set-reminder",
    input: { content: "開會", remindAt: "2026-04-09T16:00:00Z" },
    output: { success: true, summary: "✅ 已設定提醒", hasData: true, hasReplyMarkup: true },
    status: "success",       // success | error
    error: null,             // 失敗時的錯誤訊息
    durationMs: 234,
    timestamp: ISODate,
  }
  ```
- **索引**：`{ timestamp: -1 }`, `{ userId: 1, timestamp: -1 }`, `{ skill: 1, status: 1 }`
- **保留策略**：90 天後可歸檔或清理
```

---

## 驗證

### 語法檢查

```bash
node -c src/tool-executor.js && echo '✅ tool-executor' || echo '❌'
node -c src/agents/reminder-agent.js && echo '✅ reminder-agent' || echo '❌'
node -c skills/set-reminder/index.js && echo '✅ set-reminder' || echo '❌'
node -c src/bot-server.js && echo '✅ bot-server' || echo '❌'
```

### 模組載入檢查

```bash
node -e "
const skill = require('./skills/set-reminder');
console.log('listReminders:', typeof skill.listReminders === 'function' ? '✅' : '❌');
console.log('cancelReminder:', typeof skill.cancelReminder === 'function' ? '✅' : '❌');
console.log('updateReminderTime:', typeof skill.updateReminderTime === 'function' ? '✅' : '❌');

const ra = require('./src/agents/reminder-agent');
console.log('startReminderList:', typeof ra.startReminderList === 'function' ? '✅' : '❌');
console.log('startReminderSession:', typeof ra.startReminderSession === 'function' ? '✅' : '❌');
"
```

### Execution Log 檢查

```bash
# 跑完一次 Telegram 對話後，檢查 execution_logs 有沒有寫入
node -e "
const mongo = require('./lib/mongodb-tools');
(async () => {
  const db = await mongo.getDb();
  const count = await db.collection('execution_logs').countDocuments();
  console.log('execution_logs 筆數:', count);
  if (count > 0) {
    const latest = await db.collection('execution_logs').findOne({}, { sort: { timestamp: -1 } });
    console.log('最新一筆:', JSON.stringify(latest, null, 2));
  }
  await mongo.close();
})();
"
```

### Telegram 測試

| # | 操作 | 預期 |
|---|------|------|
| **F2 提醒管理** |||
| 1 | 先設一個提醒（「提醒我明天開會」→ 確認） | 提醒設定成功 |
| 2 | 發「查看提醒」 | 顯示提醒列表 + 每個提醒有刪除按鈕 |
| 3 | 按某個提醒的「❌」按鈕 | 該提醒被取消，列表更新 |
| 4 | 發「我有哪些提醒」 | 同 #2 |
| 5 | 發「取消開會的提醒」 | LLM 判斷後觸發查詢或直接取消 |
| 6 | 所有提醒都刪完後按刪除 | 顯示「目前沒有待執行的提醒」 |
| 7 | 沒有任何提醒時發「查看提醒」 | 直接回覆「目前沒有待執行的提醒」，不開 ISM |
| **E6 Execution Log** |||
| 8 | 做任何觸發 skill 的操作（建單、查信、設提醒等） | 操作正常 |
| 9 | 用上面的 node 腳本檢查 execution_logs | 有紀錄，包含 skill、input、output、durationMs |
| 10 | 故意觸發一個失敗（例如 ERP 斷線時建單） | execution_logs 有 status: 'error' 的紀錄 |

---

## 注意事項

1. **execution_logs 是 fire-and-forget**：`writeExecutionLog().catch()` 不 await，不影響用戶回覆。寫入失敗只 console.warn。
2. **sanitizeInput**：避免把密碼、token 等敏感資訊寫進 log。目前用關鍵字過濾，之後可以加更多。
3. **reminder-agent 的 list 模式和 confirm 模式共用同一個 ISM handler**：透過 `session.data._mode` 區分。同一時間一個 chatId 只能有一個 ISM session，所以不會衝突。
4. **system-router 裡的 list_reminders / cancel_reminder 保留**：不刪除，因為 LLM 透過 system-router 的 query 路徑也能觸發。兩條路徑並存：關鍵詞攔截走 ISM（有按鈕），LLM tool call 走 system-router（純文字回覆）。
