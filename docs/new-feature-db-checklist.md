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
- 加到 `scripts/ensure-indexes.js`

### 5. 保留策略
- 資料需要保留多久？
- 過期後：刪除 / 歸檔 / 標記？
- 加到 `scripts/scheduler.js` 的 db-cleanup handler

### 6. 帶 userId 嗎？
- 是個人資料？→ 必須帶 userId，查詢時過濾
- 是共用資料？→ 不帶 userId
- 多用戶時需要權限控制嗎？

### 7. 有敏感資訊嗎？
- 密碼、token、API key → 不能存
- 個人身份資訊 → 評估是否必要
- 寫入前用 `sanitizeInput`（tool-executor.js）或自己的清理函式

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
- [ ] 更新 `scripts/scheduler.js` 的 db-cleanup handler（加清理規則）
- [ ] 更新 `src/config.js` 的 cleanup 區塊（如需要可配置的保留天數）
