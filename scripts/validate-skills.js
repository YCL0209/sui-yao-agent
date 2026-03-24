#!/usr/bin/env node
/**
 * validate-skills.js — 驗證所有 skill 的 v3 標準介面
 *
 * 檢查每個 skill 是否具備：name, description, version, definition, run()
 */

const path = require('path');

const SKILLS = [
  'check-email',
  'set-reminder',
  'create-order',
  'generate-pdf',
  'print-label',
  'system-router',
];

let passed = 0;
let failed = 0;

for (const name of SKILLS) {
  try {
    const skill = require(path.join(__dirname, '../skills', name));

    const errors = [];
    if (!skill.name) errors.push('missing .name');
    if (!skill.description) errors.push('missing .description');
    if (!skill.version) errors.push('missing .version');
    if (!skill.definition) errors.push('missing .definition');
    if (!skill.definition?.name) errors.push('missing .definition.name');
    if (!skill.definition?.parameters) errors.push('missing .definition.parameters');
    if (typeof skill.run !== 'function') errors.push('missing .run() function');

    if (errors.length > 0) {
      console.log(`❌ ${name}: ${errors.join(', ')}`);
      failed++;
    } else {
      console.log(`✅ ${name} (v${skill.version})`);
      passed++;
    }
  } catch (err) {
    console.log(`❌ ${name}: require failed — ${err.message}`);
    failed++;
  }
}

console.log(`\n${passed}/${SKILLS.length} skills passed`);

if (failed > 0) {
  process.exit(1);
}
