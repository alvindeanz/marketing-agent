'use strict';
/**
 * 博客节奏：一个 sprint 一篇（2026-09-23 Alvin 定）。
 *
 * 背景：合同口径每月两篇博客，sprint 是 14 天，所以一个 sprint 一篇。这条以前只写在 ops tracker
 * 的任务文字里，规划随手分配（有的 sprint 空、有的堆三篇），判定又能把合同内的博客判 drop/later，
 * 2026-09 WF 六家欠 7 篇。现在变成机器约束，三处生效：
 *   1. 规划落库（plan.js persist）：缺博客的 sprint 自动补占位任务，零模型；
 *   2. 判定清洗（review_plan.js）：写稿阶段的配额博客不许判 drop/later/merge，改判 do 并要求换题不空交；
 *   3. 补缺工具（tools/blog_cadence.js）：人手触发，给已空掉的 sprint 补任务（pull_data 是 cron，
 *      建任务会连带排判定 job 调模型，违反硬规矩 1，所以不放进 pull_data）。
 *
 * 开关：客户 confirmed fact `contract.blog_per_sprint`，值以正整数开头（如「1，2026-09-23 Alvin 定」）。
 * 没有这条 fact 的客户（客户自写博客、本季不写博客的）一律不受影响。
 * 口径：月报按实际发布日计数，sprint 与自然月不强行对齐。
 */

const FACT_KEY = 'contract.blog_per_sprint';
const SPRINT_DAYS = 14;
const SPRINTS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
/* 补缺只追到这一天为止：规矩 9 月立，9 月以前空掉的 sprint 不追溯。 */
const CATCHUP_FROM = '2026-09-01';

const NOT_BLOG_RE = /内链|封面|修订|体检|询盘|直链|死链|分类|补图|图片|hreflang|长音|确认页|复盘|审计|改稿|补新西兰|行情区间/;

function factsOf(context) {
  const f = (context && context.facts) || {};
  return Array.isArray(f) ? f : (f.confirmed || []);
}

/** 每个 sprint 应有几篇；0 = 本客户不受节奏约束。 */
function quotaOf(context) {
  const hit = factsOf(context).find((x) => x && x.fact_key === FACT_KEY);
  if (!hit) return 0;
  const m = String(hit.value || '').trim().match(/^(\d+)/);
  return m ? Math.max(0, Number(m[1])) : 0;
}

/** 写新博文的任务（不含内链、封面、修订、发布这类围着博客转的活）。
 *  标题里「，内链回 /collections/...」是交代落点，不算内链任务，先剥掉再判排除词。 */
function isBlogTask(t) {
  if (!t) return false;
  const ops = Array.isArray(t.ops) ? t.ops.join(',') : String(t.ops || '');
  const title = String(t.title || '');
  if (/配额博客/.test(title)) return true;
  const core = title.replace(/[，,]\s*(内链|导流)回.*$/, '');
  if (NOT_BLOG_RE.test(core) || /^\s*发布/.test(core)) return false;
  if (/博客|博文|新文|篇.*blog|blog post/i.test(core)) return true;
  return false;
}

/** 已死的任务（砍掉、并入、不做）不占配额。 */
function isDead(t) {
  const note = String((t && t.result_note) || '');
  if (String(t && t.status) === 'done' && /\[(dropped|merged|killed)\]/.test(note)) return true;
  return false;
}

/** 写稿阶段：还没出草稿。review 阶段的博客（草稿已出、等客户或等发布）判 later 是正当的等待，不保护。 */
function isWritingStage(t) {
  return ['proposed', 'approved', 'in_progress', 'blocked'].indexOf(String(t && t.status)) !== -1;
}

function sprintNum(s) {
  const m = String(s || '').match(/^S(\d)$/i);
  return m ? Number(m[1]) : 0;
}

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function sprintRange(anchor, n) {
  const start = addDays(anchor, SPRINT_DAYS * (n - 1));
  return { start, end: addDays(start, SPRINT_DAYS - 1) };
}

function currentSprint(anchor, today) {
  if (!anchor) return 0;
  const days = Math.floor((Date.parse(today + 'T00:00:00Z') - Date.parse(anchor + 'T00:00:00Z')) / 86400000);
  if (days < 0) return 1;
  return Math.min(6, Math.floor(days / SPRINT_DAYS) + 1);
}

/** 每个 sprint 的活博客任务数。sprint 不是 S1..S6 的（如 W38）不计入任何 sprint。 */
function countBySprint(tasks) {
  const out = {};
  for (const s of SPRINTS) out[s] = [];
  for (const t of tasks || []) {
    if (!isBlogTask(t) || isDead(t)) continue;
    const s = String(t.sprint || '').toUpperCase();
    if (out[s]) out[s].push(t);
  }
  return out;
}

/**
 * 算缺口。返回 [{ sprint, missing, catchup, range, target }]：
 *   已过去与当前 sprint（结束日不早于 CATCHUP_FROM）按累计算：应交 = 配额 x sprint 数，
 *     实有 = 这些 sprint 里的活博客任务；后面多写的抵前面空的（Ben's AU S1 空 S2 两篇 = 交够）。
 *     欠数从最早的空 sprint 记起，全部补在当前 sprint；
 *   未来 sprint 逐个算，缺多少补多少，任务落在该 sprint；
 *   CATCHUP_FROM 之前结束的 sprint 不追溯。
 */
function gaps(context, today) {
  const quota = quotaOf(context);
  if (!quota) return [];
  const plan = context && context.active_plan;
  const anchor = plan && plan.created_at ? String(plan.created_at).slice(0, 10) : '';
  if (!anchor) return [];
  const cur = currentSprint(anchor, today);
  const by = countBySprint(context.tasks || []);
  const out = [];
  let required = 0;
  let have = 0;
  const empties = [];
  for (let n = 1; n <= cur; n++) {
    const range = sprintRange(anchor, n);
    if (range.end < CATCHUP_FROM) continue;
    const s = 'S' + n;
    required += quota;
    have += by[s].length;
    for (let k = by[s].length; k < quota; k++) empties.push({ sprint: s, range, isCur: n === cur });
  }
  let deficit = required - have;
  for (const e of empties) {
    if (deficit <= 0) break;
    out.push({ sprint: e.sprint, missing: 1, catchup: !e.isCur, range: e.range, target: 'S' + cur });
    deficit--;
  }
  for (let n = cur + 1; n <= 6; n++) {
    const s = 'S' + n;
    const missing = quota - by[s].length;
    if (missing > 0) out.push({ sprint: s, missing, catchup: false, range: sprintRange(anchor, n), target: s });
  }
  return out;
}

/** 占位任务。选题由 execute 在锁定词表内定，detail 带配额标记，判定保护认这个标记也认 isBlogTask。 */
function placeholderTask(gap, idx, platformHasBlogOps) {
  const label = gap.catchup ? '补交 ' + gap.sprint + ' 配额博客' : gap.sprint + ' 配额博客';
  return {
    module: 'content',
    title: label + (gap.missing > 1 ? '（' + (idx + 1) + '/' + gap.missing + '）' : '') + '：选题在锁定词表内自定',
    detail: '[配额博客 ' + gap.sprint + '] 合同节奏一个 sprint 一篇博客（fact ' + FACT_KEY + '，2026-09-23 Alvin 定）。' +
      (gap.catchup ? gap.sprint + '（' + gap.range.start + ' 至 ' + gap.range.end + '）没有博客，本任务补交，排在 ' + gap.target + '。' : '') +
      '选题在锁定词表内自定，先比对线上站点地图查重，避开已发布与在途选题；按客户 facts 里的博客规范写稿，出草稿后走博客确认卡。' +
      '本任务不许判不做或延后，选题不合适就换题。',
    owner_type: 'agent',
    sprint: gap.target,
    priority: gap.catchup ? 'P1' : 'P2',
    ops: platformHasBlogOps ? 'blog-draft' : '',
    attention: 0,
  };
}

/**
 * 判定保护。verdicts 是 cleanVerdicts 的输出，tasks 是本批任务全文。只在客户开了节奏开关时生效。
 * 写稿阶段的博客任务判 drop/later/merge 一律改判 do，原判与理由写进 reason，adjust 写换题要求。
 * 同一 sprint 超出配额的博客不保护（多出来的那篇可以正常判掉）。
 */
function protectVerdicts(verdicts, context, log) {
  const say = log || function () {};
  const quota = quotaOf(context);
  if (!quota) return verdicts;
  const all = (context && context.tasks) || [];
  const byId = new Map(all.map((t) => [Number(t.id), t]));
  const by = countBySprint(all);
  return verdicts.map((v) => {
    if (['drop', 'later', 'merge'].indexOf(v.verdict) === -1) return v;
    const t = byId.get(Number(v.task_id));
    if (!t || !isBlogTask(t) || !isWritingStage(t)) return v;
    const s = String(t.sprint || '').toUpperCase();
    const inSprint = (by[s] || []).map((x) => Number(x.id)).sort((a, b) => a - b);
    const tagged = /\[配额博客/.test(String(t.detail || ''));
    const withinQuota = inSprint.indexOf(Number(t.id)) !== -1 && inSprint.indexOf(Number(t.id)) < quota;
    if (!tagged && !withinQuota) return v;
    say('判定：任务 #' + t.id + ' 是 ' + s + ' 配额博客，原判 ' + v.verdict + ' 改判 do（一个 sprint 一篇，不许判不做或延后）');
    return Object.assign({}, v, {
      verdict: 'do',
      merge_into: 0,
      reason: '[配额保护] 原判 ' + v.verdict + '：' + String(v.reason || '').slice(0, 300),
      evidence: v.evidence || 'fact ' + FACT_KEY,
      adjust: (v.adjust ? v.adjust + '；' : '') + '配额博客不空交：原选题撞车、无承接页或收益不足时，在锁定词表内换题，换题理由写进方案',
    });
  });
}

module.exports = {
  FACT_KEY,
  CATCHUP_FROM,
  quotaOf,
  isBlogTask,
  isDead,
  isWritingStage,
  countBySprint,
  currentSprint,
  sprintRange,
  gaps,
  placeholderTask,
  protectVerdicts,
  sprintNum,
};
