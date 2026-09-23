'use strict';
const assert = require('assert');
const bc = require('../seo-worker/lib/blogcadence');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('ok  ' + name); } catch (e) { fail++; console.log('FAIL ' + name + ' :: ' + e.message); }
}

const FACT = { fact_key: 'contract.blog_per_sprint', value: '1，每个 sprint 一篇（2026-09-23 Alvin 定）' };
function ctx(tasks, withFact = true, anchor = '2026-08-29') {
  return { facts: { confirmed: withFact ? [FACT] : [] }, active_plan: { created_at: anchor + ' 10:00:00' }, tasks };
}

t('开关：没有 fact 不受约束，有 fact 读出数字', () => {
  assert.strictEqual(bc.quotaOf(ctx([], false)), 0);
  assert.strictEqual(bc.quotaOf(ctx([])), 1);
});

t('博客任务识别：写新文算，内链/封面/修订不算', () => {
  assert.ok(bc.isBlogTask({ title: '博客：钱包选购信息型', ops: '' }));
  assert.ok(bc.isBlogTask({ title: '博客：钱包选购信息型，内链回 /collections/wallets/', ops: '' }), '内链回是落点不是内链任务');
  assert.ok(!bc.isBlogTask({ title: '成本类文章补新西兰市场行情区间', ops: 'blog-draft' }), '改旧文不算新文');
  assert.ok(!bc.isBlogTask({ title: '发布博客：纱帘的夜间隐私（#130 草稿）', ops: '' }), '发布动作不算新文');
  assert.ok(bc.isBlogTask({ title: 'S3 配额博客：选题在锁定词表内自定', ops: 'blog-draft' }));
  assert.ok(!bc.isBlogTask({ title: '现有 7 篇博客补内链指向 made-to-measure 页', ops: '' }));
  assert.ok(!bc.isBlogTask({ title: '博客一二篇封面图与发布方案', ops: 'blog-draft' }));
});

t('缺口：死任务不占配额，已过 sprint 补在当前 sprint，9 月前的不追溯', () => {
  // 锚点 08-29：S1 08/29-09/11，S2 09/12-09/25（今天 09-23 在 S2），S3 起未来
  const c = ctx([
    { id: 1, title: '博客：A', sprint: 'S2', status: 'approved' },
    { id: 2, title: '博客：B', sprint: 'S3', status: 'done', result_note: '[dropped] 判不做' },
    { id: 3, title: '博客：C', sprint: 'S4', status: 'proposed' },
  ]);
  const g = bc.gaps(c, '2026-09-23');
  const bySprint = Object.fromEntries(g.map((x) => [x.sprint, x]));
  assert.ok(bySprint.S1 && bySprint.S1.catchup && bySprint.S1.target === 'S2', 'S1 欠交补在 S2');
  assert.ok(!bySprint.S2, 'S2 有 A');
  assert.ok(bySprint.S3 && !bySprint.S3.catchup, 'S3 的 B 已死要补');
  assert.ok(!bySprint.S4);
  assert.ok(bySprint.S5 && bySprint.S6);
  const surplus = bc.gaps(ctx([
    { id: 5, title: '博客：X', sprint: 'S2', status: 'done' },
    { id: 6, title: '博客：Y', sprint: 'S2', status: 'done' },
    { id: 7, title: '博客：Z', sprint: 'S3', status: 'proposed' },
    { id: 8, title: '博客：W', sprint: 'S4', status: 'proposed' },
    { id: 9, title: '博客：V', sprint: 'S5', status: 'proposed' },
    { id: 10, title: '博客：U', sprint: 'S6', status: 'proposed' },
  ]), '2026-09-23');
  assert.strictEqual(surplus.length, 0, 'S1 空 S2 两篇，累计交够不补');
  const old = bc.gaps(ctx([], true, '2026-07-01'), '2026-09-23');
  assert.ok(!old.some((x) => x.range.end < '2026-09-01'), '9 月前结束的 sprint 不追溯');
});

t('判定保护：写稿阶段配额博客的 drop/later 改判 do，review 阶段与超额的不保护', () => {
  const tasks = [
    { id: 308, title: '博客：tote 场景型', sprint: 'S3', status: 'approved', detail: '' },
    { id: 309, title: '博客：第二篇', sprint: 'S3', status: 'approved', detail: '' },
    { id: 142, title: '博客草稿：电动产品', sprint: 'S4', status: 'review', detail: '' },
    { id: 400, title: '首页 title 改写', sprint: 'S3', status: 'approved', detail: '' },
  ];
  const vs = [
    { task_id: 308, verdict: 'drop', reason: '收益举不出数字', evidence: 'x', adjust: '' },
    { task_id: 309, verdict: 'drop', reason: '超额', evidence: 'x', adjust: '' },
    { task_id: 142, verdict: 'later', reason: '等客户确认', evidence: 'x', adjust: '' },
    { task_id: 400, verdict: 'drop', reason: 'x', evidence: 'x', adjust: '' },
  ];
  const out = bc.protectVerdicts(vs, ctx(tasks), null);
  const m = Object.fromEntries(out.map((v) => [v.task_id, v]));
  assert.strictEqual(m[308].verdict, 'do');
  assert.ok(/\[配额保护\] 原判 drop/.test(m[308].reason));
  assert.ok(/换题/.test(m[308].adjust));
  assert.strictEqual(m[309].verdict, 'drop', '同 sprint 第二篇超配额，可判掉');
  assert.strictEqual(m[142].verdict, 'later', 'review 阶段等客户是正当等待');
  assert.strictEqual(m[400].verdict, 'drop', '非博客不管');
  assert.deepStrictEqual(bc.protectVerdicts(vs, ctx(tasks, false), null), vs, '没开关原样返回');
});

t('占位任务：带配额标记、ops 字符串、补交写明原 sprint', () => {
  const p = bc.placeholderTask({ sprint: 'S1', target: 'S2', missing: 1, catchup: true, range: { start: '2026-08-29', end: '2026-09-11' } }, 0, true);
  assert.ok(/^\[配额博客 S1\]/.test(p.detail));
  assert.strictEqual(p.sprint, 'S2');
  assert.strictEqual(p.ops, 'blog-draft');
  assert.ok(bc.isBlogTask(p));
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
