'use strict';
/* NFS 写盘重试（2026-10-28，agent 工单首轮复盘定修）：Mac worker 往 /data/aira（网络卷）
   写产出文件偶发 ETIMEDOUT，LLM 活干完了最后一步写盘报废整单（job 8068 跑 943s 出 2.8 万字、
   9748 跑 560s 出 5.9 万字，全折在 writeFileSync 上）。修法不是重跑而是别丢：
   同步重试三次退避，仍失败把内容抢救到本机盘 SALVAGE_DIR 再抛错，错误信息带抢救路径，
   人工或重排时可直接回捞，不再重烧 token。零依赖零闸：只包写这一下，不改任何语义。 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const SALVAGE_DIR = path.join(os.tmpdir(), 'seo-worker-salvage');
const BACKOFF_MS = [2000, 8000, 20000];

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { const end = Date.now() + ms; while (Date.now() < end) { /* 退化忙等，仅重试间隙 */ } }
}

function writeFileRetry(file, data, opts) {
  let lastErr = null;
  for (let i = 0; i <= BACKOFF_MS.length; i++) {
    try { fs.writeFileSync(file, data, opts); return; }
    catch (e) {
      lastErr = e;
      /* 只对瞬态 IO 错误重试；路径类错误（ENOENT 父目录缺、EACCES）重试无意义，直接走抢救与抛错 */
      if (['ETIMEDOUT', 'EIO', 'EAGAIN', 'EBUSY', 'ESTALE', 'ENOTCONN'].indexOf(String(e.code)) === -1) break;
      if (i < BACKOFF_MS.length) sleepSync(BACKOFF_MS[i]);
    }
  }
  let salvage = '';
  try {
    fs.mkdirSync(SALVAGE_DIR, { recursive: true });
    salvage = path.join(SALVAGE_DIR, Date.now() + '-' + path.basename(String(file)));
    fs.writeFileSync(salvage, data, opts);
  } catch (e2) { salvage = ''; }
  const err = new Error('writeFileRetry 耗尽重试仍失败：' + String(lastErr && lastErr.message || lastErr)
    + (salvage ? '；产出已抢救到本机 ' + salvage + '，重排前可直接回捞' : '；本机抢救也失败，产出已丢'));
  err.code = lastErr && lastErr.code;
  err.salvage = salvage;
  throw err;
}

module.exports = { writeFileRetry, SALVAGE_DIR };
