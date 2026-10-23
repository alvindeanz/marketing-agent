#!/usr/bin/env node
/* 原样写回通路与发布凭证闸分流（2026-10-23 ticket #47/#48/#49）。
   回放素材用真实事故载荷：#1597/#1608 的相对路径 detail、#1599 的「卡 #837」引用、
   #1599 方案的「不发布」措辞。跑法：node tests/blog_writeback.test.js。零网络零模型。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const wf = require(path.join(__dirname, '..', 'seo-worker', 'lib', 'webforger'));
const ex = require(path.join(__dirname, '..', 'seo-worker', 'runners', 'execute_task'));
const ap = require(path.join(__dirname, '..', 'seo-worker', 'runners', 'apply_task'));

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }

console.log('相对博客路径升格（ticket #48 死因一）');
t('#1597 式 detail：裸 /blog/ 路径升格成站点绝对链接', () => {
  const detail = '对象：San Michelle Bags 站内 duffel bag 博客草稿 /blog/duffel-bag-nz-wheels-vs-straps-leather-vs-nylon/（#1582 建的那份，未发布）。';
  const urls = wf.relBlogUrls(detail, 'sanmichellebags.co.nz');
  assert.deepStrictEqual(urls, ['https://sanmichellebags.co.nz/blog/duffel-bag-nz-wheels-vs-straps-leather-vs-nylon/']);
});
t('绝对 https 链接里的 /blog/ 不会被重复抓成相对路径', () => {
  const urls = wf.relBlogUrls('目标 https://louvresky.co.nz/blog/patio-cover-nz-checklist-before-quote/ 不动', 'louvresky.co.nz');
  assert.deepStrictEqual(urls, []);
});
t('多条相对路径都抓到（调用方据条数决定不猜）', () => {
  const urls = wf.relBlogUrls('改 /blog/post-a/ 并参考 /blog/post-b/', 'x.co.nz');
  assert.strictEqual(urls.length, 2);
});
t('补充类目路径 /collections/ 不会误命中', () => {
  const urls = wf.relBlogUrls('补 Duffel 类目链接 /collections/duffel-bags-vanity-bags/ 和相关内链', 'x.co.nz');
  assert.deepStrictEqual(urls, []);
});

console.log('发布凭证闸按方案载荷分流（ticket #47/#49，DEFECTS #809 族）');
t('#1599 式方案：满纸「不发布/发布状态不动」不触发闸', () => {
  const plan = '- 改什么：Step 5 拉链帘一句 carry a 3 year warranty 改为 4 year。标题、其余正文、问答、四张图、内链、草稿状态全部不动，不发布。\n- 风险与回滚：只改一个数字，草稿不对外。';
  assert.strictEqual(ap.planPublishIntent(['blog-edit'], plan), false);
});
t('ops 申报 blog-publish 必触发，方案文本无关', () => {
  assert.strictEqual(ap.planPublishIntent(['blog-publish'], '只改草稿，不发布'), true);
});
t('方案正文带 publishPost 调用触发', () => {
  assert.strictEqual(ap.planPublishIntent(['blog-edit'], '然后 client.publishPost(slug) 推送'), true);
});
t('方案正文带 /posts/{slug}/publish 端点触发', () => {
  assert.strictEqual(ap.planPublishIntent(['blog-edit'], 'curl -X POST /api/posts/my-post/publish'), true);
});
t('方案把 status 置 published 触发', () => {
  assert.strictEqual(ap.planPublishIntent(['blog-edit'], 'PATCH body {"status": "published"}'), true);
  assert.strictEqual(ap.planPublishIntent(['blog-edit'], '把发布状态改为 published'), true);
});
t('「不改发布状态」不触发', () => {
  assert.strictEqual(ap.planPublishIntent(['blog-edit'], '本单不改发布状态，正文替换完成即收口'), false);
});

console.log('凭证卡跨单引用（ticket #47 第二个洞）');
t('#1599 式「（卡 #837，预览 ...）」能接上', () => {
  const ids = ap.consentRefIds({ id: 1599, detail: '对象：草稿 /blog/patio-cover-nz-checklist-before-quote/（卡 #837，预览 ?preview=42cb）。', result_note: '' });
  assert.deepStrictEqual(ids, [837]);
});
t('旧形态照旧：确认卡#N 与 blog_confirmation_task-N', () => {
  const ids = ap.consentRefIds({ id: 9, detail: '见确认卡 #123', result_note: '卡页 blog_confirmation_task-55.html' });
  assert.deepStrictEqual(ids.sort(), [123, 55].sort());
});
t('本任务自己的号不进引用表', () => {
  const ids = ap.consentRefIds({ id: 837, detail: '出卡 #837 后等客户', result_note: '' });
  assert.deepStrictEqual(ids, []);
});

console.log('原样写回来源判定（载荷路由，硬规矩 9）');
function makeWs(layout) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wbtest-'));
  for (const [rel, content] of Object.entries(layout)) {
    const f = path.join(ws, 'seo-agent-output', rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content, 'utf8');
  }
  return ws;
}
t('#1608 式：detail 引 #1591，其目录有 duffel-revised-body.md，命中唯一来源', () => {
  const ws = makeWs({ 'task-1591/duffel-revised-body.md': '# Duffel\n\n正文'.padEnd(400, 'x'), 'task-1582/preview-task-1582.html': '<html>' });
  const r = ex.writebackSource({ detail: '用 #1591 结果附件里的修订稿，经 blog-draft 原地 PATCH 原草稿（#1582 建的）' }, ws, 1608);
  assert.strictEqual(r.file, path.join(ws, 'seo-agent-output', 'task-1591', 'duffel-revised-body.md'));
});
t('引用任务目录里的 JSON 载荷（publishedRevise 的 revised-body-*.md）不算来源', () => {
  const ws = makeWs({ 'task-77/revised-body-some-post.md': '{\n "title": "x", "body": "y"\n}' });
  const r = ex.writebackSource({ detail: '参考 #77 的改法' }, ws, 88);
  assert.strictEqual(r.file, '');
  assert.strictEqual(r.candidates.length, 0);
});
t('本任务自己的目录不扫（重跑残留不当输入）', () => {
  const ws = makeWs({ 'task-88/writeback-body-x.md': '正文'.padEnd(400, 'x') });
  const r = ex.writebackSource({ detail: '写回 #88 草稿' }, ws, 88);
  assert.strictEqual(r.file, '');
});
t('两份候选不猜：file 空、candidates 列全', () => {
  const ws = makeWs({
    'task-11/a-revised-body.md': '正文甲'.padEnd(400, 'x'),
    'task-12/b-revised-body.md': '正文乙'.padEnd(400, 'x'),
  });
  const r = ex.writebackSource({ detail: '用 #11 或 #12 的稿' }, ws, 99);
  assert.strictEqual(r.file, '');
  assert.strictEqual(r.candidates.length, 2);
});
t('无引用或目录缺失：不走写回，正常产线', () => {
  const ws = makeWs({});
  const r = ex.writebackSource({ detail: '新写一篇 duffel 文' }, ws, 100);
  assert.strictEqual(r.file, '');
});

console.log('搬运契约（不套新稿标准）');
t('完整正文过契约（不查 1500 词、配图、FAQ）', () => {
  const body = '# Duffel Bags\n\n正文段落。'.padEnd(600, '字') + '\n\n[类目](/collections/duffel-bags/)';
  assert.deepStrictEqual(ex.revisionCheck(body), []);
});
t('HTML 注释打回（内部元数据不进客户平台）', () => {
  const issues = ex.revisionCheck(('<!-- Style Roll: 骨架 4 -->\n正文').padEnd(400, 'x'));
  assert.ok(issues.some((s) => /注释/.test(s)));
});
t('JSON 载荷、过短、占位符各自打回', () => {
  assert.ok(ex.revisionCheck('{"body":"x"}').length >= 1);
  assert.ok(ex.revisionCheck('太短').some((s) => /过短/.test(s)));
  assert.ok(ex.revisionCheck('正文 [to supply] 待补数据'.padEnd(400, 'x')).some((s) => /占位/.test(s)));
});

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
