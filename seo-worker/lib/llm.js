'use strict';
// Claude Code CLI runner.
//
// Hard rule: an LLM only ever starts from here, and this file is only ever
// reached while executing a job that a human created in the board. Nothing in
// this worker schedules an LLM call on a timer.

const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

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

function runClaudeOnce(cfg, opts) {
  const prompt = String(opts.prompt || '');
  if (!prompt.trim()) return Promise.reject(new Error('runClaude called with an empty prompt'));

  const log = opts.log || function () {};
  const model = opts.model || cfg.claudeModel || 'opus';
  const allowedTools = opts.allowedTools || DEFAULT_ALLOWED_TOOLS;
  const timeoutMs = opts.timeoutMs || (cfg.jobTimeoutMin || 30) * 60 * 1000;
  const label = opts.label || 'claude';
  const args = ['-p', prompt, '--model', model, '--allowedTools', allowedTools];

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

    child.on('close', (code, signal) => {
      const durationMs = Date.now() - started;
      if (timedOut) {
        finish(
          reject,
          new Error(
            label + ': claude timed out after ' + Math.round(durationMs / 1000) + 's, killed'
          )
        );
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
        finish(reject, err);
        return;
      }
      log(
        label +
          ': done in ' +
          Math.round(durationMs / 1000) +
          's, ' +
          stdout.length +
          ' chars of output'
      );
      finish(resolve, { stdout, stderr, durationMs });
    });
  });
}

module.exports = { runClaude, killAll, isSpawnFlake, DEFAULT_ALLOWED_TOOLS };
