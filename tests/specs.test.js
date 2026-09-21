#!/usr/bin/env node
/* specs 完整性：paid 四件套在场且带版本标记。跑法：node tests/specs.test.js
   防的是「指针掉线」：runner 与 skill 都指向这些文件，文件丢了或段落被误删要在测试就红。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const S = path.join(__dirname, '..', 'seo-worker', 'specs');
const WANT = [
  ['review_principles.md', 'PAID-PRINCIPLES-V'],
  ['plan_experience.md', 'PAID-EXPERIENCE-V'],
  [path.join('capabilities', 'googleads.md'), 'PAID-CAP-GOOGLEADS-V'],
  [path.join('report', 'paid_section.md'), 'PAID-REPORT-V'],
];

let fail = 0;
for (const [file, marker] of WANT) {
  const p = path.join(S, file);
  try {
    const text = fs.readFileSync(p, 'utf8');
    assert.ok(text.includes(marker), 'missing marker ' + marker);
    assert.ok(text.length > 500, 'suspiciously short: ' + text.length + ' chars');
    console.log('  ok   ' + file);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + file + ' :: ' + e.message);
  }
}
// release_policy：json 与 md 都在，googleads.md 里标了 risk_class 的 op 必须与 json 一致
try {
  const pol = JSON.parse(fs.readFileSync(path.join(S, 'release_policy.json'), 'utf8'));
  assert.ok(pol.risk_class_by_op && pol.tiers, 'policy json 缺字段');
  const md = fs.readFileSync(path.join(S, 'release_policy.md'), 'utf8');
  assert.ok(md.includes('RELEASE-POLICY-V'), 'policy md 缺版本标记');
  const cap = fs.readFileSync(path.join(S, 'capabilities', 'googleads.md'), 'utf8');
  let mismatch = [];
  for (const m of cap.matchAll(/- ([a-z0-9-]+(?: \/ [a-z0-9-]+)*) \[risk_class: (\w+)\]/g)) {
    for (const op of m[1].split(' / ')) {
      if (pol.risk_class_by_op[op] !== m[2]) mismatch.push(op + ': md=' + m[2] + ' json=' + (pol.risk_class_by_op[op] || 'missing'));
    }
  }
  const wf = fs.readFileSync(path.join(S, 'capabilities', 'webforger.md'), 'utf8');
  const wfBlock = (wf.match(/RISK_CLASS_START[\s\S]*?RISK_CLASS_END/) || [''])[0];
  for (const m of wfBlock.matchAll(/^- ([a-z0-9-]+): (\w+)/gm)) {
    if (pol.risk_class_by_op[m[1]] !== m[2]) mismatch.push(m[1] + ': wf.md=' + m[2] + ' json=' + (pol.risk_class_by_op[m[1]] || 'missing'));
  }
  assert.ok(wfBlock.length > 100, 'webforger.md 缺 RISK_CLASS 块');
  const wp = fs.readFileSync(path.join(S, 'capabilities', 'wordpress.md'), 'utf8');
  const wpBlock = (wp.match(/RISK_CLASS_START[\s\S]*?RISK_CLASS_END/) || [''])[0];
  for (const m of wpBlock.matchAll(/^- ([a-z0-9-]+): (\w+)/gm)) {
    if (pol.risk_class_by_op[m[1]] !== m[2]) mismatch.push(m[1] + ': wp.md=' + m[2] + ' json=' + (pol.risk_class_by_op[m[1]] || 'missing'));
  }
  assert.ok(wpBlock.length > 100, 'wordpress.md 缺 RISK_CLASS 块');
  assert.ok(pol.connected_lanes.lanes.indexOf('wordpress') !== -1, 'connected_lanes 缺 wordpress');
  assert.ok(!mismatch.length, 'risk_class 两处不一致: ' + mismatch.join('; '));
  console.log('  ok   release_policy json/md/googleads/webforger/wordpress 一致');
} catch (e) { fail += 1; console.log('  FAIL release_policy :: ' + e.message); }

// 能力清单必须能被 runner 解析（2026-09-08 job545 教训：googleads.md 只有文档没有规划视图表，
// execute 解析出零操作全部退化成分析模式，方案文件永远出不来）。每份清单：
// 规划视图非空；agent_apply/agent_prepare 的 op 必须在 release_policy 的 risk 表里（分级派单要用）。
try {
  const cap = require(path.join(__dirname, '..', 'seo-worker', 'lib', 'capabilities.js'));
  const pol = JSON.parse(fs.readFileSync(path.join(S, 'release_policy.json'), 'utf8'));
  const capDir = path.join(S, 'capabilities');
  const problems = [];
  for (const f of fs.readdirSync(capDir).filter((x) => x.endsWith('.md'))) {
    const platform = f.replace(/\.md$/, '');
    const ops = cap.operations(platform);
    if (!ops.length) { problems.push(platform + ': 规划视图解析出零操作'); continue; }
    for (const o of ops) {
      if ((o.autonomy === 'agent_apply' || o.autonomy === 'agent_prepare') && !pol.risk_class_by_op[o.name]) {
        problems.push(platform + ': op ' + o.name + ' 不在 release_policy risk 表');
      }
    }
  }
  assert.ok(!problems.length, problems.join('; '));
  console.log('  ok   全部能力清单可解析且 op 齐 risk 表');
  // agent_readonly 的 op 必须全在只读白名单里（2026-09-18 Apex #745 教训：creative-direction
  // 漏在外面，只读出卡任务被误排 apply_task 报「no change plan」失败推到人工队列）。
  // v10 起唯一事实源是 release_policy.json 的 readonly_ops（seo-api 运行时从政策文件读，
  // PHP 内联表只是政策缺失兜底），断言改对政策文件收口。
  const roList = (pol.readonly_ops && pol.readonly_ops.ops) || [];
  const roMissing = [];
  for (const f of fs.readdirSync(capDir).filter((x) => x.endsWith('.md'))) {
    for (const o of cap.operations(f.replace(/\.md$/, ''))) {
      if (String(o.autonomy || '').startsWith('agent_readonly') && !roList.includes(o.name)) {
        roMissing.push(o.name);
      }
    }
  }
  assert.ok(!roMissing.length, 'agent_readonly op 未进 seo-api READONLY_OPS（会被误排 apply）: ' + roMissing.join(', '));
  console.log('  ok   agent_readonly op 全在 READONLY_OPS');
} catch (e) { fail += 1; console.log('  FAIL 能力清单解析 :: ' + e.message); }

// review_principles 的 SEO 部分还在（append 不许覆盖）
const rp = fs.readFileSync(path.join(S, 'review_principles.md'), 'utf8');
if (!rp.includes('五问')) { fail += 1; console.log('  FAIL review_principles 丢了原有五问段'); } else console.log('  ok   review_principles 原段完整');

// readonly_ops（v10 2026-09-21）：analysis 收货白名单的唯一事实源。卡 op 必须在场，
// 且每个 readonly op 都要有 risk_class 档（dispatch_grade 见不认识的 op 会整单拒）。
try {
  const pol = JSON.parse(fs.readFileSync(path.join(S, 'release_policy.json'), 'utf8'));
  const ro = pol.readonly_ops && pol.readonly_ops.ops;
  assert.ok(Array.isArray(ro) && ro.length, 'readonly_ops.ops 缺失');
  for (const op of ['keyword-direction', 'creative-direction', 'keyword-confirmation', 'mapping-confirmation']) {
    assert.ok(ro.includes(op), 'readonly_ops 缺 ' + op + '（确认卡会重新卡在待放行）');
  }
  /* 卡 op 会出现在 dispatch/定档语境，必须有风险档；audit 类只读 op 不走 dispatch，不强求 */
  for (const op of ro.filter((x) => /direction|confirmation/.test(x))) {
    assert.ok(typeof pol.risk_class_by_op[op] === 'string', 'readonly 卡 op ' + op + ' 没有 risk_class 档');
  }
  console.log('  ok   readonly_ops 白名单完整且卡 op 全有风险档');
} catch (e) { fail += 1; console.log('  FAIL readonly_ops :: ' + e.message); }

console.log(fail ? '\n' + fail + ' failed' : '\nall ok');
process.exit(fail ? 1 : 0);
