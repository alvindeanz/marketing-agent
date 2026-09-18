'use strict';
// resolveClaudeBin：配置路径存在直接用；不存在兜底 PATH/常见目录；全无返回 null。
// 2026-09-18 Apex job 981 事故的回归测试。样本路径与二进制名都取本机保证不存在的，
// 测试机是不是 ros、装没装真 claude 都不影响结果。
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveClaudeBin } = require('../seo-worker/lib/config');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claudebin-'));
const uniq = 'claude-test-' + process.pid;
const fake = path.join(tmp, uniq);
fs.writeFileSync(fake, '#!/bin/sh\n');
fs.chmodSync(fake, 0o755);
const gone = path.join('/nonexistent-machine/bin', uniq);
const oldPath = process.env.PATH;

// 1. 配置的绝对路径存在：原样返回，无 note。
let r = resolveClaudeBin(fake);
assert.ok(r && r.bin === fake && r.note === '', '存在的绝对路径应原样使用');

// 2. 配置了别的机器的绝对路径（本机不存在）：兜底到 PATH 里的同名文件。
process.env.PATH = tmp;
r = resolveClaudeBin(gone);
assert.ok(r && r.bin === fake && r.note.includes('兜底'), '失效绝对路径应兜底解析: ' + JSON.stringify(r));

// 3. 哪都没有：返回 null。
fs.rmSync(fake);
r = resolveClaudeBin(gone);
assert.strictEqual(r, null, '无处可寻应返回 null');

process.env.PATH = oldPath;
fs.rmSync(tmp, { recursive: true, force: true });
console.log('config_claudebin: ok');
