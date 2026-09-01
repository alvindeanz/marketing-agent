'use strict';
// report runner：月报三层的调度。
//
//   1. 数据层 lib/factspack.js   零 LLM，产出 facts pack，所有数字只在那里出现
//   2. 叙事层 本文件             一次 LLM 加至多一次纠错，只写文字
//   3. 渲染层 lib/reporthtml.js  零 LLM，模板拼 HTML，跑内置 lint
//
// 三层防线（CLAUDE.md 硬规矩第 4 条）：
//   第一层 prompt 里写死铁律加自检字段；
//   第二层 数字校验或禁词命中就同 job 内回喂一次；
//   第三层 两轮都不行就降级成纯数据版，narrative_status=fallback，job 不算失败。
//
// 什么情况该让 job 失败，什么情况不该，边界是死的：
//   取数失败、渲染断言失败、发布失败  ->  抛错，job failed
//   叙事失败                          ->  降级，job done

const fs = require('node:fs');
const path = require('node:path');

const { runClaude } = require('../lib/llm');
const { extractTrailingJson } = require('../lib/mdjson');
const { ensureClientWorkspace, clientDirName, localYmd, truncate } = require('../lib/util');
const { buildFactsPack, computePeriod } = require('../lib/factspack');
const { renderReport, KPI_DEFS } = require('../lib/reporthtml');
const { lintText, lintReport, numbersFromPack, checkNumbers, problemList } = require('../lib/reportlint');
const { publishReport } = require('../lib/publish');

const OUTPUT_DIRNAME = 'seo-agent-output';
// 叙事层不需要动手，给一个最小工具集，省得它去翻仓库。
const ALLOWED_TOOLS = 'Read';
// GSC 的数据延迟，月中出报时本期末尾要往回让这么多天。
const GSC_LAG_DAYS = 3;

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

/** prompt 开头的身份与铁律，原文出自 specs/report/prompt_contract.md。 */
function headerBlock(pack) {
  const meta = pack.meta;
  const lines = [
    '你是一家新西兰数字营销公司的 SEO 客户经理，为下面这个客户写 ' + meta.period.label + ' 的 SEO 月报叙事。',
    '读者是客户老板，不懂技术。报告数字已经由系统算好（DATA PACK），你只写解读与计划，一次写完，无人答疑。',
    '',
    '铁律：',
    '1. 只能引用 DATA PACK 里出现的数字，原样引用，不换算、不四舍五入成新数、不估算。PACK 里没有的指标写「本期未统计」。',
    '2. 排名数值变小一律写「提升 N 位」「前进」，禁用「收紧」「收窄」「压缩」。',
    '3. 全文禁用 em dash、en dash、前后带空格的连字符，用逗号、冒号、括号或「至」。禁用 emoji。',
    '4. 不出现工具名（统称「keyword research」）、不出现网站后台名与后台操作、不出现 AI 字样、不出现 W 编号、不出现「口径」二字（改「统计说明」）。',
    '5. 不出现内部黑话（钱页、重爬、硬塞、裸名、冷启动、蓄水、复盘、死件）。',
    '6. 不写绝对化（永远、唯一、只有、没人）、不承诺具体排名或数值结果、建议必须是我方可执行的。',
    '7. 反向指标不藏、不淡化、不甩外因，每个坏消息紧跟一条下月可执行的抓手。',
    '8. 工作内容写成果不写过程：写「优化了 N 个页面」，不写任务编号、脚本、模型。',
    '9. 统一用「询盘」不用「线索」；语言按 ' + meta.report_lang + '（zh 写中文，en 写英文）。',
    '10. 这份报告是向客户汇报工作的：本月做了什么要写足写具体，数据变化要与我方动作对应起来说，让客户看到投入和成果。',
  ];
  if (meta.period.partial) {
    lines.push(
      '11. 本期是月中出报，全文必须写明「截至 ' + meta.period.through_day + ' 日，本月尚未结束」，环比只与上月同一时段比，不做同比。'
    );
  }
  return lines.join('\n');
}

/** 客户专属禁区，逐条列给模型。 */
function factsBlock(pack) {
  const facts = pack.facts_for_prompt || [];
  if (!facts.length) return '客户专属事实：暂无记录，凡是 PACK 里没有的客户情况一律不要写。';
  return ['客户专属事实与禁区，逐条遵守：'].concat(facts.map((f) => '- ' + f)).join('\n');
}

/** 输出 schema 说明，字数区间与固定槽位照 prompt_contract.md。 */
function schemaBlock() {
  return [
    '输出要求：只回一个 json 代码块，块外一个字都不要有。结构如下。',
    '```json',
    '{',
    '  "hero_headline": "不超过 16 个中文字，本月最强的正向信号",',
    '  "hero_kpi_keys": ["从 allowed_kpi_keys 里挑 4 个，优先正向指标"],',
    '  "ga4_sdesc": "80 至 140 字，数据来源、周期、环比对齐、一句总体走向",',
    '  "ga4_callouts": [{"tone":"green","title":"本月信号","body":"150 至 260 字"},{"tone":"yellow","title":"需留意","body":"100 至 180 字"}],',
    '  "channels_sdesc": "40 至 80 字",',
    '  "channels_callout": {"tone":"blue","title":"","body":"180 至 300 字"},',
    '  "funnel_sdesc": "50 至 90 字",',
    '  "funnel_callouts": [{"tone":"green","title":"关键改善","body":"120 至 200 字"},{"tone":"yellow","title":"需观察","body":"120 至 200 字"}],',
    '  "rankings_sdesc": "100 至 180 字，含目标词数、加权算法说明、三档配色图例、本月无曝光的解释",',
    '  "rankings_callouts": [{"tone":"green","title":"排名亮点","body":"180 至 320 字"},{"tone":"yellow","title":"需关注","body":"150 至 280 字"}],',
    '  "pages_sdesc": "30 至 60 字",',
    '  "pages_callouts": [{"tone":"green","title":"领涨页面","body":"150 至 280 字"},{"tone":"yellow","title":"回落页面","body":"100 至 200 字"}],',
    '  "work_sdesc": "30 至 60 字",',
    '  "work_items": [{"category":"onpage","title":"12 至 30 字","body":"60 至 120 字"}],',
    '  "next_items": [',
    '    {"slot":1,"priority":"P1","title":"","body":"120 至 220 字","urls":[]},',
    '    {"slot":2,"priority":"P2","title":"","body":"50 至 110 字"},',
    '    {"slot":3,"priority":"P3","title":"","body":"50 至 110 字"},',
    '    {"slot":4,"priority":"P4","title":"站点健康检查","body":"50 至 110 字"},',
    '    {"slot":5,"priority":"P5","title":"数据监督与报告交付","body":"50 至 110 字"}',
    '  ],',
    '  "self_check": {"numbers_all_from_pack": true, "no_banned_words": true, "callouts_paired": true}',
    '}',
    '```',
    'work_items 是这份报告的重点：客户要看到我方本月做了什么。把 DATA PACK 的 work.items 按分类整理成 3 至 8 条，每一条原始动作都要有归宿不得漏项，每条写清对象与数量（改了哪些页、发了几篇、修了什么、交付了什么），成果与投入并列。分类只能取 onpage、content、link、tech、ads（广告账户操作）、report，内部速记要改写成客户面表达。',
    '成对 callout 必须两条都给。排名亮点里的「旧位次 → 新位次（差值，曝光数）」只能取 narrative_inputs.ranking_highlights 里的行。',
    'DATA PACK 里若有 yoy 节点（去年同月对照），ga4_sdesc 或 ga4_callouts 里补一句同比走向，数字照抄 yoy 节点，不自行换算；yoy 为 null 时全文不提同比。',
    'next_items 第一槽的 urls 只能取 DATA PACK 里出现过的路径。',
  ].join('\n');
}

/** 给模型看的 pack。去掉纯内部追溯字段，其余原样。 */
function packForPrompt(pack) {
  const copy = JSON.parse(JSON.stringify(pack));
  delete copy.pack_inputs;
  if (copy.work && Array.isArray(copy.work.items)) copy.work.items = copy.work.items.slice(0, 40);
  if (copy.gsc && Array.isArray(copy.gsc.top_queries)) copy.gsc.top_queries = copy.gsc.top_queries.slice(0, 20);
  return copy;
}

function buildPrompt(pack) {
  return [
    headerBlock(pack),
    '',
    factsBlock(pack),
    '',
    'allowed_kpi_keys: ' + Object.keys(KPI_DEFS).join('、'),
    '',
    'DATA PACK（唯一数字来源）：',
    '```json',
    JSON.stringify(packForPrompt(pack), null, 1),
    '```',
    '',
    schemaBlock(),
  ].join('\n');
}

function fixPrompt(problems, lastOutput) {
  return [
    '你上一轮输出的 json 有以下问题：',
    problems.map((p, i) => i + 1 + '. ' + p).join('\n'),
    '重新输出完整 json，只修这些问题，其余内容保持不变。你的回复只允许是一个 json 代码块，块外一个字都不要有。',
    '',
    '=====',
    truncate(String(lastOutput || ''), 12000),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 叙事校验
// ---------------------------------------------------------------------------

/** 把叙事 JSON 里所有会印到报告上的文字串起来，供禁词与数字校验用。 */
function narrativeText(n) {
  const parts = [];
  const push = (v) => {
    if (typeof v === 'string') parts.push(v);
  };
  if (!n || typeof n !== 'object') return '';
  push(n.hero_headline);
  for (const k of ['ga4_sdesc', 'channels_sdesc', 'funnel_sdesc', 'rankings_sdesc', 'pages_sdesc', 'work_sdesc']) push(n[k]);
  const eachCallout = (list) => {
    const arr = Array.isArray(list) ? list : list ? [list] : [];
    for (const c of arr) {
      if (!c) continue;
      push(c.title);
      push(c.body);
    }
  };
  eachCallout(n.ga4_callouts);
  eachCallout(n.channels_callout);
  eachCallout(n.funnel_callouts);
  eachCallout(n.rankings_callouts);
  eachCallout(n.pages_callouts);
  for (const w of Array.isArray(n.work_items) ? n.work_items : []) {
    if (!w) continue;
    push(w.title);
    push(w.body);
  }
  for (const w of Array.isArray(n.next_items) ? n.next_items : []) {
    if (!w) continue;
    push(w.title);
    push(w.body);
  }
  return parts.join('\n');
}

/** pack 里出现过的全部路径，用来剔掉模型臆造的 URL。 */
function knownPaths(pack) {
  const set = new Set();
  for (const p of (pack.ga4 && pack.ga4.landing_pages) || []) if (p && p.path) set.add(String(p.path));
  for (const p of (pack.gsc && pack.gsc.zero_exposure_pages) || []) set.add(String(p));
  for (const t of (pack.next && pack.next.tasks) || []) {
    const m = String((t && t.detail) || '').match(/\/[A-Za-z0-9\-_/]+\//g);
    for (const u of m || []) set.add(u);
  }
  return set;
}

/** 校验一轮叙事。返回问题清单，空数组代表可用。 */
function validateNarrative(n, allowedNumbers) {
  const problems = [];
  if (!n || typeof n !== 'object') return ['输出不是一个 json 对象'];
  const text = narrativeText(n);
  if (!text.trim()) return ['json 里没有任何叙事文字'];
  const lint = lintText(text);
  const nums = checkNumbers(text, allowedNumbers);
  problems.push.apply(problems, problemList(lint.hits, nums.bad));
  // 成对 callout 缺一条不算致命，渲染层会把两列降成单列，只提醒不回喂。
  return problems;
}

/** 剔掉不在 pack 里的 URL，这一步不回喂，直接改数据。 */
function stripUnknownUrls(n, pack, log) {
  if (!n || !Array.isArray(n.next_items)) return;
  const known = knownPaths(pack);
  for (const item of n.next_items) {
    if (!item || !Array.isArray(item.urls)) continue;
    const before = item.urls.length;
    item.urls = item.urls.filter((u) => known.has(String(u)));
    if (item.urls.length !== before && log) {
      log('叙事里有 ' + (before - item.urls.length) + ' 个 pack 之外的路径，已剔除');
    }
  }
}

// ---------------------------------------------------------------------------
// 周期与版本
// ---------------------------------------------------------------------------

/** 没给 period_start 时，默认上一个完整自然月。 */
function defaultPeriodStart(today) {
  const m = /^(\d{4})-(\d{2})/.exec(String(today));
  if (!m) throw new Error('拿不到今天的日期，无法推默认周期');
  let y = Number(m[1]);
  let mm = Number(m[2]) - 1;
  if (mm < 1) {
    mm = 12;
    y -= 1;
  }
  return y + '-' + String(mm).padStart(2, '0') + '-01';
}

/** 同客户同周期已有的最大版本号加一。取不到就当第一版。 */
async function nextVersionHint(api, clientId, periodType, periodStart, log) {
  try {
    const res = await api.listReports(clientId);
    const rows = (res && res.reports) || [];
    let max = 0;
    for (const r of rows) {
      if (String(r.period_type) !== periodType) continue;
      if (String(r.period_start).slice(0, 10) !== periodStart) continue;
      max = Math.max(max, Number(r.version) || 0);
    }
    return max + 1;
  } catch (e) {
    if (log) log('取历史版本失败，按第一版处理：' + e.message);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function run(ctx) {
  const { job, cfg, api, log } = ctx;
  const payload = job.payload || {};

  const context = await api.getContext(job.client_id);
  const profile = (context && context.profile) || null;
  if (!profile) throw new Error('context returned no profile for client_id ' + job.client_id);

  const workspace = ensureClientWorkspace(profile, cfg);
  const slug = clientDirName(profile, cfg);
  const today = localYmd();

  const period = computePeriod({
    type: String(payload.period_type || 'month'),
    start: payload.period_start || defaultPeriodStart(today),
    end: payload.period_end || null,
    today,
    lagDays: GSC_LAG_DAYS,
  });
  log(
    '报告周期 ' + period.start + ' 至 ' + period.end + '（' + period.label + '），对比 ' +
      period.compare.start + ' 至 ' + period.compare.end
  );

  const versionHint = await nextVersionHint(api, job.client_id, period.type, period.start, log);
  log('版本号先按 v' + versionHint + ' 起名，最终以服务端返回的为准');

  // ---- 第一层：数据 ----
  const pack = await buildFactsPack(ctx, profile, context, period, {
    workspace,
    slug,
    instructions: payload.instructions || '',
    versionHint,
  });
  if (pack.gaps && pack.gaps.length) log('数据缺口 ' + pack.gaps.length + ' 条：' + pack.gaps.join('；'));

  // ---- 第二层：叙事 ----
  let narrative = null;
  let narrativeStatus = 'fallback';
  let narrativeNote = '';
  const allowedNumbers = numbersFromPack(pack);
  try {
    const prompt = buildPrompt(pack);
    log('叙事 prompt ' + prompt.length + ' 字符，模型 ' + cfg.reportModel);
    let res = await runClaude(cfg, {
      prompt,
      cwd: workspace,
      log,
      model: cfg.reportModel,
      allowedTools: ALLOWED_TOOLS,
      label: 'report ' + period.start,
      timeoutMs: (Number(cfg.reportTimeoutMin) || 45) * 0.5 * 60 * 1000,
    });
    let output = String(res.stdout || '').trim();
    let parsed = extractTrailingJson(output);
    let problems = parsed.json ? validateNarrative(parsed.json, allowedNumbers) : [parsed.error || 'json 块不是对象'];

    if (problems.length) {
      log('叙事第一轮有 ' + problems.length + ' 个问题，回喂纠错一次：' + problems.slice(0, 5).join(' | '));
      res = await runClaude(cfg, {
        prompt: fixPrompt(problems, output),
        cwd: workspace,
        log,
        model: cfg.reportModel,
        allowedTools: ALLOWED_TOOLS,
        label: 'report ' + period.start + ' fix',
        timeoutMs: (Number(cfg.reportTimeoutMin) || 45) * 0.3 * 60 * 1000,
      });
      output = String(res.stdout || '').trim();
      parsed = extractTrailingJson(output);
      problems = parsed.json ? validateNarrative(parsed.json, allowedNumbers) : [parsed.error || 'json 块不是对象'];
    }

    if (problems.length) {
      narrativeNote = '叙事两轮仍不合格（' + problems.slice(0, 3).join('；') + '），本版为纯数据版';
      log(narrativeNote);
    } else {
      narrative = parsed.json;
      stripUnknownUrls(narrative, pack, log);
      narrativeStatus = 'ok';
      log('叙事通过数字校验与禁词检查');
    }
  } catch (e) {
    // 叙事这一层坏掉不许把 job 拖挂：报告降级成纯数据版照样交得出去。
    narrativeNote = '叙事生成失败（' + String(e.message || e).slice(0, 200) + '），本版为纯数据版';
    log(narrativeNote);
  }

  // ---- 第三层：渲染 ----
  let html = renderReport(pack, narrative, {});
  let lint = lintReport(html);
  if (!lint.ok && narrative) {
    log('成品 lint 命中 ' + lint.hits.length + ' 条，降级成纯数据版重渲染：' + lint.hits.map((h) => h.rule).join('、'));
    narrative = null;
    narrativeStatus = 'fallback';
    narrativeNote = '叙事文字未通过发布前检查（' + lint.hits.map((h) => h.rule).join('、') + '），本版为纯数据版';
    html = renderReport(pack, null, {});
    lint = lintReport(html);
  }
  if (!lint.ok) {
    // 纯数据版都过不了 lint，说明模板或渲染层出了问题，这必须让 job 失败。
    throw new Error(
      '报告渲染后仍未通过发布前检查：' + lint.hits.map((h) => h.rule + '（' + h.sample + '）').join('；')
    );
  }

  // ---- 落盘 ----
  const ym = period.start.slice(0, 7);
  const outDir = path.join(workspace, OUTPUT_DIRNAME);
  fs.mkdirSync(outDir, { recursive: true });
  let localHtml = path.join(outDir, 'report-' + ym + '-v' + versionHint + '.html');
  let localPack = path.join(outDir, 'report-' + ym + '-v' + versionHint + '.pack.json');
  fs.writeFileSync(localHtml, html, 'utf8');
  fs.writeFileSync(localPack, JSON.stringify(pack, null, 1), 'utf8');
  log('成品写入 ' + localHtml);

  // ---- 发布 ----
  const filename = 'seo_report_' + ym + '_v' + versionHint + '.html';
  const published = await publishReport(cfg, slug, filename, localHtml, log);

  // ---- 落库 ----
  const noteParts = [];
  if (narrativeNote) noteParts.push(narrativeNote);
  if (pack.gaps && pack.gaps.length) noteParts.push('数据缺口：' + pack.gaps.join('；'));
  const saved = await api.postReport({
    client_id: job.client_id,
    period_type: period.type,
    period_start: period.start,
    period_end: period.end,
    url: published.url,
    html_path: published.remotePath,
    facts_pack: pack,
    narrative_status: narrativeStatus,
    note: truncate(noteParts.join(' / '), 900),
  });
  const finalVersion = Number(saved && saved.version) || versionHint;
  if (finalVersion !== versionHint) {
    // 服务端的版本号才算数，本地副本改名对齐；远端文件名保留起名时那个，
    // 落库的 url 指向的就是它，链接照样有效。
    const renamedHtml = path.join(outDir, 'report-' + ym + '-v' + finalVersion + '.html');
    const renamedPack = path.join(outDir, 'report-' + ym + '-v' + finalVersion + '.pack.json');
    try {
      fs.renameSync(localHtml, renamedHtml);
      fs.renameSync(localPack, renamedPack);
      localHtml = renamedHtml;
      localPack = renamedPack;
    } catch (e) {
      log('本地副本改名失败，不影响交付：' + e.message);
    }
    log('服务端版本号为 v' + finalVersion + '，本地副本已改名，远端文件名保持 ' + filename);
  }

  // 服务端落库时会把反馈参数（?r=&k=）拼进 url，交付用它；拿不到再退回裸链接。
  const finalUrl = (saved && saved.url) || published.url;
  log('报告 v' + finalVersion + ' 完成，链接 ' + finalUrl);
  return { tokenUsage: 0 };
}

module.exports = {
  run,
  buildPrompt,
  headerBlock,
  factsBlock,
  schemaBlock,
  fixPrompt,
  narrativeText,
  validateNarrative,
  stripUnknownUrls,
  knownPaths,
  defaultPeriodStart,
  nextVersionHint,
  packForPrompt,
};
