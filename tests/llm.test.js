#!/usr/bin/env node
/* llm.js 瞬时启动失败判定（isSpawnFlake）的单测。
   跑法：node tests/llm.test.js
   背景：2026-10-06 ros 上 claude CLI 三分钟窗口内连死两个 job（4 秒退出码 1，零输出），
   这类 spawn 抖动原地重试一次；真失败（有输出、超时、跑了很久）绝不吃进重试。 */
const assert = require('assert');
const { isSpawnFlake } = require('../seo-worker/lib/llm');

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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
