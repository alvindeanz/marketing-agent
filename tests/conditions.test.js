#!/usr/bin/env node
/* F2 条件巡检的纯逻辑单测：日期条件、manual_signal、未知语法、缺 customer_id 的 ad_approved。
   GAQL 路径不在这里测（要真账户），首跑纪律照旧盯 log。跑法：node tests/conditions.test.js */
const assert = require('assert');
const { checkCondition } = require('../seo-worker/lib/conditions');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

t('after: 过去日期满足，未来日期不满足', () => {
  assert.strictEqual(checkCondition('after:2020-01-01', '', null).met, true);
  assert.strictEqual(checkCondition('after:2099-01-01', '', null).met, false);
});

t('manual_signal 巡检永远不裁', () => {
  assert.strictEqual(checkCondition('manual_signal:等客户横图', '123', null).met, false);
});

t('未知语法按未满足，不炸', () => {
  assert.strictEqual(checkCondition('approved_when_ready', '123', null).met, false);
  assert.strictEqual(checkCondition('', '123', null).met, false);
});

t('ad_approved 缺 customer_id 不发查询直接未满足', () => {
  assert.strictEqual(checkCondition('ad_approved:824204552784', '', null).met, false);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
