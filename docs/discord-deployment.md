# 穗鈅助手 — Discord 三層 Channel 架構部署指南

> 本指南說明如何把穗鈅助手 Discord 通道部署到生產 server。
> 採「物理隔離」策略：多人對話問題靠 Discord 原生權限解決，程式層不做複合保護。

---

## 一、架構概念

Discord server 的 channel 依「bot 要不要理」分成三層：

```
Discord Server
│
├─ 💬 #一般聊天 / #研發討論     ← bot 完全忽略（團隊日常）
│
├─ 🤖 #bot-討論區               ← bot 完全忽略（人類交流心得）
│                                 大家可讀可寫，交流 bot 使用經驗
│
├─ 🔒 #bot-操作-{user-a}        ← user-a 專屬操作空間（bot 會回應）
│   ├─ user-a: 可讀、可寫
│   ├─ 其他人: 可讀、不可寫（旁觀學習用）
│   └─ admin:  可讀、可寫（偶爾接手／觀察）
│
├─ 🔒 #bot-操作-{user-b}        ← user-b 專屬操作空間（同上）
│
└─ DM                            ← 每人自己的機動管道
                                  敏感 / 移動 / 快速查詢
```

### 責任定位

| Channel 類型 | 定位 | bot 行為 | 典型用途 |
|-------------|------|---------|---------|
| 普通聊天 | 團隊日常 | ❌ 忽略 | 閒聊、工作討論 |
| `#bot-討論區` | 人類交流 | ❌ 忽略 | 「這功能怎麼用」「遇到這個 bug」 |
| `#bot-操作-{user}` | 個人工作空間 | ✅ 回應 | 建單、查信、設提醒 |
| DM | 個人私密空間 | ✅ 回應 | 敏感操作、快速查詢 |

### 關鍵特徵

- **每個操作 channel 只有一個主人**：不會多人搶話
- **操作 channel 半公開**：其他人可讀（透明 + 互相學習），但不可寫
- **admin 可進任何操作 channel**：但 bot 以發話者身分執行（訂單會記在 admin 名下）
- **DM 跟操作 channel session 各自獨立**：同一人在 DM 跟 channel 的對話歷史不共享（`session` 的 key 是 `(platform, chatId)` 複合鍵，channel ID 跟 DM 是不同 chatId）

---

## 二、初次部署步驟

### 前置

- 有 Discord server（或新建一個）
- 有 Discord Developer Portal 的 bot application
- server 上已有 admin 帳號

### Step 1：建立 bot application（若還沒）

1. 到 https://discord.com/developers/applications
2. New Application → 填名稱
3. Bot → Reset Token → 複製 Token（稍後貼到 `.env`）
4. Bot → Privileged Gateway Intents → 打開：
   - **MESSAGE CONTENT INTENT**（必要，否則讀不到訊息內容）
   - **SERVER MEMBERS INTENT**（若要讀成員資訊）

### Step 2：邀請 bot 進 server

1. OAuth2 → URL Generator
2. Scopes 勾：`bot`
3. Bot Permissions 勾：
   - Read Messages/View Channels
   - Send Messages
   - Attach Files
   - Read Message History
   - Use External Emojis（可選）
4. 複製底下產生的連結，用瀏覽器開、選 server、授權

### Step 3：建立三層 channel

在 server 裡依序建：

1. **`#bot-討論區`**（Text Channel）
   - 權限：@everyone 可讀可寫；bot 不邀請進來、或進來不給讀
   - **這個 channel 不進 .env 白名單**

2. **`#bot-操作-{admin}`**（給 admin 自己的操作空間）
   - 照 `docs/discord-add-user-sop.md` 的 Step 2 權限範本設
   - 記下 channel ID（右鍵 → Copy Channel ID，需先開 User Settings → Advanced → Developer Mode）

### Step 4：設定 .env

```bash
# Discord 基本
DISCORD_ENABLED=true
DISCORD_TOKEN=<Step 1 拿到的 Bot Token>

# Guild 白名單（建議只填自家 server，避免 bot 被誤邀到別處還會回）
DISCORD_ALLOWED_GUILDS=<server ID>

# Channel 白名單（逗號分隔；先填 admin 自己的操作 channel）
DISCORD_ALLOWED_CHANNELS=<admin 操作 channel ID>

# DM 白名單（可選；留空表示允許所有 DM）
DISCORD_ALLOWED_USERS=

# Admin 用戶 ID（逗號分隔；這些人會自動被 ensure 為系統 admin）
DISCORD_ADMIN_USERS=<你自己的 Discord User ID>
```

### Step 5：啟動 bot 驗證

```bash
# 啟動 bot（launchd 管理）
launchctl kickstart -k gui/$(id -u)/com.suiyao.agent

# 或直接跑（除錯用）
cd ~/sui-yao-agent && node src/bot-server.js
```

確認 log 看到：
- `✅ Discord admin 用戶已確認 (N)`
- `[discord-adapter] logged in as ...`

### Step 6：煙霧測試

- 在 admin 操作 channel 發「你好」→ bot 應回覆
- 在 `#bot-討論區` 發「你好」→ bot 應**不回**
- DM bot 發「你好」→ bot 應回覆

---

## 三、每個 channel 的權限範本

詳見 `docs/discord-add-user-sop.md`。簡述：

| Role / Member | View | Send | Read History | Attach | Add Reactions |
|---------------|------|------|--------------|--------|---------------|
| @everyone     | ✅   | ❌   | ✅           | ❌     | ❌            |
| {channel owner} | ✅ | ✅   | ✅           | ✅     | ✅            |
| Bot           | ✅   | ✅   | ✅           | ✅     | ✅            |
| @admin        | ✅   | ✅   | ✅           | ✅     | ✅            |

---

## 四、故障排除

### bot 在白名單 channel 不回

1. `.env` 的 `DISCORD_ALLOWED_CHANNELS` 有沒有正確的 channel ID？
2. bot 重啟了嗎？（改 .env 後要重啟）
3. bot 有沒有 View Channel 權限？
4. log 有沒有 error？

### bot 在非白名單 channel 卻回了

1. 那個 channel ID 有沒有誤加進 `DISCORD_ALLOWED_CHANNELS`？
2. DM 會回是正常行為（除非有設 `DISCORD_ALLOWED_USERS` 限制）

### 用戶說他發不出訊息到操作 channel

1. Discord 那邊 channel Permissions → 確認該用戶是 Send Messages ✅
2. 檢查 @everyone 有沒有被設成 Send Messages ❌（導致該用戶繼承不到）
3. 檢查該用戶有沒有被某個 role 擋住

### 其他人在別人的操作 channel 發得出訊息

1. 權限設錯。進 channel → 齒輪 → Permissions → @everyone 的 Send Messages 應為 ❌
2. 特例：admin 是應該可寫的；確認不是 admin 身分導致的誤判

### Discord admin 自動建立失敗

```bash
# 手動跑一次
node scripts/ensure-indexes.js

# 預期輸出
# [ensure-indexes] ✅ Discord admin 用戶已確認 (N)
```

若沒看到這行，檢查 `.env` 的 `DISCORD_ADMIN_USERS` 有沒有設定。

---

## 五、常見加單流程

1. 新用戶 DM bot → 收到「審核中」訊息
2. Telegram admin 收到審核通知（Discord → Telegram cross-platform 通知）
3. admin 用 **Dashboard** 或 **Telegram 按鈕** 核准（目前推薦 Dashboard，Telegram 按鈕對 Discord 用戶的核准邏輯還有 bug）
4. admin 依 `docs/discord-add-user-sop.md` 為該用戶建操作 channel、更新 `.env`、重啟 bot
5. 通知用戶 channel 已建好，附上 `docs/discord-user-guide.md` 讓他自學
