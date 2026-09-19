#!/usr/bin/env node
'use strict';
// 博客选题缺口拉取（零 LLM，通用化自 sunseeker/badger 2026-09-10 版）。
// 用法：node tools/blog_topic_gaps.js <slug> [--window 2026-06-11,2026-09-08]
// 输入：/data/aira/clients/<slug>/notes/topic_kw.json  { "site": "https://.../", "keywords": ["kw", ...] }
// 输出：/data/aira/clients/<slug>/notes/topic_gaps_<今天>.json
//   每词：近窗全站 曝光/点击/位次 + 承接页 top3。零展现或深位词就是选题该打的缺口。
const fs = require('fs');
const { JWT } = require('google-auth-library');

const slug = String(process.argv[2] || '');
if (!slug) { console.error('用法：node tools/blog_topic_gaps.js <slug> [--window from,to]'); process.exit(2); }
const wi = process.argv.indexOf('--window');
const WIN = wi > -1 ? String(process.argv[wi + 1]).split(',') : (() => {
  const to = new Date(Date.now() - 3 * 86400000); // GSC 尾部 3 天不稳，窗口右缘退避
  const from = new Date(to.getTime() - 90 * 86400000);
  const f = (d) => d.toISOString().slice(0, 10);
  return [f(from), f(to)];
})();

const base = `/data/aira/clients/${slug}`;
const cfgPath = `${base}/notes/topic_kw.json`;
if (!fs.existsSync(cfgPath)) { console.error(`缺 ${cfgPath}（{"site":"https://.../","keywords":[...]}）`); process.exit(2); }
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
if (!cfg.site || !Array.isArray(cfg.keywords) || !cfg.keywords.length) { console.error('topic_kw.json 需要 site 与非空 keywords'); process.exit(2); }

async function gPost(url, H, body, tries = 5) {
  for (let i = 1; i <= tries; i++) {
    const r = await fetch(url, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
    if (r.ok) return d;
    if (i === tries || (r.status < 500 && r.status !== 429)) { const e = new Error('HTTP ' + r.status); e.data = d; throw e; }
    await new Promise((z) => setTimeout(z, 2000 * i));
  }
}

(async () => {
  const key = JSON.parse(fs.readFileSync('/data/aira/config/aiden_ga4_api.json', 'utf8'));
  const c = new JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] });
  const tok = (await c.authorize()).access_token; const H = { Authorization: 'Bearer ' + tok };
  const url = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(cfg.site)}/searchAnalytics/query`;
  const res = {};
  for (const kw of cfg.keywords) {
    const q = await gPost(url, H, { startDate: WIN[0], endDate: WIN[1], dimensions: ['query'],
      dimensionFilterGroups: [{ filters: [{ dimension: 'query', operator: 'equals', expression: kw }] }], rowLimit: 1 });
    const row = (q.rows || [])[0];
    if (!row) { res[kw] = { impr: 0, clicks: 0, pos: null, owner: null }; continue; }
    const p = await gPost(url, H, { startDate: WIN[0], endDate: WIN[1], dimensions: ['page'],
      dimensionFilterGroups: [{ filters: [{ dimension: 'query', operator: 'equals', expression: kw }] }], rowLimit: 3 });
    res[kw] = { clicks: row.clicks, impr: row.impressions, ctr: +(row.ctr * 100).toFixed(2), pos: +row.position.toFixed(1),
      owner: (p.rows || []).map((x) => ({ p: x.keys[0].replace(cfg.site.slice(0, -1), ''), clicks: x.clicks, impr: x.impressions, pos: +x.position.toFixed(1) })) };
  }
  const out = { slug, site: cfg.site, window: WIN, sites: { [slug]: res } };
  const path = `${base}/notes/topic_gaps_${new Date().toISOString().slice(0, 10)}.json`;
  fs.writeFileSync(path, JSON.stringify(out, null, 2));
  const zero = Object.values(res).filter((v) => !v.impr).length;
  console.error(`${slug}: ${cfg.keywords.length} 词，零展现 ${zero}，窗口 ${WIN.join(' 至 ')}`);
  console.log(path);
})().catch((e) => { console.error('ERR', e.message, JSON.stringify(e.data || '')); process.exit(1); });
