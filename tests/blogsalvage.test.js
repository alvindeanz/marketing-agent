#!/usr/bin/env node
/* 审稿修改清单逐条采纳与审稿官内链上限提示。跑法：node tests/blogsalvage.test.js。零网络零模型。 */
const assert = require('assert');
const path = require('path');
const R = require(path.join(__dirname, '..', 'seo-worker', 'runners', 'execute_task.js'));
const E = require(path.join(__dirname, '..', 'seo-worker', 'lib', 'blogedit'));
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }
/* Dareu #3550 第二轮的形状：正文已有 3 个内链目标，审稿要求的五处里一处加了第 4 个目标。 */
const body = 'Intro with [mouse range](/collections/mouse/) and medium brightness.\n\nA single static color at a lower brightness usually looks cleaner.\n\nFind the [drivers page](/drivers/).\n\nSee [keyboard guide](/blog/best-rgb-settings-customization/).\n\ncontact the seller or the support team of the brand.\n\nour team is happy to help.';
const base = { title: 'T', slug: 's', category: 'c', keyword: 'k', excerpt: 'e', meta_description: 'm', body, cover_image: '' };
const toCand = (out, b) => E.applyEdits(Object.assign({}, base, { body: b }), out);
const targets = (d) => new Set((d.body_markdown.match(/\]\((\/[^)]*)\)/g) || []));
const judge = (d) => ({ ok: targets(d).size <= 3, errors: targets(d).size <= 3 ? [] : ['内链指向 4 个不同页面'] });
const out = { social_message: '改了几处', edits: [
  { find: 'at a lower brightness usually', replace: 'at medium brightness usually' },
  { find: 'contact the seller or the support team of the brand.', replace: 'contact Dareu support.' },
  { find: 'our team is happy to help.', replace: 'our [support team](/contact-us/) is happy to help.' },
] };
console.log('逐条采纳');
t('整份超限时留下不惹事的两条，弃加链接那条', () => {
  assert.strictEqual(judge(toCand(out, body).draft).ok, false);
  const k = R.salvageEdits(out, body, toCand, judge);
  assert.ok(k && k.cand);
  assert.strictEqual(k.kept, 2); assert.deepStrictEqual(k.dropped, [2]);
  assert.ok(k.cand.draft.body_markdown.indexOf('at medium brightness usually') > -1);
  assert.ok(k.cand.draft.body_markdown.indexOf('contact Dareu support.') > -1);
  assert.ok(k.cand.draft.body_markdown.indexOf('/contact-us/') === -1);
});
t('只有一条或一条都留不下时回 null，走原来的沿用修改前版本', () => {
  assert.strictEqual(R.salvageEdits({ edits: [out.edits[2]], social_message: 'x' }, body, toCand, judge), null);
  assert.strictEqual(R.salvageEdits({ edits: [out.edits[2], { find: 'Intro with', replace: 'Intro [x](/a/) with' }], social_message: 'x' }, body, toCand, judge), null);
});
console.log('审稿官内链上限提示');
t('已满时写明已满并列出现有目标，素材图与 JSON-LD 不算', () => {
  const line = R.reviewLinkCapLine(body + '\n![i](/assets/a.jpg)\n<script type="application/ld+json">{"u":"](/x/)"}</script>');
  assert.ok(line.indexOf('本稿已用 3 个') > -1, line);
  assert.ok(line.indexOf('已满') > -1 && line.indexOf('/drivers') > -1 && line.indexOf('/assets') === -1 && line.indexOf('/x') === -1, line);
});
t('没满时不说已满', () => assert.ok(R.reviewLinkCapLine('a [x](/a/)').indexOf('已满，') === -1));
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
