# 穗鈅助手（sui-yao-agent）

Telegram Bot + ERP 整合的訂單管理助手。

## 服務管理

本專案由 macOS launchd 管理，**不要用 pm2 或 `node` 直接啟動**，會造成重複 polling（兩個實例同時收 Telegram 訊息，導致重複處理）。

| 操作 | 指令 |
|------|------|
| 重啟 | `launchctl kickstart -k gui/$(id -u)/com.suiyao.agent` |
| 查看狀態 | `launchctl print gui/$(id -u)/com.suiyao.agent` |
| 查看 log | `tail -f ~/Library/Logs/sui-yao-agent.log` |

- plist 位置：`~/Library/LaunchAgents/sui-yao-agent.plist`
- Service label：`com.suiyao.agent`
- 設定 `KeepAlive: true`，進程掛掉會自動重啟

### Scheduler

另有排程服務 `com.suiyao.scheduler`，每 60 秒執行 `scripts/scheduler.js`。

| 操作 | 指令 |
|------|------|
| 重啟 | `launchctl kickstart -k gui/$(id -u)/com.suiyao.scheduler` |
| 查看 log | `tail -f ~/Library/Logs/sui-yao-scheduler.log` |
