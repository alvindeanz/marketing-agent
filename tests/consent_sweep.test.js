#!/usr/bin/env node
/* 等同意的单到点续排，worker 侧节拍（2026-11-18，Kia Ora Kids #2011）。跑法：node tests/consent_sweep.test.js。
   判定与续排在服务端（tests/consent_verdict.test.php 测防重闸），这里只测 worker 敲一下、记日志、失败不炸。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { consentSweepTick } = require(path.join(__dirname, '..', 'seo-worker', 'lib', 'conditions'));
(async () => {
  let pass = 0, fail = 0;
  async function t(name, fn) {
    try { await fn(); pass++; console.log('  ok   ' + name); }
    catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
  }
  await t('续排了的单逐张记日志（任务号、依据、job 号）', async () => {
    const logs = [];
    const done = await consentSweepTick({ postConsentSweep: async () => ({ ok: true, seen: 3, resumed: [{ task_id: 2011, via: 'expiry', job_id: 16001 }] }) }, (l) => logs.push(l));
    assert.strictEqual(done.length, 1);
    assert.ok(logs.some((l) => /#2011/.test(l) && /expiry/.test(l) && /16001/.test(l)), logs.join('|'));
  });
  await t('没有可续的单不出声', async () => {
    const logs = [];
    await consentSweepTick({ postConsentSweep: async () => ({ ok: true, seen: 2, resumed: [] }) }, (l) => logs.push(l));
    assert.deepStrictEqual(logs, []);
  });
  await t('接口失败只记一行不抛，下一拍再来', async () => {
    const logs = [];
    const done = await consentSweepTick({ postConsentSweep: async () => { throw new Error('HTTP 502'); } }, (l) => logs.push(l));
    assert.deepStrictEqual(done, []);
    assert.ok(logs.length === 1 && /本轮失败/.test(logs[0]));
  });
  await t('源码闸：listener 和条件巡检同一拍敲同意巡检', async () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'seo-worker', 'listener.js'), 'utf8');
    const i = js.indexOf('conditionProbeTick(api, log)'); const j = js.indexOf('consentSweepTick(api, log)');
    assert.ok(i > 0 && j > i && j - i < 300, 'listener 没接同意巡检');
  });
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
