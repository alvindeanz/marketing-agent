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
const { foldCardFeedback, summariseFold } = require('../lib/cardfold');
const API = process.env.SEO_API_BASE || 'https://always.horntech-dev.com/seo-api.php';
const TOKEN = process.env.SEO_AGENT_TOKEN || '';
const TODO = process.env.MA_TODO || '/data/aira/projects/MA/memory/TODO.md';
const argv = process.argv.slice(2);
const cid = parseInt(argv[0], 10);
const DRY = argv.includes('--dry');
const NO_TODO = argv.includes('--no-todo');
const IDS = (() => { const i = argv.indexOf('--ids'); return i === -1 ? null : String(argv[i + 1] || '').split(',').map((x) => parseInt(x, 10)).filter(Boolean); })();
const GRACE_DAYS = (() => { const i = argv.indexOf('--card-grace-days'); return i === -1 ? 14 : (parseInt(argv[i + 1], 10) || 14); })();
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

/* 0. 卡反馈折叠（2026-09-13 Alvin 定第一性版）：客户在方向卡上提交过反馈的任务
   card_feedback_at 非空，harness 读到就分岔，不靠 webhook 不靠巡检。放在确认闸之前：
   反馈处理是已发出卡的收口，不该被 onboard 闸挡住。零 LLM：表态折叠是确定性规则
   （lib/cardfold.js），agree 项与文本反馈立跟进任务，POST /tasks 自动排闸A，
   后续走既有 判决 -> 放行 -> 执行 链。到期兜底同在这里：发出超过 --card-grace-days
   （默认 14 天）零反馈的方向卡，按卡上「未回复按建议执行」承诺视同同意。 */
async function foldCards(sprint) {
  const all = await tasks();
  const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
  for (const card of all.filter((t) => t.card_feedback_at)) {
    const rows = (await call('GET', '/card_feedback?task_id=' + card.id)).rows || [];
    const f = foldCardFeedback(rows);
    if (!f.hasAny) { if (!DRY) await call('PATCH', '/tasks/' + card.id, { card_feedback_done: 1 }); continue; }
    const summary = summariseFold(f);
    log('#' + card.id + ' 卡反馈折叠：' + summary);
    if (DRY) continue;
    let followId = null;
    if (f.agreed.length || f.texts.length) {
      const lines = [];
      if (f.agreed.length) {
        lines.push('客户已同意的项，按卡内建议落地（放行按 release_policy 分档，卡：' + (card.output_url || '#' + card.id) + '）：');
        for (const a of f.agreed) lines.push('- ' + a.item + (a.choice === 'flag' && a.fb ? '（勾选：' + a.fb.slice(0, 200) + '）' : ''));
      }
      if (f.holds.length) lines.push('客户要求保持观察不动：' + f.holds.map((x) => x.item).join('、'));
      if (f.texts.length) {
        lines.push('客户文本反馈（逐条处置：是纠偏写 facts，是新需求单独立项，不许留在本任务里烂掉）：');
        for (const x of f.texts) lines.push('- [' + x.item + '] ' + x.text.slice(0, 500));
      }
      lines.push('来源：方向卡 #' + card.id + ' 的客户反馈折叠，表态历史见该任务 note。');
      const r = await call('POST', '/tasks', {
        client_id: cid,
        title: '卡反馈落地：' + String(card.title).replace(/^(\[[^\]]*\]\s*)+/, '').slice(0, 60),
        module: card.module || 'technical', sprint, priority: 'P1', owner_type: 'agent',
        detail: lines.join('\n'),
      });
      followId = r.id;
      log('#' + card.id + ' -> 跟进任务 #' + followId + '，闸A 已排（job ' + (r.review_job_id || '?') + '）');
    }
    await call('POST', '/facts', { client_id: cid, fact_key: 'cards.t' + card.id + '.outcome', value: '方向卡 #' + card.id + '（' + String(card.title).slice(0, 40) + '）客户表态：' + summary + (followId ? '。跟进任务 #' + followId : '。全部保持观察，无跟进'), source: 'client', status: 'confirmed' });
    await call('PATCH', '/tasks/' + card.id, { result_note: String(card.result_note || '') + '\n\n[卡反馈折叠 ' + stamp() + '] ' + summary + (followId ? '，跟进 #' + followId : '，无需跟进'), card_feedback_done: 1 });
  }
  // 到期视同同意：只认已出客户版（有 deliverable 时间）的方向卡，折叠过的不重跑
  const auto = all.filter((t) => t.status === 'review' && !t.card_feedback_at
    && /方向卡|direction/i.test(String(t.title) + ' ' + String(t.ops || ''))
    && !/\[卡反馈折叠/.test(String(t.result_note || '')));
  for (const card of auto) {
    const sent = (card.deliverables || []).map((d) => String(d.created_at || '')).sort().pop();
    if (!sent) continue;
    const days = (Date.now() - new Date(sent.replace(' ', 'T')).getTime()) / 86400000;
    if (!(days >= GRACE_DAYS)) continue;
    log('#' + card.id + ' 发出 ' + Math.floor(days) + ' 天零反馈，到期视同同意');
    if (DRY) continue;
    const r = await call('POST', '/tasks', {
      client_id: cid,
      title: '卡到期落地（视同同意）：' + String(card.title).replace(/^(\[[^\]]*\]\s*)+/, '').slice(0, 60),
      module: card.module || 'technical', sprint, priority: 'P1', owner_type: 'agent',
      detail: '方向卡 #' + card.id + ' 发出 ' + Math.floor(days) + ' 天无客户反馈，按卡上「未回复将按建议执行」的承诺落地全部建议项。卡：' + (card.output_url || '（无链接，见任务 note）'),
    });
    await call('PATCH', '/tasks/' + card.id, { result_note: String(card.result_note || '') + '\n\n[卡反馈折叠 ' + stamp() + '] 到期（' + Math.floor(days) + ' 天）零反馈视同同意，跟进 #' + r.id });
  }
}

async function main() {
  const bc = await boardClient();
  if (!bc) throw new Error('board 上没有 client ' + cid);
  const sprintEarly = /^S/.test(String(bc.current_sprint)) ? String(bc.current_sprint) : 'S' + bc.current_sprint;
  await foldCards(sprintEarly);
  // 入 sprint 前的两道客户确认闸（2026-09-09 Alvin 定的全局流程：轻链方向卡 → 客户确认关键词 →
  // 客户确认 mapping → 才进 sprint）。证据看 facts：词表确认与 mapping 确认各要一条 confirmed 记录。
  // --skip-gates 显式跳过（如老客户补跑、或本次 --ids 只跑与词表无关的技术项），跳过原因进日志。
  if (!argv.includes('--skip-gates')) {
    const fr = await call('GET', '/facts?client_id=' + cid);
    const facts = (fr.facts || []).filter((f) => String(f.status || '') === 'confirmed');
    const kwOk = facts.some((f) => /^keywords\./.test(f.fact_key) && /(锁定|确认|lock|confirm)/i.test(String(f.fact_key) + String(f.value)));
    const mapOk = facts.some((f) => /^seo\.mapping/.test(f.fact_key) && /(确认|定稿|confirm)/i.test(String(f.fact_key) + String(f.value)));
    if (!kwOk || !mapOk) {
      throw new Error('两道确认闸未过：' + (kwOk ? '' : '关键词未经客户确认（缺 keywords.* 的 confirmed 锁定记录）；')
        + (mapOk ? '' : 'mapping 未定稿（缺 seo.mapping* 的 confirmed 记录）；')
        + '流程是 方向卡 → 词表客户确认 → mapping 确认 → sprint。确有理由跳过用 --skip-gates。');
    }
    log('两道确认闸通过：词表已确认、mapping 已定稿');
  } else {
    log('注意：--skip-gates 跳过词表与 mapping 确认闸，理由自负');
  }
  const sprint = /^S/.test(String(bc.current_sprint)) ? String(bc.current_sprint) : 'S' + bc.current_sprint;
  log(`${bc.name}（${cid}）本期 ${sprint}` + (IDS ? '，只处理 #' + IDS.join(' #') : ''));
  /* --ids：跨 sprint 指定任务，本次运行把「本期」的口径换成这批 id */
  const inScope = (t) => (IDS ? IDS.includes(t.id) : t.sprint === sprint);

  // 0.5 本期还没有判决的任务（含 later 自动挪期后清了判决的）先排一轮闸A，判完再拍板。
  let all = await tasks();
  const noVerdict = all.filter((t) => inScope(t) && t.status === 'proposed'
    && !t.review_effective && !t.review_pending && !(t.job_state && t.job_state.status)).map((t) => t.id);
  const pendingNow = all.filter((t) => inScope(t) && t.review_pending).map((t) => t.id);
  if ((noVerdict.length || pendingNow.length) && !DRY) {
    if (noVerdict.length) {
      const r = await call('POST', '/tasks/review', { client_id: cid, task_ids: noVerdict.slice(0, 20) });
      log('本期 ' + noVerdict.length + ' 条无判决，已排闸A（job ' + (r.job_id || '?') + '），等判定');
    }
    for (const id of pendingNow) if (!noVerdict.includes(id)) noVerdict.push(id);
    if (pendingNow.length) log('另有 ' + pendingNow.length + ' 条判定在飞，一并等');
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
