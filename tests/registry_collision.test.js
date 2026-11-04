#!/usr/bin/env node
/* 撞车判定「未发布不占用」回归（2026-11-04 Alvin 定，task 120 教训）。零网络零模型。
   跑法：node tests/registry_collision.test.js */
'use strict';
const assert = require('assert');
const path = require('path');
const R = require(path.join(__dirname, '..', 'seo-worker', 'lib', 'registry'));
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }

function reg(entries) { return { entries, total: entries.length, counts: {} }; }
const draftEntry = {
  kind: 'post', status: 'draft',
  slug: 'how-much-does-it-cost-to-have-curtains-made-nz',
  title: 'How Much Does It Cost to Have Curtains Made? NZ Prices Window by Window',
  keyword: 'how much does it cost to have curtains made',
  url: '/blog/how-much-does-it-cost-to-have-curtains-made-nz/',
};
const publishedEntry = Object.assign({}, draftEntry, { status: 'published' });
const cand = {
  slug: 'how-much-does-it-cost-to-have-curtains-made-nz',
  keyword: 'how much does it cost to have curtains made',
  title: 'How Much Does It Cost to Have Curtains Made in NZ?',
};

console.log('未发布不占用');
t('同 slug 的未发布草稿不构成打回，降级成 near 情报', () => {
  const v = R.checkCollision(cand, reg([draftEntry]), {});
  assert.strictEqual(v.blocking, false, '草稿不该 blocking');
  assert.strictEqual(v.blockers.length, 0);
  assert.strictEqual(v.nears.length, 1);
  assert.ok(/未发布草稿不占用/.test(v.nears[0].reason), v.nears[0].reason);
});
t('同 slug 的已发布博文照旧 exact 打回', () => {
  const v = R.checkCollision(cand, reg([publishedEntry]), {});
  assert.strictEqual(v.blocking, true);
  assert.strictEqual(v.blockers[0].level, 'exact');
});
t('草稿 page 之外只降级 post：非 post 条目不受本例外影响', () => {
  const pageDraft = Object.assign({}, draftEntry, { kind: 'page' });
  const v = R.checkCollision(cand, reg([pageDraft]), {});
  assert.strictEqual(v.blocking, true, 'page 不走未发布例外');
});

console.log('禁止清单文案');
t('占用表只列已发布，草稿单列为可覆盖且注明不要问人', () => {
  const block = R.forbiddenBlock(reg([draftEntry, Object.assign({}, publishedEntry, { slug: 'curtain-styles-nz', title: 'Curtain Styles NZ', keyword: 'curtain styles' })]), {});
  assert.ok(block.indexOf('只含已发布博文') > -1, block.slice(0, 120));
  assert.ok(block.indexOf('不占用选题') > -1);
  assert.ok(block.indexOf('不要为此改题或停下来问人') > -1);
  const occupiedSection = block.split('站上未发布草稿')[0];
  assert.strictEqual(occupiedSection.indexOf(draftEntry.slug), -1, '草稿 slug 不许出现在占用表里');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
