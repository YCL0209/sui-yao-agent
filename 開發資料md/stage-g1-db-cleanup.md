# 階段 G1：MongoDB 定期清理機制 + 新功能 DB 評估規範

> F2+E6 已完成。本階段做兩件事：
> 1. 在 scheduler 加入 `db-cleanup` handler，定期清理過期資料
> 2. 在工程文件裡加「新功能進 DB 必須評估清理策略」的 SOP

---

## 專案位置

```
~/sui-yao-agent/  (main 分支)
├── scripts/
│   └── scheduler.js               # 🔧 修改：新增 db-cleanup handler
├── src/
│   └── config.js                  # 🔧 修改：新增 cleanup 設定區塊
├── docs/
│   ├── mongodb-schema.md          # 🔧 修改：更新各 collection 的保留策略
│   └── new-feature-db-checklist.md # ⚡ 新建：新功能進 DB 的評估 SOP
└── .env                           # 可選：加 cleanup 相關變數
```

---

## Part 1：清理策略定義

### 各 Collection 清理規則

| Collection | 清理規則 | 保留天數 | 方式 |
|---|---|---|---|
| execution_logs | 刪除超過保留天數的 | 90 | deleteMany |
| task_results | 刪除超過保留天數的 | 30 | deleteMany |
| sub_tasks | status 為 completed/failed 且超過保留天數的 | 90 | deleteMany |
| notifications | delivered: true 且超過保留天數的 | 90 | deleteMany |
| reminders | status 為 done/cancelled 且超過保留天數的 | 30 | deleteMany |
| archived_daily_logs | 超過保留天數的 | 365 | deleteMany |
| parsed_documents | 超過保留天數的 | 180 | deleteMany |
| conversations | updatedAt 超過保留天數的（長期沒對話的） | 90 | deleteMany |

### 不清理的 Collection

| Collection | 理由 |
|---|---|
| memories | 已有 enforceLimit（200 條上限），不需要時間清理 |
| daily_logs | 已有 archive-logs 機制，30 天後歸檔 |
| products | sync-products 控制，停用標 active: false |
| shared_memory | 手動管理，量極小 |
| scheduled_tasks | 系統設定，不應自動刪 |
| task_requests | 量小，暫不清理 |

---

## Part 2：config.js 新增 cleanup 設定

在 config 物件裡加上（放在 `conversation` 區塊後面）：

```javascript
// DB 定期清理
cleanup: {
  executionLogs:     parseInt(process.env.CLEANUP_EXECUTION_LOGS_DAYS)     || 90,
  taskResults:       parseInt(process.env.CLEANUP_TASK_RESULTS_DAYS)       || 30,
  subTasks:          parseInt(process.env.CLEANUP_SUB_TASKS_DAYS)          || 90,
  notifications:     parseInt(process.env.CLEANUP_NOTIFICATIONS_DAYS)      || 90,
  reminders:         parseInt(process.env.CLEANUP_REMINDERS_DAYS)          || 30,
  archivedLogs:      parseInt(process.env.CLEANUP_ARCHIVED_LOGS_DAYS)      || 365,
  parsedDocuments:   parseInt(process.env.CLEANUP_PARSED_DOCUMENTS_DAYS)   || 180,
  conversations:     parseInt(process.env.CLEANUP_CONVERSATIONS_DAYS)      || 90,
},
```

不需要在 `.env` 加變數，用預設值就好。之後要調直接改 `.env`。

---

## Part 3：scheduler.js 新增 db-cleanup handler

在 `handlers` 物件裡，`archive-logs` 下面加上：

```javascript
'db-cleanup': async () => {
  const db = await mongo.getDb();
  const cleanup = appConfig.cleanup || {};
  const results = {};

  // 1. execution_logs — 刪除超過 N 天的
  const execCutoff = new Date();
  execCutoff.setDate(execCutoff.getDate() - (cleanup.executionLogs || 90));
  const execResult = await db.collection('execution_logs').deleteMany({
    timestamp: { $lt: execCutoff }
  });
  results.execution_logs = execResult.deletedCount;

  // 2. task_results — 刪除超過 N 天的
  const taskCutoff = new Date();
  taskCutoff.setDate(taskCutoff.getDate() - (cleanup.taskResults || 30));
  const taskResult = await db.collection('task_results').deleteMany({
    executedAt: { $lt: taskCutoff }
  });
  results.task_results = taskResult.deletedCount;

  // 3. sub_tasks — completed/failed 且超過 N 天的
  const subCutoff = new Date();
  subCutoff.setDate(subCutoff.getDate() - (cleanup.subTasks || 90));
  const subResult = await db.collection('sub_tasks').deleteMany({
    status: { $in: ['completed', 'failed'] },
    createdAt: { $lt: subCutoff }
  });
  results.sub_tasks = subResult.deletedCount;

  // 4. notifications — delivered 且超過 N 天的
  const notifCutoff = new Date();
  notifCutoff.setDate(notifCutoff.getDate() - (cleanup.notifications || 90));
  const notifResult = await db.collection('notifications').deleteMany({
    delivered: true,
    createdAt: { $lt: notifCutoff }
  });
  results.notifications = notifResult.deletedCount;

  // 5. reminders — done/cancelled 且超過 N 天的
  const remCutoff = new Date();
  remCutoff.setDate(remCutoff.getDate() - (cleanup.reminders || 30));
  const remResult = await db.collection('reminders').deleteMany({
    status: { $in: ['done', 'cancelled'] },
    createdAt: { $lt: remCutoff }
  });
  results.reminders = remResult.deletedCount;

  // 6. archived_daily_logs — 超過 N 天的
  const archCutoff = new Date();
  archCutoff.setDate(archCutoff.getDate() - (cleanup.archivedLogs || 365));
  const archCutoffStr = archCutoff.toISOString().split('T')[0];
  const archResult = await db.collection('archived_daily_logs').deleteMany({
    date: { $lt: archCutoffStr }
  });
  results.archived_daily_logs = archResult.deletedCount;

  // 7. parsed_documents — 超過 N 天的
  const parsedCutoff = new Date();
  parsedCutoff.setDate(parsedCutoff.getDate() - (cleanup.parsedDocuments || 180));
  const parsedResult = await db.collection('parsed_documents').deleteMany({
    createdAt: { $lt: parsedCutoff }
  });
  results.parsed_documents = parsedResult.deletedCount;

  // 8. conversations — updatedAt 超過 N 天的（長期沒對話的）
  const convCutoff = new Date();
  convCutoff.setDate(convCutoff.getDate() - (cleanup.conversations || 90));
  const convResult = await db.collection('conversations').deleteMany({
    updatedAt: { $lt: convCutoff }
  });
  results.conversations = convResult.deletedCount;

  // 統計
  const total = Object.values(results).reduce((s, n) => s + n, 0);
  const summary = total > 0
    ? Object.entries(results).filter(([, n]) => n > 0).map(([k, n]) => `${k}: ${n}`).join(', ')
    : 'nothing to clean';

  return { ok: true, cleaned: total, details: results, notified: false, summary };
},
```

### scheduler main 裡的 summary 處理

找到 main 函式裡處理各 handler 結果的區塊，加上 `db-cleanup` 的 summary 邏輯：

```javascript
// 在現有的 if/else 判斷裡加上：
} else if (task.type === 'db-cleanup') {
  summary = result.cleaned > 0
    ? `cleaned ${result.cleaned} docs (${result.summary})`
    : 'nothing to clean';
}
```

### MongoDB scheduled_tasks 裡要加一筆 db-cleanup 任務

這個需要手動插入或用腳本：

```javascript
// 一次性執行（或寫在 ensure-indexes.js 裡）
db.collection('scheduled_tasks').updateOne(
  { taskId: 'db-cleanup' },
  {
    $setOnInsert: {
      taskId: 'db-cleanup',
      type: 'db-cleanup',
      status: 'active',
      interval: 86400000,  // 每天跑一次（24小時）
      config: {},
      lastRunAt: new Date(0),
      createdAt: new Date(),
    }
  },
  { upsert: true }
);
```

**建議寫在 ensure-indexes.js 的 `ensureAllIndexes` 裡**，這樣每次啟動自動確保任務存在：

```javascript
// 在 ensureAllIndexes 最後加上：
// 確保 db-cleanup 排程任務存在
await db.collection('scheduled_tasks').updateOne(
  { taskId: 'db-cleanup' },
  {
    $setOnInsert: {
      taskId: 'db-cleanup',
      type: 'db-cleanup',
      status: 'active',
      interval: 86400000,
      config: {},
      lastRunAt: new Date(0),
      createdAt: new Date(),
    }
  },
  { upsert: true }
);
console.log('[ensure-indexes] ✅ db-cleanup 排程任務已確認');
```

---

## Part 4：mongodb-schema.md 更新保留策略

把各 collection 的「保留策略」欄位更新為具體天數。例如：

- execution_logs：`90 天後由 db-cleanup 自動刪除`
- task_results：`30 天後由 db-cleanup 自動刪除`
- sub_tasks：`completed/failed 狀態 90 天後由 db-cleanup 自動刪除`
- 其餘同理

---

## Part 5：新功能 DB 評估 SOP

**新建 `docs/new-feature-db-checklist.md`**：

```markdown
# 新功能進 DB 評估 SOP

> 任何新功能如果會寫入 MongoDB，開發前必須回答以下問題。
> 回答完後更新 `docs/mongodb-schema.md`。

---

## 必答問題

### 1. 寫入哪個 Collection？
- 現有的 collection？還是需要新建？
- 新建的話，歸屬哪一類？（記憶 / 業務 / 任務 / 通知 / Agent / 可觀測性）

### 2. 資料量評估
- 每次操作寫入幾筆？
- 每天預估寫入量？
- 一年後預估總量？

### 3. 誰寫入、誰讀取？
- 哪個模組寫？（skill / agent / scheduler / bot-server）
- 哪個模組讀？
- 有沒有跨模組共用？

### 4. 需要什麼索引？
- 主要查詢模式是什麼？（by userId? by date? by status?）
- 加到 ensure-indexes.js

### 5. 保留策略
- 資料需要保留多久？
- 過期後：刪除 / 歸檔 / 標記？
- 加到 scheduler.js 的 db-cleanup handler

### 6. 帶 userId 嗎？
- 是個人資料？→ 必須帶 userId，查詢時過濾
- 是共用資料？→ 不帶 userId
- 多用戶時需要權限控制嗎？

### 7. 有敏感資訊嗎？
- 密碼、token、API key → 不能存
- 個人身份資訊 → 評估是否必要

---

## 範例

新功能：Execution Log（E6）

| 問題 | 回答 |
|---|---|
| Collection | execution_logs（新建） |
| 歸屬 | 可觀測性 |
| 每次寫入 | 1 筆 / 每次 skill 呼叫 |
| 每日預估 | 20-50 筆 |
| 一年後 | ~10,000-18,000 筆 |
| 寫入者 | tool-executor.js |
| 讀取者 | 管理介面（未來） |
| 索引 | timestamp, userId+timestamp, skill+status |
| 保留策略 | 90 天，db-cleanup 自動刪除 |
| userId | 帶 |
| 敏感資訊 | input 經 sanitizeInput 過濾 |

---

## 更新檢查表

完成以上評估後：
- [ ] 更新 `docs/mongodb-schema.md`（加新 collection 說明）
- [ ] 更新 `scripts/ensure-indexes.js`（加索引）
- [ ] 更新 `scripts/scheduler.js` 的 db-cleanup（加清理規則）
- [ ] 更新 `src/config.js`（如需要可配置的保留天數）
```

---

## 驗證

### 語法檢查

```bash
node -c scripts/scheduler.js && echo '✅ scheduler' || echo '❌'
node -c scripts/ensure-indexes.js && echo '✅ ensure-indexes' || echo '❌'
node -c src/config.js && echo '✅ config' || echo '❌'
```

### db-cleanup 排程任務檢查

```bash
node -e "
const mongo = require('./lib/mongodb-tools');
(async () => {
  const db = await mongo.getDb();
  const task = await db.collection('scheduled_tasks').findOne({ taskId: 'db-cleanup' });
  console.log('db-cleanup 任務:', task ? '✅ 存在' : '❌ 不存在');
  if (task) console.log('  status:', task.status, '| interval:', task.interval / 3600000, '小時');
  await mongo.close();
})();
"
```

### 手動跑一次清理確認不會誤刪

```bash
# 先看各 collection 的筆數
node -e "
const mongo = require('./lib/mongodb-tools');
(async () => {
  const db = await mongo.getDb();
  const collections = ['execution_logs', 'task_results', 'sub_tasks', 'notifications', 'reminders', 'archived_daily_logs', 'parsed_documents', 'conversations'];
  for (const name of collections) {
    const count = await db.collection(name).countDocuments();
    console.log(name + ':', count);
  }
  await mongo.close();
})();
"

# 目前資料都是最近的，跑 cleanup 應該不會刪任何東西
# 確認 deletedCount 全部是 0
```

### 文件檢查

```bash
test -f docs/new-feature-db-checklist.md && echo '✅ checklist 存在' || echo '❌'
grep 'db-cleanup' docs/mongodb-schema.md && echo '✅ schema 已更新' || echo '❌'
```

---

## 注意事項

1. **db-cleanup 是每天跑一次**（interval: 86400000），不是每分鐘。清理不需要太頻繁。
2. **conversations 的清理要小心**：它刪的是 `updatedAt` 超過 90 天的。如果用戶 90 天沒對話再回來，歷史會被清掉。但有記憶系統兜底，不會完全失憶。
3. **sub_tasks 只清 completed/failed**：in_progress 的不清，避免誤刪進行中的任務。
4. **reminders 只清 done/cancelled**：pending 的絕對不碰。
5. **第一次跑 cleanup 不會刪任何東西**，因為所有資料都是最近幾天的。等 30/90/365 天後才會開始有效果。
6. **new-feature-db-checklist.md 是給你自己看的**，每次加新功能寫 DB 之前先過一遍這份 checklist。
