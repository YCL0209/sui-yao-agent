# 階段 A：Bug 修復 + 調教

> 穗鈅助手獨立架構，已完成 Phase 1 ~ 3.5.3，目前準備部署前清理。
> 本階段完成後進入 Phase 5 部署。

---

## 專案位置

```
~/sui-yao-agent/
├── src/           # 核心模組（bot-server, session, memory-manager 等）
├── skills/        # skill 資料夾（check-email, set-reminder 等）
├── prompts/       # system prompt 組件（identity.md, rules.md, user.md, skills.md）
├── scripts/       # scheduler, heartbeat-guard, archive-daily-logs
├── deploy/        # LaunchAgent plist
└── .env           # 所有設定
```

---

## 本階段任務（3 項）

### A1：identity.md 調教 — 打招呼回覆太空泛

**問題**：用戶發「你好」時，穗鈅回覆過於空泛通用，沒有個性。

**檔案**：`prompts/identity.md`

**要求**：
- 先讀目前 identity.md 的內容
- 加入打招呼的應對指引，讓穗鈅回覆簡短、有個性、像一個熟悉的工作助手
- 不要長篇大論式的自我介紹，一兩句帶過就好
- 語氣：親切但專業，繁體中文
- 如果當天有日誌記錄，可以順帶提一下「今天已經幫你做了 X 件事」之類的

**驗證**：修改後在 Telegram 發「你好」，確認回覆不再空泛。

---

### A2：rules.md 精簡 — 目前規則越加越多

**問題**：rules.md 規則越加越多，需要統一精簡到 30 條以內，減少 token 佔用。

**檔案**：`prompts/rules.md`

**要求**：
- 先讀目前 rules.md，統計目前有幾條規則
- 合併重複或相似的規則
- 刪除已經過時或不再需要的規則（例如 OpenClaw 時期遺留的）
- 最終不超過 30 條
- 保留核心鐵則（金額確認、刪除確認、不主動編造等）
- 精簡後估算 token 數，跟之前比較

**驗證**：
```bash
# 計算規則數量
grep -c "^-\|^[0-9]" prompts/rules.md
# 預期：<= 30

# 確認 prompt-loader 仍能正常組裝
node -e "
  const pl = require('./src/prompt-loader');
  (async () => {
    const prompt = await pl.loadSystemPrompt('test-user', '你好');
    console.log('system prompt 長度:', prompt.length, '字');
  })();
"
```

---

### A3：debug log 清理 — 正式部署前關掉

**問題**：開發期間加了很多 debug log（flush check、memory search 等），正式部署前要清理。

**檔案**：主要在 `src/` 目錄下的核心模組

**要求**：
- 搜尋所有 `console.log` 中帶有 debug 性質的輸出（例如含 `[DEBUG]`、`[FLUSH]`、`flush check`、`trimHistory`、`cosine` 等關鍵字）
- 有兩種處理方式：
  1. 完全刪除不需要的 debug log
  2. 改為用環境變數 `DEBUG=true` 控制（如果未來偵錯還可能用到）
- 保留正常的營運 log（錯誤、啟動、skill 執行結果）
- 不要動 `test/` 目錄裡的 log

**建議搜尋指令**：
```bash
grep -rn "console.log" src/ --include="*.js" | grep -i "debug\|flush\|trim\|cosine\|embedding\|search.*score"
```

**驗證**：
```bash
# 啟動 bot-server，觀察是否還有多餘 debug 輸出
timeout 10 node src/bot-server.js 2>&1 | head -20
# 預期：只有啟動訊息和連線資訊，沒有 debug 輸出
```

---

## 完成標準

三項全部完成後，回報：
1. identity.md 修改了什麼
2. rules.md 從幾條精簡到幾條，token 減少多少
3. debug log 刪了幾處、改了幾處

然後準備進入階段 B（Phase 5 部署）。
