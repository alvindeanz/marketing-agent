'use strict';
// Child process that executes exactly one job, then exits.
//
// The listener forks this file so a stuck job can be killed hard without
// taking the listener down. Communication with the parent is IPC only:
//   { t: 'log',    line }        streamed log line, parent buffers and PATCHes
//   { t: 'result', tokenUsage }  job finished ok
//   { t: 'error',  message, stack, gate }   gate=true 为闸类拦截（契约校验零写入中止），
//                                           listener 的熔断分诊据此 skip（lib/fuse_policy）
//
// Started with: fork(runner_host.js, [JSON.stringify(job)])

const path = require('node:path');
const { load } = require('./lib/config');
const { Api } = require('./lib/api');
const llm = require('./lib/llm');
const { ts, safeJson } = require('./lib/util');

// 新增 runner 必须同时登记在这里和 seo-api.php 的 ensure_job_types()。
// 漏一边的后果：worker 领到活以后直接抛 unknown job type，job 全红。
// 2026-08 apply_task 就是漏了这里炸的。
const KNOWN_TYPES = [
  'pull_data',
  'discover',
  'plan',
  'execute_task',
  'apply_task',
  'report',
  'feedback',
  'triage',
  'ruling',
  'backfill_metrics',
  'chat',
  'plan_review',
  'review_plan',
  'release_review',
];

function send(msg) {
  if (process.send) {
    try {
      process.send(msg);
    } catch (e) {
      /* parent gone, stdout still has the record */
    }
  }
}

function makeLog(job) {
  const tag = 'job#' + job.id + ' ' + job.type;
  return function log(line) {
    const text = String(line == null ? '' : line);
    process.stdout.write('[' + ts() + '] [' + tag + '] ' + text + '\n');
    send({ t: 'log', line: text });
  };
}

async function main() {
  let job;
  try {
    job = JSON.parse(process.argv[2] || '');
  } catch (e) {
    throw new Error('runner_host: could not parse job argument: ' + e.message);
  }
  if (!job || !job.id || !job.type) throw new Error('runner_host: job is missing id or type');

  const cfg = load();
  const api = new Api(cfg);
  const log = makeLog(job);

  /* T1 trace 落盘（PLAN W18）：一 job 一进程，这里 init 一次，llm.js 每次调用自动落账。
     trace 是账本不是闸，init 失败静默跳过。 */
  try { require('./lib/trace').init(cfg, job); } catch (e) { /* 不挡 job */ }

  if (!KNOWN_TYPES.includes(job.type)) {
    throw new Error('unknown job type "' + job.type + '", known types: ' + KNOWN_TYPES.join(', '));
  }

  const runnerPath = path.join(__dirname, 'runners', job.type + '.js');
  let runner;
  try {
    runner = require(runnerPath);
  } catch (e) {
    throw new Error('cannot load runner ' + runnerPath + ' :: ' + e.message);
  }
  if (typeof runner.run !== 'function') {
    throw new Error('runner ' + runnerPath + ' does not export run()');
  }

  /* 内层 LLM 预算对齐 job 分档（2026-10-24）：listener 看门狗按 jobTimeoutMinByType 放宽的
     类型，spawn 预算跟着放宽，减 5 分钟留给收尾与失败落账（外层硬杀会丢 per-task 错误账）。
     不在分档表里的类型不动，仍走 jobTimeoutMin 基础值。 */
  const typedMin = Number(cfg.jobTimeoutMinByType && cfg.jobTimeoutMinByType[job.type]) || 0;
  if (typedMin > cfg.jobTimeoutMin) {
    cfg.llmTimeoutMsDefault = Math.max(typedMin - 5, cfg.jobTimeoutMin) * 60 * 1000;
  }

  // payload can arrive as a JSON string from PHP. Normalize once, here.
  job.payload = safeJson(job.payload, {}) || {};
  const payloadKeys = Object.keys(job.payload);
  log('start, client_id=' + job.client_id + ', payload keys: ' + (payloadKeys.join(',') || 'none'));
  const result = (await runner.run({ job, cfg, api, log })) || {};
  log('finished ok');
  send({ t: 'result', tokenUsage: Number(result.tokenUsage) || 0 });
}

process.on('SIGTERM', () => {
  process.stdout.write('[' + ts() + '] [runner_host] SIGTERM, killing claude children\n');
  llm.killAll('SIGTERM');
  process.exit(143);
});

main().then(
  () => {
    // Let stdout flush, then exit clean.
    process.exitCode = 0;
  },
  (err) => {
    const message = err && err.message ? err.message : String(err);
    const stack = err && err.stack ? err.stack : message;
    process.stdout.write('[' + ts() + '] [runner_host] FAILED: ' + stack + '\n');
    send({ t: 'error', message, stack, gate: !!(err && err.gate) });
    process.exitCode = 1;
    // Give IPC a tick to deliver before the process tears down.
    setTimeout(() => process.exit(1), 250).unref();
  }
);
