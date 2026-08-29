'use strict';
// lib/imagegen.js：provider 选择与 BFL 轮询协议，用假 http 跑，不出网。
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const httpPath = require.resolve('../seo-worker/lib/http');
const http = require(httpPath);
const calls = [];
let pollHits = 0;
let script = {};
http.requestJson = async (url, opts = {}) => {
  calls.push({ url, method: opts.method || 'GET', headers: opts.headers, body: opts.body });
  if (/\/v1\/flux-2-/.test(url)) {
    assert.strictEqual(opts.headers['x-key'], 'k-test');
    assert.strictEqual(opts.body.width, 1280);
    assert.strictEqual(opts.body.height, 720);
    return { id: 'job1', polling_url: 'https://api.bfl.ai/v1/get_result?id=job1', cost: 3 };
  }
  if (/api\.replicate\.com\/v1\/models\//.test(url)) {
    assert.strictEqual(opts.headers.Authorization, 'Bearer r-test');
    assert.strictEqual(opts.headers.Prefer, 'wait=60');
    assert.strictEqual(opts.body.input.aspect_ratio, '16:9');
    return script.replicateSubmit();
  }
  if (/api\.replicate\.com\/v1\/predictions\//.test(url)) {
    pollHits += 1;
    return script.replicatePoll(pollHits);
  }
  if (/get_result/.test(url)) {
    pollHits += 1;
    return script.poll(pollHits);
  }
  throw new Error('unexpected url ' + url);
};
http.downloadTo = async (url, dest) => { fs.writeFileSync(dest, 'jpg'); return { bytes: 3 }; };

const imagegen = require('../seo-worker/lib/imagegen');

(async () => {
  // provider 选择
  assert.strictEqual(imagegen.pickProvider({}, 'x'), 'webforger');
  assert.strictEqual(imagegen.pickProvider({ imageProvider: 'bfl', bflApiKey: 'k' }, 'x'), 'bfl');
  assert.strictEqual(imagegen.pickProvider({ imageProvider: 'bfl' }, 'x'), 'webforger', 'key 没配回落');
  assert.strictEqual(imagegen.pickProvider({ bflApiKey: 'k', bflCanaryClients: ['kuddles'] }, 'kuddles'), 'bfl', 'canary 名单强制 bfl');
  assert.strictEqual(imagegen.pickProvider({ bflApiKey: 'k', bflCanaryClients: ['kuddles'] }, 'louvresky'), 'webforger');

  // Pending -> Ready
  script.poll = (n) => (n < 2 ? { status: 'Pending' } : { status: 'Ready', result: { sample: 'https://x/s.jpg' }, cost: 3 });
  const g = await imagegen.bflGenerate({ bflApiKey: 'k-test', bflModel: 'flux-2-pro' }, 'a room');
  assert.strictEqual(g.sampleUrl, 'https://x/s.jpg');
  assert.strictEqual(g.cost, 3);
  assert.strictEqual(g.model, 'flux-2-pro');
  assert.ok(calls[0].url.endsWith('/v1/flux-2-pro'));

  // Moderated -> 4xx 语义，不重试
  pollHits = 0; script.poll = () => ({ status: 'Content Moderated', details: { r: 'x' } });
  await assert.rejects(imagegen.bflGenerate({ bflApiKey: 'k-test' }, 'p'), (e) => e.status === 422);

  // Error -> 5xx 语义，允许外层重试
  pollHits = 0; script.poll = () => ({ status: 'Error' });
  await assert.rejects(imagegen.bflGenerate({ bflApiKey: 'k-test' }, 'p'), (e) => e.status === 502);

  // 未知型号直接拒
  await assert.rejects(imagegen.bflGenerate({ bflApiKey: 'k-test', bflModel: 'flux-9' }, 'p'), /未知的 BFL 型号/);

  // generateViaBfl：下载后 uploadAsset 回平台，返回平台 url
  pollHits = 0; script.poll = () => ({ status: 'Ready', result: { sample: 'https://x/s.jpg' }, cost: 3 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'imagegen-'));
  const client = { uploadAsset: async (p) => { assert.ok(fs.existsSync(p)); return { url: '/assets/1-flux2-x.jpg' }; } };
  const r = await imagegen.generateOne({ bflApiKey: 'k-test' }, client, 'a room', { provider: 'bfl', tmpPath: path.join(tmp, 'a.jpg') });
  assert.strictEqual(r.url, '/assets/1-flux2-x.jpg');
  assert.strictEqual(r.provider, 'bfl');

  // webforger 路原样
  const wf = { generateImage: async () => ({ url: '/assets/old.jpg' }) };
  const w = await imagegen.generateOne({}, wf, 'a room', { workspaceSlug: 'x' });
  assert.strictEqual(w.provider, 'webforger');
  assert.strictEqual(w.url, '/assets/old.jpg');

  // replicate：provider 选择
  assert.strictEqual(imagegen.pickProvider({ imageProvider: 'replicate' }, 'x'), 'webforger', 'token 没配回落');
  assert.strictEqual(imagegen.pickProvider({ imageProvider: 'replicate', replicateApiToken: 't' }, 'x'), 'replicate');
  assert.strictEqual(imagegen.pickProvider({ replicateApiToken: 't', imageCanaryClients: ['kuddles'] }, 'kuddles'), 'replicate', 'canary 默认 replicate');
  assert.strictEqual(imagegen.pickProvider({ replicateApiToken: 't', imageCanaryClients: ['kuddles'] }, 'louvresky'), 'webforger');
  assert.strictEqual(imagegen.pickProvider({ bflApiKey: 'k', bflCanaryClients: ['kuddles'] }, 'kuddles'), 'bfl', '旧字段 bflCanaryClients 仍认');

  // replicate：Prefer wait 一次到位
  script.replicateSubmit = () => ({ id: 'p1', status: 'succeeded', output: ['https://r/1.jpg'], metrics: { predict_time: 4.2 }, urls: { get: 'https://api.replicate.com/v1/predictions/p1' } });
  const r1 = await imagegen.replicateGenerate({ replicateApiToken: 'r-test' }, 'a room', { model: 'flux-1.1-pro' });
  assert.strictEqual(r1.sampleUrl, 'https://r/1.jpg');
  assert.strictEqual(r1.model, 'black-forest-labs/flux-1.1-pro');
  assert.strictEqual(r1.predictSec, 4.2);

  // replicate：没等到就轮询，output 是单字符串
  pollHits = 0;
  script.replicateSubmit = () => ({ id: 'p2', status: 'processing', urls: { get: 'https://api.replicate.com/v1/predictions/p2' } });
  script.replicatePoll = (n) => (n < 2 ? { id: 'p2', status: 'processing' } : { id: 'p2', status: 'succeeded', output: 'https://r/2.jpg' });
  const r2 = await imagegen.replicateGenerate({ replicateApiToken: 'r-test', replicateModel: 'flux-2-klein-9b' }, 'a room');
  assert.strictEqual(r2.sampleUrl, 'https://r/2.jpg');
  assert.strictEqual(r2.model, 'black-forest-labs/flux-2-klein-9b');

  // replicate：失败分类
  script.replicateSubmit = () => ({ id: 'p3', status: 'failed', error: 'NSFW content detected' });
  await assert.rejects(imagegen.replicateGenerate({ replicateApiToken: 'r-test' }, 'p'), (e) => e.status === 422);
  script.replicateSubmit = () => ({ id: 'p4', status: 'failed', error: 'CUDA out of memory' });
  await assert.rejects(imagegen.replicateGenerate({ replicateApiToken: 'r-test' }, 'p'), (e) => e.status === 502);
  await assert.rejects(imagegen.replicateGenerate({ replicateApiToken: 'r-test' }, 'p', { model: 'nope' }), /未知的 Replicate 型号/);

  // replicate 经 generateOne 回传平台
  script.replicateSubmit = () => ({ id: 'p5', status: 'succeeded', output: ['https://r/5.jpg'] });
  const r5 = await imagegen.generateOne({ replicateApiToken: 'r-test' }, client, 'a room', { provider: 'replicate', tmpPath: path.join(tmp, 'b.jpg') });
  assert.strictEqual(r5.provider, 'replicate');
  assert.strictEqual(r5.url, '/assets/1-flux2-x.jpg');

  console.log('imagegen.test.js ok');
})().catch((e) => { console.error(e); process.exit(1); });
