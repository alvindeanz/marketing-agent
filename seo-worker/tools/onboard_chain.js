#!/usr/bin/env node
'use strict';
// 导入后的 job 链：pull_data -> backfill_metrics -> discover -> plan，一步 done 才起下一步，失败即停。
//   SEO_AGENT_TOKEN=<admin jwt> node tools/onboard_chain.js <client_id> [起点类型]
// 每一步都是这次人（我）在命令行触发的，不是 cron；链只是替我按顺序点四次按钮。
const API = process.env.SEO_API_BASE || 'https://always.horntech-dev.com/seo-api.php';
const TOKEN = process.env.SEO_AGENT_TOKEN || '';
const cid = parseInt(process.argv[2], 10);
const start = process.argv[3] || 'pull_data';
const CHAIN = ['pull_data', 'backfill_metrics', 'discover', 'plan'];
if (!cid || !TOKEN) { console.error('用法：SEO_AGENT_TOKEN=... onboard_chain.js <client_id> [pull_data|backfill_metrics|discover|plan]'); process.exit(2); }

async function call(method, p, body) {
  const r = await fetch(API + p, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = { raw: t.slice(0, 200) }; }
  if (!r.ok) throw new Error(method + ' ' + p + ' -> ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

async function runStep(type) {
  const payload = type === 'pull_data' ? { fresh: true } : {};
  const d = await call('POST', '/jobs', { client_id: cid, type, payload });
  const jid = d.job_id || d.id || (d.job && d.job.id);
  console.log(ts() + ' client ' + cid + ' ' + type + ' -> job #' + jid);
  if (!jid) throw new Error('没拿到 job id：' + JSON.stringify(d).slice(0, 200));
  const budget = type === 'plan' || type === 'discover' ? 45 * 60 : 20 * 60;
  const t0 = Date.now();
  for (;;) {
    await sleep(20000);
    const j = (await call('GET', '/jobs/' + jid)).job || {};
    if (j.status === 'done') { console.log(ts() + ' job #' + jid + ' done'); return; }
    if (j.status === 'failed') {
      const log = String(j.log_text || '').split('\n').slice(-12).join('\n');
      throw new Error(type + ' job #' + jid + ' failed：\n' + log);
    }
    if ((Date.now() - t0) / 1000 > budget) throw new Error(type + ' job #' + jid + ' 超过 ' + budget / 60 + ' 分钟仍是 ' + j.status);
  }
}
(async () => {
  for (const type of CHAIN.slice(CHAIN.indexOf(start))) await runStep(type);
  console.log(ts() + ' client ' + cid + ' 链跑完，去看板看 plan draft');
})().catch((e) => { console.error(ts() + ' 链中止：' + e.message); process.exit(1); });
