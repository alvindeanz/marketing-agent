#!/usr/bin/env node
'use strict';
// 把看板 GET /board 渲染成 PJ 的 TODO.md。2026-08-29 W1：看板是任务状态唯一真相，
// PJ 不再手写任务状态。文件分两段：
//   「## 看板（生成）」  每次整段重写，禁止手改（改了下次也会被盖掉）
//   「## 批注（手写）」  这段原样保留，PJ 想记的话写这里，且只写看板上没有的东西
// 用法：SEO_WORKER_CONFIG=/data/aira/seo-worker/config.json node tools/board_todo.js [输出路径]
// 默认输出 /data/aira/projects/MA/memory/TODO.md

const fs = require('fs');
const path = require('path');
const { Api } = require('../lib/api');
const cfg = require('../lib/config').load();

const OUT = process.argv[2] || '/data/aira/projects/MA/memory/TODO.md';
const GEN_HEAD = '## 看板（生成）';
const NOTE_HEAD = '## 批注（手写）';

const STATE_LABEL = { wait_me: '等我', running: '在跑', wait_ext: '等外部', closed: '结束' };
const CLOSED_LABEL = { done: '落地', accepted: '验收', dropped: '砍掉', merged: '并入', killed: '不做' };

function line(t) {
  const st = t.human_state === 'closed'
    ? (CLOSED_LABEL[t.closed_kind] || '结束')
    : (STATE_LABEL[t.human_state] || t.human_state) + (t.wait_reason ? ' ' + t.wait_reason : '') + (t.run_note ? ' ' + t.run_note : '');
  const bits = ['#' + t.id, t.sprint || '-', t.priority || '', st];
  if (t.overdue) bits.push('逾期');
  if (t.manual_pending) bits.push('待复验: ' + (t.manual_checks || []).join('、'));
  if (t.human_state === 'closed' && t.evidence && !/^检查:|^\[(accepted|dropped|merged|killed)\]/.test(t.evidence)) bits.push('证据: ' + t.evidence);
  return '- ' + bits.filter(Boolean).join(' · ') + ' | ' + String(t.title || '').slice(0, 60);
}

/* 工具健康（W4）：仓库 HEAD 与 worker、api 的 DEPLOYED 比。漂移且部署记录超过 24 小时就报，
   放在 TODO 最顶上，PJ 每次开工先看见。查不到就写查不到，不装没事。 */
function deployDrift(board) {
  const { execSync } = require('child_process');
  const lines = [];
  let head = '';
  try { head = execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' }).trim(); } catch (e) { lines.push('- 仓库 HEAD 读不到：' + e.message); }
  const stale = (dateStr) => {
    const m = String(dateStr || '').match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/);
    if (!m) return true;
    return Date.now() - new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() > 24 * 3600 * 1000;
  };
  try {
    const dep = fs.readFileSync('/data/aira/seo-worker/DEPLOYED', 'utf8');
    const rev = (dep.match(/^rev (\S+)/m) || [])[1] || '';
    const date = (dep.match(/^date (\S+)/m) || [])[1] || '';
    if (head && rev && !head.startsWith(rev) && !rev.startsWith(head) && stale(date)) lines.push('- worker 线上 ' + rev + '（' + date + '）落后仓库 ' + head + ' 超过 24 小时，跑 ./deploy.sh worker');
  } catch (e) { lines.push('- worker DEPLOYED 读不到：' + e.message); }
  if (board.api_rev) {
    if (head && !head.startsWith(board.api_rev) && !board.api_rev.startsWith(head) && stale(board.api_deployed)) lines.push('- api 线上 ' + board.api_rev + '（' + board.api_deployed + '）落后仓库 ' + head + ' 超过 24 小时，跑 ./deploy.sh api');
  } else lines.push('- api 的 DEPLOYED-seo 读不到，看板版本不明');
  return lines;
}

function render(board) {
  const out = [GEN_HEAD, '', '生成于 ' + board.generated_at + '，来源 GET /board。本段禁止手改。', ''];
  const drift = deployDrift(board);
  if (drift.length) out.push('工具健康（先处理）：', ...drift, '');
  for (const c of board.clients) {
    const cur = c.current_sprint;
    const k = c.counts || {};
    out.push('### ' + c.name + '（本期 S' + cur + '，锚点 ' + (c.sprint_anchor || '无') + '）');
    out.push('等我 ' + (k.wait_me || 0) + ' · 在跑 ' + (k.running || 0) + ' · 待人工 ' + (k.manual_pending || 0) + ' · 7 天失败 job ' + (k.failed_jobs_7d || 0));
    const tasks = c.tasks || [];
    const now = tasks.filter((t) => t.sprint_num === cur || t.sprint_num === null || t.overdue);
    const later = tasks.filter((t) => t.sprint_num !== null && t.sprint_num > cur);
    const manual = tasks.filter((t) => t.manual_pending);
    const open = now.filter((t) => t.human_state !== 'closed');
    const closed = now.filter((t) => t.human_state === 'closed');
    for (const pp of (c.pending_plans || [])) out.push('', '待确认方案 v' + pp.version + '（plan #' + pp.plan_id + '）：' + pp.task_count + ' 条任务（S1 ' + pp.s1_count + ' 条）等你在方案区批准或打回，批准前不算本期活。');
    if (manual.length) { out.push('', '待复验（到期用 /data/aira/tools/verify/verify.js 或数据脚本跑，结果贴进看板「复验完成」；Google 交互工具类只抽查）：'); manual.forEach((t) => out.push(line(t))); }
    if (open.length) { out.push('', '本期未结：'); open.forEach((t) => out.push(line(t))); }
    if (closed.length) { out.push('', '本期已结：'); closed.forEach((t) => out.push(line(t))); }
    if (later.length) out.push('', '下期及以后 ' + later.length + ' 条：' + later.map((t) => '#' + t.id + '(' + t.sprint + ')').join(' '));
    out.push('');
  }
  return out.join('\n');
}

function keepNotes(existing) {
  const i = existing.indexOf(NOTE_HEAD);
  if (i === -1) return NOTE_HEAD + '\n\n（只写看板上没有的东西：客户口头指令、待拍板的分歧、线上观察。任务状态不许写这里。）\n';
  return existing.slice(i).trimEnd() + '\n';
}

(async () => {
  const api = new Api(cfg);
  const board = await api.req('GET', '/board');
  const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  const body = '# TODO\n\n' + render(board) + '\n' + keepNotes(existing);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body, 'utf8');
  const n = board.clients.reduce((a, c) => a + (c.tasks || []).length, 0);
  console.log('TODO.md 已生成：' + board.clients.length + ' 客户 ' + n + ' 任务 -> ' + OUT);
})().catch((e) => { console.error('board_todo 失败：' + e.message); process.exit(1); });
