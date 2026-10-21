#!/usr/bin/env node
'use strict';
/* Style Roll 存量清扫（2026-10-21 Alvin 批，spotcheck 首轮 FAIL 的处置件）。
   背景：d741524 起写回平台前统一剥 Style Roll 注释（带外化），但历史上走博客产线的文章
   （含已发布）源码里还挂着注释，spotcheck 首轮在 horntech AU 与 Ben's NZ 实证跨客户泄漏。
   本工具做且只做一件事：全部 active WebForger 客户的博文，剥掉 Style Roll 注释写回。

   安全边界：
   - strip-only 外科手术：新正文 = styleroll.stripRollComment(旧正文)，别的字段一概不传。
   - 剥之前把注释原文存进带外记录 seo-agent-output/styleroll/<slug>.json（与 execute 同格式），
     改稿轮的骨架延续不因清扫断档；已有记录不覆盖。
   - 写回后回读验证：Style Roll 标记必须为 0，否则记 FAIL（不重试，留人看）。
   - 逐篇台账：client/slug/status/前后长度/前后 sha256，落 memory/spotcheck/sweep_*.md。
   - published 的 PATCH 即时生效（Alvin 已批：注释不渲染，读者无感知）；draft 的 PATCH
     不轮换 preview token（平台契约）。
   - 默认 dry-run 只列命中，--apply 才写。人触发，一次性工具，跑完留档不进 cron。

   用法：SEO_AGENT_TOKEN=... node tools/styleroll_sweep.js [--client <id>] [--apply] */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const wf = require('../lib/webforger');
const styleroll = require('../lib/styleroll');

const API = process.env.SEO_API_BASE || 'https://always.horntech-dev.com/seo-api.php';
const TOKEN = process.env.SEO_AGENT_TOKEN || '';
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const ONLY_CLIENT = (() => { const i = argv.indexOf('--client'); return i === -1 ? 0 : parseInt(argv[i + 1], 10) || 0; })();
if (!TOKEN) { console.error('用法：SEO_AGENT_TOKEN=... node tools/styleroll_sweep.js [--client N] [--apply]'); process.exit(2); }

const WF_API = 'https://api.webforger.ai';
const WORKSPACE_ROOT = '/data/aira/clients';
const MARK_RE = /<!--\s*Style Roll/i;

async function call(p) {
  const r = await fetch(API + p, { headers: { Authorization: 'Bearer ' + TOKEN } });
  if (!r.ok) throw new Error('GET ' + p + ' -> ' + r.status);
  return r.json();
}

function sha(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16); }

function saveRollRecord(workspace, slug, body) {
  try {
    const m = String(body).match(/<!--\s*Style Roll:[\s\S]*?-->/);
    if (!m) return;
    const dir = path.join(workspace, 'seo-agent-output', 'styleroll');
    const safe = String(slug || '').replace(/[^a-z0-9-]/gi, '_');
    const f = path.join(dir, safe + '.json');
    if (fs.existsSync(f)) return; // execute 写过的更权威，不覆盖
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ slug, comment: m[0], task_id: 'styleroll_sweep', ts: new Date().toISOString() }, null, 1), 'utf8');
  } catch (e) { /* 记录失败不挡清扫，改稿轮会按新 roll 走 */ }
}

(async () => {
  const clients = (await call('/clients')).clients.filter(
    (c) => c.status === 'active' && /webforger/i.test(String(c.platform || '')) && (!ONLY_CLIENT || c.client_id === ONLY_CLIENT)
  );
  console.log('active WebForger 客户 ' + clients.length + ' 个' + (APPLY ? '' : '（dry-run，只列命中不写回）'));
  const lines = [];
  let hit = 0, cleaned = 0, failed = 0, skippedClients = 0;
  for (const c of clients) {
    let prof;
    try { prof = (await call('/profile?client_id=' + c.client_id)).profile || {}; } catch (e) { prof = {}; }
    const wsDir = String(prof.workspace_dir || '').trim();
    const workspace = wsDir ? path.join(WORKSPACE_ROOT, wsDir) : '';
    const credFile = workspace ? path.join(workspace, 'notes', 'webforger_credentials.md') : '';
    if (!credFile || !fs.existsSync(credFile)) {
      console.log('[skip] ' + c.name + '：无 webforger_credentials.md（workspace=' + (wsDir || '缺') + '）');
      lines.push('- skip ' + c.name + '：无凭据文件');
      skippedClients++;
      continue;
    }
    let client;
    try {
      const cred = wf.readCredentials(credFile);
      client = new wf.WebForger({ base: WF_API, timeoutMs: 30000 });
      await client.login(cred.email, cred.password);
    } catch (e) {
      console.log('[skip] ' + c.name + '：登录失败 ' + e.message.slice(0, 80));
      lines.push('- skip ' + c.name + '：登录失败 ' + e.message.slice(0, 80));
      skippedClients++;
      continue;
    }
    let posts = [];
    try { posts = await client.listPosts(); } catch (e) { posts = []; }
    for (const p of posts) {
      const slug = String(p.slug || '');
      if (!slug) continue;
      let got;
      try { got = await client.getPost(slug); } catch (e) { continue; }
      const post = (got && got.post) || {};
      const body = String(post.body || '');
      if (!MARK_RE.test(body)) continue;
      hit++;
      const status = String(post.status || '');
      const newBody = styleroll.stripRollComment(body);
      const row = c.name + ' / ' + slug + '（' + status + '）len ' + body.length + '->' + newBody.length + ' sha ' + sha(body) + '->' + sha(newBody);
      if (!APPLY) { console.log('[hit] ' + row); lines.push('- hit ' + row); continue; }
      saveRollRecord(workspace, slug, body);
      try {
        await client.patchPost(slug, { body: newBody });
        const back = await client.getPost(slug);
        const after = String(((back && back.post) || {}).body || '');
        if (MARK_RE.test(after)) {
          failed++;
          console.log('[FAIL] ' + row + ' 写回后标记仍在');
          lines.push('- FAIL ' + row + ' 写回后标记仍在，留人');
        } else {
          cleaned++;
          console.log('[ok] ' + row);
          lines.push('- ok ' + row + ' 回读标记 0');
        }
      } catch (e) {
        failed++;
        console.log('[FAIL] ' + row + ' PATCH 异常 ' + e.message.slice(0, 80));
        lines.push('- FAIL ' + row + ' PATCH 异常 ' + e.message.slice(0, 80));
      }
    }
  }
  const dir = '/data/aira/projects/MA/memory/spotcheck';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'sweep_styleroll_' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.md');
  fs.writeFileSync(file, [
    '# Style Roll 存量清扫台账 ' + new Date().toISOString(),
    'apply=' + APPLY + (ONLY_CLIENT ? ' client=' + ONLY_CLIENT : '') + '，客户 ' + clients.length + '（skip ' + skippedClients + '），命中 ' + hit + '，清净 ' + cleaned + '，FAIL ' + failed,
    '',
    lines.join('\n'),
  ].join('\n'), 'utf8');
  console.log('\n汇总：命中 ' + hit + '，清净 ' + cleaned + '，FAIL ' + failed + '，skip 客户 ' + skippedClients + '。台账 ' + file);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error('sweep 异常退出：' + e.message); process.exit(2); });
