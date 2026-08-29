'use strict';
// 博客配图的生成源，三条路：
//   webforger  平台 /generate-image（底下是 Replicate 上的 FLUX 1.1 Pro，固定 1280×720，没有型号可选）
//   replicate  自己的 Replicate token 直连（首选：一个 token 同时有 flux-1.1-pro 和 flux-2 全系，灰度只是换模型名），
//              POST /v1/models/{owner}/{name}/predictions 带 Prefer: wait，没等到就轮询 urls.get
//   bfl        直连 Black Forest Labs（x-key，轮询 polling_url），备用
// 两条直连路都是拿到临时 URL 后下载，再 upload 回平台 /assets，下游和平台图一样处理。
// 灰度：cfg.imageProvider 是全局默认；cfg.imageCanaryClients（工作区 slug 数组）里的客户强制走
// cfg.imageCanaryProvider（默认 replicate）。凭据没配时回落 webforger 并记日志，不让配图工序整个炸掉。
// 价格（2026-08 官网）：flux-2-pro 1280×720 约 0.92MP × $0.03/MP ≈ $0.03/张；klein-9b $0.015/张；
// 每次响应带 cost（credit，1 credit = $0.01），写进日志方便月底算账。

const fs = require('fs');
const path = require('path');
const { requestJson, downloadTo } = require('./http');

const BFL_BASE = 'https://api.bfl.ai';
const REPLICATE_BASE = 'https://api.replicate.com';
// 短名 -> Replicate 官方模型路径
const REPLICATE_MODELS = {
  'flux-1.1-pro': 'black-forest-labs/flux-1.1-pro',
  'flux-1.1-pro-ultra': 'black-forest-labs/flux-1.1-pro-ultra',
  'flux-2-pro': 'black-forest-labs/flux-2-pro',
  'flux-2-flex': 'black-forest-labs/flux-2-flex',
  'flux-2-dev': 'black-forest-labs/flux-2-dev',
  'flux-2-klein-9b': 'black-forest-labs/flux-2-klein-9b',
  'flux-2-klein-4b': 'black-forest-labs/flux-2-klein-4b',
};
const REPLICATE_POLL_MS = 1500;
const REPLICATE_POLL_BUDGET_MS = 150000;
const BFL_MODELS = ['flux-2-pro', 'flux-2-pro-preview', 'flux-2-flex', 'flux-2-max', 'flux-2-klein-9b', 'flux-2-klein-4b', 'flux-1-1-pro'];
const BFL_POLL_MS = 1500;
const BFL_POLL_BUDGET_MS = 120000;
const WIDTH = 1280;
const HEIGHT = 720;

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** 这个客户这次该走哪条路。返回 'bfl' 或 'webforger'。 */
function pickProvider(cfg, workspaceSlug, log) {
  const c = cfg || {};
  const canary = Array.isArray(c.imageCanaryClients) ? c.imageCanaryClients.map(String)
    : Array.isArray(c.bflCanaryClients) ? c.bflCanaryClients.map(String) : [];
  const canaryProvider = String(c.imageCanaryProvider || (Array.isArray(c.bflCanaryClients) && c.bflCanaryClients.length ? 'bfl' : 'replicate'));
  let want = canary.includes(String(workspaceSlug || '')) ? canaryProvider : String(c.imageProvider || 'webforger');
  if (want === 'bfl' && !c.bflApiKey) {
    if (log) log('配图源：想走 bfl 但 bflApiKey 没配，回落 webforger');
    want = 'webforger';
  }
  if (want === 'replicate' && !c.replicateApiToken) {
    if (log) log('配图源：想走 replicate 但 replicateApiToken 没配，回落 webforger');
    want = 'webforger';
  }
  return ['bfl', 'replicate'].includes(want) ? want : 'webforger';
}

/**
 * Replicate 直连生成一张，返回 { sampleUrl, cost, id, model, ms, predictSec }。
 * 官方模型走 /v1/models/{path}/predictions，Prefer: wait 同步等最多 60 秒，没等到就轮询 urls.get。
 * 输入字段以 aspect_ratio 16:9 为主（两代模型都认），cfg.replicateInput 可覆盖或补字段，不用改代码。
 */
async function replicateGenerate(cfg, prompt, opts = {}) {
  const token = String((cfg && cfg.replicateApiToken) || '');
  if (!token) throw new Error('replicateApiToken 没配');
  const short = String(opts.model || (cfg && cfg.replicateModel) || 'flux-2-pro');
  const modelPath = REPLICATE_MODELS[short] || (short.includes('/') ? short : '');
  if (!modelPath) throw new Error('未知的 Replicate 型号 ' + short + '，可选 ' + Object.keys(REPLICATE_MODELS).join(' ') + ' 或 owner/name');
  const input = Object.assign({
    prompt: String(prompt || '').trim(),
    aspect_ratio: '16:9',
    output_format: 'jpg',
    output_quality: 90,
    safety_tolerance: 2,
  }, (cfg && cfg.replicateInput) || {}, opts.input || {});
  if (Number.isFinite(opts.seed)) input.seed = opts.seed;
  const headers = { Authorization: 'Bearer ' + token, Prefer: 'wait=60', accept: 'application/json' };
  const t0 = Date.now();
  let p = await requestJson(REPLICATE_BASE + '/v1/models/' + modelPath + '/predictions', { method: 'POST', headers, body: { input }, timeoutMs: 90000 });
  const id = p && p.id;
  if (!id) throw new Error('Replicate 提交响应里没有 id：' + JSON.stringify(p || {}).slice(0, 200));
  const getUrl = (p.urls && p.urls.get) || (REPLICATE_BASE + '/v1/predictions/' + id);
  while (!['succeeded', 'failed', 'canceled'].includes(String(p.status))) {
    if (Date.now() - t0 > REPLICATE_POLL_BUDGET_MS) {
      const e = new Error('Replicate 轮询超过 ' + REPLICATE_POLL_BUDGET_MS / 1000 + ' 秒仍是 ' + p.status);
      e.status = 504;
      throw e;
    }
    await delay(REPLICATE_POLL_MS);
    p = await requestJson(getUrl, { headers: { Authorization: 'Bearer ' + token, accept: 'application/json' }, timeoutMs: 20000 });
  }
  if (p.status !== 'succeeded') {
    const msg = String(p.error || p.status);
    const e = new Error('Replicate 生成失败：' + msg.slice(0, 300));
    // 安全审核类错误是 prompt 的问题，交给质检改 prompt；其余当上游抖动允许外层重试
    e.status = /nsfw|safety|sensitive|moderat/i.test(msg) ? 422 : 502;
    throw e;
  }
  const out = Array.isArray(p.output) ? p.output[0] : p.output;
  if (!out) throw new Error('Replicate succeeded 但 output 为空');
  const predictSec = Number(p.metrics && p.metrics.predict_time) || 0;
  return { sampleUrl: String(out), cost: 0, id, model: modelPath, ms: Date.now() - t0, predictSec };
}

/**
 * 直连 BFL 生成一张，返回 { sampleUrl, cost, id, model, ms }。
 * 只管生成和拿签名 URL，不下载不回传，bench 工具也复用它。
 */
async function bflGenerate(cfg, prompt, opts = {}) {
  const key = String((cfg && cfg.bflApiKey) || '');
  if (!key) throw new Error('bflApiKey 没配');
  const model = String(opts.model || (cfg && cfg.bflModel) || 'flux-2-pro');
  if (!BFL_MODELS.includes(model)) throw new Error('未知的 BFL 型号 ' + model + '，可选 ' + BFL_MODELS.join(' '));
  const body = {
    prompt: String(prompt || '').trim(),
    width: opts.width || WIDTH,
    height: opts.height || HEIGHT,
    output_format: 'jpeg',
    safety_tolerance: 2,
  };
  if (Number.isFinite(opts.seed)) body.seed = opts.seed;
  const t0 = Date.now();
  const sub = await requestJson(BFL_BASE + '/v1/' + model, {
    method: 'POST',
    headers: { 'x-key': key, accept: 'application/json' },
    body,
    timeoutMs: 30000,
  });
  const id = sub && sub.id;
  const pollUrl = (sub && sub.polling_url) || (BFL_BASE + '/v1/get_result?id=' + encodeURIComponent(id || ''));
  if (!id) throw new Error('BFL 提交响应里没有 id：' + JSON.stringify(sub || {}).slice(0, 200));
  for (;;) {
    await delay(BFL_POLL_MS);
    const r = await requestJson(pollUrl, { headers: { 'x-key': key, accept: 'application/json' }, timeoutMs: 20000 });
    const st = String((r && r.status) || '');
    if (st === 'Ready') {
      const sample = r.result && r.result.sample;
      if (!sample) throw new Error('BFL Ready 但没有 result.sample');
      return { sampleUrl: String(sample), cost: Number(r.cost) || Number(sub.cost) || 0, id, model, ms: Date.now() - t0 };
    }
    if (st === 'Error' || st === 'Task not found') {
      const e = new Error('BFL 生成失败：' + st + ' ' + JSON.stringify(r.details || r.result || {}).slice(0, 200));
      e.status = 502; // 上游问题，允许外层重试
      throw e;
    }
    if (st === 'Request Moderated' || st === 'Content Moderated') {
      const e = new Error('BFL 审核拦下：' + st + ' ' + JSON.stringify(r.details || {}).slice(0, 200));
      e.status = 422; // prompt 的问题，不重试，让质检改 prompt
      throw e;
    }
    if (Date.now() - t0 > BFL_POLL_BUDGET_MS) {
      const e = new Error('BFL 轮询超过 ' + BFL_POLL_BUDGET_MS / 1000 + ' 秒仍是 ' + st);
      e.status = 504;
      throw e;
    }
  }
}

/**
 * 走 bfl 出一张并回传平台，返回和 client.generateImage 同形的 { url, provider, cost, model }。
 * url 是平台 /assets 路径，下游按原来的方式 origin + url 下载。
 */
async function generateViaBfl(cfg, client, prompt, opts = {}) {
  const gen = opts.provider === 'replicate' ? await replicateGenerate(cfg, prompt, opts) : await bflGenerate(cfg, prompt, opts);
  const tmp = opts.tmpPath || path.join(require('os').tmpdir(), 'bfl-' + gen.id + '.jpg');
  await downloadTo(gen.sampleUrl, tmp, { maxBytes: opts.maxBytes || 8 * 1024 * 1024, timeoutMs: 60000 });
  const slug = String(prompt || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'image';
  const named = path.join(path.dirname(tmp), Date.now() + '-flux2-' + slug + '.jpg');
  fs.renameSync(tmp, named);
  try {
    const up = await client.uploadAsset(named, 'image/jpeg');
    return { url: up.url, provider: opts.provider === 'replicate' ? 'replicate' : 'bfl', cost: gen.cost, model: gen.model, ms: gen.ms, predictSec: gen.predictSec || 0, localPath: named };
  } finally {
    /* 本地副本留给调用方决定删不删；runImageStage 会再下一次到 tmpDir，这里不管 */
  }
}

/** 统一入口：按 provider 出一张。webforger 路保持原样。 */
async function generateOne(cfg, client, prompt, opts = {}) {
  const provider = opts.provider || pickProvider(cfg, opts.workspaceSlug, opts.log);
  if (provider === 'bfl' || provider === 'replicate') return generateViaBfl(cfg, client, prompt, Object.assign({}, opts, { provider }));
  const r = await client.generateImage(prompt, { timeoutMs: opts.timeoutMs });
  return Object.assign({ provider: 'webforger', cost: 0, model: 'flux-1.1-pro(replicate)' }, r);
}

module.exports = { pickProvider, bflGenerate, replicateGenerate, generateViaBfl, generateOne, BFL_MODELS, BFL_BASE, REPLICATE_MODELS, REPLICATE_BASE, WIDTH, HEIGHT };
