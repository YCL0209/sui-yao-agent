/**
 * Check Email Skill (v3)
 *
 * 查詢 Gmail 未讀信件，支援手動查詢、排程檢查、主動推送三種模式。
 * 使用 gog CLI 查詢 Gmail，去重後推送到 Telegram。
 *
 * @version 1.0.0
 */

const { execSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const config = require('../../src/config');

// ========================================
// Configuration
// ========================================

const DATA_DIR = path.resolve(__dirname, '../../data');
const STATE_FILE = path.join(DATA_DIR, 'notified-emails.json');
const LOCK_FILE = path.join(DATA_DIR, '.check-email.lock');
const MAX_RESULTS = 20;
const MAX_NOTIFIED_RECORDS = 200;

// ========================================
// File Lock (prevent concurrent execution)
// ========================================

let lockFd = null;

function acquireLock() {
  try {
    // Ensure data dir exists
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    lockFd = fs.openSync(LOCK_FILE, 'wx');
    fs.writeSync(lockFd, String(process.pid));
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') {
      try {
        const stat = fs.statSync(LOCK_FILE);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs > 5 * 60 * 1000) {
          fs.unlinkSync(LOCK_FILE);
          return acquireLock();
        }
      } catch (_) {
        return acquireLock();
      }
      return false;
    }
    throw err;
  }
}

function releaseLock() {
  try {
    if (lockFd !== null) {
      fs.closeSync(lockFd);
      lockFd = null;
    }
    if (fs.existsSync(LOCK_FILE)) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch (_) {
    // ignore cleanup errors
  }
}

// ========================================
// State Management
// ========================================

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return { notified: [], lastCheckAt: null };
  }
}

function saveState(state) {
  if (state.notified.length > MAX_NOTIFIED_RECORDS) {
    state.notified = state.notified.slice(-MAX_NOTIFIED_RECORDS);
  }
  state.lastCheckAt = Date.now();

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ========================================
// Gmail Query (via gog CLI)
// ========================================

function fetchUnreadEmails() {
  try {
    const cmd = `${config.email.gogBinPath} gmail search "is:unread" --max ${MAX_RESULTS} --json --account ${config.email.gogAccount}`;
    const output = execSync(cmd, {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const data = JSON.parse(output);
    if (!data.threads || !Array.isArray(data.threads)) {
      return [];
    }
    return data.threads;
  } catch (err) {
    console.error(`[check-email] gog 查詢失敗: ${err.message}`);
    return null;
  }
}

// ========================================
// Deduplication
// ========================================

function filterNewEmails(threads, state) {
  const notifiedIds = new Set(state.notified.map(n => n.threadId));
  return threads.filter(t => !notifiedIds.has(t.id));
}

// ========================================
// Output Formatting
// ========================================

function formatSummary(newEmails) {
  const lines = [];
  lines.push(`📬 ${newEmails.length} 封新未讀信件：`);
  lines.push('');
  lines.push('| 日期 | 寄件人 | 主旨 |');
  lines.push('|------|--------|------|');

  for (const email of newEmails) {
    const date = email.date || '未知';
    const from = (email.from || '未知').replace(/[|]/g, '\\|');
    const subject = (email.subject || '(無主旨)').replace(/[|]/g, '\\|');
    lines.push(`| ${date} | ${from} | ${subject} |`);
  }

  return lines.join('\n');
}

// ========================================
// Telegram Direct Push
// ========================================

function sendTelegram(botToken, chatId, text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown'
    });

    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          resolve(result);
        } catch {
          reject(new Error(`Telegram API parse error: ${body}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ========================================
// Notify Mode (called by scheduler)
// ========================================

async function runNotify(chatId) {
  if (!acquireLock()) {
    return { ok: true, newCount: 0, notified: false, reason: 'locked' };
  }

  try {
    const threads = fetchUnreadEmails();
    if (threads === null) {
      return { ok: false, error: 'Gmail query failed' };
    }
    if (threads.length === 0) {
      return { ok: true, newCount: 0, notified: false };
    }

    const state = loadState();
    const newEmails = filterNewEmails(threads, state);

    if (newEmails.length === 0) {
      return { ok: true, newCount: 0, notified: false };
    }

    const botToken = config.telegram.botToken;
    const summary = formatSummary(newEmails);
    await sendTelegram(botToken, chatId, summary);

    const now = Date.now();
    for (const email of newEmails) {
      state.notified.push({ threadId: email.id, timestamp: now });
    }
    saveState(state);

    return { ok: true, newCount: newEmails.length, notified: true };
  } finally {
    releaseLock();
  }
}

// ========================================
// Scheduled Mode
// ========================================

async function runScheduled() {
  if (!acquireLock()) {
    console.log('HEARTBEAT_OK');
    return;
  }

  try {
    const threads = fetchUnreadEmails();
    if (threads === null) {
      console.error('[check-email] 查詢錯誤，跳過本次');
      console.log('HEARTBEAT_OK');
      return;
    }

    if (threads.length === 0) {
      console.log('HEARTBEAT_OK');
      return;
    }

    const state = loadState();
    const newEmails = filterNewEmails(threads, state);

    if (newEmails.length === 0) {
      console.log('HEARTBEAT_OK');
      return;
    }

    console.log(formatSummary(newEmails));

    const now = Date.now();
    for (const email of newEmails) {
      state.notified.push({ threadId: email.id, timestamp: now });
    }
    saveState(state);
  } finally {
    releaseLock();
  }
}

// ========================================
// Manual Mode
// ========================================

async function checkEmail(message, context) {
  const threads = fetchUnreadEmails();

  if (threads === null) {
    return '查詢信件時發生錯誤，請稍後再試。';
  }

  if (threads.length === 0) {
    return '目前沒有未讀信件。';
  }

  const lines = [];
  lines.push(`📬 共 ${threads.length} 封未讀信件：`);
  lines.push('');
  lines.push('| 日期 | 寄件人 | 主旨 |');
  lines.push('|------|--------|------|');

  for (const email of threads) {
    const date = email.date || '未知';
    const from = (email.from || '未知').replace(/[|]/g, '\\|');
    const subject = (email.subject || '(無主旨)').replace(/[|]/g, '\\|');
    lines.push(`| ${date} | ${from} | ${subject} |`);
  }

  return lines.join('\n');
}

// ========================================
// v3 Standard Interface
// ========================================

module.exports = {
  name: 'check-email',
  description: '查詢 Gmail 未讀信件，支援手動查詢和排程通知模式',
  version: '1.0.0',

  definition: {
    name: 'check-email',
    description: '查詢 Gmail 未讀信件',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['manual', 'scheduled', 'notify'],
          description: '查詢模式：manual（手動）、scheduled（排程）、notify（主動推送）',
          default: 'manual'
        },
        chatId: {
          type: 'string',
          description: 'Telegram chat ID（notify 模式必填）'
        }
      }
    }
  },

  async run(args, context) {
    const mode = args.mode || 'manual';

    if (mode === 'notify') {
      const chatId = args.chatId || config.telegram.adminChatId;
      const result = await runNotify(chatId);
      return {
        success: result.ok !== false,
        data: result,
        summary: result.notified
          ? `推送了 ${result.newCount} 封新信件`
          : '沒有新信件'
      };
    }

    if (mode === 'scheduled') {
      await runScheduled();
      return { success: true, data: null, summary: '排程檢查完成' };
    }

    // manual
    const result = await checkEmail('', context);
    return { success: true, data: result, summary: result };
  },

  // Legacy exports for scheduler.js
  checkEmail,
  runScheduled,
  runNotify,
};
