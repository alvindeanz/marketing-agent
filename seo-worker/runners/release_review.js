'use strict';
// release_review runner: opus 放行官（2026-09-27 Alvin 定，方案 B）。
//
// 判定层（review_plan）答的是「该不该做」，本 runner 答的是「这份方案现在照它执行，
// 是否安全且有依据」。判决三选一 release / hold_human / redo，标准全文在
// specs/release_review.md，本文件不携带任何关于安全性的私货意见。
//
// 三条必须保持的性质（沿 review_plan 的约法）：
//   1. 本 runner 只产判决，不改任务状态。落地动作（排 apply、写静默期标记、停人）
//      全部由服务端 /tasks/release_review_result 按 release_policy 执行，spend 与
//      irreversible 的 24 小时静默期、apply 历史熔断都在服务端，模型说了不算。
//   2. 每个判决必须给 reason。解析不出的判决一律降 hold_human，宁停勿猜。
//   3. 一批判一次，不自旋。重判由 harness 下一轮或人触发。

const fs = require('node:fs');
const path = require('node:path');

const { runClaude } = require('../lib/llm');
const { extractTrailingJson } = require('../lib/mdjson');
const { ensureClientWorkspace, truncate, summarize } = require('../lib/util');
const { taskBlock, attachChangePlans } = require('./review_plan');

const ALLOWED_TOOLS = 'Read';
const PRINCIPLES_FILE = path.join(__dirname, '..', 'specs', 'release_review.md');

const VERDICTS = ['release', 'hold_human', 'redo'];
const MAX_TASKS = 20;
const MAX_REASON_CHARS = 160;

function loadPrinciples() {
  return fs.readFileSync(PRINCIPLES_FILE, 'utf8');
}

function buildPrompt(opts) {
  return [
    '你是放行官。客户：' + (opts.clientName || '(未知)') + '。',
    '下面是判定原则全文，唯一标准，照它判：',
    '===== 原则开始 =====',
    opts.principles,
    '===== 原则结束 =====',
    '',
    '待判任务（每个都停在待放行，附变更方案或大纲；工作区可用 Read 核对方案引用的文件与数据包）：',
    opts.tasksText,
    '',
    '输出：只输出一个 json 代码块（格式见原则末节），覆盖上面每一个任务，块外零字符。',
  ].join('\n');
}

/** 形状清洗：非法判决降 hold_human，宁停勿猜；缺席的任务补 hold_human。 */
function cleanVerdicts(json, batchIds, log) {
  const say = log || (() => {});
  const rows = json && Array.isArray(json.verdicts) ? json.verdicts : [];
  const byId = new Map();
  for (const v of rows) {
    const tid = Number(v && v.task_id) || 0;
    if (!batchIds.includes(tid)) {
      if (tid) say('放行判定：#' + tid + ' 不在本批，丢弃');
      continue;
    }
    if (byId.has(tid)) continue;
    let verdict = String(v.verdict || '').trim().toLowerCase();
    let reason = summarize(v.reason, MAX_REASON_CHARS);
    if (!VERDICTS.includes(verdict)) {
      say('放行判定：#' + tid + ' 判决值 "' + truncate(String(v.verdict), 20) + '" 不合法，降 hold_human');
      reason = '判决值不合法，需人工看：' + reason;
      verdict = 'hold_human';
    }
    if (!reason) {
      if (verdict !== 'hold_human') {
        say('放行判定：#' + tid + ' 没有 reason，降 hold_human');
        verdict = 'hold_human';
      }
      reason = '模型没有给出理由';
    }
    const conflicts = Array.isArray(v.conflicts)
      ? v.conflicts.map((c) => String(c).slice(0, 4)).slice(0, 6)
      : [];
    byId.set(tid, { task_id: tid, verdict, reason: summarize(reason, MAX_REASON_CHARS), conflicts });
  }
  const out = [];
  for (const tid of batchIds) {
    if (byId.has(tid)) { out.push(byId.get(tid)); continue; }
    say('放行判定：#' + tid + ' 没拿到判决，记 hold_human');
    out.push({ task_id: tid, verdict: 'hold_human', reason: '模型未给出判决，需人工看', conflicts: [] });
  }
  return { verdicts: out, summary: summarize(json && json.summary, 300) };
}

/** 模型半场，与 review_plan 同款三层防线：自检、坏块一次纠错、仍坏干净失败。 */
async function judgeWithModel(ctx, opts) {
  const { cfg, log } = ctx;
  const prompt = buildPrompt(opts);
  log('放行判定 prompt ' + prompt.length + ' 字符，模型 ' + cfg.releaseReviewModel);
  const res = await runClaude(cfg, {
    prompt, cwd: opts.workspace, log, model: cfg.releaseReviewModel,
    allowedTools: ALLOWED_TOOLS, label: opts.label,
  });
  let output = String(res.stdout || '').trim();
  if (!output) return { ok: false, error: 'claude 没有任何输出' };
  let parsed = extractTrailingJson(output);
  if (parsed.error || !parsed.json || typeof parsed.json !== 'object') {
    log('放行判定：json 解析失败（' + (parsed.error || 'json 块不是对象') + '），一次纠错重试');
    const fixRes = await runClaude(cfg, {
      prompt: '你上一轮输出的 json 代码块无法解析：' + (parsed.error || 'json 块不是对象') +
        '。重新输出修正后的 json 代码块，含义不变只修语法，块外零字符。\n\n=====\n' + output.slice(-6000),
      cwd: opts.workspace, log, model: cfg.releaseReviewModel,
      allowedTools: ALLOWED_TOOLS, label: opts.label + ' fix',
    });
    output = String(fixRes.stdout || '').trim();
    parsed = extractTrailingJson(output);
  }
  if (parsed.error || !parsed.json || typeof parsed.json !== 'object') {
    return { ok: false, error: parsed.error || 'json 块不是对象' };
  }
  return { ok: true, json: parsed.json };
}

async function runWith(ctx, judge) {
  const { job, api, cfg, log } = ctx;
  const payload = job.payload || {};
  const ids = Array.isArray(payload.task_ids)
    ? payload.task_ids.map((x) => Number(x) || 0).filter((x) => x > 0)
    : [];
  if (!ids.length) throw new Error('release_review job has no payload.task_ids');
  if (ids.length > MAX_TASKS) throw new Error('release_review batch too large, max ' + MAX_TASKS);

  const context = await api.getContext(job.client_id);
  const profile = (context && context.profile) || null;
  if (!profile) throw new Error('context returned no profile for client_id ' + job.client_id);
  const allTasks = Array.isArray(context.tasks) ? context.tasks : [];
  const batch = allTasks.filter((t) => ids.indexOf(Number(t.id)) !== -1 && t.status === 'review');
  const missing = ids.filter((id) => !batch.some((t) => Number(t.id) === id));
  if (missing.length) log('放行判定：' + missing.map((x) => '#' + x).join('、') + ' 不在待放行或不属于该客户，跳过');
  if (!batch.length) throw new Error('none of the requested tasks are in review for client ' + job.client_id);

  const workspace = ensureClientWorkspace(profile, cfg);
  const withPlans = attachChangePlans(batch, workspace, log);
  const judged = await judge({
    principles: loadPrinciples(),
    tasksText: withPlans.map(taskBlock).join('\n\n'),
    clientName: profile.name || (context.client && context.client.name) || '',
    workspace,
    label: 'release_review job ' + job.id,
  });
  if (!judged || !judged.ok) {
    // 一个字都不写。失败 job 进 attention 队列是诚实的结局，一批瞎猜的放行不是。
    throw new Error('放行判定输出无法解析 :: ' + ((judged && judged.error) || '未知原因'));
  }
  const batchIds = batch.map((t) => Number(t.id));
  const cleaned = cleanVerdicts(judged.json, batchIds, log);
  const tally = cleaned.verdicts.reduce((a, v) => { a[v.verdict] = (a[v.verdict] || 0) + 1; return a; }, {});
  log('放行判定结果 ' + JSON.stringify(tally) + (cleaned.summary ? ' :: ' + cleaned.summary : ''));

  const res = await api.postReleaseReviewResult({
    client_id: job.client_id,
    job_id: job.id,
    summary: cleaned.summary,
    results: cleaned.verdicts,
  });
  log('放行判定已落库：' + JSON.stringify((res && res.actions) || res || {}));
  return { tokenUsage: 0 };
}

async function run(ctx) {
  return runWith(ctx, (opts) => judgeWithModel(ctx, opts));
}

module.exports = { run, runWith, judgeWithModel, buildPrompt, cleanVerdicts, VERDICTS, MAX_TASKS, PRINCIPLES_FILE };
