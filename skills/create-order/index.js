/**
 * Create Order Skill (v3) — 純工具函式庫
 *
 * 互動邏輯已搬到 src/agents/order-agent.js，本檔案只保留：
 * - LLM 解析（parseOrderWithLLM / simpleParseOrder）
 * - 品項解析（parseItems）
 * - ERP 操作（searchCustomers / submitOrder / createCustomerInERP）
 * - 產品 RAG 比對（enrichItemsWithRAG）
 * - PDF 生成包裝（generatePDF）
 * - LLM tool calling 入口（run）— 會啟動 ISM session
 *
 * @version 3.0.0
 */

const { erpFetch } = require('../../lib/erp-client');
const config = require('../../src/config');

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

品項解析規則：
- 使用者可能用空格、逗號、換行、分號分隔多個品項
- 常見格式：「品名 x數量@單價」「品名 ×數量 @單價」「品名 *數量 單價」
- 多品項可能連續出現：「品名Ax1@100 品名Bx2@200」
- 如果一段文字裡出現多個料號（英文字母+數字+符號的組合），每個料號是獨立品項
- items 陣列必須包含所有解析出的品項，不要遺漏

範例：
- "幫王大明建一張銷售單，A4紙 100包 150元" → {"type":"sales","customerName":"王大明","items":[{"name":"A4紙","quantity":100,"price":150,"category":"其他"}],"note":null}
- "建立訂單" → {"type":null,"customerName":null,"items":[],"note":null}
- "採購單 大明企業 影印紙x50@120" → {"type":"purchase","customerName":"大明企業","items":[{"name":"影印紙","quantity":50,"price":120,"category":"其他"}],"note":null}
- "出一份報價單給大明企業" → {"type":"quotation","customerName":"大明企業","items":[],"note":null}
- "Cable#OAC-SUI001A x1@325 Cable#ODC-SUI001A x1@325" → {"type":null,"customerName":null,"items":[{"name":"Cable#OAC-SUI001A","quantity":1,"price":325,"category":"線材"},{"name":"Cable#ODC-SUI001A","quantity":1,"price":325,"category":"線材"}],"note":null}`
        },
        { role: 'user', content: message }
      ],
      temperature: 0.1,
    });

    const text = (response.content || '').trim();
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
// 品項文字解析
// ========================================

function parseItems(text) {
  const items = [];

  // 先用全域正則掃描所有「品名 x數量 @單價」格式的品項
  const globalPattern = /([^\s,，;；]+?)\s*[xX×*]\s*(\d+)\s*(?:[@＠]\s*(\d+(?:\.\d+)?))?/g;
  let gm;
  while ((gm = globalPattern.exec(text)) !== null) {
    items.push({ name: gm[1].trim(), quantity: parseInt(gm[2]), price: gm[3] ? parseFloat(gm[3]) : 0 });
  }
  if (items.length > 0) return items;

  // fallback: 逗號/換行/分號切分後逐段解析
  const segments = text.split(/[,，;；\n]+/).map(s => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const m = seg.match(/^(.+?)\s+(\d+)\s*(?:包|個|組|箱|件)?\s*(\d+)?\s*(?:元)?$/);
    if (m) {
      items.push({ name: m[1].trim(), quantity: parseInt(m[2]), price: m[3] ? parseInt(m[3]) : 0 });
    }
  }
  return items;
}

// ========================================
// 智慧判斷起始步驟
// ========================================

function determineStartStep(parsed) {
  if (!parsed) return 'type';
  if (!parsed.type) return 'type';
  if (!parsed.customerName || parsed.customerName === null) return 'customer';
  if (!parsed.items || parsed.items.length === 0) return 'items';
  return 'confirm';
}

// ========================================
// RAG 產品比對
// ========================================

/**
 * 將原始品項與 ERP 產品庫比對
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

// ========================================
// ERP 建立新客戶
// ========================================

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

// ========================================
// 提交訂單到 ERP
// ========================================

/**
 * 提交訂單到 ERP
 * @param {Object} orderData — agent session.data 的內容
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

// ========================================
// PDF 生成包裝
// ========================================

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

// ========================================
// Module exports
// ========================================

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

  /**
   * LLM tool_call 入口
   * 解析用戶訊息後透過 ISM 啟動互動 session（由 order-agent 接管）。
   */
  async run(args, context) {
    const chatId = context.chatId;
    const userId = context.userId;
    const message = args.message || '';
    const llmAdapter = context.llm || null;

    let parsed = await parseOrderWithLLM(message, llmAdapter);
    if (!parsed) parsed = simpleParseOrder(message);

    // lazy require 避免循環依賴（order-agent require create-order）
    const { startOrderSession } = require('../../src/agents/order-agent');
    const result = await startOrderSession(chatId, userId, { parsed });

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
