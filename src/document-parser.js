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
  const pdfParse = require('pdf-parse');
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return data.text || '';
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
    model: config.llm.defaultModel,
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

品項注意事項：
- quantity 是訂購數量（通常 1~1000），不要跟單價搞混
- price 是每個/每條/每組的單價
- 如果文件有「數量」和「單價」欄位，分別對應 quantity 和 price
- 盡量提取所有品項，即使格式不標準`,
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
