/**
 * 穗鈅助手 — 多檔 System Prompt 組裝
 *
 * 靜態檔案（identity/skills/rules/user）啟動時快取。
 * 動態部分（語意搜尋結果 + 每日日誌）每次對話重新組裝。
 *
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const memorySearch = require('./memory-search');
const dailyLog = require('./daily-log');
const { loadAllSkills, generateSkillsMd } = require('./skill-loader');

// ============================================================
// 靜態檔案快取
// ============================================================

const cache = {
  identity: null,
  skills: null,
  rules: null,
  user: null,
};

function loadCache() {
  const promptsDir = config.paths.prompts;

  cache.identity = readFile(path.join(promptsDir, 'identity.md'));
  cache.rules = readFile(path.join(promptsDir, 'rules.md'));
  cache.user = readFile(path.join(promptsDir, 'user.md'));

  // 確保 skills.md 存在（如果不存在就生成）
  const skillsMdPath = path.join(promptsDir, 'skills.md');
  if (!fs.existsSync(skillsMdPath)) {
    const { skills } = loadAllSkills();
    generateSkillsMd(skills);
  }
  cache.skills = readFile(skillsMdPath);
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (err) {
    console.warn(`[prompt-loader] 讀取失敗: ${filePath} — ${err.message}`);
    return '';
  }
}

// 啟動時載入快取
loadCache();

// ============================================================
// 動態 System Prompt 組裝
// ============================================================

/**
 * 組裝完整 system prompt
 *
 * @param {string} userId
 * @param {string} currentMessage - 當前用戶訊息（用於語意搜尋）
 * @returns {Promise<string>}
 */
async function loadSystemPrompt(userId, currentMessage) {
  // 語意搜尋相關記憶
  let memorySection = '（尚無相關記憶）';
  try {
    const relevantMemories = await memorySearch.searchMemories(
      userId, currentMessage
    );
    if (relevantMemories.length > 0) {
      memorySection = relevantMemories
        .map(m => `- ${m.content}`)
        .join('\n');
    }
  } catch (err) {
    console.warn('[prompt-loader] 語意搜尋失敗:', err.message);
  }

  // 載入近日活動日誌
  let dailyLogs = '（今天尚無活動記錄）';
  try {
    dailyLogs = await dailyLog.loadRecentLogs(userId);
  } catch (err) {
    console.warn('[prompt-loader] 日誌載入失敗:', err.message);
  }

  // 組裝
  const sections = [
    cache.identity,
    cache.skills,
    cache.rules,
    cache.user,
    `## 相關記憶\n${memorySection}`,
    `## 近日活動\n${dailyLogs}`,
  ].filter(Boolean);

  return sections.join('\n\n---\n\n');
}

/**
 * 重新載入靜態快取（skills.md 更新後需要呼叫）
 */
function reloadCache() {
  loadCache();
}

// ============================================================
// Export
// ============================================================

module.exports = {
  loadSystemPrompt,
  reloadCache,
  cache,
};
