#!/usr/bin/env node
'use strict';
// 客户版交付物的返修发布（2026-09-17 midea S1 实证补的回程通道）。
//
// 背景：客户版 HTML 由 execute 经 lib/publish.js 的 scp 通道上 250，但
// /tasks/{id}/deliverables 端点只收 txt/csv/md/pdf/json。后检改完稿子想让
// 线上更新，此前只能读 publish.js 源码手拼 scp。改完本地文件不等于线上
// 改了（邻坑：2026-08-31 #145 内外链接混淆），所以这条命令把
// lint -> 发布 -> 回验 三步锁成一步。
//
// 用法：node tools/republish.js <clientDir> <filename> [--skip-lint]
//   <clientDir>  客户工作区目录名，如 midea（也是 250 上 reports/ 下的子目录）
//   <filename>   文件名，必须已存在于 /data/aira/clients/<clientDir>/reports/
// lint 出 FAIL 拒发（WARN 放行）；发布后 curl 回验 200 才算成功。

const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');
const { publishFile, injectCardToken } = require('../lib/publish');
const config = require('../lib/config');

const LINT = '/data/aira/scripts/deliverable_lint.py';
const CLIENTS_ROOT = '/data/aira/clients';

const argv = process.argv.slice(2);
const clientDir = String(argv[0] || '');
const filename = String(argv[1] || '');
const skipLint = argv.includes('--skip-lint');
const cardTask = (() => { const i = argv.indexOf('--card'); return i === -1 ? 0 : (parseInt(argv[i + 1], 10) || 0); })();

function die(msg) { console.error('republish: ' + msg); process.exit(2); }

if (!clientDir || !filename) die('用法：node tools/republish.js <clientDir> <filename> [--skip-lint] [--card <taskId>]');

const localPath = path.join(CLIENTS_ROOT, clientDir, 'reports', filename);
if (!fs.existsSync(localPath)) die('本地文件不存在：' + localPath);

// 1. lint。FAIL 拒发，WARN 放行但打印出来让人看见。
if (!skipLint && fs.existsSync(LINT) && /\.html?$/i.test(filename)) {
  let out = '';
  try {
    out = cp.execFileSync('python3', [LINT, localPath], { timeout: 120000 }).toString();
  } catch (e) {
    out = String((e.stdout || '') + (e.stderr || ''));
  }
  process.stdout.write(out);
  if (/^FAIL/m.test(out)) die('lint 有 FAIL，先修再发（确有理由跳过用 --skip-lint，理由自负）');
} else if (skipLint) {
  console.log('republish: 注意，--skip-lint 跳过检查');
}

// 2. 发布，走与 execute 完全相同的通道与权限。
(async () => {
  // 仓库工作区没有 config.json（那是部署产物的东西），发布只用得到
  // reportSsh / reportRemoteRoot / reportUrlBase 三个键，DEFAULTS 就够。
  let cfg;
  try { cfg = config.load(); } catch (e) { cfg = Object.assign({}, config.DEFAULTS); }
  /* --card <taskId>：发布客户卡时注入令牌自动补参（2026-09-21 取消预览模式），
     需要 serviceToken，所以要在部署目录（/data/aira/seo-worker）里跑。 */
  if (cardTask) {
    if (!cfg.serviceToken) die('--card 需要 serviceToken，请在 /data/aira/seo-worker 下跑本工具');
    const tok = injectCardToken(localPath, cardTask, cfg.serviceToken);
    if (!tok) die('--card 令牌注入失败（不是 HTML？）');
    console.log('republish: 已注入卡令牌（task ' + cardTask + '），裸链接将自动补参');
  }
  const res = await publishFile(cfg, clientDir, '', filename, localPath, (m) => console.log('republish: ' + m));

  // 3. 回验：线上 200 且字节数和本地同量级（scp 半途断掉会留残文件）。
  const localBytes = fs.statSync(localPath).size;
  const curl = cp.execFileSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code} %{size_download}',
    '--max-time', '30', '-A', 'Mozilla/5.0 (republish-check)', res.url], { timeout: 40000 }).toString().trim();
  const m = /^(\d{3}) (\d+)$/.exec(curl);
  if (!m || m[1] !== '200') die('回验失败：' + res.url + ' -> ' + curl);
  if (Math.abs(parseInt(m[2], 10) - localBytes) > localBytes * 0.05) {
    die('回验失败：线上 ' + m[2] + ' 字节 vs 本地 ' + localBytes + '，疑似残文件');
  }
  console.log('republish: 完成并回验 200，' + res.url);
})().catch((e) => die(e.message));
