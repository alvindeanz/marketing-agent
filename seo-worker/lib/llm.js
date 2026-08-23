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
 * Run `claude -p <prompt>` headless and capture stdout.
 * opts: { prompt, cwd, log, model, allowedTools, timeoutMs, label }
 * Resolves { stdout, stderr, durationMs }. Rejects on non zero exit or timeout.
 * No retries anywhere. A failure is a failure.
 */
function runClaude(cfg, opts) {
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
        finish(
          reject,
          new Error(
            label +
              ': claude exited with code ' +
              code +
              (signal ? ' signal ' + signal : '') +
              ' :: stderr ' +
              stderr.replace(/\s+/g, ' ').slice(0, 800)
          )
        );
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

module.exports = { runClaude, killAll, DEFAULT_ALLOWED_TOOLS };
