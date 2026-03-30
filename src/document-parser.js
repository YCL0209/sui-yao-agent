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
  // 先嘗試文字提取
  const pdfParse = require('pdf-parse');
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  const text = (data.text || '').trim();

  if (text.length > 20) {
    return text; // 有足夠文字，直接回傳
  }

  // 文字太少（可能是掃描型 PDF）→ 轉圖片 → vision 辨識
  console.log('[document-parser] PDF 文字不足，轉圖片辨識...');
  const { execSync } = require('child_process');
  const tmpDir = '/tmp/sui-yao-pdf-img';
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const prefix = path.join(tmpDir, `pdf-${Date.now()}`);
  execSync(`pdftoppm -png -r 200 -l 3 "${filePath}" "${prefix}"`); // 只轉前 3 頁

  const files = fs.readdirSync(tmpDir)
    .filter(f => f.startsWith(path.basename(prefix)) && f.endsWith('.png'))
    .sort()
    .map(f => path.join(tmpDir, f));

  if (files.length === 0) {
    return text; // 轉換失敗，回傳原本的少量文字
  }

  // 用第一頁做 vision 辨識（通常報價單資訊在第一頁）
  const result = await parseImage(files[0]);

  // 清理暫存圖片
  for (const f of files) {
    try { fs.unlinkSync(f); } catch (_) {}
  }

  return result;
}

// ============================================================
// 圖片辨識（GPT-4o vision）
// ============================================================

async function parseImage(filePath) {
  const imageBuffer = fs.readFileSync(filePath);
  const base64 = imageBuffer.toString('base64');
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';

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
              text: '請辨識這張圖片中的訂單/報價單/採購單內容。提取出客戶名稱、品項（品名、數量、單價）、訂單類型。只回傳純文字描述，不要 JSON。',
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

重要：我們公司是「穗鈅科技」（穗鈅/sui-yao）。
- 如果文件上的客戶/收件方/買方是穗鈅科技，代表這是我們收到的報價單或對方給我們的單據。
  → customerName 應填「發送方/供應商/賣方」的公司名稱（不是穗鈅科技）
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
