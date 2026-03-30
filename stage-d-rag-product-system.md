# 階段 D：RAG 產品比對系統

> 穗鈅助手已完成架構強化（階段 C），本階段建立產品資料庫 + RAG 搜尋，讓建單時品項能自動匹配 ERP 產品。
> 同時支援客戶訂單/信件/圖片的自動解析建單。

---

## 專案位置

```
~/sui-yao-agent/
├── src/
│   ├── product-search.js        # ⚡ 新建：產品 RAG 搜尋引擎
│   ├── memory-search.js         # 現有：可參考，邏輯類似
│   ├── llm-adapter.js           # 現有：embedding API
│   └── bot-server.js            # 修改：同步指令 + 建單流程串接
├── skills/
│   ├── create-order/index.js    # 修改：品項步驟接入 RAG
│   └── generate-pdf/index.js    # 現有：不動
├── scripts/
│   └── sync-products.js         # ⚡ 新建：ERP 產品同步腳本
├── lib/
│   └── erp-client/index.js      # 現有：ERP API 呼叫
└── .env                         # 新增 RAG 相關設定
```

---

## 一、產品資料結構

### MongoDB products collection

```javascript
{
  productId: "PRO-001",              // ERP 品號
  name: "USB公對母(帶耳)(1米+3米)",    // 主要品名
  aliases: ["USB延長線", "USB帶耳"],   // 別名（提高匹配率）
  category: "electronic",             // 分類
  unitPrice: 15,                      // 預設單價
  unit: "條",                         // 單位
  spec: "1米+3米",                    // 規格
  erpId: "69c497afcae88668f5d85211",  // ERP 系統的 _id（同步用）
  supplier: "百凌工業",               // 常用供應商
  active: true,                       // 是否啟用（停售設 false）
  embedding: [0.12, -0.34, ...],      // 品名+別名的向量
  embeddingModel: "openai/text-embedding-3-small",
  createdAt: ISODate("2026-03-30"),
  updatedAt: ISODate("2026-03-30"),
  syncedFromERP: true                 // 是 ERP 同步來的還是手動建的
}
```

### embedding 生成規則

品名 + 所有別名合併後生成：

```javascript
const textForEmbedding = [product.name, ...product.aliases].join(' ');
const embedding = await getEmbedding(textForEmbedding);
```

---

## 二、搜尋匹配規則

### 三層匹配（由快到慢）

```javascript
async function searchProduct(query) {
  // 第一層：品號精確匹配（不用 embedding）
  const byCode = await db.collection('products').findOne({
    active: true,
    $or: [
      { productId: query },
      { spec: { $regex: query, $options: 'i' } }
    ]
  });
  if (byCode) return { match: 'exact_code', product: byCode, score: 1.0 };

  // 第二層：品名/別名精確包含（不用 embedding）
  const byName = await db.collection('products').findOne({
    active: true,
    $or: [
      { name: { $regex: query, $options: 'i' } },
      { aliases: { $regex: query, $options: 'i' } }
    ]
  });
  if (byName) return { match: 'exact_name', product: byName, score: 1.0 };

  // 第三層：語意搜尋（cosine similarity）
  const queryEmbedding = await getEmbeddingCached(query);
  const allProducts = await db.collection('products')
    .find({ active: true })
    .toArray();

  const scored = allProducts.map(p => ({
    ...p,
    score: cosineSimilarity(queryEmbedding, p.embedding)
  }));

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(p => ({ match: 'semantic', product: p, score: p.score }));
}
```

### 相似度門檻與處理方式

| 分數範圍 | 判定 | 處理 |
|---------|------|------|
| ≥ 0.85 | 高度匹配 | 自動帶入，不問用戶 |
| 0.65 ~ 0.84 | 可能匹配 | 按鈕讓用戶選 |
| 0.40 ~ 0.64 | 不確定 | 「你是不是指這個？」 |
| < 0.40 | 沒匹配 | [🆕 建立新產品] [✏️ 手動指定] [⏭️ 略過] |

### 自動學習別名

用戶輸入的品名跟匹配到的產品名不同，確認後自動學習：

```javascript
if (userInput !== matchedProduct.name && !matchedProduct.aliases.includes(userInput)) {
  matchedProduct.aliases.push(userInput);
  const textForEmbedding = [matchedProduct.name, ...matchedProduct.aliases].join(' ');
  const newEmbedding = await getEmbedding(textForEmbedding);
  await db.collection('products').updateOne(
    { productId: matchedProduct.productId },
    {
      $push: { aliases: userInput },
      $set: { embedding: newEmbedding, updatedAt: new Date() }
    }
  );
}
```

---

## 三、ERP 同步 Script

### 檔案：scripts/sync-products.js

**支援三種模式：**

```bash
# 首次安裝：全部建立（生成所有 embedding，可能要幾分鐘）
node scripts/sync-products.js --full

# 日常同步：只處理差異（幾秒搞定）
node scripts/sync-products.js

# 測試模式：只看報告不實際寫入
node scripts/sync-products.js --dry-run
```

**同步邏輯：**

```javascript
async function syncProducts(options = {}) {
  const { full = false, dryRun = false } = options;
  const stats = { added: 0, updated: 0, deactivated: 0, skipped: 0, failed: 0 };

  // Step 1：登入 ERP
  await erpClient.authenticate();

  // Step 2：拉全部產品
  const erpProducts = await erpClient.fetch('/api/products');
  const erpIds = new Set();

  // Step 3：逐筆比對
  for (const ep of erpProducts) {
    erpIds.add(ep._id);
    try {
      const existing = await db.collection('products').findOne({ erpId: ep._id });

      if (!existing) {
        // 新產品
        if (!dryRun) {
          const embedding = await getEmbedding(ep.name);
          await db.collection('products').insertOne({
            productId: ep.productCode || ep._id,
            name: ep.name,
            aliases: [],
            category: ep.category || 'uncategorized',
            unitPrice: ep.price || 0,
            unit: ep.unit || '個',
            spec: ep.spec || '',
            erpId: ep._id,
            supplier: ep.supplier || '',
            active: true,
            embedding,
            embeddingModel: `${config.EMBEDDING_PROVIDER}/${config.EMBEDDING_MODEL}`,
            createdAt: new Date(),
            updatedAt: new Date(),
            syncedFromERP: true
          });
        }
        stats.added++;
      } else if (full || ep.name !== existing.name || ep.price !== existing.unitPrice) {
        // 有變動（或 --full 模式強制更新）
        if (!dryRun) {
          const textForEmbedding = [ep.name, ...(existing.aliases || [])].join(' ');
          const embedding = await getEmbedding(textForEmbedding);
          await db.collection('products').updateOne(
            { erpId: ep._id },
            {
              $set: {
                name: ep.name,
                unitPrice: ep.price || existing.unitPrice,
                unit: ep.unit || existing.unit,
                spec: ep.spec || existing.spec,
                category: ep.category || existing.category,
                embedding,
                updatedAt: new Date()
              }
            }
          );
        }
        stats.updated++;
      } else {
        stats.skipped++;
      }
    } catch (err) {
      console.error(`❌ 同步失敗: ${ep.name}`, err.message);
      stats.failed++;
    }
  }

  // Step 4：停用 ERP 已刪除的產品
  if (!dryRun) {
    const result = await db.collection('products').updateMany(
      { syncedFromERP: true, erpId: { $nin: [...erpIds] }, active: true },
      { $set: { active: false, updatedAt: new Date() } }
    );
    stats.deactivated = result.modifiedCount;
  }

  // Step 5：印出報告
  console.log('\n📊 同步報告：');
  console.log(`   新增: ${stats.added} 筆`);
  console.log(`   更新: ${stats.updated} 筆`);
  console.log(`   停用: ${stats.deactivated} 筆`);
  console.log(`   跳過: ${stats.skipped} 筆（無變動）`);
  console.log(`   失敗: ${stats.failed} 筆`);

  return stats;
}
```

**排程方式：**
加進 scheduler.js，每天凌晨跑一次（跟日誌歸檔一樣）。也可以在 Telegram 發「同步產品」手動觸發。

**失敗處理：**
逐筆處理，失敗的跳過不回滾。下次同步自動重試（因為 MongoDB 裡沒有或版本舊）。

---

## 四、三種產品資料灌入方式

### 方式 1：ERP 同步（你的主要方式）

```bash
node scripts/sync-products.js --full
```

### 方式 2：建單時順便新增

用戶建單遇到新品 → 按「🆕 建立新產品」→ 填品名/單價 → 存 MongoDB。

```
┌────────────────────────────────────┐
│ 找不到「藍牙耳機 TWS-500」          │
│                                     │
│ [🆕 建立新產品] [✏️ 手動指定] [⏭️ 略過] │
└────────────────────────────────────┘
        │ 按「建立新產品」
        ▼
┌────────────────────────────────────┐
│ 建立新產品：                         │
│ 品名：藍牙耳機 TWS-500              │
│ 單價：（請輸入）                     │
│                                     │
│ [✅ 確認] [❌ 取消]                  │
└────────────────────────────────────┘
        │ 確認
        ▼
存入 MongoDB（syncedFromERP: false）
→ 生成 embedding
→ 繼續建單流程
```

### 方式 3：批次匯入 Excel/CSV

```bash
node scripts/import-products.js --file products.csv
```

CSV 格式：

```csv
品號,品名,單價,單位,分類
PRO-001,USB公對母(帶耳)(1米+3米),15,條,electronic
PRO-002,8字燈管電源,85,個,electronic
```

---

## 五、建單流程串接

### create-order 品項步驟改造

目前：用戶輸入品項 → 只靠正則解析 `品名 x數量 @單價`
改為：用戶輸入品項 → LLM 拆出品項清單 → 每個品項走 RAG 比對

```
用戶輸入（任何格式）：
  「USB延長線帶耳 15元、燈管電源 85元」
        │
        ▼
LLM 結構化解析：
  [
    { name: "USB延長線帶耳", qty: 1, price: 15 },
    { name: "燈管電源", qty: 1, price: 85 }
  ]
        │
        ▼
每個品項走 RAG 比對：
  「USB延長線帶耳」→ PRO-001 USB公對母(帶耳) (0.87) ✅ 自動帶入
  「燈管電源」     → PRO-002 8字燈管電源 (0.91)     ✅ 自動帶入
        │
        ▼
訂單確認（帶正確品號和品名）：
┌─────────────────────────────────┐
│ 📋 訂單確認：                     │
│ PRO-001 USB公對母(帶耳) ×1 @15  │
│ PRO-002 8字燈管電源 ×1 @85       │
│ 合計：NT$ 100                    │
│                                  │
│ [✅ 確認] [✏️ 修改] [❌ 取消]     │
└─────────────────────────────────┘
```

### 客戶訂單/信件/圖片自動解析

```
來源不同，提取方式不同，後面流程一樣：

Email 文字 → 直接拿文字 ─────────┐
PDF 報價單 → pdf-extract 提取 ────┤
圖片/拍照  → GPT-4o 視覺辨識 ────┘
                                  │
                                  ▼
                        LLM 結構化解析
                          （拆出品項）
                                  │
                                  ▼
                        RAG 產品比對
                          （每個品項）
                                  │
                                  ▼
                        ✅ 匹配到 → 自動帶入
                        ⚠️ 不確定 → 按鈕選
                        ❌ 沒匹配 → 新增/略過
                                  │
                                  ▼
                        訂單確認按鈕
                                  │
                                  ▼
                        送 ERP 建單
```

---

## 六、.env 新增設定

```
# RAG 產品系統
PRODUCT_SEARCH_TOP_K=3               # 搜尋回傳前幾名
PRODUCT_AUTO_MATCH_THRESHOLD=0.85     # 自動帶入門檻
PRODUCT_CANDIDATE_THRESHOLD=0.65      # 候選門檻
PRODUCT_MIN_THRESHOLD=0.40            # 最低門檻（低於此判定沒匹配）
PRODUCT_SYNC_SCHEDULE=0 3 * * *       # 每天凌晨 3 點同步
```

---

## 七、實作步驟（依序）

### Step 1：建立 product-search.js

新檔案 `src/product-search.js`：
- 三層匹配邏輯（品號 → 品名 → 語意搜尋）
- 相似度門檻分級處理
- 自動學習別名功能
- 共用 memory-search.js 的 cosine + getEmbeddingCached

### Step 2：建立 sync-products.js

新檔案 `scripts/sync-products.js`：
- 支援 --full、--dry-run
- 逐筆比對 + 增量更新
- 首次跑 --full 灌入所有產品

### Step 3：改造 create-order 品項步驟

修改 `skills/create-order/index.js` 的品項輸入處理：
- 正則解析失敗時用 LLM 解析
- 每個品項走 product-search.js 比對
- 高分自動帶入、中分顯示按鈕、低分顯示新增按鈕

### Step 4：bot-server 新增同步指令 + 新產品 callback

修改 `src/bot-server.js`：
- 關鍵詞攔截「同步產品」→ 手動觸發 sync
- callback handler 處理 product_select:* 和 product_new 按鈕

### Step 5：加入 scheduler 排程

修改 `scripts/scheduler.js`：
- 每天凌晨跑 sync-products

---

## 八、驗證項目

### 同步測試
1. `node scripts/sync-products.js --dry-run` → 顯示報告
2. `node scripts/sync-products.js --full` → 首次全量同步
3. 確認 MongoDB products collection 有資料

### 搜尋測試
4. 品號搜尋：輸入「PRO-001」→ 精確匹配
5. 品名搜尋：輸入「USB延長線帶耳」→ 語意匹配到 USB公對母(帶耳)
6. 模糊搜尋：輸入「電源線」→ 顯示候選清單
7. 沒匹配：輸入「藍牙耳機」→ 顯示新增按鈕

### 建單串接測試
8. Telegram 建單輸入自然語言品項 → RAG 自動比對
9. 多品項混合（有匹配 + 沒匹配）→ 正確分流處理
10. 自動學習別名 → 第二次輸入同樣的品名直接匹配

### 客戶單據解析測試
11. 貼一段客戶 Email 內容 → 自動拆出品項 → RAG 比對 → 建單確認
12. 丟一張 PDF 報價單 → 提取 → 比對 → 建單確認

---

## 九、完成標準

12 項驗證全部通過後，回報：
1. 同步結果（ERP 有幾筆產品、成功同步幾筆）
2. 搜尋匹配效果（各門檻的實際表現）
3. 自動學習別名是否正常
4. 建單全流程（自然語言 → RAG 比對 → 確認 → 建單）
