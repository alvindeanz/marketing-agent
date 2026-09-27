'use strict';
// release_review.cleanVerdicts 的形状清洗：非法降 hold_human、缺席补 hold_human、越批丢弃。
const assert = require('node:assert');
const rr = require('../seo-worker/runners/release_review');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' :: ' + e.message); }
}

t('合法 release 原样通过', () => {
  const r = rr.cleanVerdicts({ verdicts: [{ task_id: 1, verdict: 'release', reason: '批文覆盖，数据一致', conflicts: [] }] }, [1]);
  assert.strictEqual(r.verdicts[0].verdict, 'release');
  assert.strictEqual(r.verdicts[0].task_id, 1);
});

t('非法判决值降 hold_human', () => {
  const r = rr.cleanVerdicts({ verdicts: [{ task_id: 1, verdict: 'approve', reason: 'x' }] }, [1]);
  assert.strictEqual(r.verdicts[0].verdict, 'hold_human');
});

t('release 无 reason 降 hold_human', () => {
  const r = rr.cleanVerdicts({ verdicts: [{ task_id: 1, verdict: 'release', reason: '' }] }, [1]);
  assert.strictEqual(r.verdicts[0].verdict, 'hold_human');
});

t('缺席任务补 hold_human', () => {
  const r = rr.cleanVerdicts({ verdicts: [{ task_id: 1, verdict: 'release', reason: 'ok' }] }, [1, 2]);
  assert.strictEqual(r.verdicts.length, 2);
  assert.strictEqual(r.verdicts[1].task_id, 2);
  assert.strictEqual(r.verdicts[1].verdict, 'hold_human');
});

t('越批 task_id 丢弃', () => {
  const r = rr.cleanVerdicts({ verdicts: [{ task_id: 9, verdict: 'release', reason: 'x' }] }, [1]);
  assert.strictEqual(r.verdicts.length, 1);
  assert.strictEqual(r.verdicts[0].task_id, 1);
  assert.strictEqual(r.verdicts[0].verdict, 'hold_human');
});

t('hold_human 的 conflicts 保留且截断', () => {
  const r = rr.cleanVerdicts({ verdicts: [{ task_id: 1, verdict: 'hold_human', reason: 'x', conflicts: ['1', '3', '4', '5', '6', '2', '1'] }] }, [1]);
  assert.strictEqual(r.verdicts[0].conflicts.length, 6);
});

t('重复判决只认第一条', () => {
  const r = rr.cleanVerdicts({ verdicts: [
    { task_id: 1, verdict: 'release', reason: 'a' },
    { task_id: 1, verdict: 'hold_human', reason: 'b' },
  ] }, [1]);
  assert.strictEqual(r.verdicts[0].verdict, 'release');
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
