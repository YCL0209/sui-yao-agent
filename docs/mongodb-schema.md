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
- **保留策略**：30 天後歸檔到 archived_daily_logs（archive-logs scheduler）

#### archived_daily_logs
- **用途**：30 天以上的日誌歸檔
- **寫入者**：scheduler.js、archive-daily-logs.js
- **讀取者**：極少讀取（除錯或歷史查詢用）
- **Schema**：與 daily_logs 相同
- **索引**：`{ userId: 1, date: -1 }`
- **保留策略**：365 天後由 db-cleanup 自動刪除

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
- **保留策略**：每筆訊息上限由 saveHistory 控制；整個 chat 的 updatedAt 超過 90 天由 db-cleanup 自動刪除

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
- **保留策略**：180 天後由 db-cleanup 自動刪除

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
- **保留策略**：done/cancelled 狀態 30 天後由 db-cleanup 自動刪除；pending 不清

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
- **保留策略**：暫不清理（量小）

#### task_results
- **用途**：任務執行結果
- **來源**：OpenClaw 時期遺留，system-router / scheduler 還在寫
- **索引**：`{ createdAt: -1 }`
- **保留策略**：30 天後由 db-cleanup 自動刪除（依 executedAt）

---

### 四、通知

#### notifications
- **用途**：通知記錄（查信結果等）
- **寫入者**：mongodb-tools、system-router
- **讀取者**：system-router（查詢通知）
- **索引**：`{ userId: 1, createdAt: -1 }`
- **保留策略**：delivered: true 狀態 90 天後由 db-cleanup 自動刪除

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
- **Schema**：見 stage-e1-sub-agent-infrastructure.md
- **索引**：`{ parentTaskId: 1 }`, `{ assignedAgent: 1, status: 1 }`, `{ createdAt: 1 }`, `{ context.userId: 1 }`
- **保留策略**：completed/failed 狀態 90 天後由 db-cleanup 自動刪除（needs_review 不清）

---

---

### 六、可觀測性

#### execution_logs
- **用途**：每次 skill 呼叫的結構化紀錄（入參、出參、耗時、成敗）
- **寫入者**：tool-executor.js（每次 execute 自動 fire-and-forget 寫入）
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
- **保留策略**：90 天後由 db-cleanup 自動刪除

---

### 新增 Collection 的 SOP

1. 決定歸屬哪一類（記憶 / 業務 / 任務 / 通知 / Agent）
2. 定義 Schema（欄位、型別、預設值）
3. 定義索引（查詢模式決定）
4. 定義保留策略（多久清一次、淘汰規則）
5. 更新本文件
6. 在 `scripts/ensure-indexes.js` 加入索引建立
