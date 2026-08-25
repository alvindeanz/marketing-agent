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
  // Triage reads the whole pipeline and judges it, so it gets the big model.
  triageModel: 'fable',
  // Reading a human ruling and turning it into board actions. Small job by
  // token count, but a misread here moves the board the wrong way, so it gets
  // the same model that wrote the digest it is answering.
  rulingModel: 'fable',
  // 收件箱对话。人在工作台按客户跟它聊数据、聊博客规划，只读加提议，
  // 唯一的产物是任务草案，人点立项才落账。谈的是策略，所以给大模型。
  chatModel: 'opus',
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
  cfg.maxConcurrent = Number(cfg.maxConcurrent) || 1;
  cfg.jobTimeoutMin = Number(cfg.jobTimeoutMin) || DEFAULTS.jobTimeoutMin;
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
  cfg.triageModel = String(cfg.triageModel || DEFAULTS.triageModel);
  cfg.rulingModel = String(cfg.rulingModel || DEFAULTS.rulingModel);
  cfg.chatModel = String(cfg.chatModel || DEFAULTS.chatModel);
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
  cached = cfg;
  return cfg;
}

module.exports = { load, ROOT, DEFAULTS, configPath };
