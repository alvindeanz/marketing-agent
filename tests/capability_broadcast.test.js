'use strict';
/* 能力断言匹配的单测（capability_broadcast 的纯件 lib/capclaim）。
   用例取自真实事故文本：#1310（放行官拆单措辞）、#663（泛断言）、#1274（CLI 命令名对不上）。 */
const assert = require('assert');
const path = require('path');
const { matchCapabilityClaim } = require(path.join(__dirname, '..', 'seo-worker', 'lib', 'capclaim'));

let n = 0, bad = 0;
function t(name, fn) { n++; try { fn(); console.log('  ok   ' + name); } catch (e) { bad++; console.error('  FAIL ' + name + ' :: ' + e.message); } }

t('标准措辞「缺执行器 X」强命中', () => {
  assert.strictEqual(matchCapabilityClaim({ detail: '排班备注：缺执行器 page-create，拆人工' }, 'page-create', {}), 'strong');
});

t('op 名出现在缺口语境行强命中（#1310 放行官原话）', () => {
  assert.strictEqual(matchCapabilityClaim({ detail: '本次简报里没有看到覆盖新建页面的已注册 op，page-create 不支持' }, 'page-create', {}), 'strong');
});

t('op 名出现在正常步骤行不命中（方案里引用 op 不算缺口）', () => {
  assert.strictEqual(matchCapabilityClaim({ detail: '第二步走 page-create 建空壳并挂 noindex' }, 'page-create', { platformMatches: true }), null);
});

t('泛断言只在平台一致时算 wide（#663 原话）', () => {
  const task = { detail: '平台能力清单无新建页面操作，需人在 WebForger 建页壳' };
  assert.strictEqual(matchCapabilityClaim(task, 'page-create', { platformMatches: true }), 'wide');
  assert.strictEqual(matchCapabilityClaim(task, 'page-create', { platformMatches: false }), null);
});

t('review_reason 与 result_note 同样参与匹配', () => {
  assert.strictEqual(matchCapabilityClaim({ review_reason: '缺执行器 theme-set-text，等登记' }, 'theme-set-text', {}), 'strong');
  assert.strictEqual(matchCapabilityClaim({ result_note: '没有看到已注册 op，转人工' }, 'page-create', { platformMatches: true }), 'wide');
});

t('op 名含正则元字符不炸', () => {
  assert.strictEqual(matchCapabilityClaim({ detail: '缺执行器 page-meta-update' }, 'page-meta-update', {}), 'strong');
});

t('空文本回 null', () => {
  assert.strictEqual(matchCapabilityClaim({}, 'page-create', { platformMatches: true }), null);
});

console.log(n - bad + ' passed, ' + bad + ' failed');
if (bad) process.exit(1);
