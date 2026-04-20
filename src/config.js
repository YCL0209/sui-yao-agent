/**
 * 穗鈅助手 — 統一設定管理
 *
 * 所有設定從 .env 載入，集中驗證，其他模組統一從這裡取用。
 * 採用巢狀結構：config.telegram.botToken, config.erp.apiUrl 等。
 *
 * @version 3.0.0
 */

const path = require('path');

// 載入 .env
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// 把逗號分隔字串拆成陣列（過濾空白）
function parseList(str) {
  return (str || '').split(',').map(s => s.trim()).filter(Boolean);
}

// ============================================================
// 設定定義（巢狀結構）
// ============================================================

const config = {
  // 系統
  app: {
    name:    process.env.APP_NAME    || 'sui-yao-agent',
    version: process.env.APP_VERSION || '3.0.0',
    nodeEnv: process.env.NODE_ENV    || 'production',
  },

  // 公司資訊
  company: {
    name: process.env.COMPANY_NAME || '穗鈅科技股份有限公司',
  },

  // Telegram（I1：可選，預設啟用以保持向下相容）
  telegram: {
    enabled:     process.env.TELEGRAM_ENABLED !== 'false',
    botToken:    process.env.TELEGRAM_BOT_TOKEN,
    adminChatId: process.env.TELEGRAM_ADMIN_CHAT_ID,
  },

  // Discord（I1：第二通道；I2：物理隔離策略，白名單 channel 內才回）
  discord: {
    enabled:           process.env.DISCORD_ENABLED === 'true',
    token:             process.env.DISCORD_TOKEN,
    allowedGuildIds:   parseList(process.env.DISCORD_ALLOWED_GUILDS),
    allowedChannelIds: parseList(process.env.DISCORD_ALLOWED_CHANNELS),
    allowedUserIds:    parseList(process.env.DISCORD_ALLOWED_USERS),
    adminUserIds:      parseList(process.env.DISCORD_ADMIN_USERS),
    maxMessageLength:  parseInt(process.env.DISCORD_MAX_MESSAGE_LEN) || 1900,
  },

  // LINE（Phase 4）
  line: {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    channelSecret:      process.env.LINE_CHANNEL_SECRET       || '',
  },

  // LLM — 雲端
  llm: {
    openaiApiKey:  process.env.OPENAI_API_KEY,
    defaultModel:  process.env.DEFAULT_MODEL || 'gpt-4o-mini',
    strongModel:   process.env.STRONG_MODEL  || 'gpt-4o',
    chatProvider:  process.env.CHAT_PROVIDER  || 'openai',   // 'openai' | 'ollama'
    embedProvider: process.env.EMBED_PROVIDER || 'openai',   // 'openai' | 'ollama'
  },

  // LLM — 本地
  ollama: {
    baseUrl:        process.env.OLLAMA_BASE_URL    || 'http://127.0.0.1:11434/v1',
    chatModel:      process.env.OLLAMA_CHAT_MODEL  || 'qwen2.5:7b',
    model:          process.env.OLLAMA_MODEL       || 'llama3.1:8b',
    schedulerModel: process.env.SCHEDULER_MODEL    || 'ollama/llama3.1:8b',
  },

  // Embedding
  embedding: {
    provider:    process.env.EMBED_PROVIDER          || process.env.EMBEDDING_PROVIDER || 'openai',
    model:       process.env.EMBEDDING_MODEL         || 'text-embedding-3-small',
    ollamaModel: process.env.OLLAMA_EMBEDDING_MODEL  || 'nomic-embed-text',
  },

  // MongoDB
  mongo: {
    uri:    process.env.MONGO_URI     || 'mongodb://localhost:27017',
    dbName: process.env.MONGO_DB_NAME || 'sui-yao-agent',
  },

  // 記憶系統
  memory: {
    maxCount:             parseInt(process.env.MEMORY_MAX_COUNT)         || 200,
    searchTopK:           parseInt(process.env.MEMORY_SEARCH_TOP_K)     || 5,
    minSimilarity:        parseFloat(process.env.MEMORY_MIN_SIMILARITY) || 0.3,
    dailyLogRetentionDays: parseInt(process.env.DAILY_LOG_RETENTION_DAYS) || 30,
  },

  // Session
  session: {
    tokenLimit:     parseInt(process.env.SESSION_TOKEN_LIMIT)      || 4000,
    flushThreshold: parseFloat(process.env.SESSION_FLUSH_THRESHOLD) || 0.8,
    maxRounds:      parseInt(process.env.SESSION_MAX_ROUNDS)        || 100,
  },

  // 對話歷史持久化
  conversation: {
    maxMessages: parseInt(process.env.CONVERSATION_MAX_MESSAGES) || 200,
    // maxMessages 是 DB 保留上限；session.maxRounds 控制送給 LLM 的截斷
  },

  // Dashboard
  dashboard: {
    port:          parseInt(process.env.DASHBOARD_PORT)           || 4000,
    host:          process.env.DASHBOARD_HOST                      || '127.0.0.1',
    sessionSecret: process.env.DASHBOARD_SESSION_SECRET            || 'sui-yao-dashboard-' + Date.now(),
    verifyCodeTTL: parseInt(process.env.DASHBOARD_VERIFY_CODE_TTL) || 300000,  // 5 分鐘
  },

  // DB 定期清理（單位：天）
  cleanup: {
    executionLogs:   parseInt(process.env.CLEANUP_EXECUTION_LOGS_DAYS)   || 90,
    taskResults:     parseInt(process.env.CLEANUP_TASK_RESULTS_DAYS)     || 30,
    subTasks:        parseInt(process.env.CLEANUP_SUB_TASKS_DAYS)        || 90,
    notifications:   parseInt(process.env.CLEANUP_NOTIFICATIONS_DAYS)    || 90,
    reminders:       parseInt(process.env.CLEANUP_REMINDERS_DAYS)        || 30,
    archivedLogs:    parseInt(process.env.CLEANUP_ARCHIVED_LOGS_DAYS)    || 365,
    parsedDocuments: parseInt(process.env.CLEANUP_PARSED_DOCUMENTS_DAYS) || 180,
    conversations:   parseInt(process.env.CLEANUP_CONVERSATIONS_DAYS)    || 90,
  },

  // Agent 迴圈
  agent: {
    maxLoop:       parseInt(process.env.AGENT_MAX_LOOP)        || 10,
    loopTimeoutMs: parseInt(process.env.AGENT_LOOP_TIMEOUT_MS) || 30000,
  },

  // 子 Agent 系統
  subAgent: {
    maxIterations:  parseInt(process.env.SUB_AGENT_MAX_ITERATIONS)  || 5,
    defaultTimeout: parseInt(process.env.SUB_AGENT_DEFAULT_TIMEOUT) || 30000,
    defaultModel:   process.env.SUB_AGENT_DEFAULT_MODEL              || process.env.DEFAULT_MODEL || 'gpt-4o-mini',
  },

  // 排程
  scheduler: {
    intervalMs: parseInt(process.env.SCHEDULER_INTERVAL_MS) || 60000,
  },

  // ERP API
  erp: {
    apiUrl:      process.env.ERP_API_URL      || 'http://localhost:3000',
    taxId:       process.env.ERP_TAX_ID,
    botEmail:    process.env.ERP_BOT_EMAIL,
    botPassword: process.env.ERP_BOT_PASSWORD,
  },

  // Email（gog CLI）
  email: {
    gogAccount: process.env.GOG_ACCOUNT  || 'info@sui-yao.com',
    gogBinPath: process.env.GOG_BIN_PATH || '/opt/homebrew/bin/gog',
  },

  // Printer（精臣標籤機）
  printer: {
    apiUrl:      process.env.PRINTER_API_URL || 'http://10.0.5.125:3000',
    apiKey:      process.env.PRINTER_API_KEY,
    labelWidth:  parseInt(process.env.LABEL_WIDTH)  || 40,
    labelHeight: parseInt(process.env.LABEL_HEIGHT) || 30,
  },

  // Canvas / PDF
  canvas: {
    publicUrl: process.env.CANVAS_PUBLIC_URL,
    dir:       process.env.CANVAS_DIR || './canvas',
  },
  pdf: {
    tempDir: process.env.PDF_TEMP_DIR || '/tmp/sui-yao-pdf',
  },

  // 產品 RAG 搜尋
  product: {
    searchTopK:          parseInt(process.env.PRODUCT_SEARCH_TOP_K)              || 3,
    autoMatchThreshold:  parseFloat(process.env.PRODUCT_AUTO_MATCH_THRESHOLD)    || 0.85,
    candidateThreshold:  parseFloat(process.env.PRODUCT_CANDIDATE_THRESHOLD)     || 0.65,
    minThreshold:        parseFloat(process.env.PRODUCT_MIN_THRESHOLD)           || 0.40,
  },

  // 錯誤通知
  error: {
    notifyEnabled: process.env.ERROR_NOTIFY_ENABLED !== 'false',
    notifyChannel: process.env.ERROR_NOTIFY_CHANNEL || 'telegram',
    maxRetry:      parseInt(process.env.ERROR_MAX_RETRY) || 3,
  },

  // 日誌
  log: {
    level: process.env.LOG_LEVEL || 'info',
    file:  process.env.LOG_FILE  || 'logs/sui-yao-agent.log',
  },

  // 計算值（路徑）
  paths: {
    prompts: path.join(__dirname, '../prompts'),
    skills:  path.join(__dirname, '../skills'),
  },
};

// ============================================================
// 啟動驗證
// ============================================================

const REQUIRED = [
  { key: 'llm.openaiApiKey', value: config.llm.openaiApiKey },
  { key: 'mongo.uri',        value: config.mongo.uri },
];

const missing = REQUIRED.filter(r => !r.value);
if (missing.length > 0) {
  console.error('❌ 缺少必要環境變數：');
  missing.forEach(r => console.error(`   - ${r.key}`));
  console.error('\n請檢查 .env 檔案，參考 .env.example');
  process.exit(1);
}

// 至少啟用一個通道
const telegramReady = config.telegram.enabled && config.telegram.botToken;
const discordReady  = config.discord.enabled  && config.discord.token;
if (!telegramReady && !discordReady) {
  console.error('❌ 必須至少啟用一個通道：');
  console.error('   - Telegram: TELEGRAM_ENABLED=true 且 TELEGRAM_BOT_TOKEN 已設定');
  console.error('   - Discord : DISCORD_ENABLED=true 且 DISCORD_TOKEN 已設定');
  process.exit(1);
}

// ============================================================
// 輔助方法
// ============================================================

/**
 * 判斷模型是否為本地 Ollama 模型
 */
config.isOllamaModel = function(model) {
  return model && (
    model.startsWith('ollama/') ||
    model.includes(':')  // 例如 llama3.1:8b
  );
};

/**
 * 判斷模型是否為「強模型」（支援完整 function calling）
 */
config.isStrongModel = function(model) {
  const strongModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'];
  return strongModels.some(m => model.includes(m));
};

/**
 * 取得模型對應的 API base URL
 */
config.getBaseURL = function(model) {
  if (config.isOllamaModel(model)) {
    return config.ollama.baseUrl; // 已含 /v1
  }
  return 'https://api.openai.com/v1';
};

/**
 * 印出設定摘要（隱藏敏感值）
 */
config.printSummary = function() {
  const mask = (val) => val ? val.slice(0, 8) + '...' : '(未設定)';
  const tgState = config.telegram.enabled ? mask(config.telegram.botToken) : '(停用)';
  const dcState = config.discord.enabled  ? mask(config.discord.token)     : '(停用)';
  console.log(`\n📋 穗鈅助手 v${config.app.version} 設定摘要`);
  console.log(`   環境：${config.app.nodeEnv}`);
  console.log(`   Telegram：${tgState}`);
  console.log(`   Discord ：${dcState}`);
  console.log(`   OpenAI：${mask(config.llm.openaiApiKey)}`);
  console.log(`   Chat Provider：${config.llm.chatProvider}`);
  console.log(`   預設模型：${config.llm.defaultModel}`);
  console.log(`   Ollama：${config.ollama.baseUrl} (chat: ${config.ollama.chatModel})`);
  console.log(`   MongoDB：${config.mongo.uri}/${config.mongo.dbName}`);
  console.log(`   Embed Provider：${config.llm.embedProvider} (${config.embedding.model})`);
  console.log(`   記憶上限：${config.memory.maxCount} 條`);
  console.log(`   日誌保留：${config.memory.dailyLogRetentionDays} 天`);
  console.log(`   Agent 迴圈上限：${config.agent.maxLoop} 次\n`);
};

module.exports = config;
