'use strict';
// Task deliverables: files a human has to hand carry into a system we have no
// API for, a disavow txt destined for Search Console being the usual case.
//
// The runner leaves them in the task's own output directory,
//   {workspace}/seo-agent-output/task-{id}/
// and this module pushes whatever is in there up to the board, where the card
// turns them into download links.
//
// This is an enhancement, never a critical path. Every failure in here is a log
// line and nothing else: a task that did its real work must not be marked
// failed because an upload timed out.

const fs = require('node:fs');
const path = require('node:path');

const OUTPUT_DIRNAME = 'seo-agent-output';
const TASK_DIR_PREFIX = 'task-';

// Must stay in step with DELIVERABLE_EXTS in seo-api.php. A file the server
// would refuse is not worth the round trip.
const ALLOWED_EXTS = ['.txt', '.csv', '.md', '.pdf', '.json'];
const MAX_BYTES = 5 * 1024 * 1024;
// A sane ceiling on one task's output. Anything past this is a runaway loop
// writing files, not a deliverable set, and the board should not swallow it.
const MAX_FILES = 20;

const CONTENT_TYPES = {
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
};

/** {workspace}/seo-agent-output/task-{id} */
function taskDeliverableDir(workspace, taskId) {
  return path.join(workspace, OUTPUT_DIRNAME, TASK_DIR_PREFIX + String(taskId));
}

/** Create the directory so a runner can point the agent at a path that exists. */
function ensureTaskDeliverableDir(workspace, taskId) {
  const dir = taskDeliverableDir(workspace, taskId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function contentTypeFor(name) {
  return CONTENT_TYPES[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';
}

/**
 * The upload candidates in one directory, plus the reasons anything was left
 * behind. Top level only: a subdirectory in there is scratch space, not a
 * deliverable, and recursing would sweep up whatever an agent felt like saving.
 * Returns { files: [{ name, full, bytes }], skipped: ['name: reason'] }.
 */
function listDeliverables(dir) {
  const out = { files: [], skipped: [] };
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return out; // no directory means no deliverables, which is the normal case
  }
  entries
    .slice()
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .forEach((ent) => {
      const name = ent.name;
      if (!ent.isFile()) {
        if (ent.isDirectory()) out.skipped.push(name + '：是子目录，不上传');
        return;
      }
      if (name.charAt(0) === '.') return; // dotfiles are never a deliverable
      const ext = path.extname(name).toLowerCase();
      if (ALLOWED_EXTS.indexOf(ext) === -1) {
        out.skipped.push(name + '：扩展名不在白名单 ' + ALLOWED_EXTS.join(' ') + ' 内');
        return;
      }
      const full = path.join(dir, name);
      let st;
      try {
        st = fs.statSync(full);
      } catch (e) {
        out.skipped.push(name + '：读不到文件状态 :: ' + e.message);
        return;
      }
      if (st.size <= 0) {
        out.skipped.push(name + '：空文件');
        return;
      }
      if (st.size > MAX_BYTES) {
        out.skipped.push(name + '：' + Math.round(st.size / 1024) + 'KB，超过 5MB 上限');
        return;
      }
      out.files.push({ name, full, bytes: st.size });
    });
  if (out.files.length > MAX_FILES) {
    out.files.slice(MAX_FILES).forEach((f) => {
      out.skipped.push(f.name + '：单任务交付文件超过 ' + MAX_FILES + ' 个，未上传');
    });
    out.files = out.files.slice(0, MAX_FILES);
  }
  return out;
}

/**
 * Scan one task's deliverable directory and upload everything in it.
 * ctx is the runner context, it needs api and log.
 * Never throws. Returns { dir, uploaded: [...], skipped: [...], failed: [...] }.
 */
async function uploadTaskDeliverables(ctx, taskId, workspace) {
  const { api, log } = ctx;
  const result = { dir: null, uploaded: [], skipped: [], failed: [] };
  try {
    if (!workspace) {
      log('task ' + taskId + '：交付文件跳过，没有拿到工作目录');
      return result;
    }
    const dir = taskDeliverableDir(workspace, taskId);
    result.dir = dir;
    const found = listDeliverables(dir);
    result.skipped = found.skipped;
    found.skipped.forEach((s) => log('task ' + taskId + '：交付文件忽略 ' + s));
    if (!found.files.length) return result;
    log('task ' + taskId + '：发现 ' + found.files.length + ' 个交付文件，开始上传 ' + dir);
    for (const f of found.files) {
      try {
        const buf = fs.readFileSync(f.full);
        const r = await api.uploadTaskDeliverable(taskId, {
          filename: f.name,
          contentType: contentTypeFor(f.name),
          buffer: buf,
        });
        result.uploaded.push(f.name);
        const replaced = r && r.replaced ? '，替换了 ' + r.replaced + ' 份旧文件' : '';
        log('task ' + taskId + '：交付文件已上传 ' + f.name + '（' + f.bytes + ' 字节）' + replaced);
        if (r && r.orphan_files && r.orphan_files.length) {
          // The old physical file belongs to the www user and this API could
          // not remove it. The row is gone so nothing shows it on the board.
          log(
            'task ' + taskId + '：旧交付文件删不掉，已从看板下架但磁盘上还在，需要时手工清理 ' +
              r.orphan_files.join('、')
          );
        }
      } catch (e) {
        result.failed.push(f.name);
        log('警告：task ' + taskId + ' 交付文件上传失败 ' + f.name + ' :: ' + e.message);
      }
    }
  } catch (e) {
    log('警告：task ' + taskId + ' 交付文件处理失败，任务收尾不受影响 :: ' + e.message);
  }
  return result;
}

module.exports = {
  uploadTaskDeliverables,
  listDeliverables,
  taskDeliverableDir,
  ensureTaskDeliverableDir,
  contentTypeFor,
  OUTPUT_DIRNAME,
  TASK_DIR_PREFIX,
  ALLOWED_EXTS,
  MAX_BYTES,
  MAX_FILES,
};
