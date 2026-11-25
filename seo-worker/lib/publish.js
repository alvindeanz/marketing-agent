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
const { writeFileRetry } = require('./fsretry');

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

/**
 * 卡页令牌自动补参（2026-09-21 Alvin 定「取消预览模式」）：往卡 HTML 里注入一行脚本，
 * 裸链接打开时自动 replace 成带 ?t=&k= 的链接，反馈按钮永远可用，预览降级分支永不触发。
 * 幂等：已注入的替换成最新令牌。返回令牌串；不是 HTML 或读写失败返回空串不炸调用方。
 */
function injectCardToken(localPath, taskId, serviceToken) {
  try {
    if (!/\.html?$/i.test(String(localPath)) || !taskId || !serviceToken) return '';
    const fs = require('node:fs');
    const crypto = require('node:crypto');
    const tok = crypto.createHash('md5').update('cardfb' + taskId + serviceToken).digest('hex');
    let html = fs.readFileSync(localPath, 'utf8');
    const tag = '<script data-card-autotoken>if(!new URLSearchParams(location.search).get("k"))location.replace(location.pathname+"?t=' + Number(taskId) + '&k=' + tok + '");</script>';
    if (html.indexOf('data-card-autotoken') !== -1) {
      html = html.replace(/<script data-card-autotoken>[\s\S]*?<\/script>/, tag);
    } else if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, tag + '\n</body>');
    } else {
      html += '\n' + tag + '\n';
    }
    writeFileRetry(localPath, html, 'utf8');
    return tok;
  } catch (e) { return ''; }
}

/**
 * 这页是不是反馈卡（2026-11-25 Alvin 定「报告在原链接上更新」）。卡页带反馈 widget，
 * 必须有 ?t=&k= 令牌才能提交；报告、月报这类成品页没有 widget，令牌尾巴只会让同一个
 * 页面每改一轮就多出一个「看着像新链接」的链接。判据：页面里有反馈通路 card_feedback。
 */
function isCardPage(localPath) {
  try {
    return require('node:fs').readFileSync(localPath, 'utf8').indexOf('card_feedback') !== -1;
  } catch (e) { return false; }
}

/**
 * 非卡页去掉自动补参脚本：agent 在上一版文件上原地改稿时，旧任务的补参脚本会跟着留在
 * 页面里，裸链接一打开又被 replace 成带尾巴的。幂等；读写失败不炸调用方。返回是否改了文件。
 */
function stripCardToken(localPath) {
  try {
    const fs = require('node:fs');
    const html = fs.readFileSync(localPath, 'utf8');
    if (html.indexOf('data-card-autotoken') === -1) return false;
    writeFileRetry(localPath, html.replace(/\n?<script data-card-autotoken>[\s\S]*?<\/script>/g, ''), 'utf8');
    return true;
  } catch (e) { return false; }
}

/**
 * 草稿地址跳到定稿（同日同令）：X.html 发布后，把线上的 X.draft.html 换成一页跳转，
 * 手里留着草稿旧链接的人打开看到的是定稿，不再是过期数字。只换线上那份，本地草稿原样留底。
 * 本地没有对应草稿就什么都不做，返回 null。
 */
async function publishDraftRedirect(cfg, slug, finalName, localDir, log) {
  const fs = require('node:fs');
  const os = require('node:os');
  if (/\.draft\.html$/i.test(finalName) || !/\.html$/i.test(finalName)) return null;
  const draftName = finalName.replace(/\.html$/i, '.draft.html');
  if (!fs.existsSync(path.join(localDir, draftName))) return null;
  const target = assertSafeName(finalName, '文件名');
  const stub = '<!doctype html>\n<html lang="zh"><head><meta charset="utf-8">\n'
    + '<meta name="robots" content="noindex,nofollow">\n'
    + '<meta http-equiv="refresh" content="0;url=' + target + '">\n'
    + '<title>已更新</title></head><body>\n'
    + '<p>这份草稿已有定稿，<a href="' + target + '">点这里打开最新版</a>。</p>\n'
    + '<script>location.replace("' + target + '");</script>\n</body></html>\n';
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'draft-redirect-')), draftName);
  fs.writeFileSync(tmp, stub, 'utf8');
  try {
    return await publishFile(cfg, slug, '', draftName, tmp, log);
  } finally {
    try { fs.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch (e) { /* 临时目录清不掉不碍事 */ }
  }
}

module.exports = { publishReport, publishFile, assertSafeName, injectCardToken, isCardPage, stripCardToken, publishDraftRedirect };
