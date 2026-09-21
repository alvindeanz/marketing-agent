#!/usr/bin/env node
'use strict';
// live_audit：宣称对账（2026-09-21 Alvin 批，第一性审阅 P2）。
// 零 LLM。板上宣称 done 且带 [applied] 的写批次，逐条现测线上：受影响 URL 200 且零跳转、
// 改前存档链接可回溯。这是北极星度量「L0 占比升且事故数零」缺的那台仪器：
// 零事故必须是查出来的零，不是没人查的零。
//
// 用法：SEO_WORKER_CONFIG=/data/aira/seo-worker/config.json node tools/live_audit.js [--scan | cid...] [--days 14]
//   --scan   扫 client 1 到 70，跳过无 profile 或 archived
//   --days   只审最近 N 天收口的批次（默认 14，cron 周跑覆盖有余）
// 有 FAIL 退出码 1（cron 邮件/日志醒目），全 PASS 退出码 0。

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const cfgLib = require('../lib/config');
const { Api } = require('../lib/api');

const argv = process.argv.slice(2);
const SCAN = argv.includes('--scan');
const DAYS = (() => { const i = argv.indexOf('--days'); return i === -1 ? 14 : (parseInt(argv[i + 1], 10) || 14); })();
const flagVals = new Set();
{ const i = argv.indexOf('--days'); if (i !== -1) flagVals.add(i + 1); }
const ids = SCAN ? Array.from({ length: 70 }, (_, i) => i + 1) : argv.filter((a, i) => /^\d+$/.test(a) && !flagVals.has(i)).map(Number);
if (!ids.length) { console.error('用法：node tools/live_audit.js [--scan | cid...] [--days 14]'); process.exit(2); }

const cfg = cfgLib.load();
const api = new Api(cfg);
const today = new Date().toISOString().slice(0, 10);
const cutoff = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);

function curlProbe(url) {
  try {
    const out = execFileSync('curl', ['-s', '-o', '/dev/null', '--max-time', '20', '-A', 'Mozilla/5.0 (compatible; horntech-live-audit)', '-w', '%{http_code} %{num_redirects}', url], { encoding: 'utf8', timeout: 25000 });
    const [code, redirects] = out.trim().split(' ');
    return { code: parseInt(code, 10) || 0, redirects: parseInt(redirects, 10) || 0 };
  } catch (e) { return { code: 0, redirects: 0 }; }
}

function extractApplied(t) {
  const n = String(t.result_note || '');
  if (t.status !== 'done' || n.indexOf('[applied]') === -1) return null;
  const dm = n.match(/apply-log-task-\d+-(\d{4}-\d{2}-\d{2})/);
  const closed = dm ? dm[1] : null;
  if (!closed || closed < cutoff) return null;
  if (/无变更方案验收/.test(n)) return null; // 无写入，无需对账
  const seg = n.slice(n.indexOf('[applied]'));
  const site = []; let archive = null;
  for (const m of seg.matchAll(/https?:\/\/[^\s)|，；、"'<>]+/g)) {
    /* note 存库可能截断，贴着文本末尾结束的 URL 疑似半截，跳过不审 */
    if (m.index + m[0].length >= seg.length) continue;
    const u = m[0].replace(/[.,;]$/, '');
    if (/agencyreport\.horntech-dev\.com\/reports\/[^\s]+\/qa\//.test(u)) { archive = archive || u; continue; }
    if (/horntech-dev\.com|blogpreview|\?preview=/.test(u)) continue;
    if (site.indexOf(u) === -1) site.push(u);
  }
  if (!site.length && !archive) return null;
  return { taskId: t.id, title: String(t.title || '').slice(0, 50), closed, site, archive };
}

(async () => {
  const rows = []; let fails = 0;
  for (const cid of ids) {
    let context;
    try { context = await api.getContext(cid); } catch (e) { continue; }
    const profile = context && context.profile;
    if (!profile || String(profile.status) === 'archived') continue;
    const name = (context.client && context.client.name) || profile.workspace_dir || cid;
    for (const t of context.tasks || []) {
      const b = extractApplied(t);
      if (!b) continue;
      const problems = [];
      for (const u of b.site) {
        const r = curlProbe(u);
        if (r.code !== 200) problems.push(u + ' -> HTTP ' + r.code);
        else if (r.redirects > 0) problems.push(u + ' -> ' + r.redirects + ' 跳转（交付 URL 应零跳转）');
      }
      if (b.archive) {
        const r = curlProbe(b.archive);
        if (r.code !== 200) problems.push('改前存档 ' + r.code + ' 不可回溯');
      }
      const ok = problems.length === 0;
      if (!ok) fails += 1;
      rows.push({ client: name, taskId: b.taskId, title: b.title, closed: b.closed, urls: b.site.length, ok, problems });
    }
  }
  console.log('# 宣称对账 ' + today + '（最近 ' + DAYS + ' 天收口的写批次）');
  for (const r of rows) {
    console.log((r.ok ? 'PASS ' : 'FAIL ') + r.client + ' #' + r.taskId + ' ' + r.title + '（' + r.closed + '，' + r.urls + ' URL）');
    for (const p of r.problems) console.log('     ' + p);
  }
  console.log('\n共 ' + rows.length + ' 批，FAIL ' + fails + ' 批');
  process.exit(fails ? 1 : 0);
})();
