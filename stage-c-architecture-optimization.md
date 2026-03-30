# 階段 C：Phase 3.5.4~3.5.6 架構強化

> 穗鈅助手已完成部署（Phase 5）+ 建立訂單互動流程（B2）。
> 本階段優化記憶系統和 session 效能，為後續 RAG 品項系統打基礎。

---

## 專案位置

```
~/sui-yao-agent/
├── src/
│   ├── memory-manager.js    # 長期記憶管理（主要修改）
│   ├── memory-search.js     # 語意搜尋引擎（主要修改）
│   ├── session.js           # 對話歷史 + pre-flush（修改）
│   ├── daily-log.js         # 每日日誌
│   └── config.js            # 設定
└── .env                     # 環境變數
```

---

## 本階段任務（3 項）

### C1：記憶權重（Phase 3.5.4）

**目標**：搜尋記憶時，不只看語意相關度，還考慮重要性、使用頻率、新鮮度。

**檔案**：`src/memory-manager.js`, `src/memory-search.js`

**修改 1：記憶資料結構擴充**

在 memories collection 的每條記憶加入權重欄位：

```javascript
{
  id: "mem_001",
  content: "老闆叫王大明「老王」",
  category: "contact",
  createdAt: ISODate("2026-03-20"),
  source: "對話推斷",
  embedding: [0.12, -0.34, ...],
  // ⚡ 新增以下欄位
  importance: 0.5,          // 0~1，LLM 判斷的重要程度（預設 0.5）
  accessCount: 0,           // 被搜尋命中的次數
  lastAccessedAt: null       // 最後一次被命中的時間
}
```

**修改 2：saveMemory 時設定 importance**

- 用戶主動說「記住：XXX」→ importance = 0.8
- pre-flush 自動存的 → importance = 0.5
- LLM 回覆中的 [記憶] → importance = 0.6

**修改 3：searchMemories 加入綜合評分**

目前只用 cosine similarity 排序，改為綜合分數：

```javascript
function calculateScore(memory, cosineSim) {
  // 語意相關度（主要權重）
  const semanticScore = cosineSim;

  // 重要性
  const importanceScore = memory.importance || 0.5;

  // 新鮮度衰減（recency decay）
  const daysSinceCreated = (Date.now() - new Date(memory.createdAt).getTime()) / 86400000;
  const recencyScore = Math.exp(-daysSinceCreated / 90);  // 90 天半衰期

  // 使用頻率
  const accessScore = Math.min((memory.accessCount || 0) / 10, 1);  // 上限 1

  // 綜合分數（可調整權重）
  return (
    semanticScore * 0.6 +
    importanceScore * 0.2 +
    recencyScore * 0.1 +
    accessScore * 0.1
  );
}
```

**修改 4：命中時更新 accessCount 和 lastAccessedAt**

searchMemories 回傳結果後，批量更新命中的記憶：

```javascript
// 更新命中記憶的存取記錄
for (const mem of results) {
  await db.collection('memories').updateOne(
    { userId, 'memories.id': mem.id },
    {
      $inc: { 'memories.$.accessCount': 1 },
      $set: { 'memories.$.lastAccessedAt': new Date() }
    }
  );
}
```

**驗證**：
```bash
node -e "
  const mm = require('./src/memory-manager');
  const ms = require('./src/memory-search');
  (async () => {
    await mm.connect();
    // 存兩筆記憶，不同 importance
    await mm.saveMemory('test-user', '老闆的生日是 3/15', 'fact', { importance: 0.9 });
    await mm.saveMemory('test-user', '某次提到三月有活動', 'note', { importance: 0.3 });
    // 搜尋
    const results = await ms.searchMemories('test-user', '三月');
    console.log('結果:', results.map(r => ({ content: r.content, score: r.score.toFixed(3) })));
    // 預期：生日那筆分數更高（importance 0.9 vs 0.3）
    await mm.close();
  })();
"
```

---

### C2：查詢優化（Phase 3.5.5）

**目標**：減少不必要的 cosine 計算，加速搜尋。

**檔案**：`src/memory-search.js`

**修改 1：按 category 預過濾**

searchMemories 新增可選的 category 參數：

```javascript
async function searchMemories(userId, query, topK = 5, options = {}) {
  const { category } = options;  // 可選：只搜特定分類

  const memories = await db.collection('memories').findOne({ userId });
  if (!memories) return [];

  let candidates = memories.memories;

  // ⚡ 預過濾：如果指定了 category，先篩掉不相關的
  if (category) {
    candidates = candidates.filter(m => m.category === category);
  }

  // 再算 cosine（只對篩選後的候選集）
  const queryEmbedding = await getEmbedding(query);
  const scored = candidates.map(m => ({
    ...m,
    score: calculateScore(m, cosineSimilarity(queryEmbedding, m.embedding))
  }));

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(m => m.score > 0.3);
}
```

**修改 2：embedding 快取**

同一次對話中，如果 query 相同（例如 prompt-loader 和其他模組都搜同樣的字），不要重複呼叫 embedding API：

```javascript
const embeddingCache = new Map();

async function getEmbeddingCached(text) {
  if (embeddingCache.has(text)) return embeddingCache.get(text);
  const embedding = await getEmbedding(text);
  embeddingCache.set(text, embedding);
  // 快取最多保留 100 筆，超過清掉最早的
  if (embeddingCache.size > 100) {
    const firstKey = embeddingCache.keys().next().value;
    embeddingCache.delete(firstKey);
  }
  return embedding;
}
```

**修改 3：記錄 embedding 模型名稱**

為未來切換 embedding 模型做準備：

```javascript
// saveMemory 時記錄
{
  ...memoryData,
  embeddingModel: config.EMBEDDING_PROVIDER + '/' + config.EMBEDDING_MODEL
}
```

啟動時檢查：
```javascript
// memory-manager.js init 時
const existingModel = await getFirstMemoryEmbeddingModel(userId);
if (existingModel && existingModel !== currentModel) {
  console.warn(`⚠️ 記憶的 embedding 模型 (${existingModel}) 跟目前設定 (${currentModel}) 不同，搜尋可能不準確。需要跑 migration。`);
}
```

**驗證**：
```bash
node -e "
  const ms = require('./src/memory-search');
  (async () => {
    // 測試 category 過濾
    const all = await ms.searchMemories('test-user', '咖啡');
    const contactOnly = await ms.searchMemories('test-user', '咖啡', 5, { category: 'contact' });
    console.log('全部搜尋:', all.length, '筆');
    console.log('只搜 contact:', contactOnly.length, '筆');
    // 預期：contactOnly <= all
  })();
"
```

---

### C3：preFlush 優化（Phase 3.5.6）

**目標**：pre-flush 改為背景執行，不讓用戶等。

**檔案**：`src/session.js`

**目前問題**：

pre-flush 會呼叫 LLM 整理記憶，這個過程需要幾秒。目前是同步執行，用戶的回覆要等 flush 完才能收到。

**修改：先回覆，背景 flush**

```javascript
async function trimHistory(messages, userId, llmAdapter) {
  const systemMsg = messages[0];
  const history = messages.slice(1);

  let historyTokens = history.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  // ⚡ 改為非同步：觸發 flush 但不等它完成
  if (historyTokens > TOKEN_LIMIT * FLUSH_THRESHOLD) {
    // 不 await，背景執行
    preFlush(userId, history, llmAdapter).catch(err => {
      console.error('[preFlush] 背景執行失敗:', err.message);
    });
  }

  // 立即執行截斷，不等 flush 完成
  const kept = [];
  let keptTokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(history[i].content);
    if (estimateTokens(systemMsg.content) + keptTokens + msgTokens > TOKEN_LIMIT) break;
    keptTokens += msgTokens;
    kept.unshift(history[i]);
  }

  if (kept.length < history.length) {
    const droppedCount = history.length - kept.length;
    kept.unshift({
      role: "system",
      content: `[先前有 ${droppedCount} 則對話已省略，重要資訊已存入記憶]`
    });
  }

  return [systemMsg, ...kept];
}
```

**注意事項**：
- flush 失敗不影響用戶回覆，只 log 錯誤
- 要確保同一個用戶不會同時跑兩次 flush（加鎖）

```javascript
const flushInProgress = new Set();

async function preFlush(userId, history, llmAdapter) {
  if (flushInProgress.has(userId)) {
    console.log('[preFlush] 已在執行中，跳過');
    return;
  }
  flushInProgress.add(userId);
  try {
    // ... 原本的 flush 邏輯
  } finally {
    flushInProgress.delete(userId);
  }
}
```

**驗證**：
```bash
node -e "
  const session = require('./src/session');
  // 確認 preFlush 是非同步的
  console.log('preFlush 類型:', typeof session.preFlush);
  // 確認 flushInProgress 防重複機制存在
  console.log('trimHistory 類型:', typeof session.trimHistory);
  console.log('✅ 模組載入正常');
"
```

實際驗證：在 Telegram 連續對話直到接近截斷閾值，觀察回覆速度是否比之前快（不再卡在 flush 上）。

---

## 完成標準

三項全部完成後，回報：
1. 記憶權重公式和各項權重比例
2. category 預過濾效果（搜尋速度對比）
3. embedding 模型名稱是否已記錄
4. preFlush 背景執行確認（有無加鎖、錯誤處理）

全部通過後進入下一階段（RAG 品項系統）。
