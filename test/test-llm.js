#!/usr/bin/env node
/**
 * test-llm.js — LLM Adapter 互動式 CLI 測試
 *
 * 用法：node test/test-llm.js
 * 輸入文字後 Enter 送出，Ctrl+C 退出。
 */

const readline = require('readline');
const llm = require('../src/llm-adapter');
const config = require('../src/config');

const model = process.argv[2] || config.llm.defaultModel;
const messages = [
  { role: 'system', content: '你是穗鈅助手，用繁體中文簡潔回覆。' }
];

console.log(`\n🤖 LLM CLI 測試 (model: ${model})`);
console.log('   輸入文字對話，Ctrl+C 退出\n');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'You> ',
});

rl.prompt();

rl.on('line', async (line) => {
  const input = line.trim();
  if (!input) { rl.prompt(); return; }

  messages.push({ role: 'user', content: input });

  try {
    const resp = await llm.chat({ model, messages });
    const reply = resp.content || '(no content)';
    console.log(`\nBot> ${reply}\n`);
    messages.push({ role: 'assistant', content: reply });
  } catch (err) {
    console.log(`\n❌ Error: ${err.message}\n`);
  }

  rl.prompt();
});

rl.on('close', () => {
  console.log('\n👋 Bye');
  process.exit(0);
});
