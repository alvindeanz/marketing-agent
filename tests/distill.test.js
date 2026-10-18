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

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
