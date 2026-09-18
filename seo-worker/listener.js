'use strict';
// SEO agent worker: long lived listener.
//
// State machine, in one breath, per lane: idle -> drain (claim jobs one at a
// time until the API returns {job:null}) -> idle. A wake or a poll tick that
// lands while a drain is running only sets pendingWake, and the drain reruns
// once it finishes. Lanes (lib/lanes.js): heavy (site writers, minutes)
// and light (board only, seconds). Each lane is single flight on its own, so
// a light job never waits behind a heavy one and two heavy jobs never overlap.
//
// Hard rule: nothing here starts an LLM on a schedule. The poll tick only asks
// the API whether a human queued a job. Empty queue means the worker does
// nothing at all.

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { fork } = require('node:child_process');
const FUSE_FILE = process.env.WORKER_FUSE_FILE || '/data/aira/seo-worker/.spawn_fuse';

const { load } = require('./lib/config');
const { Api } = require('./lib/api');
const blogreview = require('./lib/blogreview');
const { conditionProbeTick } = require('./lib/conditions');
const { LANE_NAMES, laneOf } = require('./lib/lanes');
const { ts, makeStdoutLogger, summarize } = require('./lib/util');

const log = makeStdoutLogger('listener');
const VERSION = '0.1.0';

let cfg;
try {
  cfg = load();
} catch (e) {
  process.stderr.write('[' + ts() + '] [listener] config error: ' + e.message + '\n');
  process.exit(1);
}
/* 启动断言（2026-09-18，Apex job 981）：claudeBin 解析不出本机可执行文件就拒绝起，
   worker 不许带着执行不了的配置进抢单循环，烧的都是真单。 */
if (!cfg.claudeBin) {
  process.stderr.write('[' + ts() + '] [listener] 启动断言失败: ' + cfg.claudeBinNote + '；修好 config.json 的 claudeBin 再起。\n');
  process.exit(1);
}
if (cfg.claudeBinNote) log('claudeBin 自愈: ' + cfg.claudeBinNote);
const api = new Api(cfg);

function laneState() {
  return { busy: false, pendingWake: false, currentJobs: {}, lastDrainAt: null, lastDrainReason: null };
}

const state = {
  lanes: Object.fromEntries(LANE_NAMES.map((n) => [n, laneState()])),
  startedAt: Date.now(),
  fastFails: 0,
  lastDrainAt: null,
  lastDrainReason: null,
  lastJob: null,
  jobsDone: 0,
  jobsFailed: 0,
  lastError: null,
  shuttingDown: false,
  sweepBusy: false,
  lastSweepAt: null,
  lastSweep: null,
};

// ---------------------------------------------------------------------------
// job execution
// ---------------------------------------------------------------------------

/**
 * Run one job in a forked runner_host, stream its log back to the API, and
 * close the job out as done or failed. Never retries, never throws.
 */
function runJob(job, lane) {
  return new Promise((resolve) => {
    const ls = state.lanes[lane] || state.lanes.heavy;
    const jobTag = 'job#' + job.id + ' ' + job.type;
    // 报告 job 的三层（取数、叙事、渲染发布）叠起来会超过通用 30 分钟预算，
    // 单独给它 cfg.reportTimeoutMin，其余类型口径不变。
    const timeoutMin = job.type === 'report' ? cfg.reportTimeoutMin : cfg.jobTimeoutMin;
    const timeoutMs = timeoutMin * 60 * 1000;
    log(jobTag + ': claimed (client_id=' + job.client_id + '), timeout ' + timeoutMin + 'min');

    let buffer = [];
    let flushing = false;
    let finished = false;
    let timedOut = false;
    let failure = null;
    let tokenUsage = 0;
    let gotResult = false;

    function push(line) {
      buffer.push('[' + ts() + '] ' + line);
    }

    async function flush() {
      if (flushing || buffer.length === 0) return;
      flushing = true;
      const chunk = buffer.join('\n');
      buffer = [];
      try {
        await api.patchJob(job.id, { log_append: chunk });
      } catch (e) {
        // Do not lose the lines and do not fail the job over a log write.
        buffer.unshift(chunk);
        log(jobTag + ': log flush failed, will retry on next flush :: ' + e.message);
      } finally {
        flushing = false;
      }
    }

    const flushTimer = setInterval(() => {
      flush();
    }, 5000);
    flushTimer.unref();

    let child;
    try {
      child = fork(path.join(__dirname, 'runner_host.js'), [JSON.stringify(job)], {
        cwd: __dirname,
        env: process.env,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
    } catch (e) {
      finalize(new Error('cannot fork runner_host: ' + e.message));
      return;
    }
    ls.currentJobs[job.id] = { id: job.id, type: job.type, client_id: job.client_id, startedAt: Date.now() };

    const killTimer = setTimeout(() => {
      timedOut = true;
      push('TIMEOUT after ' + timeoutMin + ' min, terminating runner');
      log(jobTag + ': timeout, SIGTERM');
      try {
        child.kill('SIGTERM');
      } catch (e) {
        /* already gone */
      }
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (e) {
          /* already gone */
        }
      }, 15000).unref();
    }, timeoutMs);

    child.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'log') push(msg.line);
      else if (msg.t === 'result') { gotResult = true; tokenUsage = Number(msg.tokenUsage) || 0; }
      else if (msg.t === 'error') failure = new Error(msg.stack || msg.message || 'runner error');
    });

    child.on('error', (err) => {
      failure = failure || new Error('runner process error: ' + err.message);
    });

    child.on('close', (code, signal) => {
      let err = null;
      if (timedOut) {
        err = new Error(
          'job timed out after ' + timeoutMin + ' minutes and was killed (signal ' + signal + ')'
        );
      } else if (failure) {
        err = failure;
      } else if (code !== 0) {
        err = new Error('runner exited with code ' + code + (signal ? ' signal ' + signal : ''));
      } else if (!gotResult) {
        // exit 0 但 runner 没发 result：事件循环被掏空提前退出（unref 定时器之类），不是完成。
        err = new Error('runner exited 0 without a result message (event loop drained early?)');
      }
      finalize(err);
    });

    async function finalize(err) {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      clearInterval(flushTimer);
      const jobStartedAt = (ls.currentJobs[job.id] || {}).startedAt || 0;
      delete ls.currentJobs[job.id];

      const runMs = jobStartedAt ? (Date.now() - jobStartedAt) : Infinity;
      if (err) {
        push('FAILED: ' + (err.stack || err.message));
        state.jobsFailed += 1;
        state.lastError = { job_id: job.id, at: ts(), message: summarize(err.message, 300) };
        log(jobTag + ': FAILED :: ' + summarize(err.message, 400));
        /* 连续秒挂熔断（2026-09-16，登录过期连烧 5 个 job 的教训）：起跑即挂是环境病
           （凭据/磁盘/网络），不是这单任务的病，连续 3 个就拉闸停领新单；预检防不住
           任意时刻过期，熔断才是真兜底。人修好环境后删熔断文件恢复。 */
        if (runMs < 90000) {
          state.fastFails += 1;
          if (state.fastFails >= 3 && !fs.existsSync(FUSE_FILE)) {
            fs.writeFileSync(FUSE_FILE, JSON.stringify({ at: ts(), last_job: job.id, reason: summarize(err.message, 200), note: '连续 ' + state.fastFails + ' 个 job 起跑即挂，已停止领单。修好环境（多半是 claude 登录过期）后删除本文件恢复。' }, null, 1));
            log('!! 熔断：连续 ' + state.fastFails + ' 个 job 秒挂，已写 ' + FUSE_FILE + '，停止领新单直到人工删除该文件');
          }
        } else {
          state.fastFails = 0;
        }
      } else {
        push('job completed ok');
        state.jobsDone += 1;
        state.fastFails = 0;
        log(jobTag + ': done');
      }
      state.lastJob = {
        id: job.id,
        type: job.type,
        status: err ? 'failed' : 'done',
        at: ts(),
      };

      // One final PATCH carries the tail of the log plus the terminal status.
      const body = { status: err ? 'failed' : 'done' };
      if (buffer.length) {
        body.log_append = buffer.join('\n');
        buffer = [];
      }
      if (tokenUsage > 0) body.token_usage = tokenUsage;
      try {
        await api.patchJob(job.id, body);
      } catch (e) {
        log(jobTag + ': could not PATCH terminal status :: ' + e.message);
        pendingTerminalPark(job.id, body);
      }
      // No retry of the JOB. A failed job stays failed until a human queues a
      // new one; only the terminal STATUS gets re-delivered via the pending file.
      resolve();
    }
  });
}

/* 终态回写掉线暂存（2026-09-14 演练发现：API 死在 job 飞行中时终态 PATCH 失败即失联，
   job 永远停在 running，chat 线程 409 拒收新消息，只有重启收尸能救；且收尸会把本该
   done 的记成 failed。改法：回写失败先落本地暂存，poll 每 tick 与启动时（先于收尸）
   补投，成功即销账。暂存文件损坏按空处理，宁可靠收尸兜底也不让坏文件炸监听。 */
const PENDING_TERMINAL_FILE = path.join(__dirname, 'logs', 'pending_terminal.json');
function pendingTerminalPark(jobId, body) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(PENDING_TERMINAL_FILE, 'utf8')); } catch (e) { list = []; }
  if (!Array.isArray(list)) list = [];
  list = list.filter((x) => x && x.job_id !== jobId);
  list.push({ job_id: jobId, body, at: ts() });
  try {
    fs.mkdirSync(path.dirname(PENDING_TERMINAL_FILE), { recursive: true });
    fs.writeFileSync(PENDING_TERMINAL_FILE, JSON.stringify(list));
    log('job#' + jobId + ' 终态已暂存待补投（挂账 ' + list.length + ' 条）');
  } catch (e) { log('终态暂存写盘失败，只能等收尸兜底 :: ' + e.message); }
}
async function pendingTerminalFlush() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(PENDING_TERMINAL_FILE, 'utf8')); } catch (e) { return; }
  if (!Array.isArray(list) || !list.length) return;
  const keep = [];
  for (const it of list) {
    if (!it || !it.job_id) continue;
    try { await api.patchJob(it.job_id, it.body || {}); log('job#' + it.job_id + ' 暂存终态补投成功'); }
    catch (e) { keep.push(it); }
  }
  try { fs.writeFileSync(PENDING_TERMINAL_FILE, JSON.stringify(keep)); } catch (e) {}
  if (keep.length) log('终态补投：' + keep.length + ' 条仍投不出去，下个 tick 再试');
}

// ---------------------------------------------------------------------------
// drain loop
// ---------------------------------------------------------------------------

/**
 * Claim and run one lane's jobs until that lane's queue is empty. Single
 * flight per lane: a concurrent call just marks pendingWake and returns.
 */
async function drainLane(reason, lane) {
  const ls = state.lanes[lane];
  if (!ls || state.shuttingDown) return;
  if (ls.busy) {
    ls.pendingWake = true;
    log('drain(' + reason + ', ' + lane + ') while busy, marked pending');
    return;
  }
  ls.busy = true;
  ls.lastDrainAt = ts();
  ls.lastDrainReason = reason;
  let claimed = 0;
  // heavy 道并发 2（2026-09-10 Alvin 定）：跨客户并行，同客户互斥由服务端 claim 硬保证
  // （claim(heavy) 不发在跑客户的单）。其余道保持单飞。槽位空了就再 claim：
  // 同客户被互斥压着的单会在兄弟 job 跑完后变得可领，所以每次有槽释放都要回头再问一次。
  const maxSlots = lane === 'heavy' ? (cfg.heavyConcurrency || 2) : 1;
  const active = new Set();
  let stop = false;
  try {
    for (;;) {
      if (state.shuttingDown) break;
      while (active.size < maxSlots && !stop) {
        let job;
        if (fs.existsSync(FUSE_FILE)) {
          log('熔断生效（' + FUSE_FILE + '），本轮不领单；修好环境后删除该文件恢复');
          stop = true;
          break;
        }
        try {
          job = await api.claimJob(lane);
        } catch (e) {
          log('claim(' + lane + ') failed :: ' + e.message);
          stop = true;
          break;
        }
        if (!job) break;
        if (laneOf(job.type) !== lane) {
          log('job#' + job.id + ' ' + job.type + ' claimed on ' + lane + ' lane but lib/lanes.js says ' + laneOf(job.type));
        }
        claimed += 1;
        const p = runJob(job, lane).then(() => { active.delete(p); });
        active.add(p);
        if (claimed >= 50) {
          log('claimed 50 jobs in one ' + lane + ' drain, pausing until next wake or poll');
          ls.pendingWake = true;
          stop = true;
        }
      }
      if (active.size === 0) break;
      await Promise.race(active);
      if (stop && active.size === 0) break;
    }
    if (active.size) await Promise.all(active);
  } catch (e) {
    log('drain(' + lane + ') error :: ' + (e.stack || e.message));
    if (active.size) { try { await Promise.all(active); } catch (e2) { /* runJob never throws */ } }
  } finally {
    ls.busy = false;
    if (claimed > 0) log('drain(' + reason + ', ' + lane + ') finished, ' + claimed + ' job(s) processed');
    if (ls.pendingWake && !state.shuttingDown) {
      ls.pendingWake = false;
      setImmediate(() => drainLane('pending-wake', lane));
    }
  }
}

/** Kick every lane. Lanes run independently; this only fans the signal out. */
function drain(reason) {
  return Promise.all(LANE_NAMES.map((lane) => drainLane(reason, lane)));
}

function anyBusy() {
  return LANE_NAMES.some((lane) => state.lanes[lane].busy);
}

// ---------------------------------------------------------------------------
// blog client review sweep
// ---------------------------------------------------------------------------

/**
 * Ride along with the fallback poll: check whether any client has approved or
 * sent back a blog draft on its preview page. Read only plus a ledger write,
 * no fork, no model. Single flight, and it swallows everything: a resident
 * service must not die because a client site was down.
 */
async function blogReviewTick() {
  if (state.shuttingDown || state.sweepBusy) return;
  if (!cfg.blogReviewEnabled) return;
  state.sweepBusy = true;
  try {
    const res = await blogreview.sweep({ api, cfg, log });
    state.lastSweepAt = ts();
    state.lastSweep = res;
  } catch (e) {
    state.lastSweepAt = ts();
    state.lastSweep = { errors: 1, message: summarize((e && e.message) || String(e), 200) };
    log('blog review sweep error :: ' + ((e && e.stack) || e));
  } finally {
    state.sweepBusy = false;
  }
}

// ---------------------------------------------------------------------------
// wake server
// ---------------------------------------------------------------------------

function secretOk(given) {
  const a = Buffer.from(String(given || ''), 'utf8');
  const b = Buffer.from(String(cfg.wakeSecret), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = String(req.url || '').split('?')[0];

  if (req.method === 'GET' && (url === '/health' || url === '/')) {
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      state: anyBusy() ? 'busy' : 'idle',
      lanes: state.lanes,
      last_job: state.lastJob,
      jobs_done: state.jobsDone,
      jobs_failed: state.jobsFailed,
      last_error: state.lastError,
      blog_review_enabled: !!cfg.blogReviewEnabled,
      last_sweep_at: state.lastSweepAt,
      last_sweep: state.lastSweep,
      poll_interval_sec: cfg.pollIntervalSec,
      max_concurrent: cfg.maxConcurrent,
      uptime_sec: Math.round((Date.now() - state.startedAt) / 1000),
      now: ts(),
    });
    return;
  }

  if (req.method === 'POST' && url === '/wake') {
    if (!secretOk(req.headers['x-seo-secret'])) {
      log('wake rejected, bad or missing X-Seo-Secret from ' + (req.socket.remoteAddress || '?'));
      sendJson(res, 401, { ok: false, error: 'bad secret' });
      return;
    }
    // Drain the request body so the client sees a clean close, then answer.
    req.resume();
    req.on('end', () => {
      sendJson(res, 202, { ok: true, state: anyBusy() ? 'busy' : 'idle' });
      log('wake accepted');
      drain('wake');
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not found' });
});

server.on('error', (err) => {
  log('http server error :: ' + err.message);
  if (err.code === 'EADDRINUSE') process.exit(1);
});

server.listen(cfg.wakePort, cfg.bindHost, () => {
  log(
    'seo-worker ' +
      VERSION +
      ' listening on ' +
      cfg.bindHost +
      ':' +
      cfg.wakePort +
      ', api ' +
      cfg.apiBase +
      ', poll every ' +
      cfg.pollIntervalSec +
      's, job timeout ' +
      cfg.jobTimeoutMin +
      'min, lanes ' +
      LANE_NAMES.join('+')
  );
  // Startup reap then drain. Reap first: this worker is the only executor, so a
  // 'running' row at boot is always an orphan from a previous life (deploy
  // restart, crash, OOM). Recovery must not depend on the dying process having
  // cooperated (2026-09-04 job390 zombie). Reap failure does not block the
  // drain: better to run jobs past a zombie row than to run nothing.
  pendingTerminalFlush()
    .catch(() => {})
    .then(() => api.reapJobs())
    .then((r) => {
      const ids = (r && Array.isArray(r.reaped) && r.reaped) || [];
      if (ids.length) log('startup reap: ' + ids.length + ' orphaned running job(s) -> failed: #' + ids.join(' #'));
    })
    .catch((e) => log('startup reap failed :: ' + e.message))
    .finally(() => drain('startup'));
});

// Fallback poll. Claims only. If the table has no human queued job, nothing runs.
// The blog review sweep rides the same tick, after the drain so it never
// competes with a job for the box. It is independent of the drain's outcome.
// 条件巡检（F2，零 LLM）每 12 tick 一轮（默认 300s tick 即约每小时）：核对等条件任务，
// 满足的经 condition_met 续跑。巡检自身只读，续跑的授权在委托单那一次。
let probeTickCount = 0;
const pollTimer = setInterval(() => {
  pendingTerminalFlush().catch(() => {});
  drain('poll').then(blogReviewTick, blogReviewTick);
  probeTickCount += 1;
  if (probeTickCount % 12 === 0) {
    conditionProbeTick(api, log).catch((e) => log('条件巡检本轮异常 :: ' + e.message));
  }
}, cfg.pollIntervalSec * 1000);

// ---------------------------------------------------------------------------
// shutdown
// ---------------------------------------------------------------------------

function shutdown(signal) {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  log('received ' + signal + ', shutting down');
  clearInterval(pollTimer);
  server.close();
  // A running job dies with us (KillMode=mixed kills the child); its row is
  // reaped to failed by the startup reaper on next boot. Give the current
  // child a short grace period, then exit.
  setTimeout(() => process.exit(0), anyBusy() ? 5000 : 100).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  log('uncaughtException :: ' + (err.stack || err.message));
});
process.on('unhandledRejection', (err) => {
  log('unhandledRejection :: ' + ((err && err.stack) || String(err)));
});
