#!/usr/bin/env node
'use strict';
// 导入后的 job 链：pull_data -> backfill_metrics -> discover -> plan -> plan_review（方案层过闸，自动接力），
// 一步 done 才起下一步，失败即停。跑完停在「方向确认卡」，人批准 v2 后用 tools/harness.js 接 S1。
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
  // 起跑前查工作区有没有 CLAUDE.md：worker 写稿与预览页的客户铁律只从这份文件读，
  // 没有它博客会在零品牌规则下生成（2026-08-29 benscurtainsnz #110 踩过）。
  const prof = await call('GET', '/profile?client_id=' + cid);
  const ws = (prof.profile && prof.profile.workspace_dir) || prof.workspace_dir || '';
  const wsPath = ws ? (ws.startsWith('/') ? ws : '/data/aira/clients/' + ws) : '';
  if (!wsPath || !require('fs').existsSync(require('path').join(wsPath, 'CLAUDE.md'))) {
    throw new Error('工作区 ' + (wsPath || '(profile 没填 workspace_dir)') + ' 缺 CLAUDE.md，先写客户铁律再导入');
  }
  for (const type of CHAIN.slice(CHAIN.indexOf(start))) await runStep(type);
  // plan 落任务后服务端自动排 plan_review（方案层过闸），这里只等它跑完并把确认卡打出来。
  console.log(ts() + ' client ' + cid + ' plan draft 已落，等方案层过闸（plan_review）');
  const t0 = Date.now();
  for (;;) {
    await sleep(20000);
    const jobs = (await call('GET', '/jobs?client_id=' + cid + '&limit=20')).jobs || [];
    const pr = jobs.find((j) => j.type === 'plan_review');
    if (!pr) { if (Date.now() - t0 > 120000) { console.log(ts() + ' 两分钟没看到 plan_review job，请查 /tasks/bulk 是否走了 plan_review 门'); break; } continue; }
    if (pr.status === 'done') {
      const log = String(pr.log_text || '');
      const i = log.indexOf('CARD\n');
      console.log(ts() + ' 方案层过闸完成，job #' + pr.id + '\n\n' + (i === -1 ? '(日志里没找到卡)' : log.slice(i + 5)));
      console.log('\n下一步：看板方案区批准 v2（= 确认方向），然后 SEO_AGENT_TOKEN=... node tools/harness.js ' + cid);
      break;
    }
    if (pr.status === 'failed') { console.log(ts() + ' plan_review job #' + pr.id + ' 失败：\n' + String(pr.log_text || '').split('\n').slice(-10).join('\n')); break; }
    if (Date.now() - t0 > 30 * 60 * 1000) { console.log(ts() + ' plan_review 超过 30 分钟仍是 ' + pr.status); break; }
  }
})().catch((e) => { console.error(ts() + ' 链中止：' + e.message); process.exit(1); });
