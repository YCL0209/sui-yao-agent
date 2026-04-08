# 階段 E5：對話歷史持久化 + MongoDB 分類規則

> E1~E4 已完成：子 agent 架構就位，訂單 Agent 和文件 Agent 拆分完成。
> 本階段做兩件事：
> 1. 把 chatHistories Map 搬到 MongoDB（重啟不斷片）
> 2. 建立 MongoDB collection 分類規則和索引規範

---

## 專案位置

```
~/sui-yao-agent/  (feature/sub-agent 分支)
├── src/
│   ├── bot-server.js              # 🔧 修改：chatHistories Map → MongoDB
│   ├── session.js                 # 🔧 修改：trimHistory 配合 DB 讀寫
│   ├── config.js                  # 🔧 修改：新增 conversation 設定
│   └── ...
├── scripts/
│   └── ensure-indexes.js          # ⚡ 新建：所有 collection 的索引建立腳本
└── docs/
    └── mongodb-schema.md          # ⚡ 新建：collection 分類規則文件
```

---

## Part 1：MongoDB 分類規則文件

### 建立 docs/mongodb-schema.md

```bash
mkdir -p ~/sui-yao-agent/docs
```

**檔案內容：**

```markdown
# 穗鈅助手 — MongoDB Collection 規範

> 所有 collection 的用途、schema、索引、保留策略。
> 新增 collection 時必須更新此文件。

---

## Database: sui-yao-agent

---

### 一、記憶系統（用戶個人資料）

#### memories
- **用途**：長期記憶，每用戶一份文件，內含記憶陣列 + embedding 向量
- **寫入者**：memory-manager.js（對話推斷、用戶要求、pre-flush）
- **讀取者**：memory-search.js（語意搜尋）、prompt-loader.js（注入 system prompt）
- **Schema**：
  ```javascript
  {
    userId: "telegram:8331678146",
    memories: [{
      id: "mem_xxx",
      content: "老闆偏好 A4 格式",
      category: "fact",
      importance: 0.8,
      embedding: [0.12, -0.34, ...],
      embeddingModel: "openai/text-embedding-3-small",
      source: "用戶要求",
      accessCount: 3,
      lastAccessedAt: ISODate,
      createdAt: ISODate,
    }]
  }
  ```
- **索引**：`{ userId: 1 }` (unique)
- **保留策略**：每用戶最多 200 條，超過淘汰最舊的

#### daily_logs
- **用途**：每日活動日誌，每日每用戶一份文件
- **寫入者**：daily-log.js、tool-executor.js（skill 執行完自動寫入）
- **讀取者**：prompt-loader.js（載入今天+昨天的日誌注入 system prompt）
- **Schema**：
  ```javascript
  {
    userId: "telegram:8331678146",
    date: "2026-04-07",
    entries: [{
      type: "task",           // task | decision | event | note
      content: "執行 check-email: 找到 3 封未讀",
      relatedSkill: "check-email",
      time: ISODate,
    }]
  }
  ```
- **索引**：`{ userId: 1, date: -1 }`
- **保留策略**：30 天後歸檔到 archived_daily_logs

#### archived_daily_logs
- **用途**：30 天以上的日誌歸檔
- **寫入者**：scheduler.js、archive-daily-logs.js
- **讀取者**：極少讀取（除錯或歷史查詢用）
- **Schema**：與 daily_logs 相同
- **索引**：`{ userId: 1, date: -1 }`
- **保留策略**：無限期保留（量不大）

#### shared_memory
- **用途**：跨用戶共享知識（公司規則、共用資訊）
- **寫入者**：mongodb-tools（手動或 LLM 寫入）
- **讀取者**：mongodb-tools
- **Schema**：`{ key: string, value: any, updatedAt: ISODate }`
- **索引**：`{ key: 1 }` (unique)
- **保留策略**：手動管理

#### conversations（E5 新增）
- **用途**：對話歷史持久化（取代 chatHistories Map）
- **寫入者**：bot-server.js（每次對話更新）
- **讀取者**：bot-server.js（handleMessage 取得歷史）
- **Schema**：
  ```javascript
  {
    chatId: 8331678146,              // Telegram chat ID (number)
    userId: "telegram:8331678146",
    messages: [
      { role: "user", content: "你好", ts: ISODate },
      { role: "assistant", content: "早，有什麼需要處理的？", ts: ISODate },
    ],
    updatedAt: ISODate,
  }
  ```
- **索引**：`{ chatId: 1 }` (unique)
- **保留策略**：只保留最近 maxRounds*2 條 messages（由 trimHistory 控制）

---

### 二、業務資料

#### products
- **用途**：ERP 產品庫鏡像（RAG 語意搜尋用）
- **寫入者**：sync-products.js（從 ERP API 同步）
- **讀取者**：product-search.js（建單時品項比對）
- **Schema**：
  ```javascript
  {
    productId: "PRO-001",
    erpId: "60f...",
    name: "USB公對母(帶耳)(1米+3米)",
    aliases: ["USB延長線"],
    category: "electronic",
    unitPrice: 15,
    unit: "條",
    embedding: [0.12, ...],
    embeddingModel: "openai/text-embedding-3-small",
    active: true,
    syncedAt: ISODate,
  }
  ```
- **索引**：`{ productId: 1 }` (unique), `{ erpId: 1 }`, `{ active: 1 }`
- **保留策略**：sync-products 控制（停用的標 active: false）

#### parsed_documents
- **用途**：文件分類結果快取（同一個 fileHash 不重複分類）
- **寫入者**：document-classifier.js
- **讀取者**：document-classifier.js（快取查詢）
- **Schema**：
  ```javascript
  {
    source: { fileHash: "abc123", type: "pdf" },
    classification: { category: "order", docType: "quotation", confidence: 0.95 },
    parsedData: { ... },
    status: "parsed",
    createdAt: ISODate,
    updatedAt: ISODate,
  }
  ```
- **索引**：`{ 'source.fileHash': 1 }` (unique)
- **保留策略**：無自動清理（量不大，可定期手動清）

---

### 三、任務與排程

#### reminders
- **用途**：提醒事項（單次 + 重複）
- **寫入者**：set-reminder skill
- **讀取者**：scheduler.js（每分鐘檢查到期提醒）
- **Schema**：
  ```javascript
  {
    userId: "telegram:8331678146",
    content: "開會",
    remindAt: ISODate,
    repeat: { type: "daily", weekdays: [1,3,5] } | null,
    status: "pending",    // pending | triggered | cancelled
    createdAt: ISODate,
  }
  ```
- **索引**：`{ status: 1, remindAt: 1 }`, `{ userId: 1 }`
- **保留策略**：triggered 的保留 30 天（歷史查詢），cancelled 可清

#### scheduled_tasks
- **用途**：排程任務（定時查信等系統級排程）
- **寫入者**：system-router skill
- **讀取者**：scheduler.js
- **Schema**：`{ taskId, type, schedule, status, ... }`
- **索引**：`{ status: 1 }`, `{ taskId: 1 }`
- **保留策略**：手動管理

#### task_requests
- **用途**：任務請求佇列
- **來源**：OpenClaw 時期遺留，目前 system-router 還在用
- **索引**：`{ status: 1, createdAt: 1 }`
- **保留策略**：可考慮未來清理，目前先保留

#### task_results
- **用途**：任務執行結果
- **來源**：OpenClaw 時期遺留，system-router / scheduler 還在寫
- **索引**：`{ createdAt: -1 }`
- **保留策略**：同上

---

### 四、通知

#### notifications
- **用途**：通知記錄（查信結果等）
- **寫入者**：mongodb-tools、system-router
- **讀取者**：system-router（查詢通知）
- **索引**：`{ userId: 1, createdAt: -1 }`
- **保留策略**：定期清理 90 天前的

#### notified_log
- **用途**：信件去重（已通知的 email messageId）
- **寫入者**：check-email skill（透過 mongodb-tools）
- **讀取者**：check-email skill（查詢是否已通知過）
- **Schema**：`{ email, subject, messageId, notifiedAt }`
- **索引**：`{ email: 1, messageId: 1 }`
- **保留策略**：最多 200 條（check-email 控制）

---

### 五、子 Agent 系統

#### sub_tasks
- **用途**：子 agent 的任務紀錄（briefing + result + execution log）
- **寫入者**：sub-agent-executor.js
- **讀取者**：sub-agent-executor.js、未來的管理介面
- **Schema**：見 E1 文件
- **索引**：已在 ensureIndexes() 建立
- **保留策略**：90 天後可歸檔

---

### 新增 Collection 的 SOP

1. 決定歸屬哪一類（記憶 / 業務 / 任務 / 通知 / Agent）
2. 定義 Schema（欄位、型別、預設值）
3. 定義索引（查詢模式決定）
4. 定義保留策略（多久清一次、淘汰規則）
5. 更新本文件
6. 在 ensure-indexes.js 加入索引建立
```

---

## Part 2：ensure-indexes.js — 統一索引建立腳本

**檔案**：`scripts/ensure-indexes.js`

**職責**：一個腳本統一建立所有 collection 的索引。啟動時跑一次，或部署時跑。

```javascript
/**
 * 穗鈅助手 — MongoDB 索引建立腳本
 *
 * 確保所有 collection 的索引存在。
 * 用法：node scripts/ensure-indexes.js
 * 也可以在 bot-server 啟動時 require 呼叫。
 *
 * @version 1.0.0
 */

const mongo = require('../lib/mongodb-tools');

async function ensureAllIndexes() {
  const db = await mongo.getDb();
  console.log('[ensure-indexes] 開始建立索引...');

  // 記憶系統
  await db.collection('memories').createIndexes([
    { key: { userId: 1 }, name: 'idx_userId', unique: true },
  ]);

  await db.collection('daily_logs').createIndexes([
    { key: { userId: 1, date: -1 }, name: 'idx_user_date' },
  ]);

  await db.collection('archived_daily_logs').createIndexes([
    { key: { userId: 1, date: -1 }, name: 'idx_user_date' },
  ]);

  await db.collection('shared_memory').createIndexes([
    { key: { key: 1 }, name: 'idx_key', unique: true },
  ]);

  // 對話歷史（E5 新增）
  await db.collection('conversations').createIndexes([
    { key: { chatId: 1 }, name: 'idx_chatId', unique: true },
  ]);

  // 業務資料
  await db.collection('products').createIndexes([
    { key: { productId: 1 }, name: 'idx_productId', unique: true },
    { key: { erpId: 1 }, name: 'idx_erpId' },
    { key: { active: 1 }, name: 'idx_active' },
  ]);

  await db.collection('parsed_documents').createIndexes([
    { key: { 'source.fileHash': 1 }, name: 'idx_fileHash', unique: true },
  ]);

  // 任務與排程
  await db.collection('reminders').createIndexes([
    { key: { status: 1, remindAt: 1 }, name: 'idx_status_remindAt' },
    { key: { userId: 1 }, name: 'idx_userId' },
  ]);

  await db.collection('scheduled_tasks').createIndexes([
    { key: { status: 1 }, name: 'idx_status' },
    { key: { taskId: 1 }, name: 'idx_taskId' },
  ]);

  await db.collection('task_requests').createIndexes([
    { key: { status: 1, createdAt: 1 }, name: 'idx_status_created' },
  ]);

  await db.collection('task_results').createIndexes([
    { key: { createdAt: -1 }, name: 'idx_created_desc' },
  ]);

  // 通知
  await db.collection('notifications').createIndexes([
    { key: { userId: 1, createdAt: -1 }, name: 'idx_user_created' },
  ]);

  await db.collection('notified_log').createIndexes([
    { key: { email: 1, messageId: 1 }, name: 'idx_email_messageId' },
  ]);

  // 子 Agent 系統
  await db.collection('sub_tasks').createIndexes([
    { key: { parentTaskId: 1 }, name: 'idx_parent_task' },
    { key: { assignedAgent: 1, status: 1 }, name: 'idx_agent_status' },
    { key: { createdAt: 1 }, name: 'idx_created' },
    { key: { 'context.userId': 1 }, name: 'idx_user' },
  ]);

  console.log('[ensure-indexes] ✅ 所有索引建立完成');
}

// CLI 模式
if (require.main === module) {
  ensureAllIndexes()
    .then(() => process.exit(0))
    .catch(err => {
      console.error('[ensure-indexes] ❌ 失敗:', err);
      process.exit(1);
    });
}

module.exports = { ensureAllIndexes };
```

---

## Part 3：對話歷史持久化

### 3.1 config.js 新增 conversation 設定

在 config 的 `session` 區塊下面加：

```javascript
// 對話歷史持久化
conversation: {
  maxMessages: parseInt(process.env.CONVERSATION_MAX_MESSAGES) || 200,
  // maxRounds 已在 session 區塊（用於截斷），這裡的 maxMessages 是 DB 保留上限
},
```

### 3.2 改 bot-server.js

**改動目標**：把 `chatHistories` Map 的讀寫改成 MongoDB `conversations` collection。

#### 3.2.1 刪除 Map 宣告

刪除：
```javascript
const chatHistories = new Map();
```

#### 3.2.2 新增 DB 讀寫函式

在 bot-server.js 頂部（startBot 之前）加入：

```javascript
// ============================================================
// 對話歷史 — MongoDB 持久化
// ============================================================

/**
 * 從 MongoDB 取得對話歷史
 * @param {number|string} chatId
 * @returns {Promise<Array>} messages 陣列
 */
async function getHistory(chatId) {
  const db = await mongo.getDb();
  const doc = await db.collection('conversations').findOne({ chatId: Number(chatId) });
  return doc?.messages || [];
}

/**
 * 儲存對話歷史到 MongoDB
 * @param {number|string} chatId
 * @param {string} userId
 * @param {Array} messages — 完整的 messages 陣列
 */
async function saveHistory(chatId, userId, messages) {
  const db = await mongo.getDb();
  const maxMessages = config.conversation?.maxMessages || 200;

  // 只保留最後 maxMessages 條
  const trimmed = messages.length > maxMessages
    ? messages.slice(-maxMessages)
    : messages;

  await db.collection('conversations').updateOne(
    { chatId: Number(chatId) },
    {
      $set: {
        userId,
        messages: trimmed,
        updatedAt: new Date(),
      },
      $setOnInsert: { chatId: Number(chatId) },
    },
    { upsert: true }
  );
}

/**
 * 清除對話歷史
 * @param {number|string} chatId
 */
async function clearHistory(chatId) {
  const db = await mongo.getDb();
  await db.collection('conversations').deleteOne({ chatId: Number(chatId) });
}
```

#### 3.2.3 改 handleMessage

把 handleMessage 裡的 Map 操作換成 DB 操作：

**原來：**
```javascript
if (!chatHistories.has(chatId)) {
  chatHistories.set(chatId, []);
}
const history = chatHistories.get(chatId);
history.push({ role: 'user', content: userMessage });
```

**改為：**
```javascript
const history = await getHistory(chatId);
history.push({ role: 'user', content: userMessage, ts: new Date() });
```

**原來（函式結尾）：**
```javascript
history.push({ role: 'assistant', content: finalReply });
while (history.length > config.session.maxRounds * 2) {
  history.shift();
}
```

**改為：**
```javascript
history.push({ role: 'assistant', content: finalReply, ts: new Date() });
while (history.length > config.session.maxRounds * 2) {
  history.shift();
}
// 寫回 DB（fire-and-forget，不阻塞回覆）
saveHistory(chatId, userId, history).catch(err =>
  console.error('[bot-server] 對話歷史儲存失敗:', err.message)
);
```

**同樣地，提前 return 的地方（hasImages、hasReplyMarkup）也要加 saveHistory：**

找到 `return { reply: hasImages.text, images: ... }` 和 `return { reply: text, reply_markup: ... }` 的地方，在 return 之前加：

```javascript
saveHistory(chatId, userId, history).catch(err =>
  console.error('[bot-server] 對話歷史儲存失敗:', err.message)
);
```

#### 3.2.4 改 /reset 指令

**原來：**
```javascript
chatHistories.delete(chatId);
```

**改為：**
```javascript
clearHistory(chatId).catch(() => {});
```

#### 3.2.5 session.js 的 trimHistoryWithFlush 不需要改

`trimHistoryWithFlush` 接收的是 messages 陣列（已從 DB 讀出），回傳截斷後的陣列。它不直接碰 Map 也不直接碰 DB，所以不需要改。截斷後的結果只用於當次 LLM 呼叫，不寫回 DB（DB 裡保留完整歷史，截斷只影響送給 LLM 的內容）。

---

## 驗證清單

### Part 1 驗證

```bash
# 文件存在
test -f docs/mongodb-schema.md && echo '✅ schema 文件存在' || echo '❌'
```

### Part 2 驗證

```bash
# 索引腳本語法檢查
node -c scripts/ensure-indexes.js && echo '✅ 語法正確' || echo '❌'

# 如果有 MongoDB 連線，實際跑一次：
# node scripts/ensure-indexes.js
```

### Part 3 驗證

```bash
# 語法檢查
node -c src/bot-server.js && echo '✅ 語法正確' || echo '❌'

# 確認 chatHistories Map 已移除
grep -n 'chatHistories' src/bot-server.js && echo '⚠️ 還有殘留' || echo '✅ 已清除'

# 確認新函式存在
grep -n 'async function getHistory' src/bot-server.js | head -1
grep -n 'async function saveHistory' src/bot-server.js | head -1
grep -n 'async function clearHistory' src/bot-server.js | head -1
```

### 功能測試（Telegram）— 完整測試清單

E1~E5 全部完成後的完整功能驗證：

| # | 測試場景 | 操作 | 預期結果 |
|---|---------|------|---------|
| **基礎對話** |||
| 1 | 打招呼 | 發「你好」 | 簡潔回覆，不自我介紹 |
| 2 | 記憶存入 | 告訴穗鈅一個偏好 | 回覆確認，記憶存入 |
| 3 | 記憶召回 | 問穗鈅之前的偏好 | 從記憶中找到並回覆 |
| 4 | 對話延續 | 連續聊 3-4 輪 | 記得之前聊的內容 |
| 5 | **重啟延續** | 重啟 bot-server → 繼續聊 | **不會斷片**，還記得之前的對話 |
| 6 | /reset | 發 /reset → 繼續聊 | 對話歷史清除，重新開始 |
| **建單流程（order-agent）** |||
| 7 | 引導模式 | 發「建立訂單」→ 按銷售單 → 輸入客戶 → 輸入品項 → 確認 | 訂單建立成功 |
| 8 | 智慧模式 | 發「幫百凌開一張採購單 USB延長線 x10 @15」 | 直接跳到確認或客戶選擇 |
| 9 | 找不到客戶 | 輸入一個不存在的客戶名 | 顯示「建立新客戶」按鈕 |
| 10 | 建立新客戶 | 按「建立新客戶」 | 客戶建立成功，繼續流程 |
| 11 | 多筆客戶 | 輸入一個有多筆結果的關鍵字 | 顯示選擇按鈕 |
| 12 | 取消建單 | 建單中按「取消」 | 顯示已取消，按鈕消失 |
| 13 | 建單後 PDF | 建完按「報價單」或「銷貨單」 | PDF 生成成功 |
| 14 | 建單後跳過 PDF | 建完按「不用」 | 正常結束 |
| 15 | LLM tool call | LLM 判斷需要建單時 | 正常啟動 ISM session |
| **文件處理（doc-agent）** |||
| 16 | 訂單 PDF | 傳一張報價單 PDF | 分類 → 解析 → 進入建單 |
| 17 | 訂單圖片 | 傳一張訂單照片 | 分類 → 解析 → 進入建單 |
| 18 | _ambiguous | 傳有兩個公司名的文件 | 顯示選擇按鈕 → 選完進入建單 |
| 19 | _ambiguous 取消 | 同上按取消 | 顯示已取消，按鈕消失 |
| 20 | 非訂單文件 | 傳送貨單照片 | 顯示「已辨識，尚未支援」 |
| 21 | 生活照 | 傳風景照 | 不回覆（跳過） |
| **按鈕清理** |||
| 22 | 按完清按鈕 | 按任何按鈕後 | 原訊息的按鈕消失 |
| 23 | 殭屍按鈕 | 等 session 過期後按舊按鈕 | 顯示「已過期」，按鈕消失 |
| **其他功能** |||
| 24 | 查信 | 發「查信」 | check-email 正常執行 |
| 25 | 設提醒 | 發「提醒我明天開會」 | set-reminder 正常執行 |
| 26 | 同步產品 | 發「同步產品」 | sync-products 正常執行 |
| 27 | /start | 發 /start | 顯示歡迎訊息 |

---

## 注意事項

1. **saveHistory 用 fire-and-forget**：`saveHistory(...).catch(...)` 不 await，不阻塞回覆。DB 寫入失敗不影響用戶體驗，只是下次重啟少了最後一輪。
2. **messages 裡加 `ts` 欄位**：方便之後查詢和除錯。送給 LLM 時不影響（OpenAI 忽略多餘欄位）。
3. **maxMessages vs maxRounds**：`maxRounds` 控制送給 LLM 的對話長度（context window），`maxMessages` 控制 DB 保留的歷史長度。`maxMessages` 應該 >= `maxRounds * 2`。
4. **ensure-indexes.js 部署時跑一次就好**：索引建立是冪等的，重複跑不會出錯。可以加到 LaunchAgent 的啟動腳本裡。
5. **完成測試後 merge 到 main**。

---

## 完成後的整體架構

```
bot-server.js（~500 行，精簡後）
  ├── Telegram 收發
  ├── callback handler → ISM 統一路由 + fallback
  ├── message handler → ISM 攔截 → 關鍵詞攔截 → LLM Agent 迴圈
  └── 對話歷史 → MongoDB conversations

src/agents/
  ├── order-agent.js  — 訂單互動（MESSAGES + 按鈕 + 流程）
  └── doc-agent.js    — 文件處理（分類 + 解析 + ambiguous）

src/ 基礎設施
  ├── interactive-session.js  — 通用互動 session 管理
  ├── agent-registry.js       — agent 定義註冊
  ├── policy-engine.js        — 權限 + 風險檢查
  ├── sub-agent-executor.js   — 子 agent 執行引擎（未來用）
  └── ...其他模組

skills/ 純工具
  ├── create-order/  — ERP 操作 + RAG 比對
  ├── check-email/   — Gmail 查詢
  ├── generate-pdf/  — PDF 生成
  ├── set-reminder/  — 提醒設定
  └── ...

MongoDB（15 個 collection，有分類 + 索引 + 保留策略）
```
