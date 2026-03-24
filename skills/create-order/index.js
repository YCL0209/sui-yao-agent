/**
 * Create Order Skill (v3)
 *
 * 完整訂單建立流程：
 * 1. 解析用戶輸入（客戶、品項、地址、備註）
 * 2. 查詢 ERP 客戶
 * 3. 處理找不到客戶（建立新客戶 / 重新輸入）
 * 4. 確認訂單詳情
 * 5. 呼叫 ERP API 建立訂單
 *
 * @version 1.0.0
 */

const { erpFetch } = require('../../lib/erp-client');

// ========================================
// Main Skill Function
// ========================================

async function createOrder(message, context, claudeApi) {
  try {
    const state = context.conversationState || {};

    if (state.waitingForConfirmation) {
      return handleConfirmation(message, state);
    }

    if (state.waitingForCustomerChoice) {
      return handleCustomerChoice(message, state);
    }

    // Step 1: Parse order message
    console.log('[Order] Parsing message:', message);
    const parsed = await parseOrderMessage(message, claudeApi);

    if (!parsed || parsed.confidence < 0.5) {
      return '無法理解訂單內容。請提供：客戶名稱、品項和數量。\n'
        + '範例："/order 王小明 A產品x2 B產品x1"';
    }

    console.log('[Order] Parsed order:', JSON.stringify(parsed, null, 2));

    // Step 2: Query customer from ERP
    console.log('[Order] Querying customer:', parsed.customerName);
    const customers = await erpFetch('/api/customers');

    if (!customers.success) {
      return '無法連接 ERP 系統。請稍後再試。';
    }

    const matchedCustomer = findCustomer(parsed.customerName, customers.data);

    if (!matchedCustomer) {
      context.conversationState = {
        ...state,
        waitingForCustomerChoice: true,
        parsedOrder: parsed,
        allCustomers: customers.data
      };

      return `找不到客戶「${parsed.customerName}」\n`
        + `\n請選擇：\n`
        + `1️⃣ 建立新客戶「${parsed.customerName}」\n`
        + `2️⃣ 重新輸入客戶名稱\n`
        + `3️⃣ 取消\n`
        + `\n請回覆 1、2 或 3`;
    }

    return buildOrderConfirmation(parsed, matchedCustomer, context);

  } catch (error) {
    console.error('[Order] Error:', error);
    return `系統錯誤：${error.message}\n請稍後再試。`;
  }
}

// ========================================
// Order Message Parsing
// ========================================

async function parseOrderMessage(message, claudeApi) {
  if (claudeApi && claudeApi.complete) {
    try {
      const response = await claudeApi.complete({
        prompt: `Parse this order message and extract customer name, items, quantity, price, address, and notes.

Message: "${message}"

Return JSON with format:
{
  "customerName": "customer name",
  "items": [{"name": "product name", "quantity": number, "price": number or 0}, ...],
  "address": "address or null",
  "note": "notes or null",
  "confidence": 0.0 to 1.0
}

Price format examples:
- "ABC電線x1@500" → price: 500
- "ABC電線x1" → price: 0 (not specified)

Only return valid JSON, no other text.`,
        max_tokens: 500
      });

      try {
        return JSON.parse(response);
      } catch (e) {
        return simpleParseOrder(message);
      }
    } catch (error) {
      console.warn('[Order] Claude parsing failed, using simple parser:', error.message);
      return simpleParseOrder(message);
    }
  }

  return simpleParseOrder(message);
}

function simpleParseOrder(message) {
  let text = message.replace(/^\/order\s*/i, '').trim();

  if (!text) {
    return null;
  }

  const items = [];
  const itemPatterns = [
    /([^x@,，]*?)x(\d+)(?:@(\d+))?/gi,
    /(\d+)\s*(?:个)?([^,，\d@]+)(?:@(\d+))?/gi,
    /([^,，\d@]+?)\s*(\d+)(?:@(\d+))?/gi
  ];

  let itemsText = text;

  for (const pattern of itemPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const product = match[1]?.trim() || match[2]?.trim();
      const qty = parseInt(match[2] || match[match.length - 2]);
      const price = match[3] ? parseInt(match[3]) : 0;

      if (product && !isNaN(qty) && qty > 0) {
        if (!items.find(i => i.name.toLowerCase() === product.toLowerCase())) {
          items.push({
            name: product,
            quantity: qty,
            price: price || 0
          });
          itemsText = itemsText.replace(match[0], '');
        }
      }
    }
  }

  if (items.length === 0) {
    return null;
  }

  const parts = itemsText.split(/[,，]/);
  const customerName = parts[0]?.trim() || null;

  return {
    customerName,
    items,
    address: null,
    note: null,
    confidence: 0.7
  };
}

// ========================================
// Customer Matching
// ========================================

function findCustomer(searchName, customers) {
  if (!searchName || !Array.isArray(customers)) {
    return null;
  }

  const search = searchName.toLowerCase().trim();

  let match = customers.find(c => c.name.toLowerCase() === search);
  if (match) return match;

  match = customers.find(c => c.contact && c.contact.toLowerCase() === search);
  if (match) return match;

  match = customers.find(c => c.name.toLowerCase().includes(search) || search.includes(c.name.toLowerCase()));
  if (match) return match;

  return null;
}

// ========================================
// Order Confirmation
// ========================================

function buildOrderConfirmation(parsedOrder, customer, context) {
  const totalAmount = parsedOrder.items.reduce((sum, item) => {
    return sum + (item.quantity * (item.price || 0));
  }, 0);

  const itemsSummary = parsedOrder.items
    .map(i => {
      const priceInfo = i.price > 0 ? ` @ $${i.price}` : ' (價格未填)';
      const lineTotal = i.price > 0 ? ` = $${i.quantity * i.price}` : '';
      return `  • ${i.name} × ${i.quantity}${priceInfo}${lineTotal}`;
    })
    .join('\n');

  const address = parsedOrder.address || customer.address || 'Not specified';
  const paymentMethod = customer.payment?.method || '現金';

  const confirmMsg = `✅ 訂單確認\n`
    + `━━━━━━━━━━━━━━━━\n`
    + `👤 客戶：${customer.name} (${customer.customerCode || '無'})\n`
    + `📦 品項：\n${itemsSummary}\n`
    + `💰 總額：$${totalAmount}${totalAmount === 0 ? ' (待補價格)' : ''}\n`
    + `📍 地址：${address}\n`
    + `💳 付款：${paymentMethod}\n`
    + (parsedOrder.note ? `📝 備註：${parsedOrder.note}\n` : '')
    + `━━━━━━━━━━━━━━━━\n`
    + `請回覆「確認」以建立訂單，或「取消」`;

  context.conversationState = {
    ...(context.conversationState || {}),
    waitingForConfirmation: true,
    orderData: {
      parsedOrder,
      customerId: customer._id,
      customer
    }
  };

  return confirmMsg;
}

// ========================================
// Confirmation Handler
// ========================================

async function handleConfirmation(message, state) {
  const response = message.toLowerCase().trim();

  if (response === 'confirm' || response === 'yes' || response === 'y' || response === '是' || response === '確認') {
    return createOrderInERP(state.orderData);
  } else if (response === 'cancel' || response === 'no' || response === 'n' || response === '否' || response === '取消') {
    return '訂單建立已取消。';
  } else {
    return '請回覆「確認」以建立訂單，或「取消」。';
  }
}

// ========================================
// Customer Choice Handler
// ========================================

async function handleCustomerChoice(message, state) {
  const choice = message.trim();

  if (choice === '1' || choice === '建立' || choice === 'create') {
    try {
      const newCustomer = await erpFetch('/api/customers', {
        method: 'POST',
        body: JSON.stringify({
          name: state.parsedOrder.customerName,
          phone: state.parsedOrder.phone || '',
          type: 'customer',
          payment: { method: 'cash' }
        })
      });

      if (!newCustomer.success) {
        return `建立客戶失敗：${newCustomer.message}`;
      }

      console.log('[Order] New customer created:', newCustomer.data.customerCode);
      return buildOrderConfirmation(state.parsedOrder, newCustomer.data, state);

    } catch (error) {
      return `建立客戶時發生錯誤：${error.message}`;
    }

  } else if (choice === '2' || choice === '重新輸入' || choice === 'retry') {
    delete state.waitingForCustomerChoice;
    return `請輸入正確的客戶名稱：`;

  } else if (choice === '3' || choice === '取消' || choice === 'cancel') {
    return '訂單建立已取消。';

  } else {
    return '請回覆：\n1️⃣ 建立新客戶\n2️⃣ 重新輸入客戶名稱\n3️⃣ 取消';
  }
}

// ========================================
// ERP Order Creation
// ========================================

async function createOrderInERP(orderData) {
  try {
    const { parsedOrder, customer } = orderData;

    const orderPayload = {
      orderType: 'sales',
      customerId: orderData.customerId,
      customerName: customer.name,
      customerPhone: customer.phone || parsedOrder.phone || '',
      shippingAddress: parsedOrder.address || customer.address || '',
      items: parsedOrder.items.map(item => ({
        productCode: item.name,
        productName: item.name,
        quantity: item.quantity,
        unitPrice: item.price || 0
      })),
      paymentInfo: {
        method: customer.payment?.method || 'cash',
        isPaid: false,
        paidAmount: 0
      },
      notes: parsedOrder.note || ''
    };

    console.log('[Order] Creating order in ERP:', JSON.stringify(orderPayload, null, 2));

    const result = await erpFetch('/api/orders', {
      method: 'POST',
      body: JSON.stringify(orderPayload)
    });

    if (!result.success) {
      return `建立訂單失敗：${result.message || '未知錯誤'}`;
    }

    const orderNumber = result.data.orderNumber;
    const totalAmount = parsedOrder.items.reduce((sum, i) => sum + (i.quantity * (i.price || 0)), 0);

    const itemsList = parsedOrder.items
      .map(i => {
        const priceInfo = i.price > 0 ? ` @ $${i.price}` : '';
        return `  • ${i.name} × ${i.quantity}${priceInfo}`;
      })
      .join('\n');

    return `✅ 訂單建立成功！\n`
      + `━━━━━━━━━━━━━━━━\n`
      + `📋 訂單編號：${orderNumber}\n`
      + `👤 客戶：${customer.name}\n`
      + `📦 品項：\n${itemsList}\n`
      + `💰 總額：$${totalAmount}${totalAmount === 0 ? ' (待補價格)' : ''}\n`
      + `⏱️ 狀態：待處理\n`
      + `━━━━━━━━━━━━━━━━\n\n`
      + `💡 提示：如需出單，請輸入 /pdf ${orderNumber}`;

  } catch (error) {
    console.error('[Order] ERP creation error:', error);
    return `系統錯誤：${error.message}\n請聯絡客服。`;
  }
}

// ========================================
// v3 Standard Interface
// ========================================

module.exports = {
  name: 'create-order',
  description: '建立 ERP 訂單（解析用戶輸入 → 查客戶 → 確認 → 建單）',
  version: '1.0.0',

  definition: {
    name: 'create-order',
    description: '建立銷售訂單',
    parameters: {
      type: 'object',
      properties: {
        customerName: { type: 'string', description: '客戶名稱' },
        items:        { type: 'array', description: '品項列表 [{name, quantity, price}]' },
        address:      { type: 'string', description: '送貨地址' },
        note:         { type: 'string', description: '訂單備註' },
        message:      { type: 'string', description: '自然語言訂單描述（會自動解析）' }
      }
    }
  },

  async run(args, context) {
    // 如果有結構化資料，直接用
    if (args.customerName && args.items) {
      const parsed = {
        customerName: args.customerName,
        items: args.items,
        address: args.address || null,
        note: args.note || null,
        confidence: 1.0
      };

      const customers = await erpFetch('/api/customers');
      if (!customers.success) {
        return { success: false, data: null, summary: '無法連接 ERP 系統' };
      }

      const customer = findCustomer(parsed.customerName, customers.data);
      if (!customer) {
        return { success: false, data: null, summary: `找不到客戶「${parsed.customerName}」` };
      }

      const result = await createOrderInERP({ parsedOrder: parsed, customerId: customer._id, customer });
      return { success: true, data: result, summary: result };
    }

    // 否則走原有 free-text 解析流程
    const message = args.message || '';
    const result = await createOrder(message, context || {}, null);
    return { success: true, data: result, summary: result };
  },

  // Legacy exports
  createOrder,
  parseOrderMessage,
  findCustomer,
};
