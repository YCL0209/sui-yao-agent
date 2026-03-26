/**
 * Generate PDF Skill (v3)
 *
 * 從 ERP 訂單生成 PDF 單據（報價單/採購單/銷貨單），
 * 轉換為圖片以便在 LINE/Telegram 發送。
 *
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const config = require('../../src/config');
const { erpFetch, ensureAuthenticated } = require('../../lib/erp-client');

// ========================================
// Main Function
// ========================================

async function generatePDF(message, context) {
  try {
    console.log('[PDF] Processing message:', message);

    const state = context.conversationState || {};

    if (state.waitingForPdfType) {
      return handleTypeSelection(message, state, context);
    }

    const parsed = parseMessage(message);

    if (!parsed.orderNumber) {
      return '請提供訂單編號。\n格式：\n- 採購單：生成採購單 PUR-260202-5W1E\n- 銷售單：生成報價單 ORD-260123-SA7M';
    }

    console.log('[PDF] Parsed:', JSON.stringify(parsed, null, 2));

    console.log('[PDF] Querying order:', parsed.orderNumber);
    const ordersData = await erpFetch(`/api/orders?orderNumber=${parsed.orderNumber}`);

    if (!ordersData.success || !ordersData.data || ordersData.data.length === 0) {
      return `找不到訂單「${parsed.orderNumber}」\n請確認訂單編號是否正確。`;
    }

    const order = ordersData.data[0];
    const orderId = order._id;

    console.log('[PDF] Found order:', orderId);

    if (!parsed.type) {
      context.conversationState = {
        ...state,
        waitingForPdfType: true,
        orderId: orderId,
        orderNumber: parsed.orderNumber,
        order: order
      };

      return `✅ 找到訂單 ${parsed.orderNumber}\n`
        + `━━━━━━━━━━━━━━━━\n`
        + `👤 客戶：${order.customerName}\n`
        + `💰 總額：NT$ ${order.totalAmount.toLocaleString()}\n`
        + `\n請選擇單據類型：\n`
        + `1️⃣ 報價單 (quotation)\n`
        + `2️⃣ 採購單 (purchase)\n`
        + `3️⃣ 銷貨單 (sales)\n`
        + `\n請回覆數字 1-3`;
    }

    return await generateAndSendPDF(orderId, parsed.orderNumber, parsed.type, order, context);

  } catch (error) {
    console.error('[PDF] Error:', error);
    return `系統錯誤：${error.message}\n請稍後再試。`;
  }
}

// ========================================
// Message Parsing
// ========================================

function parseMessage(message) {
  const result = {
    orderNumber: null,
    type: null
  };

  const orderMatch = message.match(/(?:PUR|ORD)-\d{6}-[A-Z0-9]{4}/i);
  if (orderMatch) {
    result.orderNumber = orderMatch[0].toUpperCase();
  }

  if (message.includes('報價單') || message.includes('quotation')) {
    result.type = 'quotation';
  } else if (message.includes('採購單') || message.includes('purchase')) {
    result.type = 'purchase';
  } else if (message.includes('銷貨單') || message.includes('sales')) {
    result.type = 'sales';
  }

  return result;
}

// ========================================
// Type Selection Handler
// ========================================

async function handleTypeSelection(message, state, context) {
  const choice = message.trim();

  let type = null;
  if (choice === '1' || choice === '報價單' || choice === 'quotation') {
    type = 'quotation';
  } else if (choice === '2' || choice === '採購單' || choice === 'purchase') {
    type = 'purchase';
  } else if (choice === '3' || choice === '銷貨單' || choice === 'sales') {
    type = 'sales';
  } else {
    return '請回覆數字 1-3 選擇單據類型。';
  }

  return await generateAndSendPDF(state.orderId, state.orderNumber, type, state.order, context);
}

// ========================================
// PDF Generation + Image Conversion
// ========================================

async function generateAndSendPDF(orderId, orderNumber, type, order, context) {
  try {
    console.log(`[PDF] Generating ${type} for order ${orderNumber}`);

    const typeNames = {
      quotation: '報價單',
      purchase: '採購單',
      sales: '銷貨單'
    };
    const typeName = typeNames[type] || type;

    // Ensure directories
    const pdfDir = config.pdf.tempDir;
    const canvasDir = path.resolve(config.canvas.dir);

    if (!fs.existsSync(pdfDir)) {
      fs.mkdirSync(pdfDir, { recursive: true });
    }
    if (!fs.existsSync(canvasDir)) {
      fs.mkdirSync(canvasDir, { recursive: true });
    }

    // Download PDF from ERP
    const pdfPath = path.join(pdfDir, `${orderId}-${type}.pdf`);
    const pdfUrl = `${config.erp.apiUrl}/api/orders/${orderId}/pdf?type=${type}`;

    console.log(`[PDF] Downloading PDF from ${pdfUrl}`);

    const token = await ensureAuthenticated();
    const pdfResponse = await fetch(pdfUrl, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!pdfResponse.ok) {
      console.error(`[PDF] PDF download failed: ${pdfResponse.status}`);
      return `${typeName}生成失敗（${pdfResponse.status}）\n請確認訂單類型是否正確。`;
    }

    const pdfBuffer = await pdfResponse.arrayBuffer();
    fs.writeFileSync(pdfPath, Buffer.from(pdfBuffer));
    console.log(`[PDF] PDF saved to ${pdfPath} (${pdfBuffer.byteLength} bytes)`);

    // Convert PDF to PNG
    const baseFilename = `${type}-${orderNumber}`;
    const outputPrefix = path.join(canvasDir, baseFilename);
    const convertCmd = `pdftoppm -png -r 150 "${pdfPath}" "${outputPrefix}"`;

    console.log(`[PDF] Converting PDF to images: ${convertCmd}`);
    execSync(convertCmd);

    // Find generated PNG files
    const files = fs.readdirSync(canvasDir);
    const imageFiles = files
      .filter(f => f.startsWith(baseFilename) && f.endsWith('.png'))
      .sort()
      .map(f => path.join(canvasDir, f));

    console.log(`[PDF] Generated ${imageFiles.length} image(s):`, imageFiles);

    if (imageFiles.length === 0) {
      return {
        text: `${typeName}生成成功，但圖片轉換失敗。\nPDF 位置：${pdfPath}`,
        localPaths: [],
      };
    }

    // 組裝圖片資訊（含本地路徑）
    const images = imageFiles.map((imgPath, i) => ({
      localPath: imgPath,
      caption: i === 0
        ? `${typeName} - ${orderNumber}\n客戶：${order.customerName}\n(第 ${i + 1}/${imageFiles.length} 頁)`
        : `(第 ${i + 1}/${imageFiles.length} 頁)`,
    }));

    console.log(`[PDF] Generated ${images.length} image(s):`, images.map(i => i.localPath));

    return {
      text: `✅ ${typeName}已生成\n📋 ${orderNumber}\n👤 ${order.customerName}\n📄 共 ${images.length} 頁`,
      localPaths: images,
      documentType: typeName,
      orderNumber,
      customerName: order.customerName,
    };

  } catch (error) {
    console.error('[PDF] Generation error:', error);
    return `生成失敗：${error.message}\n請確認 pdftoppm 工具是否已安裝。`;
  }
}

// ========================================
// v3 Standard Interface
// ========================================

module.exports = {
  name: 'generate-pdf',
  description: '從 ERP 訂單生成 PDF 單據（報價單/採購單/銷貨單）',
  version: '1.0.0',

  definition: {
    name: 'generate-pdf',
    description: '生成 PDF 單據並轉換為圖片',
    parameters: {
      type: 'object',
      properties: {
        orderNumber: { type: 'string', description: '訂單編號（例如 ORD-260123-SA7M）' },
        type:        { type: 'string', enum: ['quotation', 'purchase', 'sales'], description: '單據類型' }
      },
      required: ['orderNumber']
    }
  },

  async run(args, context) {
    const message = args.type
      ? `生成${args.type === 'quotation' ? '報價單' : args.type === 'purchase' ? '採購單' : '銷貨單'} ${args.orderNumber}`
      : args.orderNumber;
    const result = await generatePDF(message, context || {});
    // generateAndSendPDF 現在回傳物件 { text, localPaths, ... }
    if (result && typeof result === 'object' && result.text) {
      return { success: true, data: result.text, summary: result.text, localPaths: result.localPaths };
    }
    // 其他情況（parseMessage 階段的字串回傳）
    return { success: true, data: result, summary: typeof result === 'string' ? result : '' };
  },

  // Legacy exports
  generatePDF,
  parseMessage,
  generateAndSendPDF,
};
