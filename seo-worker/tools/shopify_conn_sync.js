#!/usr/bin/env node
'use strict';
// shopify_conn_sync.js — 平台接入状态进事实源（2026-10-24 修 1，Alvin 批）。
// 零 LLM：读 shopify-manager 店清单机器版 roster.json，把每个 Shopify 客户的接入状态写成
// fact `platform.shopify.connected`。拆单三问第二问（scope 授了吗）从此有单一事实源可读，
// 「token/scope 未核实无法判定」不再是排人的合法理由（Oak 七张拆单的教训）。
// 用法：SEO_AGENT_TOKEN=<admin jwt> node tools/shopify_conn_sync.js [--dry]
// 挂 weekly_pull.sh 随周日取数同跑；roster 路径可用 SPM_ROSTER 覆盖（NFS 单源，规矩 8③）。

const fs = require('fs');
const API = process.env.SEO_API_BASE || 'https://always.horntech-dev.com/seo-api.php';
const TOKEN = process.env.SEO_AGENT_TOKEN || '';
const ROSTER = process.env.SPM_ROSTER || '/data/aira/projects/MA/shopify-manager/stores/roster.json';
const DRY = process.argv.includes('--dry');
if (!TOKEN) { console.error('用法：SEO_AGENT_TOKEN=... node tools/shopify_conn_sync.js [--dry]'); process.exit(2); }

const norm = (d) => String(d || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');

async function call(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(method + ' ' + path + ' -> ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return res.json();
}

(async () => {
  const roster = JSON.parse(fs.readFileSync(ROSTER, 'utf8'));
  const byDomain = new Map();
  for (const s of roster.stores || []) if (s.domain) byDomain.set(norm(s.domain), s);
  const clientsRaw = await call('GET', '/clients');
  const clients = Array.isArray(clientsRaw) ? clientsRaw : (clientsRaw.clients || clientsRaw.rows || []);
  const today = new Date().toISOString().slice(0, 10);
  let n = 0;
  for (const c of clients) {
    if (String(c.platform || '').toLowerCase() !== 'shopify' || c.status !== 'active') continue;
    const e = byDomain.get(norm(c.domain));
    const value = e
      ? (e.status === 'connected'
        ? 'true shop=' + e.shop + '（' + (e.note || 'shpca 永久') + '，roster 同步 ' + today + '）'
        : 'false 待装：' + (e.note || '见 shopify-manager 店清单') + '（roster 同步 ' + today + '）')
      : 'false 不在 shopify-manager 店清单，未接入（roster 同步 ' + today + '）';
    if (DRY) { console.log('[dry]', c.client_id, c.name, '->', value); continue; }
    await call('POST', '/facts', { client_id: c.client_id, fact_key: 'platform.shopify.connected', value, source: 'agent' });
    console.log('fact 写入', c.client_id, c.name, '->', value.slice(0, 80));
    n++;
  }
  console.log('同步完成：' + n + ' 个客户');
})().catch((e) => { console.error('同步失败：' + e.message); process.exit(1); });
