#!/usr/bin/env node
'use strict';
// 批量转机器执行位（2026-09-17，能力重绑定回路的执行半边；候选清单看 harness 的「转位候选」段）。
//
// 语义与频道线程动作 machine_run 对齐（seo-api 1273 行）：owner 转 agent、补 ops、
// detail 落 [machine-run] 印章。两点有意差异：
//   1. ops 允许为空：SEO 内容任务的交付包模式本来就无 op（policy「无 ops 任务」走 L2，
//      execute 出方案后停 review 进发卡流程），频道版强制带 ops 是 paid 语境的遗产。
//   2. 不直接排 execute：detail 追加印章会改内容哈希，既有判决自然过期，
//      下次 harness 的 0.5 段自动重排闸A（fable 按新执行位重判）再拍板。转位后跑一次
//      harness 就是完整闭环，不在这里抢跑。
// 风险闸不动：转位只改「谁来干」，放行政策照旧管「能不能落」。
//
// 用法：SEO_AGENT_TOKEN=<admin jwt> node tools/machine_run.js <client_id> <spec> --reason "一句话"
//   <spec>  逗号分隔的 id[:ops[:module]]，ops 内多个 op 用 + 连接
//   例：node tools/machine_run.js 3 493,495:negative-keyword-add:paid,497:keyword-direction --reason "Shopify 车道接通"

const path = require('node:path');
const fs = require('node:fs');

const API = process.env.SEO_API_BASE || 'https://always.horntech-dev.com/seo-api.php';
const TOKEN = process.env.SEO_AGENT_TOKEN || '';
const POLICY = path.join(__dirname, '..', 'specs', 'release_policy.json');

const argv = process.argv.slice(2);
const cid = parseInt(argv[0], 10);
const spec = String(argv[1] || '');
const reason = (() => { const i = argv.indexOf('--reason'); return i === -1 ? '' : String(argv[i + 1] || ''); })();

function die(msg) { console.error('machine_run: ' + msg); process.exit(2); }
if (!cid || !spec || !TOKEN) die('用法：SEO_AGENT_TOKEN=... node tools/machine_run.js <client_id> <id[:ops[:module]],...> --reason "..."');
if (!reason) die('必须带 --reason，一句话说清为什么转（进任务 detail 印章，责任可追）');

const MODULES = ['technical', 'onpage', 'content', 'local', 'offpage', 'paid'];
const policy = JSON.parse(fs.readFileSync(POLICY, 'utf8'));
const knownOps = policy.risk_class_by_op || {};

const items = spec.split(',').map((s) => {
  const [id, ops, module_] = s.split(':');
  return { id: parseInt(id, 10), ops: (ops || '').split('+').map((x) => x.trim()).filter(Boolean), module: (module_ || '').trim() };
});
for (const it of items) {
  if (!it.id) die('看不懂的条目：' + JSON.stringify(it));
  for (const op of it.ops) if (!knownOps[op]) die('#' + it.id + ' 的 op「' + op + '」不在 release_policy.json 政策表里，先登记再转（能力清单同 commit 同步）');
  if (it.module && !MODULES.includes(it.module)) die('#' + it.id + ' 的 module「' + it.module + '」不合法（' + MODULES.join('/') + '）');
}

async function call(method, p, body) {
  const r = await fetch(API + p, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = { raw: t.slice(0, 200) }; }
  if (!r.ok) throw new Error(method + ' ' + p + ' -> ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  return j;
}

(async () => {
  const d = await call('GET', '/tasks?client_id=' + cid);
  const byId = new Map((d.tasks || d).map((t) => [t.id, t]));
  const stamp = '[machine-run ' + new Date().toISOString().slice(0, 10) + '] 转机器执行位（tools/machine_run.js）：' + reason;
  for (const it of items) {
    const t = byId.get(it.id);
    if (!t) die('#' + it.id + ' 不存在或不属于 client ' + cid);
    if (t.status === 'done') { console.log('#' + it.id + ' 已结束，跳过'); continue; }
    if (String(t.owner_type) === 'agent' && !it.ops.length && !it.module) { console.log('#' + it.id + ' 已在 agent 位且无字段要改，跳过'); continue; }
    const body = { owner_type: 'agent', detail: String(t.detail || '') + '\n' + stamp };
    if (it.ops.length) body.ops = it.ops.join(',');
    if (it.module) body.module = it.module;
    await call('PATCH', '/tasks/' + it.id, body);
    console.log('#' + it.id + ' -> agent 位' + (it.ops.length ? '，ops ' + it.ops.join(',') : '（无 op，交付包模式）') + (it.module ? '，module ' + it.module : ''));
  }
  console.log('转位完成。detail 印章已使旧判决过期，跑 node tools/harness.js ' + cid + ' 让闸A按新执行位重判后拍板。');
})().catch((e) => die(e.message));
