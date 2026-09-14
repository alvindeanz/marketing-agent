#!/usr/bin/env node
/* agent 泳道零模型后置对账的单测（查询函数注入假账户）。跑法：node tests/ads_audit.test.js */
const assert = require('assert');
const { auditAgentItems } = require('../seo-worker/lib/ads_audit');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

const AG = 'customers/111/assetGroups/222';
const BUD = 'customers/111/campaignBudgets/333';

function fakeAccount(rowsByQueryPart) {
  return (cid, query) => {
    for (const [frag, rows] of Object.entries(rowsByQueryPart)) {
      if (query.includes(frag)) return rows;
    }
    return [];
  };
}

t('素材组存在且期望 ENABLED 命中：过', () => {
  const q = fakeAccount({ [AG]: [{ asset_group_status: 'ENABLED' }] });
  const r = auditAgentItems('111', [{ entity: AG, op: 'asset-create', state: 'verified', evidence: '回读 ENABLED' }], q);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.checked, 1);
});

t('账户查无此组：不过', () => {
  const q = fakeAccount({});
  const r = auditAgentItems('111', [{ entity: AG, op: 'asset-create', state: 'landed', evidence: '' }], q);
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures[0].why.includes('查无'));
});

t('期望 ENABLED 实际 PAUSED：不过', () => {
  const q = fakeAccount({ [AG]: [{ asset_group_status: 'PAUSED' }] });
  const r = auditAgentItems('111', [{ entity: AG, op: 'asset-create', state: 'verified', evidence: '已置 ENABLED' }], q);
  assert.strictEqual(r.ok, false);
});

t('预算 micros 逐位比对：不符即不过', () => {
  const q = fakeAccount({ [BUD]: [{ campaign_budget_amount_micros: '30000000' }] });
  const r = auditAgentItems('111', [{ entity: BUD, op: 'budget-change', state: 'landed', target_value: '31000000 micros', evidence: '' }], q);
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures[0].why.includes('31000000'));
});

t('预算 micros 相符：过', () => {
  const q = fakeAccount({ [BUD]: [{ campaign_budget_amount_micros: '31000000' }] });
  const r = auditAgentItems('111', [{ entity: BUD, op: 'budget-change', state: 'landed', target_value: '31000000 micros', evidence: '' }], q);
  assert.strictEqual(r.ok, true);
});

t('零行可硬审（条目全缺 resource name）：不过，防蒙混收口', () => {
  const q = fakeAccount({});
  const r = auditAgentItems('111', [{ entity: '男士素材组', op: 'asset-create', state: 'landed', evidence: '做好了' }], q);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.checked, 0);
  assert.strictEqual(r.unaudited, 1);
});

t('blocked 行不参与对账', () => {
  const q = fakeAccount({ [AG]: [{ asset_group_status: 'ENABLED' }] });
  const r = auditAgentItems('111', [
    { entity: AG, op: 'asset-create', state: 'verified', evidence: 'ENABLED' },
    { entity: 'customers/111/campaigns/999', op: 'campaign-pause', state: 'blocked', block_reason: '等条件' },
  ], q);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.checked, 1);
});

t('查询抛异常按对账失败处理，不炸', () => {
  const q = () => { throw new Error('quota'); };
  const r = auditAgentItems('111', [{ entity: AG, op: 'asset-create', state: 'landed', evidence: '' }], q);
  assert.strictEqual(r.ok, false);
  assert.ok(r.failures[0].why.includes('对账查询失败'));
});

console.log(pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
