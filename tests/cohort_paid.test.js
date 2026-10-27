#!/usr/bin/env node
/* cohort_backtest paid 侧（2026-10-27 接线，W18 Gate C 欠账）单测。
   跑法：node tests/cohort_paid.test.js。批次样例取自 louvresky #1626 真实收口 note 形态。 */
const assert = require('assert');
const cb = require('../seo-worker/tools/cohort_backtest');
const labels = require('../seo-worker/lib/labels');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

t('paidOpsClass：否词止血、出价预算学习期、默认文案', () => {
  assert.strictEqual(cb.paidOpsClass('negative-keyword-add'), 'bleed');
  assert.strictEqual(cb.paidOpsClass('campaign-criteria-update'), 'bleed');
  assert.strictEqual(cb.paidOpsClass('budget-update'), 'learn');
  assert.strictEqual(cb.paidOpsClass('target-cpa-adjust'), 'learn');
  assert.strictEqual(cb.paidOpsClass('ad-copy-rewrite'), 'copy');
  assert.strictEqual(cb.paidOpsClass(''), 'copy');
});

t('paidWindow：止血 14d 紧跟落地，出价预算跳 7 天学习期，前后窗等长', () => {
  const b = cb.paidWindow('bleed', '2026-10-01');
  assert.strictEqual(b.start, '2026-10-02');
  assert.strictEqual(b.end, '2026-10-15');
  assert.strictEqual(b.before.start, '2026-09-17');
  assert.strictEqual(b.before.end, '2026-09-30');
  const l = cb.paidWindow('learn', '2026-10-01');
  assert.strictEqual(l.start, '2026-10-09', '跳过 7 天学习期');
  assert.strictEqual(l.end, '2026-11-05');
  assert.strictEqual(l.winLen, 28);
  assert.ok(l.ready_at > l.end, '成熟日在窗末加数据滞后之后');
});

t('extractPaidBatch：#1626 形态的 note 抠出 ad 与 asset group，module 不是 paid/sem 不收', () => {
  const note = '[applied] 受影响: ad 813218677176；ad 813218683146；asset 432579500572（新建）；'
    + 'assetGroup 6687217973 DESCRIPTION；customers/4386658476/assetGroupAssets/6480964884~290958326489~LONG_HEADLINE（已 REMOVED）\n'
    + '执行记录 apply-log-task-1626-2026-10-23-1792733819122.md';
  const b = cb.extractPaidBatch({ id: 1626, module: 'paid', status: 'done', ops: 'ad-copy-rewrite', title: 'x', result_note: note });
  assert.ok(b, '应抠出批次');
  assert.strictEqual(b.applied, '2026-10-23');
  assert.strictEqual(b.klass, 'copy');
  assert.ok(b.ads.indexOf('813218677176') !== -1);
  assert.ok(b.assetGroups.indexOf('6687217973') !== -1);
  assert.ok(b.assetGroups.indexOf('6480964884') !== -1, 'resource name 里的 assetGroupAssets 归 asset group');
  assert.strictEqual(cb.extractPaidBatch({ id: 1, module: 'technical', status: 'done', result_note: note }), null, '非 paid 不收');
  assert.strictEqual(cb.extractPaidBatch({ id: 2, module: 'paid', status: 'review', result_note: note }), null, '未收口不收');
  assert.strictEqual(cb.extractPaidBatch({ id: 3, module: 'sem', status: 'done', result_note: '没有落地标' }), null, '无 [applied] 不收');
});

t('paidVerdict copy：曝光不足只标低量，CTR 升破 10% 判 improved', () => {
  const low = cb.paidVerdict('copy', { impressions: 300, ctr: 2 }, { impressions: 400, ctr: 3 });
  assert.strictEqual(low.status, 'low_volume');
  assert.strictEqual(low.verdict, null);
  const up = cb.paidVerdict('copy', { impressions: 5000, ctr: 2.0, conversions: 0 }, { impressions: 5200, ctr: 2.4, conversions: 0 });
  assert.strictEqual(up.status, 'measured');
  assert.strictEqual(up.verdict, 'improved');
});

t('paidVerdict learn：转化不满 30 不判；满量按 CPA 判', () => {
  const low = cb.paidVerdict('learn', { conversions: 10, cost: 500, cpa: 50 }, { conversions: 12, cost: 500, cpa: 41.7 });
  assert.strictEqual(low.status, 'low_volume', '合计 22 不满 30');
  const ok = cb.paidVerdict('learn', { conversions: 20, cost: 1000, cpa: 50 }, { conversions: 25, cost: 1000, cpa: 40 });
  assert.strictEqual(ok.status, 'measured');
  assert.strictEqual(ok.verdict, 'improved', 'CPA 降 20%');
  const bad = cb.paidVerdict('learn', { conversions: 20, cost: 1000, cpa: 50 }, { conversions: 15, cost: 900, cpa: 60 });
  assert.strictEqual(bad.verdict, 'declined');
});

t('paidVerdict bleed：低转化按花费判（止血的本义是省钱）', () => {
  const v = cb.paidVerdict('bleed', { conversions: 5, cost: 800, cpa: 160 }, { conversions: 6, cost: 600, cpa: 100 });
  assert.strictEqual(v.status, 'measured');
  assert.strictEqual(v.verdict, 'improved');
  assert.ok(v.why.indexOf('花费') !== -1);
});

t('paidConfound：同 campaign 落地日进窗标混杂，不相交不标，账户级从严', () => {
  const win = cb.paidWindow('copy', '2026-10-01');
  const me = { taskId: 1, applied: '2026-10-01', campaignIds: ['100', '200'], win };
  assert.ok(cb.paidConfound(me, [me, { taskId: 2, applied: '2026-10-10', campaignIds: ['200'] }]), '同 campaign 窗内落地');
  assert.strictEqual(cb.paidConfound(me, [{ taskId: 3, applied: '2026-10-10', campaignIds: ['999'] }]), '', '不同 campaign 不混杂');
  assert.strictEqual(cb.paidConfound(me, [{ taskId: 4, applied: '2026-12-01', campaignIds: ['100'] }]), '', '窗外不混杂');
  assert.ok(cb.paidConfound(me, [{ taskId: 5, applied: '2026-10-10', campaignIds: [] }]), '账户级口径从严');
});

t('cohortLabel paid 行：module=paid、verdict 直取、低量混杂进不来', () => {
  const l = labels.cohortLabel({
    taskId: 1626, channel: 'paid', status: 'measured', verdict: 'improved',
    why: 'CTR 2% 到 2.4%（20%，文案资产类主指标）', klass: 'copy', scope: 'campaign',
    window_days: 28, measured_at: '2026-11-25',
  }, 'louvresky');
  assert.ok(l, '应出标签');
  assert.strictEqual(l.module, 'paid');
  assert.strictEqual(l.verdict, 'improved');
  assert.strictEqual(l.signal, 'cohort');
  assert.ok(l.why.indexOf('copy') !== -1);
  assert.strictEqual(labels.cohortLabel({ taskId: 1, channel: 'paid', status: 'low_volume' }, 'x'), null, '低量不出标签');
  assert.strictEqual(labels.cohortLabel({ taskId: 2, channel: 'paid', status: 'confounded' }, 'x'), null, '混杂不出标签');
  const seo = labels.cohortLabel({ taskId: 3, status: 'measured', delta: { clicks: 5 }, measured_at: '2026-10-01', window_days: 28 }, 'x');
  assert.strictEqual(seo.module, 'seo', 'SEO 行为老路不变');
  assert.strictEqual(seo.verdict, 'improved');
});

console.log('\ncohort_paid.test: ' + pass + ' 过 ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
