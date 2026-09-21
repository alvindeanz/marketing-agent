'use strict';
// Config loader. Reads config.json from the worker root (override with env SEO_WORKER_CONFIG).

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  apiBase: 'https://always.horntech-dev.com/seo-api.php',
  serviceToken: '',
  bindHost: '0.0.0.0',
  wakePort: 8377,
  wakeSecret: '',
  pollIntervalSec: 300,
  maxConcurrent: 1,
  // worker 身份（2026-09-18 多 worker）：claim/reap 带上，供服务端收尸隔离。ros 基座默认 ros，
  // Mac 第二 worker 在 config/env 设 workerId=mac。空串 = 老口径（reap 收 claimed_by='' ）。
  workerId: 'ros',
  ga4KeyFile: 'secrets/ga4_sa.json',
  claudeBin: 'claude',
  claudeModel: 'opus',
  // Planning is the highest stakes run, it gets its own model knob.
  planModel: 'fable',
  discoverModel: 'opus',
  // Applying an approved change plan is the only stage that writes to a site.
  applyModel: 'opus',
  // Parsing a human feedback note is a light extraction job, not analysis.
  feedbackModel: 'sonnet',
  // Looking at one generated image and saying whether it is usable. Same kind of
  // work as the feedback pass: narrow, mechanical, high volume.
  imageModel: 'sonnet',
  // 配图生成源：webforger（平台 generate-image，Replicate FLUX 1.1 Pro）或 bfl（直连 Black Forest Labs FLUX.2）。
  // 灰度用 bflCanaryClients（工作区 slug 数组）先放几家跑，全局默认不动。key 没配一律回落 webforger。
  imageProvider: 'webforger',
  imageCanaryProvider: 'replicate',
  imageCanaryClients: [],
  replicateModel: 'flux-2-pro',
  replicateApiToken: '',
  replicateInput: {},
  bflModel: 'flux-2-pro',
  bflApiKey: '',
  // 2026-09-17 Alvin 定：premium 档只留「定战略框架」与「不可回收现场」；巡检只做总结不决策，降 opus。
  triageModel: 'opus',
  // 2026-09-17 降 opus：把人话解析成看板动作，安全靠服务端双锚校验（引语逐字命中+task_id+标题片段）
  // 不靠模型，opus 解析足够；模型只提议，服务端验真。
  rulingModel: 'opus',
  // 收件箱对话。人在工作台按客户跟它聊数据、聊博客规划，只读加提议，
  // 唯一的产物是任务草案，人点开工才落账。谈的是策略，所以给大模型。
  /* 2026-09-11 Alvin 定走 fable 观察周配额，快超再降 opus；2026-09-21 应验（周中 fable 已烧 75%），
     Alvin 定降 opus：聊天用 fable 大材小用，premium 只留 plan 与 planReview 两个低频真判断位。 */
  chatModel: 'opus',
  // 任务判定（闸A）：一批任务该不该做，按 specs/review_principles.md 判。
  // 2026-09-17 Alvin 定降 opus：这是 fable 定好 plan 框架之内的单任务 go/no-go，边界清楚；
  // 判断漂了由季度 planReview（仍 fable）重规划纠回。全流水线最高频调用，premium 从高频挪走。
  reviewModel: 'opus',
  // 方案层过闸：整份方案按跨客户经验改成 v2 并出方向确认卡，一个客户一季度一次，给大模型。
  planReviewModel: 'fable',
  // 任务线程（chat runner 的任务模式）。落看板层动作（改任务、重派、改判）。
  // 2026-09-17 降 opus：同 ruling，动作靠服务端双锚校验兜底，opus 判断够稳。普通收件箱会话仍走 chatModel。
  threadModel: 'opus',
  // 博客正文审稿：机器校验过后按客户规则审一遍，只出意见，定点修一次不循环。
  // 2026-09-17 降 opus：内容 QA 是 opus 强项，且博客还要过客户确认卡。
  blogReviewModel: 'opus',
  // 与 PJ 手工产线共用的交付 lint 规则表，和记忆目录（客户 feedback_* 规则注入博客 prompt）。
  lintRulesFile: '/data/aira/scripts/deliverable_lint_rules.json',
  memoryDir: '/root/.claude/projects/-data-aira/memory',
  // 月报叙事层。数字由数据层算好，模型只写解读，但读者是客户老板，
  // 一次写完无人答疑，所以给大模型。
  reportModel: 'opus',
  // 报告成品上传到 250 用的 ssh Host 别名（root 的 ~/.ssh/config 已配好免密）。
  reportSsh: 'blogpreview',
  // 250 上报告的物理根目录，报告落在 {reportRemoteRoot}/{slug}/ 下。
  reportRemoteRoot: '/www/wwwroot/blogpreview.horntech-dev.com/reports',
  // 对外交给客户的 URL 根。与 reportRemoteRoot 是同一份文件的两个门牌，
  // 客户面一律用 agencyreport 这个域名。
  reportUrlBase: 'https://agencyreport.horntech-dev.com/reports',
  // 报告 job 单独的超时。三层里取数与渲染是快路径，LLM 一次加至多一次纠错，
  // 叠起来会逼近 jobTimeoutMin 的 30 分，所以单独放宽。
  reportTimeoutMin: 45,
  jobTimeoutMin: 30,
  // 按 job 类型分档放宽（2026-09-21 Alvin 批）：haakaa 317 篇 articles list 实测 30 分钟+，
  // 批1 #339 执行撞预算被腰斩、半途备注被当结果收口。execute/apply/backfill 给 60 分，
  // 其余类型维持 jobTimeoutMin，report 仍走 reportTimeoutMin。
  jobTimeoutMinByType: { execute_task: 60, apply_task: 60, backfill_metrics: 60 },
  // WebForger API base and the blog language the runners write in. Empty lang
  // means the site's default language.
  webforgerApi: 'https://api.webforger.ai',
  blogLang: '',
  // Blog client review sweep, runs on the fallback poll tick. Zero LLM.
  blogReviewEnabled: true,
  // Only used when the API has no /blog_review_watch endpoint yet: the client
  // ids to sweep. Leave empty once the endpoint is deployed.
  blogReviewClients: [],
  workspaceRoot: '/data/aira/clients',
  defaultClientDir: 'powerdekorfloors',
  httpTimeoutMs: 60000,
  gscSpamExcludeRegex: '(jack|jek|jak|jeck)\\s?toto',
  // Skip an external pull when the newest snapshot for that source is younger
  // than this. payload.fresh bypasses it.
  cacheTtlHours: 24,
  // ssh Host alias for the internal seoq gate that fronts SEMrush.
  seoqSsh: 'seoq',
  semrushDb: 'nz',
};

let cached = null;

/* claudeBin 启动自愈（2026-09-18，Apex job 981 事故）：Mac 的 config.json 抄了 ros 的
   /root/.local/bin/claude，worker 带病抢单把真活烧成 failed。机器色彩的配置一律在启动时
   解析成本机真实可执行文件：配置的路径存在就用；不存在（或裸名）按 PATH 与常见安装目录
   找同名兜底，用了哪个在 note 里说清。全都找不到返回 null，listener 启动断言据此拒绝起，
   不带执行不了的配置进抢单循环（地基约束①：无单实例假设）。 */
function isExecFile(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch (e) {
    return false;
  }
}
function resolveClaudeBin(configured) {
  const want = String(configured || 'claude');
  if (want.includes(path.sep) && isExecFile(want)) return { bin: want, note: '' };
  const name = path.basename(want);
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const home = process.env.HOME || '';
  if (home) dirs.push(path.join(home, '.local', 'bin'));
  dirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin');
  for (const d of dirs) {
    const c = path.join(d, name);
    if (isExecFile(c)) return { bin: c, note: 'claudeBin "' + want + '" 本机不可用，兜底解析为 ' + c };
  }
  return null;
}

function configPath() {
  return process.env.SEO_WORKER_CONFIG || path.join(ROOT, 'config.json');
}

function load() {
  if (cached) return cached;
  const p = configPath();
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error('cannot read config file ' + p + ' :: ' + e.message);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('config file is not valid JSON: ' + p + ' :: ' + e.message);
  }

  const cfg = Object.assign({}, DEFAULTS, parsed);
  cfg.root = ROOT;
  cfg.configPath = p;

  // Required fields. Fail loud at startup rather than at job time.
  const required = ['apiBase', 'serviceToken', 'wakeSecret'];
  for (const key of required) {
    if (!cfg[key] || String(cfg[key]).trim() === '') {
      throw new Error('config field "' + key + '" is required and missing in ' + p);
    }
  }
  cfg.apiBase = String(cfg.apiBase).replace(/\/+$/, '');
  cfg.wakePort = Number(cfg.wakePort) || DEFAULTS.wakePort;
  cfg.pollIntervalSec = Number(cfg.pollIntervalSec) || DEFAULTS.pollIntervalSec;
  cfg.workerId = String(cfg.workerId || process.env.WORKER_ID || DEFAULTS.workerId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  cfg.maxConcurrent = Number(cfg.maxConcurrent) || 1;
  cfg.jobTimeoutMin = Number(cfg.jobTimeoutMin) || DEFAULTS.jobTimeoutMin;
  cfg.jobTimeoutMinByType = Object.assign({}, DEFAULTS.jobTimeoutMinByType,
    (cfg.jobTimeoutMinByType && typeof cfg.jobTimeoutMinByType === 'object') ? cfg.jobTimeoutMinByType : {});
  cfg.httpTimeoutMs = Number(cfg.httpTimeoutMs) || DEFAULTS.httpTimeoutMs;
  // Newer fields. Missing in an older config.json is fine, defaults apply.
  // cacheTtlHours 0 is meaningful, it disables the cache, so only fall back on NaN.
  const ttl = Number(cfg.cacheTtlHours);
  cfg.cacheTtlHours = Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULTS.cacheTtlHours;
  cfg.seoqSsh = String(cfg.seoqSsh || DEFAULTS.seoqSsh);
  cfg.planModel = String(cfg.planModel || DEFAULTS.planModel);
  cfg.discoverModel = String(cfg.discoverModel || DEFAULTS.discoverModel);
  cfg.applyModel = String(cfg.applyModel || DEFAULTS.applyModel);
  cfg.feedbackModel = String(cfg.feedbackModel || DEFAULTS.feedbackModel);
  cfg.imageModel = String(cfg.imageModel || DEFAULTS.imageModel);
  cfg.imageProvider = String(cfg.imageProvider || DEFAULTS.imageProvider);
  cfg.bflModel = String(cfg.bflModel || DEFAULTS.bflModel);
  cfg.bflApiKey = String(cfg.bflApiKey || process.env.BFL_API_KEY || '');
  cfg.imageCanaryProvider = String(cfg.imageCanaryProvider || DEFAULTS.imageCanaryProvider);
  cfg.imageCanaryClients = Array.isArray(cfg.imageCanaryClients) ? cfg.imageCanaryClients.map(String) : [];
  cfg.replicateModel = String(cfg.replicateModel || DEFAULTS.replicateModel);
  cfg.replicateApiToken = String(cfg.replicateApiToken || process.env.REPLICATE_API_TOKEN || '');
  cfg.replicateInput = cfg.replicateInput && typeof cfg.replicateInput === 'object' ? cfg.replicateInput : {};
  cfg.triageModel = String(cfg.triageModel || DEFAULTS.triageModel);
  cfg.rulingModel = String(cfg.rulingModel || DEFAULTS.rulingModel);
  cfg.chatModel = String(cfg.chatModel || DEFAULTS.chatModel);
  cfg.reviewModel = String(cfg.reviewModel || DEFAULTS.reviewModel);
  cfg.planReviewModel = String(cfg.planReviewModel || DEFAULTS.planReviewModel);
  cfg.threadModel = String(cfg.threadModel || DEFAULTS.threadModel);
  cfg.blogReviewModel = String(cfg.blogReviewModel || DEFAULTS.blogReviewModel);
  cfg.lintRulesFile = String(cfg.lintRulesFile || DEFAULTS.lintRulesFile);
  cfg.memoryDir = String(cfg.memoryDir || DEFAULTS.memoryDir);
  cfg.reportModel = String(cfg.reportModel || DEFAULTS.reportModel);
  cfg.reportSsh = String(cfg.reportSsh || DEFAULTS.reportSsh);
  // 两个路径都去掉结尾斜杠，拼接时统一自己补，避免出现双斜杠的 URL。
  cfg.reportRemoteRoot = String(cfg.reportRemoteRoot || DEFAULTS.reportRemoteRoot).replace(/\/+$/, '');
  cfg.reportUrlBase = String(cfg.reportUrlBase || DEFAULTS.reportUrlBase).replace(/\/+$/, '');
  cfg.reportTimeoutMin = Number(cfg.reportTimeoutMin) || DEFAULTS.reportTimeoutMin;
  cfg.webforgerApi = String(cfg.webforgerApi || DEFAULTS.webforgerApi).replace(/\/+$/, '');
  cfg.blogLang = String(cfg.blogLang || '');
  cfg.blogReviewEnabled = cfg.blogReviewEnabled !== false;
  cfg.blogReviewClients = Array.isArray(cfg.blogReviewClients)
    ? cfg.blogReviewClients.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  cfg.semrushDb = String(cfg.semrushDb || DEFAULTS.semrushDb);

  // Resolve relative paths against the worker root.
  if (cfg.ga4KeyFile && !path.isAbsolute(cfg.ga4KeyFile)) {
    cfg.ga4KeyFile = path.join(ROOT, cfg.ga4KeyFile);
  }
  // claudeBin 解析：成功写回真实路径，失败置空并留言，由 listener 启动断言拦截。
  const rb = resolveClaudeBin(cfg.claudeBin);
  if (rb) {
    cfg.claudeBinNote = rb.note;
    cfg.claudeBin = rb.bin;
  } else {
    cfg.claudeBinNote = 'claudeBin "' + String(cfg.claudeBin) + '" 不存在，PATH 与常见安装目录也没有同名可执行文件';
    cfg.claudeBin = '';
  }
  cached = cfg;
  return cfg;
}

module.exports = { load, ROOT, DEFAULTS, configPath, resolveClaudeBin };
