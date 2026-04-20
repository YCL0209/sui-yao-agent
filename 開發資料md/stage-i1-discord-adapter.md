# 階段 I1：Discord 雙通道 Adapter 架構（完成紀錄）

> 已 ✅ COMPLETED（2026-04-20）
>
> 原始規格散落於多輪對話與實作時的計劃筆記中；本檔案僅作為收尾紀錄，說明實際落地的範圍與差異。細節依以 **git log** 與 **實際 code** 為準。

---

## 目標

把 bot 從「只能接 Telegram」升級成「可同時接多個通道（Telegram + Discord）」，且後續新增通道（LINE 等）只要實作 `MessageAdapter` 介面即可。

---

## 落地的 12 個 commit（main 分支）

```
e13f2c3  dashboard: 驗證碼依 user.platform 分派 adapter (Step 12)
2fe8620  adapters: discord-adapter 文字 + button + 附件 (Step 10+11)
c9633a1  adapters: telegram-adapter + bot-server slim down (Step 9)
d9e9e6c  auth: 支援 platform 參數 + chatId 統一 String
b04f789  session: loadHistory/saveHistory/clearHistory 用 (platform, chatId) 複合 key
2700616  orchestrator: 從 bot-server 抽出 agent loop 與相關 helper
68aca8b  adapters: MessageAdapter 抽象介面
22a48b7  config: 加 discord 區塊 + 至少一通道啟用驗證
2070d44  scripts: ensure-indexes 改用 (platform, chatId) 複合 key
f30e5e9  db: migrate-add-platform 一次性遷移腳本
bb2753f  chore: install discord.js@^14
```

---

## 實作與原規格的差異

1. **adapter 介面命名**：`sendReply` 最終命名為 `sendText`（語意更清楚，與 `sendImages` / `sendVoice` 對齊）。
2. **bot-server.js 行數**：原估 ~150 行，實際 80 行（orchestrator + adapter 拆得更徹底）。
3. **AgentReply 格式**：採漸進式遷移，agents 繼續回傳 `{ reply_markup: { inline_keyboard } }`，由 adapter 層 `_legacyToButtons` 自動轉譯為新的 `buttons` 陣列格式。
4. **Discord admin 自動建立**：stage-i1 未做，由 stage-i2 Commit 2 補上。
5. **`orchestrator._handleNewUser` broadcast**：落地時 `platform` 沿用申請者 platform，而 `chatId` 寫死 Telegram adminChatId，造成 Discord 新用戶申請時 admin 收不到通知的 bug。由 stage-i2 Commit 4 修復。
6. **`auth.approveUser` 跨平台核准**：`src/adapters/telegram-adapter.js` 呼叫時第一參數硬寫 `'telegram'`，Discord 用戶核准時會失敗。留待 stage-i3（或 Dashboard 用戶管理 UI 補上的替代路徑）處理。

---

## 驗證紀錄

所有 Telegram + Discord 全功能回歸測試於 2026-04-20 前通過：
- 建單到 PDF（Telegram / Discord DM / Discord channel）
- check-email / set-reminder / 記憶存取
- Dashboard 雙平台登入（驗證碼分派）
- 新用戶申請（Telegram 路徑，Discord 路徑 bug 未發現 → 進入 stage-i2）
