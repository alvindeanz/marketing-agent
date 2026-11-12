#!/usr/bin/env node
/* 博客原地改（lib/blogedit）。跑法：node tests/blogedit.test.js。零网络零模型。
   回放来源：2026-11-11/12 的 #2003、#2006、#2007、#2017、#2042 五张失败单。 */
const assert = require('assert');
const path = require('path');
const E = require(path.join(__dirname, '..', 'seo-worker', 'lib', 'blogedit'));
const C = require(path.join(__dirname, '..', 'seo-worker', 'lib', 'blogcheck'));
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }

const BODY = [
  '## Why the Cabin Bag Matters',
  '',
  'Hana packed a 56cm case for the flight.',
  '',
  '![Rangi awning](/assets/1792015954427-body-1-1-small.jpg)',
  '',
  'See our [Carry On Luggage](/collections/carry-on/) range.',
  '',
  '## Where to Start',
  '',
  'Start with a list. Start with a list of what you forgot last time.',
].join('\n');
const BASE = { title: 'Summer Packing List', slug: 'summer-holiday-packing-list-nz-bach-week', category: 'travel-tips',
  keyword: 'summer holiday packing list nz', excerpt: 'e', meta_description: 'm', body: BODY };
const SOC = '我们按意见改了三处，请您看看 {PREVIEW_URL}';

console.log('applyEdits');
t('改一句：其余逐字不变，只报 body 变了', () => {
  const r = E.applyEdits(BASE, { edits: [{ find: 'a 56cm case', replace: 'a 55cm case' }], social_message: SOC });
  assert.ok(r.ok, r.errors.join(' | '));
  assert.deepStrictEqual(r.changed, ['body']);
  assert.strictEqual(r.draft.body_markdown, BODY.replace('a 56cm case', 'a 55cm case'));
  assert.strictEqual(r.draft.title, BASE.title);
  assert.strictEqual(r.draft.slug, BASE.slug);
});
t('删图（#2006/#2007 的任务本意）：整行图片换成空串', () => {
  const r = E.applyEdits(BASE, { edits: [{ find: '![Rangi awning](/assets/1792015954427-body-1-1-small.jpg)\n\n', replace: '' }], social_message: SOC });
  assert.ok(r.ok, r.errors.join(' | '));
  assert.strictEqual(r.draft.body_markdown.indexOf('/assets/'), -1);
  assert.ok(r.draft.body_markdown.indexOf('[Carry On Luggage](/collections/carry-on/)') > -1);
});
t('find 找不到：报错并点出是哪条', () => {
  const r = E.applyEdits(BASE, { edits: [{ find: 'a 58cm case', replace: 'x' }], social_message: SOC });
  assert.ok(!r.ok);
  assert.ok(/edits\[0\].*找不到/.test(r.errors[0]), r.errors[0]);
});
t('find 不唯一：报错要求带前后文', () => {
  const r = E.applyEdits(BASE, { edits: [{ find: 'Start with a list', replace: 'x' }], social_message: SOC });
  assert.ok(!r.ok);
  assert.ok(/出现 2 次/.test(r.errors[0]), r.errors[0]);
});
t('replace 里的 $& 不被当成替换模式', () => {
  const r = E.applyEdits(BASE, { edits: [{ find: 'a 56cm case', replace: 'a $& $1 case' }], social_message: SOC });
  assert.ok(r.ok);
  assert.ok(r.draft.body_markdown.indexOf('a $& $1 case') > -1);
});
t('后一条 edit 按前一条套完后的正文匹配', () => {
  const r = E.applyEdits(BASE, { edits: [{ find: 'a 56cm case', replace: 'a 55cm bag' }, { find: '55cm bag for', replace: '55cm bag on' }], social_message: SOC });
  assert.ok(r.ok, r.errors.join(' | '));
  assert.ok(r.draft.body_markdown.indexOf('a 55cm bag on the flight') > -1);
});
t('一个字没变：不算通过', () => {
  const r = E.applyEdits(BASE, { edits: [], social_message: SOC });
  assert.ok(!r.ok);
  assert.ok(/一个字没变/.test(r.errors.join('')));
});
t('交了整篇正文没交 edits：打回', () => {
  const r = E.applyEdits(BASE, { body_markdown: 'whole new body', social_message: SOC });
  assert.ok(!r.ok);
  assert.ok(/edits 数组/.test(r.errors[0]));
});
t('点名改 meta：只报 meta_description 变了，slug 与分类改不动', () => {
  const r = E.applyEdits(BASE, { edits: [], meta_description: 'new meta', slug: 'x', category: 'y', keyword: 'z', social_message: SOC });
  assert.ok(r.ok, r.errors.join(' | '));
  assert.deepStrictEqual(r.changed, ['meta_description']);
  assert.strictEqual(r.draft.slug, BASE.slug);
  assert.strictEqual(r.draft.category, BASE.category);
  assert.strictEqual(r.draft.keyword, BASE.keyword);
});
t('缺话术：打回', () => {
  const r = E.applyEdits(BASE, { edits: [{ find: 'a 56cm case', replace: 'a 55cm case' }] });
  assert.ok(!r.ok);
  assert.ok(/social_message/.test(r.errors.join('')));
});

console.log('newErrors（只留改稿新带进来的毛病）');
t('#2017 回放：原稿本来就有的字数、配图数、内链、FAQ 问题不算在改稿头上', () => {
  const base = ['正文 101 词，低于下限 1500 词', '正文没有任何内链，SOP 红线第 3 条', '正文末尾缺少 FAQPage 的 JSON-LD schema，SOP 红线第 6 条'];
  const next = ['正文 98 词，低于下限 1500 词', '正文没有任何内链，SOP 红线第 3 条', '正文末尾缺少 FAQPage 的 JSON-LD schema，SOP 红线第 6 条'];
  assert.deepStrictEqual(E.newErrors(base, next), []);
});
t('改稿新带进来的破折号照样拦', () => {
  const base = ['正文 101 词，低于下限 1500 词'];
  const next = ['正文 104 词，低于下限 1500 词', 'body_markdown 里出现了破折号，用逗号句号或分号替代'];
  assert.deepStrictEqual(E.newErrors(base, next), ['body_markdown 里出现了破折号，用逗号句号或分号替代']);
});
t('接上真校验器：一篇短稿改一句，改前改后报错相同，新增为零', () => {
  const ctx = { roll: null, allowedPaths: ['/collections/carry-on/'], categories: ['travel-tips'], lang: '', keepImages: [], expectImageBriefs: false, lintRules: {} };
  const mk = (b) => ({ title: BASE.title, slug: BASE.slug, category: BASE.category, keyword: BASE.keyword, excerpt: 'e', meta_description: 'm', body_markdown: b, social_message: SOC });
  const a = C.checkDraft(mk(BODY), ctx);
  const b = C.checkDraft(mk(BODY.replace('a 56cm case', 'a 55cm case')), ctx);
  assert.ok(a.errors.length > 0, '短稿本身应该有一堆报错');
  assert.deepStrictEqual(E.newErrors(a.errors, b.errors), []);
});

console.log('fixTrailingSlashes（#2003 回放）');
t('markdown 内链补斜杠，图片、带扩展名、带 query、带锚点的不动', () => {
  const src = 'A [x](/blog/20-hours-free-ece-a-golden-opportunity-at-kia-ora-kids) B [y](/send-an-enquiry) ' +
    '![i](/assets/a-small) [f](/files/a.pdf) [q](/search?q=1) [h](/page#top) [ok](/about/) [home](/)';
  const r = E.fixTrailingSlashes(src);
  assert.deepStrictEqual(r.fixed, ['/blog/20-hours-free-ece-a-golden-opportunity-at-kia-ora-kids', '/send-an-enquiry']);
  assert.ok(r.body.indexOf('](/send-an-enquiry/)') > -1);
  assert.ok(r.body.indexOf('![i](/assets/a-small)') > -1);
  assert.ok(r.body.indexOf('](/files/a.pdf)') > -1);
  assert.ok(r.body.indexOf('](/search?q=1)') > -1);
  assert.ok(r.body.indexOf('](/page#top)') > -1);
});
t('href 形态也补，外链不动', () => {
  const r = E.fixTrailingSlashes('<a href="/contact">c</a> <a href="https://x.com/a">o</a>');
  assert.strictEqual(r.body, '<a href="/contact/">c</a> <a href="https://x.com/a">o</a>');
});
t('补完之后真校验器不再报缺尾斜杠', () => {
  const r = E.fixTrailingSlashes('See [x](/send-an-enquiry) now.');
  assert.deepStrictEqual(C.internalLinks(r.body), ['/send-an-enquiry/']);
});

console.log('slugsMentioned（#2006/#2017 回放）');
const SLUGS = ['retractable-awning-vs-retractable-louvre-roof', 'glass-roof-pergola-nz-vs-louvre-roof', 'pergola', 'louvre-roof'];
t('括号里的裸 slug 能认出来', () => {
  assert.deepStrictEqual(E.slugsMentioned('只改 #839 那篇未发布草稿（retractable-awning-vs-retractable-louvre-roof），走修订', SLUGS),
    ['retractable-awning-vs-retractable-louvre-roof']);
});
t('「slug xxx」写法能认出来，短 slug 与子串不误中', () => {
  assert.deepStrictEqual(E.slugsMentioned('读 #838 未发布草稿（slug glass-roof-pergola-nz-vs-louvre-roof）当前配图', SLUGS),
    ['glass-roof-pergola-nz-vs-louvre-roof']);
});
t('没提到任何现有 slug 回空（#2016 这类只写任务号的不猜）', () => {
  assert.deepStrictEqual(E.slugsMentioned('读 #839 未发布草稿当前正文与配图', SLUGS), []);
});
t('更长 slug 的一部分不算提到', () => {
  assert.deepStrictEqual(E.slugsMentioned('见 best-glass-roof-pergola-nz-vs-louvre-roof-guide', SLUGS), []);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
