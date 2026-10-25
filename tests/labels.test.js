#!/usr/bin/env node
/* T2 标签回挂（lib/labels.js）与 T4 Gate 判定（tools/label_stats.js）单测。
   跑法：node tests/labels.test.js。spotcheck 样例取自真实台账 run_2026-10-21-07-02.md。 */
const assert = require('assert');
const labels = require('../seo-worker/lib/labels');
const { gateA } = require('../seo-worker/tools/label_stats');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

t('moduleOf：module 字段优先，缺字段按 ops 词面，默认 seo', () => {
  assert.strictEqual(labels.moduleOf({ module: 'paid' }), 'paid');
  assert.strictEqual(labels.moduleOf({ module: 'sem' }), 'paid');
  assert.strictEqual(labels.moduleOf({ module: 'content', ops: 'negative-keyword-add' }), 'seo', 'module 在场时 ops 不参与');
  assert.strictEqual(labels.moduleOf({ ops: 'negative-keyword-add,keyword-bid-adjust' }), 'paid');
  assert.strictEqual(labels.moduleOf({ ops: 'page-rewrite,content-edit' }), 'seo');
  assert.strictEqual(labels.moduleOf({}), 'seo');
});

t('overrideLabel：有推翻才出 label，形状齐', () => {
  assert.strictEqual(labels.overrideLabel({ id: 1, review_verdict: 'do' }, 5), null, '无推翻无 label');
  const l = labels.overrideLabel({
    id: 99, module: 'paid', review_verdict: 'drop', review_override: 'do',
    review_override_note: '客户点名要做  这单', review_reviewed_at: '2026-10-01 10:00:00',
  }, 5);
  assert.strictEqual(l.signal, 'override');
  assert.strictEqual(l.id, 'task#99');
  assert.strictEqual(l.at, '2026-10-01');
  assert.strictEqual(l.module, 'paid');
  assert.strictEqual(l.verdict, 'do');
  assert.strictEqual(l.fable_verdict, 'drop');
  assert.strictEqual(l.why, '客户点名要做 这单', '空白折叠');
});

t('planRejectLabel：只收 rejected 且有理由', () => {
  assert.strictEqual(labels.planRejectLabel({ id: 1, status: 'active' }, 5), null);
  const l = labels.planRejectLabel({ id: 14, version: 2, status: 'rejected', reject_reason: '盲写作废' }, 5);
  assert.strictEqual(l.id, 'plan#14v2');
  assert.strictEqual(l.signal, 'plan_reject');
});

t('parseSpotcheckMd：真实台账行，只收 fail/warn，缩进行并进 why', () => {
  const md = [
    '# spotcheck 台账 2026-10-21T07:02:04.416Z',
    '参数：days=7 rate=0.1 max=12 apply=true',
    '',
    '- [ok] #77 Kuddles「/locations/ 加厚」ops=content-edit urls=2',
    '- [fail] #729 HornTech AU「英文 AI 搜索优化服务页重写」ops=page-rewrite,content-edit urls=3',
    '  - fail C2 页面源码含内部标记「Style Roll 注释」：https://example.com/a/',
    '- [warn] #61 Ben\'s Curtains AU「made-to-measure-curtains页精校」ops=page-rewrite urls=0',
    '  - warn C4 写类任务 note 找不到快照/回滚证据字样',
    '  - info C0 任务产出无可核 URL',
    '- [ok] #917 Ctomi「执行 #912 删词方案」ops=negative-keyword-remove urls=0',
  ].join('\n');
  const out = labels.parseSpotcheckMd(md, 'run_2026-10-21-07-02');
  assert.strictEqual(out.length, 2, 'ok 行不出 label');
  assert.strictEqual(out[0].verdict, 'fail');
  assert.strictEqual(out[0].id, 'spotcheck#729@run_2026-10-21-07-02');
  assert.strictEqual(out[0].at, '2026-10-21');
  assert.ok(out[0].why.includes('C2 页面源码含内部标记'));
  assert.strictEqual(out[0].module, 'seo');
  assert.strictEqual(out[1].verdict, 'warn');
  assert.ok(out[1].why.includes('C4'));
  assert.ok(out[1].why.includes('C0'), '多条缩进行拼接');
});

t('cohortLabel：measured 才出，delta 进 why，方向进 verdict', () => {
  assert.strictEqual(labels.cohortLabel({ taskId: 1, status: 'pending' }, 'x'), null);
  const l = labels.cohortLabel({
    taskId: 99, status: 'measured', measured_at: '2026-10-18', window_days: 28,
    delta: { clicks: 19, impressions: 905, ctr_pp: 0.01, position: 2.4 },
  }, 'apolloenergy');
  assert.strictEqual(l.id, 'cohort#99@apolloenergy@2026-10-18');
  assert.strictEqual(l.verdict, 'improved');
  assert.ok(l.why.includes('Δclicks 19'));
  assert.strictEqual(labels.cohortLabel({ taskId: 2, status: 'measured', delta: { clicks: -3 } }, 'x').verdict, 'declined');
  assert.strictEqual(labels.cohortLabel({ taskId: 3, status: 'measured', delta: { clicks: 0 } }, 'x').verdict, 'flat');
});

t('cardLabel：agree 是凭证不是信号，hold/other/flag 才收', () => {
  assert.strictEqual(labels.cardLabel({ task_id: 1, choice: 'agree', created_at: '2026-10-01 01:02:03' }, 5, {}), null);
  const l = labels.cardLabel({ task_id: 7, item: 'kw_1', choice: 'hold', fb: '再观察', created_at: '2026-10-01 01:02:03' }, 5, { 7: 'paid' });
  assert.strictEqual(l.signal, 'card');
  assert.strictEqual(l.module, 'paid');
  assert.strictEqual(l.verdict, 'hold');
  assert.strictEqual(l.id, 'card#7@kw_1@2026-10-01 01:02:03');
});

t('labelKey 去重键：signal + 全限定 id', () => {
  assert.strictEqual(labels.labelKey({ signal: 'override', id: 'task#9' }), 'override|task#9');
  assert.notStrictEqual(
    labels.labelKey({ signal: 'spotcheck', id: 'spotcheck#9@run_a' }),
    labels.labelKey({ signal: 'spotcheck', id: 'spotcheck#9@run_b' }),
    '同任务不同轮抽查是两条'
  );
});

t('gateA：50 总量与 20 单类型双门槛', () => {
  const mk = (n, v) => Array.from({ length: n }, () => ({ fable_verdict: v }));
  assert.strictEqual(gateA([]).open, false);
  assert.strictEqual(gateA(mk(49, 'do').concat(mk(1, 'drop'))).open, true, '50 条且 do 49 条');
  assert.strictEqual(gateA(mk(30, 'do')).open, false, '总量不足 50');
  const spread = gateA(mk(15, 'do').concat(mk(15, 'drop'), mk(15, 'later'), mk(15, 'merge')));
  assert.strictEqual(spread.open, false, '60 条但单类型最高 15 不过 20');
});

console.log(pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
