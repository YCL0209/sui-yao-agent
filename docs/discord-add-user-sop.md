# 穗鈅助手 — Discord 新用戶 Onboarding SOP

> 當有新用戶通過審核，依此 SOP 為其建立操作 channel。
> 總耗時：約 7-10 分鐘。

---

## 前置

- [ ] 已在 Dashboard / Telegram 按下「核准」
- [ ] 取得用戶 Discord username：`_______`
- [ ] 取得用戶 Discord ID：`_______`（在 Discord 右鍵 user → Copy User ID；需先在 User Settings → Advanced 開啟 Developer Mode）

---

## Step 1：建立 Channel（約 2 分鐘）

1. Discord 左側 channel list → 右鍵「Create Channel」
2. **名稱**：`bot-操作-{username}`（全小寫、用 dash 分隔）
3. **類型**：Text Channel
4. **Category**：放在「操作區」分類下（如果有規劃）

---

## Step 2：設定權限（約 3 分鐘）

進入 channel → 齒輪（Edit Channel） → **Permissions**

### @everyone 的預設（該 channel overrides）

| 權限 | 設定 |
|------|------|
| View Channel | ✅ |
| Send Messages | ❌ |
| Read Message History | ✅ |
| Attach Files | ❌ |
| Add Reactions | ❌ |

### 加入此 channel owner（該用戶本人）

| 權限 | 設定 |
|------|------|
| View Channel | ✅ |
| Send Messages | ✅ |
| Read Message History | ✅ |
| Attach Files | ✅ |
| Add Reactions | ✅ |

### Bot role

| 權限 | 設定 |
|------|------|
| View Channel | ✅ |
| Send Messages | ✅ |
| Read Message History | ✅ |
| Attach Files | ✅ |

### @admin role（若有）

| 權限 | 設定 |
|------|------|
| View Channel | ✅ |
| Send Messages | ✅ |
| Read Message History | ✅ |
| Attach Files | ✅ |

---

## Step 3：取得 Channel ID（約 30 秒）

1. 確認 Developer Mode 已開啟（User Settings → Advanced）
2. 右鍵新建的 channel → **Copy Channel ID**
3. 貼到下面暫存：

```
Channel ID: ______________________________
```

---

## Step 4：更新 .env（約 1 分鐘）

```bash
cd ~/sui-yao-agent
# 用你習慣的編輯器
vim .env
```

在 `DISCORD_ALLOWED_CHANNELS=` 後面加上剛複製的 ID（逗號分隔現有 ID）：

```
# 範例
DISCORD_ALLOWED_CHANNELS=111222333444,555666777888,<新的 channel ID>
```

存檔離開。

---

## Step 5：重啟 Bot（約 30 秒）

```bash
# launchd 管理的做法（推薦，kickstart 會重新載入 .env）
launchctl kickstart -k gui/$(id -u)/com.suiyao.agent
```

或者暴力殺 process 等 launchd 自動重啟：

```bash
pkill -f 'node src/bot-server.js'
```

---

## Step 6：驗證（約 1 分鐘）

1. 查 bot log 確認啟動成功：
   ```bash
   tail -f ~/sui-yao-agent/logs/sui-yao-agent.log
   # 預期看到：[discord-adapter] logged in as ...
   ```

2. 你（admin）進新 channel，發「你好」→ bot 應回覆

3. 請用戶本人測試或用小號測試 → bot 應回覆

4. 從 `#bot-討論區` 發「你好」→ bot 應**不回**（白名單外）

---

## Step 7：通知用戶（約 30 秒）

DM 用戶、或在 `#bot-討論區` tag 他：

> Hi {name}，你的操作 channel 已建好：<#channel_id>
>
> 請到那邊跟 bot 互動，常見功能與注意事項見 `docs/discord-user-guide.md`（我可以截圖傳給你）。
>
> 有問題可以在 `#bot-討論區` 問。

---

## 常見問題

### 權限設錯：bot 看得到 channel 但回不了

見 `docs/discord-deployment.md` 的「四、故障排除」。

### Channel ID 複製錯

bot log 會顯示對應的訊息被忽略。比對 `.env` 裡的 ID 跟實際 channel ID（右鍵該 channel 重新 Copy ID）。

### 用戶一直收到「審核中」訊息

- 他的 user 狀態可能還是 pending。查 Dashboard 或 mongosh：
  ```bash
  mongosh "$MONGO_URI" --eval "db.users.findOne({platform:'discord', chatId:'<用戶 ID>'})"
  ```
- 若 `status` 仍是 `pending`，回到審核流程按「核准」

### 用戶可以發訊息但其他用戶也可以

Step 2 的權限設錯了。進 channel Permissions，確認 @everyone 的 Send Messages 是 ❌。

---

## 從手動到未來自動化

目前這份 SOP 是手動流程（用戶量少、ROI 考量）。未來若要升級可考慮：

- **半自動**：bot 接收 `/bind-channel` slash command，admin 在 Discord 裡直接綁定 channel
- **全自動**：bot 用 Discord API 自動建 channel + 設權限（需要額外 permission）

stage-i2 階段不做這些，留給未來擴展。
