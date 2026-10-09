#!/usr/bin/env node
'use strict';
/* 舰队摘要（2026-09-20 Alvin 定四桶）：跨客户零模型汇总，给人看问题在哪。
   ① 等确认：在途卡按出卡天数排，标到期倒数（时钟=cardClockAnchor 出卡日，GRACE 14 天）
   ② 已开跑：反馈折叠后的落地任务与 in_progress 任务
   ③ 报错未自愈：近 7 天失败 job（失败不自动重试，每条都要人看）与 wait_reason 带失败的任务
   ④ 落地抽查：近 7 天 apply 落地数 vs 抽查数（抽查率低要暴露，不粉饰）
   跑法：SEO_AGENT_TOKEN=... node tools/fleet_digest.js [--days 7]
   只读，不写任何东西。输出 Discord 友好（列表，无表格，无 emoji，无破折号）。 */
const { cardClockAnchor } = require('../lib/cardfold');
const API = process.env.SEO_API_BASE || 'https://always.horntech-dev.com/seo-api.php';
const TOKEN = process.env.SEO_AGENT_TOKEN || '';
if (!TOKEN) { console.error('用法：SEO_AGENT_TOKEN=... node tools/fleet_digest.js [--days 7]'); process.exit(1); }
const argv = process.argv.slice(2);
const DAYS = (() => { const i = argv.indexOf('--days'); return i === -1 ? 7 : (parseInt(argv[i + 1], 10) || 7); })();
const GRACE_DAYS = 14;

async function call(p) {
  const r = await fetch(API + p, { headers: { Authorization: 'Bearer ' + TOKEN } });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = {}; }
  if (!r.ok) throw new Error(p + ' -> ' + r.status);
  return j;
}
/* 库里时间是 NZ 本地无时区标记，本机是 UTC，直接解析会有半天级偏移，天数下限钳 0 */
const daysAgo = (s) => Math.max(0, (Date.now() - new Date(String(s).replace(' ', 'T')).getTime()) / 86400000);

/* 与 seo-agent.html isPendingClientCard 同口径（正则暂双份，card_kind 字段落地后两处同删） */
function isPendingCard(t) {
  if (t.status !== 'review' && t.status !== 'done') return false;
  const s = String(t.result_note || '');
  if (/\[卡反馈折叠/.test(s)) return false;
  const title = String(t.title || '');
  if (/^(卡反馈落地|卡到期落地)/.test(title)) return false;
  if (/keyword-direction|creative-direction|keyword-confirmation|mapping-confirmation/.test(String(t.ops || ''))) return true;
  if (/确认卡|blog_confirmation|keyword_direction_|creative_direction_|keyword_confirmation_|negatives_direction_/.test(s + String(t.output_url || ''))) return true;
  if (/\?t=\d+&k=[a-f0-9]+/.test(s + String(t.output_url || ''))) return true; /* t/k 令牌=卡的共同签名 */
  return /确认卡|方向卡|词卡|素材卡|confirmation card/i.test(title) && /客户版|agencyreport/.test(s);
}

(async () => {
  const clients = (await call('/clients')).clients.filter((c) => c.status === 'active');
  const wait = [], running = [], broken = [], applied = [], healed = [];
  /* 三桶（2026-10-07 Alvin 定口径，批二 F 并入 digest）：
     桶一 机器债，轮内应清零，每条都是流程洞：无判决超时 / 方案在手未排放行官 / 人工位挂超
       7 天（harness D 路会转，这里是漏网之鱼）/ 非法 sprint 标签（C 已封入口，这里兜存量）。
     桶二 等人等客户，不算僵尸，但要带「等什么 / 几天 / 该谁动」。
     桶三 到期重判，later 挪期到了当期的，下一轮自然吃掉，这里点名。 */
  const debt = [], waiting = [], rejudge = [];
  let board = { clients: [] };
  try { board = await call('/board'); } catch (e) { /* 端点坏了三桶少 current_sprint 口径，容忍 */ }
  const curOf = {};
  for (const b of (board.clients || [])) curOf[Number(b.client_id)] = parseInt(String(b.current_sprint || '').replace(/^S/i, ''), 10) || null;
  const sprintN = (s) => { const m = /^S(\d+)$/i.exec(String(s || '')); return m ? parseInt(m[1], 10) : null; };
  for (const c of clients) {
    const ts = (await call('/tasks?client_id=' + c.client_id)).tasks || [];
    for (const t of ts) {
      const note = String(t.result_note || '');
      if (isPendingCard(t)) {
        const a = cardClockAnchor(t);
        if (!a) continue;
        const d = Math.floor(daysAgo(a));
        wait.push({ c: c.name, id: t.id, d, left: GRACE_DAYS - d, title: String(t.title).slice(0, 44), fb: !!t.card_feedback_at, sent: !!t.sent_at });
        continue;
      }
      if (t.status === 'in_progress' || /^(卡反馈落地|卡到期落地)/.test(String(t.title || '')) && t.status !== 'done') {
        running.push({ c: c.name, id: t.id, st: t.status, title: String(t.title).slice(0, 44) });
      }
      /* 自愈账（2026-09-21）：reclass 与自动转位的留痕，近 N 天的列给人翻案 */
      for (const tag of ['[reclass]', '[auto-machine-run]']) {
        if (note.indexOf(tag) !== -1 && t.updated_at && daysAgo(t.updated_at) <= DAYS) {
          const line = note.split('\n').find((l) => l.indexOf(tag) !== -1) || tag;
          healed.push({ c: c.name, id: t.id, what: line.replace(/^\[[^\]]*\]\s*/, '').slice(0, 90), kind: tag === '[reclass]' ? '归类' : '转位' });
        }
      }
      if (/失败/.test(String(t.wait_reason || ''))) {
        broken.push({ c: c.name, id: t.id, key: c.client_id + ':' + t.id, what: '任务 #' + t.id + ' ' + String(t.wait_reason).slice(0, 60) + '：' + String(t.title).slice(0, 36) });
      }
      if (/\[accepted\]|已自动回滚|apply/.test(note) && t.status === 'done' && t.updated_at && daysAgo(t.updated_at) <= DAYS
          && /apply|落地/.test(String(t.title || '') + String(t.ops || '') + note)) {
        applied.push({ c: c.name, id: t.id, sampled: /\[抽查/.test(note) });
      }
    }
    let jobs = [];
    try { jobs = (await call('/jobs?client_id=' + c.client_id)).jobs || []; } catch (e) { /* 端点缺容忍 */ }
    for (const j of jobs) {
      if (j.status !== 'failed' || daysAgo(j.created_at) > DAYS) continue;
      /* 同任务后来跑成了的失败不算未自愈 */
      const tid = (() => { try { const p = typeof j.payload === 'string' ? JSON.parse(j.payload) : j.payload; return p && p.task_ids && p.task_ids[0]; } catch (e) { return null; } })();
      const healed = tid && jobs.some((k) => k.status === 'done' && k.type === j.type && k.id > j.id
        && (() => { try { const p = typeof k.payload === 'string' ? JSON.parse(k.payload) : k.payload; return p && p.task_ids && p.task_ids[0] === tid; } catch (e) { return false; } })());
      /* 同任务多次失败只报最新一条；任务已在 wait_reason 桶里的不重复报 job */
      if (!healed) {
        const key = c.client_id + ':' + (tid || 'job' + j.id);
        const dup = broken.find((b) => b.key === key);
        if (dup) { if (String(dup.id).startsWith('job') && j.id > parseInt(String(dup.id).slice(4), 10)) { dup.id = 'job ' + j.id; } continue; }
        broken.push({ c: c.name, id: 'job ' + j.id, key, what: j.type + ' 失败' + (tid ? '（任务 #' + tid + '）' : '') });
      }
    }
    /* 三桶分类（批二 F）。卡类等确认在上面有自己的节，不重复入桶；失败 job 在报错节，不重复。 */
    const curN = curOf[Number(c.client_id)] || null;
    const rrCover = new Set();
    for (const j of jobs) {
      if (j.type !== 'release_review' || ['queued', 'running'].indexOf(j.status) === -1) continue;
      try { const p = typeof j.payload === 'string' ? JSON.parse(j.payload) : j.payload; ((p && p.task_ids) || []).forEach((x) => rrCover.add(Number(x))); } catch (e) { /* payload 坏容忍 */ }
    }
    for (const t of ts) {
      if (t.status === 'done' || isPendingCard(t)) continue;
      const d = Math.floor(daysAgo(t.updated_at || t.created_at));
      const note = String(t.result_note || '');
      const head = c.name + ' #' + t.id + ' ' + String(t.title).slice(0, 40);
      if (t.sprint && !/^S\d{1,2}$/i.test(String(t.sprint))) { debt.push(head + '：非法 sprint 标签 ' + t.sprint + '，不在任何轮次口径（改成 S 号）'); continue; }
      const why = String(t.wait_reason || '');
      if (t.human_state === 'queued' && d >= 3) { debt.push(head + '：' + String(t.run_note || '排期') + ' 挂 ' + d + ' 天，判定链没续上'); continue; }
      if (t.status === 'review' && t.human_state === 'wait_me' && why === '待放行') {
        const pend = note.match(/\[pending-release [^\]]*until (\d{4}-\d{2}-\d{2} \d{2}:\d{2})Z\]/g);
        const inWindow = pend && (() => { const m = pend[pend.length - 1].match(/until (\d{4}-\d{2}-\d{2} \d{2}:\d{2})Z/); return m && Date.now() < Date.parse(m[1].replace(' ', 'T') + ':00Z'); })();
        if (inWindow) { waiting.push(head + '：静默期中，到点 harness 自动落地'); continue; }
        if (!rrCover.has(Number(t.id)) && d >= 2) { debt.push(head + '：方案在手 ' + d + ' 天没排放行官（续接链漏网）'); continue; }
        waiting.push(head + '：待放行 ' + d + ' 天，放行官在途'); continue;
      }
      if (/停人/.test(why)) { waiting.push(head + '：停人待裁决 ' + d + ' 天，该人裁（判语在卡 note）'); continue; }
      if (/人工位待认领/.test(why)) { (d >= 7 ? debt : waiting).push(head + '：人工位待认领 ' + d + ' 天' + (d >= 7 ? '（超 7 天，harness 转位路该吃掉，还在就是洞）' : '，该运营认领')); continue; }
      if (/人工执行中/.test(why)) { waiting.push(head + '：人工执行中 ' + d + ' 天，该认领人收尾'); continue; }
      if (/待人工执行/.test(why)) { waiting.push(head + '：拆条人工工单 ' + d + ' 天，该运营啃'); continue; }
      if (String(t.owner_type) === 'client' && ['proposed', 'approved', 'blocked', 'in_progress'].indexOf(t.status) !== -1) { waiting.push(head + '：等客户 ' + d + ' 天'); continue; }
      if (String(t.review_effective || '') === 'later') {
        const n = sprintN(t.sprint);
        if (n !== null && curN !== null && n <= curN) rejudge.push(head + '：later 到期（' + t.sprint + ' 已当期），下一轮自动重判');
      }
    }
  }
  wait.sort((a, b) => a.left - b.left);
  const L = [];
  L.push('# 舰队摘要 ' + new Date().toISOString().slice(0, 10) + '（近 ' + DAYS + ' 天口径）');
  L.push('');
  L.push('## 等确认（' + wait.length + ' 张在途卡，按到期倒数排）');
  for (const w of wait) L.push('- ' + w.c + ' #' + w.id + ' 出卡 ' + w.d + ' 天' + (w.left <= 0 ? '，已到期待落地' : '，剩 ' + w.left + ' 天到期') + (w.fb ? '，有新反馈待折叠' : w.sent ? '，已发待反馈' : '，待发') + '：' + w.title);
  if (!wait.length) L.push('- 无');
  L.push('');
  L.push('## 已开跑（' + running.length + '）');
  for (const r of running) L.push('- ' + r.c + ' #' + r.id + ' [' + r.st + '] ' + r.title);
  if (!running.length) L.push('- 无');
  L.push('');
  L.push('## 报错未自愈（' + broken.length + '，每条都要人看）');
  for (const b of broken) L.push('- ' + b.c + ' ' + b.id + '：' + b.what);
  if (!broken.length) L.push('- 无');
  L.push('');
  const sampled = applied.filter((a) => a.sampled).length;
  L.push('## 落地抽查（近 ' + DAYS + ' 天）');
  L.push('- 落地 ' + applied.length + ' 条，抽查 ' + sampled + ' 条' + (applied.length && !sampled ? '，抽查率为零，该抽了' : ''));
  L.push('');
  L.push('## 自愈账（近 ' + DAYS + ' 天，看不顺眼的 PATCH 回原值即翻案，熔断保证不反复）');
  for (const h of healed) L.push('- ' + h.c + ' #' + h.id + ' [' + h.kind + '] ' + h.what);
  if (!healed.length) L.push('- 无');
  L.push('');
  L.push('## 桶一 机器债（' + debt.length + '，应为零，每条都是流程洞，轮内清）');
  for (const x of debt) L.push('- ' + x);
  if (!debt.length) L.push('- 无，链路自己转得动');
  L.push('');
  L.push('## 桶二 等人等客户（' + waiting.length + '，不算僵尸，带天数追）');
  for (const x of waiting) L.push('- ' + x);
  if (!waiting.length) L.push('- 无');
  L.push('');
  L.push('## 桶三 到期重判（' + rejudge.length + '，下一轮自动吃掉，点名确认）');
  for (const x of rejudge) L.push('- ' + x);
  if (!rejudge.length) L.push('- 无');
  console.log(L.join('\n'));
})().catch((e) => { console.error('fleet_digest 失败：' + e.message); process.exit(1); });
