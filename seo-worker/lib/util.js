'use strict';
// Small shared helpers: timestamps, date math, workspace paths.

const fs = require('node:fs');
const path = require('node:path');

function ts() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

/** Console logger with a timestamp and a tag prefix. */
function makeStdoutLogger(tag) {
  return function (line) {
    process.stdout.write('[' + ts() + '] [' + tag + '] ' + line + '\n');
  };
}

/** YYYY-MM-DD for a Date in UTC. */
function ymd(d) {
  return d.toISOString().slice(0, 10);
}

/** YYYY-MM-DD for a Date in the machine's local timezone, matching the server day. */
function localYmd(d) {
  const t = d || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
}

/** Date N days before today (UTC). */
function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

/**
 * Reporting window: end date is today minus lagDays (GSC data lag),
 * window is `days` long inclusive.
 */
function reportWindow(days, lagDays) {
  const end = daysAgo(lagDays);
  const start = new Date(end.getTime());
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: ymd(start), end: ymd(end) };
}

/** Directory name for a client inside workspaceRoot. */
function clientDirName(profile, cfg) {
  // 显式字段优先；都没有时从域名主机名推导（每个客户天然唯一），
  // 绝不回落 cfg.defaultClientDir：那个回落曾让所有缺配置的客户
  // 静默写进 powerdekorfloors 的目录，跨客户数据污染比报错严重得多。
  let raw = profile && (profile.workspace_dir || profile.slug || profile.dir);
  if (!raw && profile && profile.domain) {
    raw = String(profile.domain)
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, '');
  }
  if (!raw) {
    throw new Error('客户 profile 缺 workspace_dir 且无 domain 可推导工作目录，拒绝回落共享目录，请在档案里补 workspace_dir');
  }
  return String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'client';
}

/** Absolute workspace path for a client, created if missing. */
function ensureClientWorkspace(profile, cfg) {
  const dir = path.join(cfg.workspaceRoot, clientDirName(profile, cfg));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function truncate(str, n) {
  const s = String(str == null ? '' : str);
  return s.length <= n ? s : s.slice(0, n);
}

/** Collapse whitespace and cut to n chars, for API note fields. */
function summarize(str, n) {
  return truncate(String(str == null ? '' : str).replace(/\s+/g, ' ').trim(), n);
}

function safeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch (e) {
    return fallback;
  }
}

module.exports = {
  ts,
  ymd,
  localYmd,
  daysAgo,
  reportWindow,
  makeStdoutLogger,
  clientDirName,
  ensureClientWorkspace,
  truncate,
  summarize,
  safeJson,
};
