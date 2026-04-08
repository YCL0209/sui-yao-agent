# 穗鈅助手 — 獨立架構計畫 v3

> 脫離 OpenClaw，自建產品級 AI Agent 平台

---

## 為什麼要脫離 OpenClaw

| 問題 | 影響 |
|------|------|
| heartbeat + 本地模型有多個 bug | model override 被忽略、workspace context 不送給本地模型、tool calling 壞掉 |
| config 散在多處 | openclaw.json、agents/*/models.json、cron/jobs.json，難以維護 |
| 框架升級風險 | OpenClaw 改版可能破壞現有設定 |
| 實際使用率低 | 只用 Gateway 接收訊息 + 轉 LLM，其餘全部自己寫 |

### 從 OpenClaw 帶走的設計精華

| OpenClaw 設計 | 穗鈅 v3 對應 | 改進 |
|---------------|-------------|------|
| SOUL.md / AGENTS.md / USER.md | identity.md / skills.md / rules.md / user.md | 拆更細、職責更清楚 |
| MEMORY.md（長期記憶） | MongoDB memories collection | 資料庫存儲，支援搜尋 |
| memory/YYYY-MM-DD.md（每日日誌） | MongoDB daily_logs collection | 同樣每日一份，但用 DB 管理 |
| memory_search（向量語意搜尋） | memory-search.js（向量搜尋） | 同概念，自建實作 |
| memoryFlush（截斷前沖刷） | pre-flush 機制 | 同概念，整合進 session.js |
| session compaction（LLM 摘要壓縮）| 智慧截斷 + pre-flush | 先沖刷再截斷，不丟重要資訊 |

---

## 現有資產（可直接搬走）

```
skills/
├── system-router/index.js          # 意圖路由器
├── check-email/                     # Gmail 查信 + Telegram 推送
├── set-reminder/                    # 建立提醒（單次 + 重複）
├── create-order/                    # ERP 建訂單
├── generate-pdf/                    # PDF 生成
├── print-label/                     # 標籤列印
└── mongodb-query/                   # MongoDB 查詢

scripts/
├── scheduler.js                     # 定時引擎（查信、提醒、排程任務）
└── heartbeat-guard.js               # cron job 自我修復

lib/
└── mongodb-tools/index.js           # MongoDB 連線工具

config/
└── SOUL.md                          # 穗鈅助手 system prompt（將拆分為多個 md）
```

---

## 記憶系統架構（⚡ v3 核心升級）

穗鈅的記憶分三層，每層有不同的生命週期和用途：

```
┌─────────────────────────────────────────────────────────┐
│                    穗鈅記憶系統                           │
│                                                         │
│  ┌─────────────────┐  永久保存，策展級                    │
│  │  長期記憶         │  持久偏好、事實、用戶習慣            │
│  │  (memories)      │  「老闆叫王大明老王」                │
│  └────────┬────────┘                                    │
│           │                                             │
│  ┌────────▼────────┐  每日一份，保留 30 天                │
│  │  每日記憶日誌     │  當天發生的事、執行記錄、決策         │
│  │  (daily_logs)   │  「今天幫老闆建了 3 張訂單」          │
│  └────────┬────────┘                                    │
│           │                                             │
│  ┌────────▼────────┐  即時，會被截斷                      │
│  │  對話歷史         │  當前 session 的來回對話             │
│  │  (conversations) │  截斷前觸發 pre-flush 沖刷           │
│  └─────────────────┘                                    │
│                                                         │
│  ┌─────────────────┐  橫跨所有層                         │
│  │  語意搜尋         │  根據當前對話，搜尋相關記憶           │
│  │  (memory-search) │  向量 embedding + 相似度比對         │
│  └─────────────────┘                                    │
└─────────────────────────────────────────────────────────┘
```

### 三層記憶的運作方式

#### 第一層：長期記憶（memories collection）

```javascript
// MongoDB memories collection
{
  userId: "telegram:8331678146",
  memories: [
    {
      id: "mem_001",
      content: "老闆叫王大明「老王」",
      category: "contact",        // contact / preference / fact / workflow
      createdAt: ISODate("2026-03-20"),
      source: "對話推斷",
      embedding: [0.12, -0.34, ...]  // 向量，用於語意搜尋
    },
    {
      id: "mem_002",
      content: "每週一早上固定要查信",
      category: "workflow",
      createdAt: ISODate("2026-03-15"),
      source: "用戶要求",
      embedding: [0.08, 0.45, ...]
    }
  ]
}
```

產生方式：
- **LLM 自動提取**：回覆中帶 `[記憶]` 標記
- **用戶手動**：「記住：我喜歡 XXX」
- **pre-flush 沖刷**：截斷前 LLM 自動整理重要資訊存入

#### 第二層：每日記憶日誌（daily_logs collection）

```javascript
// MongoDB daily_logs collection
{
  userId: "telegram:8331678146",
  date: "2026-03-24",              // YYYY-MM-DD
  entries: [
    {
      time: ISODate("2026-03-24T09:15:00"),
      type: "task",                 // task / decision / event / note
      content: "查信：收到 3 封新信，其中 1 封客戶催訂單",
      relatedSkill: "check-email"
    },
    {
      time: ISODate("2026-03-24T09:18:00"),
      type: "task",
      content: "建立訂單 #2026032401 給王大明",
      relatedSkill: "create-order"
    },
    {
      time: ISODate("2026-03-24T14:30:00"),
      type: "decision",
      content: "老闆說下午報價要改成 USD 計價",
      relatedSkill: null
    }
  ],
  embedding: [0.22, -0.11, ...]    // 整天摘要的向量
}
```

運作邏輯：
- **自動寫入**：每次 skill 執行完畢，bot-server 自動 append 一條記錄
- **LLM 寫入**：回覆中帶 `[日誌]` 標記的內容也會寫入
- **載入範圍**：每次對話載入**今天 + 昨天**的日誌（跟 OpenClaw 一樣）
- **保留期限**：30 天後自動歸檔（可從語意搜尋撈回）

```javascript
// daily-log.js
async function appendLog(userId, entry) {
  const today = new Date().toISOString().split('T')[0];
  await db.collection('daily_logs').updateOne(
    { userId, date: today },
    {
      $push: { entries: { ...entry, time: new Date() } },
      $setOnInsert: { userId, date: today }
    },
    { upsert: true }
  );
}

async function loadRecentLogs(userId) {
  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  const logs = await db.collection('daily_logs')
    .find({ userId, date: { $in: [today, yesterday] } })
    .sort({ date: -1 })
    .toArray();

  if (!logs.length) return '（今天尚無活動記錄）';

  return logs.map(log => {
    const header = `## ${log.date}`;
    const items = log.entries.map(e =>
      `- [${e.time.toTimeString().slice(0,5)}] ${e.content}`
    ).join('\n');
    return `${header}\n${items}`;
  }).join('\n\n');
}
```

#### 第三層：對話歷史（conversations collection）— 含 pre-flush

```javascript
// session.js — 含 pre-flush 機制
const TOKEN_LIMIT = 4000;
const FLUSH_THRESHOLD = 0.8;  // 到達 80% 上限時觸發 flush

async function trimHistory(messages, userId, llmAdapter) {
  const systemMsg = messages[0];
  const history = messages.slice(1);

  let totalTokens = estimateTokens(systemMsg.content);
  let historyTokens = history.reduce((sum, m) => sum + estimateTokens(m.content), 0);

  // ⚡ PRE-FLUSH：如果即將截斷，先讓 LLM 整理重要資訊
  if (historyTokens > TOKEN_LIMIT * FLUSH_THRESHOLD) {
    await preFlush(userId, history, llmAdapter);
  }

  // 從最新的往回加，直到超過上限
  const kept = [];
  let keptTokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokens(history[i].content);
    if (totalTokens + keptTokens + msgTokens > TOKEN_LIMIT) break;
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

// Pre-flush：截斷前讓 LLM 把重要資訊沖進記憶
async function preFlush(userId, history, llmAdapter) {
  const flushMessages = [
    {
      role: "system",
      content: "對話即將被截斷。請檢查以下對話歷史，將任何值得長期記住的資訊整理出來。\n" +
               "用以下格式輸出：\n" +
               "[記憶] 持久事實或偏好\n" +
               "[日誌] 今日事件記錄\n" +
               "如果沒有需要保存的，回覆 NO_REPLY"
    },
    ...history.slice(-20),  // 只取最近 20 輪，避免 flush 本身也超限
    { role: "user", content: "請整理需要保存的記憶。" }
  ];

  const response = await llmAdapter.chat({
    model: config.DEFAULT_MODEL,
    messages: flushMessages
  });

  if (response.content && response.content !== 'NO_REPLY') {
    // 解析 [記憶] 和 [日誌] 標記，分別存入對應 collection
    const memoryLines = response.content.match(/\[記憶\]\s*(.+)/g) || [];
    const logLines = response.content.match(/\[日誌\]\s*(.+)/g) || [];

    for (const line of memoryLines) {
      const content = line.replace('[記憶]', '').trim();
      await memoryManager.saveMemory(userId, content, 'pre-flush');
    }
    for (const line of logLines) {
      const content = line.replace('[日誌]', '').trim();
      await dailyLog.appendLog(userId, { type: 'note', content });
    }
  }
}
```

### 語意搜尋（memory-search.js）

不再全量載入所有記憶，改為根據當前對話搜尋相關記憶。

```javascript
// memory-search.js
// 使用 OpenAI embedding API 或本地 embedding 模型

async function searchMemories(userId, query, topK = 5) {
  // 1. 把 query 轉成向量
  const queryEmbedding = await getEmbedding(query);

  // 2. 從 memories collection 搜尋最相關的
  const memories = await db.collection('memories').findOne({ userId });
  if (!memories) return [];

  // 3. 計算相似度，取 top K
  const scored = memories.memories.map(m => ({
    ...m,
    score: cosineSimilarity(queryEmbedding, m.embedding)
  }));

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(m => m.score > 0.3);  // 最低相關度門檻
}

// Embedding 取得（支援 OpenAI 或本地）
async function getEmbedding(text) {
  if (config.EMBEDDING_PROVIDER === 'openai') {
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text
    });
    return response.data[0].embedding;
  }

  // 本地 fallback：用 Ollama 的 embedding
  const response = await fetch(`${config.OLLAMA_BASE_URL}/api/embeddings`, {
    method: 'POST',
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: text })
  });
  const data = await response.json();
  return data.embedding;
}

// 餘弦相似度
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

### 記憶在 prompt 中的載入方式（更新 prompt-loader.js）

```javascript
// prompt-loader.js（v3 更新）
async function loadSystemPrompt(userId, currentMessage) {
  // 靜態檔案（啟動時快取）
  const identity = cache.identity;
  const skills   = cache.skills;
  const rules    = cache.rules;
  const user     = cache.user;

  // ⚡ v3：語意搜尋相關記憶（取代全量載入）
  const relevantMemories = await memorySearch.searchMemories(
    userId, currentMessage, 5
  );
  const memorySection = relevantMemories.length
    ? relevantMemories.map(m => `- ${m.content}`).join('\n')
    : '（尚無相關記憶）';

  // ⚡ v3：載入今天 + 昨天的每日日誌
  const dailyLogs = await dailyLog.loadRecentLogs(userId);

  return [
    identity,
    skills,
    rules,
    user,
    `## 相關記憶\n${memorySection}`,
    `## 近日活動\n${dailyLogs}`
  ].join('\n\n---\n\n');
}
```

### messages 陣列最終結構

```
┌ system prompt（永遠完整）
│  identity.md    → 我是穗鈅助手
│  skills.md      → 我會查信、建訂單...
│  rules.md       → 金額超過 5 萬要確認
│  user.md        → 老闆是 XXX 公司負責人
│  相關記憶（5 條） → 語意搜尋命中的長期記憶      ← v3 新增
│  近日活動        → 今天 + 昨天的日誌            ← v3 新增
└

┌ 對話歷史（短期記憶，會被截斷）
│  [先前有 N 則對話已省略，重要資訊已存入記憶]    ← pre-flush 後的提示
│  最近 N 輪對話...
└

  當前用戶訊息
```

---

## Skill 系統架構（⚡ v3 產品化）

### Skill 標準介面

每個 skill 必須遵循統一介面，方便新增和管理：

```javascript
// skills/[skill-name]/index.js 標準格式
module.exports = {
  // 基本資訊（自動載入到 skills.md）
  name: 'check-email',
  description: '查詢 Gmail 信件，支援搜尋和篩選',
  version: '1.0.0',

  // function calling 定義（供 LLM 使用）
  definition: {
    name: 'check-email',
    description: '查詢 Gmail 信箱的最新郵件',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜尋關鍵字（可選）' },
        maxResults: { type: 'number', description: '最多回傳幾封', default: 5 }
      }
    }
  },

  // 執行函式
  async run(args, context) {
    // context 包含 userId, sessionId, db 等
    const emails = await gmail.search(args.query, args.maxResults);
    return {
      success: true,
      data: emails,
      summary: `找到 ${emails.length} 封信`  // 供日誌記錄
    };
  }
};
```

### Skill 自動註冊 + skills.md 自動生成

```javascript
// skill-loader.js — 自動掃描 skills/ 目錄
const fs = require('fs');
const path = require('path');

function loadAllSkills() {
  const skillsDir = path.join(__dirname, '../skills');
  const skills = {};
  const definitions = [];

  for (const dir of fs.readdirSync(skillsDir)) {
    const skillPath = path.join(skillsDir, dir, 'index.js');
    if (!fs.existsSync(skillPath)) continue;

    const skill = require(skillPath);
    skills[skill.name] = skill;
    definitions.push(skill.definition);
  }

  return { skills, definitions };
}

// 自動生成 skills.md（啟動時執行）
function generateSkillsMd(skills) {
  const lines = ['# 可用技能\n'];
  for (const [name, skill] of Object.entries(skills)) {
    lines.push(`## ${name}`);
    lines.push(skill.description);
    if (skill.definition.parameters?.properties) {
      const params = Object.entries(skill.definition.parameters.properties)
        .map(([k, v]) => `  - ${k}: ${v.description}`)
        .join('\n');
      lines.push(`參數:\n${params}`);
    }
    lines.push('');
  }
  fs.writeFileSync(
    path.join(__dirname, '../prompts/skills.md'),
    lines.join('\n')
  );
}
```

### 新增 Skill 的流程

只需要在 `skills/` 下新增一個資料夾：

```bash
# 新增一個「天氣查詢」skill
mkdir skills/check-weather
```

```javascript
// skills/check-weather/index.js
module.exports = {
  name: 'check-weather',
  description: '查詢指定城市的天氣預報',
  version: '1.0.0',

  definition: {
    name: 'check-weather',
    description: '查詢天氣預報',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名稱' }
      },
      required: ['city']
    }
  },

  async run(args, context) {
    const weather = await fetchWeather(args.city);
    return {
      success: true,
      data: weather,
      summary: `${args.city} 天氣：${weather.description}，${weather.temp}°C`
    };
  }
};
```

重啟 bot-server 後自動生效：
1. `skill-loader.js` 掃描到新 skill
2. `skills.md` 自動更新（LLM 下次就知道有新能力）
3. `tool-executor.js` 自動能呼叫它

---

## 需要新建的模組

### 1. bot-server.js — 核心（取代 OpenClaw Gateway）

```
完整訊息處理流程：

Telegram/LINE 用戶發訊息
        │
        ▼
bot-server.js 接收
        │
        ▼
session.js 載入對話歷史（短期記憶）
        │
        ▼
prompt-loader.js 組裝 system prompt
  ├─ identity.md（身份）
  ├─ skills.md（能力，自動生成）
  ├─ rules.md（規則）
  ├─ user.md（用戶資訊）
  ├─ 語意搜尋相關記憶（memory-search.js）    ← v3 新增
  └─ 今天 + 昨天每日日誌（daily-log.js）     ← v3 新增
        │
        ▼
session.js 智慧截斷
  ├─ 接近上限？→ pre-flush 先沖刷記憶        ← v3 新增
  └─ 保留 system prompt + 最近 N 輪
        │
        ▼
組裝 messages：system prompt + history + 用戶訊息
        │
        ▼
呼叫 LLM（OpenAI / Ollama）— Agent 迴圈開始
        │
        ├─ tool_call / 命令
        │   → tool-executor 執行 skill
        │   → daily-log 自動記錄執行結果       ← v3 新增
        │   → 結果回饋 LLM → 繼續迴圈
        │
        └─ 一般回覆 / 完成
            → 解析 [記憶] → 存入長期記憶
            → 解析 [日誌] → 存入每日日誌       ← v3 新增
            → session.js 儲存本輪對話
            → 回覆用戶
```

### 2. llm-adapter.js — LLM 統一介面

```javascript
const { chat } = require('./llm-adapter');

const response = await chat({
  model: 'gpt-4o-mini',       // 或 'ollama/llama3.1:8b'
  messages: [...],
  tools: skillDefinitions,     // 從 skill-loader 自動取得
});
```

支援：
- OpenAI API（gpt-4o-mini, gpt-4o）
- Ollama API（llama3.1:8b, 其他本地模型）
- Ollama function calling 降級（字串解析 fallback）

### 3. session.js — 對話歷史管理（含 pre-flush）

- 每個 user+channel 一個 session
- 智慧截斷（system prompt 保留 + 最新對話優先）
- **⚡ v3：截斷前觸發 pre-flush，讓 LLM 先把重要資訊存進記憶**
- reset 指令清空對話

### 4. memory-manager.js — 長期記憶管理

- MongoDB memories collection
- 儲存時自動生成 embedding（向量）
- 支援分類（contact / preference / fact / workflow）
- 記憶上限管理（超過時按相關度 + 時間排序淘汰）

### 5. daily-log.js — 每日記憶日誌（⚡ v3 新增）

- MongoDB daily_logs collection
- 每日一份，append-only
- skill 執行完自動寫入
- LLM 的 [日誌] 標記也會寫入
- 載入今天 + 昨天
- 30 天後歸檔（仍可透過語意搜尋找到）

### 6. memory-search.js — 語意搜尋（⚡ v3 新增）

- 支援 OpenAI text-embedding-3-small
- 支援 Ollama nomic-embed-text（本地 fallback）
- 餘弦相似度計算
- 跨層搜尋：長期記憶 + 每日日誌都能搜到
- 最低相關度門檻（避免塞入無關記憶）

### 7. prompt-loader.js — 多檔 System Prompt 組裝

- 靜態檔案啟動時快取
- 動態部分每次對話重新組裝（語意搜尋結果 + 每日日誌）

### 8. skill-loader.js — Skill 自動註冊（⚡ v3 新增）

- 自動掃描 skills/ 目錄
- 自動生成 skills.md
- 自動組裝 function calling definitions 陣列

### 9. tool-executor.js — tool calling 執行器

- 強模型：LLM 直接指定 skill
- 弱模型：透過 system-router 分派
- **⚡ v3：執行完畢自動寫入 daily-log**

### 10. config.js — 統一設定

```
.env 一個檔案搞定：

TELEGRAM_BOT_TOKEN=7924477451:AAH5...
LINE_CHANNEL_ACCESS_TOKEN=u75vg...
LINE_CHANNEL_SECRET=cff8bf...
OPENAI_API_KEY=sk-proj-...
OLLAMA_BASE_URL=http://127.0.0.1:11434
MONGO_URI=mongodb://localhost:27017
DEFAULT_MODEL=gpt-4o-mini
SCHEDULER_MODEL=ollama/llama3.1:8b
EMBEDDING_PROVIDER=openai              # ⚡ v3 新增
EMBEDDING_MODEL=text-embedding-3-small # ⚡ v3 新增
DAILY_LOG_RETENTION_DAYS=30            # ⚡ v3 新增
MEMORY_MAX_COUNT=200                   # ⚡ v3 新增
MEMORY_SEARCH_TOP_K=5                  # ⚡ v3 新增
```

---

## 目標專案結構

```
sui-yao-agent/
├── .env                             # 所有設定（gitignore）
├── .env.example                     # 設定範例（不含真實值）
├── package.json
│
├── src/
│   ├── bot-server.js                # 核心：Telegram + LINE bot + Agent 迴圈
│   ├── llm-adapter.js               # LLM API 統一介面（含 Ollama 降級）
│   ├── session.js                   # 對話歷史管理（截斷 + pre-flush）
│   ├── prompt-loader.js             # 多檔 system prompt 組裝
│   ├── memory-manager.js            # 長期記憶管理（含 embedding）
│   ├── daily-log.js                 # 每日記憶日誌（⚡ v3）
│   ├── memory-search.js             # 語意搜尋引擎（⚡ v3）
│   ├── skill-loader.js              # Skill 自動註冊 + skills.md 生成（⚡ v3）
│   ├── tool-executor.js             # tool calling 執行（強/弱模型雙路由）
│   └── config.js                    # 設定載入
│
├── skills/                          # 每個 skill 一個資料夾，標準介面
│   ├── system-router/index.js       # 意圖路由器（弱模型用）
│   ├── check-email/index.js         # Gmail 查信
│   ├── set-reminder/index.js        # 提醒（單次 + 重複）
│   ├── create-order/index.js        # ERP 建訂單
│   ├── generate-pdf/index.js        # PDF 生成
│   ├── print-label/index.js         # 標籤列印
│   └── mongodb-query/index.js       # MongoDB 查詢
│
├── scripts/
│   ├── scheduler.js                 # 定時引擎
│   ├── heartbeat-guard.js           # 自我修復
│   └── archive-daily-logs.js        # 每日日誌歸檔（30天以上）（⚡ v3）
│
├── lib/
│   └── mongodb-tools/index.js       # MongoDB 工具
│
├── prompts/
│   ├── identity.md                  # 身份（手動維護）
│   ├── skills.md                    # 能力（⚡ v3：自動生成）
│   ├── rules.md                     # 規則（手動維護）
│   └── user.md                      # 用戶資訊（手動維護）
│
├── test/                            # 獨立測試腳本
│   ├── test-llm.js
│   ├── test-session.js
│   ├── test-memory.js
│   ├── test-daily-log.js            # ⚡ v3
│   ├── test-memory-search.js        # ⚡ v3
│   ├── test-skill-loader.js         # ⚡ v3
│   └── test-tool.js
│
└── deploy/
    ├── sui-yao-agent.plist          # LaunchAgent（bot-server 常駐）
    └── sui-yao-scheduler.plist      # LaunchAgent（scheduler 每分鐘）
```

---

## 遷移步驟

### Phase 1：建立新 repo + 搬移現有代碼
- [ ] 建立 `sui-yao-agent` Git repo
- [ ] 搬入 skills（改為標準介面格式）、scripts、lib
- [ ] 拆分 SOUL.md → identity.md / rules.md / user.md
- [ ] 建立 .env + config.js
- [ ] 調整 require 路徑
- [ ] 確認 `node -e "require('./src/config')"` 能正確載入設定

### Phase 2A：llm-adapter.js（最無依賴，先做）
- [ ] 實作 OpenAI API 呼叫
- [ ] 實作 Ollama API 呼叫
- [ ] 實作 Ollama function calling 降級（字串解析 fallback）
- [ ] 實作 embedding API（OpenAI + Ollama）
- [ ] **獨立測試**：
  ```bash
  node test/test-llm.js   # CLI 對話測試
  ```

### Phase 2B：記憶系統（三層 + 搜尋）
- [ ] 實作 memory-manager.js（長期記憶 CRUD + embedding 儲存）
- [ ] 實作 daily-log.js（每日日誌 append + 載入今天/昨天）
- [ ] 實作 memory-search.js（向量搜尋 + 餘弦相似度）
- [ ] 實作 session.js（對話歷史 + 智慧截斷 + pre-flush）
- [ ] **獨立測試**：
  ```bash
  node test/test-memory.js          # 新增/搜尋/列出長期記憶
  node test/test-daily-log.js       # 寫入/讀取每日日誌
  node test/test-memory-search.js   # 語意搜尋測試
  node test/test-session.js         # 截斷 + pre-flush 模擬
  ```

### Phase 2C：Skill 系統
- [ ] 實作 skill-loader.js（自動掃描 + skills.md 生成）
- [ ] 將現有 skills 改為標準介面格式
- [ ] 實作 tool-executor.js（強/弱模型雙路由 + daily-log 自動記錄）
- [ ] **獨立測試**：
  ```bash
  node test/test-skill-loader.js    # 掃描結果 + skills.md 內容
  node test/test-tool.js '{"name":"check-email","arguments":{}}'
  ```

### Phase 2D：prompt-loader.js
- [ ] 實作靜態檔案快取
- [ ] 整合語意搜尋結果 + 每日日誌
- [ ] **獨立測試**：
  ```bash
  node test/test-prompt.js   # 印出完整 system prompt
  ```

### Phase 2E：bot-server.js（最後整合）
- [ ] 接入 Telegram webhook / polling
- [ ] 串接所有模組
- [ ] 實作 Agent 迴圈（tool_call → 執行 → 回饋 → 直到完成）
- [ ] 實作 [記憶] 和 [日誌] 標記解析
- [ ] 實作 callback_query 處理（按鈕互動）

### Phase 3：Telegram 端對端測試
- [ ] 基本對話（意圖分類 + 回覆）
- [ ] tool calling（查信、設提醒、建訂單）
- [ ] Agent 迴圈（多步驟任務：查信 → 自動建提醒）
- [ ] callback_query（確認/延後/取消）
- [ ] 重複提醒觸發
- [ ] 長期記憶測試（對話中產生 [記憶] → 下次對話驗證）
- [ ] 每日日誌測試（執行 skill → 檢查日誌是否自動記錄）
- [ ] 語意搜尋測試（問「上次給老王的訂單」→ 能找到）
- [ ] pre-flush 測試（長對話後截斷 → 驗證重要資訊已存入記憶）
- [ ] Ollama 降級測試（斷開 OpenAI，確認 fallback 正常）

### Phase 4：LINE 整合（可延後）
- [ ] LINE webhook 接收
- [ ] LINE 回覆

### Phase 5：部署 + 切換
- [ ] LaunchAgent 設定（bot-server 常駐 + scheduler 每分鐘）
- [ ] 設定 archive-daily-logs.js 排程（每日清理 30 天前日誌）
- [ ] 停用 OpenClaw Gateway
- [ ] 驗證所有功能正常
- [ ] 移除 OpenClaw

---

## Token 預算分配

| 區塊 | 估算 | 說明 |
|------|------|------|
| identity.md | ~300 token | 固定 |
| skills.md | ~500-1K token | skill 數量決定，自動生成 |
| rules.md | ~300 token | 固定 |
| user.md | ~200 token | 固定 |
| 相關記憶（5 條）| ~200-500 token | 語意搜尋命中，非全量 |
| 每日日誌（今天+昨天）| ~500-1K token | 依活動量而定 |
| **system prompt 小計** | **~2-3.5K token** | |
| 對話歷史 | ~2-4K token | 動態截斷，pre-flush 保底 |
| LLM 回覆空間 | ~1-2K token | 預留 |
| **總計** | **~6-10K token** | 適合各種模型 |

### 不同模型的調整

| 模型 | Context Window | 對話歷史上限 | 策略 |
|------|---------------|-------------|------|
| gpt-4o-mini | 128K | 8K（可調高） | 寬裕，可放很多輪 |
| gpt-4o | 128K | 8K | 同上 |
| ollama/llama3.1:8b | 8K | 2K | 緊湊，pre-flush 更重要 |
| ollama/qwen2.5:7b | 32K | 4K | 中等 |

---

## 風險評估

| 風險 | 影響 | 對策 |
|------|------|------|
| bot-server crash | 訊息收不到 | LaunchAgent KeepAlive + 自動重啟 |
| LLM API 故障 | 無法回覆 | llm-adapter 自動 fallback 到本地模型 |
| Ollama tool calling 壞掉 | skill 無法觸發 | 字串解析降級（影片中的命令解析法） |
| MongoDB 掛了 | 全部記憶失效 | 系統 cron 繼續跑，只是不回覆 |
| 遷移期間兩套並行 | 重複通知 | 先停 OpenClaw cron，只保留系統 cron |
| token 截斷太激進 | LLM 失去上下文 | pre-flush 沖刷 + 摘要提示 |
| 長期記憶膨脹 | 搜尋變慢 | 記憶上限 200 條 + 定期淘汰低相關度 |
| 每日日誌過多 | 佔用 token | 30 天自動歸檔 + 只載入今天/昨天 |
| Embedding API 故障 | 語意搜尋失效 | fallback 到關鍵字搜尋（全文 match）|
| pre-flush 產生垃圾記憶 | 記憶品質下降 | LLM 可回覆 NO_REPLY 跳過 |

---

## v2 → v3 變更摘要

| 項目 | v2 | v3 |
|------|----|----|
| 每日記憶日誌 | ❌ 缺少 | ✅ daily-log.js，今天+昨天自動載入 |
| 語意搜尋 | ❌ 全量載入 | ✅ memory-search.js，向量搜尋 top-K |
| 截斷前沖刷 | ❌ 直接砍 | ✅ pre-flush，截斷前 LLM 自動存記憶 |
| Skill 標準介面 | 無規範 | ✅ 統一格式 + 自動註冊 + skills.md 自動生成 |
| Skill 新增流程 | 手動改 code | ✅ 新增資料夾即生效 |
| 記憶載入方式 | 全量塞 prompt | ✅ 語意搜尋只載入相關的 |
| 記憶來源 | [記憶] 標記 | ✅ [記憶] + [日誌] + skill 自動記錄 + pre-flush |
| Embedding 支援 | 無 | ✅ OpenAI + Ollama 雙支援 |
| 日誌歸檔 | 無 | ✅ 30 天自動歸檔 |
| 模組數量 | 7 個 | 10 個 |
| 風險評估 | 7 項 | 10 項 |
