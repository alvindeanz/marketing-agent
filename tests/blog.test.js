#!/usr/bin/env node
/* 博客流水线阶段机的纯函数单测。跑法：node tests/blog.test.js。零网络零模型。 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const E = require(path.join(__dirname, '..', 'seo-worker', 'runners', 'execute_task'));
const A = require(path.join(__dirname, '..', 'seo-worker', 'runners', 'apply_task'));
const C = require(path.join(__dirname, '..', 'seo-worker', 'lib', 'blogcheck'));
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }

console.log('大纲门');
t('任务说明要求大纲先交客户回批就进大纲门；标了大纲已批就直通', () => {
  assert.strictEqual(E.outlineGate({ detail: '对站上现有成本文章出逐节大纲, 补同行行情区间; 大纲交客户回批后写正文草稿。' }).gate, true);
  assert.strictEqual(E.outlineGate({ detail: '写一篇博客', review_adjust: '大纲交批前先落实客户侧审批人' }).gate, true);
  assert.strictEqual(E.outlineGate({ detail: '大纲交客户回批后写正文。\n[线程指令 2026-08-28] 大纲已批，写正文' }).gate, false);
  assert.strictEqual(E.outlineGate({ detail: '直接写一篇成本文' }).gate, false);
});

t('判定或大纲里的「就地扩写 /blog/x」被解析成 slug', () => {
  assert.strictEqual(E.expandInPlaceSlug('一，不另发新文，按大纲映射就地扩写 /blog/how-much-does-a-louvre-roof-cost-in-nz-the-factors-that-shape-your-quote，避免互抢'), 'how-much-does-a-louvre-roof-cost-in-nz-the-factors-that-shape-your-quote');
  assert.strictEqual(E.expandInPlaceSlug('apply this outline as an in place expansion of `/blog/abc-def/` rather than'), 'abc-def');
  assert.strictEqual(E.expandInPlaceSlug('另发一篇 /blog/new-post/'), '');
});

console.log('客户规则层');
t('读工作区 CLAUDE.md 与记忆目录 feedback_* 并去掉 frontmatter，超预算截断', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
  const mem = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  const slug = path.basename(ws);
  fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# 客户规则\n不写 Toa 抗风数值');
  fs.mkdirSync(path.join(mem, slug));
  fs.writeFileSync(path.join(mem, slug, 'feedback_a.md'), '---\nname: a\n---\n展厅只提 Mana');
  fs.writeFileSync(path.join(mem, slug, 'reference_b.md'), '不该进');
  const block = E.clientRulesBlock({ memoryDir: mem }, ws, () => {});
  assert.ok(block.indexOf('不写 Toa 抗风数值') > 0);
  assert.ok(block.indexOf('展厅只提 Mana') > 0);
  assert.ok(block.indexOf('name: a') === -1, 'frontmatter 应被去掉');
  assert.ok(block.indexOf('不该进') === -1, 'reference_* 不注入');
  assert.strictEqual(E.clientRulesBlock({ memoryDir: mem }, fs.mkdtempSync(path.join(os.tmpdir(), 'empty-')), () => {}), '');
});

console.log('交付 lint 规则');
t('禁用词、绝对化、禁用开头各报一次；规则文件读不到回空规则不炸', () => {
  const rules = { banned_terms: { 'AI-assisted': 'no AI mention' }, absolute_claims: ['guarantee[sd]? [a-z]+'], forbidden_openers: ['Discover'] };
  const d = { title: 'X', excerpt: 'Discover our range', meta_description: 'We guarantee results for you', body_markdown: 'AI-assisted writing' };
  const errs = C.checkLintRules(d, rules);
  assert.ok(errs.some((e) => e.indexOf('AI-assisted') > -1));
  assert.ok(errs.some((e) => e.indexOf('绝对化') > -1));
  assert.ok(errs.some((e) => e.indexOf('禁用开头') > -1));
  assert.deepStrictEqual(C.checkLintRules(d, {}), []);
  assert.deepStrictEqual(C.loadLintRules('/nonexistent.json', 'x'), {});
  const real = C.loadLintRules('/data/aira/scripts/deliverable_lint_rules.json', 'louvresky');
  assert.ok(Object.keys(real.banned_terms || {}).length > 0, '真实规则文件应读到 _default 禁用词');
});

console.log('发布门');
t('缺封面、待人工配图标记、管道表、缺 FAQ 各拦一条', () => {
  const okPost = { meta: { ogImage: '/assets/x.jpg' }, body: '## A\n<table><tr><td>1</td></tr></table>\n<script type="application/ld+json">{}</script>' };
  assert.deepStrictEqual(A.publishGate(okPost), []);
  const bad = A.publishGate({ meta: {}, body: '| a | b |\n|---|---|\n待人工配图' });
  assert.strictEqual(bad.length, 4, bad.join(' | '));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
