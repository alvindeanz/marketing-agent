#!/usr/bin/env node
'use strict';
// cohort_backtest：批次结果回测（2026-09-21 Alvin 批，第一性审阅后的 P1）。
// 零 LLM。已落地的写批次（done 任务 note 带 [applied] 与受影响 URL）满 28 天测量窗后，
// 拉 GSC 页级前后窗对比（点击/曝光/CTR/位次），结果落客户工作区 notes/cohort_results.{json,md}，
// 打印船队 digest。这是「学得回」闭环缺的另一半：experience_sync 回流人工纠偏（判断层），
// 本工具回流改动实效（结果层），月报证据素材是副产品。
//
// 用法：SEO_WORKER_CONFIG=/data/aira/seo-worker/config.json node tools/cohort_backtest.js <cid...> [--min-age 28] [--force]
//   --min-age  落地后至少几天才回测（默认 28，再加 GSC 3 天滞后）
//   --force    已回测过的批次重算（默认跳过 json 里已有结果的任务）
//
// GSC 三个已知坑的处理：页级查询不碰站均（dimensions=['page'] 本身就是页级）；
// 窗口右端压到 today-3 之前（尾日不全）；rowLimit 25000 一把抓全站页再本地匹配，
// 不用 page 过滤器（GSC 的 country/page 过滤会丢行，见 feedback_gsc_country_filter_drops_rows）。

const fs = require('node:fs');
const path = require('node:path');
const cfgLib = require('../lib/config');
const { Api } = require('../lib/api');
const { googlePost } = require('../lib/google');

const GSC_SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly'];
const LAG_DAYS = 3;
const WIN_DAYS = 28;

const argv = process.argv.slice(2);
const MIN_AGE = (() => { const i = argv.indexOf('--min-age'); return i === -1 ? 28 : (parseInt(argv[i + 1], 10) || 28); })();
const FORCE = argv.includes('--force');
const flagVals = new Set();
{ const i = argv.indexOf('--min-age'); if (i !== -1) flagVals.add(i + 1); }
const ids = argv.filter((a, i) => /^\d+$/.test(a) && !flagVals.has(i)).map(Number);
if (!ids.length) { console.error('用法：node tools/cohort_backtest.js <client_id...> [--min-age 28] [--force]'); process.exit(2); }

const cfg = cfgLib.load();
const api = new Api(cfg);
const log = (m) => console.log(m);

const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const today = ymd(new Date());

/** URL 归一化：小写 host，去 query/hash，尾斜杠归一（保留）。 */
function normUrl(u) {
  try {
    const x = new URL(String(u).trim());
    let p = x.pathname;
    if (!p.endsWith('/')) p += '/';
    return x.origin.toLowerCase() + p;
  } catch (e) { return null; }
}

/** 从 done 任务的 note 抠批次：apply 日期 + 受影响 URL 集。 */
function extractBatch(t) {
  const n = String(t.result_note || '');
  if (t.status !== 'done' || n.indexOf('[applied]') === -1) return null;
  const dm = n.match(/apply-log-task-\d+-(\d{4}-\d{2}-\d{2})/);
  if (!dm) return null;
  // 只在 [applied] 之后的文本里找 URL，剔除内部域名与存档链接
  const seg = n.slice(n.indexOf('[applied]'));
  const urls = [];
  for (const m of seg.matchAll(/https?:\/\/[^\s)|，；、"'<>]+/g)) {
    const u = m[0];
    if (/agencyreport|blogpreview|horntech-dev\.com|\?preview=/.test(u)) continue;
    const nu = normUrl(u);
    if (nu && urls.indexOf(nu) === -1) urls.push(nu);
  }
  if (!urls.length) return null;
  return { taskId: t.id, title: String(t.title || '').slice(0, 60), applied: dm[1], urls };
}

async function gscPages(property, start, end) {
  const url = 'https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(property) + '/searchAnalytics/query';
  const res = await googlePost(cfg.ga4KeyFile, GSC_SCOPES, url, {
    startDate: start, endDate: end, dimensions: ['page'], rowLimit: 25000,
  }, cfg.httpTimeoutMs);
  const map = new Map();
  for (const r of (res && res.rows) || []) {
    const k = normUrl((r.keys || [])[0]);
    if (!k) continue;
    map.set(k, { clicks: r.clicks || 0, impressions: r.impressions || 0, position: r.position || 0 });
  }
  return map;
}

function sumSet(map, urls) {
  let clicks = 0, impr = 0, posW = 0, hit = 0;
  for (const u of urls) {
    const r = map.get(u);
    if (!r) continue;
    hit += 1; clicks += r.clicks; impr += r.impressions; posW += r.position * r.impressions;
  }
  return { clicks, impressions: impr, ctr: impr ? +(100 * clicks / impr).toFixed(2) : 0, position: impr ? +(posW / impr).toFixed(1) : null, pages_with_data: hit };
}

async function runClient(cid) {
  const context = await api.getContext(cid);
  const profile = context && context.profile;
  if (!profile) { log('client ' + cid + ': 无 profile，跳过'); return []; }
  const property = profile.gsc_property || profile.gsc_site;
  const name = (context.client && context.client.name) || profile.workspace_dir || cid;
  if (!property) { log(name + ': 无 gsc_property，跳过'); return []; }
  const ws = path.join(cfg.workspaceRoot, profile.workspace_dir || String(cid));
  const jsonFile = path.join(ws, 'notes', 'cohort_results.json');
  const mdFile = path.join(ws, 'notes', 'cohort_results.md');
  let store = {};
  try { store = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); } catch (e) { /* 首次 */ }

  const batches = (context.tasks || []).map(extractBatch).filter(Boolean);
  const out = [];
  for (const b of batches) {
    if (!FORCE && store[b.taskId]) continue;
    const readyAt = addDays(b.applied, MIN_AGE + LAG_DAYS);
    if (readyAt > today) { out.push({ ...b, status: 'waiting', ready_at: readyAt }); continue; }
    const afterEnd = addDays(b.applied, MIN_AGE) < addDays(today, -LAG_DAYS) ? addDays(b.applied, MIN_AGE) : addDays(today, -LAG_DAYS);
    const afterWin = { start: addDays(b.applied, 1), end: afterEnd };
    if (afterWin.start > afterWin.end) { out.push({ ...b, status: 'waiting', ready_at: addDays(b.applied, LAG_DAYS + 2) }); continue; }
    /* 前后窗必须等长，否则截短的 after 窗对比 28 天 before 窗天然偏负 */
    const winLen = Math.round((new Date(afterWin.end) - new Date(afterWin.start)) / 86400000) + 1;
    const beforeWin = { start: addDays(b.applied, -winLen), end: addDays(b.applied, -1) };
    const [bm, am] = [await gscPages(property, beforeWin.start, beforeWin.end), await gscPages(property, afterWin.start, afterWin.end)];
    const before = sumSet(bm, b.urls);
    const after = sumSet(am, b.urls);
    const row = {
      ...b, status: 'measured', measured_at: today,
      window_days: winLen, before_window: beforeWin, after_window: afterWin,
      before, after,
      delta: {
        clicks: after.clicks - before.clicks,
        impressions: after.impressions - before.impressions,
        ctr_pp: +(after.ctr - before.ctr).toFixed(2),
        position: (after.position != null && before.position != null) ? +(before.position - after.position).toFixed(1) : null,
      },
    };
    store[b.taskId] = row;
    out.push(row);
  }
  if (Object.keys(store).length) {
    fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
    fs.writeFileSync(jsonFile, JSON.stringify(store, null, 2));
    const lines = ['# 批次回测台账（cohort_backtest 自动生成，勿手编）', ''];
    for (const r of Object.values(store).sort((a, z) => String(a.applied).localeCompare(String(z.applied)))) {
      if (r.status !== 'measured') continue;
      lines.push('## #' + r.taskId + ' ' + r.title + '（落地 ' + r.applied + '，测于 ' + r.measured_at + '）');
      lines.push('- 页面 ' + r.urls.length + ' 个，前后各 ' + r.window_days + ' 天');
      lines.push('- 点击 ' + r.before.clicks + ' 到 ' + r.after.clicks + '（' + (r.delta.clicks >= 0 ? '+' : '') + r.delta.clicks + '），曝光 ' + r.before.impressions + ' 到 ' + r.after.impressions);
      lines.push('- CTR ' + r.before.ctr + '% 到 ' + r.after.ctr + '%（' + (r.delta.ctr_pp >= 0 ? '+' : '') + r.delta.ctr_pp + 'pp），位次 ' + (r.before.position ?? '无') + ' 到 ' + (r.after.position ?? '无') + (r.delta.position != null ? '（' + (r.delta.position >= 0 ? '提升 ' : '下滑 ') + Math.abs(r.delta.position) + '）' : ''));
      lines.push('');
    }
    fs.writeFileSync(mdFile, lines.join('\n'));
  }
  return out.map((r) => ({ client: name, ...r }));
}

(async () => {
  const all = [];
  for (const cid of ids) {
    try { all.push(...await runClient(cid)); }
    catch (e) { log('client ' + cid + ' 回测失败：' + e.message); }
  }
  const measured = all.filter((r) => r.status === 'measured');
  const waiting = all.filter((r) => r.status === 'waiting');
  console.log('\n# 回测 digest ' + today);
  for (const r of measured) {
    console.log('- ' + r.client + ' #' + r.taskId + '：点击 ' + (r.delta.clicks >= 0 ? '+' : '') + r.delta.clicks + '，CTR ' + (r.delta.ctr_pp >= 0 ? '+' : '') + r.delta.ctr_pp + 'pp，位次' + (r.delta.position != null ? (r.delta.position >= 0 ? '提升 ' : '下滑 ') + Math.abs(r.delta.position) : '无数据') + '（' + r.urls.length + ' 页）');
  }
  if (waiting.length) {
    console.log('测量窗未满 ' + waiting.length + ' 批：' + waiting.map((r) => r.client + '#' + r.taskId + '(' + r.ready_at + ')').join('、'));
  }
  if (!measured.length && !waiting.length) console.log('没有可回测的批次');
})();
