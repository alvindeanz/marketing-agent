#!/usr/bin/env node
/* 卡反馈折叠的纯逻辑单测。用例底稿是 Sammichelle #306 的真实反馈序列
   （2026-09-13：同项反复表态、测试提交、other 里埋新需求）。跑法：node tests/cardfold.test.js */
const assert = require('assert');
const { foldCardFeedback, summariseFold } = require('../seo-worker/lib/cardfold');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

const r = (item, choice, fb) => ({ item, choice, fb: fb || '', created_at: '2026-09-10 10:00:00' });

t('同一 item 反复表态取最后一次（sammichelle 商场词：同意 保持 保持 同意 = 同意）', () => {
  const f = foldCardFeedback([r('retailer_terms', 'agree'), r('retailer_terms', 'hold'), r('retailer_terms', 'hold'), r('retailer_terms', 'agree')]);
  assert.strictEqual(f.agreed.length, 1);
  assert.strictEqual(f.holds.length, 0);
  assert.strictEqual(f.agreed[0].item, 'retailer_terms');
});

t('other 不覆盖表态，文本单独保留', () => {
  const f = foldCardFeedback([r('keyword_plan', 'agree'), r('keyword_plan', 'other', 'suitcase 订单下滑帮我分析')]);
  assert.strictEqual(f.agreed.length, 1);
  assert.strictEqual(f.texts.length, 1);
  assert.ok(f.texts[0].text.includes('suitcase'));
});

t('空文本的 other 行不进 texts（api 层已转 hold，这里兜底）', () => {
  const f = foldCardFeedback([r('x', 'other', ''), r('x', 'other', '  ')]);
  assert.strictEqual(f.texts.length, 0);
  assert.strictEqual(f.agreed.length + f.holds.length, 0);
});

t('flag 算可执行确认，勾选清单在 fb 里', () => {
  const f = foldCardFeedback([r('cleanup_list', 'flag', 'asset 1,asset 3')]);
  assert.strictEqual(f.agreed.length, 1);
  assert.strictEqual(f.agreed[0].choice, 'flag');
  assert.strictEqual(f.agreed[0].fb, 'asset 1,asset 3');
});

t('无 item 的表态归 _card', () => {
  const f = foldCardFeedback([r('', 'agree')]);
  assert.strictEqual(f.agreed[0].item, '_card');
});

t('多项混合：最终每项一个归宿，摘要三段齐', () => {
  const f = foldCardFeedback([
    r('a', 'agree'), r('b', 'hold'), r('c', 'agree'), r('c', 'hold'),
    r('d', 'other', '换个说法'),
  ]);
  assert.deepStrictEqual(f.agreed.map((x) => x.item).sort(), ['a']);
  assert.deepStrictEqual(f.holds.map((x) => x.item).sort(), ['b', 'c']);
  assert.strictEqual(f.texts.length, 1);
  const s = summariseFold(f);
  assert.ok(s.includes('同意 1 项') && s.includes('保持观察 2 项') && s.includes('文本反馈 1 条'), s);
});

t('空输入不炸，hasAny false', () => {
  const f = foldCardFeedback([]);
  assert.strictEqual(f.hasAny, false);
  assert.strictEqual(summariseFold(f), '无有效表态');
});

t('未知 choice 忽略不炸', () => {
  const f = foldCardFeedback([{ item: 'x', choice: 'maybe', fb: '' }]);
  assert.strictEqual(f.agreed.length + f.holds.length + f.texts.length, 0);
});

console.log(pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
