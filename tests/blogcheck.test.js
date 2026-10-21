#!/usr/bin/env node
/* 博客机器校验的结构计数。跑法：node tests/blogcheck.test.js。零网络零模型。 */
const assert = require('assert');
const path = require('path');
const C = require(path.join(__dirname, '..', 'seo-worker', 'lib', 'blogcheck'));
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }
console.log('structure');
t('管道表与 HTML 表都算表格', () => {
  const body = '## Cost\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<table><thead><tr><th>x</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>\n\n<TABLE><tr><td>y</td></tr></TABLE>\n';
  const st = C.structure(body);
  assert.strictEqual(st.pipeTables, 1);
  assert.strictEqual(st.htmlTables, 2);
  assert.strictEqual(st.tables, 3);
});
t('没有表格计 0', () => {
  assert.strictEqual(C.structure('## A\n\ntext\n\n- a\n- b\n').tables, 0);
});
t('非 Style Roll 的 HTML 注释被拦', () => {
  const d={title:'t',slug:'a-b',category:'blog',keyword:'k',excerpt:'e',meta_description:'x'.repeat(60),body_markdown:'<!-- Style Roll: 骨架=Checklist -->\n<!-- DRAFT NOTE pending -->\n## A\n\ntext [a](/a/)\n<script type="application/ld+json">{"@type":"FAQPage"}</script>',social_message:'中'.repeat(90)+'{PREVIEW_URL}'};
  const v=C.checkDraft(d,{roll:null,allowedPaths:['/a/'],categories:['blog'],lang:'',keepImages:[],expectImageBriefs:false,lintRules:{}});
  assert.ok(v.errors.some(e=>e.indexOf('HTML 注释')>-1), v.errors.join(' | '));
});

console.log('keepImages 按 URL 比对（ticket #46 回放，#1574 改 alt 被误判删图）');
const SR = require(path.join(__dirname, '..', 'seo-worker', 'lib', 'styleroll'));
function draftWith(body) {
  return { title: 'sheer curtains auckland', slug: 'a-b', category: 'blog', keyword: 'sheer curtains',
    excerpt: 'e', meta_description: 'x'.repeat(60),
    body_markdown: '<!-- Style Roll: 骨架=Checklist | 语气=Direct -->\n' + body +
      '\n\ntext [a](/a/)\n<script type="application/ld+json">{"@type":"FAQPage"}</script>',
    social_message: '中'.repeat(90) + '{PREVIEW_URL}' };
}
const KEEP = ['![Street view at night of a villa lounge](/assets/img-1.jpg)', '![Close up of S-fold sheer curtains](/assets/img-2.jpg)'];
t('改 alt 保 URL 不算删图', () => {
  const d = draftWith('## A\n\n![Night street view, lamps on behind sheers](/assets/img-1.jpg)\n\n![S-fold sheers stacked beside window](/assets/img-2.jpg)');
  const v = C.checkDraft(d, { roll: null, allowedPaths: ['/a/'], categories: ['blog'], lang: '', keepImages: KEEP, expectImageBriefs: false, lintRules: {} });
  assert.ok(!v.errors.some((e) => e.indexOf('原稿图片') > -1), v.errors.join(' | '));
});
t('真删图照拦', () => {
  const d = draftWith('## A\n\n![only one](/assets/img-1.jpg)');
  const v = C.checkDraft(d, { roll: null, allowedPaths: ['/a/'], categories: ['blog'], lang: '', keepImages: KEEP, expectImageBriefs: false, lintRules: {} });
  assert.ok(v.errors.some((e) => e.indexOf('图片 URL 必须保留') > -1 || e.indexOf('图片数量') > -1), v.errors.join(' | '));
});
t('换图（URL 变了数量没变）照拦', () => {
  const d = draftWith('## A\n\n![a](/assets/img-1.jpg)\n\n![b](/assets/img-OTHER.jpg)');
  const v = C.checkDraft(d, { roll: null, allowedPaths: ['/a/'], categories: ['blog'], lang: '', keepImages: KEEP, expectImageBriefs: false, lintRules: {} });
  assert.ok(v.errors.some((e) => e.indexOf('图片 URL 必须保留') > -1), v.errors.join(' | '));
});

console.log('Style Roll 带外剥离（ticket #46）');
t('裸注释剥净', () => {
  const out = SR.stripRollComment('<!-- Style Roll: 骨架=Checklist | 语气=Direct -->\n## A\n\ntext');
  assert.strictEqual(out.indexOf('Style Roll'), -1);
  assert.ok(out.indexOf('## A') === 0, JSON.stringify(out.slice(0, 20)));
});
t('p 壳包裹的注释剥净（#1544 平台形态）', () => {
  const out = SR.stripRollComment('<p><!-- Style Roll: 骨架=Story Lead | 语气=Expert --></p>\n## A\n\ntext');
  assert.strictEqual(out.indexOf('Style Roll'), -1);
  assert.strictEqual(out.indexOf('<p>'), -1);
});
t('正文其余部分一字不动', () => {
  const body = '## A\n\n![img](/assets/x.jpg)\n\n| a | b |\n|---|---|\n';
  assert.strictEqual(SR.stripRollComment('<!-- Style Roll: 骨架=Checklist -->\n' + body), body);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
