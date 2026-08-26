'use strict';
// Child process that executes exactly one job, then exits.
//
// The listener forks this file so a stuck job can be killed hard without
// taking the listener down. Communication with the parent is IPC only:
//   { t: 'log',    line }        streamed log line, parent buffers and PATCHes
//   { t: 'result', tokenUsage }  job finished ok
//   { t: 'error',  message, stack }
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
  'review_plan',
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
    send({ t: 'error', message, stack });
    process.exitCode = 1;
    // Give IPC a tick to deliver before the process tears down.
    setTimeout(() => process.exit(1), 250).unref();
  }
);
