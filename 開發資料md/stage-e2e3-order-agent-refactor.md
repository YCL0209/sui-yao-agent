# 階段 E2+E3：主 Agent 改造 + 訂單 Agent 拆分

> E1 已完成：agent-registry、policy-engine、sub-agent-executor、interactive-session 四個基礎模組就位（在 feature/sub-agent 分支）。
> 本階段將 bot-server.js 接入 InteractiveSessionManager，並把 create-order/index.js 的 918 行拆成「agent（互動決策）+ skill（純工具）」。
> **這是子 agent 架構的第一次實戰驗證，做完後所有建單流程必須照常運作。**

---

## 專案位置

```
~/sui-yao-agent/  (feature/sub-agent 分支)
├── src/
│   ├── bot-server.js              # 🔧 修改：callback 路由改 ISM，session 攔截改 ISM
│   ├── agents/                    # ⚡ 新建目錄
│   │   └── order-agent.js         # ⚡ 新建：訂單互動 agent（從 create-order 拆出來的互動邏輯）
│   ├── interactive-session.js     # E1 已建，本階段 registerHandler 接入 order agent
│   ├── agent-registry.js          # E1 已建，本階段註冊 order agent
│   ├── policy-engine.js           # E1 已建，不動
│   ├── sub-agent-executor.js      # E1 已建，本階段暫不接入（E2+E3 先做互動式，非 LLM 驅動）
│   └── ...其他 src 檔案不動
├── skills/
│   └── create-order/index.js      # 🔧 精簡：刪除互動邏輯，保留純工具函式
└── .env                           # 不動
```

---

## 重要設計決策

### 為什麼 E2+E3 合在一起做

bot-server.js 的 callback 路由目前硬寫 `order_` 前綴，如果只改路由不改 create-order，或只改 create-order 不改路由，中間狀態會壞掉。兩個一起改，一次切換。

### 為什麼訂單 Agent 不走 sub-agent-executor

訂單建立是**互動式流程**（按鈕 → 等用戶 → 按鈕 → 等用戶），不是一次性的 LLM 任務。sub-agent-executor 適合「給一個 briefing，跑完回傳結果」的場景。訂單流程需要的是 InteractiveSessionManager 的 onStart/onCallback/onTextInput 模式。

未來如果有「全自動建單」（例如排程從 Email 解析後直接建單，不需要人工確認），那才走 sub-agent-executor。

### callback_data 格式遷移

```
現在：order_type:sales, order_confirm, order_cancel, order_pdf:quotation:ORD-001
之後：order:type:sales,  order:confirm, order:cancel,  order:pdf:quotation:ORD-001
       ↑                  ↑               ↑               ↑
      agentName          action          action           action:payload:payload
```

統一格式：`{agentName}:{action}:{payload...}`，由 InteractiveSessionManager 自動解析。

---

## 步驟一覽

```
Step 1：建立 src/agents/ 目錄 + order-agent.js
Step 2：精簡 skills/create-order/index.js
Step 3：改 bot-server.js 接入 ISM
Step 4：整合測試
```

---

## Step 1：建立 src/agents/order-agent.js

**這個檔案的職責是：所有訂單相關的互動流程和面向用戶的文字。**

### 1.1 建立目錄

```bash
mkdir -p ~/sui-yao-agent/src/agents
```

### 1.2 order-agent.js 完整規格

這個 agent 要做的事情：

1. 用 InteractiveSessionManager 的 `registerHandler` 註冊自己
2. 管理建單的互動流程（type → customer → items → confirm → 建單 → PDF）
3. 呼叫 `skills/create-order/index.js` 的純工具函式來做實際操作
4. 所有面向用戶的文字（按鈕文字、提示訊息、錯誤訊息）都在這裡

```javascript
/**
 * 穗鈅助手 — 訂單互動 Agent
 *
 * 管理建單的互動流程（按鈕 + 文字輸入）。
 * 互動邏輯在這裡，ERP 呼叫和資料處理在 skills/create-order。
 *
 * callback_data 格式：order:{action}:{payload}
 *
 * @version 1.0.0
 */

const ism = require('../interactive-session');
const agentRegistry = require('../agent-registry');
const orderSkill = require('../../skills/create-order');

// ========================================
// 面向用戶的文字（調教在這裡改）
// ========================================

const MESSAGES = {
  askType: '請選擇訂單類型：',
  askCustomer: '請輸入客戶名稱：',
  askItems: '請輸入品項（品名、數量、單價）\n\n範例：\n• A4紙 x100 @150\n• 影印紙x50@120, 資料夾x20@35',
  cancelled: '❌ 訂單建立已取消。',
  expired: '建單流程已過期，請重新開始。',
  unknownAction: '未知的操作。',
  parseItemsFailed: '無法解析品項。請使用格式：\n品名 x數量 @單價\n\n範例：A4紙 x100 @150',
  customerNotFound: (name) => `找不到客戶「${name}」`,
  customerCreated: (name) => `✅ 已建立客戶「${name}」`,
  customerSelected: (name, company) => `✅ 客戶：${name}${company ? `（${company}）` : ''}`,
  pdfSkip: '好的，如需要再告訴我。',
  orderCreated: (orderNumber) => `✅ 訂單 ${orderNumber} 建立成功！\n\n需要生成單據嗎？`,
  orderFailed: (reason) => `建立訂單失敗：${reason}`,
  pdfFailed: (reason) => `PDF 生成失敗：${reason}`,
  customerCreateFailed: (reason) => `建立客戶失敗：${reason}`,
  erpConnectFailed: 'ERP 連線失敗',
  amountWarning: (total) => `⚠️ 金額 NT$${total.toLocaleString()} 超過 50,000，請老闆確認`,
};

// ========================================
// 按鈕模板
// ========================================

function typeButtons() {
  return {
    inline_keyboard: [
      [
        { text: '📦 銷售單', callback_data: 'order:type:sales' },
        { text: '🛒 採購單', callback_data: 'order:type:purchase' },
      ],
    ],
  };
}

function confirmButtons() {
  return {
    inline_keyboard: [
      [
        { text: '✅ 確認建單', callback_data: 'order:confirm' },
        { text: '❌ 取消', callback_data: 'order:cancel' },
      ],
    ],
  };
}

function customerNotFoundButtons(name) {
  return {
    inline_keyboard: [
      [{ text: `✅ 建立「${name}」`, callback_data: 'order:newcustomer' }],
      [
        { text: '✏️ 重新輸入', callback_data: 'order:retrycustomer' },
        { text: '❌ 取消', callback_data: 'order:cancel' },
      ],
    ],
  };
}

function customerChoiceButtons(matches) {
  const buttons = matches.slice(0, 5).map(c => [{
    text: c.company ? `${c.name}（${c.company}）` : c.name,
    callback_data: `order:customer:${c._id}`,
  }]);
  buttons.push([{ text: '❌ 取消建單', callback_data: 'order:cancel' }]);
  return { inline_keyboard: buttons };
}

function pdfButtons(orderNumber) {
  return {
    inline_keyboard: [
      [
        { text: '📄 報價單', callback_data: `order:pdf:quotation:${orderNumber}` },
        { text: '📄 銷貨單', callback_data: `order:pdf:sales:${orderNumber}` },
      ],
      [{ text: '⏭️ 不用', callback_data: 'order:pdf:skip' }],
    ],
  };
}

// ========================================
// 訂單確認摘要（格式化）
// ========================================

function formatOrderSummary(sess) {
  const data = sess.data;
  const typeName = data.type === 'sales' ? '銷售單' : data.type === 'quotation' ? '報價單' : '採購單';
  const customerName = data.customer?.name || '未知';
  const company = data.customer?.company ? `（${data.customer.company}）` : '';

  const itemLines = (data.items || []).map(i => {
    const code = i.productCode ? `[${i.productCode}] ` : '';
    const unit = i.unit || '個';
    const priceStr = i.price > 0 ? ` @NT$${i.price}/${unit}` : ' (價格未填)';
    const totalStr = i.price > 0 ? ` = NT$${i.quantity * i.price}` : '';
    const displayName = i.matchedName || i.originalName || i.name;
    if (i.matchedName && i.originalName && i.originalName !== i.matchedName) {
      return `  • ${i.originalName} → 比對為 ${code}${i.matchedName} ×${i.quantity}${priceStr}${totalStr}\n    ⚠️ 品名不完全一致，請確認`;
    }
    return `  • ${code}${displayName} ×${i.quantity}${priceStr}${totalStr}`;
  }).join('\n');

  const total = (data.items || []).reduce((s, i) => s + i.quantity * (i.price || 0), 0);

  return `📋 訂單確認：\n\n`
    + `類型：${typeName}\n`
    + `客戶：${customerName}${company}\n`
    + `品項：\n${itemLines}\n`
    + `合計：NT$ ${total.toLocaleString()}${total === 0 ? ' (待補價格)' : ''}\n`;
}

// ========================================
// InteractiveSession Handler
// ========================================

const orderHandler = {

  ttl: 10 * 60 * 1000, // 10 分鐘

  // ---- 開始互動 ----
  async onStart({ session, userId, chatId }) {
    // session.data 裡可能有 initialData（從 LLM 解析或 PDF 解析帶入）
    const parsed = session.data.parsed || null;

    if (parsed) {
      // 智慧模式：有解析結果，跳到對應步驟
      return await startFromParsed(session, parsed, { userId, chatId });
    }

    // 引導模式：從類型選擇開始
    session.step = 'type';
    return {
      text: MESSAGES.askType,
      reply_markup: typeButtons(),
    };
  },

  // ---- 按鈕回調 ----
  async onCallback(session, action, payload, context) {

    // cancel — 任何階段都可以取消
    if (action === 'cancel') {
      return { text: MESSAGES.cancelled, done: true };
    }

    // type:{sales|purchase} — 選擇訂單類型
    if (action === 'type') {
      session.data.type = payload; // 'sales' or 'purchase'
      session.step = 'customer';
      return { text: MESSAGES.askCustomer };
    }

    // customer:{id} — 從多筆客戶中選擇
    if (action === 'customer') {
      const customerId = payload;
      const customer = (session.data._customerMatches || []).find(c => c._id === customerId);
      if (!customer) {
        return { text: MESSAGES.expired };
      }
      session.data.customer = customer;
      delete session.data._customerMatches;
      session.step = 'items';

      // 如果已有品項（從 PDF 帶入），直接跳確認
      if (session.data.items && session.data.items.length > 0) {
        session.step = 'confirm';
        const summary = formatOrderSummary(session);
        return { text: summary, reply_markup: confirmButtons() };
      }
      return { text: MESSAGES.askItems };
    }

    // newcustomer — 在 ERP 建立新客戶
    if (action === 'newcustomer') {
      const pendingName = session.data._pendingCustomerName;
      if (!pendingName) {
        return { text: MESSAGES.expired };
      }
      try {
        const newCustomer = await orderSkill.createCustomerInERP(pendingName);
        session.data.customer = newCustomer;
        delete session.data._pendingCustomerName;

        // 如果已有品項，直接跳確認
        if (session.data.items && session.data.items.length > 0) {
          session.step = 'confirm';
          const summary = formatOrderSummary(session);
          return {
            text: MESSAGES.customerCreated(pendingName) + '\n\n' + summary,
            reply_markup: confirmButtons(),
          };
        }
        session.step = 'items';
        return { text: MESSAGES.customerCreated(pendingName) + '\n\n' + MESSAGES.askItems };
      } catch (err) {
        return { text: MESSAGES.customerCreateFailed(err.message) };
      }
    }

    // retrycustomer — 重新輸入客戶
    if (action === 'retrycustomer') {
      delete session.data._pendingCustomerName;
      session.step = 'customer';
      return { text: MESSAGES.askCustomer };
    }

    // confirm — 確認建單，送 ERP
    if (action === 'confirm') {
      try {
        const result = await orderSkill.submitOrder(session.data);
        const orderNumber = result.orderNumber;
        return {
          text: MESSAGES.orderCreated(orderNumber),
          reply_markup: pdfButtons(orderNumber),
          done: true, // 建單完成，清除 session
        };
      } catch (err) {
        return { text: MESSAGES.orderFailed(err.message) };
      }
    }

    // pdf:{type}:{orderNumber} — 建單後生成 PDF
    if (action === 'pdf') {
      const pdfType = payload.split(':')[0];
      const orderRef = payload.split(':').slice(1).join(':');

      if (pdfType === 'skip') {
        return { text: MESSAGES.pdfSkip, done: true };
      }

      try {
        const pdfResult = await orderSkill.generatePDF(orderRef, pdfType, context);
        if (pdfResult && pdfResult.localPaths) {
          return {
            text: pdfResult.text,
            images: pdfResult.localPaths,
            done: true,
          };
        }
        return { text: pdfResult?.text || 'PDF 生成完成', done: true };
      } catch (err) {
        return { text: MESSAGES.pdfFailed(err.message), done: true };
      }
    }

    return { text: MESSAGES.unknownAction };
  },

  // ---- 文字輸入 ----
  async onTextInput(session, text, context) {
    const trimmed = text.trim();

    // 任何步驟都可以打「取消」
    if (/^(取消|cancel)$/i.test(trimmed)) {
      return { text: MESSAGES.cancelled, done: true };
    }

    // customer 步驟：搜尋客戶
    if (session.step === 'customer') {
      const result = await orderSkill.searchCustomers(trimmed);

      if (!result.success) {
        return { text: MESSAGES.erpConnectFailed };
      }

      if (result.matches.length === 0) {
        session.data._pendingCustomerName = trimmed;
        return {
          text: MESSAGES.customerNotFound(trimmed),
          reply_markup: customerNotFoundButtons(trimmed),
        };
      }

      if (result.matches.length === 1) {
        session.data.customer = result.matches[0];
        session.step = 'items';
        const c = result.matches[0];
        const prefix = MESSAGES.customerSelected(c.name, c.company);

        if (session.data.items && session.data.items.length > 0) {
          session.step = 'confirm';
          const summary = formatOrderSummary(session);
          return { text: prefix + '\n\n' + summary, reply_markup: confirmButtons() };
        }
        return { text: prefix + '\n\n' + MESSAGES.askItems };
      }

      // 多筆
      session.data._customerMatches = result.matches;
      return {
        text: '找到多位客戶，請選擇：',
        reply_markup: customerChoiceButtons(result.matches),
      };
    }

    // items 步驟：解析品項
    if (session.step === 'items') {
      const items = orderSkill.parseItems(trimmed);

      if (items.length === 0) {
        return { text: MESSAGES.parseItemsFailed };
      }

      // RAG 產品比對
      const enrichedItems = await orderSkill.enrichItemsWithRAG(items);
      session.data.items = enrichedItems;
      session.step = 'confirm';
      return {
        text: formatOrderSummary(session),
        reply_markup: confirmButtons(),
      };
    }

    return null; // 不攔截，交回主流程
  },

  // ---- 超時 ----
  async onTimeout(session) {
    console.log(`[order-agent] Session 超時: chat=${session.chatId}`);
  },
};

// ========================================
// 從解析結果開始（PDF/圖片/智慧模式用）
// ========================================

async function startFromParsed(session, parsed, context) {
  // 設定已知的資料
  session.data.type = parsed.type || null;
  session.data.note = parsed.note || null;

  // 品項 RAG 比對
  if (parsed.items && parsed.items.length > 0) {
    session.data.items = await orderSkill.enrichItemsWithRAG(parsed.items);
  }

  // 查客戶
  if (parsed.customerName) {
    const result = await orderSkill.searchCustomers(parsed.customerName);
    if (result.success && result.matches.length >= 1) {
      session.data.customer = result.matches[0];
    }
  }

  // 判斷缺什麼，跳到對應步驟
  if (session.data.customer && session.data.items?.length > 0 && session.data.type) {
    session.step = 'confirm';
    return {
      text: formatOrderSummary(session),
      reply_markup: confirmButtons(),
    };
  }

  // 組裝已解析摘要
  const typeName = session.data.type === 'sales' ? '銷售單' : session.data.type === 'purchase' ? '採購單' : session.data.type === 'quotation' ? '報價單' : '未知';
  const itemsSummary = (session.data.items || []).length > 0
    ? (session.data.items || []).map(i => `  • ${i.name || i.originalName} ×${i.quantity || 1} @${i.price || '?'}`).join('\n')
    : '（無品項）';
  const summary = `📄 已解析出：\n類型：${typeName}\n`
    + (parsed.customerName ? `文件客戶：${parsed.customerName}\n` : '')
    + (session.data.items?.length > 0 ? `品項：\n${itemsSummary}\n` : '')
    + '\n';

  if (!session.data.type) {
    session.step = 'type';
    return { text: summary + MESSAGES.askType, reply_markup: typeButtons() };
  }

  if (!session.data.customer) {
    session.step = 'customer';
    if (parsed.customerName) {
      session.data._pendingCustomerName = parsed.customerName;
      return {
        text: summary + MESSAGES.customerNotFound(parsed.customerName),
        reply_markup: customerNotFoundButtons(parsed.customerName),
      };
    }
    return { text: summary + MESSAGES.askCustomer };
  }

  session.step = 'items';
  return { text: summary + MESSAGES.askItems };
}

// ========================================
// 註冊
// ========================================

// 註冊到 InteractiveSessionManager
ism.registerHandler('order', orderHandler);

// 註冊到 AgentRegistry（未來 sub-agent-executor 用）
agentRegistry.register({
  name: 'order',
  description: '訂單建立互動 agent — 引導用戶逐步建單',
  systemPrompt: '你是穗鈅助手的訂單處理模組。語氣簡潔直接。',
  allowedSkills: ['create-order', 'generate-pdf'],
  messages: MESSAGES,
});

// ========================================
// Export（供 bot-server 啟動時 require 觸發註冊）
// ========================================

module.exports = {
  MESSAGES,
  formatOrderSummary,
  // 讓 bot-server 能手動啟動 session（用於關鍵詞攔截和 PDF 解析）
  startOrderSession: async (chatId, userId, initialData = {}) => {
    return ism.startSession('order', { chatId, userId, initialData });
  },
};
```

**注意事項：**
- 這個檔案 `require` 時會自動執行 `ism.registerHandler('order', ...)` 和 `agentRegistry.register(...)`
- bot-server.js 只需要在啟動時 `require('./agents/order-agent')` 就完成註冊

---

## Step 2：精簡 skills/create-order/index.js

**目標：刪除所有互動邏輯，只保留純工具函式。**

### 要保留的函式（改名或調整 export）

| 現有函式 | 保留？ | 新 export 名稱 | 說明 |
|---|---|---|---|
| `parseOrderWithLLM` | ✅ | `parseOrderWithLLM` | LLM 解析訂單文字 |
| `simpleParseOrder` | ✅ | `simpleParseOrder` | Fallback 簡易解析 |
| `parseItems` | ✅ | `parseItems` | 品項文字解析 |
| `searchCustomers` | ✅ | `searchCustomers` | ERP 客戶搜尋 |
| `submitOrderToERP` | ✅ 改造 | `submitOrder` | 接收 session.data，回傳 { orderNumber } |
| `determineStartStep` | ✅ | `determineStartStep` | 判斷從哪一步開始 |
| RAG 品項比對（handleItemsInput 裡的） | ✅ 抽出 | `enrichItemsWithRAG` | 接收 items 陣列，回傳 enriched items |
| 建立新客戶（handleCallback 裡的） | ✅ 抽出 | `createCustomerInERP` | 接收 name，回傳 customer 物件 |
| PDF 生成（handleCallback 裡的） | ✅ 抽出 | `generatePDF` | 接收 orderRef + type，回傳結果 |
| `orderSessions` Map | ❌ 刪除 | — | 改由 ISM 管理 |
| `handleCallback` | ❌ 刪除 | — | 搬到 order-agent.js |
| `handleTextInput` | ❌ 刪除 | — | 搬到 order-agent.js |
| `getSession` / `deleteSession` / `createSession` | ❌ 刪除 | — | 改由 ISM 管理 |
| `startFromParsed` | ❌ 刪除 | — | 搬到 order-agent.js |
| `typeSelectionResponse` / `askCustomerResponse` / `askItemsResponse` / `orderConfirmResponse` / `orderSuccessResponse` / `customerChoiceResponse` | ❌ 刪除 | — | 搬到 order-agent.js 的 MESSAGES 和按鈕模板 |
| v3 `run()` | ✅ 改造 | `run()` | 保留 LLM tool calling 入口，但改為建立 ISM session |
| v3 `definition` | ✅ | `definition` | 不變 |

### 新增函式規格

**`submitOrder(orderData)`** — 從 `submitOrderToERP` 改造：

```javascript
/**
 * 提交訂單到 ERP
 * @param {Object} orderData — session.data 的內容
 * @param {string} orderData.type — 'sales' | 'purchase' | 'quotation'
 * @param {Object} orderData.customer — { _id, name, phone, company, address, payment }
 * @param {Array} orderData.items — enriched items 陣列
 * @param {string} [orderData.note]
 * @returns {Promise<{ orderNumber: string, orderId: string }>}
 * @throws {Error} ERP 回傳失敗時
 */
async function submitOrder(orderData) {
  const erpOrderType = orderData.type === 'quotation' ? 'sales' : orderData.type;
  const orderPayload = {
    orderType: erpOrderType,
    customerId: orderData.customer._id,
    customerName: orderData.customer.name,
    customerPhone: orderData.customer.phone || '',
    shippingAddress: orderData.customer.address || '',
    items: orderData.items.map(item => ({
      productCode: item.productCode || item.originalName || item.name,
      productName: item.matchedName || item.originalName || item.name,
      quantity: item.quantity,
      unitPrice: item.price || 0,
      unit: item.unit || '個',
      category: item.category || '其他',
    })),
    taxRate: 5,
    taxType: 'exclusive',
    paymentInfo: {
      method: orderData.customer.payment?.method || 'cash',
      isPaid: false,
      paidAmount: 0,
    },
    notes: orderData.note || '',
  };

  console.log('[Order] 建立訂單:', JSON.stringify(orderPayload, null, 2));
  const result = await erpFetch('/api/orders', {
    method: 'POST',
    body: JSON.stringify(orderPayload),
  });

  if (!result.success) {
    throw new Error(result.message || '未知錯誤');
  }

  return {
    orderNumber: result.data.orderNumber,
    orderId: result.data._id,
  };
}
```

**`enrichItemsWithRAG(items)`** — 從 `handleItemsInput` 裡抽出：

```javascript
/**
 * RAG 產品比對：將原始品項跟 ERP 產品庫比對
 * @param {Array} items — [{ name, quantity, price }]
 * @returns {Promise<Array>} — enriched items（帶 productCode、matchedName 等）
 */
async function enrichItemsWithRAG(items) {
  try {
    const productSearch = require('../../src/product-search');
    const enriched = [];

    for (const item of items) {
      const results = await productSearch.searchProduct(item.name);
      const classified = productSearch.classifyResults(results);

      if (classified.autoMatch.length > 0) {
        const matched = classified.autoMatch[0].product;
        enriched.push({
          name: item.name,
          originalName: item.name,
          matchedName: matched.name,
          productCode: matched.productId,
          matchConfidence: classified.autoMatch[0].score,
          quantity: item.quantity || 1,
          price: item.price || matched.unitPrice || 0,
          unit: matched.unit || '個',
          _matched: true,
        });
        if (item.name !== matched.name) {
          productSearch.learnAlias(matched.productId, item.name).catch(() => {});
        }
      } else if (classified.candidates.length > 0) {
        const best = classified.candidates[0].product;
        enriched.push({
          name: item.name,
          originalName: item.name,
          matchedName: best.name,
          productCode: best.productId,
          matchConfidence: classified.candidates[0].score,
          quantity: item.quantity || 1,
          price: item.price || best.unitPrice || 0,
          unit: best.unit || '個',
          _matched: 'candidate',
        });
      } else {
        enriched.push({
          name: item.name,
          originalName: item.name,
          matchedName: null,
          productCode: null,
          matchConfidence: 0,
          quantity: item.quantity || 1,
          price: item.price || 0,
          unit: '個',
          _matched: false,
        });
      }
    }

    return enriched;
  } catch (err) {
    console.warn('[Order] RAG 比對失敗，使用原始品項:', err.message);
    return items.map(i => ({ ...i, quantity: i.quantity || 1, price: i.price || 0 }));
  }
}
```

**`createCustomerInERP(name)`** — 從 `handleCallback` 的 `order_newcustomer` 抽出：

```javascript
/**
 * 在 ERP 建立新客戶
 * @param {string} name — 客戶名稱
 * @returns {Promise<Object>} — ERP 回傳的 customer 物件
 * @throws {Error}
 */
async function createCustomerInERP(name) {
  const result = await erpFetch('/api/customers', {
    method: 'POST',
    body: JSON.stringify({
      name,
      phone: '',
      type: 'customer',
      payment: { method: 'cash' },
    }),
  });
  if (!result.success) {
    throw new Error(result.message || '未知錯誤');
  }
  console.log(`[Order] 新客戶建立: ${name} (${result.data.customerCode || ''})`);
  return result.data;
}
```

**`generatePDF(orderRef, pdfType, context)`** — 從 `handleCallback` 的 `order_pdf:*` 抽出：

```javascript
/**
 * 查詢訂單並生成 PDF
 * @param {string} orderRef — orderNumber 或 MongoDB _id
 * @param {string} pdfType — 'quotation' | 'sales'
 * @param {Object} context — { userId, chatId }
 * @returns {Promise<{ text: string, localPaths?: Array }>}
 * @throws {Error}
 */
async function generatePDF(orderRef, pdfType, context) {
  const isObjectId = /^[a-f0-9]{24}$/i.test(orderRef);
  let order, orderId, orderNumber;

  if (isObjectId) {
    const orderData = await erpFetch(`/api/orders/${orderRef}`);
    if (!orderData.success || !orderData.data) throw new Error('找不到訂單');
    order = orderData.data;
    orderId = orderRef;
    orderNumber = order.orderNumber;
  } else {
    const ordersData = await erpFetch(`/api/orders?orderNumber=${orderRef}`);
    if (!ordersData.success || !ordersData.data || ordersData.data.length === 0) {
      throw new Error(`找不到訂單「${orderRef}」`);
    }
    order = ordersData.data[0];
    orderId = order._id;
    orderNumber = orderRef;
  }

  const generatePdfSkill = require('../generate-pdf');
  return await generatePdfSkill.generateAndSendPDF(orderId, orderNumber, pdfType, order, context);
}
```

### 精簡後的 module.exports

```javascript
module.exports = {
  name: 'create-order',
  description: '建立 ERP 訂單（工具函式庫）',
  version: '3.0.0',

  definition: {
    name: 'create-order',
    description: '建立銷售/採購訂單。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '用戶的自然語言訂單描述' },
      },
    },
  },

  // LLM tool_call 入口（改為透過 ISM 啟動互動 session）
  async run(args, context) {
    const chatId = context.chatId;
    const message = args.message || '';
    const llmAdapter = context.llm || null;

    let parsed = await parseOrderWithLLM(message, llmAdapter);
    if (!parsed) parsed = simpleParseOrder(message);

    // 透過 order-agent 的 startOrderSession 啟動互動
    const { startOrderSession } = require('../src/agents/order-agent');
    const result = await startOrderSession(chatId, context.userId, { parsed });
    return {
      success: true,
      data: result.text || '',
      summary: result.text || '',
      reply_markup: result.reply_markup || null,
    };
  },

  // 純工具函式 export
  parseOrderWithLLM,
  simpleParseOrder,
  parseItems,
  searchCustomers,
  submitOrder,
  enrichItemsWithRAG,
  createCustomerInERP,
  generatePDF,
  determineStartStep,
};
```

---

## Step 3：改 bot-server.js

### 3.1 新增 require

在檔案頂部，加入：

```javascript
const ism = require('./interactive-session');
const orderAgent = require('./agents/order-agent'); // 觸發 registerHandler
```

移除或保留（但不再直接用）：

```javascript
// 這行保留，因為 LLM tool_call 還是會呼叫 create-order skill
const createOrderSkill = require('../skills/create-order');
```

### 3.2 改 callback_query handler

**整個 `bot.on('callback_query', ...)` 的內容改為：**

```javascript
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const userId = `telegram:${chatId}`;

  console.log(`[bot] callback_query: ${data} (chat: ${chatId})`);

  try {
    // ======== 統一由 ISM 處理 ========
    const result = await ism.handleCallback(data, {
      chatId,
      userId,
      messageId: query.message.message_id,
    });

    if (result) {
      // 送出回覆文字
      if (result.text) {
        await sendReply(bot, chatId, result.text, result.reply_markup);
      }

      // 送出圖片（PDF 等）
      if (result.images && result.images.length > 0) {
        const fs = require('fs');
        for (const img of result.images) {
          try {
            const filePath = img.localPath || img;
            await bot.sendPhoto(chatId, fs.createReadStream(filePath), { caption: img.caption || '' });
          } catch (imgErr) {
            console.error('[bot-server] 發送圖片失敗:', imgErr.message);
          }
        }
      }
    }

    // ======== 舊格式相容（漸進遷移期間） ========
    // 如果 ISM 沒有處理（result 為 null），檢查是否是舊格式 callback
    if (result === null) {
      // PDF 選單是在 order session done 之後才按的，ISM 已清除 session
      // 需要特殊處理：order:pdf 的 callback 可能在 session 外
      if (data.startsWith('order:pdf:')) {
        const parts = data.split(':');
        const pdfType = parts[2];
        const orderRef = parts.slice(3).join(':');
        if (pdfType === 'skip') {
          await sendReply(bot, chatId, '好的，如需要再告訴我。');
        } else {
          try {
            const pdfResult = await createOrderSkill.generatePDF(orderRef, pdfType, { userId, chatId });
            if (pdfResult && pdfResult.localPaths) {
              await sendReply(bot, chatId, pdfResult.text);
              const fs = require('fs');
              for (const img of pdfResult.localPaths) {
                await bot.sendPhoto(chatId, fs.createReadStream(img.localPath), { caption: img.caption || '' });
              }
            } else {
              await sendReply(bot, chatId, pdfResult?.text || 'PDF 生成完成');
            }
          } catch (err) {
            await sendReply(bot, chatId, `PDF 生成失敗：${err.message}`);
          }
        }
      }

      // 舊格式 order_pickcustomer（文件解析的客戶選擇，bot-server 直接處理的）
      if (data.startsWith('order_pickcustomer:')) {
        // TODO: 遷移到 doc-agent（E4 階段），目前暫時保留舊邏輯
        const choice = data.split(':')[1];
        const sess = ism.getSession(chatId);
        if (sess && sess.data._parsedFromDoc) {
          const parsed = sess.data._parsedFromDoc;
          const amb = parsed._ambiguous;
          parsed.customerName = choice === 'sender' ? amb.sender : amb.receiver;
          parsed.type = choice === 'sender' ? 'purchase' : 'sales';
          delete parsed._ambiguous;
          // 重新啟動 order session with parsed data
          ism.deleteSession(chatId);
          const result = await orderAgent.startOrderSession(chatId, userId, { parsed });
          if (result) await sendReply(bot, chatId, result.text, result.reply_markup);
        }
      }
    }

    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    console.error(`[bot-server] callback_query 處理失敗:`, err);
    await bot.answerCallbackQuery(query.id, { text: '處理失敗，請重試' });
    await notifyError(bot, err, `Callback: ${data}\nChat: ${chatId}`);
  }
});
```

### 3.3 改 message handler 的 session 攔截

找到 bot-server.js 裡這段（約 502-511 行）：

```javascript
// ---- 建單 session 攔截：有 active session 時直接走 skill ----
const orderSession = createOrderSkill.getSession(chatId);
if (orderSession && (orderSession.step === 'customer' || orderSession.step === 'items')) {
  const result = await createOrderSkill.handleTextInput(chatId, text);
  if (result) {
    await sendSkillResult(bot, chatId, result);
    return;
  }
}
```

**改為：**

```javascript
// ---- ISM session 攔截：有 active session 時直接走 agent handler ----
if (ism.hasActiveSession(chatId)) {
  const result = await ism.handleTextInput(chatId, text, { userId });
  if (result) {
    if (result.text) await sendReply(bot, chatId, result.text, result.reply_markup);
    if (result.images) {
      const fs = require('fs');
      for (const img of result.images) {
        try {
          await bot.sendPhoto(chatId, fs.createReadStream(img.localPath || img), { caption: img.caption || '' });
        } catch (imgErr) {
          console.error('[bot-server] 發送圖片失敗:', imgErr.message);
        }
      }
    }
    return;
  }
  // result 為 null → ISM 不攔截，繼續走 LLM
}
```

### 3.4 改關鍵詞攔截

找到這段（約 529-538 行）：

```javascript
if (/建立訂單|建單|開單|下訂單/.test(text)) {
  const orderResult = await createOrderSkill.run(
    { message: text },
    { userId, chatId, llm: require('./llm-adapter') }
  );
  if (orderResult) {
    await sendSkillResult(bot, chatId, orderResult);
    return;
  }
}
```

**改為：**

```javascript
if (/建立訂單|建單|開單|下訂單/.test(text)) {
  const result = await orderAgent.startOrderSession(chatId, userId, {});
  if (result) {
    await sendReply(bot, chatId, result.text, result.reply_markup);
    return;
  }
}
```

### 3.5 改 /reset 指令

找到這段：

```javascript
if (text === '/reset' || text === '/new') {
  chatHistories.delete(chatId);
  createOrderSkill.deleteSession(chatId);
  await bot.sendMessage(chatId, '🔄 對話已重置');
  return;
}
```

**改為：**

```javascript
if (text === '/reset' || text === '/new') {
  chatHistories.delete(chatId);
  ism.deleteSession(chatId); // 取代 createOrderSkill.deleteSession
  await bot.sendMessage(chatId, '🔄 對話已重置');
  return;
}
```

### 3.6 改文件解析流程裡的建單觸發

找到 bot-server.js 裡 `startFromParsed` 相關的邏輯（約 446-468 行的 `_ambiguous` 處理和 `startFromParsed` 呼叫）。

**`_ambiguous` 的按鈕改用新的 callback 格式**：

原來：`callback_data: 'order_pickcustomer:sender'`

不動（Step 3.2 已在 callback handler 裡做了相容處理）。等 E4 文件 Agent 再一起遷移。

**`startFromParsed` 呼叫改為**：

找到約 467 行：
```javascript
const result = await createOrderSkill.startFromParsed(chatId, parsed, { userId, chatId, llm: llmAdapter });
```

改為：
```javascript
const result = await orderAgent.startOrderSession(chatId, userId, { parsed });
```

然後把 `sendSkillResult` 改為 `sendReply`：
```javascript
if (result) {
  await sendReply(bot, chatId, result.text, result.reply_markup);
}
```

---

## Step 4：整合測試

### 4.1 語法檢查

```bash
node -e "require('./src/bot-server')" 2>&1 | head -5
# 預期：不報錯（但因為沒有 .env 中的 token，可能會 exit，看 exit 前有沒有語法錯誤）
```

### 4.2 模組載入檢查

```bash
node -e "
const ism = require('./src/interactive-session');
const orderAgent = require('./src/agents/order-agent');
console.log('ISM handlers:', ism.hasActiveSession(0) === false ? '✅' : '❌');
console.log('order agent exported:', typeof orderAgent.startOrderSession === 'function' ? '✅' : '❌');
console.log('order agent MESSAGES:', typeof orderAgent.MESSAGES === 'object' ? '✅' : '❌');
"
```

### 4.3 Skill 精簡檢查

```bash
node -e "
const skill = require('./skills/create-order');
console.log('parseItems:', typeof skill.parseItems);
console.log('searchCustomers:', typeof skill.searchCustomers);
console.log('submitOrder:', typeof skill.submitOrder);
console.log('enrichItemsWithRAG:', typeof skill.enrichItemsWithRAG);
console.log('createCustomerInERP:', typeof skill.createCustomerInERP);
console.log('generatePDF:', typeof skill.generatePDF);
console.log('run:', typeof skill.run);
// 確認舊的已移除
console.log('orderSessions (should be undefined):', typeof skill.orderSessions);
console.log('handleCallback (should be undefined):', typeof skill.handleCallback);
console.log('handleTextInput (should be undefined):', typeof skill.handleTextInput);
"
```

### 4.4 功能測試（在 Telegram 上）

啟動 bot 後，測試以下場景：

| 測試 | 操作 | 預期 |
|---|---|---|
| 引導模式 | 發「建立訂單」→ 按銷售單 → 輸入客戶 → 輸入品項 → 確認 | 訂單建立成功 |
| 智慧模式 | 發「幫百凌開一張採購單 USB延長線 x10 @15」 | 跳到確認步驟或客戶步驟 |
| 取消 | 建單中按取消 | 顯示已取消，session 清除 |
| 超時 | 開始建單後等 10 分鐘 | session 自動清除 |
| PDF | 建單完成後按報價單/銷貨單 | PDF 生成成功 |
| 文件建單 | 傳一張訂單 PDF/圖片 | 分類 → 解析 → 進入建單流程 |
| /reset | 建單進行中按 /reset | session 清除 |
| LLM tool call | LLM 判斷需要建單時呼叫 create-order skill | 正常啟動互動 session |
| 同步產品 | 發「同步產品」 | 不受影響，正常運作 |
| 一般對話 | 發「你好」 | 不受影響，正常回覆 |

---

## 注意事項

1. **callback_data 格式遷移**：所有新按鈕用 `order:{action}:{payload}` 格式。舊的 `order_pickcustomer:` 暫時保留相容處理，E4 再清理。
2. **order agent 的 PDF 按鈕特殊處理**：PDF 按鈕在 `order:confirm` 回傳 `done: true` 之後才按，此時 ISM session 已清除。需要在 callback handler 裡做 session 外處理（Step 3.2 已處理）。
3. **require 順序**：`order-agent.js` require `interactive-session.js` 和 `agent-registry.js`，所以必須在 bot-server.js 的最頂部 require，確保 E1 模組先載入。
4. **create-order/index.js 的 `run()` 改為啟動 ISM session**：這樣 LLM tool calling 進來的也會走新流程。注意 `run()` 裡 require order-agent 會有循環依賴風險（order-agent require create-order，create-order 的 run require order-agent），用 lazy require 解決。
5. **測試完成前不要 merge 到 main**，確認所有場景都通過。
