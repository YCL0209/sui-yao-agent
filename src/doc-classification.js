/**
 * 穗鈅助手 — 文件分類定義模組
 *
 * 定義文件類別（DOC_CATEGORIES）、文件類型（DOC_TYPES），
 * 並提供 LLM 分類 prompt 組裝與結果驗證。
 *
 * @version 1.0.0
 */

// ============================================================
// DOC_CATEGORIES — 第一層分類
// ============================================================

const DOC_CATEGORIES = {
  document:   { key: 'document',   label: '正式單據' },
  message:    { key: 'message',    label: '口頭請求/文字指令' },
  attachment: { key: 'attachment', label: '非單據附件' },
  unknown:    { key: 'unknown',    label: '無法辨識' },
};

// ============================================================
// DOC_TYPES — 第二層分類（僅 category=document 時適用）
// ============================================================

const DOC_TYPES = {
  quotation: {
    key: 'quotation',
    label: '報價單',
    description:
      '正式報價文件。通常有公司抬頭/LOGO，標題為「報價單」或「Quotation」，' +
      '含報價編號、日期、有效期限。主體是品項表格，欄位包含品名/型號（如 LRS-150-24）、' +
      '數量、單價、金額。底部有付款條件、交貨條件，以及公司章或業務簽名。',
    requiredFields: ['documentType', 'vendorName', 'customerName', 'quotationNumber', 'date', 'items', 'totalAmount'],
    optionalFields: ['validUntil', 'paymentTerms', 'deliveryTerms', 'contactPerson', 'phone', 'fax', 'currency', 'taxAmount', 'remarks'],
  },

  purchase_order: {
    key: 'purchase_order',
    label: '採購單',
    description:
      '買方向賣方發出的採購文件。標題為「採購單」或「訂購單」或「Purchase Order」，' +
      '頂部有買方公司資訊，含採購編號（PO Number）、日期、交貨日期。' +
      '品項表格列出產品型號（如 PCI-1245）、規格、數量、單價。' +
      '底部通常有交貨地址、買方核准章/簽名。',
    requiredFields: ['documentType', 'buyerName', 'vendorName', 'poNumber', 'date', 'items', 'totalAmount'],
    optionalFields: ['deliveryDate', 'deliveryAddress', 'paymentTerms', 'contactPerson', 'phone', 'currency', 'taxAmount', 'remarks', 'approvalSignature'],
  },

  invoice: {
    key: 'invoice',
    label: '發票/請款單',
    description:
      '請求付款的帳務文件。標題為「發票」、「請款單」或「Invoice」。' +
      '含賣方統一編號（8 碼數字）、發票號碼（如 AB-12345678）、買賣雙方資訊。' +
      '品項表格列出品名、數量、金額，底部有稅額計算（營業稅 5%）和含稅總計。' +
      '台灣統一發票有特殊格式：兩碼英文 + 八碼數字。',
    requiredFields: ['documentType', 'invoiceNumber', 'sellerName', 'sellerTaxId', 'buyerName', 'buyerTaxId', 'date', 'items', 'taxAmount', 'totalAmount'],
    optionalFields: ['paymentDueDate', 'bankAccount', 'currency', 'remarks'],
  },

  delivery_note: {
    key: 'delivery_note',
    label: '出貨單/送貨單',
    description:
      '隨貨附上的出貨文件。標題為「出貨單」、「送貨單」或「Delivery Note」。' +
      '含出貨日期、送貨地址、收件人。品項表格列出產品型號和數量，通常「不含價格」。' +
      '可能有物流單號或車牌號碼。底部有收貨人簽收欄位。' +
      '與報價單/採購單的主要區別是沒有價格資訊。',
    requiredFields: ['documentType', 'vendorName', 'customerName', 'deliveryNumber', 'date', 'items'],
    optionalFields: ['deliveryAddress', 'receiverName', 'receiverPhone', 'trackingNumber', 'vehiclePlate', 'relatedPoNumber', 'remarks', 'receiverSignature'],
  },

  statement: {
    key: 'statement',
    label: '對帳單',
    description:
      '帳務往來明細表。標題為「對帳單」或「Statement of Account」。' +
      '含對帳期間（起訖日期）、期初餘額、期末餘額。' +
      '主體是交易明細表格，列出多筆歷史交易（發票、付款、折讓），每筆有日期、單號、金額、餘額。' +
      '通常按月產生，重點在「多筆交易彙總」而非單筆訂單。',
    requiredFields: ['documentType', 'issuerName', 'customerName', 'statementDate', 'periodStart', 'periodEnd', 'transactions', 'closingBalance'],
    optionalFields: ['openingBalance', 'currency', 'contactPerson', 'paymentInstructions', 'remarks'],
  },

  receipt: {
    key: 'receipt',
    label: '簽收單/收據',
    description:
      '確認收貨或收款的文件。標題為「簽收單」、「收據」或「Receipt」。' +
      '格式通常較簡單（半頁或一頁），含日期、收到的品項或金額、簽收人姓名/簽名。' +
      '可能引用相關送貨單號或發票號碼。' +
      '與送貨單的區別：簽收單是「已收到」的確認，送貨單是「正在送」的隨附文件。',
    requiredFields: ['documentType', 'date', 'receiverName', 'items'],
    optionalFields: ['receiptNumber', 'senderName', 'relatedDocumentNumber', 'receiverSignature', 'remarks', 'amount'],
  },

  packing_list: {
    key: 'packing_list',
    label: '裝箱單',
    description:
      '列出出貨包裝內容的文件。標題為「裝箱單」或「Packing List」。' +
      '含箱號（Carton No.）、每箱內容物（產品型號與數量）、每箱毛重/淨重、材積/尺寸。' +
      '常見於國際出貨或大批量出貨。底部有總箱數、總重量。' +
      '與送貨單的區別：裝箱單重點在「每箱裝了什麼」，送貨單重點在「送了什麼」。',
    requiredFields: ['documentType', 'vendorName', 'customerName', 'date', 'packages'],
    optionalFields: ['packingListNumber', 'relatedPoNumber', 'relatedInvoiceNumber', 'totalBoxes', 'totalGrossWeight', 'totalNetWeight', 'remarks'],
  },

  other_document: {
    key: 'other_document',
    label: '其他單據',
    description:
      '有正式格式（表頭、表格、編號、公司章）但不屬於以上任何類型的商業文件。' +
      '仍然是結構化的單據，而非隨意的文字訊息或參考資料。',
    requiredFields: ['documentType', 'date'],
    optionalFields: ['issuerName', 'recipientName', 'documentNumber', 'items', 'remarks'],
  },
};

// ============================================================
// Prompt 組裝
// ============================================================

/**
 * 組裝文件分類用的 system prompt。
 * 包含所有類別與類型定義，指定判斷優先順序。
 * @returns {string}
 */
function getClassificationPrompt() {
  // 組裝第二層類型清單
  const typeList = Object.values(DOC_TYPES)
    .map((t, i) => `${i + 1}. ${t.key}（${t.label}）：${t.description}`)
    .join('\n');

  return `你是文件分類專家。請根據提供的資訊判斷文件的類別與類型。

## 判斷優先順序
文件視覺內容（圖片/PDF 的版面與欄位） > 信件內文（Email body 或訊息文字） > 檔名

## 第一層：文件類別（category）
- document：正式單據 — 有固定格式、表頭、表格、公司章的商業文件
- message：口頭請求/文字指令 — 聊天訊息、Email 內文、口頭交代事項
- attachment：非單據附件 — 產品規格書、型錄、目錄、技術文件等參考資料
- unknown：無法辨識 — 資訊不足以判斷

## 第二層：單據類型（docType）
僅當 category 為 document 時需要判斷，否則 docType 必須為 null。

${typeList}

## 回覆格式
只回傳 JSON，不要其他文字：
{
  "category": "document|message|attachment|unknown",
  "docType": "quotation|purchase_order|invoice|delivery_note|statement|receipt|packing_list|other_document|null",
  "confidence": 0.0到1.0的數值,
  "language": "文件語言，如 zh-TW、en、ja",
  "reasoning": "簡短說明判斷依據",
  "hasBusinessContent": true或false
}

## 注意事項
- category 不是 document 時，docType 必須是 null
- confidence 低於 0.6 時請在 reasoning 說明不確定的原因
- 如果文件同時像兩種類型，選最接近的那個，並在 reasoning 說明
- hasBusinessContent：圖片或文字中是否包含任何商業相關內容，例如產品名稱、料號、價格、公司名、規格、條碼等。即使無法判斷文件類型，只要有商業相關文字或資訊就填 true。純粹的生活照片、風景、人物照等填 false`;
}

// ============================================================
// ClassificationResult — 分類結果結構與驗證
// ============================================================

/**
 * @typedef {Object} ClassificationResult
 * @property {'document'|'message'|'attachment'|'unknown'} category
 * @property {string|null} docType
 * @property {number} confidence
 * @property {string} language
 * @property {string} reasoning
 */

const VALID_CATEGORIES = new Set(Object.keys(DOC_CATEGORIES));
const VALID_DOC_TYPES = new Set(Object.keys(DOC_TYPES));

/**
 * 驗證並正規化 LLM 回傳的分類結果。
 * @param {Object} raw - LLM 回傳的原始 JSON
 * @returns {ClassificationResult}
 */
function createClassificationResult(raw) {
  const category = VALID_CATEGORIES.has(raw.category) ? raw.category : 'unknown';

  let docType = null;
  if (category === 'document' && raw.docType && VALID_DOC_TYPES.has(raw.docType)) {
    docType = raw.docType;
  }

  const confidence = typeof raw.confidence === 'number'
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0;

  const language = raw.language || 'zh-TW';
  const reasoning = raw.reasoning || '';
  const hasBusinessContent = typeof raw.hasBusinessContent === 'boolean' ? raw.hasBusinessContent : true;

  return { category, docType, confidence, language, reasoning, hasBusinessContent };
}

// ============================================================
// 輔助函式
// ============================================================

/**
 * 取得指定 docType 的完整定義。
 * @param {string} key
 * @returns {Object|null}
 */
function getDocType(key) {
  return DOC_TYPES[key] || null;
}

/**
 * 取得指定 docType 的必要欄位清單。
 * @param {string} key
 * @returns {string[]}
 */
function getRequiredFields(key) {
  const t = DOC_TYPES[key];
  return t ? t.requiredFields : [];
}

// ============================================================
// Export
// ============================================================

module.exports = {
  DOC_CATEGORIES,
  DOC_TYPES,
  getClassificationPrompt,
  createClassificationResult,
  getDocType,
  getRequiredFields,
};
