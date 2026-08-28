#!/usr/bin/env node
/* 预览页渲染的纯函数单测。跑法：node tests/preview.test.js */
const assert = require('assert');
const path = require('path');
const P = require(path.join(__dirname, '..', 'seo-worker', 'lib', 'preview'));
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }
console.log('mdToHtml');
t('标题、段落、列表、表格、行内、raw html、注释', () => {
  const md = '<!-- Style Roll -->\n# T\n\n## H2 **bold**\n\npara with `code` and [link](/a/) and *em*.\n\n- a\n- b\n\n1. x\n2. y\n\n| c1 | c2 |\n|---|---|\n| v1 | v2 |\n\n<table><tr><td>raw</td></tr></table>\n\n> quote';
  const h = P.mdToHtml(md);
  assert.ok(h.indexOf('<h1>T</h1>') > -1 && h.indexOf('<h2>H2 <strong>bold</strong></h2>') > -1);
  assert.ok(h.indexOf('<code>code</code>') > -1 && h.indexOf('<a href="/a/"') > -1 && h.indexOf('<em>em</em>') > -1);
  assert.ok(h.indexOf('<ul><li>a</li><li>b</li></ul>') > -1 && h.indexOf('<ol><li>x</li><li>y</li></ol>') > -1);
  assert.ok(h.indexOf('<th>c1</th>') > -1 && h.indexOf('<td>v2</td>') > -1);
  assert.ok(h.indexOf('<table><tr><td>raw</td></tr></table>') > -1);
  assert.ok(h.indexOf('<blockquote>quote</blockquote>') > -1);
  assert.ok(h.indexOf('Style Roll') === -1, '注释不进预览');
});
t('转义与图片', () => {
  const h = P.mdToHtml('a < b & c\n\n![alt text](/assets/x.jpg)');
  assert.ok(h.indexOf('a &lt; b &amp; c') > -1 && h.indexOf('<img src="/assets/x.jpg" alt="alt text"') > -1);
});
console.log('renderBlogPreview / renderDocPreview');
t('博客预览带 Copy 按钮、meta 表、绝对图片地址、hero', () => {
  const html = P.renderBlogPreview({ draft: { title: 'T1', slug: 's', keyword: 'k', category: 'c', excerpt: 'e', meta_description: 'm', body_markdown: '## A\n\n![x](/assets/b.jpg)' }, ogImage: '/assets/h.jpg', host: 'example.co.nz', taskId: 9, client: 'C' });
  assert.ok(html.indexOf('id="copyBtn"') > -1 && html.indexOf('id="articleBody"') > -1);
  assert.ok(html.indexOf('https://example.co.nz/assets/b.jpg') > -1 && html.indexOf('https://example.co.nz/assets/h.jpg') > -1);
  assert.ok(html.indexOf('<h1>T1</h1>') > -1 && html.indexOf('noindex') > -1);
});
t('文档预览无 Copy 按钮，含种类与 markdown 渲染', () => {
  const html = P.renderDocPreview({ title: 'Plan', markdown: '## 1. 变更目标\n\n| 位置 | before | after |\n|---|---|---|\n| title | a | b |', kind: '变更方案', taskId: 3, client: 'C', note: 'n' });
  assert.ok(html.indexOf('copyBtn') === -1 && html.indexOf('变更方案') > -1 && html.indexOf('<td>b</td>') > -1 && html.indexOf('class="warn"') > -1);
});
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
