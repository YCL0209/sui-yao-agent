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
    // 注意：因為 confirm 已 done:true 清除 session，PDF 按鈕通常會走 bot-server 的 fallback
    // 這段保留以防有其他流程在 session 內按 PDF
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
