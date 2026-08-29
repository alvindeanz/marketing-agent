#!/usr/bin/env node
'use strict';
// 回写闭环：把人推翻 fable 的判决（review_override_note）和被打回的方案（plans.reject_reason）
// 抓到 specs/plan_experience.md 的「待整理」段，按 task/plan id 去重。我每周把待整理的条目提炼成规律挪到正文。
//   SEO_AGENT_TOKEN=<admin jwt> node tools/experience_sync.js [client_id ...]   不给 id 就扫 /board 上全部客户
const fs = require('fs');
const path = require('path');
const API = process.env.SEO_API_BASE || 'https://always.horntech-dev.com/seo-api.php';
const TOKEN = process.env.SEO_AGENT_TOKEN || '';
const FILE = path.join(__dirname, '..', 'specs', 'plan_experience.md');
const HEAD = '## 待整理（experience_sync 自动追加，整理后删）';
if (!TOKEN) { console.error('用法：SEO_AGENT_TOKEN=... node tools/experience_sync.js [client_id ...]'); process.exit(2); }

async function call(p) {
  const r = await fetch(API + p, { headers: { Authorization: 'Bearer ' + TOKEN } });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = {}; }
  if (!r.ok) throw new Error('GET ' + p + ' -> ' + r.status + ' ' + t.slice(0, 200));
  return j;
}

(async () => {
  let ids = process.argv.slice(2).map((x) => parseInt(x, 10)).filter(Boolean);
  if (!ids.length) ids = ((await call('/board')).clients || []).map((c) => c.client_id);
  let text = fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8') : '';
  if (!text.includes(HEAD)) text = text.replace(/\s*$/, '\n\n' + HEAD + '\n');
  const lines = [];
  for (const cid of ids) {
    const tasks = (await call('/tasks?client_id=' + cid)).tasks || [];
    for (const t of tasks) {
      if (!t.review_override || !t.review_override_note) continue;
      const key = 'task#' + t.id;
      if (text.includes(key)) continue;
      lines.push('- [' + key + ' ' + (t.review_reviewed_at || '').slice(0, 10) + '] fable 判 ' + t.review_verdict + '（' + String(t.review_reason || '').slice(0, 80) + '），人改 ' + t.review_override + '：' + String(t.review_override_note).replace(/\s+/g, ' ').slice(0, 200));
    }
    const plans = (await call('/plans?client_id=' + cid)).plans || [];
    for (const p of plans) {
      if (p.status !== 'rejected' || !p.reject_reason) continue;
      const key = 'plan#' + p.id;
      if (text.includes(key)) continue;
      lines.push('- [' + key + ' v' + p.version + '] 方案被打回：' + String(p.reject_reason).replace(/\s+/g, ' ').slice(0, 200));
    }
  }
  if (!lines.length) { console.log('没有新的推翻或打回记录'); return; }
  text = text.replace(/\s*$/, '\n') + lines.join('\n') + '\n';
  fs.writeFileSync(FILE, text);
  console.log('追加 ' + lines.length + ' 条到 ' + FILE + '：\n' + lines.join('\n'));
})().catch((e) => { console.error('experience_sync 中止：' + e.message); process.exit(1); });
