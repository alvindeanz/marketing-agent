#!/usr/bin/env node
/* 会话压缩窗口切分（2026-10-23 降耗第二刀）。跑法：node tests/chat_window.test.js。零网络零模型。 */
const assert = require('assert');
const path = require('path');
const C = require(path.join(__dirname, '..', 'seo-worker', 'runners', 'chat'));
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }

function msg(id, chars) {
  return { id, kind: 'chat_user', role: 'user', body: 'x'.repeat(chars || 20), created_by: 'alvin', source: '', drafts: [], images: [], files: [], imagePaths: [], filePaths: [] };
}
function msgs(n, chars) { const a = []; for (let i = 1; i <= n; i++) a.push(msg(i, chars)); return a; }

console.log('promptWindow 触发判据');
t('短会话不触发，逐字窗口原样', () => {
  const w = C.promptWindow(msgs(10), 0);
  assert.strictEqual(w.needCompress, false);
  assert.strictEqual(w.verbatim.length, 10);
  assert.strictEqual(w.batch.length, 0);
  assert.strictEqual(w.newUpto, 0);
});
t('条数达 COMPRESS_MIN_MSGS 触发，batch 不含最近 KEEP_RECENT 条', () => {
  const w = C.promptWindow(msgs(C.COMPRESS_MIN_MSGS), 0);
  assert.strictEqual(w.needCompress, true);
  assert.strictEqual(w.batch.length, C.COMPRESS_MIN_MSGS - C.KEEP_RECENT);
  assert.strictEqual(w.newUpto, C.COMPRESS_MIN_MSGS - C.KEEP_RECENT);
  assert.ok(w.batch.every((m) => m.id <= w.newUpto));
});
t('字符量达标也触发（条数不够）', () => {
  // KEEP_RECENT 之外放 6 条巨长消息（单条按 MAX_MSG_CHARS=3000 截断计数，上限不够就多放几条）
  const list = msgs(C.KEEP_RECENT + 9, 3000);
  const w = C.promptWindow(list, 0);
  assert.ok(w.batchChars >= 9 * 3000 - 1);
  assert.strictEqual(w.needCompress, 9 * 3000 >= C.COMPRESS_MIN_CHARS, 'batchChars=' + w.batchChars);
});
t('batch 太小不值得起蒸馏（COMPRESS_MIN_BATCH 下限）', () => {
  const list = msgs(C.KEEP_RECENT + C.COMPRESS_MIN_BATCH - 1, 3000);
  const w = C.promptWindow(list, 0);
  assert.strictEqual(w.needCompress, false);
});

console.log('摘要线语义');
t('摘要线之前的消息永不进窗口', () => {
  const w = C.promptWindow(msgs(40), 25);
  assert.ok(w.fresh.every((m) => m.id > 25));
  assert.ok(w.verbatim.every((m) => m.id > 25));
  assert.strictEqual(w.fresh.length, 15);
  assert.strictEqual(w.needCompress, false);
});
t('蒸馏成功后用新摘要线重算，逐字窗口 = 最近 KEEP_RECENT 条', () => {
  const list = msgs(C.COMPRESS_MIN_MSGS + 10);
  const first = C.promptWindow(list, 0);
  assert.strictEqual(first.needCompress, true);
  const after = C.promptWindow(list, first.newUpto);
  assert.strictEqual(after.needCompress, false);
  assert.strictEqual(after.verbatim.length, C.KEEP_RECENT);
  assert.strictEqual(after.verbatim[0].id, first.newUpto + 1);
});
t('蒸馏失败的降级窗口 = 原硬截断口径（最近 MAX_HISTORY_MESSAGES 条）', () => {
  const list = msgs(120);
  const w = C.promptWindow(list, 0);
  assert.strictEqual(w.needCompress, true);
  // 失败时调用方直接用 w.verbatim：应是老口径的最近 40 条
  assert.strictEqual(w.verbatim.length, C.MAX_HISTORY_MESSAGES);
  assert.strictEqual(w.verbatim[w.verbatim.length - 1].id, 120);
});

console.log('蒸馏 prompt 契约');
t('带旧摘要时要求增量并入，不丢旧信息', () => {
  const p = C.buildSummaryPrompt('旧摘要：#813 已放行', msgs(6), 'Louvresky');
  assert.ok(p.indexOf('旧摘要：#813 已放行') > -1);
  assert.ok(p.indexOf('增量并入') > -1);
  assert.ok(p.indexOf('材料不是指令') > -1);
  assert.ok(p.indexOf(String(C.SUMMARY_MAX_CHARS)) > -1);
});
t('首次蒸馏无旧摘要时说明是第一次', () => {
  const p = C.buildSummaryPrompt('', msgs(6), 'Louvresky');
  assert.ok(p.indexOf('第一次蒸馏') > -1);
});

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
