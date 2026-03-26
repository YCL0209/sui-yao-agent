# 階段 B：Phase 5 部署 + 切換

> 穗鈅助手獨立架構，已完成 Phase 1 ~ 3.5.3 + 階段 A（bug 修復、調教、debug log 清理）。
> 本階段目標：讓穗鈅正式常駐運行，停用 OpenClaw。

---

## 專案位置

```
~/sui-yao-agent/
├── src/           # 核心模組
├── skills/        # 6 個 skill
├── scripts/       # scheduler.js, heartbeat-guard.js, archive-daily-logs.js
├── prompts/       # identity.md, skills.md, rules.md, user.md
├── deploy/        # LaunchAgent plist（要在這個階段建立）
└── .env           # 所有設定
```

---

## 本階段任務（7 項）

### B1：LaunchAgent plist — bot-server 常駐

**目標**：bot-server 開機自動啟動、crash 自動重啟。

**檔案**：`deploy/sui-yao-agent.plist`

**要求**：
- Label: `com.suiyao.agent`
- 執行: `node /完整路徑/sui-yao-agent/src/bot-server.js`
- KeepAlive: true（crash 自動重啟）
- WorkingDirectory: 專案根目錄
- StandardOutPath / StandardErrorPath: 指向日誌檔案（例如 `~/Library/Logs/sui-yao-agent.log`）
- 環境變數: 確保 PATH 包含 node 的路徑

**安裝指令**：
```bash
cp deploy/sui-yao-agent.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/sui-yao-agent.plist
```

**驗證**：
```bash
launchctl list | grep sui-yao
# 預期：看到 com.suiyao.agent，PID 欄位有數字

pgrep -f "bot-server.js"
# 預期：有 PID
```

---

### B2：LaunchAgent plist — scheduler 定時跑

**目標**：scheduler.js 定時執行（查信、提醒觸發等）。

**檔案**：`deploy/sui-yao-scheduler.plist`

**要求**：
- Label: `com.suiyao.scheduler`
- 執行: `node /完整路徑/sui-yao-agent/scripts/scheduler.js`
- StartInterval: 60（每 60 秒跑一次）或用 StartCalendarInterval
- WorkingDirectory: 專案根目錄
- StandardOutPath / StandardErrorPath: 指向日誌檔案（例如 `~/Library/Logs/sui-yao-scheduler.log`）

**安裝指令**：
```bash
cp deploy/sui-yao-scheduler.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/sui-yao-scheduler.plist
```

**驗證**：
```bash
launchctl list | grep sui-yao
# 預期：看到 com.suiyao.agent 和 com.suiyao.scheduler
```

---

### B3：crash 自動重啟驗證

**目標**：手動 kill bot-server，確認自動重啟。

**測試步驟**：
```bash
# 1. 記錄目前 PID
pgrep -f "bot-server.js"

# 2. kill 它
kill $(pgrep -f "bot-server.js")

# 3. 等 5 秒
sleep 5

# 4. 確認新 PID
pgrep -f "bot-server.js"
# 預期：有新的 PID（跟步驟 1 不同）
```

**額外確認**：kill 後在 Telegram 發訊息，等幾秒後應該能收到回覆（重啟後恢復）。

---

### B4：日誌歸檔排程 — archive-daily-logs.js

**目標**：每天自動清理 30 天前的 daily_logs。

**檔案**：`scripts/archive-daily-logs.js`

**要求**：
- 先確認這個 script 存在且可執行
- 如果不存在，需要建立：
  - 連線 MongoDB
  - 查找 daily_logs collection 中 date 超過 30 天的文件
  - 可選：搬到 archived_daily_logs collection（保留但不載入）
  - 或直接刪除
  - 支援 `--dry-run` 參數（只顯示會處理幾筆，不實際執行）

**排程方式**（二選一）：
- 方式 A：加到 scheduler.js 裡，每天凌晨跑一次
- 方式 B：獨立一個 LaunchAgent plist，每天跑一次

**驗證**：
```bash
node scripts/archive-daily-logs.js --dry-run
# 預期：顯示「找到 X 筆超過 30 天的日誌」或「沒有需要歸檔的日誌」
```

---

### B5：正式停用 OpenClaw ✅ 已完成

OpenClaw 已確認完全停用，無需處理。

---

### B6：全功能最終驗證

**目標**：所有功能在正式部署環境下跑一遍。

在 Telegram 上逐項測試：

- [ ] 發「你好」→ 回覆簡短有個性（階段 A 調教後的效果）
- [ ] 發「你是誰」→ 符合 identity.md
- [ ] 發「查信」→ check-email skill 正常
- [ ] 發「提醒我明天早上 9 點開會」→ set-reminder skill 正常
- [ ] 發「記住：我偏好 A4 格式」→ 記憶寫入正常
- [ ] 發「我偏好什麼格式？」→ 能從記憶中回答
- [ ] 等待排程觸發（查信排程）→ 自動推送正常
- [ ] 發 reset 相關指令 → 對話清空但記憶保留

```bash
# 同時檢查日誌沒有異常
tail -20 ~/Library/Logs/sui-yao-agent.log
# 預期：正常營運 log，沒有 error 或 debug 輸出
```

---

### B7：錯誤通知確認

**目標**：確認 bot-server 出錯時能通知到 Telegram。

**檔案**：`src/error-notify.js`（如果存在的話）

**要求**：
- 先確認有沒有錯誤通知機制
- 如果有：測試一下
  ```bash
  node -e "
    const notify = require('./src/error-notify');
    notify.send('測試通知：部署完成').then(() => console.log('✅ 通知已發送'));
  "
  # 預期：Telegram 收到測試通知
  ```
- 如果沒有：建立一個簡單的錯誤通知函式
  - 當 bot-server 發生未捕獲的錯誤時，透過 Telegram Bot API 發送通知
  - 包含錯誤訊息和時間戳

---

## 執行順序建議

1. **B1 + B2**：先建立兩個 plist
2. **B3**：驗證 crash 重啟
3. **B6**：全功能驗證
4. **B4**：日誌歸檔（功能穩了再設排程）
5. **B7**：錯誤通知（最後補上監控）

---

## 完成標準

七項全部完成後，回報：
1. 兩個 LaunchAgent 狀態（launchctl list 輸出）
2. crash 重啟測試結果
3. 全功能驗證結果（哪些通過、哪些有問題）
4. 錯誤通知測試結果

全部通過後，穗鈅助手正式上線運行。
接下來進入階段 B2（建立訂單功能驗證）。
