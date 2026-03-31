/**
 * Create Order Skill (v4) — 互動式按鈕流程
 *
 * 支援兩種模式：
 * 1. 引導模式：按鈕逐步選擇 類型→客戶→品項→確認
 * 2. 智慧模式：LLM 解析完整資訊，直接跳到確認
 *
 * @version 2.0.0
 */

const { erpFetch } = require('../../lib/erp-client');
const config = require('../../src/config');

// ========================================
// Order Sessions（建單狀態管理）
// ========================================

const orderSessions = new Map();

const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 分鐘

/**
 * 清除過期 sessions
 */
function cleanExpiredSessions() {
  const now = Date.now();
  for (const [chatId, sess] of orderSessions) {
    if (now - sess.createdAt > SESSION_TIMEOUT_MS) {
      orderSessions.delete(chatId);
      console.log(`[Order] Session 過期清除: ${chatId}`);
    }
  }
}

// 每分鐘檢查一次
setInterval(cleanExpiredSessions, 60 * 1000);

/**
 * 取得或建立 session
 */
function getSession(chatId) {
  return orderSessions.get(chatId) || null;
}

function createSession(chatId, initialData = {}) {
  const sess = {
    step: 'type',
    type: null,
    customer: null,
    items: [],
    createdAt: Date.now(),
    ...initialData,
  };
  orderSessions.set(chatId, sess);
  return sess;
}

function deleteSession(chatId) {
  orderSessions.delete(chatId);
}

// ========================================
// LLM 解析訂單
// ========================================

async function parseOrderWithLLM(message, llm) {
  if (!llm || !llm.chat) return null;

  try {
    const response = await llm.chat({
      model: config.llm.defaultModel,
      messages: [
        {
          role: 'system',
          content: `你是訂單解析器。從用戶訊息中提取訂單資訊，回傳 JSON。
只回傳 JSON，不要其他文字。

格式：
{
  "type": "sales" 或 "purchase" 或 "quotation" 或 null,
  "customerName": "客戶名稱" 或 null,
  "items": [{"name": "品名", "quantity": 數量, "price": 單價或0, "category": "分類"}],
  "note": "備註" 或 null
}

category 必須是以下之一：電子組件、機械組件、氣動組件、感測器、控制器、緊固件、線材、連接器、照明、其他
根據品名判斷最合適的分類，無法判斷時用「其他」。

範例：
- "幫王大明建一張銷售單，A4紙 100包 150元" → {"type":"sales","customerName":"王大明","items":[{"name":"A4紙","quantity":100,"price":150,"category":"其他"}],"note":null}
- "建立訂單" → {"type":null,"customerName":null,"items":[],"note":null}
- "採購單 大明企業 影印紙x50@120" → {"type":"purchase","customerName":"大明企業","items":[{"name":"影印紙","quantity":50,"price":120,"category":"其他"}],"note":null}
- "出一份報價單給大明企業" → {"type":"quotation","customerName":"大明企業","items":[],"note":null}`
        },
        { role: 'user', content: message }
      ],
      temperature: 0.1,
    });

    const text = (response.content || '').trim();
    // 提取 JSON（可能被包在 ```json ``` 中）
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch (err) {
    console.warn('[Order] LLM 解析失敗:', err.message);
    return null;
  }
}

/**
 * 簡易正則解析（LLM 不可用時的 fallback）
 */
function simpleParseOrder(message) {
  const text = message.replace(/^\/order\s*/i, '').trim();
  if (!text) return null;

  const items = [];
  const pattern = /([^\sx@,，]+?)[\s]*[xX×][\s]*(\d+)(?:[\s]*[@＠][\s]*(\d+))?/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    items.push({
      name: match[1].trim(),
      quantity: parseInt(match[2]),
      price: match[3] ? parseInt(match[3]) : 0,
    });
  }

  // 嘗試判斷類型
  let type = null;
  if (/銷售單|銷售/.test(text)) type = 'sales';
  if (/採購單|採購/.test(text)) type = 'purchase';

  return { type, customerName: null, items, note: null };
}

// ========================================
// ERP 客戶搜尋
// ========================================

async function searchCustomers(searchName) {
  const customers = await erpFetch('/api/customers');
  if (!customers.success) {
    return { success: false, matches: [], error: '無法連接 ERP 系統' };
  }

  const search = searchName.toLowerCase().trim();
  const matches = (customers.data || []).filter(c => {
    const name = (c.name || '').toLowerCase();
    const contact = (c.contact || '').toLowerCase();
    return name === search || contact === search ||
           name.includes(search) || search.includes(name);
  });

  return { success: true, matches };
}

// ========================================
// 回應建構器（含 inline keyboard）
// ========================================

function typeSelectionResponse() {
  return {
    success: true,
    summary: '請選擇訂單類型',
    data: '請選擇訂單類型：',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📦 銷售單', callback_data: 'order_type:sales' },
          { text: '🛒 採購單', callback_data: 'order_type:purchase' },
          { text: '📝 報價單', callback_data: 'order_type:quotation' },
        ]
      ]
    },
  };
}

function askCustomerResponse() {
  return {
    success: true,
    summary: '等待輸入客戶名稱',
    data: '請輸入客戶名稱：',
  };
}

function customerChoiceResponse(matches) {
  const buttons = matches.slice(0, 5).map(c => ([{
    text: `${c.name}${c.company ? ' - ' + c.company : ''}`,
    callback_data: `order_customer:${c._id}`,
  }]));
  buttons.push([{ text: '❌ 取消建單', callback_data: 'order_cancel' }]);

  return {
    success: true,
    summary: '找到多位客戶，請選擇',
    data: '找到多位客戶，請選擇：',
    reply_markup: { inline_keyboard: buttons },
  };
}

function askItemsResponse() {
  return {
    success: true,
    summary: '等待輸入品項',
    data: '請輸入品項（品名、數量、單價）\n\n範例：\n• A4紙 x100 @150\n• 影印紙x50@120, 資料夾x20@35',
  };
}

function orderConfirmResponse(sess) {
  const typeName = sess.type === 'sales' ? '銷售單' : sess.type === 'quotation' ? '報價單' : '採購單';
  const customerName = sess.customer?.name || '未知';
  const company = sess.customer?.company ? `（${sess.customer.company}）` : '';

  const itemLines = sess.items.map(i => {
    const code = i.productCode ? `[${i.productCode}] ` : '';
    const unit = i.unit || '個';
    const priceStr = i.price > 0 ? ` @NT$${i.price}/${unit}` : ' (價格未填)';
    const totalStr = i.price > 0 ? ` = NT$${i.quantity * i.price}` : '';
    return `  • ${code}${i.name} ×${i.quantity}${priceStr}${totalStr}`;
  }).join('\n');

  const total = sess.items.reduce((s, i) => s + i.quantity * (i.price || 0), 0);

  const text = `📋 訂單確認：\n\n`
    + `類型：${typeName}\n`
    + `客戶：${customerName}${company}\n`
    + `品項：\n${itemLines}\n`
    + `合計：NT$ ${total.toLocaleString()}${total === 0 ? ' (待補價格)' : ''}\n`;

  return {
    success: true,
    summary: '訂單確認中',
    data: text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ 確認建單', callback_data: 'order_confirm' },
          { text: '❌ 取消', callback_data: 'order_cancel' },
        ]
      ]
    },
  };
}

function orderSuccessResponse(orderNumber) {
  return {
    success: true,
    summary: `訂單 ${orderNumber} 建立成功`,
    data: `✅ 訂單 ${orderNumber} 建立成功！\n\n需要生成單據嗎？`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📄 報價單', callback_data: `order_pdf:quotation:${orderNumber}` },
          { text: '📄 銷貨單', callback_data: `order_pdf:sales:${orderNumber}` },
        ],
        [
          { text: '⏭️ 不用', callback_data: 'order_pdf:skip' },
        ]
      ]
    },
  };
}

// ========================================
// 核心流程：根據 session step 決定下一步
// ========================================

/**
 * 智慧判斷從哪一步開始
 */
function determineStartStep(parsed) {
  if (!parsed) return 'type';
  if (!parsed.type) return 'type';
  if (!parsed.customerName || parsed.customerName === null) return 'customer';
  if (!parsed.items || parsed.items.length === 0) return 'items';
  return 'confirm';
}

// ========================================
// handleCallback — 處理 inline keyboard 按鈕
// ========================================

async function handleCallback(chatId, callbackData) {
  const parts = callbackData.split(':');
  const action = parts[0] + ':' + (parts[1] || '');

  // order_cancel — 任何階段都可以取消
  if (callbackData === 'order_cancel') {
    deleteSession(chatId);
    return { success: true, data: '❌ 訂單建立已取消。', summary: '訂單已取消' };
  }

  // order_newcustomer — 建立新客戶
  if (callbackData === 'order_newcustomer') {
    const sess = getSession(chatId);
    if (!sess || !sess._pendingCustomerName) {
      return { success: false, data: '流程已過期，請重新開始。', summary: '流程過期' };
    }
    try {
      const newCustomer = await erpFetch('/api/customers', {
        method: 'POST',
        body: JSON.stringify({
          name: sess._pendingCustomerName,
          phone: '',
          type: 'customer',
          payment: { method: 'cash' },
        }),
      });
      if (!newCustomer.success) {
        return { success: false, data: `建立客戶失敗：${newCustomer.message || '未知錯誤'}`, summary: '建立失敗' };
      }
      sess.customer = newCustomer.data;
      delete sess._pendingCustomerName;
      sess.step = 'items';
      const name = sess.customer.name;
      console.log(`[Order] 新客戶建立: ${name} (${sess.customer.customerCode || ''})`);
      if (sess.items && sess.items.length > 0) {
        sess.step = 'confirm';
        const confirmResp = orderConfirmResponse(sess);
        return { ...confirmResp, data: `✅ 已建立客戶「${name}」\n\n${confirmResp.data}` };
      }
      const itemsResp = askItemsResponse();
      return { ...itemsResp, data: `✅ 已建立客戶「${name}」\n\n${itemsResp.data}` };
    } catch (err) {
      console.error('[Order] 建立客戶失敗:', err);
      return { success: false, data: `建立客戶失敗：${err.message}`, summary: '建立失敗' };
    }
  }

  // order_retrycustomer — 重新輸入客戶
  if (callbackData === 'order_retrycustomer') {
    const sess = getSession(chatId);
    if (sess) {
      delete sess._pendingCustomerName;
      sess.step = 'customer';
    }
    return { success: true, data: '請輸入客戶名稱：', summary: '重新輸入客戶' };
  }

  // order_pdf:* — 建單後的 PDF 選項
  if (callbackData.startsWith('order_pdf:')) {
    const pdfType = parts[1];
    const orderRef = parts.slice(2).join(':'); // orderNumber 或 orderId
    if (pdfType === 'skip') {
      return { success: true, data: '好的，如需要再告訴我。', summary: '跳過 PDF' };
    }
    try {
      // 判斷是 orderNumber (PUR-/ORD-) 還是 MongoDB _id (24 hex)
      const isObjectId = /^[a-f0-9]{24}$/i.test(orderRef);
      let order, orderId, orderNumber;

      if (isObjectId) {
        // 用 _id 查 ERP
        const orderData = await erpFetch(`/api/orders/${orderRef}`);
        if (!orderData.success || !orderData.data) {
          return { success: false, data: `找不到訂單`, summary: '找不到訂單' };
        }
        order = orderData.data;
        orderId = orderRef;
        orderNumber = order.orderNumber;
      } else {
        // 用 orderNumber 查 ERP
        const ordersData = await erpFetch(`/api/orders?orderNumber=${orderRef}`);
        if (!ordersData.success || !ordersData.data || ordersData.data.length === 0) {
          return { success: false, data: `找不到訂單「${orderRef}」`, summary: '找不到訂單' };
        }
        order = ordersData.data[0];
        orderId = order._id;
        orderNumber = orderRef;
      }

      // 直接呼叫 generateAndSendPDF（跳過 parseMessage）
      const generatePdfSkill = require('../generate-pdf');
      const pdfResult = await generatePdfSkill.generateAndSendPDF(
        orderId, orderNumber, pdfType, order, { userId: `telegram:${chatId}`, chatId }
      );

      // generateAndSendPDF 回傳 { text, localPaths } 或字串
      if (pdfResult && typeof pdfResult === 'object' && pdfResult.localPaths) {
        return {
          success: true,
          data: pdfResult.text,
          summary: pdfResult.text,
          images: pdfResult.localPaths, // [{ localPath, caption }]
        };
      }
      return { success: true, data: typeof pdfResult === 'string' ? pdfResult : pdfResult?.text || 'PDF 生成完成', summary: 'PDF' };
    } catch (err) {
      console.error('[Order] PDF 生成失敗:', err);
      return { success: false, data: `PDF 生成失敗：${err.message}`, summary: 'PDF 失敗' };
    }
  }

  const sess = getSession(chatId);

  // order_type:sales / order_type:purchase
  if (action.startsWith('order_type:')) {
    const type = parts[1]; // 'sales' or 'purchase'
    if (!sess) {
      createSession(chatId, { type, step: 'customer' });
      return askCustomerResponse();
    }
    sess.type = type;
    sess.step = 'customer';
    return askCustomerResponse();
  }

  // order_customer:{id} — 從多筆客戶中選擇
  if (action.startsWith('order_customer:')) {
    const customerId = parts[1];
    if (!sess) {
      return { success: false, data: '建單流程已過期，請重新開始。', summary: '流程過期' };
    }
    // 從暫存的候選客戶找
    const customer = (sess._customerMatches || []).find(c => c._id === customerId);
    if (!customer) {
      return { success: false, data: '找不到該客戶，請重新輸入。', summary: '客戶不存在' };
    }
    sess.customer = customer;
    delete sess._customerMatches;
    sess.step = 'items';
    return askItemsResponse();
  }

  // order_confirm — 確認建單
  if (callbackData === 'order_confirm') {
    if (!sess) {
      return { success: false, data: '建單流程已過期，請重新開始。', summary: '流程過期' };
    }
    return await submitOrderToERP(chatId, sess);
  }

  return { success: false, data: '未知的操作。', summary: '未知 callback' };
}

// ========================================
// handleTextInput — 處理建單過程中的文字輸入
// ========================================

async function handleTextInput(chatId, text) {
  const sess = getSession(chatId);
  if (!sess) {
    return null; // 沒有 active session，交回正常流程
  }

  if (sess.step === 'customer') {
    return await handleCustomerInput(chatId, sess, text);
  }

  if (sess.step === 'items') {
    return handleItemsInput(chatId, sess, text);
  }

  return null;
}

async function handleCustomerInput(chatId, sess, text) {
  const trimmed = text.trim();

  // 允許用戶在此步取消
  if (/^(取消|cancel)$/i.test(trimmed)) {
    deleteSession(chatId);
    return { success: true, data: '❌ 訂單建立已取消。', summary: '訂單已取消' };
  }

  const result = await searchCustomers(trimmed);

  if (!result.success) {
    return { success: false, data: result.error, summary: 'ERP 連線失敗' };
  }

  if (result.matches.length === 0) {
    sess._pendingCustomerName = trimmed;
    return {
      success: true,
      data: `找不到客戶「${trimmed}」`,
      summary: '找不到客戶',
      reply_markup: {
        inline_keyboard: [
          [{ text: `✅ 建立「${trimmed}」`, callback_data: 'order_newcustomer' }],
          [
            { text: '✏️ 重新輸入', callback_data: 'order_retrycustomer' },
            { text: '❌ 取消', callback_data: 'order_cancel' },
          ],
        ],
      },
    };
  }

  if (result.matches.length === 1) {
    sess.customer = result.matches[0];
    sess.step = 'items';
    const name = sess.customer.name;
    const company = sess.customer.company ? `（${sess.customer.company}）` : '';
    const itemsResp = askItemsResponse();
    return {
      ...itemsResp,
      data: `✅ 客戶：${name}${company}\n\n${itemsResp.data}`,
    };
  }

  // 多筆 → 按鈕選擇
  sess._customerMatches = result.matches;
  return customerChoiceResponse(result.matches);
}

async function handleItemsInput(chatId, sess, text) {
  const trimmed = text.trim();

  if (/^(取消|cancel)$/i.test(trimmed)) {
    deleteSession(chatId);
    return { success: true, data: '❌ 訂單建立已取消。', summary: '訂單已取消' };
  }

  // 解析品項
  const items = parseItems(trimmed);

  if (items.length === 0) {
    return {
      success: true,
      data: '無法解析品項。請使用格式：\n品名 x數量 @單價\n\n範例：A4紙 x100 @150',
      summary: '品項解析失敗',
    };
  }

  // RAG 產品比對
  try {
    const productSearch = require('../../src/product-search');
    const enrichedItems = [];
    const pendingItems = []; // 需要用戶選擇的品項

    for (const item of items) {
      const results = await productSearch.searchProduct(item.name);
      const classified = productSearch.classifyResults(results);

      if (classified.autoMatch.length > 0) {
        // 高度匹配 → 自動帶入
        const matched = classified.autoMatch[0].product;
        enrichedItems.push({
          name: matched.name,
          productCode: matched.productId,
          quantity: item.quantity,
          price: item.price || matched.unitPrice || 0,
          unit: matched.unit || '個',
          _matched: true,
          _userInput: item.name,
        });
        // 自動學習別名（fire-and-forget）
        if (item.name !== matched.name) {
          productSearch.learnAlias(matched.productId, item.name).catch(() => {});
        }
      } else if (classified.candidates.length > 0) {
        // 候選 → 暫存，先用第一個候選
        const best = classified.candidates[0].product;
        enrichedItems.push({
          name: best.name,
          productCode: best.productId,
          quantity: item.quantity,
          price: item.price || best.unitPrice || 0,
          unit: best.unit || '個',
          _matched: 'candidate',
          _userInput: item.name,
          _score: classified.candidates[0].score,
        });
        pendingItems.push({ input: item.name, candidates: classified.candidates });
      } else {
        // 沒匹配 → 保留原始輸入
        enrichedItems.push({
          name: item.name,
          productCode: null,
          quantity: item.quantity,
          price: item.price || 0,
          unit: '個',
          _matched: false,
          _userInput: item.name,
        });
      }
    }

    sess.items = enrichedItems;
  } catch (err) {
    console.warn('[Order] RAG 比對失敗，使用原始品項:', err.message);
    sess.items = items;
  }

  sess.step = 'confirm';
  return orderConfirmResponse(sess);
}

/**
 * 解析品項文字
 */
function parseItems(text) {
  const items = [];
  // 支援多種格式：A4紙x100@150, A4紙 x 100 @ 150, A4紙 100包 150元
  const segments = text.split(/[,，\n]+/).map(s => s.trim()).filter(Boolean);

  for (const seg of segments) {
    // 格式1: 品名 x數量 @單價
    let m = seg.match(/^(.+?)\s*[xX×]\s*(\d+)\s*(?:[@＠]\s*(\d+))?/);
    if (m) {
      items.push({ name: m[1].trim(), quantity: parseInt(m[2]), price: m[3] ? parseInt(m[3]) : 0 });
      continue;
    }
    // 格式2: 品名 數量包/個/組 單價元
    m = seg.match(/^(.+?)\s+(\d+)\s*(?:包|個|組|箱|件)?\s*(\d+)?\s*(?:元)?$/);
    if (m) {
      items.push({ name: m[1].trim(), quantity: parseInt(m[2]), price: m[3] ? parseInt(m[3]) : 0 });
      continue;
    }
  }
  return items;
}

// ========================================
// 送 ERP 建單
// ========================================

async function submitOrderToERP(chatId, sess) {
  try {
    const orderPayload = {
      orderType: sess.type,
      customerId: sess.customer._id,
      customerName: sess.customer.name,
      customerPhone: sess.customer.phone || '',
      shippingAddress: sess.customer.address || '',
      items: sess.items.map(item => ({
        productCode: item.name,
        productName: item.name,
        quantity: item.quantity,
        unitPrice: item.price || 0,
        unit: item.unit || '個',
        category: item.category || '其他',
      })),
      taxRate: 5,
      taxType: 'exclusive',
      paymentInfo: {
        method: sess.customer.payment?.method || 'cash',
        isPaid: false,
        paidAmount: 0,
      },
      notes: sess.note || '',
    };

    console.log('[Order] 建立訂單:', JSON.stringify(orderPayload, null, 2));

    const result = await erpFetch('/api/orders', {
      method: 'POST',
      body: JSON.stringify(orderPayload),
    });

    if (!result.success) {
      return { success: false, data: `建立訂單失敗：${result.message || '未知錯誤'}`, summary: '建單失敗' };
    }

    const orderNumber = result.data.orderNumber;

    // 清除 session
    deleteSession(chatId);

    return orderSuccessResponse(orderNumber);
  } catch (error) {
    console.error('[Order] ERP 建單錯誤:', error);
    return { success: false, data: `系統錯誤：${error.message}`, summary: '系統錯誤' };
  }
}

// ========================================
// v3 Standard Interface — run()
// ========================================

module.exports = {
  name: 'create-order',
  description: '建立 ERP 訂單（互動式按鈕流程，支援銷售單/採購單）',
  version: '2.0.0',

  definition: {
    name: 'create-order',
    description: '建立銷售/採購訂單。用戶說「建立訂單」時觸發引導流程；提供完整資訊時自動跳到確認步驟。',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: '用戶的自然語言訂單描述' },
      },
    },
  },

  /**
   * LLM tool_call 進入點
   *
   * 智慧判斷：根據解析結果決定從哪一步開始
   */
  async run(args, context) {
    const chatId = context.chatId;
    const message = args.message || '';
    const llm = context.llm || null;

    // 嘗試 LLM 解析
    let parsed = await parseOrderWithLLM(message, llm);

    // LLM 失敗 → fallback 簡易解析
    if (!parsed) {
      parsed = simpleParseOrder(message);
    }

    const startStep = determineStartStep(parsed);
    console.log(`[Order] 解析結果: startStep=${startStep}`, parsed);

    // 建立 session
    const sess = createSession(chatId, {
      step: startStep,
      type: parsed?.type || null,
      items: parsed?.items || [],
      note: parsed?.note || null,
    });

    // 根據起始步驟回應
    if (startStep === 'type') {
      return typeSelectionResponse();
    }

    if (startStep === 'customer') {
      return askCustomerResponse();
    }

    if (startStep === 'items') {
      // 需要先查客戶
      if (parsed?.customerName) {
        const result = await searchCustomers(parsed.customerName);
        if (result.success && result.matches.length === 1) {
          sess.customer = result.matches[0];
          return askItemsResponse();
        } else if (result.success && result.matches.length > 1) {
          sess._customerMatches = result.matches;
          sess.step = 'customer';
          return customerChoiceResponse(result.matches);
        } else {
          sess.step = 'customer';
          return {
            success: true,
            data: `找不到客戶「${parsed.customerName}」，請重新輸入客戶名稱：`,
            summary: '找不到客戶',
          };
        }
      }
      sess.step = 'customer';
      return askCustomerResponse();
    }

    if (startStep === 'confirm') {
      // 資訊完整 → 查客戶後直接跳到確認
      const result = await searchCustomers(parsed.customerName);
      if (result.success && result.matches.length >= 1) {
        sess.customer = result.matches[0];
        sess.step = 'confirm';
        return orderConfirmResponse(sess);
      }
      // 客戶找不到 → 退回客戶步驟
      sess.step = 'customer';
      return {
        success: true,
        data: `找不到客戶「${parsed.customerName}」，請輸入客戶名稱：`,
        summary: '找不到客戶',
      };
    }

    return typeSelectionResponse();
  },

  /**
   * 從解析好的資料直接建單（PDF/圖片/Email 用）
   * @param {number} chatId
   * @param {Object} parsed - { type, customerName, items: [{name, quantity, price}], note }
   * @param {Object} context - { userId, chatId, llm }
   */
  async startFromParsed(chatId, parsed, context) {
    const startStep = determineStartStep(parsed);
    console.log(`[Order] startFromParsed: startStep=${startStep}`, parsed);

    const sess = createSession(chatId, {
      step: startStep,
      type: parsed?.type || null,
      items: [],
      note: parsed?.note || null,
    });

    // 品項 RAG 比對
    if (parsed?.items && parsed.items.length > 0) {
      try {
        const productSearch = require('../../src/product-search');
        const enrichedItems = [];
        for (const item of parsed.items) {
          const results = await productSearch.searchProduct(item.name);
          const classified = productSearch.classifyResults(results);
          if (classified.autoMatch.length > 0) {
            const matched = classified.autoMatch[0].product;
            enrichedItems.push({
              name: matched.name,
              productCode: matched.productId,
              quantity: item.quantity || 1,
              price: item.price || matched.unitPrice || 0,
              unit: matched.unit || '個',
              _matched: true,
            });
            if (item.name !== matched.name) {
              productSearch.learnAlias(matched.productId, item.name).catch(() => {});
            }
          } else {
            enrichedItems.push({
              name: item.name,
              productCode: null,
              quantity: item.quantity || 1,
              price: item.price || 0,
              unit: '個',
              _matched: false,
            });
          }
        }
        sess.items = enrichedItems;
      } catch (err) {
        console.warn('[Order] startFromParsed RAG 失敗:', err.message);
        sess.items = parsed.items.map(i => ({ ...i, quantity: i.quantity || 1, price: i.price || 0 }));
      }
    }

    // 查客戶
    if (parsed?.customerName) {
      const result = await searchCustomers(parsed.customerName);
      if (result.success && result.matches.length >= 1) {
        sess.customer = result.matches[0];
      }
    }

    // 根據有多少資訊決定回什麼
    if (sess.customer && sess.items.length > 0) {
      sess.step = 'confirm';
      return orderConfirmResponse(sess);
    }

    // 組裝已解析摘要
    const typeName = sess.type === 'sales' ? '銷售單' : sess.type === 'purchase' ? '採購單' : sess.type === 'quotation' ? '報價單' : '未知';
    const itemsSummary = sess.items.length > 0
      ? sess.items.map(i => `  • ${i.name} ×${i.quantity || 1} @${i.price || '?'}`).join('\n')
      : '（無品項）';
    const summary = `📄 已從文件解析出：\n`
      + `類型：${typeName}\n`
      + (parsed?.customerName ? `文件客戶：${parsed.customerName}\n` : '')
      + (sess.items.length > 0 ? `品項：\n${itemsSummary}\n` : '')
      + `\n`;

    if (sess.type && sess.customer) {
      sess.step = 'items';
      return { success: true, data: summary + '請輸入品項：', summary: '等待品項' };
    }
    if (sess.type) {
      sess.step = 'customer';
      if (parsed?.customerName) {
        // 有客戶名但 ERP 找不到 → 提供建立按鈕
        sess._pendingCustomerName = parsed.customerName;
        return {
          success: true,
          data: summary + `⚠️ ERP 找不到「${parsed.customerName}」`,
          summary: '找不到客戶',
          reply_markup: {
            inline_keyboard: [
              [{ text: `✅ 建立「${parsed.customerName}」`, callback_data: 'order_newcustomer' }],
              [
                { text: '✏️ 重新輸入', callback_data: 'order_retrycustomer' },
                { text: '❌ 取消', callback_data: 'order_cancel' },
              ],
            ],
          },
        };
      }
      return { success: true, data: summary + '請輸入客戶名稱：', summary: '等待客戶' };
    }
    return typeSelectionResponse();
  },

  // Export for bot-server
  orderSessions,
  handleCallback,
  handleTextInput,
  getSession,
  deleteSession,
};
