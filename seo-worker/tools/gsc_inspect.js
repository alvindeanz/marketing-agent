#!/usr/bin/env node
'use strict';
// gsc_inspect：URL Inspection API 批查收录与富结果状态（ticket #59 Summer 提报，Alvin 批 2026-11-09）。
// 零 LLM 零依赖，全程只读 scope，人触发的 CLI，不是 job 类型。
//
// 回答两件事：这页被 Google 重新抓了没（lastCrawlTime / coverageState），
// 结构化数据还报不报错（richResultsResult 的 verdict 与逐项 issues）。
// 配额：每资源每天 2000 次、每分钟 600 次（官方口径），这里节流 300ms 一发，怎么跑都撞不上。
// 逐页「请求编入索引」「验证修复」Google 没开 API，这工具做不了，也别来加。
//
// 用法：
//   SEO_WORKER_CONFIG=/data/aira/seo-worker/config.json node tools/gsc_inspect.js <client_id> [URL 来源] [--save]
//   URL 来源三选一：
//     直接跟在参数里的完整 URL（可多个）
//     --urls-file <文件>      一行一个 URL
//     --from-sitemap <子串>   拉线上 sitemap（跟一层 index），取 loc 含该子串的 URL
//                             Shopify 商品页就是 --from-sitemap /products/
//   --site <property> 绕开看板直接指定资源（URL 来源仍必填）。
//   --save 把结果落客户工作区 notes/gsc_inspect_<日期>.md（需要 client_id）。

const fs = require('node:fs');
const path = require('node:path');
const cfgLib = require('../lib/config');
const { Api } = require('../lib/api');
const { getAccessToken } = require('../lib/google');
const { requestJson, request } = require('../lib/http');

const SCOPE_RO = ['https://www.googleapis.com/auth/webmasters.readonly'];
const INSPECT_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
// sitemap 抓取带浏览器 UA（WF 站 WAF 挡默认 UA，照抄 site_hygiene）
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const MAX_CHILD_SITEMAPS = 20;
const MAX_URLS = 500; // 单次批查上限，再多就该分批跑
const THROTTLE_MS = 300;

function usageDie(msg) {
  if (msg) console.error(msg);
  console.error('用法：node tools/gsc_inspect.js <client_id> [url ...] [--urls-file f] [--from-sitemap 子串] [--site property] [--save]');
  process.exit(1);
}

function parseArgs(argv) {
  const out = { cid: 0, site: '', urls: [], urlsFile: '', fromSitemap: '', save: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--urls-file') out.urlsFile = String(argv[++i] || '');
    else if (a === '--from-sitemap') out.fromSitemap = String(argv[++i] || '');
    else if (a === '--site') out.site = String(argv[++i] || '');
    else if (a === '--save') out.save = true;
    else if (/^https?:\/\//.test(a)) out.urls.push(a);
    else if (/^\d+$/.test(a)) out.cid = Number(a);
    else usageDie('不认识的参数：' + a);
  }
  if (!out.cid && !out.site) usageDie();
  return out;
}

async function fetchText(url) {
  const r = await request(url, { headers: { 'User-Agent': UA }, timeoutMs: 30000 });
  if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status + ' GET ' + url);
  return r.text || '';
}

// <loc> 提取不上 XML 解析器：loc 是纯文本节点，正则够用且零依赖（同 site_hygiene）
function xmlLocs(xml, parent) {
  const re = new RegExp('<' + parent + '[\\s>][\\s\\S]*?<loc>\\s*([^<]+?)\\s*</loc>', 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

async function urlsFromSitemap(origin, needle) {
  const rootUrl = origin.replace(/\/?$/, '/') + 'sitemap.xml';
  const rootXml = await fetchText(rootUrl);
  let urls = [];
  if (/<sitemapindex[\s>]/i.test(rootXml)) {
    const children = xmlLocs(rootXml, 'sitemap').slice(0, MAX_CHILD_SITEMAPS);
    for (const c of children) {
      try {
        urls = urls.concat(xmlLocs(await fetchText(c), 'url'));
      } catch (e) {
        console.error('  子 sitemap 拉取失败 ' + c + ' :: ' + e.message);
      }
    }
  } else {
    urls = xmlLocs(rootXml, 'url');
  }
  return urls.filter((u) => u.includes(needle));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function summarize(r) {
  const idx = (r && r.indexStatusResult) || {};
  const rich = r && r.richResultsResult;
  const issues = [];
  if (rich) {
    for (const d of rich.detectedItems || []) {
      for (const item of d.items || []) {
        for (const it of item.issues || []) {
          issues.push((d.richResultType || '?') + ': ' + (it.issueMessage || '?') + ' [' + (it.severity || '?') + ']');
        }
      }
    }
  }
  return {
    verdict: idx.verdict || '?',
    coverage: idx.coverageState || '?',
    lastCrawl: idx.lastCrawlTime || '',
    richVerdict: rich ? rich.verdict || '?' : '无富结果',
    richTypes: rich ? (rich.detectedItems || []).map((d) => d.richResultType).join('+') : '',
    issues,
  };
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const cfg = cfgLib.load();

  let site = opt.site;
  let profile = null;
  if (opt.cid) {
    const ctx = await new Api(cfg).getContext(opt.cid);
    profile = (ctx && ctx.profile) || null;
    if (!site) site = profile && profile.gsc_property;
  }
  if (!site) throw new Error('定不出 GSC 资源：profile 没 gsc_property，用 --site 指定');

  let urls = opt.urls.slice();
  if (opt.urlsFile) {
    urls = urls.concat(
      fs.readFileSync(opt.urlsFile, 'utf8').split('\n').map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s))
    );
  }
  if (opt.fromSitemap) {
    const origin = site.startsWith('sc-domain:') ? 'https://' + site.slice('sc-domain:'.length) : site;
    urls = urls.concat(await urlsFromSitemap(origin, opt.fromSitemap));
  }
  urls = Array.from(new Set(urls));
  if (!urls.length) usageDie('没有要查的 URL');
  if (urls.length > MAX_URLS) throw new Error('一次 ' + urls.length + ' 条超过上限 ' + MAX_URLS + '，分批跑');

  console.log('GSC 资源：' + site + '，批查 ' + urls.length + ' 条');
  const token = await getAccessToken(cfg.ga4KeyFile, SCOPE_RO);

  const rows = [];
  const tally = { pass: 0, neutral: 0, fail: 0, other: 0, richIssues: 0 };
  for (const u of urls) {
    let s;
    try {
      const res = await requestJson(INSPECT_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inspectionUrl: u, siteUrl: site }),
        timeoutMs: 30000,
      });
      s = summarize(res && res.inspectionResult);
    } catch (e) {
      s = { verdict: 'ERROR', coverage: e.message.slice(0, 160), lastCrawl: '', richVerdict: '', richTypes: '', issues: [] };
    }
    rows.push({ url: u, ...s });
    if (s.verdict === 'PASS') tally.pass++;
    else if (s.verdict === 'NEUTRAL') tally.neutral++;
    else if (s.verdict === 'FAIL') tally.fail++;
    else tally.other++;
    if (s.issues.length) tally.richIssues++;
    const flag = s.verdict === 'PASS' && !s.issues.length ? 'ok ' : '!! ';
    console.log(flag + u);
    console.log('     ' + s.verdict + ' | ' + s.coverage + ' | 抓取 ' + (s.lastCrawl || '无') + ' | 富结果 ' + s.richVerdict + (s.richTypes ? ' (' + s.richTypes + ')' : ''));
    s.issues.forEach((x) => console.log('     issue: ' + x));
    await sleep(THROTTLE_MS);
  }

  console.log(
    '\n小结：PASS ' + tally.pass + ' / NEUTRAL ' + tally.neutral + ' / FAIL ' + tally.fail +
    ' / 其他 ' + tally.other + '，带富结果 issue 的页面 ' + tally.richIssues + ' 条'
  );

  if (opt.save) {
    if (!opt.cid || !profile) throw new Error('--save 需要 client_id（定位客户工作区）');
    const ws = path.join(cfg.workspaceRoot, profile.workspace_dir || String(opt.cid));
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(ws, 'notes', 'gsc_inspect_' + day + '.md');
    const lines = [
      '# GSC URL Inspection 批查 ' + day,
      '',
      '资源 ' + site + '，共 ' + rows.length + ' 条。PASS ' + tally.pass + '，富结果 issue ' + tally.richIssues + ' 条。工具 tools/gsc_inspect.js。',
      '',
      '| URL | verdict | coverage | lastCrawl | 富结果 | issues |',
      '|---|---|---|---|---|---|',
    ];
    for (const r of rows) {
      lines.push('| ' + r.url + ' | ' + r.verdict + ' | ' + r.coverage + ' | ' + (r.lastCrawl || '') + ' | ' + r.richVerdict + (r.richTypes ? ' ' + r.richTypes : '') + ' | ' + r.issues.join('; ') + ' |');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n') + '\n');
    console.log('已落盘 ' + file);
  }
}

main().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
