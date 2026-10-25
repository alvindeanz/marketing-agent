#!/usr/bin/env node
/* llm.js 瞬时启动失败判定（isSpawnFlake）的单测。
   跑法：node tests/llm.test.js
   背景：2026-10-06 ros 上 claude CLI 三分钟窗口内连死两个 job（4 秒退出码 1，零输出），
   这类 spawn 抖动原地重试一次；真失败（有输出、超时、跑了很久）绝不吃进重试。 */
const assert = require('assert');
const { isSpawnFlake, resolveTimeoutMs, parseResultEnvelope } = require('../seo-worker/lib/llm');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

t('4 秒退出码 1 零输出是 flake（10-06 实案）', () => {
  assert.strictEqual(isSpawnFlake(1, '', '', 4000, false), true);
  assert.strictEqual(isSpawnFlake(1, '  \n', ' ', 4000, false), true, '空白等于空');
});

t('有 stderr 的真报错不是 flake', () => {
  assert.strictEqual(isSpawnFlake(1, '', 'Invalid API key', 4000, false), false);
});

t('有 stdout 的半截产出不是 flake', () => {
  assert.strictEqual(isSpawnFlake(1, '# 方案写了一半', '', 4000, false), false);
});

t('跑满 30 秒以上不是 flake（模型已经在干活）', () => {
  assert.strictEqual(isSpawnFlake(1, '', '', 30000, false), false);
  assert.strictEqual(isSpawnFlake(1, '', '', 120000, false), false);
});

t('超时与正常退出都不是 flake', () => {
  assert.strictEqual(isSpawnFlake(null, '', '', 4000, true), false, 'timedOut');
  assert.strictEqual(isSpawnFlake(0, '', '', 4000, false), false, 'exit 0');
});

t('spawn 超时取值：显式 > 分档注入 > 基础 jobTimeoutMin', () => {
  assert.strictEqual(resolveTimeoutMs({ jobTimeoutMin: 30 }, { timeoutMs: 1000 }), 1000, '调用方显式优先');
  assert.strictEqual(resolveTimeoutMs({ jobTimeoutMin: 30, llmTimeoutMsDefault: 55 * 60000 }, {}), 55 * 60000, 'runner_host 注入的分档值');
  assert.strictEqual(resolveTimeoutMs({ jobTimeoutMin: 30 }, {}), 30 * 60000, '基础值兜底');
  assert.strictEqual(resolveTimeoutMs({}, {}), 30 * 60000, '缺配置默认 30 分');
});

t('execute/apply 的 1801s 腰斩口径：60 分档注入后内层应拿 55 分', () => {
  // runner_host 的注入算式：max(typedMin - 5, jobTimeoutMin) * 60000
  const typedMin = 60, base = 30;
  const injected = Math.max(typedMin - 5, base) * 60000;
  assert.strictEqual(resolveTimeoutMs({ jobTimeoutMin: base, llmTimeoutMsDefault: injected }, {}), 55 * 60000);
});

t('封套解析：result 正文还给 runner，session 与用量进 trace（T1）', () => {
  const env = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false,
    result: '# 方案\n正文', session_id: 'abc-123', total_cost_usd: 0.05,
    usage: { input_tokens: 10 },
  });
  const p = parseResultEnvelope(env);
  assert.strictEqual(p.parsed, true);
  assert.strictEqual(p.text, '# 方案\n正文');
  assert.strictEqual(p.sessionId, 'abc-123');
  assert.strictEqual(p.costUsd, 0.05);
  assert.strictEqual(p.usage.input_tokens, 10);
});

t('封套解析：不是封套一律原样返回（旗标关闭/老 CLI/半截输出）', () => {
  assert.strictEqual(parseResultEnvelope('普通文本输出').parsed, false);
  assert.strictEqual(parseResultEnvelope('普通文本输出').text, '普通文本输出');
  assert.strictEqual(parseResultEnvelope('{"type":"result"').parsed, false, '半截 JSON 原样');
  assert.strictEqual(parseResultEnvelope('{"foo":1}').parsed, false, '无 type 字段原样');
  assert.strictEqual(parseResultEnvelope('{"type":"result","result":null}').parsed, false, 'result 非字符串原样');
  assert.strictEqual(parseResultEnvelope('').text, '');
});

t('封套解析：模型正文自己是 JSON 时不被二次解包', () => {
  const inner = '{"tasks":[1,2]}';
  const env = JSON.stringify({ type: 'result', result: inner, session_id: 's' });
  const p = parseResultEnvelope(env);
  assert.strictEqual(p.parsed, true);
  assert.strictEqual(p.text, inner, '只解一层封套');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
