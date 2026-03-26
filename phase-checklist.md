# 穗鈅助手 — Phase 檢查點清單

> 每完成一個 Phase，必須逐項通過檢查才能進入下一個 Phase。
> 給 Claude Code 用：完成後跑對應的檢查指令，全部 ✅ 才算過關。

---

## Phase 1：建立新 repo + 搬移現有代碼

### 檢查項目

- [ ] **1.1 Git repo 已建立**
  ```bash
  cd sui-yao-agent && git status
  # 預期：顯示 On branch main，沒有報錯
  ```

- [ ] **1.2 目錄結構正確**
  ```bash
  ls -la src/ skills/ scripts/ lib/ prompts/ deploy/ test/
  # 預期：所有資料夾都存在，沒有 "No such file or directory"
  ```

- [ ] **1.3 核心檔案到位**
  ```bash
  cat .env.example | head -5
  node -e "const c = require('./src/config'); console.log('✅ config 載入成功')"
  cat prompts/rules.md | head -3
  cat prompts/identity.md | head -3
  cat prompts/user.md | head -3
  # 預期：每個指令都有輸出，不報錯
  ```

- [ ] **1.4 .env 已建立且 .gitignore 有排除**
  ```bash
  test -f .env && echo "✅ .env 存在" || echo "❌ .env 不存在"
  grep ".env" .gitignore
  # 預期：.env 存在，.gitignore 中有 .env
  ```

- [ ] **1.5 SOUL.md 已拆分**
  ```bash
  ls prompts/
  # 預期：identity.md  rules.md  user.md（skills.md 會在 Phase 2C 自動生成）
  # 不應該還有 SOUL.md 或 system-prompt.md
  ```

- [ ] **1.6 現有 skills 已搬入**
  ```bash
  ls skills/
  # 預期：system-router  check-email  set-reminder  create-order
  #       generate-pdf   print-label   mongodb-query
  ```

- [ ] **1.7 package.json 已建立且 dotenv 已安裝**
  ```bash
  node -e "require('dotenv'); console.log('✅ dotenv 可用')"
  cat package.json | grep "name"
  # 預期：dotenv 可 require，package name 是 sui-yao-agent
  ```

- [ ] **1.8 config.js 啟動驗證正常**
  ```bash
  node -e "const c = require('./src/config'); c.printSummary()"
  # 預期：印出設定摘要，API key 有遮罩，沒有報錯退出
  ```

### Phase 1 通過標準
> 以上 8 項全部 ✅，才能進入 Phase 2A

---

## Phase 2A：llm-adapter.js

### 檢查項目

- [ ] **2A.1 檔案存在且可載入**
  ```bash
  node -e "const llm = require('./src/llm-adapter'); console.log('✅ llm-adapter 載入成功')"
  ```

- [ ] **2A.2 OpenAI API 呼叫正常**
  ```bash
  node -e "
    const llm = require('./src/llm-adapter');
    llm.chat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: '回覆 OK 兩個字' }]
    }).then(r => console.log('✅ OpenAI:', r.content))
      .catch(e => console.log('❌ OpenAI 失敗:', e.message));
  "
  # 預期：✅ OpenAI: OK
  ```

- [ ] **2A.3 Ollama API 呼叫正常（如果 Ollama 有跑）**
  ```bash
  node -e "
    const llm = require('./src/llm-adapter');
    llm.chat({
      model: 'ollama/llama3.1:8b',
      messages: [{ role: 'user', content: '回覆 OK 兩個字' }]
    }).then(r => console.log('✅ Ollama:', r.content))
      .catch(e => console.log('⚠️ Ollama 未啟動或失敗:', e.message));
  "
  ```

- [ ] **2A.4 function calling 正常**
  ```bash
  node -e "
    const llm = require('./src/llm-adapter');
    llm.chat({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: '幫我查信' }],
      tools: [{
        type: 'function',
        function: {
          name: 'check-email',
          description: '查詢 Gmail 信件',
          parameters: { type: 'object', properties: {} }
        }
      }]
    }).then(r => {
      if (r.tool_calls) console.log('✅ tool_call:', r.tool_calls[0].function.name);
      else console.log('⚠️ 沒有觸發 tool_call，回覆:', r.content);
    });
  "
  # 預期：✅ tool_call: check-email
  ```

- [ ] **2A.5 Ollama 降級（字串解析）可運作**
  ```bash
  node -e "
    const { parseCommandFromText } = require('./src/llm-adapter');
    const result = parseCommandFromText('命令: check-email');
    console.log(result ? '✅ 字串解析正常:' + result.name : '❌ 解析失敗');
  "
  # 預期：✅ 字串解析正常: check-email
  ```

- [ ] **2A.6 Embedding API 正常**
  ```bash
  node -e "
    const llm = require('./src/llm-adapter');
    llm.getEmbedding('測試文字').then(v => {
      console.log('✅ Embedding 維度:', v.length);
    }).catch(e => console.log('❌ Embedding 失敗:', e.message));
  "
  # 預期：✅ Embedding 維度: 1536（OpenAI）或 768（Ollama）
  ```

- [ ] **2A.7 CLI 對話測試可互動**
  ```bash
  node test/test-llm.js
  # 預期：能輸入文字、收到回覆、Ctrl+C 退出
  ```

### Phase 2A 通過標準
> 2A.1 ~ 2A.6 全部 ✅（2A.3 如果 Ollama 沒跑可跳過），才能進入 Phase 2B

---

## Phase 2B：記憶系統（三層 + 搜尋）

### 檢查項目

- [ ] **2B.1 memory-manager.js 可載入**
  ```bash
  node -e "const mm = require('./src/memory-manager'); console.log('✅ memory-manager 載入成功')"
  ```

- [ ] **2B.2 長期記憶 CRUD 正常**
  ```bash
  node -e "
    const mm = require('./src/memory-manager');
    (async () => {
      await mm.connect();
      await mm.saveMemory('test-user', '這是測試記憶', 'test');
      const memories = await mm.getMemories('test-user');
      console.log('✅ 記憶數量:', memories.length);
      await mm.deleteMemory('test-user', memories[memories.length - 1].id);
      console.log('✅ 刪除成功');
      await mm.close();
    })();
  "
  # 預期：✅ 記憶數量: 1（或更多），✅ 刪除成功
  ```

- [ ] **2B.3 daily-log.js 可載入且寫入/讀取正常**
  ```bash
  node -e "
    const dl = require('./src/daily-log');
    (async () => {
      await dl.connect();
      await dl.appendLog('test-user', {
        type: 'task',
        content: '測試日誌寫入',
        relatedSkill: 'test'
      });
      const logs = await dl.loadRecentLogs('test-user');
      console.log('✅ 日誌內容:', logs.substring(0, 50));
      await dl.close();
    })();
  "
  # 預期：✅ 日誌內容: ## 2026-03-24（包含測試日誌寫入）
  ```

- [ ] **2B.4 每日日誌只載入今天 + 昨天**
  ```bash
  node -e "
    const dl = require('./src/daily-log');
    (async () => {
      await dl.connect();
      // 寫一筆 3 天前的假資料
      const threeDaysAgo = new Date(Date.now() - 3 * 86400000)
        .toISOString().split('T')[0];
      await dl.db.collection('daily_logs').insertOne({
        userId: 'test-user',
        date: threeDaysAgo,
        entries: [{ time: new Date(), type: 'task', content: '三天前的資料' }]
      });
      const logs = await dl.loadRecentLogs('test-user');
      const has3DaysAgo = logs.includes('三天前的資料');
      console.log(has3DaysAgo ? '❌ 不應該載入三天前' : '✅ 正確只載入今天+昨天');
      await dl.close();
    })();
  "
  # 預期：✅ 正確只載入今天+昨天
  ```

- [ ] **2B.5 memory-search.js 語意搜尋正常**
  ```bash
  node -e "
    const mm = require('./src/memory-manager');
    const ms = require('./src/memory-search');
    (async () => {
      await mm.connect();
      // 先存幾筆有 embedding 的記憶
      await mm.saveMemory('test-user', '老闆喜歡喝美式咖啡', 'test');
      await mm.saveMemory('test-user', '每週一要查信', 'test');
      await mm.saveMemory('test-user', '王大明的電話是 0912345678', 'test');

      // 搜尋
      const results = await ms.searchMemories('test-user', '咖啡偏好');
      console.log('✅ 搜尋結果:', results.length, '筆');
      if (results.length > 0) {
        console.log('   最相關:', results[0].content);
        console.log('   相似度:', results[0].score.toFixed(3));
      }
      await mm.close();
    })();
  "
  # 預期：✅ 搜尋結果 >= 1 筆，最相關應該是「美式咖啡」那筆
  ```

- [ ] **2B.6 session.js 智慧截斷正常**
  ```bash
  node -e "
    const session = require('./src/session');
    // 模擬一個超長對話
    const messages = [
      { role: 'system', content: '你是穗鈅助手' },
      ...Array.from({ length: 100 }, (_, i) => ([
        { role: 'user', content: '第 ' + (i+1) + ' 輪的問題，這是一段比較長的文字用來測試截斷' },
        { role: 'assistant', content: '第 ' + (i+1) + ' 輪的回覆，同樣是一段比較長的文字' }
      ])).flat()
    ];
    const trimmed = session.trimHistory(messages);
    console.log('原始:', messages.length, '則');
    console.log('截斷後:', trimmed.length, '則');
    console.log('第一則:', trimmed[0].role);
    console.log('第二則:', trimmed[1].content.substring(0, 30));
    console.log(trimmed.length < messages.length ? '✅ 截斷正常' : '❌ 沒有截斷');
  "
  # 預期：截斷後數量 < 原始數量，第一則是 system，第二則包含「已省略」
  ```

- [ ] **2B.7 pre-flush 機制可觸發**
  ```bash
  node -e "
    const session = require('./src/session');
    // 驗證 pre-flush 函式存在且可呼叫
    console.log(typeof session.preFlush === 'function'
      ? '✅ preFlush 函式存在'
      : '❌ preFlush 函式不存在');
  "
  # 預期：✅ preFlush 函式存在
  ```

- [ ] **2B.8 MongoDB collections 已正確建立**
  ```bash
  node -e "
    const { MongoClient } = require('mongodb');
    const config = require('./src/config');
    (async () => {
      const client = new MongoClient(config.MONGO_URI);
      await client.connect();
      const db = client.db(config.MONGO_DB_NAME);
      const collections = await db.listCollections().toArray();
      const names = collections.map(c => c.name);
      const required = ['memories', 'daily_logs', 'conversations'];
      for (const name of required) {
        console.log(names.includes(name)
          ? '✅ ' + name + ' 存在'
          : '⚠️ ' + name + ' 尚未建立（首次寫入時會自動建立）');
      }
      await client.close();
    })();
  "
  ```

### Phase 2B 通過標準
> 2B.1 ~ 2B.7 全部 ✅（2B.8 是參考），才能進入 Phase 2C

---

## Phase 2C：Skill 系統

### 檢查項目

- [ ] **2C.1 skill-loader.js 可掃描所有 skills**
  ```bash
  node -e "
    const sl = require('./src/skill-loader');
    const { skills, definitions } = sl.loadAllSkills();
    console.log('✅ 載入 skill 數量:', Object.keys(skills).length);
    Object.keys(skills).forEach(name => console.log('   -', name));
  "
  # 預期：列出所有 skill 名稱（check-email, set-reminder 等）
  ```

- [ ] **2C.2 每個 skill 都符合標準介面**
  ```bash
  node -e "
    const sl = require('./src/skill-loader');
    const { skills } = sl.loadAllSkills();
    let pass = true;
    for (const [name, skill] of Object.entries(skills)) {
      const fields = ['name', 'description', 'definition', 'run'];
      const missing = fields.filter(f => !skill[f]);
      if (missing.length) {
        console.log('❌', name, '缺少:', missing.join(', '));
        pass = false;
      } else {
        console.log('✅', name, '介面完整');
      }
    }
    if (pass) console.log('\n✅ 所有 skill 介面檢查通過');
  "
  # 預期：每個 skill 都顯示 ✅
  ```

- [ ] **2C.3 skills.md 自動生成正確**
  ```bash
  node -e "
    const sl = require('./src/skill-loader');
    const { skills } = sl.loadAllSkills();
    sl.generateSkillsMd(skills);
    console.log('✅ skills.md 已生成');
  "
  cat prompts/skills.md
  # 預期：skills.md 內容包含所有 skill 的名稱和描述
  ```

- [ ] **2C.4 function calling definitions 陣列格式正確**
  ```bash
  node -e "
    const sl = require('./src/skill-loader');
    const { definitions } = sl.loadAllSkills();
    console.log('✅ definitions 數量:', definitions.length);
    console.log('   格式範例:', JSON.stringify(definitions[0]).substring(0, 100));
    // 驗證格式
    const valid = definitions.every(d =>
      d.type === 'function' && d.function && d.function.name && d.function.parameters
    );
    console.log(valid ? '✅ 格式全部正確' : '❌ 有格式錯誤');
  "
  # 預期：✅ 格式全部正確
  ```

- [ ] **2C.5 tool-executor.js 可執行 skill**
  ```bash
  node -e "
    const te = require('./src/tool-executor');
    (async () => {
      // 測試強模型路徑（直接指定 skill）
      const result = await te.execute({
        function: { name: 'check-email', arguments: '{}' }
      }, 'strong');
      console.log('✅ 執行結果:', result.success ? '成功' : '失敗');
      console.log('   摘要:', result.summary);
    })().catch(e => console.log('❌ 執行失敗:', e.message));
  "
  # 預期：✅ 執行結果: 成功（或因為沒有 Gmail 設定而失敗，但不應該是找不到 skill）
  ```

- [ ] **2C.6 tool-executor 執行後自動寫入 daily-log**
  ```bash
  node -e "
    const dl = require('./src/daily-log');
    (async () => {
      await dl.connect();
      const logs = await dl.loadRecentLogs('test-user');
      const hasSkillLog = logs.includes('check-email') || logs.includes('執行');
      console.log(hasSkillLog
        ? '✅ skill 執行記錄已寫入日誌'
        : '⚠️ 日誌中沒找到 skill 記錄（可能 test-user 不一致）');
      await dl.close();
    })();
  "
  ```

### Phase 2C 通過標準
> 2C.1 ~ 2C.5 全部 ✅，才能進入 Phase 2D

---

## Phase 2D：prompt-loader.js

### 檢查項目

- [ ] **2D.1 靜態檔案快取正常**
  ```bash
  node -e "
    const pl = require('./src/prompt-loader');
    console.log('✅ prompt-loader 載入成功');
    console.log('   快取 identity:', pl.cache?.identity ? '有' : '無');
    console.log('   快取 rules:', pl.cache?.rules ? '有' : '無');
    console.log('   快取 user:', pl.cache?.user ? '有' : '無');
  "
  ```

- [ ] **2D.2 完整 system prompt 可組裝**
  ```bash
  node -e "
    const pl = require('./src/prompt-loader');
    (async () => {
      const prompt = await pl.loadSystemPrompt('test-user', '你好');
      console.log('✅ system prompt 長度:', prompt.length, '字');
      console.log('   包含 identity:', prompt.includes('穗鈅') ? '✅' : '❌');
      console.log('   包含 skills:', prompt.includes('技能') || prompt.includes('skill') ? '✅' : '❌');
      console.log('   包含 rules:', prompt.includes('規則') || prompt.includes('鐵則') ? '✅' : '❌');
      console.log('   包含記憶區段:', prompt.includes('記憶') || prompt.includes('memory') ? '✅' : '❌');
      console.log('   包含日誌區段:', prompt.includes('活動') || prompt.includes('日誌') ? '✅' : '❌');
    })();
  "
  # 預期：所有區段都 ✅
  ```

- [ ] **2D.3 語意搜尋結果有嵌入 prompt**
  ```bash
  node -e "
    const pl = require('./src/prompt-loader');
    (async () => {
      // 先確保有記憶資料
      const mm = require('./src/memory-manager');
      await mm.connect();
      await mm.saveMemory('test-user', '老闆喜歡喝拿鐵', 'test');

      const prompt = await pl.loadSystemPrompt('test-user', '咖啡');
      console.log(prompt.includes('拿鐵')
        ? '✅ 語意搜尋結果已嵌入 prompt'
        : '⚠️ prompt 中沒找到相關記憶（可能搜尋未命中）');
      await mm.close();
    })();
  "
  ```

- [ ] **2D.4 Token 估算合理**
  ```bash
  node -e "
    const pl = require('./src/prompt-loader');
    (async () => {
      const prompt = await pl.loadSystemPrompt('test-user', '你好');
      // 粗估：中文 1 字 ≈ 2 token
      const estimatedTokens = prompt.length * 1.5;
      console.log('system prompt 約', Math.round(estimatedTokens), 'tokens');
      console.log(estimatedTokens < 5000
        ? '✅ 在合理範圍內（< 5K）'
        : '⚠️ 偏大，檢查是否有不必要的內容');
    })();
  "
  ```

### Phase 2D 通過標準
> 2D.1 ~ 2D.3 全部 ✅，才能進入 Phase 2E

---

## Phase 2E：bot-server.js（整合）

### 檢查項目

- [ ] **2E.1 bot-server 可啟動不報錯**
  ```bash
  timeout 5 node src/bot-server.js || true
  # 預期：啟動訊息出現（例如 "穗鈅助手已啟動"），5 秒後自動結束
  # 不應該有 unhandled error 或 crash
  ```

- [ ] **2E.2 Telegram 連線正常**
  ```bash
  node -e "
    const config = require('./src/config');
    const TelegramBot = require('node-telegram-bot-api');
    const bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN);
    bot.getMe().then(me => {
      console.log('✅ Telegram Bot:', me.username);
      process.exit(0);
    }).catch(e => {
      console.log('❌ Telegram 連線失敗:', e.message);
      process.exit(1);
    });
  "
  # 預期：✅ Telegram Bot: [你的 bot 名稱]
  ```

- [ ] **2E.3 Agent 迴圈有上限保護**
  ```bash
  grep -n "AGENT_MAX_LOOP\|maxLoop\|max_loop\|迴圈上限" src/bot-server.js
  # 預期：找到迴圈上限的相關程式碼（防止無限迴圈）
  ```

- [ ] **2E.4 [記憶] 標記解析正常**
  ```bash
  node -e "
    const { parseMemoryTags } = require('./src/bot-server');
    const input = '好的，已幫你建立訂單。\n[記憶] 老闆偏好 A4 尺寸\n[日誌] 建立訂單 #001';
    const result = parseMemoryTags(input);
    console.log('回覆:', result.reply);
    console.log('記憶:', result.memories);
    console.log('日誌:', result.logs);
    console.log(result.memories.length === 1 && result.logs.length === 1
      ? '✅ 解析正確'
      : '❌ 解析有誤');
  "
  # 預期：回覆不包含標記，memories 和 logs 各 1 筆
  ```

- [ ] **2E.5 所有模組正確串接**
  ```bash
  node -e "
    const modules = [
      './src/config',
      './src/llm-adapter',
      './src/session',
      './src/memory-manager',
      './src/daily-log',
      './src/memory-search',
      './src/prompt-loader',
      './src/skill-loader',
      './src/tool-executor'
    ];
    let allOk = true;
    for (const mod of modules) {
      try {
        require(mod);
        console.log('✅', mod);
      } catch (e) {
        console.log('❌', mod, ':', e.message);
        allOk = false;
      }
    }
    console.log(allOk ? '\n✅ 所有模組載入成功' : '\n❌ 有模組載入失敗');
  "
  # 預期：所有模組都 ✅
  ```

### Phase 2E 通過標準
> 2E.1 ~ 2E.5 全部 ✅，才能進入 Phase 3

---

## Phase 3：Telegram 端對端測試

> 以下測試需要在 Telegram 上實際操作

### 檢查項目

- [ ] **3.1 基本對話** — 發送「你好」→ 穗鈅用繁體中文回覆
- [ ] **3.2 身份認知** — 發送「你是誰」→ 穗鈅回覆符合 identity.md 設定
- [ ] **3.3 規則遵守** — 發送「幫我刪除所有訂單」→ 穗鈅要求二次確認
- [ ] **3.4 查信** — 發送「查信」→ 觸發 check-email skill，回覆信件摘要
- [ ] **3.5 設提醒** — 發送「提醒我明天早上 9 點開會」→ 觸發 set-reminder skill
- [ ] **3.6 建訂單** — 發送「幫王大明建一張訂單」→ 觸發 create-order skill
# - [ ] **3.7 多步驟 Agent 迴圈** — 發送「查信，有重要的就幫我設提醒」→ 先查信再自動設提醒（暫緩，可能改方向）
- [ ] **3.8 callback_query** — 確認/延後/取消按鈕點擊後正常回應
- [ ] **3.9 長期記憶寫入** — 發送「記住：我偏好 A4 格式」→ 確認寫入 memories
  ```bash
  node -e "
    const mm = require('./src/memory-manager');
    (async () => {
      await mm.connect();
      const mems = await mm.getMemories('telegram:你的chatId');
      const found = mems.find(m => m.content.includes('A4'));
      console.log(found ? '✅ 記憶已存入' : '❌ 記憶未找到');
      await mm.close();
    })();
  "
  ```
- [ ] **3.10 長期記憶讀取** — 下一次對話發送「我喜歡什麼格式？」→ 穗鈅能回答 A4
- [ ] **3.11 每日日誌** — 執行完 skill 後檢查日誌
  ```bash
  node -e "
    const dl = require('./src/daily-log');
    (async () => {
      await dl.connect();
      const logs = await dl.loadRecentLogs('telegram:你的chatId');
      console.log(logs);
      await dl.close();
    })();
  "
  # 預期：看到今天的 skill 執行記錄
  ```
- [ ] **3.12 語意搜尋** — 發送「上次給老王的訂單是什麼？」→ 能從記憶/日誌中找到相關資訊
- [ ] **3.13 pre-flush 測試** — 連續對話直到接近截斷閾值，檢查重要資訊是否自動存入記憶
# - [ ] **3.14 Ollama 降級** — 暫時停用 OpenAI key，確認自動切換到 Ollama（暫緩，8B 模型太小會卡住，升級硬體後再啟用）
- [ ] **3.15 重複提醒** — 設定重複提醒，確認按時觸發
- [ ] **3.16 reset 指令** — 發送 reset 相關指令，確認對話歷史清空但記憶保留

### Phase 3 通過標準
> 3.1 ~ 3.10 為必要項目，全部 ✅ 才能進入 Phase 4
> 3.11 ~ 3.16 為進階項目，建議通過但不阻塞

---

## Phase 4：LINE 整合

### 檢查項目

- [ ] **4.1 LINE webhook 接收正常** — LINE 上發送訊息，bot-server 有收到
- [ ] **4.2 LINE 回覆正常** — 穗鈅能在 LINE 上正確回覆
- [ ] **4.3 session 隔離** — LINE 和 Telegram 的對話歷史互不干擾
- [ ] **4.4 記憶共享** — 同一個用戶的長期記憶在兩個 channel 都能存取
  （如果同一個人用 Telegram 和 LINE，userId mapping 需要處理）

### Phase 4 通過標準
> 4.1 ~ 4.3 全部 ✅

---

## Phase 5：部署 + 切換

### 檢查項目

- [ ] **5.1 LaunchAgent 設定正確**
  ```bash
  plutil -lint deploy/sui-yao-agent.plist
  plutil -lint deploy/sui-yao-scheduler.plist
  # 預期：兩個都顯示 OK
  ```

- [ ] **5.2 bot-server 常駐正常**
  ```bash
  launchctl list | grep sui-yao
  # 預期：看到 sui-yao-agent 和 sui-yao-scheduler
  ```

- [ ] **5.3 crash 後自動重啟**
  ```bash
  # 手動 kill bot-server process
  kill $(pgrep -f "bot-server.js")
  sleep 5
  pgrep -f "bot-server.js"
  # 預期：process 自動重啟，有新的 PID
  ```

- [ ] **5.4 日誌歸檔排程設定**
  ```bash
  # 確認 archive-daily-logs.js 可執行
  node scripts/archive-daily-logs.js --dry-run
  # 預期：顯示將歸檔的日誌數量（或 0），不實際刪除
  ```

- [ ] **5.5 OpenClaw 已停用**
  ```bash
  launchctl list | grep -i openclaw
  pgrep -f openclaw
  # 預期：沒有任何 OpenClaw 相關 process
  ```

- [ ] **5.6 所有功能正常（最終驗證）**
  - [ ] Telegram 發訊息 → 正常回覆
  - [ ] 查信 → 正常
  - [ ] 設提醒 → 正常
  - [ ] 建訂單 → 正常
  - [ ] 排程任務 → 正常觸發
  - [ ] 記憶 → 讀寫正常
  - [ ] 日誌 → 自動記錄正常

- [ ] **5.7 監控確認**
  ```bash
  # 確認錯誤通知功能正常
  node -e "
    const notify = require('./src/error-notify');
    notify.send('測試通知：部署完成').then(() => console.log('✅ 通知已發送'));
  "
  # 預期：Telegram 收到測試通知
  ```

### Phase 5 通過標準
> 5.1 ~ 5.7 全部 ✅，大功告成 🎉

---

## 快速索引

| Phase | 必要檢查點 | 預估項目 |
|-------|----------|---------|
| Phase 1 | 8 項 | 基礎建設 |
| Phase 2A | 7 項 | LLM 通訊 |
| Phase 2B | 8 項 | 記憶系統 |
| Phase 2C | 6 項 | Skill 系統 |
| Phase 2D | 4 項 | Prompt 組裝 |
| Phase 2E | 5 項 | 整合串接 |
| Phase 3 | 16 項 | 端對端測試 |
| Phase 4 | 4 項 | LINE 整合 |
| Phase 5 | 7 項 | 部署切換 |
| **總計** | **65 項** | |
