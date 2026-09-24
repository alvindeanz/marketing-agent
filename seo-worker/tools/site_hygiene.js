#!/usr/bin/env node
'use strict';
// site_hygiene：收录与 sitemap 卫生周检（刀1，2026-09-24 Alvin 批：卫生活划出 LLM 任务域，
// 归零模型巡检域，规划层不再为它立 sprint 任务）。零 LLM，只报告不修不建任务。
// 两项检查：
//   1. sitemap 杂项：URL 路径带非页面扩展名（.md/.txt/.json/.xml 等混进 urlset，
//      sungait agents.md 实证），顺手 curl 确认是否在线（cap 10 条）
//   2. 收录差集：sitemap URL 里近 90 天 GSC 页级零曝光的集合（cap 展示 20 条），
//      只给数与清单，值不值得动作由人看周报时定
// 结果落客户工作区 notes/site_hygiene.md（含 json 块），控制台打船队 digest。
// GSC 已知坑照抄 cohort_backtest：页级 dimensions=['page'] 一把抓，不用 page 过滤器；
// 右端压到 today-3。sitemap 抓取带浏览器 UA（WF 站 WAF 挡默认 UA）。
//
// 用法：SEO_WORKER_CONFIG=/data/aira/seo-worker/config.json node tools/site_hygiene.js <cid...>
// cron：周一 cron 家族（live_audit 18:00 / cohort 18:30 之后，19:00）。

const fs = require('node:fs');
const path = require('node:path');
const cfgLib = require('../lib/config');
const { Api } = require('../lib/api');
const { googlePost } = require('../lib/google');

const GSC_SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const PAGE_EXT_OK = new Set(['', 'html', 'htm']);
const MAX_CHILD_SITEMAPS = 20;
const MAX_URLS = 20000;
const GSC_WINDOW_DAYS = 90;
const LAG_DAYS = 3;

const argv = process.argv.slice(2);
const ids = argv.filter((a) => /^\d+$/.test(a)).map(Number);
if (!ids.length) { console.error('用法：node tools/site_hygiene.js <client_id...>'); process.exit(2); }

const cfg = cfgLib.load();
const api = new Api(cfg);
const log = (m) => console.log(m);
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const today = ymd(new Date());

function normUrl(u) {
  try {
    const x = new URL(String(u).trim());
    let p = x.pathname;
    if (!p.endsWith('/')) p += '/';
    return x.origin.toLowerCase() + p;
  } catch (e) { return null; }
}

function extOf(u) {
  try {
    const p = new URL(u).pathname;
    const seg = p.split('/').pop() || '';
    const dot = seg.lastIndexOf('.');
    return dot === -1 ? '' : seg.slice(dot + 1).toLowerCase();
  } catch (e) { return ''; }
}

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
  return r.text();
}

function xmlLocs(xml, tag) {
  // <loc> 提取不上 XML 解析器：sitemap 的 loc 是纯文本节点，正则够用且零依赖
  const out = [];
  const re = new RegExp('<' + tag + '>\\s*<loc>([^<]+)</loc>', 'g');
  const plain = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
  let m;
  while ((m = plain.exec(xml))) out.push(m[1].trim());
  void re;
  return out;
}

/** 拉 sitemap（跟一层 sitemap index），返回 { urls, sources }。 */
async function fetchSitemap(domain) {
  const base = 'https://' + String(domain).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const rootXml = await fetchText(base + '/sitemap.xml');
  const isIndex = /<sitemapindex[\s>]/i.test(rootXml);
  const urls = [];
  const sources = [base + '/sitemap.xml'];
  if (!isIndex) {
    for (const u of xmlLocs(rootXml, 'url')) { urls.push(u); if (urls.length >= MAX_URLS) break; }
    return { urls, sources };
  }
  const children = xmlLocs(rootXml, 'sitemap').slice(0, MAX_CHILD_SITEMAPS);
  for (const c of children) {
    try {
      const xml = await fetchText(c);
      sources.push(c);
      for (const u of xmlLocs(xml, 'url')) { urls.push(u); if (urls.length >= MAX_URLS) break; }
    } catch (e) { log('  子 sitemap 拉取失败 ' + c + ' :: ' + e.message); }
    if (urls.length >= MAX_URLS) break;
  }
  return { urls, sources };
}

async function gscPages(property, start, end) {
  const url = 'https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(property) + '/searchAnalytics/query';
  const res = await googlePost(cfg.ga4KeyFile, GSC_SCOPES, url, {
    startDate: start, endDate: end, dimensions: ['page'], rowLimit: 25000,
  }, cfg.httpTimeoutMs);
  const set = new Set();
  for (const r of (res && res.rows) || []) {
    const k = normUrl((r.keys || [])[0]);
    if (k) set.add(k);
  }
  return set;
}

async function headStatus(url) {
  try {
    const r = await fetch(url, { method: 'GET', headers: { 'user-agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    return r.status;
  } catch (e) { return 0; }
}

async function runClient(cid) {
  const context = await api.getContext(cid);
  const profile = context && context.profile;
  const name = (context && context.client && context.client.name) || cid;
  if (!profile) { log(name + ': 无 profile，跳过'); return null; }
  const domain = String(profile.domain || '').trim();
  const property = profile.gsc_property || profile.gsc_site;
  if (!domain) { log(name + ': 无 domain，跳过'); return null; }

  let sm;
  try { sm = await fetchSitemap(domain); } catch (e) { log(name + ': sitemap 拉取失败 :: ' + e.message); return { cid, name, error: 'sitemap: ' + e.message }; }
  const urls = [...new Set(sm.urls)];

  // 1. sitemap 杂项
  const junk = [];
  for (const u of urls) {
    const ext = extOf(u);
    if (!PAGE_EXT_OK.has(ext)) junk.push({ url: u, ext });
  }
  for (const j of junk.slice(0, 10)) j.status = await headStatus(j.url);

  // 2. 收录差集（近 90 天页级零曝光）
  let zero = null;
  if (property) {
    try {
      const end = addDays(today, -LAG_DAYS);
      const start = addDays(end, -(GSC_WINDOW_DAYS - 1));
      const seen = await gscPages(property, start, end);
      const misses = urls.map(normUrl).filter(Boolean).filter((u) => !seen.has(u));
      zero = { window: start + ' 至 ' + end, count: misses.length, total: urls.length, sample: misses.slice(0, 20) };
    } catch (e) { log(name + ': GSC 差集失败 :: ' + e.message); }
  }

  const row = { cid, name, checked_at: today, sitemap_urls: urls.length, sources: sm.sources.length, junk, zero_impression: zero };
  const ws = path.join(cfg.workspaceRoot, profile.workspace_dir || String(cid));
  try {
    const mdFile = path.join(ws, 'notes', 'site_hygiene.md');
    fs.mkdirSync(path.dirname(mdFile), { recursive: true });
    const lines = ['# 站点卫生周检（site_hygiene 自动生成，勿手编）', '', '检查日 ' + today + '，sitemap ' + urls.length + ' 条 URL（' + sm.sources.length + ' 个文件）', ''];
    lines.push('## sitemap 杂项（非页面扩展名）');
    if (!junk.length) lines.push('- 无');
    for (const j of junk) lines.push('- ' + j.url + '（.' + j.ext + (j.status !== undefined ? '，HTTP ' + j.status : '') + '）');
    lines.push('');
    if (zero) {
      lines.push('## 近 90 天零曝光页（' + zero.window + '）');
      lines.push('- ' + zero.count + ' / ' + zero.total + ' 条 sitemap URL 在 GSC 页级报表无任何曝光行');
      for (const u of zero.sample) lines.push('  - ' + u);
      if (zero.count > zero.sample.length) lines.push('  - （其余 ' + (zero.count - zero.sample.length) + ' 条略）');
    } else {
      lines.push('## 近 90 天零曝光页', '- 本轮未取到 GSC 数据');
    }
    lines.push('', 'json: ```' + JSON.stringify(row) + '```', '');
    fs.writeFileSync(mdFile, lines.join('\n'));
  } catch (e) { log(name + ': 台账写入失败 :: ' + e.message); }
  return row;
}

(async () => {
  const digest = [];
  for (const cid of ids) {
    try {
      const r = await runClient(cid);
      if (!r) continue;
      if (r.error) { digest.push(r.name + ': ' + r.error); continue; }
      const parts = [r.name + ': sitemap ' + r.sitemap_urls];
      if (r.junk.length) parts.push('杂项 ' + r.junk.length + ' 条（' + r.junk.slice(0, 3).map((j) => j.url.split('/').pop()).join('、') + (r.junk.length > 3 ? ' 等' : '') + '）');
      if (r.zero_impression) parts.push('零曝光 ' + r.zero_impression.count + '/' + r.zero_impression.total);
      digest.push(parts.join('，') + (r.junk.length ? '  <- 有杂项' : ''));
    } catch (e) {
      digest.push('client ' + cid + ': ' + e.message);
    }
  }
  console.log('\n===== site_hygiene digest ' + today + ' =====');
  for (const d of digest) console.log(d);
})();
