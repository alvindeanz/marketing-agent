#!/usr/bin/env node
/* 任务的目标文章（2026-11-18 ticket #64 与 Ben's NZ #2151）。跑法：node tests/tasktarget.test.js。
   覆盖三段：lib/tasktarget 的标记读写、chat 派单生产端落标记与拦歧义、执行器定位不到就停。
   末尾源码闸守住两侧同一口径（服务端 task_target_of 与本库同一条正则）。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const T = require(path.join(__dirname, '..', 'seo-worker', 'lib', 'tasktarget'));
const E = require(path.join(__dirname, '..', 'seo-worker', 'runners', 'execute_task'));
const chat = require(path.join(__dirname, '..', 'seo-worker', 'runners', 'chat'));
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

/* 线上真实任务书（Ben's NZ #2151，2026-11-18，节选） */
const D2151 = '目标文章站内路径 /blog/how-to-choose-sheer-curtains-nz/。第一步先看线上状态：仍是草稿就用 blog-draft 改草稿；已经发布了就用 blog-edit 改线上版本，不重建文章。'
  + '四，和 /blog/sheer-curtains-for-living-room-nz/ 分开角度：本篇讲通用选择方法，那篇讲客厅场景。';

console.log('标记读写');
t('targetOf 只认独占一行的 [target]', () => {
  assert.strictEqual(T.targetOf('x\n[target] /blog/a-b/\n[backing] k'), '/blog/a-b/');
  assert.strictEqual(T.targetOf('说明里提到 [target] /blog/a-b/ 不算'), '');
  assert.strictEqual(T.targetOf(''), '');
  assert.strictEqual(T.targetOf(null), '');
});
t('normalizeBlogTarget：相对路径、完整网址、带预览参数都规整成 /blog/<slug>/', () => {
  assert.strictEqual(T.normalizeBlogTarget('/blog/a-b'), '/blog/a-b/');
  assert.strictEqual(T.normalizeBlogTarget('https://x.co.nz/blog/a-b/?preview=abc'), '/blog/a-b/');
  assert.strictEqual(T.normalizeBlogTarget('/pages/about'), '');
  assert.strictEqual(T.normalizeBlogTarget(''), '');
});
t('needsBlogTarget / declaresEdit 只看申报的 ops', () => {
  assert.strictEqual(T.needsBlogTarget('blog-draft,blog-edit'), true);
  assert.strictEqual(T.needsBlogTarget('blog-publish'), true);
  assert.strictEqual(T.needsBlogTarget('blog-draft'), false);
  assert.strictEqual(T.needsBlogTarget('blog-edit'), false, '方案泳道的批量改不归这里管');
  assert.strictEqual(T.needsBlogTarget('page-advanced-update,blog-edit'), false);
  assert.strictEqual(T.declaresEdit('blog-draft, Blog-Edit'), true);
  assert.strictEqual(T.declaresEdit('blog-publish'), false);
});

console.log('派单落标记');
t('#2151 回放：任务书两篇文章、没给 target → 拦下并说清原因', () => {
  const r = T.stampTarget({ title: '改稿 how to choose sheer curtains（#832）三处问题后再发布', ops: 'blog-draft,blog-edit', detail: D2151 });
  assert.ok(/2 篇文章/.test(r.error) && /target/.test(r.error), r.error);
});
t('#2151 回放：给了 target → 落一行，别的文章不干扰', () => {
  const r = T.stampTarget({ title: 'x', ops: 'blog-draft,blog-edit', target: '/blog/how-to-choose-sheer-curtains-nz/', detail: D2151 });
  assert.strictEqual(r.error, '');
  assert.strictEqual(T.targetOf(r.detail), '/blog/how-to-choose-sheer-curtains-nz/');
});
t('任务书只有一篇 → 自动落行（确定的，不是猜）', () => {
  const r = T.stampTarget({ title: '发布', ops: 'blog-publish', detail: '把草稿 /blog/a-b/ 原样发布' });
  assert.strictEqual(r.target, '/blog/a-b/');
  assert.ok(/\n\[target\] \/blog\/a-b\/$/.test(r.detail));
});
t('已有 [target] 行不重复落；非博客单提到博客链接不落', () => {
  const once = T.stampTarget({ title: 'x', ops: 'blog-draft,blog-edit', detail: '改 /blog/a-b/\n[target] /blog/a-b/' });
  assert.strictEqual((once.detail.match(/\[target\]/g) || []).length, 1);
  const page = T.stampTarget({ title: 'x', ops: 'page-meta-update', detail: '产品页加内链到 /blog/a-b/' });
  assert.strictEqual(page.target, '');
  assert.strictEqual(page.detail, '产品页加内链到 /blog/a-b/');
});
t('一篇都没出现的改稿单不拦（网址不带 /blog/ 的站照旧）', () => {
  const r = T.stampTarget({ title: '改稿 spring sale post', ops: 'blog-draft,blog-edit', detail: '改 https://x.co.nz/spring-sale-post/ 的标题' });
  assert.strictEqual(r.error, '');
  assert.strictEqual(r.target, '');
});
t('批量改多篇的单（只有 blog-edit）提到多篇 → 不拦不落', () => {
  const r = T.stampTarget({ title: '补内链', ops: 'blog-edit', detail: '给 /blog/a-b/ 和 /blog/c-d/ 各加一条内链' });
  assert.strictEqual(r.error, '');
  assert.strictEqual(r.target, '');
});
t('发布单提到两篇又没写 target → 拦', () => {
  const r = T.stampTarget({ title: '发布', ops: 'blog-publish', detail: '发布 /blog/a-b/，它和 /blog/c-d/ 互链' });
  assert.ok(/2 篇文章/.test(r.error), r.error);
});
t('新写一篇（只有 blog-draft）提到两篇旧文做内链 → 不拦不落', () => {
  const r = T.stampTarget({ title: '新博客', ops: 'blog-draft', detail: '内链指向 /blog/a-b/ 和 /blog/c-d/' });
  assert.strictEqual(r.error, '');
  assert.strictEqual(r.target, '');
});
t('chat 生产端：歧义单被拦且露面，写明 target 的单带着标记出去', () => {
  const dropped = [];
  const base = { module: 'content', owner_type: 'agency', priority: 'P2', kind: 'change', ops: 'blog-draft,blog-edit' };
  const out = chat.cleanDrafts({ drafts: [
    Object.assign({ title: '改稿甲', detail: D2151 }, base),
    Object.assign({ title: '改稿乙', detail: D2151, target: '/blog/how-to-choose-sheer-curtains-nz/' }, base),
  ] }, () => {}, dropped);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].title, '改稿乙');
  assert.strictEqual(T.targetOf(out[0].detail), '/blog/how-to-choose-sheer-curtains-nz/');
  assert.ok(dropped.some((m) => /改稿甲/.test(m) && /target/.test(m)), dropped.join('|'));
});
t('chat 生产端：任务书很长时标记不被截断', () => {
  const out = chat.cleanDrafts({ drafts: [{ title: '发', module: 'content', owner_type: 'agency', kind: 'change', ops: 'blog-publish',
    detail: '发布 /blog/a-b/ ' + '说明'.repeat(3000) }] }, () => {}, []);
  assert.strictEqual(out.length, 1);
  assert.ok(out[0].detail.length <= 4000);
  assert.strictEqual(T.targetOf(out[0].detail), '/blog/a-b/');
});

console.log('执行器：定位不到就停');
t('#2151 回放：申报 blog-edit 却没定位到文章 → 停，不写新稿', () => {
  const why = E.blogTargetStop({ ops: 'blog-draft,blog-edit', mode: 'create', markedTarget: '' });
  assert.ok(/目标不明/.test(why) && /不退回写新稿/.test(why), why);
});
t('写明了目标但平台上读不到 → 停', () => {
  const why = E.blogTargetStop({ ops: 'blog-publish', mode: 'create', markedTarget: '/blog/gone/' });
  assert.ok(/读不到/.test(why) && /\/blog\/gone\//.test(why), why);
});
t('已定位到文章的继续；纯新写单照旧新建', () => {
  assert.strictEqual(E.blogTargetStop({ ops: 'blog-draft,blog-edit', mode: 'revise', markedTarget: '/blog/a/' }), '');
  assert.strictEqual(E.blogTargetStop({ ops: 'blog-draft', mode: 'create', markedTarget: '' }), '');
  assert.strictEqual(E.blogTargetStop({ ops: '', mode: 'create', markedTarget: '' }), '');
});

console.log('源码闸');
t('执行器先读 [target] 再走兜底，停下判断在写稿之前', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'seo-worker', 'runners', 'execute_task.js'), 'utf8');
  const iMark = js.indexOf('tasktarget.targetOf(task.detail)');
  const iGuess = js.indexOf('const noteUrls = String(task.result_note');
  const iStop = js.indexOf('const stopWhy = blogTargetStop(');
  const iGuide = js.indexOf("const guidance = [");
  assert.ok(iMark > 0 && iGuess > iMark, '[target] 没排在兜底猜法之前');
  assert.ok(iStop > iGuess && iGuide > iStop, '停下判断没排在全部定位办法之后、写稿之前');
});
t('服务端与本库同一条标记正则，提示词教了 target 和批文写法', () => {
  const php = fs.readFileSync(path.join(__dirname, '..', 'seo-api.php'), 'utf8');
  assert.ok(php.includes("preg_match('/^\\[target\\][ \\t]*(\\S+)[ \\t]*$/mu'"), '服务端 task_target_of 正则变了');
  assert.strictEqual(String(T.TARGET_LINE_RE), '/^\\[target\\][ \\t]*(\\S+)[ \\t]*$/m');
  const p = chat.buildPrompt({ clientName: 'L', title: 't', briefing: 'B', messages: [] });
  assert.ok(/"target":""/.test(p) && /目标文章必填/.test(p), '提示词没教 target');
  assert.ok(/slug 和「发布」二字/.test(p), '提示词没教发布批文怎么写');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
