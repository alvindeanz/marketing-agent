'use strict';
// The internal seoq gate, shared by pull_data and discover.
//
// The worker never talks to SEMrush directly. seoq carries its own 24 hour
// cache, so repeat calls are cheap. stdout is always a single JSON object,
// including on the gate refusal exit code 77. stderr is human progress, dropped.

const { execFile } = require('node:child_process');
const { truncate } = require('./util');

const SEOQ_TIMEOUT_MS = 90000;

// Only these subcommands may ever be run. The discover runner lets a model
// propose follow up calls, so this list is a security boundary, not a hint.
const ALLOWED_SUBCOMMANDS = [
  'competitors',
  'rankings',
  'keyword-gap',
  'domain-overview',
  'backlinks',
  'keywords',
  'backlink-gap',
];

// Conservative argument charset. Anything outside it could reach a remote shell.
const SAFE_ARG_RE = /^[A-Za-z0-9 ._,:/@=+-]*$/;

/** powerdekorfloors.co.nz from https://www.powerdekorfloors.co.nz/ */
function rootDomain(profile) {
  const raw = (profile && (profile.domain || profile.website || profile.url)) || '';
  return String(raw)
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./i, '')
    .toLowerCase();
}

/**
 * Check a subcommand string before it is handed to ssh.
 * Returns { ok: true, command } or { ok: false, reason }.
 */
function sanitizeSubcommand(input) {
  const cmd = String(input == null ? '' : input).trim();
  if (!cmd) return { ok: false, reason: 'empty command' };
  if (!SAFE_ARG_RE.test(cmd)) {
    return { ok: false, reason: 'contains characters that are not allowed in a gate command' };
  }
  const name = cmd.split(/\s+/)[0];
  if (!ALLOWED_SUBCOMMANDS.includes(name)) {
    return {
      ok: false,
      reason: 'subcommand "' + name + '" is not on the allow list (' + ALLOWED_SUBCOMMANDS.join(', ') + ')',
    };
  }
  return { ok: true, command: cmd };
}

/** A hard cap on gate calls for one job. Spending past the cap throws. */
class CallBudget {
  constructor(max, log) {
    this.max = Number(max) || 0;
    this.used = 0;
    this.log = log || function () {};
  }

  get remaining() {
    return Math.max(0, this.max - this.used);
  }

  /** Returns false instead of throwing, callers decide how to degrade. */
  take(label) {
    if (this.used >= this.max) {
      this.log('seoq budget exhausted (' + this.used + '/' + this.max + '), skipping ' + label);
      return false;
    }
    this.used += 1;
    return true;
  }
}

/**
 * Run one seoq subcommand over ssh. Resolves the parsed object, rejects with a
 * readable error. Never retries.
 */
function seoq(cfg, subcommand, log) {
  const checked = sanitizeSubcommand(subcommand);
  if (!checked.ok) {
    return Promise.reject(new Error('refused to run "' + subcommand + '" :: ' + checked.reason));
  }
  return new Promise((resolve, reject) => {
    log('seoq: ssh ' + cfg.seoqSsh + ' "' + checked.command + '"');
    const started = Date.now();
    execFile(
      'ssh',
      ['-o', 'BatchMode=yes', cfg.seoqSsh, checked.command],
      { timeout: SEOQ_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const secs = Math.round((Date.now() - started) / 1000);
        const out = String(stdout || '').trim();
        let parsed = null;
        if (out) {
          try {
            parsed = JSON.parse(out);
          } catch (e) {
            parsed = null;
          }
        }
        if (!parsed) {
          const why = err
            ? err.killed
              ? 'timed out after ' + SEOQ_TIMEOUT_MS / 1000 + 's'
              : 'exit code ' + err.code + ' ' + err.message
            : 'no JSON on stdout';
          reject(
            new Error(
              'seoq "' +
                checked.command +
                '" ' +
                why +
                ' :: stdout ' +
                truncate(out.replace(/\s+/g, ' '), 300) +
                ' :: stderr ' +
                truncate(String(stderr || '').replace(/\s+/g, ' '), 300)
            )
          );
          return;
        }
        // seoq answers status 'ok' on a live fetch and 'cached' when serving
        // from its own 24h store; both carry valid data.
        if (parsed.status !== 'ok' && parsed.status !== 'cached') {
          reject(
            new Error(
              'seoq "' +
                checked.command +
                '" returned status ' +
                parsed.status +
                ' :: ' +
                truncate(
                  typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error),
                  400
                )
            )
          );
          return;
        }
        log('seoq: ok in ' + secs + 's, ' + out.length + ' bytes');
        resolve(parsed);
      }
    );
  });
}

/** Unwrap the seoq envelope, which nests the useful payload under data. */
function payloadOf(part) {
  if (!part) return null;
  if (part.data && typeof part.data === 'object') return part.data;
  return part;
}

/** Find the first array in a seoq payload, trying the usual key names. */
function rowsOf(part, keys) {
  const payload = payloadOf(part);
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  const candidates = (keys || []).concat([
    'rows',
    'items',
    'results',
    'data',
    'keywords',
    'competitors',
    'rankings',
  ]);
  for (const key of candidates) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

module.exports = {
  seoq,
  rootDomain,
  sanitizeSubcommand,
  CallBudget,
  payloadOf,
  rowsOf,
  ALLOWED_SUBCOMMANDS,
  SEOQ_TIMEOUT_MS,
};
