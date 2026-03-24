/**
 * Print Label Skill (v3)
 *
 * 透過精臣標籤機列印標籤（文字、條碼、QR Code）。
 * 支援自由文字標籤和 ERP 產品標籤。
 *
 * @version 1.0.0
 */

const http = require('http');
const config = require('../../src/config');
const { erpFetch } = require('../../lib/erp-client');

// ========================================
// Layout Constants (mm)
// ========================================

const MARGIN_LEFT = 5;
const MARGIN_TOP = 3;
const DEFAULT_FONT_SIZE = 4;

// ========================================
// Printer API
// ========================================

function sendPrintJob(labelData) {
  return new Promise((resolve, reject) => {
    const url = new URL('/print-label', config.printer.apiUrl);
    const postData = JSON.stringify(labelData);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.printer.apiKey,
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`Invalid response: ${body}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('列印請求逾時'));
    });

    req.write(postData);
    req.end();
  });
}

function checkPrinterStatus() {
  return new Promise((resolve, reject) => {
    const url = new URL('/printer/status', config.printer.apiUrl);

    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      headers: { 'x-api-key': config.printer.apiKey },
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('無法解析印表機狀態'));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('印表機連線逾時'));
    });

    req.end();
  });
}

// ========================================
// Message Parsing
// ========================================

function parseMessage(message) {
  const result = {
    mode: 'text',
    text: '',
    barcode: null,
    qrcode: null,
    copies: 1,
    productNo: null,
  };

  let cleaned = message
    .replace(/^(列印標籤|印標籤|標籤列印|印貼紙|print\s*label|列印貼紙|印\s*標籤)\s*/i, '')
    .trim();

  const productMatch = cleaned.match(/^(印?產品標籤|product)\s+(.+)/i);
  if (productMatch) {
    result.mode = 'product';
    result.productNo = productMatch[2].trim();
    return result;
  }

  const copiesMatch = cleaned.match(/[xX×]\s*(\d+)\s*$/);
  if (copiesMatch) {
    result.copies = parseInt(copiesMatch[1]);
    cleaned = cleaned.replace(/[xX×]\s*\d+\s*$/, '').trim();
  }

  const barcodeMatch = cleaned.match(/條碼[:：]\s*(\S+)/);
  if (barcodeMatch) {
    result.barcode = barcodeMatch[1];
    result.mode = 'barcode';
    cleaned = cleaned.replace(/條碼[:：]\s*\S+/, '').trim();
  }

  const qrcodeMatch = cleaned.match(/[Qq][Rr]\s*[Cc]ode[:：]\s*(\S+)/);
  if (qrcodeMatch) {
    result.qrcode = qrcodeMatch[1];
    result.mode = 'barcode';
    cleaned = cleaned.replace(/[Qq][Rr]\s*[Cc]ode[:：]\s*\S+/, '').trim();
  }

  const nameMatch = cleaned.match(/品名[:：]\s*(\S+)/);
  if (nameMatch) {
    result.text = nameMatch[1];
    cleaned = cleaned.replace(/品名[:：]\s*\S+/, '').trim();
  }

  if (!result.text && cleaned) {
    result.text = cleaned;
  }

  return result;
}

// ========================================
// Label Layout Builders
// ========================================

function buildTextLabel(text, copies) {
  const labelWidth = config.printer.labelWidth;
  const labelHeight = config.printer.labelHeight;
  const textWidth = labelWidth - MARGIN_LEFT - 5;

  const lines = text.split(/[\/\n]/).map(l => l.trim()).filter(Boolean);
  const lineCount = lines.length;
  const availHeight = labelHeight - MARGIN_TOP - 3;

  let fontSize, lineHeight;
  if (lineCount === 1) {
    fontSize = lines[0].length <= 6 ? 7 : (lines[0].length <= 10 ? 5 : 4);
    lineHeight = fontSize + 4;
  } else if (lineCount === 2) {
    fontSize = 6;
    lineHeight = Math.floor(availHeight / 2);
  } else {
    fontSize = 5;
    lineHeight = Math.floor(availHeight / lineCount);
  }

  const totalHeight = lineHeight * lineCount;
  const startY = MARGIN_TOP + Math.round((availHeight - totalHeight) / 2);

  const content = lines.map((line, i) => ({
    type: 'text',
    x: MARGIN_LEFT,
    y: startY + (i * lineHeight),
    width: textWidth,
    height: lineHeight,
    value: line,
    fontSize,
  }));

  return {
    label: { width: labelWidth, height: labelHeight, rotate: 0 },
    content,
    copies,
  };
}

function buildBarcodeLabel(text, barcode, qrcode, copies) {
  const labelWidth = config.printer.labelWidth;
  const labelHeight = config.printer.labelHeight;
  const textWidth = labelWidth - MARGIN_LEFT - 5;
  const content = [];
  let y = MARGIN_TOP;

  if (text) {
    content.push({
      type: 'text',
      x: MARGIN_LEFT,
      y,
      width: textWidth,
      height: 8,
      value: text,
      fontSize: 4,
      bold: true,
    });
    y += 10;
  }

  if (barcode) {
    content.push({
      type: 'barcode',
      x: MARGIN_LEFT,
      y,
      width: textWidth,
      height: 10,
      value: barcode,
      barcodeType: 'CODE128',
    });
    y += 12;
  }

  if (qrcode) {
    const qrSize = 15;
    content.push({
      type: 'qrcode',
      x: Math.round((labelWidth - qrSize) / 2),
      y,
      width: qrSize,
      height: qrSize,
      value: qrcode,
    });
  }

  return {
    label: { width: labelWidth, height: labelHeight, rotate: 0 },
    content,
    copies,
  };
}

function buildProductLabel(productNo, productName, copies) {
  const labelWidth = config.printer.labelWidth;
  const labelHeight = config.printer.labelHeight;
  const textWidth = labelWidth - MARGIN_LEFT - 5;

  return {
    label: { width: labelWidth, height: labelHeight, rotate: 0 },
    content: [
      {
        type: 'text',
        x: MARGIN_LEFT,
        y: MARGIN_TOP,
        width: textWidth,
        height: 8,
        value: productName || productNo,
        fontSize: 4,
        bold: true,
      },
      {
        type: 'barcode',
        x: MARGIN_LEFT,
        y: 14,
        width: textWidth,
        height: 12,
        value: productNo,
        barcodeType: 'CODE128',
      },
    ],
    copies,
  };
}

// ========================================
// Main Entry
// ========================================

async function printLabel(message, context) {
  const parsed = parseMessage(message);

  if (!parsed.text && !parsed.productNo && !parsed.barcode && !parsed.qrcode) {
    return '請提供標籤內容。\n\n用法：\n• 印標籤 文字內容\n• 印標籤 品名:ABC 條碼:123\n• 印標籤 文字 x3（印 3 張）\n• 印產品標籤 品號';
  }

  try {
    let labelData;
    let summary;

    if (parsed.mode === 'product') {
      const data = await erpFetch(`/api/products/search?keyword=${encodeURIComponent(parsed.productNo)}`);

      if (!data.success || !data.data || data.data.length === 0) {
        return `找不到品號「${parsed.productNo}」，請確認品號是否正確。`;
      }

      const product = data.data[0];
      labelData = buildProductLabel(
        product.productNo || parsed.productNo,
        product.name || product.productName,
        parsed.copies
      );
      summary = `品號：${product.productNo || parsed.productNo}\n品名：${product.name || product.productName}`;

    } else if (parsed.mode === 'barcode') {
      labelData = buildBarcodeLabel(parsed.text, parsed.barcode, parsed.qrcode, parsed.copies);
      const parts = [];
      if (parsed.text) parts.push(`品名：${parsed.text}`);
      if (parsed.barcode) parts.push(`條碼：${parsed.barcode}`);
      if (parsed.qrcode) parts.push(`QR Code：${parsed.qrcode}`);
      summary = parts.join('\n');

    } else {
      labelData = buildTextLabel(parsed.text, parsed.copies);
      summary = `內容：${parsed.text}`;
    }

    const result = await sendPrintJob(labelData);

    if (result.success) {
      return `✅ 標籤已列印（${parsed.copies} 張）\n${summary}`;
    } else {
      return `❌ 列印失敗：${result.error || result.message || '未知錯誤'}`;
    }

  } catch (err) {
    console.error('[PRINT] Error:', err);

    if (err.message.includes('ECONNREFUSED') || err.message.includes('逾時')) {
      return '❌ 無法連接印表機服務，請確認 Windows 電腦和標籤機已開啟。';
    }
    return `❌ 列印失敗：${err.message}`;
  }
}

// ========================================
// v3 Standard Interface
// ========================================

module.exports = {
  name: 'print-label',
  description: '透過精臣標籤機列印標籤（文字、條碼、QR Code、產品標籤）',
  version: '1.0.0',

  definition: {
    name: 'print-label',
    description: '列印標籤',
    parameters: {
      type: 'object',
      properties: {
        text:      { type: 'string', description: '標籤文字內容' },
        barcode:   { type: 'string', description: '條碼內容' },
        qrcode:    { type: 'string', description: 'QR Code 內容' },
        copies:    { type: 'number', description: '列印份數', default: 1 },
        productNo: { type: 'string', description: 'ERP 品號（產品標籤模式）' },
        mode:      { type: 'string', enum: ['text', 'barcode', 'product'], description: '標籤模式' }
      }
    }
  },

  async run(args, context) {
    // 組裝 message 字串給 printLabel 解析
    let message = '';
    if (args.productNo) {
      message = `印產品標籤 ${args.productNo}`;
    } else {
      const parts = [];
      if (args.text) parts.push(args.text);
      if (args.barcode) parts.push(`條碼:${args.barcode}`);
      if (args.qrcode) parts.push(`QRCode:${args.qrcode}`);
      message = parts.join(' ');
      if (args.copies && args.copies > 1) message += ` x${args.copies}`;
    }

    const result = await printLabel(message, context || {});
    return {
      success: !result.startsWith('❌'),
      data: result,
      summary: result
    };
  },

  // Legacy exports
  printLabel,
  parseMessage,
  buildTextLabel,
  buildBarcodeLabel,
  buildProductLabel,
  sendPrintJob,
  checkPrinterStatus,
};
