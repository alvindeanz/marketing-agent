'use strict';
// triage runner: the house keeping pass.
//
// Reads everything on record for one client, plan, tasks, facts, snapshots, job
// history and the exception queue, and writes one page of Chinese prose saying
// where the client stands, what is stuck, and what to do next.
//
// Read only, and that is the whole point. It files no tasks, queues no jobs,
// touches no site. Every recommendation is addressed to a human, who stays the
// one who releases anything. The materials are inlined into the prompt so the
// model never has to go looking, and Read is the only tool it gets.

const { generateDraft, OUTPUT_DIRNAME } = require('../lib/draft');
const { snapshotBlock } = require('../lib/brief');
const { extractTrailingJson } = require('../lib/mdjson');
const { truncate, summarize } = require('../lib/util');

const ALLOWED_TOOLS = 'Read';

// The four buckets section three already sorts blockers into. The digest card
// reuses them so a person reading the inbox sees the same vocabulary as the
// report.
const DIGEST_KINDS = ['基础设施', '方案', '等外部依赖', '需人决策'];

// Rough prompt budget. Claude takes the prompt as a CLI argument, so a runaway
// materials block is a real failure mode, not just a cost one.
const MAX_PROMPT_CHARS = 30000;

// Shrink ladder, applied in order until the prompt fits. Job log tails go
// first because they are the most repetitive material, task detail after that,
// and the finished tasks last: section two still has to cite them, but a done
// task is the least useful thing to spend the budget on.
const BUDGET_LADDER = [
  { logTail: 500, detail: 600, note: 400, plan: 4000, doneCap: 0 },
  { logTail: 200, detail: 600, note: 400, plan: 3000, doneCap: 0 },
  { logTail: 0, detail: 600, note: 300, plan: 2000, doneCap: 0 },
  { logTail: 0, detail: 300, note: 200, plan: 1500, doneCap: 30 },
  { logTail: 0, detail: 0, note: 120, plan: 800, doneCap: 10 },
];

const STATUS_ORDER = ['blocked', 'review', 'in_progress', 'approved', 'proposed', 'done'];

function tail(text, n) {
  const s = String(text == null ? '' : text);
  if (!n || !s) return '';
  return s.length <= n ? s : '...' + s.slice(s.length - n);
}

function profileBlock(client, profile) {
  const p = profile || {};
  const rows = [
    '客户：' + ((client && client.name) || '未命名') + '（client_id ' + ((client && client.id) || '?') + '）',
    '站点：' + (p.domain || '未填'),
    '平台：' + (p.platform || '未填'),
    '档案状态：' + (p.status || '未填'),
    '报告语言：' + (p.report_lang || '未填'),
    'GA4：' + (p.ga4_property || '未接') + '，GSC：' + (p.gsc_property || '未接') + '，Semrush：' + (p.semrush_project || '未接'),
  ];
  const kw = p.target_keywords;
  rows.push('目标关键词：' + (Array.isArray(kw) ? kw.join('、') : kw || '未填'));
  if (p.business_goals) rows.push('业务目标：' + truncate(String(p.business_goals), 600));
  if (p.conversion_goals) rows.push('转化目标：' + truncate(String(p.conversion_goals), 400));
  if (p.notes) rows.push('档案备注（含数据口径与历史坑）：' + truncate(String(p.notes), 1200));
  return '一、客户档案\n' + rows.join('\n');
}

function planBlock(plan, limit) {
  if (!plan) return '二、当前生效方案\n没有生效方案。这本身可能就是一个发现。';
  const head =
    'v' + (plan.version || '?') + '，状态 ' + (plan.status || '?') +
    '，作者 ' + (plan.authored_by || '-') + '，批准人 ' + (plan.approved_by || '-') +
    '，建于 ' + (plan.created_at || '-');
  const body = limit ? truncate(String(plan.body || ''), limit) : '（正文因篇幅省略）';
  return '二、当前生效方案\n' + head + '\n-----\n' + body + '\n-----';
}

function taskEntry(t, level) {
  const detailLimit = level.detail;
  const noteLimit = level.note;
  const bits = [
    '#' + t.id,
    '[' + (t.status || '?') + ']',
    '[' + (t.owner_type || '?') + ']',
    '[' + (t.priority || 'P2') + ']',
    '[' + (t.module || '?') + ']',
  ];
  if (t.sprint) bits.push('[' + t.sprint + ']');
  if (Number(t.attention)) bits.push('[需人判断]');
  const rows = [bits.join(' ') + ' ' + (t.title || '(无标题)')];
  if (t.ops) rows.push('  ops：' + t.ops);
  if (t.output_url) rows.push('  产出：' + t.output_url);
  if (t.created_at) rows.push('  建于 ' + t.created_at + '，更新于 ' + (t.updated_at || '-'));
  if (detailLimit && t.detail) rows.push('  说明：' + summarize(String(t.detail), detailLimit));
  if (noteLimit && t.result_note) rows.push('  结果备注：' + summarize(String(t.result_note), noteLimit));
  return rows.join('\n');
}

function tasksBlock(tasks, level) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length) return '三、任务全量\n一个任务都没有。';
  const groups = {};
  for (const t of list) {
    const st = t.status || 'unknown';
    if (!groups[st]) groups[st] = [];
    groups[st].push(t);
  }
  const seen = {};
  const order = STATUS_ORDER.filter((s) => groups[s]).concat(
    Object.keys(groups).filter((s) => STATUS_ORDER.indexOf(s) === -1)
  );
  const out = [];
  for (const st of order) {
    if (seen[st]) continue;
    seen[st] = true;
    let rows = groups[st];
    let cut = 0;
    // Only the done pile gets capped, and only at the tight end of the ladder.
    if (st === 'done' && level.doneCap && rows.length > level.doneCap) {
      cut = rows.length - level.doneCap;
      rows = rows.slice(0, level.doneCap);
    }
    out.push('【' + st + '】共 ' + groups[st].length + ' 个');
    out.push(rows.map((t) => taskEntry(t, level)).join('\n'));
    if (cut) out.push('（另有 ' + cut + ' 个 done 任务因篇幅未列出，需要时问人要）');
  }
  return '三、任务全量（共 ' + list.length + ' 个）\n' + out.join('\n');
}

function factsBlock(facts) {
  const list = Array.isArray(facts) ? facts : [];
  if (!list.length) return '四、Facts 知识库\n还没有任何 fact。';
  const ok = list.filter((f) => f.status === 'confirmed');
  const pending = list.filter((f) => f.status !== 'confirmed');
  const fmt = (f) => '- ' + f.fact_key + ' = ' + summarize(String(f.value || ''), 200) + '（来源 ' + (f.source || '?') + '）';
  const rows = ['已确认 ' + ok.length + ' 条，待确认 ' + pending.length + ' 条'];
  if (ok.length) rows.push('已确认：\n' + ok.map(fmt).join('\n'));
  if (pending.length) rows.push('待确认（agent 提交，人还没点头，别当既定事实用）：\n' + pending.map(fmt).join('\n'));
  return '四、Facts 知识库\n' + rows.join('\n');
}

function jobsBlock(jobs, logTail) {
  const list = Array.isArray(jobs) ? jobs : [];
  if (!list.length) return '六、最近 job 记录\n没有 job 记录。';
  const rows = list.map((j) => {
    const head =
      '#' + j.id + ' ' + (j.type || '?') + ' [' + (j.status || '?') + ']' +
      ' 建于 ' + (j.created_at || '-') +
      (j.finished_at ? '，结束 ' + j.finished_at : '') +
      (j.token_usage ? '，token ' + j.token_usage : '');
    const lg = logTail ? tail(j.log_text, logTail) : '';
    return lg ? head + '\n  日志尾部：' + lg.replace(/\n/g, '\n  ') : head;
  });
  return '六、最近 job 记录（新到旧，含日志尾部）\n' + rows.join('\n');
}

function attentionBlock(at) {
  if (!at) return '七、例外队列\n取不到例外队列。';
  const ft = at.flagged_tasks || [];
  const co = at.client_open || [];
  const fj = at.failed_jobs || [];
  const line = (t) => '- #' + t.id + ' [' + (t.priority || 'P2') + '] ' + (t.title || '') + '（状态 ' + (t.status || '?') + '）';
  const rows = [
    '模型标记需人判断的任务 ' + ft.length + ' 个：' + (ft.length ? '\n' + ft.map(line).join('\n') : '无'),
    '客户侧未办结的任务 ' + co.length + ' 个：' + (co.length ? '\n' + co.map(line).join('\n') : '无'),
    '失败 job ' + fj.length + ' 个：' +
      (fj.length ? '\n' + fj.map((j) => '- #' + j.id + ' ' + j.type + '，建于 ' + (j.created_at || '-')).join('\n') : '无'),
    '待确认 fact ' + (at.pending_facts_count || 0) + ' 条',
  ];
  return '七、例外队列\n' + rows.join('\n');
}

/** Everything the model gets to look at, at one shrink level. */
function buildMaterials(data, level) {
  return [
    profileBlock(data.client, data.profile),
    planBlock(data.plan, level.plan),
    tasksBlock(data.tasks, level),
    factsBlock(data.facts),
    '五、最新数据快照\n' + snapshotBlock(data.snapshots),
    jobsBlock(data.jobs, level.logTail),
    attentionBlock(data.attention),
    '八、人工反馈\n' +
      '反馈框的原文没有单独接口给 agent 读。已解析的反馈摘要会以 [反馈] 开头追加在对应任务的' +
      '结果备注里，上面第三段能看到；解析中或解析失败的反馈只在第六段的 feedback 类型 job 里留痕。',
  ].join('\n\n');
}

function buildPrompt(materials) {
  return [
    '你是这家新西兰 SEO agency 的总管 agent，现在做一次客户巡检。',
    '你的产出是给公司内部人看的一页诊断，不是给客户看的报告。',
    '',
    '你这次只有一件事：把下面的材料读透，判断这个客户的运营流水线现在处于什么状态，',
    '哪里卡住了，接下来该按什么顺序做。你不执行任何变更，不新建任务，不排 job，',
    '不改任何数据。你的全部输出就是文字。',
    '',
    '决策基准',
    '- 一切建议只从 agency 的 SEO 营销效果出发：排名、流量、转化线索。',
    '- 只用现有资源和已经拿到的授权。不提需要新预算、新工具、新账号的方案，',
    '  除非它是解开某个阻塞的唯一办法，那就写进第五段并说明为什么绕不开。',
    '- **不许提任何要客户改经营方式的建议**。客户怎么做生意不是我们的活儿，',
    '  我们的活儿是把他现在的生意在搜索里推出去。',
    '',
    '铁律',
    '- **不许建议任何自动重试。** 失败的 job 要先弄清为什么失败。你可以建议人重跑，',
    '  但必须写清楚重跑前要先确认什么。',
    '- **风险操作只能建议人来做。** 放行变更、部署上线、动线上站点、发客户邮件，',
    '  这些一律写成"建议某人去做某事"，不许写成"让 agent 自动执行"。',
    '- 只引用材料里真实存在的东西。任务必须带真实 id，数字必须来自快照。',
    '  材料里没有的，就写"材料里没有这块信息"，不许编。',
    '- 材料里的 unconfirmed fact 是 agent 猜的，人还没确认，不许当既定事实用。',
    '',
    '=====  材料开始  =====',
    materials,
    '=====  材料结束  =====',
    '',
    '产出格式：中文 Markdown，固定五段，标题原样保留，一段都不能少。',
    '',
    '## 一、当前位置',
    '一句话定位这个客户处在哪个阶段：还在 initial 部署（摸底、建档、首版方案），',
    '还是在第几个 sprint 的执行期，还是在等某件事。给出你判断的依据。',
    '',
    '## 二、上阶段战果',
    '已经 done 的任务里，哪些真正产生了效果。逐条引用任务 id 和标题，',
    '能对上快照数字的要把数字写出来（点击、展示、会话、排名），并说明数据覆盖的时间段。',
    '数据还看不出效果的就直说还看不出来，不许把"做完了"包装成"有效果"。',
    '',
    '## 三、异常与阻塞',
    '逐条列出现在卡着的东西，每条必须归到下面四类之一，并标明类别：',
    '- 基础设施问题（job 失败、接口不通、凭据过期、数据没拉到）',
    '- 方案问题（方案本身写得不对、任务定得不合理、方向要调整）',
    '- 等外部依赖（等客户答复、等第三方平台、等数据积累时间）',
    '- 需人决策（两条路都能走，得有人拍板）',
    '每条写清楚：卡的是什么、卡了多久、影响到哪些任务、下一步谁做什么能解开。',
    '',
    '## 四、下一步建议批次',
    '从**材料里已经存在的任务**里挑出接下来该做的一批，给出执行顺序。',
    '每条格式：#任务 id 标题，一句话理由。理由要说清为什么是现在做、为什么排这个位置。',
    '不许发明新任务，发明的写到第五段去。这一批控制在合理规模，别把整个待办清单抄一遍。',
    '',
    '## 五、待人决策与建议新任务',
    '两部分：',
    '1. 需要人拍板的事项。每条给出推荐选项和一句理由，把利弊说清楚，别和稀泥。',
    '2. 你认为值得立但现在还不存在的新任务。每条写清楚要做什么、为什么值得做、',
    '   属于哪个模块（technical、onpage、content、local、offpage）、建议谁做（agency、client、agent）。',
    '',
    '五段写完，最后另起一段，标题写"极简版"，用不超过 150 字讲清楚：现在在哪、',
    '最大的问题是什么、下一步做什么。这段要能直接贴进聊天窗口发给同事，不带 Markdown 标记。',
    '',
    '文风',
    '- 全中文。不用 emoji。不用破折号，用逗号、句号或分号。',
    '- 说人话，不说套话。"整体运营态势良好"这种句子一句都不要有。',
    '- 有问题直接说有问题，把话说死，不要用"可能"、"或许"稀释判断，',
    '  除非你真的不确定，那就写清楚不确定在哪、需要什么信息才能确定。',
    '- 你的最终回复就是这份文档本身，从第一段标题开始，别写开场白，别写"以上"。',
    '- 材料已经全部内联在上面了，不需要你去翻工作目录里的文件。',
    '',
    '最后一件事：决策卡片',
    '五段加极简版写完之后，再追加一个 json 代码块，作为整份文档的结尾，块后面一个字都不要有。',
    '这个块是给决策收件箱用的：把上面第三段和第五段里**真正需要人拍板或者需要人动手**的事，',
    '一条一张卡片列出来。已经在顺利推进、不需要人插手的东西不要列。',
    '```json',
    '{"digest":[{"kind":"需人决策","title":"一句话说清是什么事","tasks":[12,13],' +
      '"evidence":"一句话证据，引材料里真实存在的东西","options":["A. 这样做","B. 那样做"],' +
      '"recommend":"B。一句话理由"}],"tldr":"极简版那段的原文"}',
    '```',
    '',
    '卡片的规矩',
    '- kind 只能是这四个之一：基础设施、方案、等外部依赖、需人决策。',
    '- tasks 写这条事情涉及的任务 id 数组，必须是材料里真实存在的 id。',
    '  确实不涉及具体任务的写空数组 []。**不许编 id**，编出来的 id 会让人在错的任务上做决定。',
    '- evidence 一句话，写清楚你凭什么这么说，引材料里的真实内容。',
    '- options 写人可以选的路，两到三条，每条一句话。只有一条路可走时写一条。',
    '- recommend 写你推荐哪条以及一句话理由。这条会在界面上高亮给人看，别和稀泥。',
    '- 一次最多 8 张卡片，挑最要紧的。没有任何需要人拍板的事时，digest 写空数组 []。',
    '- 全中文，不用 emoji，不用破折号。json 必须能被机器解析，字符串里不许有英文双引号和换行。',
  ].join('\n');
}

/**
 * The json tail turned into the Chinese markdown body of one inbox card.
 * The console renders this line by line: a line starting with ### opens an
 * item, a line starting with 推荐： is highlighted. Keep both prefixes.
 */
function buildDigestBody(items, tldr) {
  const rows = [];
  items.forEach((it, n) => {
    rows.push('### ' + (n + 1) + '. [' + it.kind + '] ' + it.title);
    if (it.taskLabels && it.taskLabels.length) rows.push('涉及任务：' + it.taskLabels.join('、'));
    else rows.push('涉及任务：无具体任务');
    if (it.evidence) rows.push('证据：' + it.evidence);
    if (it.options && it.options.length) {
      rows.push('可选项：');
      it.options.forEach((o) => rows.push('  ' + o));
    }
    if (it.recommend) rows.push('推荐：' + it.recommend);
    rows.push('');
  });
  if (tldr) rows.push('极简版：' + tldr);
  return rows.join('\n').trim();
}

/**
 * Read the digest block out of the report.
 * Anything without a title is dropped, and a task id that is not on this
 * client's board is dropped with a log line: the ids become the refs, and refs
 * are what later bounds what a ruling is allowed to touch.
 */
function cleanDigest(json, tasks, log) {
  const raw = json && Array.isArray(json.digest) ? json.digest : [];
  const known = {};
  for (const t of tasks || []) known[Number(t.id)] = t.title || '';
  const out = [];
  for (const item of raw) {
    if (out.length >= 8) {
      log('巡检：决策卡片超过 8 条，多出来的没有入库');
      break;
    }
    const d = item || {};
    const title = summarize(d.title, 200);
    if (!title) {
      log('巡检：丢弃一条没有标题的决策项');
      continue;
    }
    const kind = DIGEST_KINDS.indexOf(String(d.kind || '').trim()) >= 0 ? String(d.kind).trim() : '需人决策';
    const ids = [];
    const labels = [];
    for (const x of Array.isArray(d.tasks) ? d.tasks : []) {
      const n = Number(x) || 0;
      if (!n || ids.indexOf(n) >= 0) continue;
      if (!(n in known)) {
        log('巡检：决策项「' + truncate(title, 40) + '」引用了不存在的任务 #' + n + '，已丢弃');
        continue;
      }
      ids.push(n);
      labels.push('#' + n + ' ' + summarize(known[n], 60));
    }
    out.push({
      kind,
      title,
      tasks: ids,
      taskLabels: labels,
      evidence: summarize(d.evidence, 400),
      options: (Array.isArray(d.options) ? d.options : []).map((o) => summarize(o, 200)).filter((o) => o !== '').slice(0, 4),
      recommend: summarize(d.recommend, 300),
    });
  }
  return out;
}

/**
 * Fallback when the model did not give a parseable digest block. The report
 * itself is still good, so the card carries its tail instead of nothing, and
 * the task ids it names are recovered from the prose so a ruling still has
 * something in scope to act on.
 */
function fallbackDigest(text, tasks, log, reason) {
  const known = {};
  for (const t of tasks || []) known[Number(t.id)] = t.title || '';
  const ids = [];
  const re = /#(\d+)/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const n = Number(m[1]);
    if (n && ids.indexOf(n) === -1 && n in known) ids.push(n);
    if (ids.length >= 30) break;
  }
  log('巡检：决策卡片没有结构化输出（' + reason + '），退回用报告正文，识别到任务 ' + ids.length + ' 个');
  const tail = String(text || '').trim();
  const body = [
    '### 1. [需人决策] 本次巡检没有给出结构化的决策项',
    '涉及任务：' + (ids.length ? ids.map((n) => '#' + n + ' ' + summarize(known[n], 60)).join('、') : '无具体任务'),
    '证据：' + reason + '。下面是巡检报告正文，请人自己读一遍再裁决。',
    '',
    truncate(tail, 6000),
  ].join('\n');
  return { body, refs: { tasks: ids, jobs: [] } };
}

async function run(ctx) {
  const { job, cfg, api, log } = ctx;

  const context = await api.getContext(job.client_id);
  const profile = (context && context.profile) || null;
  if (!profile) throw new Error('context returned no profile for client_id ' + job.client_id);

  // Everything else is best effort: a missing side channel degrades the report,
  // it does not fail the run. Say so in the log so the reader knows what the
  // model was working from.
  let jobs = [];
  try {
    const r = await api.listJobs(job.client_id, 20);
    jobs = (r && r.jobs) || [];
  } catch (e) {
    log('巡检：读 job 历史失败，本次没有这块材料 :: ' + e.message);
  }
  let attention = null;
  try {
    attention = await api.getAttention(job.client_id);
  } catch (e) {
    log('巡检：读例外队列失败，本次没有这块材料 :: ' + e.message);
  }
  let facts = [];
  try {
    const r = await api.listFacts(job.client_id);
    facts = (r && r.facts) || [];
  } catch (e) {
    log('巡检：读 facts 失败，退回 context 里的简版 :: ' + e.message);
    const c = (context.facts && context.facts.confirmed) || [];
    const p = (context.facts && context.facts.pending) || [];
    facts = c
      .map((f) => ({ fact_key: f.fact_key, value: f.value, source: 'unknown', status: 'confirmed' }))
      .concat(p.map((f) => ({ fact_key: f.fact_key, value: f.value, source: f.source, status: 'unconfirmed' })));
  }

  const tasks = (context && Array.isArray(context.tasks) && context.tasks) || [];
  const data = {
    client: context.client,
    profile,
    plan: context.active_plan || null,
    tasks,
    facts,
    snapshots: context.latest_snapshots,
    jobs,
    attention,
  };
  log(
    '巡检材料：任务 ' + tasks.length + ' 个，fact ' + facts.length + ' 条，job ' + jobs.length +
      ' 条，方案 ' + (data.plan ? 'v' + data.plan.version : '无')
  );

  let prompt = '';
  let used = BUDGET_LADDER[BUDGET_LADDER.length - 1];
  for (let i = 0; i < BUDGET_LADDER.length; i++) {
    used = BUDGET_LADDER[i];
    prompt = buildPrompt(buildMaterials(data, used));
    if (prompt.length <= MAX_PROMPT_CHARS) break;
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    log('巡检：材料压到最小档仍有 ' + prompt.length + ' 字符，超出 ' + MAX_PROMPT_CHARS + ' 的目标，照发');
  } else {
    log(
      '巡检 prompt ' + prompt.length + ' 字符（日志尾 ' + used.logTail +
        '，任务说明 ' + used.detail + '，结果备注 ' + used.note +
        '，方案正文 ' + used.plan + '，done 上限 ' + (used.doneCap || '不限') + '）'
    );
  }

  const out = await generateDraft(ctx, {
    label: 'triage',
    prompt,
    filePrefix: 'triage',
    profile,
    model: cfg.triageModel,
    allowedTools: ALLOWED_TOOLS,
  });
  log('巡检报告已存盘：' + out.file + '，输出目录 ' + OUTPUT_DIRNAME);

  // The report keeps every one of its old destinations, file and job log
  // included. The card is an extra reader, not a replacement: the inbox wants
  // the decisions, the report keeps the reasoning behind them.
  await postDigest(ctx, out.text, tasks);

  return { tokenUsage: 0 };
}

/**
 * File the decision card. Best effort on purpose: the triage run has already
 * produced its report by this point, and losing the card is a smaller failure
 * than throwing away a run that cost a fable pass. It shouts in the log instead.
 */
async function postDigest(ctx, text, tasks) {
  const { job, api, log } = ctx;
  const parsed = extractTrailingJson(text);
  let body;
  let refs;
  if (parsed.error || !parsed.json || typeof parsed.json !== 'object') {
    const fb = fallbackDigest(parsed.body || text, tasks, log, parsed.error || 'json 块不是对象');
    body = fb.body;
    refs = fb.refs;
  } else {
    const items = cleanDigest(parsed.json, tasks, log);
    if (!items.length) {
      log('巡检：本次没有需要人拍板的事项，不写决策卡片');
      return;
    }
    const ids = [];
    for (const it of items) for (const n of it.tasks) if (ids.indexOf(n) === -1) ids.push(n);
    body = buildDigestBody(items, summarize(parsed.json.tldr, 600));
    refs = { tasks: ids, jobs: [] };
    log('巡检：决策卡片 ' + items.length + ' 条，涉及任务 ' + ids.length + ' 个');
  }
  try {
    const r = await api.postInbox({
      client_id: job.client_id,
      kind: 'digest',
      body,
      refs,
    });
    log('巡检：决策卡片已写入收件箱，inbox #' + ((r && r.id) || '?'));
  } catch (e) {
    log('警告：决策卡片写入收件箱失败，报告本身不受影响 :: ' + e.message);
  }
}

module.exports = {
  run,
  postDigest,
  buildDigestBody,
  cleanDigest,
  fallbackDigest,
  buildPrompt,
  buildMaterials,
  profileBlock,
  planBlock,
  tasksBlock,
  factsBlock,
  jobsBlock,
  attentionBlock,
  ALLOWED_TOOLS,
  MAX_PROMPT_CHARS,
  BUDGET_LADDER,
  DIGEST_KINDS,
};
