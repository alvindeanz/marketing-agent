#!/usr/bin/env node
'use strict';
/**
 * Shopify 博客任务卡片链接全船队对齐（2026-09-22 sungait #619）。零模型，幂等。
 * 已发布 = 正式链接；草稿 = Shopify admin 文章页（后台预览）。
 *
 * 用法：SEO_WORKER_CONFIG=/data/aira/seo-worker/config.json node tools/shopify_link_sync.js [cid...]
 *   不给 cid 时现查 /clients 取 platform=Shopify 的 active 客户（不用手抄名单，DEFECTS 2026-09-22）。
 * cron（ros，root，UTC，每小时第 17 分）：
 *   17 * * * * cd /data/aira/projects/MA/marketing-agent/seo-worker && SEO_WORKER_CONFIG=/data/aira/seo-worker/config.json node tools/shopify_link_sync.js >> /data/aira/seo-worker/logs/shopify_link_sync.log 2>&1
 *   （tools 不在部署白名单里，从仓库跑，和 weekly_pull.sh 同套路）
 * 零模型不违反硬规矩 1；多 worker 同跑也安全（读平台 -> 值不同才写）。
 */
const { Api } = require('../lib/api');
const cfg = require('../lib/config').load();
const shopifylink = require('../lib/shopifylink');

async function main() {
  const api = new Api(cfg);
  const argIds = process.argv.slice(2).filter((a) => /^\d+$/.test(a)).map(Number);
  const clientsRes = await api.req('GET', '/clients');
  const rows = Array.isArray(clientsRes) ? clientsRes : (clientsRes.clients || []);
  const targets = rows.filter((c) => /shopify/i.test(String(c.platform || '')) && String(c.status || 'active') === 'active'
    && (!argIds.length || argIds.includes(Number(c.client_id))));
  const stamp = new Date().toISOString();
  let total = 0;
  for (const c of targets) {
    const cid = Number(c.client_id);
    try {
      const pr = await api.req('GET', '/profile?client_id=' + cid);
      const profile = (pr && (pr.profile || pr)) || {};
      const r = await shopifylink.syncClientLinks(api, cid, profile, (m) => console.log(stamp + ' [' + cid + ' ' + c.name + '] ' + m));
      total += r.changed || 0;
      console.log(stamp + ' [' + cid + ' ' + c.name + '] 核对 ' + r.checked + '，更新 ' + r.changed + (r.skipped ? '（' + r.skipped + '）' : ''));
    } catch (e) {
      console.log(stamp + ' [' + cid + ' ' + c.name + '] 失败 :: ' + e.message);
    }
  }
  console.log(stamp + ' 完成：' + targets.length + ' 家 Shopify 客户，更新 ' + total + ' 个链接');
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
