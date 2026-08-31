#!/usr/bin/env node
'use strict';
// W5 agent harness（2026-08-29 Alvin 定：人不再逐个点按钮）。
// 一个客户从「待拍板」跑到「待放行」：
//   1. 本期 sprint 里有 fable 判决且未过期的任务 → POST /tasks/apply_verdicts（do 排 execute，drop/merge/later 按判决收口）
//   2. 轮询 execute job；方案 lint 打回的任务重排一次（仅一次，且是这次人起跑授权的，不是 cron）
//   3. 队列空了收阻塞：执行失败两次 / 方案里「需要人定」段 / 待判（fable 没判）/ 判决过期 / 待人工验证项
//   4. 阻塞写回看板（任务 attention=1，note 尾部加 [harness] 段）并追加到 PJ 的 TODO.md 批注段
//   5. 打印放行卡链接清单，人只看卡点放行
// 用法：SEO_AGENT_TOKEN=<admin jwt> node tools/harness.js <client_id> [--dry] [--no-todo]
// 硬规矩不破：放行（apply）永远不在这里点；不做也不在这里判（drop 只按 fable 判决）。

const fs = require('fs');
const path = require('path');
const API = process.env.SEO_API_BASE || 'https://always.horntech-dev.com/seo-api.php';
const TOKEN = process.env.SEO_AGENT_TOKEN || '';
const TODO = process.env.MA_TODO || '/data/aira/projects/MA/memory/TODO.md';
const argv = process.argv.slice(2);
const cid = parseInt(argv[0], 10);
const DRY = argv.includes('--dry');
const NO_TODO = argv.includes('--no-todo');
const IDS = (() => { const i = argv.indexOf('--ids'); return i === -1 ? null : String(argv[i + 1] || '').split(',').map((x) => parseInt(x, 10)).filter(Boolean); })();
const POLL_MS = 45000;
const BUDGET_MS = 3 * 60 * 60 * 1000;
if (!cid || !TOKEN) { console.error('用法：SEO_AGENT_TOKEN=... node tools/harness.js <client_id> [--dry] [--no-todo]'); process.exit(2); }

const ts = () => new Date().toISOString().slice(11, 19);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(ts() + ' ' + m);

async function call(method, p, body) {
  const r = await fetch(API + p, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = { raw: t.slice(0, 200) }; }
  if (!r.ok) throw new Error(method + ' ' + p + ' -> ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  return j;
}
async function tasks() { const d = await call('GET', '/tasks?client_id=' + cid); return d.tasks || d; }
async function boardClient() {
  const b = await call('GET', '/board');
  return (b.clients || []).find((c) => Number(c.client_id) === cid) || null;
}

/* 从方案 note 里抠「需要人定」段：以该标题起，到下一个 ** 标题或 --- 为止 */
function humanDecisions(note) {
  const n = String(note || '');
  const m = n.match(/\*\*需要人定\*\*\s*([\s\S]*?)(?=\n\*\*|\n---|$)/);
  if (!m) return [];
  return m[1].split('\n').map((s) => s.trim()).filter((s) => /^\d+[.)]|^[-*]/.test(s)).map((s) => s.replace(/^(\d+[.)]|[-*])\s*/, ''));
}

async function main() {
  const bc = await boardClient();
  if (!bc) throw new Error('board 上没有 client ' + cid);
  const sprint = /^S/.test(String(bc.current_sprint)) ? String(bc.current_sprint) : 'S' + bc.current_sprint;
  log(`${bc.name}（${cid}）本期 ${sprint}` + (IDS ? '，只处理 #' + IDS.join(' #') : ''));
  /* --ids：跨 sprint 指定任务，本次运行把「本期」的口径换成这批 id */
  const inScope = (t) => (IDS ? IDS.includes(t.id) : t.sprint === sprint);

  // 0.5 本期还没有判决的任务（含 later 自动挪期后清了判决的）先排一轮闸A，判完再拍板。
  let all = await tasks();
  const noVerdict = all.filter((t) => inScope(t) && t.status === 'proposed'
    && !t.review_effective && !t.review_pending && !(t.job_state && t.job_state.status)).map((t) => t.id);
  if (noVerdict.length && !DRY) {
    const r = await call('POST', '/tasks/review', { client_id: cid, task_ids: noVerdict.slice(0, 20) });
    log('本期 ' + noVerdict.length + ' 条无判决，已排闸A（job ' + (r.job_id || '?') + '），等判定');
    const t1 = Date.now();
    for (;;) {
      await sleep(20000);
      all = await tasks();
      const pending = all.filter((t) => noVerdict.includes(t.id) && !t.review_effective);
      if (!pending.length) break;
      if (Date.now() - t1 > 15 * 60 * 1000) { log('判定超 15 分钟未齐，先拍已有判决的'); break; }
    }
  }

  // 1. 拍板：本期、有判决、未过期、还没动过的
  const verdictIds = all.filter((t) => inScope(t) && ['proposed', 'approved', 'blocked'].includes(t.status)
    && t.review_effective && !t.review_stale && !t.review_pending && !(t.job_state && t.job_state.status)
    && !(t.status === 'approved' && t.owner_type !== 'agent')).map((t) => t.id);
  if (verdictIds.length) {
    log('按判决处置 ' + verdictIds.length + ' 条：' + verdictIds.join(' '));
    if (!DRY) {
      const r = await call('POST', '/tasks/apply_verdicts', { client_id: cid, task_ids: verdictIds });
      log('apply_verdicts -> ' + JSON.stringify(r.done) + ' jobs ' + JSON.stringify(r.job_ids) + (r.skipped.length ? ' skipped ' + JSON.stringify(r.skipped) : ''));
    }
  } else log('没有可拍板的任务');
  if (DRY) { await report(await tasks(), sprint, {}); return; }

  // 2. 等 execute 跑完；lint 打回重排一次
  const retried = {};
  const t0 = Date.now();
  for (;;) {
    await sleep(POLL_MS);
    all = await tasks();
    const mine = all.filter(inScope);
    const running = mine.filter((t) => t.human_state === 'running');
    const lintFailed = mine.filter((t) => t.human_state === 'wait_me' && /lint 未过/.test(t.fail_reason || '') && !retried[t.id]);
    for (const t of lintFailed) {
      retried[t.id] = true;
      const r = await call('POST', '/tasks/' + t.id + '/decide', { yes: true, note: 'harness：方案 lint 打回，重出一次' });
      log('#' + t.id + ' lint 打回，重排 -> job ' + JSON.stringify(r.job_ids));
    }
    if (!running.length && !lintFailed.length) break;
    log('在跑 ' + running.map((t) => '#' + t.id + '(' + t.run_note + ')').join(' '));
    if (Date.now() - t0 > BUDGET_MS) { log('超过 3 小时预算，先收口'); break; }
  }
  await report(await tasks(), sprint, retried);
  /* 收尾：把人推翻的判决与打回的方案抓进经验层，零 LLM */
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('node', [require('path').join(__dirname, 'experience_sync.js'), String(cid)], { env: process.env, timeout: 120000 }).toString().trim();
    log('experience_sync：' + out.split('\n')[0]);
  } catch (e) { log('experience_sync 失败（不影响本次）：' + String(e.message).slice(0, 120)); }
}

async function report(all, sprint, retried) {
  const mine = all.filter((t) => (IDS ? IDS.includes(t.id) : t.sprint === sprint));
  const blockers = [];
  const ready = [];
  for (const t of mine) {
    if (t.status === 'review') {
      const pv = (String(t.result_note || '').match(/预览: (\S+)/) || [])[1] || t.output_url || '';
      ready.push({ id: t.id, title: t.title, preview: pv });
      for (const q of humanDecisions(t.result_note)) blockers.push({ id: t.id, kind: '需要人定', text: q });
      // note 每轮追加一段「要点」，配图计数取最后一次出现的
      const imgAll = [...String(t.result_note || '').matchAll(/配图 (\d+)\/(\d+)/g)];
      const img = imgAll.length ? imgAll[imgAll.length - 1] : null;
      if (img && Number(img[1]) < Number(img[2])) blockers.push({ id: t.id, kind: '待人工配图', text: '配图 ' + img[1] + '/' + img[2] + '，缺 ' + ((String(t.result_note).match(/缺 ([^（。]+?)待人工配图/) || [])[1] || '').trim() });
      if (t.manual_pending) blockers.push({ id: t.id, kind: '待人工验证', text: (t.manual_checks || []).filter((c) => !c.done).map((c) => c.text || c).join('；') });
      continue;
    }
    if (t.human_state !== 'wait_me') continue;
    if (t.fail_reason) blockers.push({ id: t.id, kind: retried[t.id] ? '重排后仍失败' : '执行失败', text: t.fail_reason });
    else if (t.review_pending) blockers.push({ id: t.id, kind: '待判', text: 'fable 还没判' });
    else if (t.review_stale) blockers.push({ id: t.id, kind: '判决过期', text: 'facts 更新后需重判' });
    else if (!t.review_effective) blockers.push({ id: t.id, kind: '无判决', text: '没有 fable 判决，需先跑 review' });
    else if (t.owner_type !== 'agent' && t.status === 'approved') blockers.push({ id: t.id, kind: '人工任务', text: 'owner=' + t.owner_type + '，机器不执行，等人做' });
  }

  // 写回看板：attention + note 尾部 [harness] 段（同任务多条合并）
  const byTask = {};
  for (const b of blockers) (byTask[b.id] = byTask[b.id] || []).push(b);
  for (const [id, list] of Object.entries(byTask)) {
    const t = mine.find((x) => x.id === Number(id));
    const block = '\n\n[harness ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + '] 阻塞：\n' + list.map((b) => '- ' + b.kind + '：' + b.text).join('\n');
    const note = String(t.result_note || '');
    if (note.includes('[harness ') && list.every((b) => note.includes(b.text))) continue;
    if (!DRY) await call('PATCH', '/tasks/' + id, { attention: 1, result_note: note + block });
  }

  // 输出
  console.log('\n## 放行卡（' + ready.length + '）');
  for (const r of ready) console.log('- #' + r.id + ' ' + r.title + (r.preview ? ' ' + r.preview : ''));
  console.log('\n## 阻塞与待人定（' + blockers.length + '）');
  for (const b of blockers) console.log('- #' + b.id + ' ' + b.kind + '：' + b.text);

  // 追加到 TODO.md 批注段
  if (!NO_TODO && !DRY && fs.existsSync(TODO)) {
    const s = fs.readFileSync(TODO, 'utf8');
    const head = '## 批注（手写）';
    const i = s.indexOf(head);
    if (i !== -1) {
      const bc = await boardClient();
      const stamp = new Date().toISOString().slice(0, 10);
      const lines = ['', `- [harness ${stamp}] ${bc ? bc.name : cid}：待放行 ${ready.length} 条${blockers.length ? '；阻塞 ' + blockers.length + ' 条：' + blockers.map((b) => '#' + b.id + ' ' + b.kind).join('、') : '，无阻塞'}`];
      const j = s.indexOf('\n', s.indexOf('\n', i) + 1); // 跳过标题行和说明行
      const out = s.slice(0, j) + lines.join('\n') + s.slice(j);
      fs.writeFileSync(TODO, out);
      log('已写 TODO.md 批注段');
    }
  }
}

main().catch((e) => { console.error(ts() + ' harness 中止：' + e.message); process.exit(1); });
