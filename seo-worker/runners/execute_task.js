'use strict';
// execute_task runner: run one Claude Code pass per task id in the payload.
//
// Two modes, chosen by the task itself:
//   analysis mode, for tasks with no ops. The agent researches and drafts.
//   prepare mode, for agent tasks that carry ops from the platform capability
//   manifest. The agent produces a change plan: the exact call sequence, the
//   expected response at each step, a diff preview and a rollback. It does not
//   make the change. A human releases it and apply_task executes it.
//
// In both modes the tools are read only plus curl, and the prompt pins curl to
// GET. Nothing in this file can alter a live site.

const fs = require('node:fs');
const path = require('node:path');

const { runClaude } = require('../lib/llm');
const { buildBrief } = require('../lib/brief');
const { extractTrailingJson } = require('../lib/mdjson');
const capabilities = require('../lib/capabilities');
const styleroll = require('../lib/styleroll');
const blogcheck = require('../lib/blogcheck');
const blogimages = require('../lib/blogimages');
const wf = require('../lib/webforger');
const contentRegistry = require('../lib/registry');
const deliverables = require('../lib/deliverables');
const { ensureClientWorkspace, summarize, truncate, safeJson } = require('../lib/util');

const ALLOWED_TOOLS = 'Read,Glob,Grep,WebFetch,Bash(curl:*)';
const OUTPUT_DIRNAME = 'seo-agent-output';
const CHANGE_PLAN_PREFIX = 'change-plan-task-';

// The blog SOP travels with the worker. No SOP, no post: writing SEO copy off
// the top of the model's head is exactly what the SOP exists to prevent.
const SOP_FILE = path.join(__dirname, '..', 'specs', 'sops', 'seo-blog-sop.md');
const BLOG_OP = 'blog-draft';
const SOCIAL_OPEN = '<<<';
const SOCIAL_CLOSE = '>>>';

/** ops arrives as a comma separated string from the server, or an array. */
function taskOps(task) {
  const raw = (task && task.ops) || '';
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return list.map((o) => String(o || '').trim().toLowerCase()).filter(Boolean);
}

function credentialsPath(workspace, platform) {
  return path.join(workspace, 'notes', capabilities.slugPlatform(platform) + '_credentials.md');
}

function findTask(context, taskId) {
  const tasks = (context && Array.isArray(context.tasks) && context.tasks) || [];
  return tasks.find((t) => String(t.id) === String(taskId)) || null;
}

function taskDetail(task) {
  const rows = [
    'Task id: ' + task.id,
    'Title: ' + (task.title || task.name || '(untitled)'),
  ];
  if (task.status) rows.push('Status: ' + task.status);
  if (task.due_date) rows.push('Due: ' + task.due_date);
  if (task.priority) rows.push('Priority: ' + task.priority);
  if (task.type || task.category) rows.push('Type: ' + (task.type || task.category));
  const detail = task.detail || task.description || task.notes || '';
  if (detail) rows.push('Detail:\n' + truncate(String(detail), 4000));
  return rows.join('\n');
}

function buildPrompt(brief, task, workspace) {
  return [
    'You are the SEO execution agent for a New Zealand digital marketing agency.',
    'You are running headless. Nobody can answer questions mid run, so make reasonable',
    'assumptions, state them, and finish the deliverable in one pass.',
    '',
    'THE TASK',
    taskDetail(task),
    '',
    brief,
    '',
    'WORKING DIRECTORY',
    'Your working directory is ' + workspace + '. Client research notes, assets and past',
    'reports may already be there, read them before you start. Use Read, Glob and Grep to',
    'look around, WebFetch to check live pages and competitors.',
    '',
    'RULES',
    '1. Deliverable only. Produce the finished artifact the task asks for, for example a',
    '   page copy draft, a technical fix list, a keyword map or an outreach angle list.',
    '2. Do not publish anything and do not attempt to modify any website. You have read',
    '   only tools by design. If the task implies publishing, produce the draft plus the',
    '   exact steps a human should take.',
    '3. Ground every claim in what you actually read from the data or the live pages. If a',
    '   number is not in the brief, say it is unknown rather than inventing it.',
    '4. Language: anything that goes on the client site, page copy, blog body, meta text,',
    '   is written in the site language. Notes, rationale and anything the agency reads',
    '   internally are written in Chinese. No emoji. No em dash or en dash, use commas,',
    '   full stops or semicolons instead.',
    '5. Start your answer with a one paragraph summary of what you produced and what you',
    '   assumed, then the deliverable itself in markdown.',
    '',
    'FACTS, only when the task was a check or a verification',
    'If this task had you verify something about the client and the answer is a stable,',
    'structured fact, finish your reply with one fenced json block and nothing after it:',
    '```json',
    '{"facts":[{"key":"gbp.status","value":"match"},{"key":"gbp.url","value":"https://..."}]}',
    '```',
    'Rules for that block:',
    '- keys are lower case, dot separated namespaces: gbp.*, product.*, policy.*, local.*',
    '- values are short and literal, a status word, a url, a number, a name. Not prose,',
    '  not a summary, not your opinion',
    '- only facts you actually verified in this run. A guess recorded as a fact is worse',
    '  than no fact, because a human will trust it later',
    '- these are stored as unconfirmed until a human confirms them, and a fact a human',
    '  already confirmed will not be overwritten',
    '- if the task produced no verified structured fact, do not output the block at all.',
    '  Most tasks produce no facts, that is normal',
  ].join('\n');
}

/**
 * The prepare prompt. The agent gets the full capability manifest, the sections
 * for the operations this task needs, the risk notes, and a pointer to the
 * credentials file. It gets no permission to change anything.
 */
function buildPreparePrompt(opts) {
  const { task, brief, workspace, platform, ops, credPath, planFile } = opts;
  const sections = ops
    .map((op) => capabilities.sectionFor(platform, op))
    .filter(Boolean)
    .join('\n\n');
  const opLines = ops
    .map((op) => '- ' + op + '（' + (capabilities.autonomyOf(platform, op) || '未知等级') + '）')
    .join('\n');

  return [
    '你是一家新西兰数字营销公司的 SEO 执行 agent，现在处于 prepare 阶段。',
    '你的产出是一份"待放行的变更方案"，不是变更本身。这个阶段你没有任何写权限，',
    '人审过方案之后，会由 apply 阶段严格照着你写的步骤执行。',
    '',
    '任务',
    taskDetail(task),
    '',
    '本任务涉及的平台操作',
    opLines,
    '',
    brief,
    '',
    '工作目录',
    '你的工作目录是 ' + workspace + '。客户的调研笔记、素材、历史报告可能已经在里面，先看再动手。',
    '',
    '凭据',
    '平台凭据在 ' + credPath + '，用 Read 读它拿账号和 token 获取方式。',
    '**凭据内容严禁出现在你的任何输出里**：不许写进方案文档，不许写进摘要，不许写进日志，',
    '不许拼进示例命令。方案里需要引用的地方一律写成占位符，例如 $WF_TOKEN、$SITE_ID，',
    '并注明"从凭据文件读取"。',
    '',
    '平台能力清单（本任务相关章节）',
    '-----',
    sections || '（清单里没有这些操作的细节章节，按下面的全局风险注记从严处理）',
    '-----',
    '',
    capabilities.riskNotes(platform) || '',
    '',
    '这个阶段允许你做什么',
    '- 用 Read、Glob、Grep 看工作区里的东西。',
    '- 用 WebFetch 看线上页面。',
    '- 用 curl **只准 GET**：读接口现状、读页面元素、读现有重定向、读候选 404。',
    '  任何 POST、PATCH、PUT、DELETE 都属于 apply 阶段，这个阶段一律不许发。',
    '  唯一例外是清单里注明"只算不写"的读取型 POST，清单没写就当成禁止。',
    '- 不确定的地方去读真实数据，不要靠猜。方案里出现凭想象写的 contentId、slug 或路径，',
    '  apply 阶段一定会撞车。',
    '',
    '产出：变更方案文档，写成 Markdown，中文，四个部分',
    '',
    '## 1. 变更目标与现状',
    '这次要改什么，为什么改，现在是什么状态。现状必须是你实际 GET 回来的，附上你读到的关键值。',
    '',
    '## 2. API 调用序列',
    '按执行顺序编号，每一步写清楚：',
    '- 方法与完整路径（siteId 用占位符）',
    '- 请求体（真实内容，不是示意，正文类字段写完整成品）',
    '- 预期响应：**只写 HTTP 状态码**。不许写"响应里某字段等于什么"，平台响应结构不是契约，会变。',
    '- 回读核对：这一步成功与否靠回读，写清回读哪个只读端点、比对什么内容（元素值、页面字段、文章正文、线上 URL 状态码）。',
    '- 这一步如果失败，是停下还是可以跳过',
    '每一条写请求都要带 header `X-WF-Changeset: $WF_CHANGESET`（apply 阶段 worker 会给出真实 id），每条 curl 带 `--max-time 120`。',
    '**不许把 POST /snapshots 写成前置步骤**，安全网是 changeset。整页覆盖类操作，前面必须有一步 GET 留档。',
    '第 2 节末尾加一行「涉及文件：」列出本方案会写到的平台文件（pages/x.html、posts/slug.md、config.json 这类），',
    'apply 结束会拿 changeset 实际碰过的文件和它比对。',
    '',
    '## 3. 变更预览',
    '每个被改动的对象给 before 和 after 对照。文案类给原文和新文；重定向类给完整的新增和删除清单；',
    '样式类给改动的选择器和规则。人看这一段就要能判断该不该放行。',
    '',
    '## 4. 回滚方式',
    '每一步怎么退回去，写成可执行的调用（反向 PATCH 回原值、反向 redirects PATCH 这类）。',
    '平台目前没有自助回滚接口，兜底是人按 changeset 原件还原，所以每一步的原值必须写在方案里。说明哪些步骤一旦执行就不可逆。',
    '',
    '## 5. 执行后验证',
    '编号列出 apply 阶段做完要跑的验证：回读哪个接口、比对哪个字段、哪个线上 URL 该返回什么状态码。',
    '每条验证要能机械判断通过与否，不许写"看起来正常"这种。',
    '',
    '文风与约束',
    '- 方案正文用中文。会写进站点的内容（页面文案、博客正文、meta 文本）按站点语言写。',
    '- 不用 emoji，不用破折号，用逗号、句号或分号。',
    '- 不许编造数字或接口字段。清单里没有的端点不许出现在方案里。',
    '- **你的最终回复本身就是方案文档**。runner 会把你最终回复的全文原样存为 ' + planFile + '，',
    '  apply 阶段只认这份文件。你没有 Write 权限，不要尝试自己写文件，也不要在最终回复里写',
    '  工作总结或"方案已保存"之类的话，最终回复从方案标题开始，到摘要后面那个 json 块结束，',
    '  别的一个字不要有。',
    '  方案必须自洽完整，不能依赖你脑子里没写出来的上下文。',
    '- 五个章节一个都不能少，章节标题原样保留。就算你调研后推翻了任务原设，只要你提出任何',
    '  要执行的变更，也必须把它写满五段结构；你的调研结论和对原设的修正写进第 1 节。',
    '  确实没有任何变更可做时，第 2 节写"本方案无 API 调用"，其余章节照样保留并说明原因。',
    '- 缺章节的方案会被机械校验直接打回，等于这次 prepare 白跑。',
    '- 最后附一段不超过 200 字的中文摘要，写清这次改什么、风险在哪、需要人重点看哪一点。',
    '- 摘要之后再附一个 json 块收尾，后面不要有任何内容：',
    '```json',
    '{"target_urls":["https://example.co.nz/some-page/"],"files":["pages/index.html","config.json"]}',
    '```',
    '  files 是本方案会写到的平台文件清单，与第 2 节末尾「涉及文件」一致，apply 结束用它和 changeset 比对。',
    '  target_urls 是本方案**将会改动**的页面完整 URL 列表，写规范域、零跳转的那一个',
    '  （拿不准就 curl -L -w "%{num_redirects}" 验一下，必须是 0）。放行的人先看这几个地址',
    '  再决定放不放，所以只写真的会被改的页面，读过没改的不许写，接口地址与本地路径也不许写。',
    '  本方案不改任何页面（例如只加重定向或只拍快照）就写空数组。',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

// The five sections a change plan must carry, mirroring buildPreparePrompt. A
// plan missing any of them can not be applied, so it never reaches the release
// panel: the job fails and the task stays approved.
const REQUIRED_PLAN_SECTIONS = ['变更目标与现状', 'API 调用序列', '变更预览', '回滚方式', '执行后验证'];

function missingPlanSections(text) {
  return REQUIRED_PLAN_SECTIONS.filter((s) => text.indexOf(s) === -1);
}

/**
 * 方案文本的机械 lint，来自 2026-08-26 两次落地失败与 Aiden 的 bot 操作说明。
 * 一条命中就打回重出，不让它进待放行：apply 阶段照着一份注定失败的方案跑 10 分钟，
 * 比 prepare 阶段多花 10 秒重写贵得多。返回问题描述数组，空数组即通过。
 */
const PLAN_FORBIDDEN_PATHS = ['/api/domains', '/api/admin', '/api/partner', '/api/migrate', '/api/payments'];
// 方案里说「不含 POST /snapshots」「不碰 /api/admin」是好话，不能当命中。带这些词的行跳过。
const PLAN_NEGATION = /(不含|不许|不准|不拍|不调用|不发|不碰|不涉及|不用|不要|不再|不建议|禁止|严禁|删掉|已失效|不存在|不做)/;
/** 只取「## 2. API 调用序列」到下一个 ## 之间的正文，真正会被 apply 照做的只有这一节。 */
function planCallSection(text) {
  const t = String(text || '');
  const m = t.match(/(?:^|\n)##\s*2[\.、]?\s*API 调用序列[^\n]*\n/);
  if (!m) return t;
  const start = m.index + m[0].length;
  const rest = t.slice(start);
  const next = rest.search(/\n##\s*\d/);
  return next === -1 ? rest : rest.slice(0, next);
}
function lintPlan(text) {
  const t = String(text || '');
  const problems = [];
  const sec = planCallSection(t);
  const lines = sec.split('\n');
  const live = lines.filter((l) => !PLAN_NEGATION.test(l));
  // 1. 全站快照当步骤（大站 restore 必挂，且 changeset 才是安全网）。只认调用行，不认注释。
  if (live.some((l) => /\bPOST\b[^\n]*\/snapshots(?![^\n]*restore)/i.test(l))) {
    problems.push('方案把 POST /snapshots 写成了步骤，全站快照不许用，安全网是 changeset');
  }
  // 2. redirects 全量 PUT
  if (live.some((l) => /\bPUT\b[^\n]*\/redirects/i.test(l))) problems.push('方案对 /redirects 用了 PUT，只准 PATCH');
  // 3. 禁区路径，只认调用行（带 HTTP 动词的）
  for (const p of PLAN_FORBIDDEN_PATHS) {
    if (live.some((l) => l.indexOf(p) !== -1 && /\b(GET|POST|PATCH|PUT|DELETE)\b/.test(l))) problems.push('方案出现禁区路径 ' + p);
  }
  // 4. 响应字段硬断言。只查「预期响应」行。
  for (const line of lines) {
    if (!/预期响应/.test(line)) continue;
    if (/(===|字段(等于|为|应为|必须是)|\bok\s*[=:]\s*true|回读体里)/.test(line)) {
      problems.push('「预期响应」写了响应字段断言：' + line.trim().slice(0, 80) + '。只准写状态码，成功靠回读核对');
      break;
    }
  }
  // 5. 涉及文件清单（全文找，可能写在第 2 节末尾或末尾 json）
  if (!/涉及文件/.test(t) && !/"files"\s*:/.test(t)) problems.push('方案没有列「涉及文件」清单，apply 无法和 changeset 比对');
  return problems;
}

/** 方案末尾 json 里的 files 清单，apply 用来和 changeset 比对。没有就空数组。 */
function planFiles(text) {
  const parsed = extractTrailingJsonSafe(text);
  const files = parsed && Array.isArray(parsed.files) ? parsed.files : [];
  return files.map((f) => String(f || '').trim()).filter(Boolean).slice(0, 50);
}
function extractTrailingJsonSafe(text) {
  try {
    const { extractTrailingJson } = require('../lib/mdjson');
    const r = extractTrailingJson(text);
    return r && r.json && typeof r.json === 'object' ? r.json : null;
  } catch (e) {
    return null;
  }
}

/**
 * 方案末尾 json 块里的 target_urls。纯函数，解析不出来就返回空数组：
 * 这一行只是给放行的人看的路标，缺了不该把一份合格方案打回。
 */
function readTargetUrls(output) {
  const parsed = extractTrailingJson(output);
  const raw = parsed && parsed.json && parsed.json.target_urls;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out = [];
  for (const item of list) {
    const u = String(item || '').trim();
    if (!/^https?:\/\/\S+$/.test(u)) continue;
    if (out.indexOf(u) === -1) out.push(u);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * 待放行 note 的头部一行。与 apply 的头部同一套写法（一行一个键，--- 收尾），
 * 人在放行面板上先看目标页面，再决定放不放。
 */
function buildTargetHeader(urls) {
  const list = Array.isArray(urls) ? urls.filter(Boolean) : [];
  return '目标页面: ' + (list.length ? list.join(' , ') : '未提供') + '\n---\n';
}

/* =========================================================
   Blog mode
   ========================================================= */

/** The SOP text, or a hard failure. Never write a post without it. */
function loadSop() {
  let text;
  try {
    text = fs.readFileSync(SOP_FILE, 'utf8');
  } catch (e) {
    throw new Error('SOP 文件缺失：' + SOP_FILE + '，博客任务拒绝执行（' + e.message + '）');
  }
  if (!text.trim()) throw new Error('SOP 文件缺失：' + SOP_FILE + ' 是空文件，博客任务拒绝执行');
  return text;
}

/** Split the SOP into its `## ` sections, in document order. */
function sopSections(text) {
  const out = [];
  const lines = String(text).split('\n');
  let cur = { heading: '', body: [] };
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      out.push(cur);
      cur = { heading: line.replace(/^##\s+/, '').trim(), body: [line] };
    } else {
      cur.body.push(line);
    }
  }
  out.push(cur);
  return out.map((s) => ({ heading: s.heading, text: s.body.join('\n').trim() }));
}

/**
 * Trim the SOP down to what this pass has to execute.
 *
 * Kept in full, because they are the rules the output is checked against:
 *   〇.二 骨架执行规范, 〇.三 去重检查, 〇.四 质量红线, 一、写作硬规则,
 *   and the one SECTION that applies to this client.
 * Dropped:
 *   〇 启动 checklist   the runner already did those steps
 *   〇.一 Style Roll    already rolled in code, showing the table invites a re roll
 *   二 配图 SOP         the writer produces briefs, not pictures; the image
 *                       stage owns the rules and enforces them mechanically
 *   三 发布流程         publishing is the apply stage's job
 *   四 移植说明         about the skill file itself, not about writing
 * From 三 发布流程 the WebForger rendering note survives, because it governs how
 * the JSON-LD block has to be written into the body.
 */
function sopForPrompt(text, section) {
  const keep = [];
  const wantSection = section === 'B' ? 'SECTION B' : 'SECTION A';
  for (const s of sopSections(text)) {
    const h = s.heading;
    if (!h) continue;
    if (/^〇\.二/.test(h) || /^〇\.三/.test(h) || /^〇\.四/.test(h) || /^一、/.test(h)) {
      keep.push(s.text);
    } else if (h.indexOf(wantSection) === 0) {
      keep.push(s.text);
    } else if (/^三、发布流程/.test(h)) {
      const idx = s.text.indexOf('### WebForger 渲染管线注意');
      if (idx !== -1) keep.push('## 渲染管线注意（写正文时必须遵守）\n\n' + s.text.slice(idx));
    }
  }
  return keep.join('\n\n---\n\n');
}

/**
 * Which half of the SOP applies. An explicit confirmed fact wins, otherwise the
 * domain decides, because a NZ or AU service site and a global SaaS want
 * opposite things from the same skeleton.
 */
function sopSectionFor(context, profile) {
  const confirmed = ((context && context.facts && context.facts.confirmed) || []);
  const hit = confirmed.find((f) => f.fact_key === 'biz.blog_section');
  if (hit) {
    const v = String(hit.value || '').trim().toUpperCase();
    if (v === 'A' || v === 'B') return { section: v, why: 'facts 里的 biz.blog_section' };
  }
  const domain = String((profile && profile.domain) || '').toLowerCase();
  if (/webforger\.(ai|site)/.test(domain)) return { section: 'B', why: '域名是 webforger 自营站' };
  if (/\.nz(\/|$)|\.au(\/|$)|\.co\.nz|\.com\.au/.test(domain)) {
    return { section: 'A', why: '域名是 NZ 或 AU 站，按本地服务行业处理' };
  }
  return { section: 'A', why: '没有判定依据，默认按本地服务行业处理' };
}

/** Every path a body is allowed to link to: the page registry plus real posts. */
function allowedPathsFrom(pages, posts) {
  const out = new Set(['/', '/blog']);
  for (const p of pages || []) {
    const raw = p && (p.path || p.url || p.slug);
    if (!raw) continue;
    let s = String(raw);
    if (!s.startsWith('/')) s = '/' + s;
    s = s.replace(/index\.html$/, '').replace(/\.html$/, '');
    out.add(blogcheck.normPath(s));
  }
  for (const post of posts || []) {
    if (post && post.slug) out.add(blogcheck.normPath('/blog/' + post.slug));
  }
  return Array.from(out);
}

function categorySlugs(categories) {
  return (categories || [])
    .map((c) => (typeof c === 'string' ? c : c && (c.slug || c.name)))
    .filter(Boolean)
    .map(String);
}

/** Newest first, tolerating whichever timestamp field the platform sends. */
function sortPostsNewestFirst(posts) {
  return (posts || []).slice().sort((a, b) => {
    const at = String((a && (a.updatedAt || a.createdAt || a.publishedAt)) || '');
    const bt = String((b && (b.updatedAt || b.createdAt || b.publishedAt)) || '');
    return bt.localeCompare(at);
  });
}

/** Structural fingerprint of an existing post, for the SOP's dedup check. */
function fingerprint(post, body) {
  const st = blogcheck.structure(body);
  const parsed = styleroll.parseRollComment(body);
  return {
    slug: (post && post.slug) || '',
    title: (post && post.title) || '',
    roll: parsed.found ? parsed.fields : null,
    tables: st.tables,
    uls: st.uls,
    blockquotes: st.blockquotes,
    h2Count: st.h2Count,
    words: st.words,
    h2Sample: st.h2.slice(0, 4),
    lead: blogcheck.leadText(body, 50),
  };
}

function fingerprintBlock(prints) {
  if (!prints.length) return '站上还没有可比对的历史博文，去重检查这一轮没有约束对象。';
  return prints
    .map((f, i) => {
      const rollTxt = f.roll
        ? Object.keys(f.roll).map((k) => k + '=' + f.roll[k]).join(' | ')
        : '（没有 Style Roll 注释）';
      return [
        '第 ' + (i + 1) + ' 篇 ' + f.slug + '：' + f.title,
        '  Style Roll：' + rollTxt,
        '  结构：表格 ' + f.tables + '，UL ' + f.uls + '，blockquote ' + f.blockquotes +
          '，H2 ' + f.h2Count + ' 个，约 ' + f.words + ' 词',
        '  H2 举例：' + (f.h2Sample.join(' / ') || '无'),
        '  开头 50 词：' + f.lead,
      ].join('\n');
    })
    .join('\n\n');
}

/**
 * The revision brief on a task, newest first.
 *
 * Two sources write into result_note. [客户审阅 第N轮 ...] comes from the client
 * pressing "request changes" on the preview page, [反馈] comes from a human
 * pasting words into the board's feedback box. The client's own words win when
 * both are present, because they are the reason the draft came back, and the
 * round header goes into the prompt as is so the writer knows which round it is.
 */
function latestFeedbackNote(task) {
  const note = String((task && task.result_note) || '');
  if (!note) return '';
  const lines = note.split('\n').map((l) => l.trim());
  let lastReview = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].indexOf('[客户审阅') === 0) lastReview = i;
  }
  if (lastReview === -1) {
    const manual = lines.filter((l) => l.indexOf('[反馈]') === 0);
    return manual.length ? manual[manual.length - 1].replace(/^\[反馈\]\s*/, '') : '';
  }
  // Anything a human typed after the client's last round is a deliberate
  // addition to it, so it rides along instead of being dropped.
  const after = lines
    .slice(lastReview + 1)
    .filter((l) => l.indexOf('[反馈]') === 0)
    .map((l) => l.replace(/^\[反馈\]\s*/, ''));
  return after.length ? lines[lastReview] + '\n我们同事补充：' + after.join('；') : lines[lastReview];
}

/* =========================================================
   Content registry: what the site already covers
   =========================================================

   Built live off the platform rather than read from the snapshot, on purpose.
   A draft another run created an hour ago is exactly the thing this check
   exists to catch, and it would not be in yesterday's snapshot. The stored
   snapshot is only the fallback for when the live enumeration breaks.
*/

/**
 * Live registry for the write path, plus the cannibalisation signal computed
 * from whatever GSC rows are already on record. Never throws: a failed
 * enumeration falls back to the snapshot, and a failed snapshot read returns
 * null, which the caller turns into a loud warning in the brief rather than a
 * silent pass.
 */
async function blogRegistry(ctx, context, client, profile, taskId) {
  const { log } = ctx;
  const gsc = (context && context.latest_snapshots && context.latest_snapshots.gsc) || null;
  const gscData = gsc ? safeJson(gsc.data, null) : null;
  let reg = null;
  try {
    // withHeadings off: the collision check reads slugs, keywords and titles,
    // and one elements call per page would slow the write path for nothing.
    reg = await contentRegistry.buildRegistry({ client, profile, log, withHeadings: false });
    log('task ' + taskId + '：站内注册表实时枚举完成，' + reg.total + ' 条');
  } catch (e) {
    log('task ' + taskId + '：实时枚举失败，退回注册表快照 :: ' + e.message);
    const snap = (context && context.latest_snapshots && context.latest_snapshots[contentRegistry.SOURCE]) || null;
    reg = snap ? safeJson(snap.data, null) : null;
    if (reg) log('task ' + taskId + '：用的是 ' + (snap.created_at || '未知时间') + ' 的注册表快照，可能漏掉最近的草稿');
  }
  if (!reg) return null;
  reg.cannibal = contentRegistry.cannibalSignals(gscData);
  if (reg.cannibal.available) {
    log(
      'task ' + taskId + '：蚕食信号 ' + reg.cannibal.signal_count +
        ' 条（互抢明显 ' + reg.cannibal.high_count + ' 条）'
    );
  } else {
    log('task ' + taskId + '：' + reg.cannibal.reason);
  }
  return reg;
}

/* A task that names its own target term. Plan written tasks usually spell it
   out in the detail, and when they do we can fail before spending a model run
   instead of after. No extraction is not an error, it just means the check
   happens after generation like normal. */
const TASK_KEYWORD_RE = /(?:主词|目标关键词|关键词|target\s*keyword|keyword)\s*[:：]\s*([^\n；;，,。]+)/i;
const TASK_SLUG_RE = /\bslug\s*[:：]\s*([a-z0-9-]+)/i;

function taskCandidate(task) {
  const text = [task && task.title, task && task.detail, task && task.description]
    .filter(Boolean)
    .join('\n');
  const kw = text.match(TASK_KEYWORD_RE);
  const slug = text.match(TASK_SLUG_RE);
  if (!kw && !slug) return null;
  return {
    keyword: kw ? kw[1].trim() : '',
    slug: slug ? slug[1].trim() : '',
    title: '',
  };
}

/** The registry block a blog prompt carries: the inventory plus the ban list. */
function registryPromptBlock(reg, excludeSlug) {
  if (!reg) {
    return [
      '站内内容注册表',
      '**注册表这次没能生成**，所以这一轮没有机械化的撞车情报。',
      '这不代表站上没有相近内容，只代表我们没测到。写之前用 WebFetch 看一眼站点的 /blog/ 列表页，',
      '选题往明显没被覆盖的方向靠，并在正文开头一句话说明你据此做了什么规避。',
    ].join('\n');
  }
  return [
    contentRegistry.registryBlock(reg, { maxEntries: 80, maxSignals: 12 }),
    '',
    '本轮禁止清单',
    contentRegistry.forbiddenBlock(reg, { excludeSlug }),
  ].join('\n');
}

function factsBlock(context) {
  const confirmed = ((context && context.facts && context.facts.confirmed) || []);
  if (!confirmed.length) return '（没有已确认的 fact，写作素材只能来自任务说明）';
  return confirmed.map((f) => '- ' + f.fact_key + ' = ' + truncate(String(f.value || ''), 300)).join('\n');
}

function blogSiteBlock(opts) {
  const { profile, siteId, brand, lang, section, sectionWhy } = opts;
  return [
    '站点：' + (profile.domain || '未填域名') + '（siteId ' + siteId + '）',
    '品牌名：' + brand,
    '正文语言：' + lang,
    'SOP 语境：' + (section === 'B' ? 'SECTION B 全球 SaaS' : 'SECTION A 本地服务行业') + '（判定依据：' + sectionWhy + '）',
    profile.business_goals ? '业务目标：' + truncate(String(profile.business_goals), 400) : '',
    profile.conversion_goals ? '转化目标：' + truncate(String(profile.conversion_goals), 300) : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The image brief section of the output contract.
 *
 * Only a fresh write carries it. The rules are spelled out here rather than
 * left to the SOP excerpt because the briefs are machine input: the image stage
 * sends flux_prompt to FLUX verbatim, so a vague brief becomes a wasted
 * generation and a blocked job, not a slightly worse picture.
 */
function imageBriefContract() {
  return [
    'image_briefs 写法（这是配图工序的输入，程序会照着它直接调 FLUX 出图，你写什么就出什么）',
    '- 正好 4 条，slot 依次是 "hero"、"body-1"、"body-2"、"body-3"，顺序不许乱，不许多不许少。',
    '- anchor：hero 的 anchor 原样写本篇 title；body-1 到 body-3 各绑一个**正文里真实存在的 H2**，',
    '  原样照抄那一行 H2 的文字（不带 ## 号，不许改写、不许缩写），三条绑三个不同的 H2，',
    '  按它们在正文里出现的顺序排。绑错或绑一个不存在的 H2，机器校验直接打回。',
    '- scene：中文，一到两句，写清这张图里**实际能看到什么**：什么空间、什么物件、',
    '  什么人在做什么动作、什么光线。这是给我们同事复核用的内部说明，不是发给 FLUX 的。',
    '- alt：站点语言，描述图里实际画面，并自然带上目标关键词的一个变体。',
    '  写画面里有什么，不许写它"代表"什么。',
    '- flux_prompt：英文，就是直接发给 FLUX 的那一句。四条硬规则：',
    '  1. **必须具象实景**：相机能拍到的场景、物件、动作、材质、光线。',
    '  2. **禁止抽象隐喻**：不许出现 representing / symbolizing / conceptual / metaphor /',
    '     abstract 这类词，也不许用"价签代表成本""门代表选择""纸飞机代表轻量"这种 stock 套路。',
    '     图要画这一节在讲的那个东西本身。',
    '  3. **必须原样以这一串收尾，一字不差**：' + blogcheck.NO_TEXT_TAIL,
    '  4. 长度 ' + blogcheck.FLUX_PROMPT_MIN + ' 到 ' + blogcheck.FLUX_PROMPT_MAX + ' 字符，写足细节：',
    '     场景加主体加动作加光线加构图加风格。参考句式：',
    '     Professional editorial photograph of <具体场景与主体>, <光线>, <构图>, realistic,',
    '     high quality, ' + blogcheck.NO_TEXT_TAIL,
    '- 4 张图必须是 4 个明显不同的画面，不许 4 张都是同一个客厅换角度。',
    '- 出图之后有一道机器视觉质检，会逐张查伪文字、是否贴题、是否畸变，不过的会带原因重出。',
    '  prompt 写得越具体，重出次数越少。',
    '- **正文里仍然不许出现任何图片标记**，图由程序在这一步之后按 anchor 机械插进去。',
  ].join('\n');
}

/**
 * The output contract. Shared by the write and the revise prompt, except for
 * the image briefs, which only a fresh write produces.
 */
function blogOutputContract(roll, opts) {
  const withImages = !!(opts && opts.withImageBriefs);
  const fields = [
    '  "title": "英文标题，含目标关键词",',
    '  "slug": "ascii-lowercase-with-hyphens",',
    '  "category": "站点现有分类的 slug，原样照抄",',
    '  "keyword": "目标关键词",',
    '  "excerpt": "英文摘要，一到两句",',
    '  "meta_description": "英文 meta description，50 到 165 字符",',
    '  "body_markdown": "正文全文，markdown，第一行是 Style Roll 注释",',
    '  "social_message": "中文微信话术，80 到 150 字，结尾带 {PREVIEW_URL} 占位符"' + (withImages ? ',' : ''),
  ];
  if (withImages) {
    fields.push(
      '  "image_briefs": [',
      '    {"slot":"hero","anchor":"本篇 title 原文","scene":"中文，这张图里实际能看到什么","alt":"站点语言的 alt","flux_prompt":"英文 FLUX prompt"},',
      '    {"slot":"body-1","anchor":"正文里某个 H2 的原文","scene":"...","alt":"...","flux_prompt":"..."},',
      '    {"slot":"body-2","anchor":"另一个 H2 的原文","scene":"...","alt":"...","flux_prompt":"..."},',
      '    {"slot":"body-3","anchor":"第三个 H2 的原文","scene":"...","alt":"...","flux_prompt":"..."}',
      '  ]'
    );
  }
  const lines = [
    '产出格式：你的最终回复必须以一个 json 代码块结尾，块之后不许再有任何文字。',
    '```json',
    '{',
    ...fields,
    '}',
    '```',
    '',
    'body_markdown 的第一行必须原样是这一行注释，一个字都不许改：',
    styleroll.rollComment(roll),
    '',
    'social_message 写法：这是我们发给客户的微信消息，口吻是"我们替您运营站点"，中文，',
    '说清楚给他站点写了一篇什么主题的文章、请他看看内容与表述是否符合他的偏好、没问题我们就发布。',
    '不要吹嘘，不要写 SEO 术语，不要写 emoji，不要写破折号。链接位置写 {PREVIEW_URL} 占位符，',
    'runner 会替换成真实预览链接。',
    '',
  ];
  if (withImages) lines.push(imageBriefContract(), '');
  lines.push(
    '交之前自己把 json 通读一遍：字段是不是齐、' +
      (withImages ? 'image_briefs 是不是 4 条且 anchor 都能在正文里找到、' : '') +
      '字符串里有没有未转义的英文双引号。json 解析不了这一轮就白跑了。'
  );
  return lines.join('\n');
}

function blogHardRules(opts) {
  const { allowedPaths, categories, lang, keepImages, withImageBriefs } = opts;
  let imageRule;
  if (keepImages && keepImages.length) {
    imageRule = [
      '1. **现有图片一张不许动。** 原稿里已有 ' + keepImages.length + ' 张图片，全部原样保留：',
      '   相同的 alt、相同的路径、留在原来的段落位置附近。不许删除、不许改路径、不许新增图片。',
      '   机器校验会逐张比对，少一张多一张都打回。',
    ];
  } else if (withImageBriefs) {
    imageRule = [
      '1. **正文里不许出现任何 markdown 图片或 <img> 标签。** 图不是你插的：配图是写稿之后的',
      '   独立工序，程序按你给的 image_briefs 出图、质检、再按 H2 锚点机械插进正文。',
      '   你现在编造的图片路径一定是 404。',
    ];
  } else {
    imageRule = [
      '1. **本轮不许插图。** 正文里不许出现任何 markdown 图片或 <img> 标签。配图是另一道独立工序。',
      '   你现在编造的图片路径一定是 404。',
    ];
  }
  return [
    '这一轮的硬约束，违反任何一条都会被机器校验打回重写：',
    ...imageRule,
    '2. **内链只准指向下面这张真实路径清单里的路径**，一条都不许编：',
    allowedPaths.map((p) => '   ' + p).join('\n'),
    '   全篇内链总数最多 3 条（2 主 1 次）。',
    '3. **分类只准从下面这张现有分类清单里选一个最贴的**，不许发明新分类：',
    '   ' + (categories.length ? categories.join('、') : '（站点还没有分类，category 写 blog）'),
    '4. 正文、标题、meta、excerpt 用' + lang + '；social_message 用中文。',
    '5. 正文里不许出现 emoji，不许出现破折号，用逗号句号或分号。',
    '6. FAQ 部分的 FAQPage JSON-LD 直接用 <script type="application/ld+json">{...}</script> 写在正文末尾。',
    '   Article 和 BreadcrumbList schema 由平台自动注入，不要自己写。',
    '7. 字数 ' + blogcheck.WORD_MIN + ' 到 ' + blogcheck.WORD_MAX + ' 词之间，这是硬性区间。',
    '8. 不要在正文里写 meta 信息，不要写 "In this article"、"Let\'s dive in"、"In conclusion" 这类废话。',
  ].join('\n');
}

function buildBlogPrompt(opts) {
  const { task, roll, sop, siteBlock, facts, hardRules, fingerprints, contract, registryText, conflictText } = opts;
  return [
    '你是这家新西兰数字营销公司的 SEO 内容 agent，现在给客户站点写一篇博文。',
    '你是在无人值守的情况下运行的，没人能中途回答你的问题，所以按下面给定的参数一次写完。',
    '',
    '这篇文章的风格组合已经由程序掷定，**你不许自己重新掷，也不许改**：',
    styleroll.rollSummary(roll),
    '',
    '骨架标了什么就必须写成什么。标 ' + roll.skeleton.label + ' 却写成别的结构，是 SOP 红线第 12 条，直接打回。',
    '',
    '任务',
    taskDetail(task),
    '',
    '站点信息',
    siteBlock,
    '',
    '客户已确认的事实（写作素材，只能用这里的，不许编数字）',
    facts,
    '',
    opts.clientRules || '',
    '',
    registryText,
    '',
    conflictText || '',
    '',
    '站内最近博文的结构指纹（用于 SOP 〇.三 去重检查，本篇必须和它们明显不同）',
    fingerprints,
    '',
    hardRules,
    '',
    '===== SOP 摘录开始，这是硬性规范 =====',
    sop,
    '===== SOP 摘录结束 =====',
    '',
    contract,
  ].join('\n');
}

function buildBlogRevisePrompt(opts) {
  const { task, roll, sop, siteBlock, facts, hardRules, contract, currentBody, feedback, slug, registryText } = opts;
  return [
    '你是这家新西兰数字营销公司的 SEO 内容 agent。站点上有一篇**已经写好的草稿**，',
    '客户看过预览之后提了意见，现在你要按意见改稿。',
    '',
    '这是改稿，不是重写。没有被意见点到的部分尽量保持原样，尤其是结构、骨架和已经写好的数据。',
    '**slug 必须保持 ' + slug + ' 不变**，改了 slug 会让客户手里的预览链接失效。',
    'Style Roll 注释也保持原样不变，骨架不许换。',
    '',
    '本篇的风格组合（沿用原稿，不许改）：',
    styleroll.rollSummary(roll),
    '',
    '任务',
    taskDetail(task),
    '',
    '客户这次的意见（这是改稿的唯一依据）',
    '=====',
    feedback || '（任务备注里没有找到 [反馈] 段落，按任务说明里的要求改）',
    '=====',
    '',
    '站点信息',
    siteBlock,
    '',
    '客户已确认的事实',
    facts,
    '',
    opts.clientRules || '',
    '',
    registryText,
    '（本篇自己已经从上面的清单里排除掉了。改稿不许把主题往清单里其他条目上靠。）',
    '',
    '当前草稿全文',
    '=====',
    currentBody,
    '=====',
    '',
    hardRules,
    '',
    '===== SOP 摘录开始，这是硬性规范 =====',
    sop,
    '===== SOP 摘录结束 =====',
    '',
    contract,
    '',
    '改完之后 json 里所有字段都要给全，body_markdown 是改后的完整正文，不是 diff。',
  ].join('\n');
}

/** Pull the draft json out of the model reply and say why if it is not there. */
function readDraftJson(output) {
  const parsed = extractTrailingJson(output);
  if (parsed.error || !parsed.json || typeof parsed.json !== 'object') {
    return { ok: false, error: parsed.error || 'json 块不是一个对象' };
  }
  return { ok: true, draft: parsed.json };
}

/**
 * One blog task: roll the style, write or revise, check it mechanically, then
 * put the draft on the platform. The draft is never published here, and the
 * task lands in review with the three deliverables a human needs to forward it.
 */
/**
 * 客户规则层：PJ 手工产线动笔前读的东西，原样喂给无头模型。
 * 两个来源：客户工作区的 CLAUDE.md，以及记忆目录里该客户的 feedback_* 文件
 * （客户目录名 = 工作区目录名）。每份截 1500 字，总量 9000 字，超出的按文件名排序截掉并记日志。
 */
const RULES_PER_FILE = 1500;
const RULES_TOTAL = 9000;
function clientRulesBlock(cfg, workspace, log) {
  const slug = path.basename(String(workspace || ''));
  const parts = [];
  let total = 0;
  const push = (label, text) => {
    const t = truncate(String(text || '').trim(), RULES_PER_FILE);
    if (!t) return false;
    if (total + t.length > RULES_TOTAL) return false;
    parts.push('[' + label + ']\n' + t);
    total += t.length;
    return true;
  };
  try {
    const claude = path.join(workspace, 'CLAUDE.md');
    if (fs.existsSync(claude)) push('客户 CLAUDE.md', fs.readFileSync(claude, 'utf8'));
  } catch (e) { /* 没有就没有 */ }
  try {
    const dir = path.join(String(cfg.memoryDir || ''), slug);
    if (slug && fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => /^feedback_.*\.md$/.test(f)).sort();
      let dropped = 0;
      for (const f of files) {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^---[\s\S]*?---\s*/, '');
        if (!push(f.replace(/\.md$/, ''), raw)) dropped += 1;
      }
      if (log) log('客户规则层：' + slug + ' 读到 ' + files.length + ' 条 feedback 记忆' + (dropped ? '，超预算丢 ' + dropped + ' 条' : ''));
    }
  } catch (e) {
    if (log) log('客户规则层读取失败，照常写 :: ' + e.message);
  }
  if (!parts.length) return '';
  return [
    '===== 客户规则开始（这是我们团队在这个客户身上踩过的坑，每一条都是硬约束，优先级高于 SOP 通用规则）=====',
    parts.join('\n\n'),
    '===== 客户规则结束 =====',
  ].join('\n');
}

/**
 * 大纲门：任务要求「先大纲、客户回批」时，本轮只出大纲进待放行，不写正文。
 * 回批后人在线程里说「大纲已批」触发重跑，任务说明里会带 [大纲已批] 标记（线程指令写进 detail），
 * 或者人工把这句加进说明，就直通正文。
 */
const OUTLINE_GATE_RE = /(大纲|outline)[^\n]{0,30}(客户|回批|审批|过目|先审|先交|approv)/i;
const OUTLINE_DONE_RE = /大纲已批|大纲已过|outline approved|大纲回批通过/i;
function outlineGate(task) {
  const text = [task && task.detail, task && task.review_adjust].filter(Boolean).join('\n');
  if (OUTLINE_DONE_RE.test(text)) return { gate: false, why: '任务说明里已标大纲已批' };
  if (OUTLINE_GATE_RE.test(text)) return { gate: true, why: '任务要求大纲先交客户回批' };
  return { gate: false, why: '' };
}

function buildOutlinePrompt(opts) {
  const { task, roll, siteBlock, facts, clientRules, registryText, sop, allowedPaths } = opts;
  return [
    '你是这家新西兰数字营销公司的 SEO 内容 agent。这个任务要求**大纲先交客户回批，回批后才写正文**。',
    '所以你这一轮只出大纲，不写正文。无人值守，一次写完。',
    '',
    '风格组合已由程序掷定，正文阶段会沿用：' + styleroll.rollSummary(roll),
    '',
    '任务',
    taskDetail(task),
    '',
    '站点信息',
    siteBlock,
    '',
    '客户已确认的事实（只能用这里的，不许编数字）',
    facts,
    '',
    clientRules || '',
    '',
    registryText,
    '',
    '===== SOP 摘录（骨架与红线，大纲要按它的结构走）=====',
    sop,
    '===== SOP 摘录结束 =====',
    '',
    '内链只准从这些真实路径里选：',
    (allowedPaths || []).slice(0, 60).map((p) => '   ' + p).join('\n'),
    '',
    '产出格式：最终回复以一个 json 代码块结尾，块后不许有文字：',
    '```json',
    '{"title":"英文标题，含目标关键词","keyword":"目标关键词","slug":"ascii-lowercase","category":"站点现有分类 slug",',
    ' "outline_markdown":"大纲全文 markdown：每个 H2 一行加两三句要写什么、要用哪条 fact、要放哪条内链、表格放哪里；末尾列出 FAQ 三问",',
    ' "questions_for_client":["需要客户确认的点，例如行情区间的口径"],',
    ' "social_message":"中文微信话术，80 到 150 字，请客户看大纲，结尾带 {PREVIEW_URL} 占位符"}',
    '```',
    '中文说明，英文标题与大纲条目按站点语言。不用 emoji，不用破折号。字符串里不许有未转义英文双引号。',
  ].join('\n');
}

/** 审稿：机器校验过了之后，大模型按客户规则再读一遍，只出意见。回 { ok, verdict, issues } */
async function reviewDraft(ctx, opts) {
  const { cfg, log } = ctx;
  const { draft, clientRules, task, workspace, taskId } = opts;
  const prompt = [
    '你是这家新西兰 SEO agency 的审稿人。下面是一篇无头模型写好、机器校验已通过的博客草稿。',
    '你的工作只有一件：按客户规则和交付常识挑出**必须改**的地方，不改文，不复述，不夸。',
    '只看这些：事实与口径（有没有编数字、有没有违反客户规则里的红线）、页面类型与读者路径是否对题、',
    '是否有 AI 腔与废话、内链与 FAQ 是否自然、标题与 meta 是否像人写的。结构骨架机器已查过，不用再查。',
    '',
    '任务',
    taskDetail(task),
    '',
    clientRules || '（该客户没有额外规则）',
    '',
    '===== 草稿开始 =====',
    'title: ' + draft.title,
    'meta_description: ' + draft.meta_description,
    'excerpt: ' + draft.excerpt,
    '',
    truncate(String(draft.body_markdown || ''), 24000),
    '===== 草稿结束 =====',
    '',
    '输出：最终回复以一个 json 代码块结尾，块后不许有文字：',
    '```json',
    '{"verdict":"pass","issues":[]}',
    '```',
    '或 {"verdict":"revise","issues":["具体到段落或句子的修改要求，每条一句，最多 6 条"]}。',
    '只有真的必须改才 revise；措辞偏好不算。全中文，不用 emoji，不用破折号，字符串里不许有英文双引号。',
    '不要读工作目录里的文件，材料已经全在上面。',
  ].join('\n');
  try {
    const res = await runClaude(cfg, { prompt, cwd: workspace, log, model: cfg.blogReviewModel, allowedTools: 'Read', label: 'blog review ' + taskId });
    const parsed = extractTrailingJson(String(res.stdout || ''));
    if (parsed.error || !parsed.json) return { ok: false, verdict: 'pass', issues: [], error: parsed.error || 'no json' };
    const verdict = String(parsed.json.verdict || 'pass').toLowerCase() === 'revise' ? 'revise' : 'pass';
    const issues = (Array.isArray(parsed.json.issues) ? parsed.json.issues : []).map((x) => summarize(x, 300)).filter(Boolean).slice(0, 6);
    return { ok: true, verdict: issues.length ? verdict : 'pass', issues };
  } catch (e) {
    log('task ' + taskId + '：审稿调用失败，按通过处理 :: ' + e.message);
    return { ok: false, verdict: 'pass', issues: [], error: e.message };
  }
}

async function runBlogTask(ctx, context, workspace, task) {
  const { cfg, api, log } = ctx;
  const profile = (context && context.profile) || {};
  const taskId = task.id;

  const sopText = loadSop();
  log('task ' + taskId + '：博客模式，SOP 已加载 ' + sopText.length + ' 字符');

  const credPath = credentialsPath(workspace, profile.platform);
  const cred = wf.readCredentials(credPath);
  const client = new wf.WebForger({
    base: cfg.webforgerApi,
    timeoutMs: cfg.httpTimeoutMs,
    lang: cfg.blogLang || '',
  });
  const who = await client.login(cred.email, cred.password);
  log('task ' + taskId + '：已登录 WebForger，siteId ' + who.siteId);

  const posts = await client.listPosts();
  const ordered = sortPostsNewestFirst(posts);
  log('task ' + taskId + '：站上现有 ' + posts.length + ' 篇博文');

  // Previous skeleton, so the rotation never repeats itself twice running.
  let previousSkeletonLabel = null;
  const prints = [];
  for (const post of ordered.slice(0, 3)) {
    try {
      const got = await client.getPost(post.slug);
      const body = String((got && got.post && got.post.body) || '');
      if (!body) continue;
      const fp = fingerprint(post, body);
      prints.push(fp);
      if (!previousSkeletonLabel && fp.roll && fp.roll['骨架']) previousSkeletonLabel = fp.roll['骨架'];
    } catch (e) {
      log('task ' + taskId + '：读历史博文 ' + post.slug + ' 失败，跳过 :: ' + e.message);
    }
  }
  if (previousSkeletonLabel) log('task ' + taskId + '：上一篇骨架是 ' + previousSkeletonLabel);

  const roll = styleroll.roll({ postCount: posts.length, previousSkeletonLabel });
  for (const n of roll.notes) log('task ' + taskId + '：Roll 说明 ' + n);
  log('task ' + taskId + '：本篇 Style Roll ' + styleroll.rollSummary(roll));

  const categories = categorySlugs(await client.listCategories());
  let pages = [];
  try {
    pages = await client.listPages();
  } catch (e) {
    log('task ' + taskId + '：页面注册表读不到，内链只允许指向博客路径 :: ' + e.message);
  }
  const allowedPaths = allowedPathsFrom(pages, ordered);
  log('task ' + taskId + '：可用内链路径 ' + allowedPaths.length + ' 条，分类 ' + (categories.join('、') || '无'));

  // A task that already carries a preview link is a revision round.
  let mode = 'create';
  let slug = '';
  let currentBody = '';
  const outputUrl = String(task.output_url || '');
  if (outputUrl && wf.isBlogUrl(outputUrl, profile.domain)) {
    slug = wf.slugFromBlogUrl(outputUrl);
    if (slug) {
      try {
        const got = await client.getPost(slug);
        const post = (got && got.post) || null;
        if (post) {
          mode = 'revise';
          currentBody = String(post.body || '');
          const parsedRoll = styleroll.parseRollComment(currentBody);
          const keep = parsedRoll.found && styleroll.skeletonByLabel(parsedRoll.skeletonLabel);
          if (keep) {
            roll.skeleton = keep;
            if (parsedRoll.fields['语气']) roll.tone = parsedRoll.fields['语气'];
            if (parsedRoll.fields['开头']) roll.opening = parsedRoll.fields['开头'];
            if (parsedRoll.fields['CTA']) roll.cta = parsedRoll.fields['CTA'];
            if (parsedRoll.fields['标题']) roll.title = parsedRoll.fields['标题'];
            if (parsedRoll.fields['密度']) roll.density = parsedRoll.fields['密度'];
            log('task ' + taskId + '：改稿轮，沿用原稿 Style Roll ' + styleroll.rollSummary(roll));
          }
        }
      } catch (e) {
        log('task ' + taskId + '：output_url 指向的草稿 ' + slug + ' 读不到，按新建处理 :: ' + e.message);
        slug = '';
      }
    }
  }

  // Registry and cannibalisation, built after the mode is known so a revision
  // can exclude its own post from its own ban list.
  const reg = await blogRegistry(ctx, context, client, profile, taskId);

  // Pre flight. When the task spells out its own target term we can refuse
  // before spending a model run. Only exact and high block; near is information
  // and rides into the prompt like everything else.
  let preConflictText = '';
  if (reg && mode === 'create') {
    const cand = taskCandidate(task);
    if (cand) {
      const verdict = contentRegistry.checkCollision(cand, reg, {});
      if (verdict.blocking) {
        throw new Error(
          'task ' + taskId + '：选题在写之前就已经和站内内容撞车，未调用模型，任务保持原状。\n' +
            contentRegistry.collisionReport(verdict)
        );
      }
      if (verdict.nears.length) {
        log('task ' + taskId + '：任务自带主词有 ' + verdict.nears.length + ' 条近似内容，已写进简报');
        preConflictText = [
          '本次选题的近似内容（程序机械比对出来的，不是模型判断）',
          '下面这些站内内容和本次主词相近但不构成撞车。你必须主动和它们拉开角度：',
          verdict.nears
            .slice(0, 8)
            .map((c) => '- ' + c.url + '（主词「' + (c.primary_term || '未知') + '」，' + c.reason + '）')
            .join('\n'),
          '在正文开头之前，先在你回复的第一段里用一句话说明本篇和它们的分工是什么。',
        ].join('\n');
      }
    }
  }
  const registryText = registryPromptBlock(reg, mode === 'revise' ? slug : '');

  const sectionPick = sopSectionFor(context, profile);
  const brand =
    (context && context.client && context.client.name) || profile.domain || '客户站点';
  const lang = cfg.blogLang ? cfg.blogLang : '英文（站点默认语言）';
  // On a revision the images already placed by the image pass are load bearing:
  // the model must carry them through untouched, and the checker compares sets.
  const keepImages = mode === 'revise' ? currentBody.match(/!\[[^\]]*\]\([^)]+\)/g) || [] : [];
  const shared = {
    task,
    roll,
    sop: sopForPrompt(sopText, sectionPick.section),
    siteBlock: blogSiteBlock({
      profile,
      siteId: who.siteId,
      brand,
      lang,
      section: sectionPick.section,
      sectionWhy: sectionPick.why,
    }),
    facts: factsBlock(context),
    hardRules: blogHardRules({
      allowedPaths,
      categories,
      lang,
      keepImages,
      withImageBriefs: mode !== 'revise',
    }),
    // Image briefs on a fresh write only. A revision keeps the pictures the
    // image stage already placed, so it neither writes briefs nor re-runs the
    // stage, and its image rules stay exactly what they were.
    contract: blogOutputContract(roll, { withImageBriefs: mode !== 'revise' }),
    registryText,
  };

  const clientRules = clientRulesBlock(cfg, workspace, log);
  const lintRules = blogcheck.loadLintRules(cfg.lintRulesFile, path.basename(workspace));
  shared.clientRules = clientRules;

  // ---- 大纲门 ----
  const gate = outlineGate(task);
  if (mode === 'create' && gate.gate) {
    log('task ' + taskId + '：大纲门生效（' + gate.why + '），本轮只出大纲');
    return runOutlineOnly(ctx, { task, workspace, roll, shared, clientRules, allowedPaths, client, taskId });
  }

  const feedback = latestFeedbackNote(task);
  const basePrompt =
    mode === 'revise'
      ? buildBlogRevisePrompt(Object.assign({}, shared, { currentBody, feedback, slug }))
      : buildBlogPrompt(
          Object.assign({}, shared, {
            fingerprints: fingerprintBlock(prints),
            conflictText: preConflictText,
          })
        );

  const checkCtx = {
    roll,
    allowedPaths,
    categories,
    lang: cfg.blogLang || '',
    keepImages,
    expectImageBriefs: mode !== 'revise',
    lintRules,
  };
  let draft = null;
  let lastErrors = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt =
      attempt === 1
        ? basePrompt
        : basePrompt +
          '\n\n===== 上一版被机器校验打回 =====\n' +
          '你刚才交的那一版没通过校验，问题如下，逐条改掉再交一次完整的 json：\n' +
          lastErrors.map((e, i) => i + 1 + '. ' + e).join('\n') +
          '\n不要只改被点名的地方就交，改完通读一遍确认其他规则没被改坏。';
    log('task ' + taskId + '：第 ' + attempt + ' 次生成，模型 ' + cfg.claudeModel + '，prompt ' + prompt.length + ' 字符');

    const res = await runClaude(cfg, {
      prompt,
      cwd: workspace,
      log,
      model: cfg.claudeModel,
      allowedTools: ALLOWED_TOOLS,
      label: 'blog task ' + taskId + ' #' + attempt,
    });
    const output = String(res.stdout || '').trim();
    if (!output) {
      lastErrors = ['模型没有任何输出'];
      continue;
    }
    const read = readDraftJson(output);
    if (!read.ok) {
      lastErrors = ['产出的 json 块解析失败：' + read.error];
      log('task ' + taskId + '：' + lastErrors[0]);
      continue;
    }
    const verdict = blogcheck.checkDraft(read.draft, checkCtx);
    if (verdict.ok) {
      draft = read.draft;
      log(
        'task ' + taskId + '：机器校验通过，' + verdict.structure.words + ' 词，表格 ' +
          verdict.structure.tables + '，UL ' + verdict.structure.uls + '，H2 ' + verdict.structure.h2Count
      );
      break;
    }
    lastErrors = verdict.errors;
    log('task ' + taskId + '：机器校验未通过（' + verdict.errors.length + ' 项）：' + verdict.errors.join(' | '));
  }

  if (!draft) {
    throw new Error(
      'task ' + taskId + '：两次生成都没通过机器校验，草稿未上平台，任务保持原状。最后一次的问题：' +
        lastErrors.join(' | ')
    );
  }

  // ---- 审稿：一次审，一次定点修，不循环 ----
  let reviewNote = '';
  const review = await reviewDraft(ctx, { draft, clientRules, task, workspace, taskId });
  if (review.verdict === 'revise' && review.issues.length) {
    log('task ' + taskId + '：审稿要求修改 ' + review.issues.length + ' 处：' + review.issues.join(' | '));
    const fixPrompt = basePrompt +
      '\n\n===== 审稿意见（定点修改，其余保持原样）=====\n' +
      '下面是你上一版的完整 json，审稿人要求改这几处。只改被点名的地方，改完交一次完整的 json：\n' +
      review.issues.map((e, i) => i + 1 + '. ' + e).join('\n') +
      '\n\n上一版：\n```json\n' + JSON.stringify(draft) + '\n```';
    try {
      const res = await runClaude(cfg, { prompt: fixPrompt, cwd: workspace, log, model: cfg.claudeModel, allowedTools: ALLOWED_TOOLS, label: 'blog task ' + taskId + ' fix' });
      const read = readDraftJson(String(res.stdout || '').trim());
      if (read.ok) {
        const v2 = blogcheck.checkDraft(read.draft, checkCtx);
        if (v2.ok) {
          draft = read.draft;
          reviewNote = '审稿修改 ' + review.issues.length + ' 处。';
          log('task ' + taskId + '：定点修改后机器校验通过');
        } else {
          reviewNote = '审稿提了 ' + review.issues.length + ' 处，修改版没过校验，沿用修改前版本，意见附在备注。';
          log('task ' + taskId + '：定点修改版没过校验（' + v2.errors.join(' | ') + '），沿用修改前版本');
        }
      } else {
        reviewNote = '审稿提了 ' + review.issues.length + ' 处，修改版解析失败，沿用修改前版本，意见附在备注。';
      }
    } catch (e) {
      reviewNote = '审稿提了 ' + review.issues.length + ' 处，修改调用失败，沿用修改前版本，意见附在备注。';
      log('task ' + taskId + '：定点修改调用失败 :: ' + e.message);
    }
  } else {
    log('task ' + taskId + '：审稿通过' + (review.ok ? '' : '（审稿调用异常，按通过）'));
  }

  // Cannibalisation gate. This one is deliberately not in the retry loop: a
  // slug or a primary term that collides with something already on the site is
  // a problem with the brief, not with the wording, and asking the model to
  // have another go just produces a second article about the same thing under
  // a different name. Fail the job and let a human decide between merging,
  // expanding the existing piece, or picking a genuinely new angle.
  if (reg) {
    const verdict = contentRegistry.checkCollision(
      { slug: draft.slug || slug, keyword: draft.keyword, title: draft.title },
      reg,
      { excludeSlug: mode === 'revise' ? slug : '' }
    );
    if (verdict.blocking) {
      throw new Error(
        'task ' + taskId + '：稿子写完了但和站内内容撞车，草稿未上平台，任务保持原状。\n' +
          contentRegistry.collisionReport(verdict)
      );
    }
    if (verdict.nears.length) {
      log(
        'task ' + taskId + '：撞车检查通过，另有 ' + verdict.nears.length + ' 条近似内容（最高 ' +
          Math.round(verdict.nears[0].score * 100) + '%），不构成打回'
      );
    } else {
      log('task ' + taskId + '：撞车检查通过，站内没有相近主题');
    }
  } else {
    log('task ' + taskId + '：注册表缺失，本轮跳过撞车检查，草稿照常上平台但需要人复核选题');
  }

  // Keep the full draft on disk before touching the platform.
  const outDir = path.join(workspace, OUTPUT_DIRNAME);
  fs.mkdirSync(outDir, { recursive: true });
  const draftFile = path.join(outDir, 'blog-task-' + taskId + '-' + Date.now() + '.md');
  fs.writeFileSync(draftFile, draft.body_markdown, 'utf8');

  const payload = {
    title: draft.title,
    keyword: draft.keyword,
    category: draft.category,
    body: draft.body_markdown,
    excerpt: draft.excerpt,
    meta: { description: draft.meta_description },
  };

  let previewUrl = '';
  let finalSlug = '';
  if (mode === 'revise' && slug) {
    // PATCH does not rotate the preview token, so the link the client already
    // has keeps working. That is the whole reason revisions go through here.
    await client.patchPost(slug, payload);
    const got = await client.getPost(slug);
    previewUrl = String((got && got.previewUrl) || outputUrl);
    finalSlug = slug;
    log('task ' + taskId + '：草稿 ' + slug + ' 已改稿，预览链接不变');
  } else {
    // 上一轮跑到一半失败时草稿可能已经在平台上（同 slug）。有就改它，别再建一篇重复的。
    let existing = null;
    try { const g = await client.getPost(draft.slug); existing = (g && g.post) || null; } catch (e) { existing = null; }
    let created;
    if (existing && String(existing.status || '').toLowerCase() !== 'published') {
      log('task ' + taskId + '：平台上已有同 slug 草稿 ' + draft.slug + '（上一轮遗留），改它不新建');
      await client.patchPost(draft.slug, payload);
      created = await client.getPost(draft.slug);
    } else {
      created = await client.createPost(Object.assign({ slug: draft.slug }, payload));
    }
    const post = (created && created.post) || {};
    finalSlug = String(post.slug || draft.slug);
    previewUrl = String((created && created.previewUrl) || '');
    if (!previewUrl) {
      const got = await client.getPost(finalSlug);
      previewUrl = String((got && got.previewUrl) || '');
    }
    log('task ' + taskId + '：草稿已建，slug ' + finalSlug);
  }
  if (!previewUrl) {
    throw new Error('task ' + taskId + '：平台没有返回 previewUrl，无法交付给客户审阅');
  }

  // ---- 配图工序 ----
  // Runs after the draft exists, because the preview url is what tells us which
  // host serves /assets/, and because a blocked image stage must leave a draft
  // behind for a human rather than nothing at all.
  let imageNote = '';
  let imagesMissing = false;
  if (mode === 'revise') {
    // Deliberately untouched. The mechanical keepImages check already forced the
    // writer to carry every existing picture through, and regenerating images on
    // a copy revision is how a client ends up with a different photo every round.
    // Only this round's brief counts. An images tick three rounds ago was
    // already dealt with and must not keep re-flagging every later revision.
    const wantsImages = /方向：[^\n]*图片/.test(String(feedback || ''));
    if (wantsImages) {
      log(
        'task ' + taskId + '：客户这轮勾了"图片"方向，本流程不做自动重新配图，' +
          '需要人接手判断是换图还是调 alt 与位置，请在看板上认领'
      );
      imageNote = '客户这轮点了图片方向，配图未自动处理，需人工接手。';
    } else {
      log('task ' + taskId + '：改稿轮，配图沿用原稿，未重新生成');
      imageNote = '配图沿用原稿未动。';
    }
  } else {
    const origin = wf.originOf(previewUrl);
    const tmpDir = blogimages.tmpDirFor(workspace, OUTPUT_DIRNAME, taskId);
    let placed = null;
    try {
      placed = await blogimages.runImageStage(
        { cfg, log },
        {
          client,
          workspace,
          tmpDir,
          taskId,
          briefs: draft.image_briefs,
          body: draft.body_markdown,
          keyword: draft.keyword,
          origin,
        }
      );
    } catch (e) {
      // 配图工序本身炸了（FLUX 不通、下载失败之类）。稿子照样交付，图全部标待人工。
      log('task ' + taskId + '：配图工序异常，稿子照常交付，配图全部待人工 :: ' + e.message);
      placed = { body: draft.body_markdown, ogImage: '', heroAlt: '', heroFallback: '', results: [], blocked: [{ slot: 'all', attempts: 0, failures: [{ reasons: [e.message] }] }] };
    } finally {
      blogimages.cleanupTmp(tmpDir, log);
    }

    const meta = { description: draft.meta_description };
    if (placed.ogImage) meta.ogImage = placed.ogImage;
    await client.patchPost(finalSlug, { body: placed.body, meta });
    fs.writeFileSync(draftFile, placed.body, 'utf8');
    const okCount = placed.results.length;
    const total = (draft.image_briefs || []).length || 4;
    const missing = (placed.blocked || []).map((b) => b.slot);
    const retries = placed.results.reduce((n, r) => n + ((r.attempts || 1) - 1), 0);
    const big = placed.results.filter((r) => r.bytes > blogimages.SIZE_WARN_BYTES).map((r) => r.slot);
    log(
      'task ' + taskId + '：配图 ' + okCount + '/' + total + ' 已写回草稿' + (placed.ogImage ? '，封面 ' + placed.ogImage : '，封面缺') +
        (missing.length ? '，缺 ' + missing.join('、') : '') + '，重生成 ' + retries + ' 次'
    );
    imageNote = '配图 ' + okCount + '/' + total + '。' +
      (placed.heroFallback ? '封面用站内素材兜底。' : '') +
      (missing.length ? '缺 ' + missing.join('、') + ' 待人工配图（FLUX 连续 ' + blogimages.MAX_ATTEMPTS + ' 次质检不过，最后原因：' +
        (placed.blocked || []).map((b) => b.slot + ' ' + ((b.failures || []).slice(-1)[0] || {}).reasons).join('；').slice(0, 300) + '）。' : '') +
      (big.length ? '超 200KB：' + big.join('、') + '，发布前需压缩。' : '');
    imagesMissing = missing.length > 0 || !placed.ogImage;
  }

  const social = String(draft.social_message).split(blogcheck.PREVIEW_TOKEN).join(previewUrl);
  const summary =
    '写了 ' + (draft.keyword || draft.title) + ' 主题，骨架 ' + roll.skeleton.label +
    '，' + (mode === 'revise' ? '按客户反馈改稿' : '新建草稿') +
    '，分类 ' + draft.category + '。' + imageNote + reviewNote;

  const note = [
    '预览链接：' + previewUrl,
    '客户话术：',
    SOCIAL_OPEN,
    social,
    SOCIAL_CLOSE,
    '要点：' + summarize(summary, 400),
    (review.verdict === 'revise' && review.issues.length && !/审稿修改/.test(reviewNote)) ? '审稿意见（未能自动落实）：' + review.issues.join('；') : '',
  ].filter(Boolean).join('\n');

  // Anything the pass left in the task's deliverable directory goes up before
  // the result, so the card and its downloads appear together.
  await deliverables.uploadTaskDeliverables(ctx, taskId, workspace);
  // 图没齐就打 attention：稿子进待放行，但人得先补图，发布门会拦。
  await api.postTaskResult(taskId, { output_url: previewUrl, note, attention: imagesMissing });
  log('task ' + taskId + '：已交付，任务进 review 等人转发客户' + (imagesMissing ? '（配图不齐，已标需人判断）' : ''));
  return draftFile;
}

/** 大纲门那一轮：只出大纲，存成交付文件，任务进待放行等客户回批。 */
async function runOutlineOnly(ctx, opts) {
  const { cfg, api, log } = ctx;
  const { task, workspace, roll, shared, clientRules, allowedPaths, taskId } = opts;
  const prompt = buildOutlinePrompt({
    task, roll, siteBlock: shared.siteBlock, facts: shared.facts, clientRules,
    registryText: shared.registryText, sop: shared.sop, allowedPaths,
  });
  log('task ' + taskId + '：出大纲，模型 ' + cfg.claudeModel + '，prompt ' + prompt.length + ' 字符');
  const res = await runClaude(cfg, { prompt, cwd: workspace, log, model: cfg.claudeModel, allowedTools: ALLOWED_TOOLS, label: 'blog outline ' + taskId });
  const parsed = extractTrailingJson(String(res.stdout || '').trim());
  if (parsed.error || !parsed.json || !parsed.json.outline_markdown) {
    throw new Error('task ' + taskId + '：大纲 json 解析失败或缺 outline_markdown：' + (parsed.error || ''));
  }
  const o = parsed.json;
  const outDir = path.join(workspace, OUTPUT_DIRNAME, 'task-' + taskId);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'outline-task-' + taskId + '.md');
  const qs = Array.isArray(o.questions_for_client) ? o.questions_for_client : [];
  fs.writeFileSync(file, [
    '# ' + String(o.title || task.title),
    '',
    'keyword: ' + String(o.keyword || ''),
    'slug: ' + String(o.slug || ''),
    'category: ' + String(o.category || ''),
    'style: ' + styleroll.rollSummary(roll),
    '',
    String(o.outline_markdown),
    '',
    qs.length ? '## 需客户确认\n' + qs.map((q) => '- ' + q).join('\n') : '',
  ].join('\n'), 'utf8');
  await deliverables.uploadTaskDeliverables(ctx, taskId, workspace);
  const social = String(o.social_message || '').split(blogcheck.PREVIEW_TOKEN).join('（大纲见附件）');
  const note = [
    '大纲已出（交付文件 outline-task-' + taskId + '.md），等客户回批。',
    '客户话术：', SOCIAL_OPEN, social, SOCIAL_CLOSE,
    qs.length ? '需客户确认：' + qs.join('；') : '',
    '回批通过后，在线程里说「大纲已批，写正文」，会带着这句重跑出正文。',
  ].filter(Boolean).join('\n');
  await api.postTaskResult(taskId, { output_url: '', note, attention: false });
  log('task ' + taskId + '：大纲已交付，任务进 review 等客户回批');
  return file;
}

// A key like gbp.status: a namespace, a dot, then at least one segment.
const FACT_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const KNOWN_NAMESPACES = ['gbp', 'product', 'policy', 'local'];

/**
 * Pull the facts block out of a task reply.
 *
 * The deliverable itself can legitimately end with a json block, so a block only
 * counts as facts when it is an object carrying a facts array. Anything else is
 * left alone. Parsing problems are logged and never touch the task result.
 */
function extractFacts(text, log) {
  const parsed = extractTrailingJson(text);
  if (parsed.error) {
    // No block at all is the normal case and not worth a line. A malformed one is.
    if (parsed.error.indexOf('did not parse') !== -1) {
      log('facts: trailing json block did not parse, no facts recorded :: ' + parsed.error);
    }
    return [];
  }
  const json = parsed.json;
  if (!json || typeof json !== 'object' || !Array.isArray(json.facts)) {
    return [];
  }
  const out = [];
  for (const raw of json.facts) {
    const item = raw || {};
    const key = String(item.key || item.fact_key || '').trim().toLowerCase();
    let value = item.value;
    if (!FACT_KEY_RE.test(key)) {
      log('facts: skipping "' + truncate(String(item.key), 60) + '", not a namespaced lower case key');
      continue;
    }
    if (value === undefined || value === null || value === '') {
      log('facts: skipping "' + key + '", empty value');
      continue;
    }
    if (typeof value === 'object') value = JSON.stringify(value);
    value = truncate(String(value).trim(), 2000);
    if (!KNOWN_NAMESPACES.includes(key.split('.')[0])) {
      log('facts: "' + key + '" uses an unusual namespace, recording it anyway for review');
    }
    out.push({ key, value });
  }
  return out;
}

/** Record verified facts. Never fails the task, the deliverable is what matters. */
async function recordFacts(ctx, taskId, text) {
  const { job, api, log } = ctx;
  let facts = [];
  try {
    facts = extractFacts(text, log);
  } catch (e) {
    log('facts: extraction failed, ignoring :: ' + e.message);
    return 0;
  }
  if (!facts.length) return 0;

  log('facts: ' + facts.length + ' proposed by task ' + taskId);
  let stored = 0;
  for (const fact of facts) {
    try {
      const res = await api.postFact(job.client_id, fact.key, fact.value);
      const skipped = !!(res && (res.skipped || res.skipped_confirmed));
      if (skipped) {
        log('facts: ' + fact.key + ' skipped, a confirmed value is already on record');
      } else {
        stored += 1;
        log('facts: ' + fact.key + ' = ' + truncate(fact.value, 120) + ' stored as unconfirmed');
      }
    } catch (e) {
      log('facts: ' + fact.key + ' FAILED to store :: ' + e.message);
    }
  }
  return stored;
}

async function runOne(ctx, context, workspace, taskId) {
  const { cfg, api, log, job } = ctx;
  const profile = (context && context.profile) || {};
  const task = findTask(context, taskId);
  if (!task) {
    throw new Error('task ' + taskId + ' not found in context for client_id ' + job.client_id);
  }
  const platform = profile.platform || profile.cms || null;
  const allOps = taskOps(task);

  // Blog mode wins over prepare and analysis. A blog task produces an unpublished
  // draft, which nobody outside the team can see, so it is agent_apply rather
  // than a change plan. The manifest still has the last word: if it does not
  // clear blog-draft for this platform, fall through to the normal branches.
  if (allOps.indexOf(BLOG_OP) !== -1) {
    const level = platform ? capabilities.autonomyOf(platform, BLOG_OP) : null;
    if (level === 'agent_apply') {
      return runBlogTask(ctx, context, workspace, task);
    }
    log(
      'task ' + taskId + '：带 ' + BLOG_OP + ' 但平台清单里它是 ' + (level || '未登记') +
        '，不走博客模式，退回常规处理'
    );
  }

  // Only operations the manifest cleared for an agent put a task into prepare
  // mode. An unknown op is not a licence, and a human_only op is a hard no even
  // when someone hand edited it onto the task in the board.
  const ops = platform
    ? allOps.filter((op) => {
        const level = capabilities.autonomyOf(platform, op);
        return level === 'agent_apply' || level === 'agent_prepare';
      })
    : [];
  const stripped = allOps.filter((op) => ops.indexOf(op) === -1);
  for (const op of stripped) {
    const level = platform ? capabilities.autonomyOf(platform, op) : null;
    log(
      'task ' +
        taskId +
        ': op "' +
        op +
        '" ' +
        (level === 'agent_readonly'
          ? 'is read only, running in analysis mode with no change plan'
          : 'ignored, ' +
            (level === 'human_only' ? 'it is human_only and an agent never runs it' : 'not in the platform manifest'))
    );
  }
  const prepare = ops.length > 0;

  log(
    'task ' +
      taskId +
      ': "' +
      (task.title || '(untitled)') +
      '" starting in ' +
      (prepare ? 'prepare mode, ops ' + ops.join(', ') : 'analysis mode, no ops') +
      (stripped.length ? ' (ignored: ' + stripped.join(', ') + ')' : '')
  );

  const outDir = path.join(workspace, OUTPUT_DIRNAME);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  let prompt;
  let file;
  if (prepare) {
    file = path.join(outDir, CHANGE_PLAN_PREFIX + taskId + '.md');
    const credPath = credentialsPath(workspace, platform);
    if (!fs.existsSync(credPath)) {
      // Not fatal at prepare time, the agent only reads. It matters at apply.
      log('task ' + taskId + ': credentials file not found at ' + credPath + ', the plan must call that out');
    }
    prompt = buildPreparePrompt({
      task,
      brief: buildBrief(context, { includeTasks: false }),
      workspace,
      platform,
      ops,
      credPath,
      planFile: file,
    });
  } else {
    file = path.join(outDir, 'task-' + taskId + '-' + stamp + '.md');
    prompt = buildPrompt(buildBrief(context, { includeTasks: false }), task, workspace);
  }

  const res = await runClaude(cfg, {
    prompt,
    cwd: workspace,
    log,
    model: cfg.claudeModel,
    allowedTools: ALLOWED_TOOLS, // read only plus curl, and the prompt pins curl to GET
    label: 'task ' + taskId,
  });

  const output = String(res.stdout || '').trim();
  if (!output) throw new Error('task ' + taskId + ': claude produced no output');

  // Keep the full text on disk. The API note only carries a short summary.
  // The change plan filename is stable on purpose: apply_task looks it up by id.
  fs.writeFileSync(file, output, 'utf8');
  log('task ' + taskId + ': ' + (prepare ? 'change plan' : 'output') + ' saved to ' + file);

  if (prepare) {
    const missing = missingPlanSections(output);
    const lint = missing.length ? [] : lintPlan(output);
    if (lint.length) {
      // 和缺章节同一待遇：不 post result，任务留在 approved，job 判红并把问题写清楚，
      // 人在卡上看到「执行失败：方案 lint 未过：...」就知道该在线程里让它重出。
      throw new Error('task ' + taskId + ': 方案 lint 未过，打回重出：' + lint.join('；'));
    }
    if (missing.length) {
      // Do not post a result: posting flips the task to review, which is the
      // releasable state, and a structurally broken plan must never be
      // releasable. The failed job lands in the attention queue instead.
      throw new Error(
        'task ' + taskId + ': 变更方案缺少章节 ' + missing.join('、') + '，方案不合格，任务未进入待放行，需重跑 prepare'
      );
    }
  }

  const note = prepare
    ? buildTargetHeader(readTargetUrls(output)) +
      '变更方案已生成，待人工放行后由 apply_task 执行。方案文件 ' +
      path.basename(file) +
      '。摘要：' +
      summarize(output, 400)
    : summarize(output, 500);
  // Deliverables before the result: by the time the card shows up on the board
  // its downloads are already attached to it.
  await deliverables.uploadTaskDeliverables(ctx, taskId, workspace);
  await api.postTaskResult(taskId, { output_url: '', note });
  log(
    'task ' +
      taskId +
      ': result posted' +
      (prepare ? ', task left for review, nothing on the site has changed' : '')
  );

  // Facts come after the result, so a facts problem can never cost the result.
  await recordFacts(ctx, taskId, output);
  return file;
}

async function run(ctx) {
  const { job, api, log } = ctx;
  const payload = job.payload || {};
  const taskIds = Array.isArray(payload.task_ids) ? payload.task_ids : [];
  if (!taskIds.length) throw new Error('execute_task job has no payload.task_ids');
  log('executing ' + taskIds.length + ' task(s): ' + taskIds.join(', '));

  const context = await api.getContext(job.client_id);
  const profile = (context && context.profile) || null;
  if (!profile) throw new Error('context returned no profile for client_id ' + job.client_id);

  const workspace = ensureClientWorkspace(profile, ctx.cfg);
  log('workspace: ' + workspace);

  const failures = [];
  for (const taskId of taskIds) {
    try {
      await runOne(ctx, context, workspace, taskId);
    } catch (e) {
      // Keep going so one bad task does not block the rest, but the job still
      // ends as failed so a human sees it.
      log('task ' + taskId + ': FAILED :: ' + (e.stack || e.message));
      failures.push(taskId + ': ' + e.message);
    }
  }

  if (failures.length) {
    throw new Error(
      failures.length + ' of ' + taskIds.length + ' task(s) failed :: ' + failures.join(' | ')
    );
  }
  return { tokenUsage: 0 };
}

module.exports = {
  run,
  lintPlan,
  planFiles,
  planCallSection,
  clientRulesBlock,
  outlineGate,
  buildOutlinePrompt,
  PLAN_FORBIDDEN_PATHS,
  buildPrompt,
  buildPreparePrompt,
  taskOps,
  credentialsPath,
  readTargetUrls,
  buildTargetHeader,
  extractFacts,
  recordFacts,
  ALLOWED_TOOLS,
  CHANGE_PLAN_PREFIX,
  // blog mode
  runBlogTask,
  buildBlogPrompt,
  buildBlogRevisePrompt,
  blogOutputContract,
  imageBriefContract,
  blogHardRules,
  loadSop,
  sopForPrompt,
  sopSections,
  sopSectionFor,
  allowedPathsFrom,
  categorySlugs,
  sortPostsNewestFirst,
  fingerprint,
  fingerprintBlock,
  latestFeedbackNote,
  readDraftJson,
  blogRegistry,
  taskCandidate,
  registryPromptBlock,
  BLOG_OP,
  SOP_FILE,
  SOCIAL_OPEN,
  SOCIAL_CLOSE,
};
