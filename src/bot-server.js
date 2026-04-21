/**
 * 穗鈅助手 — Bot Server（啟動器）
 *
 * 只負責：
 *   1. 啟動 orchestrator（require 觸發 ISM/agent/skill 註冊）
 *   2. 啟動每個啟用的 platform adapter
 *   3. 啟動 dashboard（HTTP + WebSocket）
 *   4. graceful shutdown
 *
 * 業務邏輯在 orchestrator 與 adapters。
 *
 * @version 2.0.0
 */

const config = require('./config');
const orchestrator = require('./orchestrator');
const TelegramAdapter = require('./adapters/telegram-adapter');
const DiscordAdapter = require('./adapters/discord-adapter');
const dashboard = require('./dashboard/server');
const wsManager = require('./dashboard/ws-manager');
const toolExecutor = require('./tool-executor');

async function main() {
  config.printSummary();

  // 啟動時確保 MongoDB 索引存在（冪等）
  const { ensureAllIndexes } = require('../scripts/ensure-indexes');
  await ensureAllIndexes().catch(err =>
    console.error('[bot-server] ensureAllIndexes 失敗:', err.message));

  // 啟用的 adapters
  const adapters = {};

  if (config.telegram.enabled && config.telegram.botToken) {
    adapters.telegram = new TelegramAdapter({ config, orchestrator });
  }
  if (config.discord.enabled && config.discord.token) {
    adapters.discord = new DiscordAdapter({ config, orchestrator });
  }

  if (Object.keys(adapters).length === 0) {
    console.error('❌ 沒有任何通道啟用（Telegram / Discord 都沒設定）');
    process.exit(1);
  }

  // 啟動所有 adapter（單一失敗不炸 bot：失敗者跳過，仍能跑剩下的）
  const startedAdapters = {};
  for (const [name, a] of Object.entries(adapters)) {
    try {
      await a.start();
      startedAdapters[name] = a;
    } catch (err) {
      console.error(`[bot-server] ❌ ${name} adapter 啟動失敗，跳過此通道：${err.message}`);
    }
  }
  if (Object.keys(startedAdapters).length === 0) {
    console.error('❌ 所有 adapter 都啟動失敗，bot 無法運作');
    process.exit(1);
  }

  // toolExecutor 執行 hook → dashboard ws 推送
  toolExecutor.setOnExecuteHook((event) => {
    try { wsManager.broadcast('new_log', event); } catch (_) {}
  });

  // 啟動 Dashboard（Step 12 才會用到 adapters；目前 dashboard.start 只用第一個或忽略）
  dashboard.start(startedAdapters);

  console.log(`\n✅ 穗鈅助手已啟動（${Object.keys(startedAdapters).length} 個通道：${Object.keys(startedAdapters).join(', ')}）\n`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[bot-server] shutting down...');
    for (const a of Object.values(startedAdapters)) {
      await a.stop().catch(err => console.error(err));
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[bot-server] 啟動失敗:', err);
    process.exit(1);
  });
}

module.exports = { main };
