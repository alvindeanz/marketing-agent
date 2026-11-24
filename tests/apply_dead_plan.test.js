#!/usr/bin/env node
/* 败方案不重放（2026-11-24，一周六张同形状：Apollo #2618 / Kuddles #2438 / PF Moving #2720 /
   Play Mate #2731 / SD Aluminium #2765 / Merii #2759）。跑法：node tests/apply_dead_plan.test.js。
   判定在 seo-api.php 的 apply_agent_verdict / dead_plan_replan_ok / dead_plan_route，本测是前两个纯函数的
   镜像实现加真实 job 日志收尾行回放，末尾源码同步闸防两边各改各的。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

/* 镜像：取最后一条收尾行，按 ' | ' 拆，命中「<任务号>: failed|aborted」整段才算 agent 给了结论 */
function verdict(log, tid) {
  const m = [...String(log).matchAll(/did not complete :: ([^\n]+)/gu)];
  if (!m.length) return '';
  for (const part of m[m.length - 1][1].trim().split(' | ')) {
    const mm = new RegExp('^' + Number(tid) + ': (failed|aborted)$').exec(part.trim());
    if (mm) return mm[1];
  }
  return '';
}
function replanOk(ops, rc, note) {
  if (String(note).indexOf('[redo opus') !== -1) return false;
  if (!Array.isArray(ops) || !ops.length || !rc) return false;
  for (const op of ops) {
    if (op === 'blog-draft') return false;
    if (String(rc[op] || '') !== 'reversible') return false;
  }
  return true;
}
const RC = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'seo-worker', 'specs', 'release_policy.json'), 'utf8')).risk_class_by_op;
const tail = (s) => '[2026-11-22 04:29:56Z] FAILED: Error: Error: 1 of 1 task(s) did not complete :: ' + s;

/* 真实样本：线上 agent_jobs.log_text 的收尾行（2026-11-24 取） */
const REAL_VERDICT = [
  [16425, 2618, '2618: failed', 'failed'],   // Apollo：全写进去了，只因方案把文件名写成 .md
  [16430, 2618, '2618: aborted', 'aborted'], // Apollo 重放：撞上自己上一轮的写入
  [16366, 2438, '2438: aborted', 'aborted'], // Kuddles：page 参数写法平台不收，404
  [16522, 2720, '2720: aborted', 'aborted'], // PF Moving：运行时缺凭据
  [16639, 2731, '2731: failed', 'failed'],   // Play Mate：tag 回读按顺序比
  [16967, 2765, '2765: failed', 'failed'],   // SD Aluminium：方案把预期次数写错
  [16921, 2759, '2759: aborted', 'aborted'], // Merii：方案缺商品节点出价
  [17118, 2780, '2780: aborted', 'aborted'], // Merii 重建：细分节点读回 PAUSED
];
const REAL_NO_VERDICT = [
  [11167, 479, '479: task 479: shop alias missing for oakfurniturestore.co.nz'],
  [12664, 1796, '1796: shopify apply task 1796: claude timed out after 3301s, killed'],
  [13595, 1966, '1966: task 1966: changeset open failed :: HTTP 401 POST https://api.webforger.ai/api/auth/login :: {"error":"Invalid credentials"}'],
  [15834, 2174, '2174: task 2174：客户还没在确认卡上同意发布（publish_blog=agree，卡上没有任何发布表态）。不发布。'],
  [9773, 421, '421: task 421: no approved change plan at /data/aira/clients/goodiegoodie/seo-agent-output/change-plan-task-421.md. execute chained'],
];

t('本周八个失败 job 回放：agent 给了结论的全部认出', () => {
  for (const [job, tid, s, want] of REAL_VERDICT) assert.strictEqual(verdict(tail(s), tid), want, 'job ' + job);
});
t('抛错收尾的失败不归这里管：缺别名、超时、登录失败、同意闸、无方案续接', () => {
  for (const [job, tid, s] of REAL_NO_VERDICT) assert.strictEqual(verdict(tail(s), tid), '', 'job ' + job);
});
t('没有收尾行（超时清扫）不认；收尾行后面跟堆栈照认', () => {
  assert.strictEqual(verdict('[reaped-timeout] 认领超过 60 分钟未完成', 479), '');
  assert.strictEqual(verdict(tail('2438: aborted') + '\n    at Object.run (/data/aira/seo-worker/runners/apply_task.js:2105:11)', 2438), 'aborted');
});
t('任务号要整段对上：别的任务的结论、号码是前缀的都不认', () => {
  assert.strictEqual(verdict(tail('24380: aborted'), 2438), '');
  assert.strictEqual(verdict(tail('2438: aborted'), 438), '');
  assert.strictEqual(verdict(tail('2437: failed | 2438: aborted'), 2438), 'aborted');
  assert.strictEqual(verdict(tail('2437: failed | 2438: task 2438: timed out'), 2438), '');
});
t('只看最后一条收尾行', () => {
  assert.strictEqual(verdict(tail('2438: aborted') + '\n' + tail('2438: task 2438: claude timed out'), 2438), '');
});
t('出路：本周可逆的四张打回重出，花钱与结构类停人', () => {
  assert.strictEqual(replanOk(['blog-edit'], RC, ''), true, 'Apollo #2618');
  assert.strictEqual(replanOk(['page-advanced-update', 'content-edit'], RC, ''), true, 'Kuddles #2438');
  assert.strictEqual(replanOk(['product-tags-update'], RC, ''), true, 'Play Mate #2731');
  assert.strictEqual(replanOk(['report-html-update', 'report-preview-deploy'], RC, ''), true, 'SD Aluminium #2765');
  assert.strictEqual(replanOk(['campaign-create', 'adgroup-create'], RC, ''), false, 'Merii #2759 花钱加结构');
  assert.strictEqual(replanOk(['campaign-create', 'adgroup-create', 'budget-change'], RC, ''), false, 'Merii #2780');
});
t('出路：对外、不可逆、未登记 op、空 ops、新建博客稿都停人', () => {
  assert.strictEqual(replanOk(['blog-publish'], RC, ''), false);
  assert.strictEqual(replanOk(['conversion-goal-change'], RC, ''), false);
  assert.strictEqual(replanOk(['page-meta-update', 'no-such-op'], RC, ''), false);
  assert.strictEqual(replanOk([], RC, ''), false);
  assert.strictEqual(replanOk(['blog-draft'], RC, ''), false);
  assert.strictEqual(replanOk(['page-meta-update'], null, ''), false, '政策文件读不到按从严');
});
t('打回重出只有一次额度，与放行官 redo 共用', () => {
  assert.strictEqual(replanOk(['page-meta-update'], RC, '[redo opus 2026-11-24 01:00] 方案打回重出：…'), false);
  assert.strictEqual(replanOk(['page-meta-update'], RC, '[auto-release L0] 复审判 do'), true);
});
t('源码同步闸：seo-api.php 与镜像一致，且两条放行路都接了', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'seo-api.php'), 'utf8');
  assert.ok(src.includes("preg_match('/^'.(int)$tid.': (failed|aborted)$/',trim($part),$mm)"), '结论正则变了先改本测');
  assert.ok(src.includes("explode(' | ',trim((string)end($m[1])))"), '收尾行拆法变了先改本测');
  assert.ok(src.includes("if($op==='blog-draft')return false;"), '新建博客稿豁免变了先改本测');
  assert.ok(src.includes("if((string)($rc[$op]??'')!=='reversible')return false;"), '可逆判据变了先改本测');
  assert.ok(src.includes("if(strpos((string)$note,'[redo opus')!==false)return false;"), '额度判据变了先改本测');
  assert.ok(src.includes("dead_plan_route($cid,$tid,$t,$lx0,$rc,'seo-worker')"), 'L0 路没接');
  assert.ok(src.includes("dead_plan_route($cid,$tid,$t,$lastExec,$rc,'opus-release')"), '放行官路没接');
  assert.ok(src.indexOf("dead_plan_route($cid,$tid,$t,$lx0,$rc,'seo-worker')") < src.indexOf('if($an0>=2){'), 'L0 路要在熔断计数之前');
  assert.ok(src.indexOf("dead_plan_route($cid,$tid,$t,$lastExec,$rc,'opus-release')") < src.indexOf('if($applyN>=2&&$money){'), '放行官路要在熔断分流之前');
  /* 首杀当场抓到的二次派发（Kuddles #2438）：L0 打回后同一轮不许再续排放行官；放行官回来时方案正在重出的整行跳过 */
  assert.ok(src.includes("!==''){$deadIds[$tid]=true;continue;}"), 'L0 打回后没登记 deadIds');
  assert.ok(src.includes("isset($autoIds[$tid])||isset($deadIds[$tid])"), '放行官续排没跳过已处置的任务');
  assert.ok(src.includes("if((int)($fr['c']??0)>0)return 'replan';"), 'dead_plan_route 缺重出在途的幂等保护');
  assert.ok(src.includes("'seo_release_replan_inflight_skip'"), '放行官回写缺重出在途跳过');
  assert.ok(src.indexOf("'seo_release_replan_inflight_skip'") < src.indexOf("if($verdict==='hold_human'){"), '在途跳过要在三种判决分流之前');
  /* 重出轮的 prompt 靠这一行把失败原因带进去，标记改了两边一起改 */
  const ex = fs.readFileSync(path.join(__dirname, '..', 'seo-worker', 'runners', 'execute_task.js'), 'utf8');
  assert.ok(ex.includes('noteStr.match(/\\[redo opus [^\\n]*/g)'), 'execute 读打回行的正则变了');
  assert.ok(src.includes("'[redo opus '.$stamp.'] 方案打回重出：上一版方案落地'"), '打回行格式变了');
});
console.log(pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
