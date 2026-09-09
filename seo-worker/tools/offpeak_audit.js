#!/usr/bin/env node
'use strict';
// 夜间审计批（2026-09-09 Alvin 定：审计类扫描不占工作时段，onboard 只做取数与方向）。
// 找出没有 discover 摸底（或 dossier 过期）的活跃客户，串行跑 discover，一晚清一批。
// 触发语义：由人（Aira）在闲时窗口显式起跑，不是 cron 自燃；跑批本身是人按下的那一下。
//   SEO_AGENT_TOKEN=<admin jwt> node tools/offpeak_audit.js --scan          列出待审计客户，不跑
//   SEO_AGENT_TOKEN=<admin jwt> node tools/offpeak_audit.js --run [n]      跑最多 n 个（默认 3）
//   SEO_AGENT_TOKEN=<admin jwt> node tools/offpeak_audit.js <cid> [cid..]  点名跑
const API = process.env.SEO_API_BASE || 'https://always.horntech-dev.com/seo-api.php';
const TOKEN = process.env.SEO_AGENT_TOKEN || '';
if (!TOKEN) { console.error('缺 SEO_AGENT_TOKEN'); process.exit(2); }

async function call(method, p, body) {
  const r = await fetch(API + p, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = { raw: t.slice(0, 200) }; }
  if (!r.ok) throw new Error(method + ' ' + p + ' -> ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);

async function pending() {
  const clients = (await call('GET', '/clients')).clients || [];
  const out = [];
  for (const c of clients) {
    const cid = c.client_id || c.id;
    if (!cid) continue;
    const services = String(c.services || '');
    if (services && services !== 'seo' && services !== 'both') continue;
    const jobs = (await call('GET', '/jobs?client_id=' + cid)).jobs || [];
    const disc = jobs.filter((j) => j.type === 'discover' && j.status === 'done');
    if (!disc.length) { out.push({ cid, name: c.name, why: '从未摸底' }); continue; }
    const last = disc[0].finished_at || disc[0].created_at || '';
    const ageDays = last ? (Date.now() - Date.parse(String(last).replace(' ', 'T'))) / 86400000 : 999;
    if (ageDays > 90) out.push({ cid, name: c.name, why: 'dossier ' + Math.round(ageDays) + ' 天前，过期' });
  }
  return out;
}

async function runOne(cid) {
  const d = await call('POST', '/jobs', { client_id: cid, type: 'discover', payload: {} });
  const jid = d.job_id || d.id || (d.job && d.job.id);
  console.log(ts() + ' client ' + cid + ' discover -> job #' + jid);
  const t0 = Date.now();
  for (;;) {
    await sleep(30000);
    const j = (await call('GET', '/jobs/' + jid)).job || {};
    if (j.status === 'done') { console.log(ts() + ' job #' + jid + ' done'); return true; }
    if (j.status === 'failed') { console.log(ts() + ' job #' + jid + ' FAILED，跳过该客户继续下一个'); return false; }
    if ((Date.now() - t0) / 1000 > 50 * 60) { console.log(ts() + ' job #' + jid + ' 超 50 分钟，停批查原因'); process.exit(1); }
  }
}

(async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--scan') {
    const list = await pending();
    if (!list.length) return console.log('没有待审计客户，收工');
    for (const p of list) console.log(p.cid + '\t' + p.name + '\t' + p.why);
    return;
  }
  let ids;
  if (args[0] === '--run') {
    const n = parseInt(args[1], 10) || 3;
    ids = (await pending()).slice(0, n).map((p) => p.cid);
  } else {
    ids = args.map((a) => parseInt(a, 10)).filter(Boolean);
  }
  if (!ids.length) { console.log('没有要跑的客户（--scan 看清单）'); return; }
  console.log(ts() + ' 夜间审计批：' + ids.join(', '));
  for (const cid of ids) await runOne(cid);
  console.log(ts() + ' 批次结束');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
