# 階段 E4：文件處理 Agent + 狀態外部化 + 清理

> E1~E3 已完成：子 agent 基礎設施就位，訂單 Agent 拆分完成並通過 Telegram 測試。
> 本階段做三件事：
> 1. 把 bot-server.js 的文件處理邏輯（~130 行）搬到 doc-agent.js
> 2. 把 _pendingDocParsed Map 併入 doc-agent 的 ISM session（消滅解法 A 的暫存 Map）
> 3. 補上 E2+E3 審查時標記的小問題

---

## 專案位置

```
~/sui-yao-agent/  (feature/sub-agent 分支)
├── src/
│   ├── bot-server.js              # 🔧 修改：文件處理區塊精簡為 5 行呼叫
│   ├── agents/
│   │   ├── order-agent.js         # E3 已建，不動
│   │   └── doc-agent.js           # ⚡ 新建：文件處理 agent
│   ├── interactive-session.js     # E1 已建，不動
│   ├── agent-registry.js          # E1 已建，不動
│   ├── document-classifier.js     # 現有，不動（doc-agent 呼叫它）
│   ├── document-parser.js         # 現有，不動（doc-agent 呼叫它）
│   ├── doc-classification.js      # 現有，不動
│   └── input-normalizer.js        # 現有，不動
└── skills/create-order/index.js   # E3 已改，不動
```

---

## 設計決策

### 為什麼文件處理用 ISM 而不是 sub-agent-executor

文件處理有一個互動環節：`_ambiguous`（兩個公司名不知道選哪個，需要用戶按按鈕）。這跟訂單 Agent 一樣是互動式流程，適合 ISM。

### _pendingDocParsed Map 的歸宿

E2+E3 用「解法 A」在 bot-server.js 裡加了一個 `_pendingDocParsed` Map 暫存文件解析結果。現在文件處理搬到 doc-agent，這個 Map 自然變成 doc-agent 的 ISM session data，不再需要獨立存在。

### doc-agent 的職責邊界

```
doc-agent 負責：
  ✅ 接收 PDF/圖片
  ✅ 分類文件
  ✅ 提取文字
  ✅ LLM 結構化解析
  ✅ _ambiguous 客戶選擇（按鈕互動）
  ✅ 回傳解析結果

doc-agent 不負責：
  ❌ 建立訂單（交給 order-agent）
  ❌ ERP 操作
  ❌ PDF 生成
```

解析完成後，doc-agent 把結果交給 order-agent 啟動建單流程。兩個 agent 是串接關係，不是巢狀關係。

---

## Step 1：建立 src/agents/doc-agent.js

**完整規格：**

```javascript
/**
 * 穗鈅助手 — 文件處理 Agent
 *
 * 處理 PDF / 圖片的分類、解析、結構化。
 * 解析完成後如果是訂單類文件，交給 order-agent 接手建單。
 *
 * 互動場景：
 * - _ambiguous（兩個公司名無法判斷客戶時，按鈕讓用戶選）
 *
 * callback_data 格式：doc:{action}:{payload}
 *
 * @version 1.0.0
 */

const ism = require('../interactive-session');
const agentRegistry = require('../agent-registry');
const { normalizeInput } = require('../input-normalizer');
const { classifyDocument, computeFileHash, updateDocumentStatus } = require('../document-classifier');
const { getDocType } = require('../doc-classification');

// ========================================
// 面向用戶的文字（調教在這裡改）
// ========================================

const MESSAGES = {
  classifying: '📄 正在辨識文件類型...',
  recognized: (label, confidence) => `📄 文件辨識結果\n類型：${label}\n信心度：${confidence}%\n\n正在為您解析內容...`,
  recognizedCategory: (category) => `📄 文件辨識結果\n類別：${category}\n\n正在為您解析內容...`,
  unknownTrying: '📄 無法辨識此文件類型，嘗試為您解析...',
  nonOrderDoc: (label) => `✅ 已辨識為${label}，已記錄。\n目前尚未支援自動處理此類型單據。`,
  unsupportedFormat: '目前只支援 PDF 和圖片檔案。',
  extractFailed: (sourceType) => `無法從${sourceType}中提取有效內容。`,
  parseFailed: (sourceType, preview) => `無法從${sourceType}中辨識訂單資訊。\n\n提取的內容：\n${preview}`,
  processFailed: (reason) => `處理失敗：${reason}`,
  ambiguousPrompt: (itemCount, itemsSummary) =>
    `📄 已解析 ${itemCount} 個品項：\n${itemsSummary}\n\n無法自動判斷客戶，請選擇：`,
  ambiguousExpired: '建單流程已過期，請重新傳送文件。',
  cancelled: '❌ 已取消。',
};

// 訂單類文件類型
const ORDER_DOC_TYPES = new Set(['quotation', 'purchase_order']);

// ========================================
// 核心處理函式
// ========================================

/**
 * 處理一個文件/圖片訊息
 *
 * 這是 doc-agent 的主入口。bot-server 收到 PDF/圖片後直接呼叫這個。
 * 不走 ISM 的 onStart（因為文件處理的「開始」是收到檔案，不是用戶打字或按按鈕）。
 *
 * @param {Object} msg — Telegram message 物件
 * @param {Object} bot — TelegramBot instance（用於下載檔案）
 * @param {Object} context — { chatId, userId }
 * @returns {Promise<Object|null>} — { text, reply_markup?, images? } 或 null
 */
async function handleDocument(msg, bot, context) {
  const { chatId, userId } = context;
  const fs = require('fs');
  const docParser = require('../document-parser');
  const llmAdapter = require('../llm-adapter');

  // 1. 正規化輸入
  const input = await normalizeInput(msg, bot);

  // 2. 分類文件
  const classification = await classifyDocument(input);
  console.log(`[doc-agent] 分類結果: category=${classification.category}, docType=${classification.docType}, confidence=${classification.confidence}`);

  // 3. 非訂單類文件 → 記錄但不解析
  if (classification.docType && !ORDER_DOC_TYPES.has(classification.docType)) {
    const typeDef = getDocType(classification.docType);
    const label = typeDef ? typeDef.label : classification.docType;
    const att = input.attachments[0];
    if (att) try { fs.unlinkSync(att.filePath); } catch (_) {}
    return { text: MESSAGES.nonOrderDoc(label) };
  }

  // 4. unknown 且無商業內容 → 跳過
  if (classification.category === 'unknown' && !classification.hasBusinessContent) {
    console.log('[doc-agent] 非商業內容圖片，跳過');
    const att = input.attachments[0];
    const fh = att ? computeFileHash(att.filePath) : null;
    if (fh) updateDocumentStatus(fh, 'skipped', { reason: '非商業內容' }).catch(() => {});
    if (att) try { fs.unlinkSync(att.filePath); } catch (_) {}
    return null; // null = 不回覆（跳過生活照等）
  }

  // 5. 回覆分類結果
  let classificationText = '';
  if (classification.category === 'unknown') {
    classificationText = MESSAGES.unknownTrying;
  } else if (classification.docType) {
    const typeDef = getDocType(classification.docType);
    const label = typeDef ? typeDef.label : classification.docType;
    const pct = Math.round(classification.confidence * 100);
    classificationText = MESSAGES.recognized(label, pct);
  } else {
    classificationText = MESSAGES.recognizedCategory(classification.category);
  }

  // 6. 檢查附件格式
  const attachment = input.attachments[0];
  const fileHash = attachment ? computeFileHash(attachment.filePath) : null;

  if (!attachment || (attachment.type !== 'pdf' && attachment.type !== 'image')) {
    return { text: classificationText + '\n\n' + MESSAGES.unsupportedFormat };
  }

  // 7. 提取文字
  let extractedText = '';
  let sourceType = '';

  if (attachment.type === 'pdf') {
    sourceType = 'PDF';
    extractedText = await docParser.parsePDF(attachment.filePath);
    console.log('[doc-agent] PDF 提取文字:', extractedText.substring(0, 500));
  } else {
    sourceType = '圖片';
    extractedText = await docParser.parseImage(attachment.filePath);
  }

  // 清理暫存檔
  try { fs.unlinkSync(attachment.filePath); } catch (_) {}

  if (!extractedText || extractedText.trim().length < 10) {
    if (fileHash) updateDocumentStatus(fileHash, 'parse_failed', { reason: '無法提取有效內容' }).catch(() => {});
    return { text: classificationText + '\n\n' + MESSAGES.extractFailed(sourceType) };
  }

  // 8. LLM 結構化解析
  const parsed = await docParser.extractOrderFromText(extractedText, llmAdapter);

  if (!parsed || (!parsed.items?.length && !parsed.customerName)) {
    if (fileHash) updateDocumentStatus(fileHash, 'parse_failed', { reason: '無法辨識訂單資訊', extractedText: extractedText.substring(0, 500) }).catch(() => {});
    return { text: classificationText + '\n\n' + MESSAGES.parseFailed(sourceType, extractedText.substring(0, 500)) };
  }

  // 解析成功
  if (fileHash) updateDocumentStatus(fileHash, 'parsed', parsed).catch(() => {});

  // 9. _ambiguous：兩個公司名無法判斷 → 開 ISM session 等用戶選
  if (parsed._ambiguous) {
    const { sender, receiver } = parsed._ambiguous;

    // 用 ISM 開一個 doc session 暫存 parsed
    await ism.startSession('doc', { chatId, userId, initialData: { parsed } });

    const itemsSummary = parsed.items.map(i => `  • ${i.name} ×${i.quantity} @${i.price}`).join('\n');
    return {
      text: classificationText + '\n\n' + MESSAGES.ambiguousPrompt(parsed.items.length, itemsSummary),
      reply_markup: {
        inline_keyboard: [
          [{ text: sender, callback_data: 'doc:pickcustomer:sender' }],
          [{ text: receiver, callback_data: 'doc:pickcustomer:receiver' }],
          [{ text: '❌ 取消', callback_data: 'doc:cancel' }],
        ],
      },
    };
  }

  // 10. 解析完成，直接啟動 order session
  // 回傳 classificationText 作為前綴，讓 bot-server 先送出分類結果
  // 然後再啟動 order session
  return {
    text: classificationText,
    _startOrder: true,   // 標記：bot-server 送完這條後要啟動 order session
    _parsed: parsed,     // 帶上 parsed 資料
  };
}

// ========================================
// ISM Handler（只用於 _ambiguous 的按鈕互動）
// ========================================

const docHandler = {
  ttl: 5 * 60 * 1000, // 5 分鐘（比 order session 短，只是等一個按鈕）

  // doc session 不需要 onStart（handleDocument 直接建 session）
  async onStart({ session }) {
    // 不會走到這裡，但 ISM 要求必須有 onStart
    return { text: '' };
  },

  async onCallback(session, action, payload, context) {
    const { chatId, userId } = context;

    // cancel
    if (action === 'cancel') {
      return { text: MESSAGES.cancelled, done: true };
    }

    // pickcustomer:{sender|receiver}
    if (action === 'pickcustomer') {
      const choice = payload; // 'sender' or 'receiver'
      const parsed = session.data.parsed;

      if (!parsed || !parsed._ambiguous) {
        return { text: MESSAGES.ambiguousExpired, done: true };
      }

      const amb = parsed._ambiguous;
      parsed.customerName = choice === 'sender' ? amb.sender : amb.receiver;
      parsed.type = choice === 'sender' ? 'purchase' : 'sales';
      delete parsed._ambiguous;

      // 清除 doc session，啟動 order session
      // 回傳特殊標記讓 bot-server 知道要啟動 order
      return {
        text: '',
        done: true,
        _startOrder: true,
        _parsed: parsed,
        _chatId: chatId,
        _userId: userId,
      };
    }

    return { text: MESSAGES.cancelled, done: true };
  },

  async onTimeout(session) {
    console.log(`[doc-agent] Session 超時: chat=${session.chatId}`);
  },
};

// ========================================
// 註冊
// ========================================

ism.registerHandler('doc', docHandler);

agentRegistry.register({
  name: 'doc',
  description: '文件處理 agent — PDF/圖片分類、解析、結構化',
  systemPrompt: '你是穗鈅助手的文件處理模組。',
  allowedSkills: [],  // doc-agent 不直接呼叫 skill，它呼叫 document-parser 和 classifier
  messages: MESSAGES,
});

// ========================================
// Export
// ========================================

module.exports = {
  MESSAGES,
  handleDocument,
};
```

---

## Step 2：改 bot-server.js

### 2.1 修改 require

在檔案頂部加入：

```javascript
const docAgent = require('./agents/doc-agent');
```

### 2.2 刪除 _pendingDocParsed Map

刪除這行（約第 31-33 行）：

```javascript
// 刪除整個 _pendingDocParsed Map 宣告
const _pendingDocParsed = new Map();
```

### 2.3 精簡文件處理區塊

把 bot-server.js 裡的文件處理區塊（從 `if (!text)` 到 `return;` 的 ~130 行）改為：

```javascript
// ---- 非文字訊息處理（PDF / 圖片 → doc-agent） ----
if (!text) {
  if (msg.document || msg.photo) {
    const prev = chatLocks.get(chatId) || Promise.resolve();
    const current = prev.then(async () => {
      try {
        await bot.sendChatAction(chatId, 'typing');

        const result = await docAgent.handleDocument(msg, bot, { chatId, userId });

        if (!result) return; // null = 跳過（非商業內容）

        // 送出分類/解析結果
        if (result.text) {
          await sendReply(bot, chatId, result.text, result.reply_markup);
        }

        // doc-agent 標記要啟動 order session
        if (result._startOrder && result._parsed) {
          const orderResult = await orderAgent.startOrderSession(chatId, userId, { parsed: result._parsed });
          if (orderResult && orderResult.text) {
            await sendReply(bot, chatId, orderResult.text, orderResult.reply_markup);
          }
        }
      } catch (err) {
        console.error(`[bot-server] 文件處理失敗:`, err);
        await bot.sendMessage(chatId, `處理失敗：${err.message}`);
        await notifyError(bot, err, `Document/Photo\nChat: ${chatId}`);
      }
    });
    chatLocks.set(chatId, current.catch(() => {}));
  }
  return;
}
```

### 2.4 改 callback handler 的 fallback 分支

把 `order:pickcustomer:` 的處理區塊改為由 ISM 自動處理（doc-agent 的 `onCallback` 已註冊 `doc:pickcustomer:`）。

刪除 callback handler 裡的這段（約 360-377 行）：

```javascript
// 刪除整個 order:pickcustomer 區塊
else if (data.startsWith('order:pickcustomer:')) {
  // ... 全部刪除 ...
}
```

但需要在 ISM 主路徑的結果處理裡加上 `_startOrder` 的支援。修改 callback handler 的 ISM 主路徑（約 312-326 行）：

```javascript
if (result) {
  if (result.text) {
    await sendReply(bot, chatId, result.text, result.reply_markup);
  }
  if (result.images && result.images.length > 0) {
    const fs = require('fs');
    for (const img of result.images) {
      try {
        const filePath = img.localPath || img;
        await bot.sendPhoto(chatId, fs.createReadStream(filePath), { caption: img.caption || '' });
      } catch (imgErr) {
        console.error('[bot-server] 發送圖片失敗:', imgErr.message);
      }
    }
  }
  // doc-agent 的 pickcustomer callback 完成後，啟動 order session
  if (result._startOrder && result._parsed) {
    const targetChatId = result._chatId || chatId;
    const targetUserId = result._userId || userId;
    const orderResult = await orderAgent.startOrderSession(targetChatId, targetUserId, { parsed: result._parsed });
    if (orderResult && orderResult.text) {
      await sendReply(bot, targetChatId, orderResult.text, orderResult.reply_markup);
    }
  }
}
```

### 2.5 改 /reset 指令

找到 `/reset` 區塊，刪除 `_pendingDocParsed.delete(chatId)` 那行（Map 已不存在）：

```javascript
if (text === '/reset' || text === '/new') {
  chatHistories.delete(chatId);
  ism.deleteSession(chatId);
  // 刪除：_pendingDocParsed.delete(chatId);  ← 已不需要
  await bot.sendMessage(chatId, '🔄 對話已重置');
  return;
}
```

### 2.6 清理不再需要的 require

檢查 bot-server.js 頂部，以下 require 應該可以移除（已搬到 doc-agent 內部）：

```javascript
// 這些在 doc-agent 內部 require，bot-server 不再直接用
// 如果 bot-server 其他地方沒用到，可以刪除：
const { normalizeInput } = require('./input-normalizer');
const { classifyDocument, computeFileHash, updateDocumentStatus } = require('./document-classifier');
```

**注意**：先確認 bot-server.js 裡除了文件處理區塊以外沒有其他地方用到這些函式，再刪除。如果不確定就保留，不影響功能。

---

## Step 3：補上 E2+E3 審查標記的小問題

### 3.1 _ambiguous 取消按鈕

在 E2+E3 審查時標記的問題：取消按鈕 `order:cancel` 在沒有 ISM session 時不會有回覆。

現在改用 `doc:cancel`，由 doc-agent 的 onCallback 處理，問題自動解決。

### 3.2 _pendingDocParsed 定時清理

不再需要——改用 ISM session 後，ISM 的定時清理機制（每分鐘檢查一次，5 分鐘超時）自動處理。

---

## 驗證清單

### Step 1 驗證

```bash
# 模組載入
node -e "
const docAgent = require('./src/agents/doc-agent');
console.log('handleDocument:', typeof docAgent.handleDocument === 'function' ? '✅' : '❌');
console.log('MESSAGES:', typeof docAgent.MESSAGES === 'object' ? '✅' : '❌');

const ism = require('./src/interactive-session');
// 確認 doc handler 已註冊（嘗試開 session 不會報「找不到 handler」）
// 不做真正的 startSession 因為需要 onStart
console.log('doc handler 已註冊:', ism.hasActiveSession(999999) === false ? '✅' : '❌');
console.log('✅ doc-agent OK');
"
```

### Step 2 驗證

```bash
# 語法檢查
node -c src/bot-server.js && echo '✅ 語法正確' || echo '❌ 語法錯誤'

# 確認 _pendingDocParsed 已移除
grep -n '_pendingDocParsed' src/bot-server.js && echo '❌ 還有殘留' || echo '✅ 已清除'

# 確認 order:pickcustomer 已移除
grep -n 'order:pickcustomer' src/bot-server.js && echo '❌ 還有殘留' || echo '✅ 已清除'

# 確認 doc-agent require 存在
grep -n 'doc-agent' src/bot-server.js | head -3
```

### 功能測試（Telegram）

| 測試 | 操作 | 預期 |
|---|---|---|
| 訂單類 PDF | 傳一張報價單 PDF | 分類 → 解析 → 進入 order session |
| 訂單類圖片 | 傳一張訂單照片 | 分類 → 解析 → 進入 order session |
| _ambiguous | 傳一張有兩個公司名的文件 | 顯示品項 + sender/receiver 按鈕 → 選完後進入 order session |
| _ambiguous 取消 | 同上，但按取消 | 顯示「已取消」 |
| _ambiguous 超時 | 同上，但 5 分鐘不按 | session 自動清除 |
| 非訂單文件 | 傳一張送貨單照片 | 顯示「已辨識為送貨單，尚未支援」 |
| 生活照 | 傳一張風景照 | 不回覆（跳過） |
| 建單功能 | 發「建立訂單」 | 跟 E3 一樣正常運作（不受 E4 影響） |
| 一般對話 | 發「你好」 | 不受影響 |

---

## 注意事項

1. **doc-agent 的 handleDocument 不是 ISM 的 onStart** — 它是直接呼叫的函式，只有 `_ambiguous` 的時候才開 ISM session 等按鈕。大部分文件會直接走完整個流程不開 session。
2. **`_startOrder` 標記** — doc-agent 不直接 require order-agent（避免 agent 之間的直接耦合）。它用 `_startOrder: true` 和 `_parsed` 告訴 bot-server「我處理完了，請交給 order-agent」。bot-server 做串接。
3. **callback_data 前綴改成 `doc:`** — _ambiguous 的按鈕從 `order:pickcustomer:` 改成 `doc:pickcustomer:`，由 doc-agent 的 onCallback 處理。
4. **doc-agent 內部 require document-parser 和 llm-adapter 是在 handleDocument 函式裡面**（lazy require），不是在檔案頂部。這是因為 document-parser 依賴 config，而 doc-agent 在 require 時就會執行 registerHandler，太早 require 可能有問題。

---

## 完成後的 bot-server.js 文件處理區塊

從 ~130 行縮減到 ~25 行：

```javascript
// 之前（130 行）：
// normalizeInput → classifyDocument → 各種 if/else →
// docParser.parsePDF/parseImage → LLM 解析 → _ambiguous 判斷 →
// startFromParsed → ...

// 之後（25 行）：
const result = await docAgent.handleDocument(msg, bot, { chatId, userId });
if (!result) return;
if (result.text) await sendReply(...);
if (result._startOrder) await orderAgent.startOrderSession(...);
```

---

## 下一步

E4 完成後，子 agent 架構的核心改造就全部完成了。剩下的是：

- **E5（可選）**：chatHistories Map → MongoDB 持久化
- **E6（可選）**：tool-executor 加結構化 execution_log
- **合併到 main**：feature/sub-agent merge 到 main
