#!/usr/bin/env node
'use strict';
// 配图源对比：同一条 prompt 分别用平台 FLUX 1.1 Pro 和 BFL 各型号各出一张，图存本地目录，打印耗时与费用。
// 灰度升级前先用博客产线真实 prompt 跑几条（从 job 日志「调 FLUX，prompt」附近拿），人眼看一遍再决定放哪几家进 canary。
//   SEO_WORKER_CONFIG=/data/aira/seo-worker/config.json BFL_API_KEY=... \
//   node tools/image_bench.js --workspace /data/aira/clients/benscurtainsnz \
//     --models flux-2-pro,flux-2-klein-9b [--no-wf] [--out /tmp/bench] "<prompt>" ["<prompt 2>" ...]
// 不经过质检，不写任务，不回传平台（--wf 的平台图本来就在平台 /assets 里）。

const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
const imagegen = require('../lib/imagegen');
const { downloadTo } = require('../lib/http');

const argv = process.argv.slice(2);
function opt(name, dflt) { const i = argv.indexOf('--' + name); return i === -1 ? dflt : argv[i + 1]; }
const NO_WF = argv.includes('--no-wf');
const workspace = opt('workspace', '');
const models = String(opt('models', 'flux-2-pro')).split(',').map((s) => s.trim()).filter(Boolean);
const out = opt('out', path.join(process.env.TMPDIR || '/tmp', 'image-bench-' + Date.now()));
const VALUED = ['--workspace', '--models', '--out'];
const prompts = [];
for (let i = 0; i < argv.length; i += 1) {
  if (VALUED.includes(argv[i])) { i += 1; continue; }
  if (argv[i].startsWith('--')) continue;
  prompts.push(argv[i]);
}
if (!prompts.length) { console.error('要至少一条 prompt'); process.exit(2); }

const cfg = config.load();
fs.mkdirSync(out, { recursive: true });
const ts = () => new Date().toISOString().slice(11, 19);

async function wfClient() {
  const wf = require('../lib/webforger');
  const cred = wf.readCredentials(path.join(workspace, 'notes', 'webforger_credentials.md'));
  const c = new wf.WebForger({ base: cfg.webforgerApi, timeoutMs: cfg.httpTimeoutMs });
  const who = await c.login(cred.email, cred.password);
  console.log('已登录 WebForger，siteId ' + who.siteId);
  return c;
}

(async () => {
  const rows = [];
  let client = null;
  if (!NO_WF) {
    if (!workspace) { console.error('平台对比要 --workspace（读 notes/webforger_credentials.md）；不比平台加 --no-wf'); process.exit(2); }
    client = await wfClient();
  }
  for (let pi = 0; pi < prompts.length; pi += 1) {
    const prompt = prompts[pi];
    console.log('\n[' + ts() + '] prompt ' + (pi + 1) + ': ' + prompt.slice(0, 120));
    if (client) {
      const t0 = Date.now();
      try {
        const r = await client.generateImage(prompt, { timeoutMs: 150000 });
        const origin = new URL(client.base).origin;
        const dest = path.join(out, 'p' + (pi + 1) + '-webforger.jpg');
        await downloadTo(r.url.startsWith('http') ? r.url : origin + r.url, dest, { maxBytes: 8 * 1024 * 1024 });
        rows.push({ prompt: pi + 1, provider: 'webforger', model: 'flux-1.1-pro', ms: Date.now() - t0, cost_usd: 0, file: dest });
        console.log('  webforger  ' + Math.round((Date.now() - t0) / 1000) + 's  ' + dest);
      } catch (e) { rows.push({ prompt: pi + 1, provider: 'webforger', error: e.message }); console.log('  webforger  失败 ' + e.message); }
    }
    for (const model of models) {
      try {
        const g = await imagegen.bflGenerate(cfg, prompt, { model });
        const dest = path.join(out, 'p' + (pi + 1) + '-' + model + '.jpg');
        await downloadTo(g.sampleUrl, dest, { maxBytes: 8 * 1024 * 1024 });
        const usd = (g.cost || 0) / 100;
        rows.push({ prompt: pi + 1, provider: 'bfl', model, ms: g.ms, cost_usd: usd, file: dest });
        console.log('  ' + model.padEnd(16) + Math.round(g.ms / 1000) + 's  $' + usd.toFixed(3) + '  ' + dest);
      } catch (e) { rows.push({ prompt: pi + 1, provider: 'bfl', model, error: e.message }); console.log('  ' + model.padEnd(16) + '失败 ' + e.message); }
    }
  }
  fs.writeFileSync(path.join(out, 'bench.json'), JSON.stringify({ prompts, rows }, null, 2));
  console.log('\n结果目录 ' + out + '，bench.json 有明细。看图用：ls ' + out);
})().catch((e) => { console.error('bench 中止：' + e.message); process.exit(1); });
