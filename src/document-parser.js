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
  const { execSync } = require('child_process');
  const tmpDir = '/tmp/sui-yao-pdf-img';
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // 一律轉圖片 → vision 辨識（表格欄位分得更清楚）
  console.log('[document-parser] PDF → 圖片 → vision 辨識...');
  const prefix = path.join(tmpDir, `pdf-${Date.now()}`);
  execSync(`pdftoppm -jpeg -r 250 -l 3 "${filePath}" "${prefix}"`);

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
2. 產品型號：通常是英文+數字的組合（如 LRS-150-24、PCI-1245），必須精確辨識
3. 數量和單價：分別標示清楚
4. 文件類型：報價單/採購單/銷貨單

請用以下格式輸出：
發送方公司：XXX
收件方公司：XXX
文件類型：XXX
品項：
1. 品名：XXX，數量：XXX，單價：XXX
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
  return data.choices[0]?.message?.content || '';
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

重要：我們公司是「穗鈅科技」。
OCR 可能誤讀公司名，以下都是我們公司：穗鈅、穗鋒、穗瑤、穗堯、sui-yao、suiyao，或任何「穗X科技」的變體。
- 如果文件上的收件方/買方是我們公司 → 這是收到的報價單
  → customerName 應填「發送方/供應商/賣方」的公司名稱（不是我們公司）
  → type 應為 "purchase"（我們要向對方採購）
- 如果文件是我們開給別人的 → customerName 填對方名稱，type 為 "sales" 或 "quotation"

格式：
{
  "type": "sales" 或 "purchase" 或 "quotation" 或 null,
  "customerName": "對方公司/客戶名稱" 或 null,
  "items": [{"name": "品名", "quantity": 數量, "price": 單價或0}],
  "note": "備註" 或 null
}

品項解析規則（非常重要）：
- PDF 表格提取時欄位常會黏在一起，例如「1T12MLE-21PCS」其實是「項目:1」+「品名:T12MLE-21」+「單位:PCS」
- 品名清理：去掉開頭的行號數字（如 1、2、3）和結尾的單位（PCS、EA、SET、個、條、組、箱、件、米、M）
- quantity = 訂購數量（通常是較小的整數，如 1、5、10、100）
- price = 每單位的單價（通常是較大的數字，如 85、500、1250）
- 如果一個品項只有一個數字且沒標「數量」，在報價單上通常是單價，數量預設 1
- 文件常見欄位對應：「數量/QTY」→ quantity，「單價/PRICE/報價」→ price
- 盡量提取所有品項，品名只保留型號/產品名本身`,
      },
      { role: 'user', content: text },
    ],
    temperature: 0.1,
  });

  const content = (response.content || '').trim();
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }
  return null;
}

// ============================================================
// Export
// ============================================================

module.exports = {
  parsePDF,
  parseImage,
  extractOrderFromText,
};
