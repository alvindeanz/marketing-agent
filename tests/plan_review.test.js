#!/usr/bin/env node
/* plan_review（方案层过闸）的干跑单测。跑法：node tests/plan_review.test.js
   覆盖：cleanOutput 归一化（非法任务丢弃、changes 类型过滤、card 上限）、renderCard、
        buildPrompt 含经验与铁律与任务号、runWith 用假 api 与假模型跑通落库、
        v2 正文太短或无任务不落库。不碰网络、不调模型。 */
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-review-'));

const W = path.join(__dirname, '..', 'seo-worker');
const R = require(path.join(W, 'runners', 'plan_review'));

let pass = 0, fail = 0;
const pending = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(r.then(() => { pass++; console.log('  ok   ' + name); }, (e) => { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }));
      return;
    }
    pass++; console.log('  ok   ' + name);
  } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
const quiet = () => {};
const cap = { platform: 'WebForger', operations: [{ name: 'page-meta-update', autonomy: 'agent_prepare' }] };

console.log('cleanOutput');
t('keeps valid tasks, drops bad ones, filters change types, caps card arrays', () => {
  const out = R.cleanOutput({
    tasks: [
      { module: 'onpage', title: 'A', detail: 'd', owner_type: 'agent', sprint: 'S1', priority: 'P0', ops: ['page-meta-update'], from: [97, 'x'] },
      { module: 'nope', title: 'B', owner_type: 'agent', sprint: 'S1' },
    ],
    changes: [{ type: 'split', from: [110], why: '一任务一篇' }, { type: 'bogus', from: [], why: 'x' }],
    card: { goal: 'g', s1: ['a', 'b', 'c', 'd'], changed: ['1'], unsure: [], ask: '' },
  }, cap, quiet);
  assert.strictEqual(out.tasks.length, 1);
  assert.deepStrictEqual(out.tasks[0].from, [97]);
  assert.strictEqual(out.tasks[0].ops, 'page-meta-update');
  assert.strictEqual(out.dropped.length, 1);
  assert.strictEqual(out.changes.length, 1);
  assert.strictEqual(out.card.s1.length, 3);
  assert.ok(out.card.ask.length > 0, 'ask 有默认值');
});

console.log('renderCard');
t('renders the confirmation card with version and counts', () => {
  const s = R.renderCard({ goal: 'G', s1: ['x'], changed: ['c1'], unsure: [], ask: '确认方向' }, { version: 2, clientName: 'Apollo', taskCount: 9, v1Count: 11, changeCount: 3 });
  assert.ok(s.includes('方案 v2 方向确认'));
  assert.ok(s.includes('Apollo'));
  assert.ok(s.includes('任务 9 条（v1 11 条），改动 3 处'));
  assert.ok(s.includes('- 无'));
});

console.log('buildPrompt');
t('carries experience, client rules, briefing and task ids', () => {
  const p = R.buildPrompt({
    clientName: 'Apollo', experience: 'EXP-MARK', principles: 'PRIN', clientRules: 'RULE-MARK', globalRules: '- g1', history: '',
    briefing: 'BRIEF', planBody: 'BODY', tasks: [{ id: 97, title: 'T97', detail: 'd', sprint: 'S1', priority: 'P0', module: 'technical', owner_type: 'agency' }], capability: cap,
  });
  for (const m of ['EXP-MARK', 'RULE-MARK', 'BRIEF', 'BODY', '#97', 'page-meta-update', '"card"']) assert.ok(p.includes(m), 'missing ' + m);
});

console.log('runWith');
function fakeCtx(planStatus, posted) {
  return {
    cfg: { planReviewModel: 'fable', memoryDir: '/nonexistent', workspaceRoot: TMP },
    log: quiet,
    job: { id: 1, client_id: 8, payload: { plan_id: 8 } },
    api: {
      getPlan: async () => ({ plan: { id: 8, client_id: 8, version: 1, status: planStatus, body: 'v1' }, tasks: [{ id: 97, title: 'a', detail: 'd', sprint: 'S1', priority: 'P0', module: 'technical', owner_type: 'agency' }] }),
      getContext: async () => ({ profile: { name: 'Apollo', platform: 'WebForger', workspace_dir: 'apolloenergy', domain: 'https://x' }, client: { name: 'Apollo' }, tasks: [], facts: [] }),
      postPlanReviewResult: async (id, body) => { posted.id = id; posted.body = body; return { plan_id: 99, version: 2, ids: [201], closed: [97], card_id: 5, review_job_id: 7 }; },
    },
  };
}
const goodJson = { tasks: [{ module: 'onpage', title: 'v2 task', detail: 'd', owner_type: 'agent', sprint: 'S1', priority: 'P0', ops: ['page-meta-update'], from: [97] }], changes: [{ type: 'reword', from: [97], why: 'w' }], card: { goal: 'g', s1: ['a'], changed: ['c'], unsure: [], ask: '确认' } };
const longBody = 'v2 正文 '.repeat(60);

t('stores v2 with header, tasks, changes and card', async () => {
  const posted = {};
  const ctx = fakeCtx('draft', posted);
  await R.runWith(ctx, async () => ({ ok: true, json: goodJson, body: longBody }));
  assert.strictEqual(posted.id, 8);
  assert.ok(posted.body.body.startsWith('<!-- plan v2 by plan_review from v1'));
  assert.strictEqual(posted.body.tasks.length, 1);
  assert.strictEqual(posted.body.tasks[0].ops, 'page-meta-update');
  assert.strictEqual(posted.body.changes.length, 1);
  assert.ok(posted.body.card.includes('方案 v2 方向确认'));
});
t('refuses a non-draft plan', async () => {
  const posted = {};
  await assert.rejects(R.runWith(fakeCtx('active', posted), async () => ({ ok: true, json: goodJson, body: longBody })), /only a draft/);
  assert.strictEqual(posted.id, undefined);
});
t('does not store when v2 body is too short', async () => {
  const posted = {};
  await assert.rejects(R.runWith(fakeCtx('draft', posted), async () => ({ ok: true, json: goodJson, body: 'short' })), /太短/);
  assert.strictEqual(posted.id, undefined);
});
t('does not store when no task survives validation', async () => {
  const posted = {};
  await assert.rejects(R.runWith(fakeCtx('draft', posted), async () => ({ ok: true, json: { tasks: [{ title: 'x', module: 'nope' }], card: {} }, body: longBody })), /没有任何合法任务/);
  assert.strictEqual(posted.id, undefined);
});
t('model failure stores nothing', async () => {
  const posted = {};
  await assert.rejects(R.runWith(fakeCtx('draft', posted), async () => ({ ok: false, error: 'bad json' })), /无法解析/);
  assert.strictEqual(posted.id, undefined);
});

Promise.all(pending).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
