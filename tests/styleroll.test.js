#!/usr/bin/env node
/* Style Roll 骨架轮换。跑法：node tests/styleroll.test.js。零网络零模型。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const R = require(path.join(__dirname, '..', 'seo-worker', 'lib', 'styleroll'));
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }
const brief3545 = fs.readFileSync(path.join(__dirname, 'fixtures', 'brief_task-3545.txt'), 'utf8');
/* 找一个会落到 Cost Breakdown 的 postCount，不写死轮换公式。 */
let costCount = -1;
for (let i = 0; i < 10; i++) if (R.roll({ postCount: i }).skeleton.label === 'Cost Breakdown') { costCount = i; break; }
console.log('任务书明令不写价格时不落 Cost Breakdown（Louvresky #3545 任务书回放）');
t('夹具任务书被认出是禁价', () => assert.ok(R.briefBansPrices(brief3545)));
t('轮到 Cost Breakdown 时顺延', () => {
  assert.ok(costCount >= 0);
  const r = R.roll({ postCount: costCount, briefText: brief3545 });
  assert.notStrictEqual(r.skeleton.label, 'Cost Breakdown');
  assert.ok(r.notes.some((n) => n.indexOf('不写价格') > -1));
});
t('顺延不撞上一篇骨架', () => {
  const next = R.roll({ postCount: costCount + 1 }).skeleton.label;
  const r = R.roll({ postCount: costCount, briefText: brief3545, previousSkeletonLabel: next });
  assert.notStrictEqual(r.skeleton.label, 'Cost Breakdown');
  assert.notStrictEqual(r.skeleton.label, next);
});
t('没有禁价令的任务书照常落 Cost Breakdown（豁免面）', () => {
  assert.strictEqual(R.roll({ postCount: costCount, briefText: '[配额博客 S6] 选题在锁定词表内自定，按客户 facts 里的博客规范写稿。' }).skeleton.label, 'Cost Breakdown');
  assert.strictEqual(R.roll({ postCount: costCount, briefText: '新博文：rangehood installation cost nz，价格区间按 fact 写' }).skeleton.label, 'Cost Breakdown');
  assert.strictEqual(R.roll({ postCount: costCount }).skeleton.label, 'Cost Breakdown');
});
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
