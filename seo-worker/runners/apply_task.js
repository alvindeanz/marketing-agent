'use strict';
// apply_task runner: execute a change plan a human already approved.
//
// This is the only runner that writes to a live site, so the rules are narrow
// on purpose:
//   the approved change plan file is the only source of truth
//   nothing outside that plan may be called
//   a response that does not match what the plan predicted means stop, not adapt
//   the task is only completed after the plan's own verification steps pass
//
// A task that aborts stays in review with the reason in its note. Nothing is
// retried automatically, because a half applied change is a human's problem.

const fs = require('node:fs');
const path = require('node:path');

const { runClaude } = require('../lib/llm');
const capabilities = require('../lib/capabilities');
const wf = require('../lib/webforger');
const { extractTrailingJson } = require('../lib/mdjson');
const deliverables = require('../lib/deliverables');
const { publishFile } = require('../lib/publish');
const { ensureClientWorkspace, clientDirName, summarize, truncate, localYmd } = require('../lib/util');

const ALLOWED_TOOLS = 'Read,Glob,Grep,WebFetch,Bash(curl:*)';
const OUTPUT_DIRNAME = 'seo-agent-output';
const CHANGE_PLAN_PREFIX = 'change-plan-task-';
const STATUSES = ['success', 'aborted', 'failed'];
const BLOG_OPS = ['blog-draft', 'blog-publish'];

/** Same shape as execute_task's helper. Kept local so runners stay independent. */
function taskOps(task) {
  const raw = (task && task.ops) || '';
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return list.map((o) => String(o || '').trim().toLowerCase()).filter(Boolean);
}

function changePlanPath(workspace, taskId) {
  return path.join(workspace, OUTPUT_DIRNAME, CHANGE_PLAN_PREFIX + taskId + '.md');
}

function findTask(context, taskId) {
  const tasks = (context && Array.isArray(context.tasks) && context.tasks) || [];
  return tasks.find((t) => String(t.id) === String(taskId)) || null;
}

function buildPrompt(opts) {
  const { task, plan, planFile, workspace, platform, credPath } = opts;
  return [
    '你是一家新西兰数字营销公司的 SEO 执行 agent，现在处于 apply 阶段。',
    '下面这份变更方案**已经过人工审批**。你的工作只有一件：严格照着它执行，然后自验。',
    '',
    '铁律，任何情况下都不许突破',
    '1. **只准执行方案里写明的调用。** 方案之外的任何写操作一律不许发，哪怕你觉得顺手、',
    '   哪怕你认为方案漏了一步、哪怕只是"顺便修一下"。方案没写就是不许做。',
    '2. **响应与方案预期不符，立刻中止。** 不许换参数重试，不许改路径试探，不许自行推断',
    '   替代方案。停下来，把已经执行到第几步、实际响应是什么、和预期差在哪里写清楚。',
    '3. **不许改方案。** 你不是来优化方案的。方案有问题就中止并报告，让人重新审。',
    '4. 看到 401 停下报告，token 失效重试没有意义。看到 403 停下报告，不许换 payload 试。',
    '   看到 429 按响应里的 retryAfter 退避，没有就退 60 秒，最多等一次，再不行就中止。',
    '5. **凭据严禁出现在你的输出里。** 不许把 token、密码、完整 Authorization 头写进',
    '   执行记录、摘要或任何回复内容。需要提及时写占位符。',
    '',
    '任务',
    'Task id: ' + task.id,
    'Title: ' + (task.title || '(untitled)'),
    task.detail ? 'Detail: ' + truncate(String(task.detail), 2000) : '',
    '',
    '凭据',
    '平台凭据在 ' + credPath + '，用 Read 读它，按方案里的登录步骤取 token。',
    '',
    '工作目录：' + workspace,
    '',
    '已批准的变更方案（来源文件 ' + planFile + '）',
    '=====',
    plan,
    '=====',
    '',
    platform ? capabilities.riskNotes(platform) || '' : '',
    '',
    '执行流程',
    '1. 通读方案，确认每一步的预期响应是什么。',
    '2. 按顺序执行。每一步执行后先比对响应，符合预期才走下一步。',
    '3. 方案里写了拍快照或 GET 留档的前置步骤，必须先做，不许跳过。',
    '4. 全部步骤完成后，执行方案里"执行后验证"一节的每一条，逐条给出实际结果。',
    '5. 当场可验的验证项任何一条不通过，整体判为失败，并说明是否需要回滚、回滚到哪一步。',
    '   当场无法验证的项（需要浏览器交互的官方工具、要等 N 天的收录跟进这类）不算失败，',
    '   照实标成待人工，不许为了让结果好看把没跑的写成通过。',
    '',
    '输出：中文执行记录，按下面结构写',
    '',
    '## 执行记录',
    '按步骤编号，每步写：调用了什么、实际响应关键字段、与预期是否一致。',
    '中止的话，在中止那一步写清楚原因。',
    '',
    '## 验证结果',
    '逐条列方案里的验证项，写实际观测值和通过与否。',
    '',
    '## 结论',
    '一段话：改了什么、当前站点处于什么状态、是否需要人接手做什么。',
    '',
    '最后附一个 json 块，后面不要有任何内容：',
    '```json',
    '{"status":"success","steps_done":3,"steps_total":3,"verification_passed":true,',
    ' "affected_urls":["https://example.co.nz/some-page/"],',
    ' "snapshot_label":"task-61-mtm-rewrite-pre",',
    ' "before_archive":"/data/aira/clients/example/backups/2026-08-25-task-61/before-rendered.html",',
    ' "checks":[{"name":"V1 接口返回 ok","passed":true,"deferred":false,"note":"ok=true"},',
    '  {"name":"V12 Rich Results Test","passed":false,"deferred":true,"note":"需浏览器交互，本环境跑不了，待人工补跑"}],',
    ' "note":"中文一句话结论"}',
    '```',
    'status 取值：success 表示全部步骤执行且当场可验的验证全过；aborted 表示因为响应不符或方案有问题',
    '主动中止；failed 表示执行了但当场可验的验证没过。三者只能选一个，不许自行发明。',
    '',
    'json 各字段的硬要求',
    '- affected_urls：本次**实际**改动到的页面完整 URL 列表，写规范域、零跳转的那一个',
    '  （拿不准就 curl -L -w "%{num_redirects}" 验一下，必须是 0）。没有页面被改动就写空数组。',
    '  不许把只读过没改过的页面写进来，也不许写接口地址或本地路径。',
    '- snapshot_label：方案里那一步拍的平台快照 label 原文，方案没有拍快照就写空字符串。',
    '- before_archive：方案步骤里落到本地的改前渲染 HTML 的绝对路径（整页覆盖类必有这一步），',
    '  没有就写空字符串。写路径本身，不要写目录，不要写多个。',
    '- checks：方案"执行后验证"一节的每一条各一项，顺序照方案。',
    '  name 用方案里的编号加标题，例如 "V3 禁区词清零"；',
    '  passed 是这一条实际过没过；',
    '  deferred=true 表示这一条当场根本无法验证（需要浏览器的官方工具、要等 N 天的收录跟进这类），',
    '  deferred 项不计入成败，但 passed 仍要照实写（没跑就写 false）；',
    '  当场跑了但没过的项写 passed=false 且 deferred=false，这种项只要有一条，整体就是失败。',
    '- verification_passed：老字段，保留兼容，按当场可验的项是否全过来写。',
    '',
    '文风：中文，不用 emoji，不用破折号。不许编造响应内容，没跑过的步骤不许写成跑过了。',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

/* =========================================================
   outcome 契约的解析、判定与 note 头部
   下面五个函数都是纯函数：只吃参数吐值，不碰网络不碰磁盘，单测直接调。
   ========================================================= */

/** checks 数组归一化。脏数据一律丢掉，剩下的字段类型强制成 bool 与 string。 */
function normalizeChecks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({
      name: truncate(String(c.name || '').trim(), 120) || '未命名检查项',
      passed: c.passed === true,
      deferred: c.deferred === true,
      note: truncate(String(c.note || '').trim(), 200),
    }));
}

/** affected_urls 归一化：只留 http(s) 开头的完整地址，去重，最多 20 条。 */
function normalizeUrls(raw) {
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
 * 成败判定。
 * 有 checks 就以 checks 为准：只有 deferred=false 且 passed=false 的项算失败，
 * deferred 项只记录不计成败（task 61 的教训：V12 要浏览器、V13 要等 14 天，
 * 这两条把一次全绿的落地判成了失败）。
 * 没有 checks 才回落老字段 verification_passed，行为与从前一致。
 * 返回 { mode, ok, failed, deferred, passedCount }
 */
function judgeChecks(json) {
  const checks = normalizeChecks(json && json.checks);
  if (checks.length) {
    const failed = checks.filter((c) => !c.deferred && !c.passed);
    const deferred = checks.filter((c) => c.deferred);
    const passedCount = checks.filter((c) => !c.deferred && c.passed).length;
    return { mode: 'checks', ok: failed.length === 0, failed, deferred, passedCount, checks };
  }
  const legacyOk = json && json.verification_passed === true;
  return {
    mode: 'legacy',
    ok: !!legacyOk,
    failed: [],
    deferred: [],
    passedCount: 0,
    checks: [],
  };
}

/** 「检查:」那一行。没有 checks 的老方案回落成一句话，格式仍然可 grep。 */
function checkSummary(judge) {
  if (!judge || judge.mode !== 'checks') {
    return judge && judge.ok ? '旧格式，模型声明全部通过' : '旧格式，模型未声明全部通过';
  }
  const parts = ['通过 ' + judge.passedCount + ' 项'];
  if (judge.failed.length) {
    parts.push('未通过 ' + judge.failed.length + ' 项（' + judge.failed.map((c) => c.name).join('、') + '）');
  }
  parts.push(
    '待人工 ' +
      judge.deferred.length +
      ' 项' +
      (judge.deferred.length ? '（' + judge.deferred.map((c) => c.name).join('、') + '）' : '')
  );
  return parts.join('，');
}

/**
 * result_note 的固定头部，apply 成功与失败都写，人一眼看到改了哪页，机器能 grep。
 * 缺的字段整行不写，唯独「受影响页面」与「检查」两行永远在。
 */
function buildNoteHeader(o) {
  const opts = o || {};
  const urls = normalizeUrls(opts.affectedUrls);
  const lines = ['受影响页面: ' + (urls.length ? urls.join(' , ') : '未提供')];
  if (opts.archiveUrl) lines.push('改前存档: ' + opts.archiveUrl);
  if (opts.snapshotLabel) lines.push('快照: ' + String(opts.snapshotLabel).trim());
  lines.push('检查: ' + checkSummary(opts.judge));
  return lines.join('\n') + '\n---\n';
}

/** Read the machine block. A missing or unparseable block is treated as failed. */
function readOutcome(output, log) {
  const parsed = extractTrailingJson(output);
  const say = log || function () {};
  // 解析不出来的情况没有任何可信字段，判定字段一律给空值。
  const empty = { judge: judgeChecks(null), affectedUrls: [], snapshotLabel: '', beforeArchive: '' };
  if (parsed.error || !parsed.json || typeof parsed.json !== 'object') {
    say('outcome block: ' + (parsed.error || 'not an object') + ', treating this task as failed');
    return Object.assign(
      { status: 'failed', note: '执行结果无法解析，未确认是否成功，需人工核对站点状态', raw: null },
      empty
    );
  }
  const json = parsed.json;
  const extra = {
    judge: judgeChecks(json),
    affectedUrls: normalizeUrls(json.affected_urls),
    snapshotLabel: truncate(String(json.snapshot_label || '').trim(), 120),
    beforeArchive: String(json.before_archive || '').trim(),
  };
  const status = String(json.status || '').trim().toLowerCase();
  if (!STATUSES.includes(status)) {
    say('outcome block: status "' + json.status + '" is not one of ' + STATUSES.join('/') + ', treating as failed');
    return Object.assign(
      { status: 'failed', note: '执行结果状态值非法，需人工核对站点状态', raw: json },
      extra
    );
  }
  // 声称成功但判定不过才降级。判定口径见 judgeChecks：有 checks 就只看
  // deferred=false 的项，没有 checks 才回落老字段 verification_passed。
  if (status === 'success' && !extra.judge.ok) {
    const why =
      extra.judge.mode === 'checks'
        ? '当场可验的检查项有 ' + extra.judge.failed.length + ' 条没过：' +
          extra.judge.failed.map((c) => c.name).join('、')
        : '验证未全部通过';
    say('outcome block: status success but ' + why + ', treating as failed');
    return Object.assign(
      {
        status: 'failed',
        note: '执行声称成功但' + why + '：' + truncate(String(json.note || ''), 300),
        raw: json,
      },
      extra
    );
  }
  if (status === 'success' && extra.judge.deferred.length) {
    say(
      'outcome block: ' +
        extra.judge.deferred.length +
        ' deferred check(s) recorded, not counted as failure :: ' +
        extra.judge.deferred.map((c) => c.name).join('、')
    );
  }
  return Object.assign({ status, note: truncate(String(json.note || ''), 500), raw: json }, extra);
}

/* =========================================================
   改前存档上传与快照回滚
   ========================================================= */

const ARCHIVE_SUBDIR = 'qa';
const ARCHIVE_MAX_BYTES = 20 * 1024 * 1024;

/**
 * 把方案里落的改前渲染 HTML 传到 250 的 reports/{slug}/qa/，返回对外链接。
 * 传不上去只记日志不炸任务：存档是给人看的旁证，不是交付物本身，
 * 为它挂掉一次已经落地的变更不划算。失败返回空字符串，调用方写「存档上传失败」。
 */
async function publishBeforeArchive(ctx, workspace, profile, taskId, localPath) {
  const { cfg, log } = ctx;
  const p = String(localPath || '').trim();
  if (!p) return '';
  try {
    const abs = path.resolve(p);
    // 只允许工作区里的文件出去。模型给的路径不可全信，越界一律不传。
    const root = path.resolve(workspace) + path.sep;
    if (abs !== path.resolve(workspace) && abs.indexOf(root) !== 0) {
      log('task ' + taskId + '：改前存档 ' + abs + ' 不在工作区内，不上传');
      return '';
    }
    const st = fs.statSync(abs);
    if (!st.isFile()) {
      log('task ' + taskId + '：改前存档 ' + abs + ' 不是文件，不上传');
      return '';
    }
    if (st.size > ARCHIVE_MAX_BYTES) {
      log('task ' + taskId + '：改前存档 ' + abs + ' 超过 20MB，不上传');
      return '';
    }
    const slug = clientDirName(profile, cfg);
    const filename = 'task-' + taskId + '-before.html';
    const res = await publishFile(cfg, slug, ARCHIVE_SUBDIR, filename, abs, log);
    log('task ' + taskId + '：改前存档已上传 ' + res.url);
    return res.url;
  } catch (e) {
    log('task ' + taskId + '：改前存档上传失败，只记日志不影响任务 :: ' + e.message);
    return '';
  }
}

/**
 * 判失败时的兜底回滚：用方案里那一步拍的快照做一次平台还原。
 * 走的是与方案第 4 节同一个接口 POST /api/content/{siteId}/snapshots/{label}/restore，
 * 凭据与登录方式与其他 runner 完全一致（notes/{platform}_credentials.md 加 shadow bot 登录）。
 * 返回一句中文，直接放进 note 开头，人看一眼就知道站点现在是什么状态。
 */
async function rollbackSnapshot(ctx, workspace, profile, taskId, label) {
  const { cfg, log } = ctx;
  const name = String(label || '').trim();
  if (!name) return '';
  try {
    const credPath = path.join(
      workspace,
      'notes',
      capabilities.slugPlatform(profile.platform || 'platform') + '_credentials.md'
    );
    const cred = wf.readCredentials(credPath);
    const client = new wf.WebForger({ base: cfg.webforgerApi, timeoutMs: cfg.httpTimeoutMs });
    const who = await client.login(cred.email, cred.password);
    log('task ' + taskId + '：准备回滚，siteId ' + who.siteId + '，快照 ' + name);
    const res = await client.req(
      'POST',
      '/api/content/' + encodeURIComponent(who.siteId) + '/snapshots/' + encodeURIComponent(name) + '/restore',
      {}
    );
    if (!res || res.ok !== true) {
      throw new Error('restore 响应 ok 不为 true：' + truncate(JSON.stringify(res || {}), 200));
    }
    const restored = res.restored == null ? '未知' : res.restored;
    const pre = res.preRestoreLabel ? '，还原前平台自动快照 ' + res.preRestoreLabel : '';
    log('task ' + taskId + '：回滚成功，restored ' + restored);
    return '已自动回滚：快照 ' + name + ' 已还原，restored ' + restored + pre + '。';
  } catch (e) {
    log('task ' + taskId + '：回滚失败 :: ' + e.message);
    return '回滚失败需人工：快照 ' + name + ' 还原没成功（' + truncate(e.message, 200) + '），站点可能停在半改状态。';
  }
}

/**
 * Publishing an approved blog draft.
 *
 * No model in this path. Publishing is four deterministic calls and three
 * checks, and a model can only add ways for it to go sideways. The draft was
 * already written, already reviewed by the team, and already approved by the
 * client; the only question left is whether the platform did what it said.
 */
async function runBlogPublish(ctx, task, workspace, profile, previewUrl) {
  const { cfg, api, log } = ctx;
  const taskId = task.id;
  const steps = [];
  const record = (line) => {
    steps.push(line);
    log('task ' + taskId + '：' + line);
  };

  const credPath = path.join(
    workspace,
    'notes',
    capabilities.slugPlatform(profile.platform || 'platform') + '_credentials.md'
  );
  const cred = wf.readCredentials(credPath);
  const client = new wf.WebForger({
    base: cfg.webforgerApi,
    timeoutMs: cfg.httpTimeoutMs,
    lang: cfg.blogLang || '',
  });
  const who = await client.login(cred.email, cred.password);
  record('已登录 WebForger，siteId ' + who.siteId);

  const slug = wf.slugFromBlogUrl(previewUrl);
  if (!slug) throw new Error('task ' + taskId + '：从 output_url 解析不出 slug：' + previewUrl);
  const publicUrl = wf.publicUrlOf(previewUrl);
  record('目标文章 slug ' + slug + '，正式地址 ' + publicUrl);

  const before = await client.getPost(slug);
  const post = (before && before.post) || null;
  if (!post) throw new Error('task ' + taskId + '：平台上找不到 slug ' + slug + '，不发布');
  const statusBefore = String(post.status || '').toLowerCase();
  record('发布前状态 ' + (statusBefore || '未知'));

  if (statusBefore === 'published') {
    // A retry after a partial run. Do not publish twice, just verify.
    record('文章已经是 published，跳过发布，直接验证线上');
  } else if (statusBefore && statusBefore !== 'draft') {
    throw new Error('task ' + taskId + '：文章状态是 ' + statusBefore + '，不是 draft，停下报人');
  } else {
    await client.publishPost(slug);
    record('已调用 publish');
  }

  // Verification. Every one of these has to pass before the task is done.
  const problems = [];
  const after = await client.getPost(slug);
  const statusAfter = String(((after && after.post) || {}).status || '').toLowerCase();
  record('发布后平台状态 ' + (statusAfter || '未知'));
  if (statusAfter !== 'published') problems.push('平台状态不是 published，实际是 ' + (statusAfter || '未知'));

  let live = null;
  try {
    live = await wf.fetchPublic(publicUrl, cfg.httpTimeoutMs);
    record('线上回读 ' + publicUrl + ' 返回 ' + live.status + '，' + (live.text || '').length + ' 字节');
  } catch (e) {
    problems.push('线上回读失败：' + e.message);
  }
  if (live && live.status !== 200) problems.push('线上地址返回 ' + live.status + '，不是 200');
  if (live) {
    const robotsHeader = String(live.headers['x-robots-tag'] || '');
    const metaNoindex = /<meta[^>]+name\s*=\s*["']robots["'][^>]*noindex/i.test(live.text);
    if (/noindex/i.test(robotsHeader)) problems.push('响应头 X-Robots-Tag 仍带 noindex：' + robotsHeader);
    if (metaNoindex) problems.push('页面 meta robots 仍是 noindex');
    if (/preview\s*draft/i.test(live.text)) problems.push('线上页面还挂着 Preview draft 横幅，说明发布没生效');
  }

  const outDir = path.join(workspace, OUTPUT_DIRNAME);
  fs.mkdirSync(outDir, { recursive: true });
  const logFile = path.join(outDir, 'blog-publish-task-' + taskId + '-' + localYmd() + '-' + Date.now() + '.md');
  fs.writeFileSync(
    logFile,
    ['# 博客发布执行记录', '', '任务 #' + taskId, 'slug ' + slug, '正式地址 ' + publicUrl, '', '## 步骤', ...steps.map((s) => '- ' + s), '', '## 验证', problems.length ? problems.map((p) => '- 未通过：' + p).join('\n') : '- 全部通过'].join('\n'),
    'utf8'
  );

  // Before either branch: a run that half worked can still have produced a file
  // a human needs, so the upload is not conditional on the outcome.
  await deliverables.uploadTaskDeliverables(ctx, taskId, workspace);

  // 发布路径的验证是写死的三条，没有延后项，照样按同一套 checks 口径写头部，
  // 让看板上两条路径的 result_note 长一个样。
  const publishChecks = [
    { name: '平台状态 published', passed: statusAfter === 'published', deferred: false, note: '' },
    { name: '线上回读 200', passed: !!live && live.status === 200, deferred: false, note: '' },
    {
      name: '无 noindex 且无草稿横幅',
      passed: !problems.some((p) => /noindex|Preview draft/i.test(p)),
      deferred: false,
      note: '',
    },
  ];
  const header = buildNoteHeader({
    affectedUrls: [publicUrl],
    judge: judgeChecks({ checks: publishChecks }),
  });

  if (problems.length) {
    const note =
      header +
      '发布后验证未通过，任务保持 review，需要人核对线上状态：' + problems.join('；') +
      ' 执行记录 ' + path.basename(logFile);
    try {
      await api.postTaskResult(taskId, { output_url: publicUrl, note });
    } catch (e) {
      log('task ' + taskId + '：写失败备注也失败了 :: ' + e.message);
    }
    log('task ' + taskId + '：发布验证未通过，留在 review');
    return { taskId, status: 'failed', logFile };
  }

  await api.completeTask(taskId, {
    note:
      header +
      '博文已发布并验证：' + publicUrl + '（平台状态 published，线上 200，无 noindex）。执行记录 ' + path.basename(logFile),
  });
  log('task ' + taskId + '：博文已发布并验证通过，标记完成');
  return { taskId, status: 'success', logFile };
}

async function runOne(ctx, context, workspace, taskId) {
  const { cfg, api, log, job } = ctx;
  const profile = (context && context.profile) || {};
  const platform = profile.platform || profile.cms || null;
  const task = findTask(context, taskId) || { id: taskId, title: null, detail: null };
  if (!findTask(context, taskId)) {
    log('task ' + taskId + ': not found in context, applying against the plan file alone');
  }

  // Blog publish is its own path: the deliverable is a draft on the platform,
  // not a change plan file, so the plan file requirement below does not apply.
  const ops = taskOps(task);
  const outputUrl = String(task.output_url || '');
  if (ops.some((op) => BLOG_OPS.indexOf(op) !== -1) && wf.isBlogUrl(outputUrl, profile.domain)) {
    log('task ' + taskId + '：博客发布模式，目标 ' + wf.publicUrlOf(outputUrl));
    return runBlogPublish(ctx, task, workspace, profile, outputUrl);
  }

  const planFile = changePlanPath(workspace, taskId);
  let plan;
  try {
    plan = fs.readFileSync(planFile, 'utf8');
  } catch (e) {
    throw new Error(
      'task ' + taskId + ': no approved change plan at ' + planFile + '. Run execute_task first'
    );
  }
  if (!plan.trim()) throw new Error('task ' + taskId + ': the change plan file is empty');
  log('task ' + taskId + ': change plan loaded, ' + Buffer.byteLength(plan, 'utf8') + ' bytes');

  const credPath = path.join(
    workspace,
    'notes',
    capabilities.slugPlatform(platform || 'platform') + '_credentials.md'
  );
  if (!fs.existsSync(credPath)) {
    throw new Error('task ' + taskId + ': credentials file missing at ' + credPath + ', refusing to apply');
  }

  const prompt = buildPrompt({ task, plan, planFile, workspace, platform, credPath });
  log('task ' + taskId + ': applying, model ' + cfg.applyModel + ', prompt ' + prompt.length + ' chars');

  const res = await runClaude(cfg, {
    prompt,
    cwd: workspace,
    log,
    model: cfg.applyModel,
    allowedTools: ALLOWED_TOOLS,
    label: 'apply task ' + taskId,
  });

  const output = String(res.stdout || '').trim();
  if (!output) throw new Error('task ' + taskId + ': the apply pass produced no output');

  const outDir = path.join(workspace, OUTPUT_DIRNAME);
  fs.mkdirSync(outDir, { recursive: true });
  const logFile = path.join(
    outDir,
    'apply-log-task-' + taskId + '-' + localYmd() + '-' + Date.now() + '.md'
  );
  fs.writeFileSync(logFile, output, 'utf8');
  log('task ' + taskId + ': execution record saved to ' + logFile);

  const outcome = readOutcome(output, log);

  // Before the branch on purpose: an aborted apply may still have written the
  // file a human has to carry somewhere by hand, and that is exactly when they
  // need to be able to download it.
  await deliverables.uploadTaskDeliverables(ctx, taskId, workspace);

  // 改前存档先上传，成功与失败两条路都要在头部给出这条链接。
  const archiveUrl = outcome.beforeArchive
    ? (await publishBeforeArchive(ctx, workspace, profile, taskId, outcome.beforeArchive)) || '存档上传失败'
    : '';

  if (outcome.status === 'success') {
    const header = buildNoteHeader({
      affectedUrls: outcome.affectedUrls,
      archiveUrl,
      snapshotLabel: outcome.snapshotLabel,
      judge: outcome.judge,
    });
    await api.completeTask(taskId, {
      note:
        header +
        '已按批准方案执行并自验通过。' + (outcome.note || '') + ' 执行记录 ' + path.basename(logFile),
    });
    log('task ' + taskId + ': applied and verified, marked done');
    return { taskId, status: 'success', logFile };
  }

  // Not a success. The task stays in review with the reason on it, and nothing
  // is retried. A half applied change needs a human, not another attempt.
  // 判失败且方案里拍过快照的，先当场兜底回滚一次，把结果写进 note 开头，
  // 人接手时第一眼看到的是站点现在到底回没回去，而不是要自己去查。
  const rollbackLine =
    outcome.status === 'failed' && outcome.snapshotLabel
      ? await rollbackSnapshot(ctx, workspace, profile, taskId, outcome.snapshotLabel)
      : '';
  const label = outcome.status === 'aborted' ? '执行中止' : '执行失败';
  const header = buildNoteHeader({
    affectedUrls: outcome.affectedUrls,
    archiveUrl,
    snapshotLabel: outcome.snapshotLabel,
    judge: outcome.judge,
  });
  const note =
    header +
    (rollbackLine ? rollbackLine + ' ' : '') +
    label +
    '：' +
    (outcome.note || summarize(output, 300)) +
    ' 任务保持 review，未标记完成。执行记录 ' +
    path.basename(logFile);
  try {
    // attention 打上：落地没成的任务必须自己浮到人眼前，不能只靠 job 挂掉。
    await api.postTaskResult(taskId, { output_url: '', note, attention: true });
  } catch (e) {
    log('task ' + taskId + ': could not write the failure note :: ' + e.message);
  }
  log('task ' + taskId + ': ' + outcome.status + ', left in review :: ' + truncate(outcome.note, 300));
  return { taskId, status: outcome.status, logFile };
}

async function run(ctx) {
  const { job, api, log } = ctx;
  const payload = job.payload || {};
  const taskIds = Array.isArray(payload.task_ids) ? payload.task_ids : [];
  if (!taskIds.length) throw new Error('apply_task job has no payload.task_ids');
  log('applying ' + taskIds.length + ' approved task(s): ' + taskIds.join(', '));

  const context = await api.getContext(job.client_id);
  const profile = (context && context.profile) || null;
  if (!profile) throw new Error('context returned no profile for client_id ' + job.client_id);
  const workspace = ensureClientWorkspace(profile, ctx.cfg);
  log('workspace: ' + workspace);

  const problems = [];
  for (const taskId of taskIds) {
    try {
      const res = await runOne(ctx, context, workspace, taskId);
      if (res.status !== 'success') problems.push(taskId + ': ' + res.status);
    } catch (e) {
      log('task ' + taskId + ': FAILED :: ' + (e.stack || e.message));
      problems.push(taskId + ': ' + e.message);
    }
  }

  if (problems.length) {
    // Surfaced as a failed job so it lands in front of a human, even though each
    // task already carries its own note.
    throw new Error(
      problems.length + ' of ' + taskIds.length + ' task(s) did not complete :: ' + problems.join(' | ')
    );
  }
  return { tokenUsage: 0 };
}

module.exports = {
  run,
  buildPrompt,
  readOutcome,
  changePlanPath,
  runBlogPublish,
  taskOps,
  normalizeChecks,
  normalizeUrls,
  judgeChecks,
  checkSummary,
  buildNoteHeader,
  publishBeforeArchive,
  rollbackSnapshot,
  ALLOWED_TOOLS,
  BLOG_OPS,
  ARCHIVE_SUBDIR,
};
