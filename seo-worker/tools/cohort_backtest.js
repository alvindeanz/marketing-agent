#!/usr/bin/env node
'use strict';
// cohort_backtest：批次结果回测（2026-09-21 Alvin 批，第一性审阅后的 P1）。
// 零 LLM。已落地的写批次（done 任务 note 带 [applied] 与受影响 URL）满 28 天测量窗后，
// 拉 GSC 页级前后窗对比（点击/曝光/CTR/位次），结果落客户工作区 notes/cohort_results.{json,md}，
// 打印船队 digest。这是「学得回」闭环缺的另一半：experience_sync 回流人工纠偏（判断层），
// 本工具回流改动实效（结果层），月报证据素材是副产品。
//
// 用法：SEO_WORKER_CONFIG=/data/aira/seo-worker/config.json node tools/cohort_backtest.js [cid...] [--min-age 28] [--force]
//   不传 cid 默认全量 active（从 /board 现取，不再依赖 crontab 写死清单）
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
let ids = argv.filter((a, i) => /^\d+$/.test(a) && !flagVals.has(i)).map(Number);
// 不传 id = 全量 active（2026-10-14 Alvin 批统一半月制口径，取代 crontab 写死 id 清单的漂移）

/* 懒加载：纯函数可被单测 require，不碰 config 文件（2026-10-27 paid 侧接线时改） */
let cfg = null;
let api = null;
function ensureCtx() { if (!cfg) { cfg = cfgLib.load(); api = new Api(cfg); } }
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

/* ===== paid 侧（2026-10-27 Alvin 批「动手做吧」，W18 Gate C 欠账）=====
   paid 批次 = module paid/sem 的 done 任务 note 带 [applied]。归因天然比 SEO 页级弱，
   宁可少标不硬归因，两道保护：前后窗转化合计不满 30 只标 low_volume 不出结论（止血类
   按花费判是唯一例外）；测量窗内有其他批次落在同 campaign 的标 confounded 不打标签。
   成熟窗按动作类型（label_stats Gate C 口径）：止血类 14d、出价预算类跳过 7d 学习期再
   28d、文案资产类 28d 以 CTR 为主。转化口径 metrics.conversions（账户 Primary，客户级
   口径见 fact ads.google.conversion_scope）。metrics.conversions 按点击日归因，回看窗内
   会继续回填（restatement），右缘与 GSC 同款压 today-3，残余滞后记作本工具的已知噪声。 */

const PAID_LAG_DAYS = 3;
const PAID_WINDOWS = { bleed: { skip: 0, days: 14 }, learn: { skip: 7, days: 28 }, copy: { skip: 0, days: 28 } };

function paidOpsClass(ops) {
  const s = String(ops || '').toLowerCase();
  if (/negative|exclusion|criteri/.test(s)) return 'bleed';
  if (/budget|bid|target-cpa|target-roas|troas|tcpa/.test(s)) return 'learn';
  return 'copy';
}

function paidWindow(klass, applied) {
  const w = PAID_WINDOWS[klass] || PAID_WINDOWS.copy;
  const start = addDays(applied, w.skip + 1);
  const end = addDays(applied, w.skip + w.days);
  return {
    start, end, winLen: w.days,
    ready_at: addDays(end, PAID_LAG_DAYS + 1),
    before: { start: addDays(applied, -w.days), end: addDays(applied, -1) },
  };
}

/** 从 done 任务 note 抠 paid 批次：apply 日期 + 受影响实体（能归因到 campaign 的三类）。 */
function extractPaidBatch(t) {
  if (!/^(paid|sem)$/.test(String(t.module || ''))) return null;
  const n = String(t.result_note || '');
  if (t.status !== 'done' || n.indexOf('[applied]') === -1) return null;
  const dm = n.match(/apply-log-task-\d+-(\d{4}-\d{2}-\d{2})/);
  if (!dm) return null;
  const ads = new Set(); const assetGroups = new Set(); const campaigns = new Set();
  for (const m of n.matchAll(/customers\/\d+\/(\w+)\/([\w~-]+)/g)) {
    const type = m[1]; const id = String(m[2]).split('~')[0];
    if (!/^\d+$/.test(id)) continue;
    if (type === 'campaigns' || type === 'campaignCriteria' || type === 'campaignSharedSets' || type === 'campaignBudgets' || type === 'campaignConversionGoals') campaigns.add(id);
    else if (type === 'assetGroups' || type === 'assetGroupAssets') assetGroups.add(id);
    else if (type === 'adGroupAds') { const p = String(m[2]).split('~')[1] || ''; if (/^\d+$/.test(p)) ads.add(p); }
  }
  for (const m of n.matchAll(/\bad (\d{6,})/g)) ads.add(m[1]);
  for (const m of n.matchAll(/\basset[_ ]?group (\d{6,})/gi)) assetGroups.add(m[1]);
  if (!ads.size && !assetGroups.size && !campaigns.size) return null;
  return {
    taskId: t.id, title: String(t.title || '').slice(0, 60), applied: dm[1],
    klass: paidOpsClass(t.ops),
    ads: [...ads], assetGroups: [...assetGroups], campaigns: [...campaigns],
  };
}

/** 默认 GAQL 通道（只读子进程），单测可换假的。 */
function runGaqlDefault(customerId, query) {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync('python3', [path.join(__dirname, '..', 'lib', 'gaql_query.py'), customerId, query], { timeout: 60000 }).toString().trim();
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
let runGaql = runGaqlDefault;

/** 实体归因到 campaign id 集（ad 与 asset group 各一次反查，campaign 类直取）。 */
function paidCampaignsFor(customerId, b) {
  const camps = new Set(b.campaigns);
  if (b.ads.length) {
    const rows = runGaql(customerId, 'SELECT campaign.id, ad_group_ad.ad.id FROM ad_group_ad WHERE ad_group_ad.ad.id IN (' + b.ads.join(',') + ')');
    for (const r of rows) if (r.campaign_id) camps.add(String(r.campaign_id));
  }
  if (b.assetGroups.length) {
    const rows = runGaql(customerId, 'SELECT asset_group.id, asset_group.campaign FROM asset_group WHERE asset_group.id IN (' + b.assetGroups.join(',') + ')');
    for (const r of rows) { const m = String(r.asset_group_campaign || '').match(/campaigns\/(\d+)/); if (m) camps.add(m[1]); }
  }
  return [...camps];
}

/** 一个窗口的汇总指标（campaign 集为空退账户级，scope 记 account）。 */
function paidMetrics(customerId, campaignIds, start, end) {
  const q = campaignIds.length
    ? "SELECT campaign.id, metrics.cost_micros, metrics.conversions, metrics.clicks, metrics.impressions FROM campaign WHERE segments.date BETWEEN '" + start + "' AND '" + end + "' AND campaign.id IN (" + campaignIds.join(',') + ')'
    : "SELECT metrics.cost_micros, metrics.conversions, metrics.clicks, metrics.impressions FROM customer WHERE segments.date BETWEEN '" + start + "' AND '" + end + "'";
  let cost = 0; let conv = 0; let clicks = 0; let impr = 0;
  for (const r of runGaql(customerId, q)) {
    cost += Number(r.metrics_cost_micros || 0);
    conv += Number(r.metrics_conversions || 0);
    clicks += Number(r.metrics_clicks || 0);
    impr += Number(r.metrics_impressions || 0);
  }
  cost = +(cost / 1e6).toFixed(2);
  conv = +conv.toFixed(1);
  return {
    cost, conversions: conv, clicks, impressions: impr,
    ctr: impr ? +((100 * clicks) / impr).toFixed(2) : 0,
    cpa: conv > 0 ? +(cost / conv).toFixed(2) : null,
  };
}

function pctDelta(after, before) { return before ? +(((after - before) * 100) / before).toFixed(1) : null; }

/** 按类型判 improved / declined / flat（纯函数，单测用）。 */
function paidVerdict(klass, before, after) {
  const convTotal = (before.conversions || 0) + (after.conversions || 0);
  if (klass === 'copy') {
    const imprTotal = (before.impressions || 0) + (after.impressions || 0);
    if (imprTotal < 1000) return { verdict: null, status: 'low_volume', why: '前后窗曝光合计 ' + imprTotal + ' 不足 1000，不判' };
    const d = pctDelta(after.ctr, before.ctr);
    return { verdict: d == null ? 'flat' : d >= 10 ? 'improved' : d <= -10 ? 'declined' : 'flat', status: 'measured', why: 'CTR ' + before.ctr + '% 到 ' + after.ctr + '%（' + (d == null ? 'n/a' : d + '%') + '，文案资产类主指标）' };
  }
  if (convTotal < 30) {
    if (klass === 'bleed') {
      const d = pctDelta(after.cost, before.cost);
      return { verdict: d == null ? 'flat' : d <= -10 ? 'improved' : d >= 10 ? 'declined' : 'flat', status: 'measured', why: '转化量不足，止血类按花费判：cost ' + before.cost + ' 到 ' + after.cost + '（' + (d == null ? 'n/a' : d + '%') + '）' };
    }
    return { verdict: null, status: 'low_volume', why: '前后窗转化合计 ' + convTotal + ' 不满 30，不判（低量户口径）' };
  }
  if (before.cpa == null || after.cpa == null) return { verdict: null, status: 'low_volume', why: '单窗零转化，CPA 不可比' };
  const d = pctDelta(after.cpa, before.cpa);
  return { verdict: d <= -10 ? 'improved' : d >= 10 ? 'declined' : 'flat', status: 'measured', why: 'CPA ' + before.cpa + ' 到 ' + after.cpa + '（' + d + '%，' + (klass === 'learn' ? '出价预算类，已跳过 7 天学习期' : '止血类') + '）' };
}

/** 混杂检测（纯函数）：其他批次的落地日落进本批测量范围且 campaign 相交（含账户级）。 */
function paidConfound(b, others) {
  for (const o of others) {
    if (o.taskId === b.taskId) continue;
    if (o.applied < b.win.before.start || o.applied > b.win.end) continue;
    if (!b.campaignIds.length || !o.campaignIds.length) return '与批次 #' + o.taskId + '（' + o.applied + '）窗口重叠且有账户级口径';
    if (o.campaignIds.some((c) => b.campaignIds.indexOf(c) !== -1)) return '与批次 #' + o.taskId + '（' + o.applied + '）同 campaign 且窗口重叠';
  }
  return '';
}

/** paid 侧主流程：抠批次、归因、混杂检测、到窗测量，结果并进同一 store。 */
function runPaid(customerId, tasks, store) {
  const raw = tasks.map(extractPaidBatch).filter(Boolean);
  if (!raw.length) return [];
  const batches = raw.map((b) => {
    let campaignIds = [];
    try { campaignIds = paidCampaignsFor(customerId, b); } catch (e) { /* 归因失败按账户级走 */ }
    return { ...b, campaignIds, win: paidWindow(b.klass, b.applied) };
  });
  const out = [];
  for (const b of batches) {
    if (!FORCE && store[b.taskId]) continue;
    if (b.win.ready_at > today) { out.push({ ...b, channel: 'paid', status: 'waiting', ready_at: b.win.ready_at }); continue; }
    const conf = paidConfound(b, batches);
    const base = {
      taskId: b.taskId, title: b.title, applied: b.applied, channel: 'paid', klass: b.klass,
      scope: b.campaignIds.length ? 'campaign' : 'account', campaigns: b.campaignIds,
      window_days: b.win.winLen, before_window: b.win.before, after_window: { start: b.win.start, end: b.win.end },
      measured_at: today,
    };
    if (conf) {
      const row = { ...base, status: 'confounded', why: conf };
      store[b.taskId] = row; out.push(row); continue;
    }
    const before = paidMetrics(customerId, b.campaignIds, b.win.before.start, b.win.before.end);
    const after = paidMetrics(customerId, b.campaignIds, b.win.start, b.win.end);
    const v = paidVerdict(b.klass, before, after);
    const row = {
      ...base, before, after,
      delta: {
        cost_pct: pctDelta(after.cost, before.cost),
        cpa_pct: (before.cpa != null && after.cpa != null) ? pctDelta(after.cpa, before.cpa) : null,
        ctr_pp: +(after.ctr - before.ctr).toFixed(2),
        conversions: +(after.conversions - before.conversions).toFixed(1),
      },
      verdict: v.verdict, status: v.status, why: v.why,
    };
    store[b.taskId] = row; out.push(row);
  }
  return out;
}

async function runClient(cid) {
  const context = await api.getContext(cid);
  const profile = context && context.profile;
  if (!profile) { log('client ' + cid + ': 无 profile，跳过'); return []; }
  const property = profile.gsc_property || profile.gsc_site;
  const name = (context.client && context.client.name) || profile.workspace_dir || cid;
  const ws = path.join(cfg.workspaceRoot, profile.workspace_dir || String(cid));
  const jsonFile = path.join(ws, 'notes', 'cohort_results.json');
  const mdFile = path.join(ws, 'notes', 'cohort_results.md');
  let store = {};
  try { store = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); } catch (e) { /* 首次 */ }

  const out = [];
  /* SEO 侧（GSC 页级，需 property）；paid 侧在下方独立跑，互不挡路 */
  const batches = property ? (context.tasks || []).map(extractBatch).filter(Boolean) : [];
  if (!property) log(name + ': 无 gsc_property，SEO 侧跳过');
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
  /* paid 侧（2026-10-27 接线，W18 Gate C 欠账）：需 profile.ads_customer_id */
  const adsCid = String(profile.ads_customer_id || '').replace(/-/g, '');
  if (adsCid) {
    try { out.push(...runPaid(adsCid, context.tasks || [], store)); }
    catch (e) { log(name + ' paid 回测失败：' + String(e.message || e).slice(0, 200)); }
  }
  if (Object.keys(store).length) {
    fs.mkdirSync(path.dirname(jsonFile), { recursive: true });
    fs.writeFileSync(jsonFile, JSON.stringify(store, null, 2));
    const lines = ['# 批次回测台账（cohort_backtest 自动生成，勿手编）', ''];
    for (const r of Object.values(store).sort((a, z) => String(a.applied).localeCompare(String(z.applied)))) {
      if (r.channel === 'paid') {
        if (r.status === 'waiting') continue;
        lines.push('## #' + r.taskId + ' ' + r.title + '（paid ' + r.klass + '，落地 ' + r.applied + '，测于 ' + r.measured_at + '）');
        if (r.status !== 'measured') { lines.push('- ' + r.status + '：' + (r.why || '')); lines.push(''); continue; }
        lines.push('- 口径 ' + r.scope + '（campaign ' + (r.campaigns || []).join('、') + '），前后各 ' + r.window_days + ' 天' + (r.klass === 'learn' ? '（后窗跳过 7 天学习期）' : ''));
        lines.push('- 花费 ' + r.before.cost + ' 到 ' + r.after.cost + '（' + (r.delta.cost_pct == null ? 'n/a' : r.delta.cost_pct + '%') + '），转化 ' + r.before.conversions + ' 到 ' + r.after.conversions + '，CPA ' + (r.before.cpa ?? '无') + ' 到 ' + (r.after.cpa ?? '无') + '，CTR ' + r.before.ctr + '% 到 ' + r.after.ctr + '%');
        lines.push('- 判读：' + (r.verdict || '无') + '（' + r.why + '）');
        lines.push('');
        continue;
      }
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

async function main() {
  ensureCtx();
  if (!ids.length) {
    const b = await api.req('GET', '/board');
    ids = (b.clients || []).map((c) => c.client_id);
    log('未传 client_id，取全量 active 共 ' + ids.length + ' 家');
  }
  const all = [];
  for (const cid of ids) {
    try { all.push(...await runClient(cid)); }
    catch (e) { log('client ' + cid + ' 回测失败：' + e.message); }
  }
  const measured = all.filter((r) => r.status === 'measured');
  const waiting = all.filter((r) => r.status === 'waiting');
  const skipped = all.filter((r) => r.status === 'low_volume' || r.status === 'confounded');
  console.log('\n# 回测 digest ' + today);
  for (const r of measured) {
    if (r.channel === 'paid') {
      console.log('- ' + r.client + ' #' + r.taskId + '（paid ' + r.klass + '）：' + (r.verdict || '无') + '，' + r.why + '（' + r.scope + '）');
    } else {
      console.log('- ' + r.client + ' #' + r.taskId + '：点击 ' + (r.delta.clicks >= 0 ? '+' : '') + r.delta.clicks + '，CTR ' + (r.delta.ctr_pp >= 0 ? '+' : '') + r.delta.ctr_pp + 'pp，位次' + (r.delta.position != null ? (r.delta.position >= 0 ? '提升 ' : '下滑 ') + Math.abs(r.delta.position) : '无数据') + '（' + r.urls.length + ' 页）');
    }
  }
  if (skipped.length) {
    console.log('不出结论 ' + skipped.length + ' 批（低量/混杂，宁可少标不硬归因）：' + skipped.map((r) => r.client + '#' + r.taskId + '(' + r.status + ')').join('、'));
  }
  if (waiting.length) {
    console.log('测量窗未满 ' + waiting.length + ' 批：' + waiting.map((r) => r.client + '#' + r.taskId + '(' + r.ready_at + ')').join('、'));
  }
  if (!measured.length && !waiting.length && !skipped.length) console.log('没有可回测的批次');
}

if (require.main === module) {
  main().catch((e) => { console.error('cohort_backtest 中止：' + e.message); process.exit(1); });
}

module.exports = {
  paidOpsClass, paidWindow, extractPaidBatch, paidVerdict, paidConfound, pctDelta,
  _setGaql(fn) { runGaql = fn; },
};
