#!/usr/bin/env node
/* distill（简报蒸馏）的驳回反馈链路单测。跑法：node tests/distill.test.js
   背景：被拒方案不是 /context 的 active_plan，驳回理由要能从 killed 任务备注反推进简报
   （2026-10-18 Aiden 条子：plan 67 三处截断）。不碰网络、不调模型。 */
const assert = require('assert');
const path = require('path');

const D = require(path.join(__dirname, '..', 'seo-worker', 'lib', 'distill'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const REASON = '网站近期做了大量的更新，对比3个月前的冷启动，具体的内容需要参照\nhttps://webforger.ai/apps/\nhttps://webforger.ai/\nhttps://webforger.ai/pricing/\n这三个页面来重新onboard的方式规划seo';
const NOTE = '[killed] wf:agency:wfu_c6cb3371bf19c5acc2ee00d23e93c05a：方案 #67 被打回：' + REASON + '\n[2026-10-18] 其他追加段落';
const killedTask = (id, note) => ({ id, plan_id: 67, module: 'onpage', owner_type: 'agent', title: '任务' + id, status: 'done', result_note: note || NOTE });

console.log('lastRejectedFromTasks');
t('recovers the full multiline reason and stops at the next [tag] segment', () => {
  const got = D.lastRejectedFromTasks([killedTask(1450)], null);
  assert.ok(got, 'must find the rejection');
  assert.strictEqual(got.id, 67);
  assert.ok(got.reason.includes('https://webforger.ai/pricing/'), 'last URL line must survive');
  assert.ok(got.reason.includes('重新onboard的方式规划seo'));
  assert.ok(!got.reason.includes('其他追加段落'), 'later note segments excluded');
});
t('picks the newest rejected plan when several exist', () => {
  const older = killedTask(1300, '[killed] aira：方案 #63 被打回：老理由');
  const got = D.lastRejectedFromTasks([older, killedTask(1450)], null);
  assert.strictEqual(got.id, 67);
});
t('ignores rejections older than the active plan', () => {
  assert.strictEqual(D.lastRejectedFromTasks([killedTask(1450)], 70), null);
  assert.ok(D.lastRejectedFromTasks([killedTask(1450)], 65));
});
t('no killed-by-reject notes means null', () => {
  assert.strictEqual(D.lastRejectedFromTasks([{ id: 1, status: 'done', result_note: '[merged] 并入 #2' }], null), null);
});

console.log('buildPlanningBriefing feedback');
const baseCtx = (tasks, activePlan) => ({
  active_plan: activePlan || null,
  tasks,
  profile: { name: 'WebForger', domain: 'https://webforger.ai/' },
  facts: { confirmed: [], pending: [] },
});
t('rejected-plan reason reaches the briefing in full when there is no active plan', () => {
  const out = D.buildPlanningBriefing(baseCtx([killedTask(1450)]), { log: () => {} });
  assert.ok(out.text.includes('PREVIOUS PLAN FEEDBACK'));
  assert.ok(out.text.includes('https://webforger.ai/apps/'));
  assert.ok(out.text.includes('https://webforger.ai/pricing/'));
  assert.ok(out.text.includes('重新onboard的方式规划seo'));
  assert.ok(out.text.includes('recovered from the task ledger'));
});
t('active_plan reject_reason still wins over the ledger reconstruction', () => {
  const out = D.buildPlanningBriefing(
    baseCtx([killedTask(1450)], { id: 70, version: 7, status: 'active', reject_reason: '直给的理由' }),
    {}
  );
  assert.ok(out.text.includes('直给的理由'));
  assert.ok(!out.text.includes('recovered from the task ledger'));
});
t('ledger row keeps the URL lines and drops the actor prefix', () => {
  const out = D.buildPlanningBriefing(baseCtx([killedTask(1450)]), {});
  const row = out.text.split('\n').find((l) => l.startsWith('#1450'));
  assert.ok(row, 'ledger row exists');
  assert.ok(row.includes('killed'));
  assert.ok(row.includes('https://webforger.ai/apps/'), 'URL beyond the first newline survives in the row');
  assert.ok(!row.includes('wfu_c6cb3371'), 'actor prefix stripped');
});

console.log('priorOutcomesSection（续季：上一季结局，2026-11-17）');
const PRIOR = [
  { id: 1, status: 'done', plan_id: 3, sprint: 'S1', module: 'onpage', title: '首页 title 改写', ops: 'page-meta-update', updated_at: '2026-09-10 01:00:00' },
  { id: 2, status: 'done', plan_id: 3, sprint: 'S6', module: 'onpage', title: '产品页加厚', review_verdict: 'drop', review_reason: '商品描述正文属 human_only', updated_at: '2026-11-15 01:00:00' },
  { id: 3, status: 'done', plan_id: 3, sprint: 'S2', module: 'content', title: 'S2 配额博客', ops: 'blog-draft', updated_at: '2026-10-01 01:00:00' },
  { id: 4, status: 'done', origin: 'chatw:9', module: 'onpage', title: '新建配送页', ops: 'page-create', updated_at: '2026-11-06 01:00:00' },
  { id: 5, status: 'done', origin: 'report:9', module: 'onpage', title: '月报改稿', ops: 'report-html-update', updated_at: '2026-11-06 01:00:00' },
  { id: 6, status: 'done', plan_id: 2, sprint: 'S1', title: '被打回方案的收尸单', result_note: '[killed] aira：方案 #2 被打回：方向不对' },
  { id: 7, status: 'approved', plan_id: 3, sprint: 'S6', title: '没做完的不进结局' },
  { id: 8, status: 'done', plan_id: 3, sprint: 'S4', module: 'technical', title: '人工叫停的活', result_note: '检查: ok\n[killed] aira：客户不同意改导航' },
];
t('首份方案（没有已结束的计划内任务）返回空串，简报不标续季', () => {
  assert.strictEqual(D.priorOutcomesSection([]), '');
  assert.strictEqual(D.priorOutcomesSection([PRIOR[3], PRIOR[6]]), '');
  const out = D.buildPlanningBriefing(baseCtx([]), {});
  assert.strictEqual(out.renewal, false);
  assert.ok(!out.text.includes('PRIOR QUARTER OUTCOMES'));
});
t('已落地、丢弃带理由、计划外改站动作各归各节，过渡单与报告改稿不进', () => {
  const s = D.priorOutcomesSection(PRIOR);
  assert.ok(s.includes('#1 [S1][onpage] 首页 title 改写 | 2026-09-10'));
  assert.ok(s.includes('#2 [S6][onpage][dropped] 产品页加厚 :: 商品描述正文属 human_only'));
  assert.ok(s.includes('#8 [S4][technical][killed] 人工叫停的活 :: 客户不同意改导航'));
  assert.ok(s.includes('另有配额博客 1 篇'));
  assert.ok(s.includes('#4 [onpage][page-create] 新建配送页'));
  assert.ok(!s.includes('月报改稿'));
  assert.ok(!s.includes('收尸单'));
  assert.ok(!s.includes('没做完的不进结局'));
  assert.ok(s.includes('S6 落地 0 / 丢弃砍并 1'));
});
t('prior_tasks 挂上后简报带上一季结局并标续季', () => {
  const ctx = baseCtx([]);
  ctx.prior_tasks = PRIOR;
  const out = D.buildPlanningBriefing(ctx, {});
  assert.strictEqual(out.renewal, true);
  assert.ok(out.priorBytes > 0);
  assert.ok(out.text.includes('PRIOR QUARTER OUTCOMES'));
});
t('超长截断到预算内', () => {
  const many = [];
  for (let i = 0; i < 400; i++) many.push({ id: 1000 + i, status: 'done', plan_id: 3, sprint: 'S1', module: 'onpage', title: '很长的任务标题'.repeat(8), updated_at: '2026-09-10' });
  const s = D.priorOutcomesSection(many);
  assert.ok(Buffer.byteLength(s, 'utf8') <= 7 * 1024);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
