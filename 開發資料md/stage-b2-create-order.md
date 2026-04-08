# 階段 B2：建立訂單 — 互動式按鈕流程

> 穗鈅助手已完成部署（Phase 5），本階段改造 create-order skill，加入 Telegram inline button 互動流程。

---

## 專案位置

```
~/sui-yao-agent/
├── src/bot-server.js           # 核心，處理 callback_query
├── skills/create-order/index.js # 建單 skill（主要修改對象）
├── lib/erp-client/index.js      # ERP JWT 認證 + API 呼叫（已完成，不用動）
└── .env                         # ERP 四個變數已設定
```

---

## 目標

將 create-order 改為互動式流程，用 Telegram inline keyboard 引導用戶逐步建單。支援兩種模式：

1. **引導模式**：用戶只說「建立訂單」→ 按鈕引導每個步驟
2. **智慧模式**：用戶給完整資訊「幫王大明建一張銷售單，A4紙 100包 150元」→ 直接跳到確認步驟

---

## 互動流程

### 完整流程（引導模式）

```
用戶：「建立訂單」（資訊不足）
        │
        ▼
┌─────────────────────────────────┐
│ 請選擇訂單類型：                   │
│ [📦 銷售單]  [🛒 採購單]          │
└─────────────────────────────────┘
        │ 用戶按按鈕
        ▼
穗鈅：「請輸入客戶名稱」
        │ 用戶打字：王大明
        ▼
ERP 搜尋客戶
  ├─ 找到 1 筆 → 自動帶入
  ├─ 找到多筆 → 按鈕選擇
  │   ┌────────────────────────────┐
  │   │ 找到多位客戶：               │
  │   │ [王大明 - 大明企業]          │
  │   │ [王大明 - 大明貿易]          │
  │   └────────────────────────────┘
  └─ 找不到 → 提示重新輸入
        │
        ▼
穗鈅：「請輸入品項（品名、數量、單價）」
        │ 用戶打字：A4紙 100包 150元
        ▼
┌─────────────────────────────────┐
│ 📋 訂單確認：                     │
│                                  │
│ 類型：銷售單                      │
│ 客戶：王大明（大明企業）            │
│ 品項：A4紙 x100 @NT$150          │
│ 合計：NT$ 15,000                 │
│                                  │
│ [✅ 確認建單] [✏️ 修改] [❌ 取消]  │
└─────────────────────────────────┘
        │ 用戶按確認
        ▼
送 ERP API 建單 → 取得訂單編號
        │
        ▼
┌─────────────────────────────────┐
│ ✅ 訂單 ORD-2026-0325 建立成功！  │
│                                  │
│ 需要生成單據嗎？                   │
│ [📄 報價單] [📄 銷貨單] [⏭️ 不用]  │
└─────────────────────────────────┘
```

### 智慧模式（資訊完整時跳過）

```
用戶：「幫王大明建一張銷售單，A4紙 100包 150元」
        │
        ▼
LLM 解析出：類型=銷售單, 客戶=王大明, 品項=A4紙 x100 @150
        │
        ▼
ERP 搜尋客戶「王大明」→ 找到
        │
        ▼
直接跳到「訂單確認」步驟（顯示摘要 + 確認/修改/取消按鈕）
```

---

## 技術實作要點

### 1. Telegram Inline Keyboard

使用 `node-telegram-bot-api` 的 inline keyboard：

```javascript
bot.sendMessage(chatId, '請選擇訂單類型：', {
  reply_markup: {
    inline_keyboard: [
      [
        { text: '📦 銷售單', callback_data: 'order_type:sales' },
        { text: '🛒 採購單', callback_data: 'order_type:purchase' }
      ]
    ]
  }
});
```

### 2. callback_data 格式建議

```
order_type:sales          → 選擇銷售單
order_type:purchase       → 選擇採購單
order_customer:{id}       → 選擇客戶（多筆時）
order_confirm:{sessionKey} → 確認建單
order_edit:{sessionKey}    → 修改訂單
order_cancel:{sessionKey}  → 取消
order_pdf:quotation:{orderId}  → 生成報價單
order_pdf:sales:{orderId}      → 生成銷貨單
order_pdf:skip                 → 不需要單據
```

### 3. 建單 Session 狀態管理

需要在記憶體中（或 MongoDB）暫存每個用戶的建單進度：

```javascript
// 建議用 Map 暫存，建單完成或超時後清除
const orderSessions = new Map();

// 結構：
orderSessions.set(chatId, {
  step: 'type' | 'customer' | 'items' | 'confirm',
  type: 'sales' | 'purchase' | null,
  customer: { id, name, company } | null,
  items: [{ name, quantity, price }] | [],
  createdAt: Date.now(),
  // 超時自動清除（例如 10 分鐘）
});
```

### 4. bot-server.js 需要處理的 callback_query

確認 `bot-server.js` 的 callback_query handler 能辨識 `order_*` 開頭的 callback_data，並轉發給 create-order skill 處理。

### 5. 智慧判斷邏輯

create-order 的 `run()` 接到參數時：
- 有 type + customer + items → 跳到確認步驟
- 有 type + customer，沒 items → 從「輸入品項」開始
- 有 type，沒 customer → 從「輸入客戶」開始
- 什麼都沒有 → 從「選擇類型」開始

---

## 已知問題需修復

### claudeApi 傳 null（優先修復）

`create-order/index.js` 第 425 行附近，`run()` 被呼叫時 `claudeApi` 參數傳 `null`。

影響：用戶用自然語言描述訂單時（「幫王大明建一張銷售單，A4紙 100包」），只能靠 `simpleParseOrder` 正則解析，很脆弱。

修復：確保 `tool-executor.js` 呼叫 `run()` 時傳入可用的 LLM adapter，讓 create-order 能用 LLM 解析自然語言。

---

## 訂單類型對照

| 中文 | callback_data | ERP 前綴 |
|------|---------------|---------|
| 銷售單 | sales | ORD- |
| 採購單 | purchase | PUR- |

---

## 相關 Skill

建單成功後可能連動：
- **generate-pdf**：生成報價單/銷貨單 PDF
- **print-label**：列印標籤（獨立流程，不在本階段範圍）

---

## 驗證項目

### 引導模式測試
1. 發「建立訂單」→ 出現類型選擇按鈕
2. 按「銷售單」→ 提示輸入客戶
3. 輸入客戶名 → ERP 搜尋成功，進入品項步驟
4. 輸入品項 → 顯示訂單摘要 + 確認按鈕
5. 按確認 → ERP 建單成功，顯示訂單編號 + PDF 選項
6. 按取消 → 取消建單，清除 session

### 智慧模式測試
7. 發「幫王大明建一張銷售單，A4紙 100包 150元」→ 直接跳到確認步驟
8. 按確認 → 建單成功

### 邊界測試
9. 搜尋客戶找到多筆 → 出現選擇按鈕
10. 搜尋客戶找不到 → 提示重新輸入
11. 超時未操作（10 分鐘）→ session 自動清除
12. 建單過程中發其他訊息 → 不影響建單 session

---

## 完成標準

12 項驗證全部通過後，回報：
1. 引導模式全流程截圖或描述
2. 智慧模式跳步截圖
3. ERP 實際建單結果
4. claudeApi 修復狀態
