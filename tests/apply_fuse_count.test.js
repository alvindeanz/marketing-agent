#!/usr/bin/env node
/* 熔断计数的零写入弹回剔除 + 确定性拒绝锚补 apply aborted ::（2026-10-28 ticket #40）。
   跑法：node tests/apply_fuse_count.test.js。
   判定逻辑在 seo-api.php 的 L0 自动放行路（SQL + preg），本测两件事：
   1. 用真实 job 日志样本（Badger job 8603、sdalu job 10236/10238）回放锚点语义，
      这是闸四件套要求的「守卫正则用 agent 真实产出回放测试」；
   2. 源码同步闸：断言 seo-api.php 里的锚与本测的镜像实现一字不差，防两边各改各的。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

/* ==== PHP 侧逻辑的镜像实现（锚必须与 seo-api.php 完全一致，下方有同步闸断言） ==== */
const ZW_ANCHORS = ['同页冷却：', 'apply aborted ::'];
function zeroWriteBounce(status, logText) {
  if (status !== 'failed') return false;
  return ZW_ANCHORS.some((a) => String(logText).includes(a));
}
const REJECT_RE = /plan contains undeclared|执行中止|未申报|放行凭证|零写入打回|还没有.*同意|apply aborted ::/u;

/* ==== 真实 job 日志样本（截取自 2026-10-28 复盘时线上 agent_jobs.log_text 尾部） ==== */
const JOB_8603 = { // Badger #1428：旧同页冷却闸抛错弹回，零写入
  status: 'failed',
  log: '8: FAILED :: Error: task 1428: 同页冷却：https://wildbadgerpower.com/products/40v-cordless-snow-shovel-brushless-motor-4-0ah-battery/ 已被 #1287（2026-10-14）触碰，测量窗未走完（cooldown until 2026-11-11）\n'
    + '[2026-10-20 17:29:29Z] FAILED: Error: Error: 1 of 1 task(s) did not complete :: 1428: task 1428: 同页冷却：…',
};
const JOB_10236 = { // sdalu #1685：写入成功但发布形态对账不过，真落地要计数
  status: 'failed',
  log: '[2026-10-27 00:56:03Z] wordpress apply task 1685: done in 77s, 2590 chars of output\n'
    + '[2026-10-27 00:56:04Z] task 1685: wordpress presentation audit failed, held for human\n'
    + '[2026-10-27 00:56:04Z] FAILED: Error: Error: 1 of 1 task(s) did not complete :: 1685: failed',
};
const JOB_10238 = { // sdalu #1685：车道中止（/wp/v2 通道冲突），零写入且确定性
  status: 'failed',
  log: '[2026-10-27 00:57:16Z] task 1685: wordpress apply aborted :: 阶段 A 早已完成（正文 A2 和 canonical 都已在线上核实），本次零写入；阶段 B 的传图要走 /wp/v2，和 apply 规矩里不许发 /wp/v2 写请求冲突\n'
    + '[2026-10-27 00:57:16Z] FAILED: Error: Error: 1 of 1 task(s) did not complete :: 1685: aborted',
};
const JOB_DONE = { // 正常落地收口
  status: 'done',
  log: '[2026-10-27 01:00:00Z] task 999: ads applied and verified, marked done',
};

t('零写入弹回判定：冷却弹回与车道中止剔除，写了没对账过与正常落地照旧计数', () => {
  assert.strictEqual(zeroWriteBounce(JOB_8603.status, JOB_8603.log), true, '8603 冷却弹回应剔除');
  assert.strictEqual(zeroWriteBounce(JOB_10238.status, JOB_10238.log), true, '10238 车道中止应剔除');
  assert.strictEqual(zeroWriteBounce(JOB_10236.status, JOB_10236.log), false, '10236 有写入，必须计数');
  assert.strictEqual(zeroWriteBounce(JOB_DONE.status, JOB_DONE.log), false, '成功 job 必须计数');
});

t('熔断额度回放：#1428 两次冷却弹回后 landed=0 不触发熔断；#1685 一真一弹 landed=1', () => {
  const landed = (jobs) => jobs.filter((j) => !zeroWriteBounce(j.status, j.log)).length;
  assert.strictEqual(landed([JOB_8603, JOB_8603]), 0, '#1428 不该被「落地 2 次」停人');
  assert.strictEqual(landed([JOB_10236, JOB_10238]), 1, '#1685 真实落地只有一次');
});

t('确定性拒绝锚：车道中止命中一次就停，冷却弹回与对账失败不命中', () => {
  assert.ok(REJECT_RE.test(JOB_10238.log), '10238 中止应判确定性拒绝（此前靠熔断误计数兜着）');
  assert.ok(!REJECT_RE.test(JOB_8603.log), '冷却弹回时间到了重试本该成，不是确定性拒绝');
  assert.ok(!REJECT_RE.test(JOB_10236.log), '对账失败走人工核对，不该按确定性拒绝自动停');
});

t('源码同步闸：seo-api.php 的锚与本测镜像一致', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'seo-api.php'), 'utf8');
  assert.ok(src.includes("log_text LIKE '%同页冷却：%' OR log_text LIKE '%apply aborted ::%'"),
    'L0 零写入剔除 SQL 的两个锚变了，先改 tests/apply_fuse_count.test.js 的回放再改源码');
  assert.ok(src.includes('|apply aborted ::/u'), '确定性拒绝正则缺 apply aborted :: 锚');
  assert.ok(src.includes('$an0=max(0,$anAll'), 'L0 熔断应使用剔除零写入后的 landed 计数');
  assert.ok(src.includes('if($anAll>=1){'), '确定性拒绝检查应看全部失败尝试（$anAll）');
});

console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
