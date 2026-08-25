'use strict';
// 报告成品上传到 250。三步：建目录、传文件、改权限。
//
// 与 lib/deliverables.js 的「上传失败也不炸 job」相反，这里失败必须抛错：
// 报告的交付物就是那条链接，传不上去等于没交付，让 job 挂掉比留一条
// 指向 404 的链接强。
//
// 通道是 root 的 ssh Host 别名（默认 blogpreview，见 cfg.reportSsh），
// 与 lib/seoq.js 走 seoqSsh 是同一套路，密钥在 ~/.ssh/config 里，
// 代码里不出现主机、账号与口令。

// 用模块对象而不是解构，单测要能把 execFile 换成假的。
const cp = require('node:child_process');
const path = require('node:path');

const SSH_TIMEOUT_MS = 120000;

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    cp.execFile(bin, args, { timeout: timeoutMs || SSH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '').replace(/\s+/g, ' ').slice(0, 400);
        reject(new Error(bin + ' ' + args.slice(0, 2).join(' ') + ' 失败：' + msg));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** slug 与文件名都要进 shell 命令，这里只放白名单字符，其余一律拒。 */
function assertSafeName(name, what) {
  const s = String(name || '');
  if (!s || !/^[A-Za-z0-9._-]+$/.test(s)) {
    throw new Error(what + ' 含不安全字符或为空，拒绝上传：' + JSON.stringify(name));
  }
  return s;
}

/**
 * 把一个本地文件传到 250 的 {reportRemoteRoot}/{slug}[/{subdir}]/ 下并返回对外链接。
 * 报告走 subdir 为空，apply 的改前存档走 subdir='qa'，通道与权限完全一样。
 * cfg       需要 reportSsh、reportRemoteRoot、reportUrlBase
 * slug      客户目录名，与工作区目录同源（clientDirName）
 * subdir    客户目录下的子目录名，空字符串表示直接落在客户目录里
 * filename  远端文件名，例如 seo_report_2026-08_v1.html
 * localPath 本地文件绝对路径
 * log       ctx.log
 * 返回 { url, remotePath, remoteDir }
 */
async function publishFile(cfg, slug, subdir, filename, localPath, log) {
  const say = log || function () {};
  const dirName = assertSafeName(slug, 'slug');
  const fileName = assertSafeName(filename, '文件名');
  const sub = String(subdir || '').trim();
  const subName = sub ? assertSafeName(sub, '子目录名') : '';
  const host = String(cfg.reportSsh || 'blogpreview');
  const rel = dirName + (subName ? '/' + subName : '');
  const remoteDir = String(cfg.reportRemoteRoot || '').replace(/\/+$/, '') + '/' + rel;
  const remotePath = remoteDir + '/' + fileName;
  const url = String(cfg.reportUrlBase || '').replace(/\/+$/, '') + '/' + rel + '/' + fileName;

  say('publish: 建目录 ' + remoteDir);
  await run('ssh', ['-o', 'BatchMode=yes', host, 'mkdir -p ' + remoteDir + ' && chmod 755 ' + remoteDir]);

  say('publish: 上传 ' + path.basename(localPath) + ' 到 ' + host);
  await run('scp', ['-o', 'BatchMode=yes', '-q', localPath, host + ':' + remotePath]);

  await run('ssh', ['-o', 'BatchMode=yes', host, 'chmod 644 ' + remotePath]);
  say('publish: 完成，对外链接 ' + url);

  return { url, remotePath, remoteDir };
}

/**
 * 把一个本地报告文件传到 250 并返回对外链接。
 * 参数与返回值不变，内部改走 publishFile（subdir 为空），行为逐字一致。
 */
async function publishReport(cfg, slug, filename, localPath, log) {
  return publishFile(cfg, slug, '', filename, localPath, log);
}

module.exports = { publishReport, publishFile, assertSafeName };
