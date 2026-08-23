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
const { ensureClientWorkspace, summarize, truncate, localYmd } = require('../lib/util');

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
    '5. 任何一条验证不通过，整体判为失败，并说明是否需要回滚、回滚到哪一步。',
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
    '{"status":"success","steps_done":3,"steps_total":3,"verification_passed":true,"note":"中文一句话结论"}',
    '```',
    'status 取值：success 表示全部步骤执行且全部验证通过；aborted 表示因为响应不符或方案有问题',
    '主动中止；failed 表示执行了但验证没过。三者只能选一个，不许自行发明。',
    'verification_passed 只有每一条验证都通过才写 true。',
    '',
    '文风：中文，不用 emoji，不用破折号。不许编造响应内容，没跑过的步骤不许写成跑过了。',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

/** Read the machine block. A missing or unparseable block is treated as failed. */
function readOutcome(output, log) {
  const parsed = extractTrailingJson(output);
  if (parsed.error || !parsed.json || typeof parsed.json !== 'object') {
    log('outcome block: ' + (parsed.error || 'not an object') + ', treating this task as failed');
    return { status: 'failed', note: '执行结果无法解析，未确认是否成功，需人工核对站点状态', raw: null };
  }
  const json = parsed.json;
  const status = String(json.status || '').trim().toLowerCase();
  if (!STATUSES.includes(status)) {
    log('outcome block: status "' + json.status + '" is not one of ' + STATUSES.join('/') + ', treating as failed');
    return { status: 'failed', note: '执行结果状态值非法，需人工核对站点状态', raw: json };
  }
  // Success requires the model to also say every verification passed.
  if (status === 'success' && json.verification_passed !== true) {
    log('outcome block: status success but verification_passed is not true, treating as failed');
    return {
      status: 'failed',
      note: '执行声称成功但验证未全部通过：' + truncate(String(json.note || ''), 300),
      raw: json,
    };
  }
  return { status, note: truncate(String(json.note || ''), 500), raw: json };
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

  if (problems.length) {
    const note =
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
    note: '博文已发布并验证：' + publicUrl + '（平台状态 published，线上 200，无 noindex）。执行记录 ' + path.basename(logFile),
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

  if (outcome.status === 'success') {
    await api.completeTask(taskId, {
      note: '已按批准方案执行并自验通过。' + (outcome.note || '') + ' 执行记录 ' + path.basename(logFile),
    });
    log('task ' + taskId + ': applied and verified, marked done');
    return { taskId, status: 'success', logFile };
  }

  // Not a success. The task stays in review with the reason on it, and nothing
  // is retried. A half applied change needs a human, not another attempt.
  const label = outcome.status === 'aborted' ? '执行中止' : '执行失败';
  const note =
    label +
    '：' +
    (outcome.note || summarize(output, 300)) +
    ' 任务保持 review，未标记完成。执行记录 ' +
    path.basename(logFile);
  try {
    await api.postTaskResult(taskId, { output_url: '', note });
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
  ALLOWED_TOOLS,
  BLOG_OPS,
};
