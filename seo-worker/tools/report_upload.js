#!/usr/bin/env node
'use strict';
// report_upload — 把本地报告草稿 / Excel / 任意交付文件同步到报告服务器并回打印对外链接。
// 补执行器（2026-11-03 Louvresky #1794）：此前月报修订的产物只能人工 scp 上传，
// agent 泳道没有可调的登记命令。通道与权限复用 lib/publish（ssh Host 别名，无明文凭据）。
//
// 用法：node tools/report_upload.js <client_slug> <local_file> [--name 远端文件名] [--subdir 子目录]
//   client_slug  客户目录名（与工作区 clients/<slug> 同源），走白名单字符校验
//   local_file   本地文件绝对路径或相对当前目录
//   --name       远端文件名，缺省用本地文件名（同样过白名单校验）
//   --subdir     客户目录下的子目录（如 qa），缺省直接落客户目录
// 成功输出一行 JSON：{"ok":true,"url":...,"remotePath":...}，失败非零退出。

const path = require('node:path');
const fs = require('node:fs');
const { publishFile } = require('../lib/publish');

function parseArgs(argv) {
  const pos = [];
  const opt = { name: '', subdir: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--name') { opt.name = String(argv[i + 1] || ''); i += 1; }
    else if (a === '--subdir') { opt.subdir = String(argv[i + 1] || ''); i += 1; }
    else pos.push(a);
  }
  return { pos, opt };
}

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2));
  const [slug, localArg] = pos;
  if (!slug || !localArg) {
    console.error('用法：node tools/report_upload.js <client_slug> <local_file> [--name 远端文件名] [--subdir 子目录]');
    process.exit(2);
  }
  const localPath = path.resolve(localArg);
  if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) {
    console.error('本地文件不存在或不是文件：' + localPath);
    process.exit(2);
  }
  const filename = opt.name || path.basename(localPath);
  // 配置晚加载：找不到 config.json 时报参数用法以外的事，别在 require 期就炸
  const cfg = require('../lib/config').load();
  const res = await publishFile(cfg, slug, opt.subdir, filename, localPath, (s) => console.error(s));
  console.log(JSON.stringify({ ok: true, url: res.url, remotePath: res.remotePath }));
}

main().catch((e) => { console.error('上传失败：' + e.message); process.exit(1); });
