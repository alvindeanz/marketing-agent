#!/usr/bin/env node
/* review_plan 判定的纯函数单测。
   跑法：node tests/review.test.js
   覆盖：cleanVerdicts 的归一化（批外任务丢弃、重复只认第一条、非法 verdict 降 later、
        merge 目标无效降 later、无 evidence 降 later、漏判补 later、adjust 只留给 do）、
        buildPrompt 含原则全文与任务号、taskBlock 的字段、runWith 的失败不落库。
   不碰网络、不调模型、不写 250。 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const W = path.join(__dirname, '..', 'seo-worker');
const R = require(path.join(W, 'runners', 'review_plan'));

let pass = 0,
  fail = 0;
const pending = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(
        r.then(
          () => {
            pass++;
            console.log('  ok   ' + name);
          },
          (e) => {
            fail++;
            console.log('  FAIL ' + name + '\n       ' + e.message);
          }
        )
      );
      return;
    }
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL ' + name + '\n       ' + e.message);
  }
}

const quiet = () => {};

console.log('cleanVerdicts');

t('keeps a well formed verdict as is', () => {
  const out = R.cleanVerdicts(
    { verdicts: [{ task_id: 1, verdict: 'do', reason: '首页无 meta', evidence: 'GSC 48% 点击', adjust: '别写 220' }] },
    [1],
    [1, 2],
    quiet
  );
  assert.strictEqual(out.verdicts.length, 1);
  assert.deepStrictEqual(out.verdicts[0], {
    task_id: 1,
    verdict: 'do',
    reason: '首页无 meta',
    evidence: 'GSC 48% 点击',
    merge_into: 0,
    adjust: '别写 220',
  });
});

t('drops a verdict for a task outside the batch', () => {
  const out = R.cleanVerdicts(
    { verdicts: [{ task_id: 9, verdict: 'drop', reason: 'x', evidence: 'y' }, { task_id: 1, verdict: 'do', reason: 'a', evidence: 'b' }] },
    [1],
    [1, 9],
    quiet
  );
  assert.strictEqual(out.verdicts.length, 1);
  assert.strictEqual(out.verdicts[0].task_id, 1);
});

t('a duplicate verdict keeps the first one', () => {
  const out = R.cleanVerdicts(
    { verdicts: [{ task_id: 1, verdict: 'do', reason: 'first', evidence: 'e' }, { task_id: 1, verdict: 'drop', reason: 'second', evidence: 'e' }] },
    [1],
    [1],
    quiet
  );
  assert.strictEqual(out.verdicts[0].verdict, 'do');
  assert.strictEqual(out.verdicts[0].reason, 'first');
});

t('an unknown verdict value becomes later and says so', () => {
  const out = R.cleanVerdicts({ verdicts: [{ task_id: 1, verdict: 'maybe', reason: 'r', evidence: 'e' }] }, [1], [1], quiet);
  assert.strictEqual(out.verdicts[0].verdict, 'later');
  assert.ok(out.verdicts[0].reason.indexOf('判决值不合法') === 0);
});

t('merge into a task that does not exist becomes later', () => {
  const out = R.cleanVerdicts({ verdicts: [{ task_id: 1, verdict: 'merge', merge_into: 77, reason: 'r', evidence: 'e' }] }, [1], [1, 2], quiet);
  assert.strictEqual(out.verdicts[0].verdict, 'later');
  assert.strictEqual(out.verdicts[0].merge_into, 0);
  assert.ok(out.verdicts[0].reason.indexOf('并入目标无效') === 0);
});

t('merge into itself becomes later', () => {
  const out = R.cleanVerdicts({ verdicts: [{ task_id: 1, verdict: 'merge', merge_into: 1, reason: 'r', evidence: 'e' }] }, [1], [1], quiet);
  assert.strictEqual(out.verdicts[0].verdict, 'later');
});

t('merge into a known task outside the batch is allowed', () => {
  const out = R.cleanVerdicts({ verdicts: [{ task_id: 1, verdict: 'merge', merge_into: 2, reason: 'r', evidence: 'e' }] }, [1], [1, 2], quiet);
  assert.strictEqual(out.verdicts[0].verdict, 'merge');
  assert.strictEqual(out.verdicts[0].merge_into, 2);
});

t('a drop without evidence is downgraded to later', () => {
  const out = R.cleanVerdicts({ verdicts: [{ task_id: 1, verdict: 'drop', reason: '不值' }] }, [1], [1], quiet);
  assert.strictEqual(out.verdicts[0].verdict, 'later');
  assert.ok(out.verdicts[0].reason.indexOf('证据缺失') === 0);
});

t('a later without evidence stays later', () => {
  const out = R.cleanVerdicts({ verdicts: [{ task_id: 1, verdict: 'later', reason: '等 fact' }] }, [1], [1], quiet);
  assert.strictEqual(out.verdicts[0].verdict, 'later');
  assert.strictEqual(out.verdicts[0].reason, '等 fact');
});

t('a task the model forgot gets a later placeholder', () => {
  const out = R.cleanVerdicts({ verdicts: [{ task_id: 1, verdict: 'do', reason: 'r', evidence: 'e' }] }, [1, 2], [1, 2], quiet);
  assert.strictEqual(out.verdicts.length, 2);
  const two = out.verdicts.find((v) => v.task_id === 2);
  assert.strictEqual(two.verdict, 'later');
  assert.ok(two.reason.indexOf('模型未给出判决') === 0);
});

t('adjust is only kept on a do', () => {
  const out = R.cleanVerdicts({ verdicts: [{ task_id: 1, verdict: 'drop', reason: 'r', evidence: 'e', adjust: 'x' }] }, [1], [1], quiet);
  assert.strictEqual(out.verdicts[0].adjust, '');
});

t('reason is capped', () => {
  const out = R.cleanVerdicts({ verdicts: [{ task_id: 1, verdict: 'do', reason: '长'.repeat(500), evidence: 'e' }] }, [1], [1], quiet);
  assert.ok(out.verdicts[0].reason.length <= 80);
});

t('summary is carried and capped', () => {
  const out = R.cleanVerdicts({ summary: '好'.repeat(1000), verdicts: [] }, [], [], quiet);
  assert.ok(out.summary.length <= 300 && out.summary.length > 0);
});

t('no verdicts at all yields one later per batch task', () => {
  const out = R.cleanVerdicts({}, [3, 4], [3, 4], quiet);
  assert.strictEqual(out.verdicts.length, 2);
  assert.ok(out.verdicts.every((v) => v.verdict === 'later'));
});

console.log('buildPrompt / taskBlock');

t('principles file exists and carries the five questions', () => {
  const text = R.loadPrinciples();
  assert.ok(text.indexOf('不做会怎样') > 0);
  assert.ok(text.indexOf('收益量级对成本量级') > 0);
  assert.ok(text.indexOf('是不是我们的活') > 0);
  assert.ok(text.indexOf('前提还成不成立') > 0);
  assert.ok(text.indexOf('顺序对不对') > 0);
});

t('prompt carries the principles, the briefing, and every task id', () => {
  const p = R.buildPrompt({
    principles: 'PRINCIPLES-MARK',
    briefing: 'BRIEF-MARK',
    tasks: [
      { id: 82, title: '首页标题', status: 'approved', priority: 'P0', module: 'onpage', detail: '补 meta', ops: 'page-meta-update' },
      { id: 84, title: 'GSC 审计', status: 'approved', priority: 'P0', module: 'technical', detail: '只读' },
    ],
    clientName: 'Louvresky',
  });
  assert.ok(p.indexOf('PRINCIPLES-MARK') > 0);
  assert.ok(p.indexOf('BRIEF-MARK') > p.indexOf('PRINCIPLES-MARK'));
  assert.ok(p.indexOf('#82、#84') > 0);
  assert.ok(p.indexOf('Louvresky') > 0);
  assert.ok(p.indexOf('```json') > 0);
});

t('taskBlock shows ops and a flattened detail', () => {
  const b = R.taskBlock({ id: 5, title: 'T', status: 'proposed', priority: 'P1', module: 'content', sprint: 'S2', ops: 'blog-draft', detail: 'a\n\nb' });
  assert.ok(b.indexOf('#5 [proposed] [P1] [content] [S2] T') === 0);
  assert.ok(b.indexOf('ops：blog-draft') > 0);
  assert.ok(b.indexOf('说明：a b') > 0);
});

t('a review task carries its change plan, a missing plan is stated', () => {
  const ws = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rvp-'));
  fs.mkdirSync(path.join(ws, 'seo-agent-output'));
  fs.writeFileSync(path.join(ws, 'seo-agent-output', 'change-plan-task-82.md'), '# 方案 82\n改首页 meta');
  const out = R.attachChangePlans(
    [{ id: 82, status: 'review', title: 'A' }, { id: 83, status: 'review', title: 'B' }, { id: 84, status: 'approved', title: 'C' }],
    ws,
    quiet
  );
  assert.ok(out[0].change_plan.indexOf('改首页 meta') > 0);
  assert.strictEqual(out[1].change_plan, undefined);
  assert.strictEqual(out[2].change_plan, undefined);
  const b82 = R.taskBlock(out[0]);
  assert.ok(b82.indexOf('方案该不该落地') > 0 && b82.indexOf('改首页 meta') > 0);
  const b83 = R.taskBlock(out[1]);
  assert.ok(b83.indexOf('方案缺失') > 0);
  const b84 = R.taskBlock(out[2]);
  assert.ok(b84.indexOf('方案') === -1);
});

t('review 任务没有方案时改附大纲或最新草稿', () => {
  const ws = fs.mkdtempSync(path.join(require('os').tmpdir(), 'rva-'));
  fs.mkdirSync(path.join(ws, 'seo-agent-output', 'task-88'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'seo-agent-output', 'task-88', 'outline-task-88.md'), '# 大纲');
  fs.writeFileSync(path.join(ws, 'seo-agent-output', 'blog-task-89-1.md'), 'old');
  fs.writeFileSync(path.join(ws, 'seo-agent-output', 'blog-task-89-2.md'), 'new');
  assert.strictEqual(R.reviewArtifactFor(ws, 88).kind, '博客大纲');
  assert.ok(R.reviewArtifactFor(ws, 89).file.endsWith('blog-task-89-2.md'));
  assert.strictEqual(R.reviewArtifactFor(ws, 90), null);
  const out = R.attachChangePlans([{ id: 88, status: 'review', title: 'A' }], ws, () => {});
  assert.strictEqual(out[0].artifact_kind, '博客大纲');
  assert.ok(R.taskBlock(out[0]).indexOf('博客大纲开始') > 0);
});

console.log('runWith');

function fakeCtx(tasks, judge) {
  const calls = { review: null };
  return {
    ctx: {
      job: { id: 500, client_id: 16, payload: { task_ids: tasks.map((t) => t.id) } },
      cfg: { workspaceRoot: fs.mkdtempSync(path.join(require('os').tmpdir(), 'rv-')), defaultClientDir: 'x' },
      log: quiet,
      api: {
        getContext: async () => ({
          profile: { name: 'Louvresky', workspace_dir: 'louvresky' },
          client: { id: 16, name: 'Louvresky' },
          tasks,
          facts: { confirmed: [], pending: [] },
          latest_snapshots: {},
        }),
        postReviewResult: async (body) => {
          calls.review = body;
          return { ok: true, written: body.verdicts.length };
        },
      },
    },
    calls,
    judge,
  };
}

t('a good judgment lands one verdict per task', async () => {
  const tasks = [{ id: 1, title: 'A', status: 'approved' }, { id: 2, title: 'B', status: 'proposed' }];
  const f = fakeCtx(tasks, async () => ({ ok: true, json: { summary: 's', verdicts: [{ task_id: 1, verdict: 'do', reason: 'r', evidence: 'e' }, { task_id: 2, verdict: 'merge', merge_into: 1, reason: 'r', evidence: 'e' }] } }));
  await R.runWith(f.ctx, f.judge);
  assert.ok(f.calls.review);
  assert.strictEqual(f.calls.review.client_id, 16);
  assert.strictEqual(f.calls.review.job_id, 500);
  assert.strictEqual(f.calls.review.verdicts.length, 2);
  assert.strictEqual(f.calls.review.verdicts[1].merge_into, 1);
});

t('an unparsable judgment writes nothing and fails the job', async () => {
  const tasks = [{ id: 1, title: 'A', status: 'approved' }];
  const f = fakeCtx(tasks, async () => ({ ok: false, error: 'no json' }));
  let threw = false;
  try {
    await R.runWith(f.ctx, f.judge);
  } catch (e) {
    threw = true;
    assert.ok(e.message.indexOf('判定输出无法解析') === 0);
  }
  assert.ok(threw);
  assert.strictEqual(f.calls.review, null);
});

t('a batch over the cap is refused before any model call', async () => {
  const tasks = [];
  for (let i = 1; i <= 21; i += 1) tasks.push({ id: i, title: 'T' + i, status: 'approved' });
  let called = false;
  const f = fakeCtx(tasks, async () => {
    called = true;
    return { ok: true, json: { verdicts: [] } };
  });
  let threw = false;
  try {
    await R.runWith(f.ctx, f.judge);
  } catch (e) {
    threw = true;
  }
  assert.ok(threw && !called);
});

Promise.all(pending).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
