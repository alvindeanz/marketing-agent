#!/usr/bin/env node
/* 政策表 vs 执行器能力的一致性断言（2026-09-14 ctomi #682 教训：政策表有 asset-create
   的风险档，被当成「执行器已覆盖」转了机器位，放行到 apply 才发现建不了 PMax 素材组）。
   三方对齐：release_policy.json 的 executor_pending_ops、ads_mutate.py 的 OPS 白名单、
   capabilities/googleads.md 的 agent_prepare 行。跑法：node tests/policy_executor.test.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pol = JSON.parse(fs.readFileSync(path.join(__dirname, '../seo-worker/specs/release_policy.json'), 'utf8'));
const py = fs.readFileSync(path.join(__dirname, '../seo-worker/lib/ads_mutate.py'), 'utf8');
const md = fs.readFileSync(path.join(__dirname, '../seo-worker/specs/capabilities/googleads.md'), 'utf8');

const opsM = py.match(/OPS\s*=\s*\[([\s\S]*?)\]/);
const implemented = opsM ? [...opsM[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]) : [];
const pending = (pol.executor_pending_ops && pol.executor_pending_ops.ops) || [];
const riskTable = pol.risk_class_by_op || {};
/* 能力清单里名字和执行器实现名不同的对（清单名: 执行器名） */
const ALIAS = { 'ad-copy-rewrite': 'rsa-copy-update' };

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

t('ads_mutate 的 OPS 白名单解析非空', () => {
  assert.ok(implemented.length >= 10, 'OPS 解析出 ' + implemented.length + ' 个');
});

t('executor_pending_ops 每个 op 都在政策风险表里', () => {
  for (const op of pending) assert.ok(riskTable[op], op + ' 不在 risk_class_by_op');
});

t('pending 与已实现互斥：执行器会做的不许还挂在 pending 表', () => {
  for (const op of pending) assert.ok(!implemented.includes(op), op + ' 已在 ads_mutate OPS 里，从 pending 删掉它');
});

t('googleads 能力清单的 agent_prepare 行：要么执行器已实现要么登记 pending，不许两不沾', () => {
  const rows = [...md.matchAll(/^\|\s*([a-z0-9-]+)\s*\|\s*agent_prepare\s*\|/gm)].map((m) => m[1]);
  assert.ok(rows.length >= 5, '清单解析出 ' + rows.length + ' 行 agent_prepare');
  for (const op of rows) {
    const exec = ALIAS[op] || op;
    const ok = implemented.includes(exec) || pending.includes(op);
    assert.ok(ok, op + ' 既不在 ads_mutate OPS 也不在 executor_pending_ops：这就是 #682 那种「表里有档、落地没门」的缺口');
  }
});

t('asset-create 当前登记为 pending（补上执行器时改这里和政策表）', () => {
  assert.ok(pending.includes('asset-create'));
});

t('意图携带开关在政策里且为 true', () => {
  assert.strictEqual(pol.dispatch_rules.mandate_carries_release, true);
});

console.log(pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
