#!/usr/bin/env node
'use strict';
// T2 标签统一回挂（PLAN W18，2026-10-25 Alvin 批）。零 LLM，人触发（随 label_stats 或单独跑）。
// 五个信号源收进一份 labels.jsonl（追加式，按 labelKey 去重）：
//   override / plan_reject（看板 API，experience_sync 同源）、spotcheck 台账 md、
//   cohort_backtest 结果 json、客户卡反馈（GET /card_feedback?client_id=）。
// 另记一份快照账本 stats_history.jsonl：每次跑记 judged/overridden 总量（推翻率趋势的分母，
// 板上只有现值，趋势只能靠快照攒）。
//   用法：SEO_AGENT_TOKEN=<admin jwt> node tools/label_sync.js [client_id ...]
// 路径均可用环境变量覆盖（LABELS_DIR / SPOTCHECK_DIR / CLIENTS_ROOT），默认 ros 本机惯例。

const fs = require('fs');
const path = require('path');
const labels = require('../lib/labels');

const API = process.env.SEO_API_BASE || 'https://always.horntech-dev.com/seo-api.php';
const TOKEN = process.env.SEO_AGENT_TOKEN || '';
const LABELS_DIR = process.env.LABELS_DIR || '/data/aira/projects/MA/memory/labels';
const SPOTCHECK_DIR = process.env.SPOTCHECK_DIR || '/data/aira/projects/MA/memory/spotcheck';
const CLIENTS_ROOT = process.env.CLIENTS_ROOT || '/data/aira/clients';
const OUT = path.join(LABELS_DIR, 'labels.jsonl');
const HISTORY = path.join(LABELS_DIR, 'stats_history.jsonl');

async function call(p) {
  const r = await fetch(API + p, { headers: { Authorization: 'Bearer ' + TOKEN } });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch (e) { j = {}; }
  if (!r.ok) throw new Error('GET ' + p + ' -> ' + r.status + ' ' + t.slice(0, 200));
  return j;
}

function readExistingKeys() {
  const keys = new Set();
  try {
    for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { keys.add(labels.labelKey(JSON.parse(line))); } catch (e) { /* 坏行跳过 */ }
    }
  } catch (e) { /* 首跑无文件 */ }
  return keys;
}

/** 采集全部新 label（不写盘）。返回 { fresh, counts, snapshot }。tools 与测试共用。 */
async function collect(ids) {
  if (!TOKEN) throw new Error('SEO_AGENT_TOKEN 缺失');
  if (!ids || !ids.length) ids = ((await call('/board')).clients || []).map((c) => c.client_id);
  const existing = readExistingKeys();
  const fresh = [];
  const counts = {};
  const snapshot = { at: new Date().toISOString().slice(0, 10), judged: 0, overridden: 0, judged_paid: 0, overridden_paid: 0 };
  const push = (l) => {
    if (!l) return;
    const k = labels.labelKey(l);
    if (existing.has(k)) return;
    existing.add(k);
    fresh.push(l);
    counts[l.signal] = (counts[l.signal] || 0) + 1;
  };

  for (const cid of ids) {
    const tasks = (await call('/tasks?client_id=' + cid)).tasks || [];
    const moduleByTask = {};
    for (const t of tasks) {
      moduleByTask[t.id] = labels.moduleOf(t);
      if (t.review_verdict) {
        snapshot.judged += 1;
        if (moduleByTask[t.id] === 'paid') snapshot.judged_paid += 1;
        if (t.review_override) {
          snapshot.overridden += 1;
          if (moduleByTask[t.id] === 'paid') snapshot.overridden_paid += 1;
        }
      }
      push(labels.overrideLabel(t, cid));
    }
    const plans = (await call('/plans?client_id=' + cid)).plans || [];
    for (const p of plans) push(labels.planRejectLabel(p, cid));
    try {
      const rows = (await call('/card_feedback?client_id=' + cid + '&limit=200')).rows || [];
      for (const r of rows) push(labels.cardLabel(r, cid, moduleByTask));
    } catch (e) { /* 路由缺位或零行，不挡其他源 */ }
  }

  try {
    for (const f of fs.readdirSync(SPOTCHECK_DIR)) {
      if (!f.startsWith('run_') || !f.endsWith('.md')) continue;
      const text = fs.readFileSync(path.join(SPOTCHECK_DIR, f), 'utf8');
      for (const l of labels.parseSpotcheckMd(text, f.replace(/\.md$/, ''))) push(l);
    }
  } catch (e) { /* 目录缺位跳过 */ }

  try {
    for (const slug of fs.readdirSync(CLIENTS_ROOT)) {
      const p = path.join(CLIENTS_ROOT, slug, 'notes', 'cohort_results.json');
      if (!fs.existsSync(p)) continue;
      let data;
      try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { continue; }
      for (const k of Object.keys(data)) push(labels.cohortLabel(data[k], slug));
    }
  } catch (e) { /* 目录缺位跳过 */ }

  return { fresh, counts, snapshot };
}

/** 采集并落盘。返回 collect 的结果（label_stats --sync 复用）。 */
async function sync(ids) {
  const r = await collect(ids);
  fs.mkdirSync(LABELS_DIR, { recursive: true });
  if (r.fresh.length) {
    fs.appendFileSync(OUT, r.fresh.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  fs.appendFileSync(HISTORY, JSON.stringify(r.snapshot) + '\n');
  return r;
}

if (require.main === module) {
  (async () => {
    const ids = process.argv.slice(2).map((x) => parseInt(x, 10)).filter(Boolean);
    const r = await sync(ids);
    const parts = Object.keys(r.counts).map((k) => k + ' ' + r.counts[k]);
    console.log('新增 ' + r.fresh.length + ' 条标签' + (parts.length ? '（' + parts.join('，') + '）' : '') + ' -> ' + OUT);
    console.log('快照：judged ' + r.snapshot.judged + '（paid ' + r.snapshot.judged_paid + '），overridden ' + r.snapshot.overridden + '（paid ' + r.snapshot.overridden_paid + '）');
  })().catch((e) => { console.error('label_sync 中止：' + e.message); process.exit(1); });
}

module.exports = { collect, sync, OUT, HISTORY, LABELS_DIR };
