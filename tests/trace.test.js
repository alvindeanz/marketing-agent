#!/usr/bin/env node
/* T1 trace 落盘（lib/trace.js）单测。跑法：node tests/trace.test.js
   纪律断言：trace 是账本不是闸，任何失败场景 record/init 都不许抛错。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const trace = require('../seo-worker/lib/trace');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'));
const cfg = { traceDir: path.join(tmp, 'traces'), workerId: 'test', configPath: path.join(tmp, 'config.json'), traceRetentionDays: 180 };

t('init + record 成功路径：四件套齐全，meta 字段对', () => {
  trace._reset();
  trace.init(cfg, { id: 42, type: 'execute_task', client_id: 7 });
  const meta = trace.record({
    prompt: '测试 prompt', stdout: '模型正文', stderr: '', model: 'opus', label: 'x',
    startedAt: '2026-10-25T00:00:00Z', durationMs: 1234, ok: true, cwd: '/tmp',
    sessionId: null, usage: { input_tokens: 1 }, costUsd: 0.01,
  });
  assert.ok(meta, 'record 返回 meta');
  const dir = path.join(cfg.traceDir, '7', '42-execute_task');
  assert.ok(fs.existsSync(path.join(dir, '01.prompt.md')));
  assert.ok(fs.existsSync(path.join(dir, '01.stdout.md')));
  assert.strictEqual(fs.readFileSync(path.join(dir, '01.stdout.md'), 'utf8'), '模型正文');
  const m = JSON.parse(fs.readFileSync(path.join(dir, '01.meta.json'), 'utf8'));
  assert.strictEqual(m.job_id, 42);
  assert.strictEqual(m.client_id, 7);
  assert.strictEqual(m.worker_id, 'test');
  assert.strictEqual(m.specs_rev, 'dev', '无 DEPLOYED 文件记 dev');
  assert.strictEqual(m.ok, true);
  assert.strictEqual(m.cost_usd, 0.01);
});

t('同 job 第二次调用序号递增，失败也记账', () => {
  const meta = trace.record({ prompt: 'p2', stdout: '半截', ok: false, error: 'exit 1', durationMs: 5, cwd: '/tmp' });
  assert.ok(meta);
  const dir = path.join(cfg.traceDir, '7', '42-execute_task');
  assert.ok(fs.existsSync(path.join(dir, '02.meta.json')));
  const m = JSON.parse(fs.readFileSync(path.join(dir, '02.meta.json'), 'utf8'));
  assert.strictEqual(m.ok, false);
  assert.strictEqual(m.error, 'exit 1');
});

t('session jsonl：有 sessionId 但文件缺失记 missing，复制成功记文件名', () => {
  trace._reset();
  trace.init(cfg, { id: 43, type: 'chat', client_id: 7 });
  const m1 = trace.record({ prompt: 'p', stdout: 's', ok: true, cwd: '/tmp', sessionId: 'no-such-session' });
  assert.strictEqual(m1.session_log, 'missing');
  // 造一个真实位置的 session 文件再记一次
  const sid = 'test-session-' + Date.now();
  const sdir = path.dirname(trace.sessionLogPath('/tmp', sid));
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(trace.sessionLogPath('/tmp', sid), '{"type":"x"}\n');
  const m2 = trace.record({ prompt: 'p', stdout: 's', ok: true, cwd: '/tmp', sessionId: sid });
  assert.strictEqual(m2.session_log, '02.session.jsonl');
  fs.rmSync(trace.sessionLogPath('/tmp', sid));
});

t('sessionLogPath 打散规则：/ 与 . 变 -', () => {
  const p = trace.sessionLogPath('/data/aira/clients/x.y', 'abc');
  assert.ok(p.endsWith(path.join('.claude', 'projects', '-data-aira-clients-x-y', 'abc.jsonl')), p);
  assert.strictEqual(trace.sessionLogPath('', 'abc'), null);
  assert.strictEqual(trace.sessionLogPath('/tmp', ''), null);
});

t('未 init 时 record 是 no-op，不抛错', () => {
  trace._reset();
  assert.strictEqual(trace.record({ prompt: 'x' }), null);
});

t('init 入参残缺不抛错，保持未初始化', () => {
  trace._reset();
  trace.init(null, null);
  trace.init({}, { id: 1 });
  trace.init(cfg, {});
  assert.strictEqual(trace.record({ prompt: 'x' }), null);
});

t('prune：过期 job 目录删除，golden 与新目录保留', () => {
  const root = path.join(tmp, 'prune');
  const pcfg = { traceDir: root, traceRetentionDays: 180, configPath: cfg.configPath, workerId: 'test' };
  const oldDir = path.join(root, '9', '1-plan');
  const newDir = path.join(root, '9', '2-plan');
  const golden = path.join(root, 'golden', 'good');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  fs.mkdirSync(golden, { recursive: true });
  const old = new Date(Date.now() - 200 * 86400000);
  fs.utimesSync(oldDir, old, old);
  const goldenOld = path.join(root, 'golden');
  fs.utimesSync(goldenOld, old, old);
  trace.prune(pcfg);
  assert.ok(!fs.existsSync(oldDir), '过期目录应删');
  assert.ok(fs.existsSync(newDir), '新目录应留');
  assert.ok(fs.existsSync(golden), 'golden 永不清扫');
  // 标记文件限频：同日二跑不再动文件
  const oldDir2 = path.join(root, '9', '3-plan');
  fs.mkdirSync(oldDir2, { recursive: true });
  fs.utimesSync(oldDir2, old, old);
  trace.prune(pcfg);
  assert.ok(fs.existsSync(oldDir2), '24h 内第二次 prune 应被标记文件挡住');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
