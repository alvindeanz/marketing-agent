#!/usr/bin/env node
/* 同因连败闸（2026-11-16，Oak #479 的 79 圈自转）。跑法：node tests/apply_fail_streak.test.js。
   判定在 seo-api.php 的 apply_fail_sig / apply_fail_streak，本测是镜像实现加真实 job 日志回放，
   末尾源码同步闸防两边各改各的。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const MAX = 3;
function sig(log) {
  const m = [...String(log).matchAll(/did not complete :: ([^\n]+)/gu)];
  if (!m.length) return '';
  return m[m.length - 1][1].trim().replace(/\d+/g, '#').slice(0, 160);
}
/* jobs 按 id 倒序（最新在前），只含 failed/done */
function streak(jobs) {
  let n = 0, s0 = '';
  for (const j of jobs) {
    if (j.status !== 'failed') break;
    const s = sig(j.log);
    if (s === '') break;
    if (n === 0) s0 = s; else if (s !== s0) break;
    n++;
  }
  return [n, s0];
}

/* 真实样本（线上 agent_jobs.log_text） */
const JOB_11167 = { status: 'failed', log: // Oak #479：Shopify 车道缺店铺别名，零写入，确定性
  '[2026-10-28 21:35:47Z] task 479: FAILED :: Error: task 479: shop alias missing for oakfurniturestore.co.nz\n    at runShopifyApply (/data/aira/seo-worker/runners/apply_task.js:1397:11)\n'
  + '[2026-10-28 21:35:47Z] FAILED: Error: Error: 1 of 1 task(s) did not complete :: 479: task 479: shop alias missing for oakfurniturestore.co.nz\n    at Object.run (/data/aira/seo-worker/runners/apply_task.js:2037:45)' };
const JOB_10999 = { status: 'failed', log: // 同单：认领超时被清扫，瞬态，无收尾行
  '    at emit (node:internal/child_process:949:14)\n[2026-10-28 12:52:00Z] [reaped-timeout] 认领超过 60 分钟未完成，疑似 worker 离线，超时清扫判 failed（非执行错误，重排即可）。失败 job 不自动重试。' };
const JOB_10236 = { status: 'failed', log: // sdalu #1685：写入成功对账不过
  '[2026-10-27 00:56:04Z] FAILED: Error: Error: 1 of 1 task(s) did not complete :: 1685: failed' };
const JOB_10238 = { status: 'failed', log: // sdalu #1685：车道中止
  '[2026-10-27 00:57:16Z] FAILED: Error: Error: 1 of 1 task(s) did not complete :: 1685: aborted' };
const JOB_DONE = { status: 'done', log: '[2026-10-27 01:00:00Z] finished ok' };

t('签名：取收尾行并把数字归一', () => {
  assert.strictEqual(sig(JOB_11167.log), '#: task #: shop alias missing for oakfurniturestore.co.nz');
  assert.strictEqual(sig(JOB_10999.log), '', '超时清扫没有收尾行，无签名');
});
t('#479 回放：第三次同因失败后停，不会转到第 79 圈', () => {
  assert.strictEqual(streak([JOB_11167, JOB_11167])[0], 2, '两次还放一次重试（夹了判定）');
  const [n, s] = streak([JOB_11167, JOB_11167, JOB_11167]);
  assert.ok(n >= MAX && /shop alias missing/.test(s));
});
t('瞬态失败断开连击：超时清扫不计数', () => {
  assert.strictEqual(streak([JOB_10999, JOB_11167, JOB_11167, JOB_11167])[0], 0);
  assert.strictEqual(streak([JOB_11167, JOB_10999, JOB_11167, JOB_11167])[0], 1);
});
t('不同原因不算连败：#1685 一次对账失败一次车道中止', () => {
  assert.strictEqual(streak([JOB_10238, JOB_10236])[0], 1);
});
t('中间成功过就清零', () => {
  assert.strictEqual(streak([JOB_11167, JOB_DONE, JOB_11167, JOB_11167])[0], 1);
  assert.strictEqual(streak([JOB_DONE, JOB_11167, JOB_11167, JOB_11167])[0], 0);
});
t('源码同步闸：seo-api.php 与镜像一致，且两条放行路都接了闸', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'seo-api.php'), 'utf8');
  assert.ok(src.includes('const APPLY_FAIL_STREAK_MAX=' + MAX + ';'), '阈值变了先改本测');
  assert.ok(src.includes("preg_match_all('/did not complete :: ([^\\n]+)/u'"), '签名正则变了先改本测');
  assert.ok(src.includes("preg_replace('/\\d+/','#',$sig)"), '数字归一变了先改本测');
  assert.ok(src.includes('apply_fail_streak($cid,$tid,$lx0)'), 'L0 路没接连败闸');
  assert.ok(src.includes('apply_fail_streak($cid,$tid,$lastExec)'), '放行官路没接连败闸');
  assert.ok(src.indexOf('apply_fail_streak($cid,$tid,$lastExec)') < src.indexOf('if($applyN>=2&&$money){'), '放行官路的连败闸要在熔断分流之前');
  assert.ok(src.includes('MODIFY result_note MEDIUMTEXT'), '备注列加宽不见了');
});
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
