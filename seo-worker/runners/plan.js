'use strict';
// plan runner: the 90 day planning pass.
//
// Shape of the run, and the order matters:
//   1. refresh every data source through the pull_data logic, cache aware, so a
//      plan is structurally guaranteed to sit on current data
//   2. distil the snapshots into a briefing in plain node, no LLM, no raw
//      snapshot ever reaches the prompt
//   3. one LLM pass with Read only tools, planning does not touch anything
//   4. persist the prose as a draft plan and the task list as proposed tasks
//
// Degradation rule: the plan itself is the valuable artifact. A missing or
// malformed task block never fails the job, it just leaves the board to be
// filled in by hand.

const { generateDraft, logDocument } = require('../lib/draft');
const {
  buildPlanningBriefing,
  LIMIT_STEPS,
  MAX_BYTES,
  DOSSIER_STALE_DAYS,
} = require('../lib/distill');
const { extractTrailingJson } = require('../lib/mdjson');
const capabilities = require('../lib/capabilities');
const { refreshSources } = require('./pull_data');
const { truncate, safeJson } = require('../lib/util');

const MODULES = ['technical', 'onpage', 'content', 'local', 'offpage', 'paid'];
const OWNER_TYPES = ['agency', 'client', 'agent'];
const SPRINTS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const DEFAULT_PRIORITY = 'P2';
const MAX_TASKS = 12;
const AUTHORED_BY = 'seo-worker';

/* 客户背景一律来自 profile 与 facts 简报，不在这里写死。
   2026-08-25 删除了试点客户 powerdekor 的硬编码 CLIENT_BACKGROUND（新西兰地板站、
   jacktoto 注入、78,000 垃圾外链），此前它被无条件塞进每个客户的 plan 提示词，
   benscurtains 两次 plan 都被串进该背景（见 COLLAB 2026-08-24 AIRA (b) bug 1）。 */

/**
 * Pull the last ```json fenced block out of the model output.
 * Returns { body, tasks, error }. body is everything before the block, which is
 * what gets stored as the plan.
 */
function extractJsonBlock(text) {
  const parsed = extractTrailingJson(text);
  if (parsed.error) return { body: parsed.body, tasks: null, error: parsed.error };
  const tasks = Array.isArray(parsed.json) ? parsed.json : parsed.json && parsed.json.tasks;
  if (!Array.isArray(tasks)) {
    return { body: parsed.body, tasks: null, error: 'json block has no tasks array' };
  }
  return { body: parsed.body, tasks, error: null };
}

/**
 * Drop anything the bulk endpoint would reject, since one bad row 400s the
 * whole batch. Returns { tasks, dropped }.
 */
function validateTasks(rawTasks, log, capability) {
  const dropped = [];
  const tasks = [];
  const known = ((capability && capability.operations) || []).reduce((acc, o) => {
    acc[o.name] = o.autonomy;
    return acc;
  }, {});
  for (let i = 0; i < rawTasks.length; i += 1) {
    const t = rawTasks[i] || {};
    const title = String(t.title || '').trim();
    const module = String(t.module || '').trim().toLowerCase();
    const ownerType = String(t.owner_type || '').trim().toLowerCase();
    const sprint = String(t.sprint || '').trim().toUpperCase();
    const priority = String(t.priority || '').trim().toUpperCase();
    const reasons = [];
    if (!title) reasons.push('empty title');
    if (!MODULES.includes(module)) reasons.push('module "' + t.module + '" not allowed');
    if (!OWNER_TYPES.includes(ownerType)) reasons.push('owner_type "' + t.owner_type + '" not allowed');
    if (!SPRINTS.includes(sprint)) reasons.push('sprint "' + t.sprint + '" not allowed');
    if (reasons.length) {
      dropped.push('task ' + (i + 1) + ' "' + truncate(title || '(untitled)', 60) + '": ' + reasons.join(', '));
      continue;
    }
    // priority is optional on the endpoint, so a bad value is corrected rather
    // than used as a reason to drop otherwise good work.
    let finalPriority = priority;
    if (!PRIORITIES.includes(finalPriority)) {
      if (priority && log) {
        log('task "' + truncate(title, 60) + '": priority "' + t.priority + '" not allowed, using ' + DEFAULT_PRIORITY);
      }
      finalPriority = DEFAULT_PRIORITY;
    }
    // ops: an unknown operation name is dropped, the task survives. A task is
    // still worth doing when the model got one label wrong, and a human reading
    // the board can see from the log what was stripped.
    const rawOps = Array.isArray(t.ops)
      ? t.ops
      : typeof t.ops === 'string'
        ? t.ops.split(',')
        : [];
    const ops = [];
    for (const rawOp of rawOps) {
      const op = String(rawOp || '').trim().toLowerCase();
      if (!op) continue;
      if (!known[op]) {
        log('task "' + truncate(title, 60) + '": op "' + op + '" is not in the platform manifest, dropped');
        continue;
      }
      if (known[op] === 'human_only') {
        log('task "' + truncate(title, 60) + '": op "' + op + '" is human_only, dropped from ops');
        continue;
      }
      if (ops.indexOf(op) === -1) ops.push(op);
    }
    if (ops.length && ownerType !== 'agent') {
      log('task "' + truncate(title, 60) + '": has ops but owner_type is ' + ownerType + ', left as is for a human to settle');
    }

    // attention is 0/1 on the server, so it is sent as an integer, not a bool.
    const attention =
      t.attention === true || t.attention === 1 || t.attention === '1' || t.attention === 'true'
        ? 1
        : 0;

    tasks.push({
      module,
      title: truncate(title, 200),
      detail: truncate(String(t.detail || '').trim(), 2000),
      owner_type: ownerType,
      sprint,
      priority: finalPriority,
      ops: ops.join(','),
      attention,
    });
  }
  if (dropped.length && log) {
    for (const d of dropped) log('task validation dropped ' + d);
  }
  return { tasks: tasks.slice(0, MAX_TASKS), dropped, overflow: Math.max(0, tasks.length - MAX_TASKS) };
}

/**
 * The planning prompt.
 *
 * Output language is Chinese: the plan, the decision log and the task titles are
 * read by the team, not by the client. The machine anchors stay fixed literals
 * so review and parsing do not drift, and the json keys stay English.
 * Client facing deliverables are a different matter and are written in the
 * site's language by the execute stage.
 */
function buildPrompt(briefing, extraInstructions, dossier, capability) {
  const hasDossier = !!(dossier && dossier.present);
  const ops = (capability && capability.operations) || [];
  const applyOps = ops.filter((o) => o.autonomy === 'agent_apply').map((o) => o.name);
  const prepareOps = ops.filter((o) => o.autonomy === 'agent_prepare').map((o) => o.name);
  return [
    '你是一家新西兰数字营销公司的 SEO 策略负责人，为下面这个客户写 90 天方案。',
    '这份方案会交给人审批，通过的任务会变成真实工作。你在无人值守模式下运行，只有只读工具，',
    '没人能回答你的问题。自己做判断，讲清理由，一次写完。',
    '',
    'BRIEFING, this is distilled from the live data, treat it as the only facts you have',
    '-----',
    briefing,
    '-----',
    '',
    hasDossier
      ? [
          '关于摸底报告（DISCOVERY DOSSIER）',
          '上面那份 dossier 是这个客户的结构性摸底，日期 ' +
            (dossier.date || '未知') +
            '，依据 discover spec ' +
            (dossier.specVersion || '未知') +
            '。',
          '它的每条结论都带置信度标注。你引用时必须把标注一起带上，例如：本季外链不是瓶颈',
          '[推断，dossier]。严禁把标注往上升级。dossier 里标 [未知] 的东西就是数据缺口，',
          '不能当成事实来规划，要写进下面的数据缺口段。',
          dossier.stale
            ? '这份 dossier 已经 ' +
              dossier.ageDays +
              ' 天，超过 ' +
              DOSSIER_STALE_DAYS +
              ' 天线。它的竞争类结论要打折看待，并在数据缺口里写明。'
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : [
          '没有摸底报告',
          '这个客户还没做过结构性摸底，竞争格局、权威度差距、本地格局都是未测量状态。',
          '按现有表现数据能支撑的范围规划，把缺失的摸底写进数据缺口段。',
        ].join('\n'),
    '',
    extraInstructions ? '客户负责人的额外要求\n' + extraInstructions + '\n' : '',
    '输出契约：五个部分，顺序照抄，前后不要有别的东西。',
    '标题是机器解析和人工 grep 的锚点，必须一字不差地复制。',
    '',
    '## 1. 数据解读',
    '数据实际说明了什么。要具体，数字直接引简报里的。',
    '数据薄或者缺的地方直接说，不要用猜测补。某个数据源没有快照，就说清楚它缺了会影响什么判断。',
    '',
    '## 2. 决策清单',
    '两个清单，这是客户负责人第一个看的部分。',
    '做：本季值得做的事。每条结尾用"因为……"接一个简报里的依据。',
    '不做：至少三条。常规 SEO 方案会写、但你这个阶段故意不做的事，每条结尾同样用"因为……"',
    '说清取舍。把不值得做的事和理由讲明白，是这一段存在的全部意义。',
    '',
    '## 3. 90 天方案',
    'Markdown，按六个双周 sprint 组织，标号 S1 到 S6。每个 sprint 写清目标、交付物、以及',
    '用什么指标判断它做成了。能解锁后续工作的排前面。S1 必须是明天就能动手、不需要再摸底的活。',
    '',
    '## 数据缺口',
    '标题就是这四个字加二级标题，不许改写、不许翻译、不许加编号。全部方案的复盘会 grep 这一段。',
    '事实台账里 CONFIRMED 的内容严禁出现在这里，也严禁变成让客户或 agent 去核实的任务。',
    '把已经定论的问题再问一遍，是一份方案能犯的最惹人烦的错。',
    '用编号列表写你没拿到的决策输入。每条写：缺什么、它削弱了本方案里的哪个决策、什么能补上它。',
    'dossier 里标 [未知] 而你又需要的、快照缺失害你判断不了的、你为了写完不得不做的假设，都写进来。',
    '这一段是空的，基本说明你没认真找。',
    '',
    '## 任务块',
    '最后给一个 json 代码块，后面不要再有任何内容：',
    '```json',
    '{"tasks":[{"module":"technical","title":"...","detail":"...","owner_type":"agent","sprint":"S1","priority":"P0","ops":["redirect-batch"],"attention":false}]}',
    '```',
    'json 的键名保持英文，值里的 title 和 detail 用中文。规则：',
    '- 最多 ' + MAX_TASKS + ' 条，挑真正重要的',
    '- module 取值：' + MODULES.join('、'),
    '- sprint 取值：' + SPRINTS.join('、'),
    '- priority 取值：' + PRIORITIES.join('、') +
      '。P0 是必须在它自己那个 sprint 里落地，落不了这个 sprint 就算失败；P1 高价值但可以顺延；' +
      'P2 正常；P3 有余力再说。P0 要吝啬，满屏 P0 等于没有优先级',
    '',
    '关于 owner_type 和 ops，这条决定活派给谁：',
    ops.length
      ? [
          '- 平台能力清单已经在简报里。凡是能由清单里的操作组合完成的任务，owner_type 必须写',
          '  agent，并在 ops 数组里列出用到的操作名。',
          '- 可用操作名：' + ops.map((o) => o.name + '(' + o.autonomy + ')').join('、'),
          applyOps.length ? '- agent_apply 类（agent 可直接执行）：' + applyOps.join('、') : '',
          prepareOps.length
            ? '- agent_prepare 类（agent 只出方案，人放行后才执行）：' + prepareOps.join('、')
            : '',
          '- 只要任务里包含 agent_prepare 类操作，detail 必须写明：本任务的产出物是一份待放行的',
          '  变更方案，不是变更本身。',
          '- human_only 类操作不许进 ops，那种活写成 agency 任务，detail 里说清要人做什么。',
          '- 清单里没有的站点操作，owner_type 写 agency。不要为了让 agent 接活去编操作名。',
          '- 纯分析、纯调研、纯写稿这类不碰站点的任务，owner_type 可以写 agent，ops 留空数组。',
        ]
          .filter(Boolean)
          .join('\n')
      : [
          '- 这个客户没有平台能力清单，任何会改动站点的任务一律 owner_type 写 agency，ops 留空。',
          '- 不碰站点的纯分析或写稿任务可以写 agent，ops 留空数组。',
        ].join('\n'),
    '- owner_type 取值：' + OWNER_TYPES.join('、') + '。client 只用于只有客户本人能做的事。',
    '',
    '关于 attention 标记：',
    '- 需要人做重大判断的任务标 attention:true，例如涉及品牌取舍、预算投入、法律或合规风险、',
    '  会影响客户对外承诺的内容。',
    '- 标了 true 就要在 detail 里写清楚为什么需要人判断，判断点是什么。',
    '- 其余任务标 false。这个标记是给人筛工作的，滥标等于没标。',
    '',
    '其余任务字段规则：',
    '- detail 写一到三句，让人不用回来问你就能开工。S1 的任务要点名具体页面、关键词或文件。',
    '- 每条任务都要能追溯到"做"清单里的某一条。',
    '',
    '事实台账，这条是硬规则',
    'CONFIRMED 的事实是已经关闭的问题。不许写进数据缺口，不许派任务去核实，不许再问客户，',
    '直接在它上面规划。PENDING 的事实可以用，但每次依赖它都要写"待确认"，并且不许只靠一条',
    'PENDING 事实就立 P0 任务。',
    '',
    '文风',
    '中文输出。不用 emoji。不用破折号，用逗号、句号或分号代替。',
    '不写废话，不复述简报。不许编造简报里没有的数字。',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

/**
 * One line of provenance at the top of every stored plan. Cheap now,
 * impossible to reconstruct later, and it is what makes a spec change
 * traceable to the plans it produced.
 */
function provenanceHeader(dossier) {
  const spec = (dossier && dossier.specVersion) || 'v1';
  const date = (dossier && dossier.date) || 'none';
  return '<!-- plan generated with discover spec ' + spec + ', dossier date ' + date + ' -->';
}

/** Store the prose plan, then the tasks. Task failures never fail the job. */
async function persist(ctx, text, dossier, capability) {
  const { job, api, log } = ctx;
  const parsed = extractJsonBlock(text);
  if (parsed.error) log('task block: ' + parsed.error);

  const prose = parsed.body || String(text || '').trim();
  if (!prose) throw new Error('model output had no plan body to store');
  const body = provenanceHeader(dossier) + '\n\n' + prose;

  let plan;
  try {
    plan = await api.postPlan({
      client_id: job.client_id,
      body,
      authored_by: AUTHORED_BY,
    });
  } catch (e) {
    // Nothing was persisted, so dump the whole plan into the job log before
    // failing. The work is expensive, it does not get thrown away.
    logDocument(log, 'PLAN TEXT, NOT STORED', body);
    throw new Error('POST /plans failed :: ' + e.message);
  }
  const planId = plan && (plan.id !== undefined ? plan.id : plan.plan_id);
  log('plan stored as draft, id ' + planId + ', version ' + (plan && plan.version));

  if (!parsed.tasks) {
    log('no task list to store, add tasks by hand in the board. The plan is still stored');
    return { planId, taskIds: [] };
  }

  const { tasks, dropped, overflow } = validateTasks(parsed.tasks, log, capability);
  if (overflow) log('model proposed more than ' + MAX_TASKS + ' tasks, kept the first ' + MAX_TASKS);
  if (!tasks.length) {
    log(
      'every proposed task failed validation, ' +
        dropped.length +
        ' dropped, nothing sent to /tasks/bulk. Add tasks by hand in the board'
    );
    return { planId, taskIds: [] };
  }

  try {
    const res = await api.postTasksBulk({
      client_id: job.client_id,
      plan_id: planId,
      tasks,
    });
    const ids = (res && res.ids) || [];
    log('stored ' + tasks.length + ' proposed task(s), ids ' + (ids.join(', ') || 'none returned'));
    return { planId, taskIds: ids };
  } catch (e) {
    // The batch is all or nothing on the server, so log what was proposed and
    // let a human key it in. The plan is already safe.
    log('POST /tasks/bulk failed, no tasks stored :: ' + e.message);
    logDocument(log, 'PROPOSED TASKS, NOT STORED', JSON.stringify({ tasks }, null, 1));
    return { planId, taskIds: [] };
  }
}

/**
 * The context list may carry the discovery snapshot without its body, since the
 * list endpoint omits the data blob. Fetch the full row when that happens, in
 * place, so the distiller sees the dossier text.
 */
async function hydrateDossier(ctx, context) {
  const { api, log } = ctx;
  const latest = context && context.latest_snapshots;
  if (!latest) return;
  const snap = Array.isArray(latest)
    ? latest.find((s) => s && s.source === 'discovery')
    : latest.discovery;
  if (!snap) return;
  const data = safeJson(snap.data, null);
  if (data && data.dossier_md) return;
  if (snap.id === undefined || snap.id === null) {
    log('dossier: snapshot present without a body and without an id, cannot hydrate it');
    return;
  }
  try {
    const full = await api.getSnapshot(snap.id);
    const row = (full && full.snapshot) || full;
    if (row && row.data) {
      snap.data = row.data;
      log('dossier: hydrated snapshot #' + snap.id + ' through GET /snapshots/' + snap.id);
    } else {
      log('dossier: GET /snapshots/' + snap.id + ' returned no data field');
    }
  } catch (e) {
    // Not fatal. The plan proceeds and the missing dossier becomes a data gap.
    log('dossier: could not hydrate snapshot #' + snap.id + ' :: ' + e.message);
  }
}

async function run(ctx) {
  const { job, api, log, cfg } = ctx;
  const payload = job.payload || {};
  const startedAt = Date.now();

  // 1. data freshness first, so planning always sees current numbers.
  log('step 1 of 4: refreshing data sources before planning');
  const refresh = await refreshSources(ctx, { fresh: payload.fresh === true });
  const skipped = refresh.skipped || {};
  log(
    'source state: ' +
      ['gsc', 'ga4', 'semrush']
        .map((s) => s + ' ' + (skipped[s] ? 'from cache' : 'pulled'))
        .join(', ')
  );
  if (refresh.errors && refresh.errors.length) {
    // Planning on partial data is better than no plan, the readout has to own it.
    log('data refresh had errors, planning continues on what is available :: ' + refresh.errors.join(' | '));
  }

  // 2. re read the context so the briefing includes what step 1 just stored.
  log('step 2 of 4: distilling the briefing, no LLM in this step');
  const context = await api.getContext(job.client_id);
  const profile = (context && context.profile) || null;
  if (!profile) throw new Error('context returned no profile for client_id ' + job.client_id);

  await hydrateDossier(ctx, context);
  const briefing = buildPlanningBriefing(context, { log });
  log(
    'briefing distilled: ' +
      briefing.bytes +
      ' bytes total (' +
      briefing.dataBytes +
      ' data at detail step ' +
      briefing.step +
      ' of ' +
      (LIMIT_STEPS.length - 1) +
      ' against a ' +
      MAX_BYTES +
      ' byte budget, ' +
      briefing.dossierBytes +
      ' dossier)'
  );

  const dossier = briefing.dossier || { present: false };
  if (!dossier.present) {
    log('dossier: none on record for this client, planning without a structural survey');
  } else {
    log(
      'dossier: spec ' +
        (dossier.specVersion || 'unknown') +
        ', dated ' +
        (dossier.date || 'unknown') +
        ', ' +
        (dossier.ageDays === null ? 'age unknown' : dossier.ageDays + ' days old') +
        ', ' +
        dossier.unknowns.length +
        ' recorded unknown(s)'
    );
    if (dossier.stale) {
      // A warning line only. Whether to refresh is a human call, per the design.
      log(
        'WARNING dossier is ' +
          dossier.ageDays +
          ' days old, past the ' +
          DOSSIER_STALE_DAYS +
          ' day mark. Consider queueing a discover refresh. This does not block the plan'
      );
    }
  }

  // What this platform lets an agent do. An unknown platform is not an error,
  // it just means every site changing task goes to the agency.
  const platform = profile.platform || profile.cms || null;
  const capability = { platform, operations: platform ? capabilities.operations(platform) : [] };
  if (!platform) {
    log('capabilities: profile has no platform field, site changing tasks will go to agency');
  } else if (!capability.operations.length) {
    log('capabilities: no manifest for platform "' + platform + '", site changing tasks will go to agency');
  } else {
    const byLevel = capability.operations.reduce((acc, o) => {
      acc[o.autonomy] = (acc[o.autonomy] || 0) + 1;
      return acc;
    }, {});
    log(
      'capabilities: platform ' +
        platform +
        ', ' +
        capability.operations.length +
        ' operation(s) ' +
        JSON.stringify(byLevel) +
        ', planning view ' +
        Buffer.byteLength(capabilities.planningView(platform).text, 'utf8') +
        ' bytes injected'
    );
  }

  const prompt = buildPrompt(briefing.text, payload.instructions, dossier, capability);
  log('step 3 of 4: planning pass, model ' + cfg.planModel + ', prompt ' + prompt.length + ' chars');

  let result = { planId: null, taskIds: [] };
  await generateDraft(ctx, {
    label: 'plan',
    prompt,
    filePrefix: 'plan-90d',
    profile,
    model: cfg.planModel,
    allowedTools: 'Read', // planning reads, it does not act
    logFullText: false, // the plan lives in /plans, not in the job log
    postDraft: async ({ text }) => {
      log('step 4 of 4: persisting');
      result = await persist(ctx, text, dossier, capability);
    },
  });

  log(
    'plan run finished in ' +
      Math.round((Date.now() - startedAt) / 1000) +
      's, plan id ' +
      result.planId +
      ', ' +
      result.taskIds.length +
      ' task(s) stored'
  );
  return { tokenUsage: 0 };
}

module.exports = {
  run,
  buildPrompt,
  extractJsonBlock,
  validateTasks,
  MODULES,
  OWNER_TYPES,
  SPRINTS,
  MAX_TASKS,
};
