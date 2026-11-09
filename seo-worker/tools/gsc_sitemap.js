#!/usr/bin/env node
'use strict';
// gsc_sitemap：GSC sitemap 查看与重新提交（ticket #59 Summer 提报，Alvin 批 2026-11-09）。
// 零 LLM 零依赖，人触发的 CLI，不是 job 类型。
//
// submit 是 worker 全家唯一用可写 GSC scope 的地方：只做 PUT sitemaps 这一个动作，
// 取数链路（pull_data / metrics / site_hygiene 等）继续 webmasters.readonly 不动。
// 前提：服务账号在该 GSC 资源的权限是「完全」，受限（restricted）能列不能提。
// 提交后回读 lastSubmitted 对账，没见到新鲜时间戳就按失败报。
//
// 用法：
//   SEO_WORKER_CONFIG=/data/aira/seo-worker/config.json node tools/gsc_sitemap.js <client_id> [--submit] [--sitemap <url>]
//   资源取看板 profile.gsc_property；--site <property> 直接指定（presale 等没建档的场景）。
//   不带 --submit 只列现状。--sitemap 缺省为 <site>sitemap.xml。

const cfgLib = require('../lib/config');
const { Api } = require('../lib/api');
const { getAccessToken } = require('../lib/google');
const { requestJson } = require('../lib/http');

const SCOPE_RO = ['https://www.googleapis.com/auth/webmasters.readonly'];
const SCOPE_RW = ['https://www.googleapis.com/auth/webmasters'];
const API_BASE = 'https://www.googleapis.com/webmasters/v3/sites/';

function usageDie(msg) {
  if (msg) console.error(msg);
  console.error('用法：node tools/gsc_sitemap.js <client_id> [--submit] [--sitemap <url>] | --site <property> [--submit] [--sitemap <url>]');
  process.exit(1);
}

function parseArgs(argv) {
  const out = { cid: 0, site: '', sitemap: '', submit: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--submit') out.submit = true;
    else if (a === '--site') out.site = String(argv[++i] || '');
    else if (a === '--sitemap') out.sitemap = String(argv[++i] || '');
    else if (/^\d+$/.test(a)) out.cid = Number(a);
    else usageDie('不认识的参数：' + a);
  }
  if (!out.cid && !out.site) usageDie();
  return out;
}

async function listSitemaps(keyFile, site, scopes) {
  const token = await getAccessToken(keyFile, scopes);
  const res = await requestJson(API_BASE + encodeURIComponent(site) + '/sitemaps', {
    headers: { Authorization: 'Bearer ' + token },
    timeoutMs: 30000,
  });
  return (res && res.sitemap) || [];
}

function printEntry(s) {
  const counts = (s.contents || []).map((c) => c.type + ':' + (c.submitted || 0) + '提/' + (c.indexed || 0) + '收').join(' ');
  console.log(
    '  ' + s.path +
    '\n    lastSubmitted ' + (s.lastSubmitted || '无') +
    ' | lastDownloaded ' + (s.lastDownloaded || '无') +
    ' | errors ' + (s.errors || 0) + ' warnings ' + (s.warnings || 0) +
    (s.isPending ? ' | pending' : '') +
    (counts ? '\n    ' + counts : '')
  );
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const cfg = cfgLib.load();
  const keyFile = cfg.ga4KeyFile; // config.load() 已解析成绝对路径

  let site = opt.site;
  if (!site) {
    const api = new Api(cfg);
    const ctx = await api.getContext(opt.cid);
    site = ctx && ctx.profile && ctx.profile.gsc_property;
    if (!site) throw new Error('client ' + opt.cid + ' 的 profile 没有 gsc_property，用 --site 直接指定');
  }

  console.log('GSC 资源：' + site);
  const before = await listSitemaps(keyFile, site, SCOPE_RO);
  console.log('现挂 sitemap ' + before.length + ' 条：');
  before.forEach(printEntry);

  if (!opt.submit) return;

  const sitemapUrl = opt.sitemap || (site.startsWith('sc-domain:') ? '' : site.replace(/\/?$/, '/') + 'sitemap.xml');
  if (!sitemapUrl) throw new Error('sc-domain 资源推不出 sitemap 地址，用 --sitemap 指定完整 URL');

  console.log('\n提交：' + sitemapUrl);
  const token = await getAccessToken(keyFile, SCOPE_RW);
  await requestJson(API_BASE + encodeURIComponent(site) + '/sitemaps/' + encodeURIComponent(sitemapUrl), {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + token },
    timeoutMs: 30000,
  });

  // 回读对账：lastSubmitted 必须变新鲜，光看 PUT 的 2xx 不算数
  const after = await listSitemaps(keyFile, site, SCOPE_RO);
  const hit = after.find((s) => s.path === sitemapUrl);
  if (!hit || !hit.lastSubmitted) throw new Error('提交后回读没见到该 sitemap，按失败处理');
  const ageMs = Date.now() - new Date(hit.lastSubmitted).getTime();
  if (!(ageMs >= 0 && ageMs < 10 * 60 * 1000)) {
    throw new Error('回读 lastSubmitted=' + hit.lastSubmitted + ' 不新鲜，提交可能没生效');
  }
  console.log('回读对账通过，lastSubmitted ' + hit.lastSubmitted);
}

main().catch((e) => {
  console.error('失败：' + e.message);
  process.exit(1);
});
