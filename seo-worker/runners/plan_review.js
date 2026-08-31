'use strict';
// plan_review runner: 方案层过闸（W7，2026-08-29 Alvin 定）。
//
// plan job 出的是「按这个客户的数据能做什么」；这一道加的是「按我们所有客户的经验该怎么做」。
// 一次 fable，输入草稿全文、任务清单、客户铁律（CLAUDE.md + feedback 记忆）、跨客户方案经验
// （specs/plan_experience.md）、任务判定原则、全局交付规则的摘要、本客户历史方案的处置记录。
// 输出：v2 方案正文 + 重排后的任务 + 每处改动的理由 + 一张方向确认卡。
//
// 三条不变量：
//   1. 只出 v2 和卡，不批准。批准（/plans/{id}/approve）永远是人点的。
//   2. 不改 facts，不新造数字。v2 里的数字只能来自草稿和简报。
//   3. 一次过，不循环。改完就交，人不满意走 reject 或直接改任务。

const fs = require('node:fs');
const path = require('node:path');

const { runClaude } = require('../lib/llm');
const { extractTrailingJson } = require('../lib/mdjson');
const { buildPlanningBriefing } = require('../lib/distill');
const capabilities = require('../lib/capabilities');
const { ensureClientWorkspace, truncate, summarize } = require('../lib/util');
const planRunner = require('./plan');
const { clientRulesBlock } = require('./execute_task');

const ALLOWED_TOOLS = 'Read';
const EXPERIENCE_FILE = path.join(__dirname, '..', 'specs', 'plan_experience.md');
const PRINCIPLES_FILE = path.join(__dirname, '..', 'specs', 'review_principles.md');
const MAX_PLAN_CHARS = 14000;
const MAX_GLOBAL_RULES = 60;
const MAX_HISTORY = 30;
const CHANGE_TYPES = ['keep', 'reword', 'split', 'merge', 'drop', 'add', 'move'];

/* 原则与经验文件是判断的地基，读不到必须炸，不许带着占位符判（2026-08-31 指针硬化）。 */
function readStrict(file, label) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error(label + ' 读不到（' + file + '），不判：' + e.message); }
  if (text.trim().length < 200) throw new Error(label + ' 内容异常（只有 ' + text.trim().length + ' 字），不判');
  return text;
}
function readOr(file, fallback) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return fallback; }
}

/** _global/feedback_*.md 只取 frontmatter 的 description 一行，60 条封顶。 */
function globalRulesDigest(cfg) {
  const dir = path.join(String((cfg && cfg.memoryDir) || ''), '_global');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^feedback_.*\.md$/.test(f)).sort(); } catch (e) { return ''; }
  const lines = [];
  for (const f of files) {
    const raw = readOr(path.join(dir, f), '');
    const m = raw.match(/^description:\s*"?([^"\n]+)"?/m);
    if (m) lines.push('- ' + truncate(m[1].trim(), 160));
    if (lines.length >= MAX_GLOBAL_RULES) break;
  }
  return lines.join('\n');
}

/** 本客户历史方案的处置记录：被 drop / merge / 人推翻的任务，告诉模型这家以前哪些路走不通。 */
function historyBlock(tasks, currentPlanId) {
  const rows = [];
  for (const t of tasks || []) {
    if (Number(t.plan_id) === Number(currentPlanId)) continue;
    const note = String(t.result_note || '');
    const closed = (note.match(/\[(dropped|merged|killed)\][^\n]*/) || [])[0] || '';
    const override = t.review_override ? '人推翻为 ' + t.review_override + '：' + String(t.review_override_note || '') : '';
    // 已落地的也要给：模型不知道某页 5 天前刚整页重写，就会按旧数据再排一次重写（2026-08-29 Ben's AU #61 vs #133）。
    const applied = String(t.status) === 'done' && !closed ? (note.match(/\[applied\][^\n]*/) || [])[0] || '' : '';
    if (!closed && !override && !applied) continue;
    rows.push('- #' + t.id + ' ' + truncate(String(t.title || ''), 60) + ' | ' + (applied ? '已落地 ' + truncate(applied, 160) : truncate(closed || override, 160)));
    if (rows.length >= MAX_HISTORY) break;
  }
  return rows.join('\n');
}

/** 现役方案还没做完的任务：v2 要么吸收（from 写它的 id），要么明说不要。批准 v2 时这些会被按 merged 收掉。 */
function activeOpenBlock(tasks, activePlanId, currentPlanId) {
  if (!activePlanId || Number(activePlanId) === Number(currentPlanId)) return '';
  const rows = (tasks || []).filter((t) => Number(t.plan_id) === Number(activePlanId) && !['done'].includes(String(t.status)));
  return rows.map(taskLine).join('\n');
}

function taskLine(t) {
  return '- #' + t.id + ' [' + (t.sprint || '?') + '][' + (t.priority || 'P2') + '][' + (t.module || '?') + '][' + (t.owner_type || '?') + ']' +
    (t.ops ? '[ops ' + t.ops + ']' : '') + ' ' + t.title + '\n  ' + truncate(String(t.detail || '').replace(/\s+/g, ' '), 600);
}

function buildPrompt(o) {
  const ops = ((o.capability && o.capability.operations) || []).map((x) => x.name + '(' + x.autonomy + ')').join('、');
  return [
    '你是 HornTech 的 SEO 总监，正在审一份刚由规划模型写出的 90 天方案草稿（v1）。',
    '规划模型只看了这一个客户的数据；你手里多的是我们做过所有客户的经验。你的活是把 v1 改成 v2：',
    '方向对不对、顺序对不对、任务粒度对不对、有没有碰客户铁律、有没有我们踩过的坑。',
    '改完给人一张「方向确认卡」，人只看卡决定是否确认方向，不逐条看任务。所以卡要短、要把改动说清、要把你拿不准的摊开。',
    '',
    '硬规矩：',
    '- 不新造数字。v2 里每个数字都必须在 v1 或简报里找得到。',
    '- 不改事实。CONFIRMED 的事实照用，不派任务核实。',
    '- 不为了显得有改动而改。v1 对的地方 keep，改动必须有理由，理由要能追溯到下面的经验、铁律或简报。',
    '- 一任务一件事：博客一任务一篇；一组页面一个任务；只读审计不立任务。',
    '- S1 只放我方能独立落地、且直接推动本季度第一批转化的事。',
    '- 任务字段沿用 v1 的契约：module ' + planRunner.MODULES.join('/') + '，sprint ' + planRunner.SPRINTS.join('/') +
      '，priority P0 到 P3，owner_type agency/client/agent，ops 只能用能力清单里的名字' + (ops ? '（' + ops + '）' : '（这个客户没有清单，改站任务一律 agency，ops 留空）') + '。最多 ' + planRunner.MAX_TASKS + ' 条。',
    '- 任务 detail 里凡是文案类的，要引用客户铁律里相关的一条（写「铁律：」加原句要点）。',
    '',
    '===== 客户：' + o.clientName,
    '',
    '===== 跨客户方案经验（specs/plan_experience.md）',
    o.experience,
    '',
    '===== 任务判定原则（任务层闸门会按这个逐条判，你在方案层先把明显过不了的清掉）',
    truncate(o.principles, 6000),
    '',
    '===== 客户铁律与规则（CLAUDE.md 与该客户 feedback 记忆；为空说明这家还没有，v2 的文案类任务要标「待补铁律」）',
    o.clientRules || '（无）',
    '',
    '===== 全局交付规则摘要（所有客户通用）',
    o.globalRules || '（无）',
    '',
    '===== 本客户历史任务的处置记录（已落地的带日期，别对刚改过的页再排重写；被砍、被并、被人推翻的说明这家哪些路走不通）',
    o.history || '（无，首次导入）',
    '',
    '===== 现役方案还没做完的任务（批准 v2 时这些会被收掉，所以 v2 必须决定：吸收它就把它的任务号写进 from，不要它就在 changes 里 drop 并说明）',
    o.activeOpen || '（无现役方案或已全部完成）',
    '',
    '===== 简报（事实与数据）',
    o.briefing,
    '',
    '===== v1 方案正文',
    truncate(o.planBody, MAX_PLAN_CHARS),
    '',
    '===== v1 任务清单（' + o.tasks.length + ' 条）',
    o.tasks.map(taskLine).join('\n'),
    '',
    '===== 输出',
    '先用中文写 v2 方案正文（markdown，结构沿用 v1 的章节，改动处不用标记，正文就是最终版），',
    '然后以一个 json 代码块结尾，块后不许再有任何文字：',
    '```json',
    '{"tasks":[{"module":"onpage","title":"...","detail":"...","owner_type":"agent","sprint":"S1","priority":"P0","ops":["page-meta-update"],"attention":false,"from":[97]}],',
    ' "changes":[{"type":"split","from":[110],"why":"一任务一篇"}],',
    ' "card":{"goal":"一句话：本季度靠什么出第一批询盘","s1":["S1 第一件事","第二件","第三件"],"changed":["v1 到 v2 改了什么，每条一句，最多 6 条"],"unsure":["我拿不准的，最多 3 条，没有写空数组"],"ask":"要人做的唯一一个动作，通常是：确认方向，批准 v2"}}',
    '```',
    '字段规矩：',
    '- tasks：v2 的完整任务清单（不是增量）。from 写它来自 v1 的哪些任务号，新增写 []。',
    '- changes：type 取 ' + CHANGE_TYPES.join('/') + '，keep 不用列。why 一句话。',
    '- card 里全部中文，每条一句，不用 emoji，不用破折号。json 字符串里不许有英文双引号和换行。',
  ].join('\n');
}

/** 归一化模型输出。任务用 plan.js 同一套校验；卡缺字段补空。 */
function cleanOutput(json, capability, log) {
  const out = { tasks: [], changes: [], card: null, dropped: [] };
  if (!json || typeof json !== 'object') return out;
  const v = planRunner.validateTasks(Array.isArray(json.tasks) ? json.tasks : [], log, capability);
  out.tasks = v.tasks.map((t, i) => {
    const src = (json.tasks || [])[i] || {};
    return Object.assign({}, t, { from: Array.isArray(src.from) ? src.from.map((x) => Number(x) || 0).filter(Boolean) : [] });
  });
  out.dropped = v.dropped;
  out.changes = (Array.isArray(json.changes) ? json.changes : [])
    .filter((c) => c && CHANGE_TYPES.includes(String(c.type)))
    .map((c) => ({ type: String(c.type), from: Array.isArray(c.from) ? c.from.map((x) => Number(x) || 0).filter(Boolean) : [], why: summarize(String(c.why || ''), 200) }))
    .slice(0, 40);
  const c = json.card && typeof json.card === 'object' ? json.card : {};
  const arr = (x, n) => (Array.isArray(x) ? x : []).map((s) => summarize(String(s || ''), 200)).filter(Boolean).slice(0, n);
  out.card = {
    goal: summarize(String(c.goal || ''), 200),
    s1: arr(c.s1, 3),
    changed: arr(c.changed, 6),
    unsure: arr(c.unsure, 3),
    ask: summarize(String(c.ask || '确认方向，批准新版方案').replace(/\bv2\b/g, '新版方案'), 120),
  };
  return out;
}

function renderCard(card, o) {
  const lines = [
    '方案 v' + o.version + ' 方向确认 · ' + o.clientName,
    '',
    '目标：' + (card.goal || '（模型没写）'),
    '',
    'S1 三件事：',
    ...(card.s1.length ? card.s1.map((s, i) => (i + 1) + '. ' + s) : ['（空）']),
    '',
    'v1 到 v2 改了什么：',
    ...(card.changed.length ? card.changed.map((s) => '- ' + s) : ['- 没有实质改动']),
    '',
    '拿不准的：',
    ...(card.unsure.length ? card.unsure.map((s) => '- ' + s) : ['- 无']),
    '',
    '要你做的：' + card.ask + '。批准在方案区点 v' + o.version + '；不认可就 reject 并写一句原因，原因会进跨客户经验。',
    '',
    '任务 ' + o.taskCount + ' 条（v1 ' + o.v1Count + ' 条），改动 ' + o.changeCount + ' 处。',
  ];
  return lines.join('\n');
}

async function judgeWithModel(ctx, opts) {
  const { cfg, log } = ctx;
  const prompt = buildPrompt(opts);
  log('方案层过闸 prompt ' + prompt.length + ' 字符，模型 ' + cfg.planReviewModel);
  const res = await runClaude(cfg, { prompt, cwd: opts.workspace, log, model: cfg.planReviewModel, allowedTools: ALLOWED_TOOLS, label: opts.label });
  let output = String(res.stdout || '').trim();
  if (!output) return { ok: false, error: 'claude 没有任何输出' };
  let parsed = extractTrailingJson(output);
  if (parsed.error || !parsed.json || typeof parsed.json !== 'object') {
    log('方案层过闸：json 解析失败（' + (parsed.error || 'json 块不是对象') + '），发起一次纠错重试');
    const fixRes = await runClaude(cfg, {
      prompt: '你上一轮的输出如下，结尾的 json 代码块无法解析，解析器报错：' + (parsed.error || 'json 块不是对象') +
        '。常见原因是字符串值里有未转义的英文双引号或换行。重新输出：先原样给出 v2 正文，再给修正后的 json 代码块，块外不要有别的字。\n\n=====\n' + output.slice(-12000),
      cwd: opts.workspace, log, model: cfg.planReviewModel, allowedTools: ALLOWED_TOOLS, label: opts.label + ' fix',
    });
    output = String(fixRes.stdout || '').trim();
    parsed = extractTrailingJson(output);
  }
  if (parsed.error || !parsed.json || typeof parsed.json !== 'object') return { ok: false, error: parsed.error || 'json 块不是对象' };
  return { ok: true, json: parsed.json, body: String(parsed.body || '').trim() };
}

/** 状态机，模型可注入，测试干跑。 */
async function runWith(ctx, judge) {
  const { job, api, cfg, log } = ctx;
  const payload = job.payload || {};
  const planId = Number(payload.plan_id) || 0;
  if (!planId) throw new Error('plan_review job has no payload.plan_id');

  const got = await api.getPlan(planId);
  const plan = got && got.plan;
  if (!plan) throw new Error('plan #' + planId + ' not found');
  if (String(plan.status) !== 'draft') throw new Error('plan #' + planId + ' is ' + plan.status + ', only a draft can be reviewed');
  const v1Tasks = Array.isArray(got.tasks) ? got.tasks : [];

  const context = await api.getContext(job.client_id);
  const profile = (context && context.profile) || null;
  if (!profile) throw new Error('context returned no profile for client_id ' + job.client_id);
  const workspace = ensureClientWorkspace(profile, cfg);
  const platform = profile.platform || profile.cms || '';
  const capability = { platform, operations: platform ? capabilities.operations(platform) : [] };
  const briefing = buildPlanningBriefing(context, { log });

  const judged = await judge({
    clientName: profile.name || (context.client && context.client.name) || profile.domain || '',
    experience: readStrict(EXPERIENCE_FILE, '方案经验文件'),
    principles: readStrict(PRINCIPLES_FILE, '判定原则文件'),
    clientRules: clientRulesBlock(cfg, workspace, log),
    globalRules: globalRulesDigest(cfg),
    history: historyBlock(context.tasks || [], planId),
    activeOpen: activeOpenBlock(context.tasks || [], context.active_plan && context.active_plan.id, planId),
    briefing: briefing.text,
    planBody: String(plan.body || ''),
    tasks: v1Tasks,
    capability,
    workspace,
    label: 'plan review job ' + job.id,
  });
  if (!judged || !judged.ok) throw new Error('方案层过闸输出无法解析 :: ' + ((judged && judged.error) || '未知原因'));

  const cleaned = cleanOutput(judged.json, capability, log);
  if (!cleaned.tasks.length) throw new Error('v2 没有任何合法任务，不落库（' + cleaned.dropped.join('；') + '）');
  if (!judged.body || judged.body.length < 200) throw new Error('v2 正文太短（' + (judged.body || '').length + ' 字），不落库');
  const version = Number(plan.version || 1) + 1;
  const header = '<!-- plan v' + version + ' by plan_review from v' + plan.version + ' (plan #' + planId + '), ' + new Date().toISOString().slice(0, 10) + ' -->';
  const card = renderCard(cleaned.card, { version, clientName: profile.name || '', taskCount: cleaned.tasks.length, v1Count: v1Tasks.length, changeCount: cleaned.changes.length });
  log('v2：任务 ' + cleaned.tasks.length + ' 条（v1 ' + v1Tasks.length + '），改动 ' + cleaned.changes.length + ' 处' + (cleaned.dropped.length ? '，校验丢弃 ' + cleaned.dropped.length + ' 条：' + cleaned.dropped.join('；') : ''));
  for (const c of cleaned.changes) log('  ' + c.type + ' ' + (c.from.length ? '#' + c.from.join(' #') : '(new)') + '：' + c.why);

  const res = await api.postPlanReviewResult(planId, {
    body: header + '\n\n' + judged.body,
    tasks: cleaned.tasks.map((t) => ({ module: t.module, title: t.title, detail: t.detail, owner_type: t.owner_type, sprint: t.sprint, priority: t.priority, ops: Array.isArray(t.ops) ? t.ops.join(',') : String(t.ops || ''), attention: !!t.attention })),
    changes: cleaned.changes,
    card,
  });
  log('v2 已落库：plan #' + (res && res.plan_id) + ' v' + (res && res.version) + '，任务 ' + ((res && res.ids) || []).join(' ') + '，v1 收掉 ' + ((res && res.closed) || []).length + ' 条，确认卡 #' + (res && res.card_id) + '，任务层判定 job ' + (res && res.review_job_id));
  log('CARD\n' + card);
  return { tokenUsage: 0 };
}

async function run(ctx) {
  return runWith(ctx, (opts) => judgeWithModel(ctx, opts));
}

module.exports = { run, runWith, judgeWithModel, buildPrompt, cleanOutput, renderCard, globalRulesDigest, historyBlock, activeOpenBlock, EXPERIENCE_FILE, CHANGE_TYPES };
