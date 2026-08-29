#!/usr/bin/env node
'use strict';
// 导入包 -> 看板。2026-08-29 起批量导入客户的机械步骤，替代手抄 JSON。
//   node tools/import_package.js <client_dir> [--apply] [--token <jwt>]
// 读 /data/aira/clients/<client_dir>/seo-agent-onboarding/import_package_v1_draft.md（或 _final.md），
// 解析第 1 节 profile、第 2 节 facts、第 3 节大事记，落三份 JSON 到同目录，
// 不带 --apply 只落文件并打印摘要；带 --apply 依次 PUT /profile、POST /facts、POST /facts_history（都要 admin JWT）。
// 不起 job，job 链另跑（pull_data -> backfill_metrics -> discover -> plan），每步要人看一眼。
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const clientDir = args[0];
if (!clientDir) { console.error('用法：import_package.js <client_dir> [--apply] [--token <jwt>]'); process.exit(2); }
const APPLY = args.includes('--apply');
const tokIdx = args.indexOf('--token');
const TOKEN = tokIdx > -1 ? args[tokIdx + 1] : (process.env.SEO_AGENT_TOKEN || '');
const API = process.env.SEO_API_BASE || 'https://always.horntech-dev.com/seo-api.php';

const dir = path.join('/data/aira/clients', clientDir, 'seo-agent-onboarding');
const file = ['import_package_v1_final.md', 'import_package_v1_draft.md'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
if (!file) { console.error('找不到导入包：' + dir); process.exit(2); }
const md = fs.readFileSync(file, 'utf8');

/** 取 "## N. " 开头的一节 */
function section(n) {
  const re = new RegExp('(^|\\n)## ' + n + '\\.[^\\n]*\\n([\\s\\S]*?)(?=\\n## \\d+\\.|$)');
  const m = md.match(re);
  return m ? m[2] : '';
}
/** 表格行 -> 单元格数组，处理 \| 转义 */
function rows(text) {
  return text.split('\n').filter((l) => /^\|/.test(l) && !/^\|\s*-{3,}/.test(l)).map((l) => {
    let s = l.trim().replace(/^\|/, '').replace(/\|$/, '');
    // 反引号里的竖线是正则的一部分，不是分列
    s = s.replace(/`[^`]*`/g, (m) => m.replace(/\|/g, '\\|'));
    return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
  });
}
const strip = (s) => String(s || '').replace(/^`|`$/g, '').replace(/\\\|/g, '|').trim();

// ---- 1. profile
const prof = {};
for (const r of rows(section(1))) {
  if (r.length < 2 || r[0] === '字段') continue;
  prof[r[0]] = r[1];
}
const clientId = parseInt(prof.client_id, 10);
if (!clientId) { console.error('profile 表里 client_id 不是数字：' + prof.client_id); process.exit(2); }
/** target_keywords 一栏是带小标题的中文散文，取冒号后面按逗号或顿号拆的英文词 */
function parseKeywords(text) {
  const out = [];
  const segs = String(text || '').split(/[。;；]/);
  for (const seg of segs) {
    const body = seg.includes(':') ? seg.split(':').slice(1).join(':') : (seg.includes('：') ? seg.split('：').slice(1).join('：') : '');
    for (const w of body.split(/[,，、]/)) {
      const k = w.trim().replace(/\s*\(.*?\)\s*$/, '').toLowerCase();
      if (/^[a-z0-9][a-z0-9 '\-]{2,60}$/.test(k) && !out.includes(k)) out.push(k);
    }
  }
  return out;
}
const profile = {
  client_id: clientId,
  status: prof.status || 'active',
  report_lang: prof.report_lang || 'zh',
  platform: prof.platform,
  domain: prof.domain,
  workspace_dir: prof.workspace_dir,
  ga4_property: prof.ga4_property,
  gsc_property: prof.gsc_property,
  semrush_db: prof.semrush_db || 'nz',
  semrush_project: prof.semrush_project || '',
  brand_regex: strip(prof.brand_regex),
  target_keywords: parseKeywords(prof.target_keywords),
  business_goals: prof.business_goals,
  conversion_goals: prof.conversion_goals,
  notes: prof.notes,
};
try { new RegExp(profile.brand_regex); } catch (e) { console.error('brand_regex 不是合法正则：' + profile.brand_regex); process.exit(2); }

// ---- 2. facts
const facts = [];
for (const r of rows(section(2))) {
  if (r.length < 3 || r[0] === 'fact_key') continue;
  const key = strip(r[0]);
  if (!/^[a-z0-9_]+\.[a-z0-9_]+$/.test(key)) continue;
  const value = r[1];
  if (value.length > 400) { console.error('fact ' + key + ' 值 ' + value.length + ' 字，超 400'); process.exit(2); }
  facts.push({ fact_key: key, value, source: 'manual', status: /待确认|待提供/.test(value) && /approver/.test(key) ? 'unconfirmed' : 'confirmed' });
}

// ---- 3. history
const events = [];
for (const r of rows(section(3))) {
  if (r.length < 3 || r[0] === 'date') continue;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r[0])) continue;
  if (!['apply', 'publish', 'config', 'offpage', 'manual'].includes(r[1])) { console.error('大事记 kind 非法：' + r[1]); process.exit(2); }
  events.push({ d: r[0], kind: r[1], label: r[2] });
}

const total = facts.length + events.length;
if (total > 55) { console.error('总行数 ' + total + ' 超 55'); process.exit(2); }

fs.writeFileSync(path.join(dir, 'profile_fill.json'), JSON.stringify(profile, null, 2));
fs.writeFileSync(path.join(dir, 'facts_fill.json'), JSON.stringify({ client_id: clientId, facts }, null, 2));
fs.writeFileSync(path.join(dir, 'facts_history.json'), JSON.stringify({ client_id: clientId, events }, null, 2));

console.log('包：' + path.basename(file));
console.log('client_id ' + clientId + ' · facts ' + facts.length + '（unconfirmed ' + facts.filter((f) => f.status === 'unconfirmed').length + '）· 大事记 ' + events.length + ' · 合计 ' + total);
console.log('profile: domain=' + profile.domain + ' ga4=' + profile.ga4_property + ' gsc=' + profile.gsc_property + ' ws=' + profile.workspace_dir + ' brand=/' + profile.brand_regex + '/');
console.log('target_keywords (' + profile.target_keywords.length + '): ' + profile.target_keywords.join(', '));
console.log('facts keys: ' + facts.map((f) => f.fact_key).join(' '));

if (!APPLY) { console.log('（未带 --apply，只落了 JSON）'); process.exit(0); }
if (!TOKEN) { console.error('--apply 需要 admin JWT（--token 或 SEO_AGENT_TOKEN）'); process.exit(2); }

async function call(method, p, body) {
  const r = await fetch(API + p, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch (e) { j = { raw: t.slice(0, 200) }; }
  if (!r.ok) throw new Error(method + ' ' + p + ' -> ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  return j;
}
(async () => {
  const p = await call('PUT', '/profile', profile);
  console.log('PUT /profile ok', JSON.stringify(p).slice(0, 120));
  for (let i = 0; i < facts.length; i += 50) {
    const f = await call('POST', '/facts', { client_id: clientId, facts: facts.slice(i, i + 50) });
    console.log('POST /facts ok', JSON.stringify(f).slice(0, 160));
  }
  const h = await call('POST', '/facts_history', { client_id: clientId, events });
  console.log('POST /facts_history ok', JSON.stringify(h).slice(0, 160));
})().catch((e) => { console.error('导入失败：' + e.message); process.exit(1); });
