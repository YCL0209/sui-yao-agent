/**
 * 穗鈅助手 — 文件解析器
 *
 * 支援 PDF、圖片、純文字 → 結構化訂單資料。
 * PDF 用 pdf-parse，圖片用 GPT-4o vision。
 *
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

// ============================================================
// PDF 文字提取
// ============================================================

async function parsePDF(filePath) {
  const { execFileSync } = require('child_process');
  const tmpDir = '/tmp/sui-yao-pdf-img';
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // 一律轉圖片 → vision 辨識（表格欄位分得更清楚）
  console.log('[document-parser] PDF → 圖片 → vision 辨識...');
  const prefix = path.join(tmpDir, `pdf-${Date.now()}`);
  execFileSync('pdftoppm', ['-jpeg', '-r', '250', '-l', '3', filePath, prefix]);

  const files = fs.readdirSync(tmpDir)
    .filter(f => f.startsWith(path.basename(prefix)) && (f.endsWith('.jpg') || f.endsWith('.png')))
    .sort()
    .map(f => path.join(tmpDir, f));

  if (files.length > 0) {
    // 用第一頁做 vision 辨識
    const result = await parseImage(files[0]);
    // 清理暫存圖片
    for (const f of files) {
      try { fs.unlinkSync(f); } catch (_) {}
    }
    if (result && result.trim().length > 20) {
      return result;
    }
  }

  // Fallback: pdf-parse 文字提取
  console.log('[document-parser] vision 失敗，fallback pdf-parse...');
  const pdfParse = require('pdf-parse');
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return (data.text || '').trim();
}

// ============================================================
// 圖片辨識（GPT-4o vision）
// ============================================================

async function parseImage(filePath) {
  const imageBuffer = fs.readFileSync(filePath);
  const base64 = imageBuffer.toString('base64');
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mimeType = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

  console.log(`[document-parser] parseImage: ${filePath} (${(imageBuffer.length / 1024).toFixed(0)} KB, ${mimeType})`);

  const REFUSE_KEYWORDS = ['無法識別', '無法辨識', 'I cannot', "I can't", 'sorry', 'Sorry'];
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.llm.openaiApiKey}`,
      },
      body: JSON.stringify({
        model: config.llm.strongModel || 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `請仔細辨識這張圖片中的商業文件內容（報價單/採購單/銷貨單）。

要求：
1. 公司名稱：完整正確辨識每個中文字，不要猜測或替換
2. 產品編號：通常是英文+數字/dash（如 PRO-236、MADLN02BD、LRS-150-24）。照原文抄，不得改字；欄位空的就留空
3. 品名規格：照原文**完整**抄寫，包含型號、規格、數量單位等所有字（如「CN-14A 耐撓曲連接線 5條」「350CE 線材包, 單芯線16條, 多芯線3條」）。**不得改字、不得簡化、不得換字**；若跨多行則全部串起
4. 數量和單價：分別標示清楚，含小數
5. 文件類型：報價單/採購單/銷貨單

請用以下格式輸出（欄位用「，」分隔；產品編號與品名規格分開兩欄）：
發送方公司：XXX
收件方公司：XXX
文件類型：XXX
品項：
1. 產品編號：XXX，品名規格：XXX，數量：XXX，單價：XXX
2. ...
備註：XXX`,
              },
              {
                type: 'image_url',
                image_url: { url: `data:${mimeType};base64,${base64}` },
              },
            ],
          },
        ],
        max_tokens: 1000,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Vision API ${res.status}: ${err}`);
    }

    const data = await res.json();
    const content = data.choices[0]?.message?.content || '';

    // 檢查是否為拒絕辨識的回應
    const refused = REFUSE_KEYWORDS.some(kw => content.includes(kw));
    if (refused && attempt < MAX_ATTEMPTS) {
      console.log('[document-parser] vision 辨識失敗，重試中...');
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    return content;
  }
}

// ============================================================
// LLM 結構化解析（文字 → 訂單資料）
// ============================================================

async function extractOrderFromText(text, llm) {
  const response = await llm.chat({
    model: config.llm.strongModel || config.llm.defaultModel,
    messages: [
      {
        role: 'system',
        content: `你是訂單解析器。從以下文字中提取訂單資訊，回傳 JSON。
只回傳 JSON，不要其他文字。

格式：
{
  "sender": "發送方/賣方公司名稱",
  "receiver": "收件方/買方公司名稱",
  "documentType": "報價單" 或 "採購單" 或 "銷貨單" 或 "訂單" 或 null,
  "items": [{
    "productCode": "產品編號原文（如 PRO-236；沒有就空字串）",
    "spec": "品名規格欄完整原文（如 CN-14A 耐撓曲連接線 5條；照抄不得改字）",
    "quantity": 數量,
    "price": 單價或0
  }],
  "note": "整單備註" 或 null
}

品項解析規則：
- productCode 只放產品編號那一欄（例如 "PRO-236"）；原文沒給就空字串，不要自己編
- spec 放品名規格欄的完整原文，不要拆、不要改字、不要簡化、不要替換成相似字
- quantity = 訂購數量，price = 每單位單價
- 如果只有一個數字且在報價單上，通常是單價，數量預設 1
- 盡量提取所有品項`,
      },
      { role: 'user', content: text },
    ],
    temperature: 0.1,
  });

  const content = (response.content || '').trim();
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  const raw = JSON.parse(jsonMatch[0]);

  // 用 ERP 客戶搜尋判斷誰是客戶
  const sender = raw.sender || '';
  const receiver = raw.receiver || '';
  const { erpFetch } = require('../lib/erp-client');

  let senderMatch = null, receiverMatch = null;

  if (sender) {
    try {
      const res = await erpFetch('/api/customers');
      if (res.success && res.data) {
        const s = sender.toLowerCase();
        senderMatch = res.data.find(c =>
          c.name && (c.name.toLowerCase().includes(s) || s.includes(c.name.toLowerCase()))
        );
      }
    } catch (_) {}
  }

  if (receiver) {
    try {
      const res = await erpFetch('/api/customers');
      if (res.success && res.data) {
        const r = receiver.toLowerCase();
        receiverMatch = res.data.find(c =>
          c.name && (c.name.toLowerCase().includes(r) || r.includes(c.name.toLowerCase()))
        );
      }
    } catch (_) {}
  }

  let type, customerName, ambiguous = false;

  if (senderMatch && !receiverMatch) {
    // sender 是客戶 → 我們是 receiver → purchase
    type = 'purchase';
    customerName = senderMatch.name;
  } else if (receiverMatch && !senderMatch) {
    // receiver 是客戶 → 我們是 sender → sales
    type = 'sales';
    customerName = receiverMatch.name;
  } else if (senderMatch && receiverMatch) {
    // 兩個都找到 → 用文件類型判斷
    type = raw.documentType === '採購單' ? 'purchase' : 'sales';
    customerName = type === 'purchase' ? senderMatch.name : receiverMatch.name;
  } else {
    // 都找不到 → 標記 ambiguous，讓建單流程問用戶
    type = raw.documentType === '採購單' ? 'purchase' : 'quotation';
    customerName = null;
    ambiguous = true;
  }

  console.log(`[document-parser] ERP 搜尋: sender="${sender}"→${senderMatch ? '✓' : '✗'} receiver="${receiver}"→${receiverMatch ? '✓' : '✗'} → type=${type} customer=${customerName}`);

  return {
    type,
    customerName,
    items: raw.items || [],
    note: raw.note || null,
    _ambiguous: ambiguous ? { sender, receiver } : null,
  };
}

// ============================================================
// Export
// ============================================================

module.exports = {
  parsePDF,
  parseImage,
  extractOrderFromText,
};
