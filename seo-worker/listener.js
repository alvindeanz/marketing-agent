'use strict';
// SEO agent worker: long lived listener.
//
// State machine, in one breath, per lane: idle -> drain (claim jobs one at a
// time until the API returns {job:null}) -> idle. A wake or a poll tick that
// lands while a drain is running only sets pendingWake, and the drain reruns
// once it finishes. Two lanes (lib/lanes.js): heavy (site writers, minutes)
// and light (board only, seconds). Each lane is single flight on its own, so
// a light job never waits behind a heavy one and two heavy jobs never overlap.
//
// Hard rule: nothing here starts an LLM on a schedule. The poll tick only asks
// the API whether a human queued a job. Empty queue means the worker does
// nothing at all.

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { fork } = require('node:child_process');

const { load } = require('./lib/config');
const { Api } = require('./lib/api');
const blogreview = require('./lib/blogreview');
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
const api = new Api(cfg);

function laneState() {
  return { busy: false, pendingWake: false, currentJob: null, lastDrainAt: null, lastDrainReason: null };
}

const state = {
  lanes: { heavy: laneState(), light: laneState() },
  startedAt: Date.now(),
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
    ls.currentJob = { id: job.id, type: job.type, client_id: job.client_id, startedAt: Date.now() };

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
      ls.currentJob = null;

      if (err) {
        push('FAILED: ' + (err.stack || err.message));
        state.jobsFailed += 1;
        state.lastError = { job_id: job.id, at: ts(), message: summarize(err.message, 300) };
        log(jobTag + ': FAILED :: ' + summarize(err.message, 400));
      } else {
        push('job completed ok');
        state.jobsDone += 1;
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
      }
      // No retry. A failed job stays failed until a human queues a new one.
      resolve();
    }
  });
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
  try {
    for (;;) {
      if (state.shuttingDown) break;
      let job;
      try {
        job = await api.claimJob(lane);
      } catch (e) {
        log('claim(' + lane + ') failed :: ' + e.message);
        break;
      }
      if (!job) break;
      if (laneOf(job.type) !== lane) {
        // The server filed it elsewhere. Run it anyway rather than leak a
        // claimed job, but say so: the two lane tables have drifted.
        log('job#' + job.id + ' ' + job.type + ' claimed on ' + lane + ' lane but lib/lanes.js says ' + laneOf(job.type));
      }
      claimed += 1;
      await runJob(job, lane);
      if (claimed >= 50) {
        // Safety valve against a runaway queue. Next drain picks up the rest.
        log('claimed 50 jobs in one ' + lane + ' drain, pausing until next wake or poll');
        ls.pendingWake = true;
        break;
      }
    }
  } catch (e) {
    log('drain(' + lane + ') error :: ' + (e.stack || e.message));
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
  // Startup drain: pick up anything queued while the worker was down.
  drain('startup');
});

// Fallback poll. Claims only. If the table has no human queued job, nothing runs.
// The blog review sweep rides the same tick, after the drain so it never
// competes with a job for the box. It is independent of the drain's outcome.
const pollTimer = setInterval(() => {
  drain('poll').then(blogReviewTick, blogReviewTick);
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
  // A running job is left to its own timeout handling on restart. Give the
  // current child a short grace period, then exit.
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
