'use strict';
// Claude Code CLI runner.
//
// Hard rule: an LLM only ever starts from here, and this file is only ever
// reached while executing a job that a human created in the board. Nothing in
// this worker schedules an LLM call on a timer.

const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const trace = require('./trace');

// Every live claude process, so runner_host can tear them down on SIGTERM.
const liveChildren = new Set();

// WebSearch is in by default so verification tasks (GBP existence, listing
// checks) can self-serve from public sources instead of landing on the client.
const DEFAULT_ALLOWED_TOOLS = 'Read,Glob,Grep,WebFetch,WebSearch,Bash(curl:*)';

function childEnv() {
  const env = Object.assign({}, process.env);
  // The native installer puts claude in ~/.local/bin, which is often missing
  // from the PATH a systemd unit inherits.
  const extra = path.join(os.homedir(), '.local', 'bin');
  const parts = String(env.PATH || '').split(':');
  if (!parts.includes(extra)) env.PATH = extra + ':' + env.PATH;
  if (!env.HOME) env.HOME = os.homedir();
  return env;
}

function killTree(child, signal) {
  if (!child || child.killed) return;
  try {
    process.kill(-child.pid, signal);
  } catch (e) {
    try {
      child.kill(signal);
    } catch (e2) {
      /* already gone */
    }
  }
}

/** Kill every claude process this process started. Used on shutdown. */
function killAll(signal) {
  for (const child of liveChildren) killTree(child, signal || 'SIGTERM');
}

/**
 * 瞬时启动失败判定（2026-10-07 ticket #23/#24）：CLI spawn 后几秒内退出、一个字没产出、
 * stderr 也是空的，说明模型根本没开始跑（当时是 CLI 自身的瞬时故障，10-06 三分钟窗口里
 * 连死两个 job）。这类不是 LLM 工作的失败，是 runner 环境抖动，原地重试一次。
 * 纯函数，单测在 tests/llm.test.js。
 */
const SPAWN_FLAKE_MAX_MS = 30000;

/**
 * --output-format json 的封套解析（T1 trace，2026-10-25）。成功时 stdout 是一个
 * {type:'result', result:'<模型正文>', session_id, usage, total_cost_usd} 的 JSON，
 * 解出正文还给 runner（契约不变），session_id 等进 trace。解析不动原文：不是封套
 * （旗标关了、CLI 老版本、半截输出）一律原样返回，parsed=false。纯函数，单测在 tests/llm.test.js。
 */
function parseResultEnvelope(stdout) {
  const raw = String(stdout || '');
  const t = raw.trim();
  if (!t.startsWith('{') || t.indexOf('"type"') === -1) return { text: raw, parsed: false };
  try {
    const j = JSON.parse(t);
    if (j && j.type === 'result' && typeof j.result === 'string') {
      return {
        text: j.result,
        sessionId: j.session_id || null,
        usage: j.usage || null,
        costUsd: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
        parsed: true,
      };
    }
  } catch (e) { /* 不是封套 */ }
  return { text: raw, parsed: false };
}
function isSpawnFlake(code, stdout, stderr, durationMs, timedOut) {
  if (timedOut || code === 0) return false;
  if (durationMs >= SPAWN_FLAKE_MAX_MS) return false;
  return !String(stdout || '').trim() && !String(stderr || '').trim();
}

/**
 * Run `claude -p <prompt>` headless and capture stdout.
 * opts: { prompt, cwd, log, model, allowedTools, timeoutMs, label }
 * Resolves { stdout, stderr, durationMs }. Rejects on non zero exit or timeout.
 * No retries at the job level. A failure is a failure. The one exception is a
 * spawn flake (see isSpawnFlake): the model never started, so one in-place
 * retry masks nothing; a second flake rejects like before.
 */
async function runClaude(cfg, opts) {
  const log = opts.log || function () {};
  const label = opts.label || 'claude';
  try {
    return await runClaudeOnce(cfg, opts);
  } catch (e) {
    if (!e || !e.spawnFlake) throw e;
    log(label + ': CLI 启动即退且零输出，按瞬时环境故障原地重试一次（5 秒后）');
    await new Promise((r) => setTimeout(r, 5000));
    try {
      return await runClaudeOnce(cfg, opts);
    } catch (e2) {
      if (e2 && e2.spawnFlake) e2.message += '（原地重试一次仍启动即退）';
      throw e2;
    }
  }
}

/* spawn 超时的取值顺序：调用方显式 timeoutMs > runner_host 按 job 类型注入的
   llmTimeoutMsDefault > 基础 jobTimeoutMin。第二档是 2026-10-24 补的：listener 的
   job 看门狗早按 jobTimeoutMinByType 给 execute/apply 放宽到 60 分（2026-09-21 Alvin 批），
   但这里一直回落 30 分基础值，内层先杀外层白放宽，一天 8 例 1801s 腰斩
   （Oak #479、Midea #494/#1562 各两次、Badger #1025/#455/#1634）。 */
function resolveTimeoutMs(cfg, opts) {
  if (opts.timeoutMs) return opts.timeoutMs;
  if (cfg.llmTimeoutMsDefault) return cfg.llmTimeoutMsDefault;
  return (cfg.jobTimeoutMin || 30) * 60 * 1000;
}

function runClaudeOnce(cfg, opts) {
  const prompt = String(opts.prompt || '');
  if (!prompt.trim()) return Promise.reject(new Error('runClaude called with an empty prompt'));

  const log = opts.log || function () {};
  const model = opts.model || cfg.claudeModel || 'opus';
  const allowedTools = opts.allowedTools || DEFAULT_ALLOWED_TOOLS;
  const timeoutMs = resolveTimeoutMs(cfg, opts);
  const label = opts.label || 'claude';
  const args = ['-p', prompt, '--model', model, '--allowedTools', allowedTools];
  if (cfg.llmJsonEnvelope !== false) args.push('--output-format', 'json');

  log(
    label +
      ': spawn ' +
      cfg.claudeBin +
      ' -p <prompt ' +
      prompt.length +
      ' chars> --model ' +
      model +
      ' --allowedTools ' +
      allowedTools +
      ' (cwd ' +
      opts.cwd +
      ', timeout ' +
      Math.round(timeoutMs / 1000) +
      's)'
  );

  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(cfg.claudeBin, args, {
        cwd: opts.cwd,
        env: childEnv(),
        detached: true, // own process group, so we can kill the whole tree
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(new Error('failed to spawn ' + cfg.claudeBin + ' :: ' + e.message));
      return;
    }
    liveChildren.add(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });

    const softTimer = setTimeout(() => {
      timedOut = true;
      log(label + ': timeout reached, sending SIGTERM');
      killTree(child, 'SIGTERM');
      setTimeout(() => killTree(child, 'SIGKILL'), 10000).unref();
    }, timeoutMs);

    function finish(fn, arg) {
      if (settled) return;
      settled = true;
      clearTimeout(softTimer);
      liveChildren.delete(child);
      fn(arg);
    }

    child.on('error', (err) => {
      finish(reject, new Error('claude process error: ' + err.message));
    });

    /* trace 落账（成功与失败都记，失败的 trace 对复盘更值钱）。
       record 内部全程 try/catch，绝不反噬 job。 */
    function traceCall(ok, text, env2, error, durationMs) {
      trace.record({
        prompt,
        stdout: text,
        stderr,
        model,
        label,
        startedAt: new Date(started).toISOString(),
        durationMs,
        ok,
        error,
        sessionId: (env2 && env2.sessionId) || null,
        usage: (env2 && env2.usage) || null,
        costUsd: env2 ? env2.costUsd : null,
        cwd: opts.cwd,
      });
    }

    child.on('close', (code, signal) => {
      const durationMs = Date.now() - started;
      if (timedOut) {
        const msg = label + ': claude timed out after ' + Math.round(durationMs / 1000) + 's, killed';
        traceCall(false, stdout, parseResultEnvelope(stdout), 'timeout', durationMs);
        finish(reject, new Error(msg));
        return;
      }
      if (code !== 0) {
        const err = new Error(
          label +
            ': claude exited with code ' +
            code +
            (signal ? ' signal ' + signal : '') +
            ' :: stderr ' +
            stderr.replace(/\s+/g, ' ').slice(0, 800)
        );
        err.spawnFlake = isSpawnFlake(code, stdout, stderr, durationMs, timedOut);
        traceCall(false, stdout, parseResultEnvelope(stdout), 'exit ' + code, durationMs);
        finish(reject, err);
        return;
      }
      const env2 =
        cfg.llmJsonEnvelope !== false ? parseResultEnvelope(stdout) : { text: stdout, parsed: false };
      log(
        label +
          ': done in ' +
          Math.round(durationMs / 1000) +
          's, ' +
          env2.text.length +
          ' chars of output' +
          (env2.sessionId ? ', session ' + env2.sessionId : '')
      );
      traceCall(true, env2.text, env2, null, durationMs);
      finish(resolve, {
        stdout: env2.text,
        stderr,
        durationMs,
        sessionId: env2.sessionId || null,
        usage: env2.usage || null,
        costUsd: typeof env2.costUsd === 'number' ? env2.costUsd : null,
      });
    });
  });
}

module.exports = {
  runClaude,
  killAll,
  isSpawnFlake,
  resolveTimeoutMs,
  parseResultEnvelope,
  DEFAULT_ALLOWED_TOOLS,
};
