/**
 * 穗鈅助手 — Skill 自動註冊 + skills.md 生成
 *
 * 自動掃描 skills/ 目錄，載入所有符合 v3 標準介面的 skill，
 * 組裝 OpenAI function calling definitions 陣列，生成 skills.md。
 *
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

// ============================================================
// 載入所有 Skills
// ============================================================

/**
 * 掃描 skills/ 目錄，載入所有 skill
 *
 * @returns {{ skills: Object, definitions: Array }}
 *   skills: { [name]: skillModule }
 *   definitions: OpenAI function calling 格式陣列
 */
function loadAllSkills() {
  const skillsDir = config.paths.skills;
  const skills = {};
  const definitions = [];

  let dirs;
  try {
    dirs = fs.readdirSync(skillsDir);
  } catch (err) {
    console.error('[skill-loader] 無法讀取 skills 目錄:', err.message);
    return { skills, definitions };
  }

  for (const dir of dirs) {
    const skillPath = path.join(skillsDir, dir, 'index.js');
    if (!fs.existsSync(skillPath)) continue;

    try {
      const skill = require(skillPath);

      // 驗證 v3 標準介面
      if (!skill.name || !skill.definition || typeof skill.run !== 'function') {
        console.warn(`[skill-loader] ${dir}: 缺少 v3 標準介面，跳過`);
        continue;
      }

      skills[skill.name] = skill;

      // 包成 OpenAI function calling 格式
      definitions.push({
        type: 'function',
        function: {
          name: skill.definition.name,
          description: skill.definition.description,
          parameters: skill.definition.parameters || { type: 'object', properties: {} },
        },
      });

    } catch (err) {
      console.error(`[skill-loader] ${dir}: 載入失敗 —`, err.message);
    }
  }

  return { skills, definitions };
}

// ============================================================
// 生成 skills.md
// ============================================================

/**
 * 自動生成 prompts/skills.md
 * @param {Object} skills - { [name]: skillModule }
 */
function generateSkillsMd(skills) {
  const lines = ['# 可用技能\n'];

  for (const [name, skill] of Object.entries(skills)) {
    lines.push(`## ${name}`);
    lines.push(skill.description || '（無描述）');

    if (skill.definition?.parameters?.properties) {
      const props = skill.definition.parameters.properties;
      const params = Object.entries(props)
        .map(([k, v]) => `  - \`${k}\`: ${v.description || v.type || ''}`)
        .join('\n');
      if (params) {
        lines.push(`\n參數:\n${params}`);
      }
    }

    lines.push('');
  }

  const outputPath = path.join(config.paths.prompts, 'skills.md');
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
  console.log(`[skill-loader] skills.md 已生成 (${Object.keys(skills).length} skills)`);
}

// ============================================================
// Export
// ============================================================

module.exports = {
  loadAllSkills,
  generateSkillsMd,
};
