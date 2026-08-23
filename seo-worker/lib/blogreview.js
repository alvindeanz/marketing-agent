'use strict';
// Blog client review sweep.
//
// The client reviews a draft on its preview page and presses one of two buttons.
// Approve publishes the post there and then, on the platform, without telling us.
// Request changes records a round on the post, also without telling us. This
// sweep is the part that notices, so the board stops needing a human to babysit
// the handoff:
//
//   published        -> the task is finished, close it and record the live URL
//   changes_requested -> append the new rounds to the task and queue a revision
//
// Zero LLM. Everything here is an HTTP GET plus a small ledger write. The
// revision itself is a normal execute_task job that the worker picks up through
// the usual queue, so nothing about this file schedules a model.
//
// Failure policy: one bad client or one bad task never stops the sweep, and the
// sweep never throws into the listener's timer.

const path = require('node:path');

const wf = require('./webforger');
const { ensureClientWorkspace, summarize, truncate } = require('./util');

// The platform's review choice enum, in the client's own words.
const CHOICE_LABELS = {
  title: '标题',
  opening: '开头',
  tone: '语气',
  depth: '深度',
  facts: '事实',
  images: '图片',
  length: '篇幅',
  seo: 'SEO',
  other: '其他',
};

const REVIEW_MARK = '[客户审阅';
const MAX_ROUNDS = 20;

function choiceLabels(choices) {
  const list = Array.isArray(choices) ? choices : [];
  const out = list
    .map((c) => CHOICE_LABELS[String(c || '').trim().toLowerCase()] || String(c || '').trim())
    .filter(Boolean);
  return out.length ? out.join('、') : '未指定';
}

/** Timestamp trimmed to minutes, enough to tell rounds apart in a note. */
function roundStamp(at) {
  const s = String(at || '').trim();
  if (!s) return '时间未知';
  return s.replace('T', ' ').slice(0, 16);
}

/**
 * How many review rounds the task's note already carries.
 * The highest round number wins over a plain count, so a hand edited note that
 * dropped a line cannot make the sweep replay rounds the writer already saw.
 */
function roundsAlreadyRecorded(resultNote) {
  const note = String(resultNote || '');
  if (!note) return 0;
  let max = 0;
  const re = /\[客户审阅\s*第(\d+)轮/g;
  let m;
  while ((m = re.exec(note)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  if (max) return max;
  const plain = note.split(REVIEW_MARK).length - 1;
  return plain > 0 ? plain : 0;
}

/** One fixed format line per round, appended to the task's result_note. */
function roundLine(n, round) {
  const comment = truncate(String((round && round.comment) || '').replace(/\s+/g, ' ').trim(), 2000);
  return (
    '[客户审阅 第' + n + '轮 ' + roundStamp(round && round.at) + '] 方向：' +
    choiceLabels(round && round.choices) +
    '；意见：' + (comment || '（客户没有写文字说明）')
  );
}

/** Only the rounds where the client asked for changes, in platform order. */
function changeRounds(review) {
  const rounds = (review && Array.isArray(review.rounds) && review.rounds) || [];
  return rounds.filter((r) => r && String(r.action) === 'changes_requested').slice(0, MAX_ROUNDS);
}

/**
 * One task. Returns a short verdict string for the sweep log.
 * Throws only on things the caller should see; routine mismatches just report.
 */
async function handleTask(deps, client, task) {
  const { api, log, cfg } = deps;
  const slug = wf.slugFromBlogUrl(task.output_url);
  if (!slug) return 'task ' + task.id + '：output_url 解析不出 slug，跳过';

  const got = await client.getPost(slug);
  const post = (got && got.post) || null;
  if (!post) return 'task ' + task.id + '：平台上找不到 ' + slug + '，跳过';

  const status = String(post.status || '').toLowerCase();
  const review = post.review || {};
  const reviewStatus = String(review.status || '').toLowerCase();

  // 1. The client approved, which publishes on the spot. Close the task.
  if (status === 'published') {
    const publicUrl = wf.publicUrlOf(task.output_url);
    let verdict = '';
    try {
      const live = await wf.fetchPublic(publicUrl, cfg.httpTimeoutMs);
      verdict = live.status === 200 ? '线上 200 已验证' : '线上回读返回 ' + live.status + '，需人核对';
    } catch (e) {
      verdict = '线上回读失败（' + summarize(e.message, 120) + '），需人核对';
    }
    // The publish already happened and was the client's own doing, so the task
    // closes either way. A failed check goes in the note, not in the way.
    await api.completeTask(task.id, {
      note: '客户已在预览页确认发布，正式 URL ' + publicUrl + '。' + verdict,
    });
    log('task ' + task.id + '：客户已确认发布，任务办结（' + verdict + '）');
    return 'task ' + task.id + '：已办结';
  }

  // 2. The client asked for changes. Record what is new, then queue one pass.
  if (reviewStatus === 'changes_requested') {
    const rounds = changeRounds(review);
    const seen = roundsAlreadyRecorded(task.result_note);
    if (rounds.length <= seen) return 'task ' + task.id + '：已记录 ' + seen + ' 轮，无新增';

    const fresh = [];
    for (let i = seen; i < rounds.length; i += 1) fresh.push(roundLine(i + 1, rounds[i]));
    // postTaskResult is the append path: it CONCAT_WS onto result_note and sets
    // status to review, which this task already is, so nothing moves. The
    // existing output_url is passed back so the preview link is not cleared.
    await api.postTaskResult(task.id, {
      output_url: task.output_url,
      note: fresh.join('\n'),
    });
    log('task ' + task.id + '：记入 ' + fresh.length + ' 条新客户意见（累计 ' + rounds.length + ' 轮）');

    try {
      const res = await api.requestRevise(task.id, '客户审阅第 ' + rounds.length + ' 轮意见，自动触发改稿');
      log('task ' + task.id + '：已排改稿 job #' + ((res && res.job_id) || '?'));
      return 'task ' + task.id + '：记入 ' + fresh.length + ' 轮并排队改稿';
    } catch (e) {
      if (e && e.status === 409) {
        // Something is already running for this client. The note is written, so
        // the next tick sees no new rounds and only retries the enqueue.
        log('task ' + task.id + '：该客户已有 execute_task 在跑，改稿排队推迟到下个 tick');
        return 'task ' + task.id + '：意见已记入，排队 409 推迟';
      }
      throw e;
    }
  }

  // 3. Approved but not published. Per the platform contract approve publishes
  // immediately, so this means something went wrong on their side.
  if (reviewStatus === 'approved') {
    log(
      '警告 task ' + task.id + '：平台 review 是 approved 但文章仍是 ' + (status || '未知') +
        '，按契约 approve 应当立即发布，不动作，请人工核对 ' + slug
    );
    return 'task ' + task.id + '：approved 但未发布，已告警';
  }

  return 'task ' + task.id + '：客户还没审（状态 ' + (status || '未知') + '）';
}

/**
 * Which tasks to watch. The API endpoint is the real answer; the config list is
 * a fallback for a worker running against an API that predates it.
 */
async function collectTasks(deps) {
  const { api, cfg, log } = deps;
  try {
    const res = await api.listBlogReviewWatch();
    return { tasks: (res && res.tasks) || [], source: 'api' };
  } catch (e) {
    if (!(e && (e.status === 404 || e.status === 400))) throw e;
    log('巡检：/blog_review_watch 不可用（' + e.status + '），退回 config 里的 blogReviewClients');
  }
  const ids = cfg.blogReviewClients || [];
  if (!ids.length) return { tasks: [], source: 'none' };
  const tasks = [];
  for (const cid of ids) {
    try {
      const ctx = await api.getContext(cid);
      for (const t of (ctx && ctx.tasks) || []) {
        const ops = String(t.ops || '').toLowerCase();
        if (t.status === 'review' && ops.indexOf('blog-draft') !== -1 && t.output_url) {
          tasks.push({
            id: t.id,
            client_id: cid,
            ops: t.ops,
            output_url: t.output_url,
            result_note: t.result_note,
          });
        }
      }
    } catch (e) {
      log('巡检：客户 ' + cid + ' 的 context 读不到，跳过 :: ' + e.message);
    }
  }
  return { tasks, source: 'config' };
}

/**
 * One sweep pass. Never throws: the listener calls this from a timer and a
 * resident service must not fall over because a client site was unreachable.
 * Returns a small summary for the health endpoint.
 */
async function sweep(deps) {
  const { api, cfg, log } = deps;
  const out = { checked: 0, completed: 0, revised: 0, errors: 0, source: 'none' };
  if (!cfg.blogReviewEnabled) return Object.assign(out, { skipped: 'disabled' });

  let found;
  try {
    found = await collectTasks(deps);
  } catch (e) {
    log('巡检：任务枚举失败，本轮跳过 :: ' + e.message);
    out.errors += 1;
    return out;
  }
  out.source = found.source;
  if (!found.tasks.length) return out;

  // Group by client so each site is logged into once per sweep.
  const byClient = new Map();
  for (const t of found.tasks) {
    const cid = Number(t.client_id);
    if (!byClient.has(cid)) byClient.set(cid, []);
    byClient.get(cid).push(t);
  }
  log('巡检：' + found.tasks.length + ' 个待审博客任务，分布在 ' + byClient.size + ' 个客户');

  for (const [cid, tasks] of byClient) {
    let client;
    try {
      const ctx = await api.getContext(cid);
      const profile = (ctx && ctx.profile) || null;
      if (!profile) {
        log('巡检：客户 ' + cid + ' 没有 profile，跳过');
        continue;
      }
      const workspace = ensureClientWorkspace(profile, cfg);
      const credPath = path.join(
        workspace,
        'notes',
        String(profile.platform || 'platform').toLowerCase().replace(/[^a-z0-9_-]/g, '') + '_credentials.md'
      );
      const cred = wf.readCredentials(credPath);
      client = new wf.WebForger({
        base: cfg.webforgerApi,
        timeoutMs: cfg.httpTimeoutMs,
        lang: cfg.blogLang || '',
      });
      await client.login(cred.email, cred.password);
    } catch (e) {
      // Missing credentials or a login failure is a per client problem.
      log('巡检：客户 ' + cid + ' 登录失败，跳过本轮 :: ' + summarize(e.message, 200));
      out.errors += 1;
      continue;
    }

    for (const task of tasks) {
      out.checked += 1;
      try {
        const verdict = await handleTask(deps, client, task);
        if (verdict.indexOf('已办结') !== -1) out.completed += 1;
        if (verdict.indexOf('改稿') !== -1) out.revised += 1;
      } catch (e) {
        out.errors += 1;
        log('巡检：task ' + task.id + ' 处理失败，继续下一个 :: ' + summarize(e.message, 250));
      }
    }
  }

  if (out.checked) {
    log(
      '巡检完成：查 ' + out.checked + ' 个，办结 ' + out.completed + ' 个，触发改稿 ' + out.revised +
        ' 个，失败 ' + out.errors + ' 个'
    );
  }
  return out;
}

module.exports = {
  sweep,
  handleTask,
  collectTasks,
  roundsAlreadyRecorded,
  roundLine,
  changeRounds,
  choiceLabels,
  CHOICE_LABELS,
  REVIEW_MARK,
};
