'use strict';
// T1 trace 落盘（PLAN W18，2026-10-25 Alvin 批）：每次 LLM 调用的完整输入输出归档，
// 让日后的总结优化有 trace 可回放（judge 校准、经验蒸馏、prompt 优化全吃这个）。
//
// 形态：<traceDir>/<client_id>/<job_id>-<job_type>/ 下按调用序号落四件：
//   NN.prompt.md（组装后的完整 prompt）/ NN.stdout.md（模型正文）/
//   NN.meta.json（model、label、时长、specs_rev、worker、session_id、用量）/
//   NN.session.jsonl（claude CLI 的完整工具轨迹，复制自 ~/.claude/projects，best effort）
//
// 纪律：这是账本不是闸。任何一步失败只静默跳过，绝不挡 job、绝不抛错进 runner。
// runner_host 一 job 一进程，模块级上下文天然按 job 隔离；目录按 job_id 唯一，
// 双 worker 并发不相撞（硬规矩 8）。golden/ 子目录是人工标注集，清扫永不碰它。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let ctx = null;

/** 部署目录的 DEPLOYED 文件记 rev（deploy.sh 写）。仓库直跑没有它，记 dev。 */
function specsRevFor(cfg) {
  try {
    const p = path.join(path.dirname(String(cfg.configPath || '')), 'DEPLOYED');
    const m = fs.readFileSync(p, 'utf8').match(/[0-9a-f]{7,40}/);
    if (m) return m[0];
  } catch (e) { /* 仓库直跑或文件缺失 */ }
  return 'dev';
}

/** headless claude 的会话 jsonl 落点：~/.claude/projects/<cwd 打散>/<sessionId>.jsonl */
function sessionLogPath(cwd, sessionId) {
  if (!cwd || !sessionId) return null;
  const slug = path.resolve(String(cwd)).replace(/[/.]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug, String(sessionId) + '.jsonl');
}

/** runner_host 在 runner.run 之前调一次。cfg/job 不全就保持未初始化（record 全程 no-op）。 */
function init(cfg, job) {
  ctx = null;
  try {
    if (!cfg || !cfg.traceDir || !job || !job.id) return;
    const dir = path.join(
      String(cfg.traceDir),
      String(job.client_id || 0),
      String(job.id) + '-' + String(job.type || 'job').replace(/[^a-zA-Z0-9_-]/g, '')
    );
    fs.mkdirSync(dir, { recursive: true });
    ctx = {
      dir,
      jobId: job.id,
      clientId: job.client_id || 0,
      type: String(job.type || ''),
      workerId: String(cfg.workerId || ''),
      specsRev: specsRevFor(cfg),
      seq: 0,
    };
    prune(cfg);
  } catch (e) {
    ctx = null;
  }
}

/**
 * llm.js 每次 claude 调用结束（成功或失败）调一次。
 * entry: { prompt, stdout, stderr, model, label, startedAt, durationMs, ok, error,
 *          sessionId, usage, costUsd, cwd }
 * 返回写出的 meta（给测试断言），未初始化或写失败返回 null。
 */
function record(entry) {
  if (!ctx) return null;
  try {
    ctx.seq += 1;
    const n = String(ctx.seq).padStart(2, '0');
    const e = entry || {};
    fs.writeFileSync(path.join(ctx.dir, n + '.prompt.md'), String(e.prompt || ''));
    fs.writeFileSync(path.join(ctx.dir, n + '.stdout.md'), String(e.stdout || ''));
    let sessionLog = null;
    const src = sessionLogPath(e.cwd, e.sessionId);
    if (src) {
      try {
        fs.copyFileSync(src, path.join(ctx.dir, n + '.session.jsonl'));
        sessionLog = n + '.session.jsonl';
      } catch (err) {
        sessionLog = 'missing';
      }
    }
    const meta = {
      job_id: ctx.jobId,
      client_id: ctx.clientId,
      job_type: ctx.type,
      worker_id: ctx.workerId,
      specs_rev: ctx.specsRev,
      label: String(e.label || ''),
      model: String(e.model || ''),
      started_at: e.startedAt || null,
      duration_ms: Number(e.durationMs) || 0,
      ok: !!e.ok,
      error: e.error ? String(e.error).slice(0, 500) : null,
      prompt_chars: String(e.prompt || '').length,
      stdout_chars: String(e.stdout || '').length,
      stderr_tail: e.stderr ? String(e.stderr).slice(-500) : '',
      session_id: e.sessionId || null,
      session_log: sessionLog,
      usage: e.usage || null,
      cost_usd: typeof e.costUsd === 'number' ? e.costUsd : null,
      cwd: e.cwd || null,
    };
    fs.writeFileSync(path.join(ctx.dir, n + '.meta.json'), JSON.stringify(meta, null, 1));
    return meta;
  } catch (err) {
    return null;
  }
}

/** 日度清扫：满 retention 的 job 目录删掉。标记文件限频，失败不挡 job。golden/ 永不碰。 */
function prune(cfg) {
  try {
    const root = String(cfg.traceDir);
    const marker = path.join(root, '.last_prune');
    const now = Date.now();
    try {
      if (now - fs.statSync(marker).mtimeMs < 24 * 3600 * 1000) return;
    } catch (e) { /* 首跑无标记 */ }
    fs.writeFileSync(marker, new Date().toISOString());
    const keepMs = (Number(cfg.traceRetentionDays) || 180) * 24 * 3600 * 1000;
    for (const c of fs.readdirSync(root)) {
      if (c.startsWith('.') || c === 'golden') continue;
      const cdir = path.join(root, c);
      let st;
      try { st = fs.statSync(cdir); } catch (e) { continue; }
      if (!st.isDirectory()) continue;
      for (const j of fs.readdirSync(cdir)) {
        const jdir = path.join(cdir, j);
        try {
          if (now - fs.statSync(jdir).mtimeMs > keepMs) fs.rmSync(jdir, { recursive: true, force: true });
        } catch (e) { /* 单目录失败跳过 */ }
      }
    }
  } catch (e) { /* 清扫失败不挡 job */ }
}

/** 测试用：重置上下文。 */
function _reset() { ctx = null; }

module.exports = { init, record, prune, sessionLogPath, specsRevFor, _reset };
