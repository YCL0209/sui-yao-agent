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

function cancelOnlyButtons() {
  return {
    inline_keyboard: [
      [{ text: '❌ 取消', callback_data: 'order:cancel' }],
    ],
  };
}

// 品項下拉選單（Discord 用；Telegram adapter 會忽略此欄位）
// 最多 25 個選項（Discord 硬上限）；超過的話後面品項就下拉看不到，但文字指令仍可操作
function itemSelectMenu(items, selectedIdx) {
  const options = items.slice(0, 25).map((i, idx) => {
    const code = i.productCode ? `[${i.productCode}] ` : '';
    const name = i.matchedName || i.originalName || i.name || '未命名';
    // Discord option label 最多 100 字元
    const rawLabel = `${idx + 1}. ${code}${name} ×${i.quantity}`;
    const label = rawLabel.length > 100 ? rawLabel.slice(0, 97) + '…' : rawLabel;
    return { label, value: String(idx), default: idx === selectedIdx };
  });

  let placeholder = '選擇品項編輯 ▼';
  if (selectedIdx !== undefined && items[selectedIdx]) {
    const item = items[selectedIdx];
    const name = item.matchedName || item.originalName || item.name || '未命名';
    placeholder = `已選：${name.slice(0, 60)}`;
  }

  return {
    custom_id: 'order:item:sel',
    placeholder,
    options,
  };
}

// 品項編輯中的按鈕列（已選品項）
function itemActionButtons(idx, item) {
  const qty = item.quantity || 1;
  return [
    [
      { text: `− 1 (${qty} → ${Math.max(qty - 1, 0)})`, callback_data: `order:qty:dec:${idx}` },
      { text: `+ 1 (${qty} → ${qty + 1})`, callback_data: `order:qty:inc:${idx}` },
      { text: '🗑 移除', callback_data: `order:qty:del:${idx}` },
    ],
    [{ text: '↩ 返回品項選擇', callback_data: 'order:item:back' }],
    [
      { text: '✅ 確認建單', callback_data: 'order:confirm' },
      { text: '❌ 取消', callback_data: 'order:cancel' },
    ],
  ];
}

// 統一渲染 confirm 步驟（summary + 對應按鈕 + Discord 下拉）
// - 無品項 → 提示 + 只給取消
// - 有 _selectedItemIdx → 已選狀態：[-][+][🗑][↩] 按鈕 + select（標 default）
// - 未選 → 一般狀態：[確認][取消] 按鈕 + select
function renderConfirmStep(session) {
  const items = session.data.items || [];

  if (items.length === 0) {
    return {
      text: '⚠️ 訂單已無品項，請取消後重新建單。',
      reply_markup: cancelOnlyButtons(),
    };
  }

  // _selectedItemIdx 可能指向已被刪除的 index，保險檢查
  let idx = session.data._selectedItemIdx;
  if (idx !== undefined && !items[idx]) {
    delete session.data._selectedItemIdx;
    idx = undefined;
  }

  const summary = formatOrderSummary(session);

  if (idx !== undefined) {
    const item = items[idx];
    const displayName = item.matchedName || item.originalName || item.name || '未命名';
    return {
      text: summary + `\n\n✏️ 編輯中：${displayName} ×${item.quantity}`,
      reply_markup: {
        inline_keyboard: itemActionButtons(idx, item),
        select_menu: itemSelectMenu(items, idx),
      },
    };
  }

  return {
    text: summary,
    reply_markup: {
      inline_keyboard: confirmButtons().inline_keyboard,
      select_menu: itemSelectMenu(items),
    },
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

function pdfButtons(orderNumber, orderType) {
  const docButtons = orderType === 'purchase'
    ? [{ text: '📄 採購單', callback_data: `order:pdf:purchase:${orderNumber}` }]
    : [
        { text: '📄 報價單', callback_data: `order:pdf:quotation:${orderNumber}` },
        { text: '📄 銷貨單', callback_data: `order:pdf:sales:${orderNumber}` },
      ];
  return {
    inline_keyboard: [
      docButtons,
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

  const itemLines = (data.items || []).map((i, idx) => {
    const num = `${idx + 1}.`;
    const code = i.productCode ? `[${i.productCode}] ` : '';
    const unit = i.unit || '個';
    const priceStr = i.price > 0 ? ` @NT$${i.price}/${unit}` : ' (價格未填)';
    const totalStr = i.price > 0 ? ` = NT$${i.quantity * i.price}` : '';
    // displayName 優先順序：matchedName（ERP 標準）> spec（PDF 原文）> name > '未命名'
    //   避免 matchedName 跟 spec 都空時退回 name = productCode 變成 "[PRO-236] PRO-236"
    const displayName = i.matchedName || i.spec || i.name || i.originalName || '未命名';

    let line = `  ${num} ${code}${displayName} ×${i.quantity}${priceStr}${totalStr}`;

    // 警告層級由強到弱：
    // (1) ERP 查不到 productCode（PDF 抽到 code 但庫裡沒）→ 最優先警告
    // (2) PDF 原文規格跟顯示名不同 → 小字顯示供口核
    // (3) 舊路徑 matchedName vs originalName 不符
    if (i._codeNotFoundInErp) {
      line += `\n     ⚠️ ERP 找不到此產品編號，建議先確認或到 ERP 建立`;
      // 同時顯示規格原文，讓 admin 清楚是什麼商品
      if (i.spec && i.spec !== displayName) {
        line += `\n     📍 規格：${i.spec}`;
      }
    } else if (i.spec && i.spec !== displayName) {
      line += `\n     📍 規格：${i.spec}`;
    } else if (i.matchedName && i.originalName && i.originalName !== i.matchedName) {
      line += `\n     ⚠️ 比對為 ERP 標準名，請確認`;
    }
    return line;
  }).join('\n');

  const total = (data.items || []).reduce((s, i) => s + i.quantity * (i.price || 0), 0);

  return `📋 訂單確認：\n\n`
    + `類型：${typeName}\n`
    + `客戶：${customerName}${company}\n`
    + `品項：\n${itemLines}\n`
    + `合計：NT$ ${total.toLocaleString()}${total === 0 ? ' (待補價格)' : ''}\n`
    + `\n💡 Discord：用下拉選品項編輯數量；Telegram：輸入「全部 3」「MADLN02BD 改 5」「×3」調整`;
}

// ========================================
// 數量調整解析（confirm 步驟的文字輸入）
// ========================================

function applyQtyEdit(text, items) {
  if (!items.length) return { matched: false };

  // 整單倍數：×3 / x3 / *3（單獨一個 token）
  const mulMatch = text.match(/^\s*[×x*]\s*(\d{1,2})\s*$/i);
  if (mulMatch) {
    const n = parseInt(mulMatch[1], 10);
    if (n >= 1 && n <= 99) {
      return {
        matched: true,
        items: items.map(it => ({ ...it, quantity: (it.quantity || 1) * n })),
        feedback: `✅ 已將所有品項數量 ×${n}`,
      };
    }
  }

  // 全部設為 N：全部 3 / 每項 3 / 都 3 / 都改 3 / 全部改 3
  const allMatch = text.match(/^\s*(?:全部|每項|每個|都)(?:改|設為|改成)?\s*(\d{1,3})\s*(?:個|組|台|條|支)?\s*$/);
  if (allMatch) {
    const n = parseInt(allMatch[1], 10);
    if (n >= 1 && n <= 999) {
      return {
        matched: true,
        items: items.map(it => ({ ...it, quantity: n })),
        feedback: `✅ 已將所有品項數量設為 ${n}`,
      };
    }
  }

  // 指定品項：<keyword> [改|x|×|*]? N
  const itemMatch = text.match(/^\s*(.+?)\s*(?:改|改成|設為|[x×*])\s*(\d{1,3})\s*(?:個|組|台|條|支)?\s*$/i);
  if (itemMatch) {
    const keyword = itemMatch[1].trim();
    const n = parseInt(itemMatch[2], 10);
    if (n >= 1 && n <= 999 && keyword.length >= 1) {
      const kwLower = keyword.toLowerCase();
      const hits = [];
      const newItems = items.map((it, idx) => {
        const code = (it.productCode || '').toLowerCase();
        const name = (it.matchedName || it.originalName || it.name || '').toLowerCase();
        const origName = (it.originalName || '').toLowerCase();
        const isHit = code === kwLower
          || (code && code.includes(kwLower))
          || (name && name.includes(kwLower))
          || (origName && origName.includes(kwLower));
        if (isHit) {
          hits.push(it.productCode || it.matchedName || it.name);
          return { ...it, quantity: n };
        }
        return it;
      });
      if (hits.length > 0) {
        return {
          matched: true,
          items: newItems,
          feedback: `✅ 已將「${hits.join('、')}」數量設為 ${n}`,
        };
      }
    }
  }

  return { matched: false };
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
        return renderConfirmStep(session);
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
          const rendered = renderConfirmStep(session);
          return {
            ...rendered,
            text: MESSAGES.customerCreated(pendingName) + '\n\n' + rendered.text,
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

    // item:sel:IDX — Discord 下拉選品項
    // item:back    — 返回品項選擇
    if (action === 'item') {
      const [sub, arg] = (payload || '').split(':');
      if (sub === 'sel') {
        const idx = parseInt(arg, 10);
        if (!Number.isNaN(idx) && session.data.items?.[idx]) {
          session.data._selectedItemIdx = idx;
          return renderConfirmStep(session);
        }
        return { text: MESSAGES.expired };
      }
      if (sub === 'back') {
        delete session.data._selectedItemIdx;
        return renderConfirmStep(session);
      }
      return { text: MESSAGES.unknownAction };
    }

    // qty:inc:IDX / qty:dec:IDX / qty:del:IDX — 單品項數量編輯
    if (action === 'qty') {
      const [sub, arg] = (payload || '').split(':');
      const idx = parseInt(arg, 10);
      const items = session.data.items || [];
      if (Number.isNaN(idx) || !items[idx]) {
        return { text: MESSAGES.expired };
      }

      if (sub === 'inc') {
        items[idx].quantity = (items[idx].quantity || 1) + 1;
        // 保持 _selectedItemIdx 不變，續編同品項
        return renderConfirmStep(session);
      }

      if (sub === 'dec') {
        const newQty = (items[idx].quantity || 1) - 1;
        if (newQty <= 0) {
          items.splice(idx, 1);
          delete session.data._selectedItemIdx;
        } else {
          items[idx].quantity = newQty;
        }
        return renderConfirmStep(session);
      }

      if (sub === 'del') {
        items.splice(idx, 1);
        delete session.data._selectedItemIdx;
        return renderConfirmStep(session);
      }

      return { text: MESSAGES.unknownAction };
    }

    // confirm — 確認建單，送 ERP
    if (action === 'confirm') {
      try {
        const result = await orderSkill.submitOrder(session.data);
        const orderNumber = result.orderNumber;
        return {
          text: MESSAGES.orderCreated(orderNumber),
          reply_markup: pdfButtons(orderNumber, session.data.type),
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
          const rendered = renderConfirmStep(session);
          return { ...rendered, text: prefix + '\n\n' + rendered.text };
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
      return renderConfirmStep(session);
    }

    // confirm 步驟：允許打字調整數量（×3、全部 3、MADLN02BD 改 5 …）
    if (session.step === 'confirm') {
      const result = applyQtyEdit(trimmed, session.data.items || []);
      if (result.matched) {
        session.data.items = result.items;
        delete session.data._selectedItemIdx;  // 文字改完後回到未選狀態
        const rendered = renderConfirmStep(session);
        return { ...rendered, text: result.feedback + '\n\n' + rendered.text };
      }
      // 沒 match 就不攔截，讓主流程接手
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
    return renderConfirmStep(session);
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
