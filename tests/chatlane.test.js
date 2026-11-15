#!/usr/bin/env node
/* chat 泳道在途载荷判据（2026-11-15）。跑法：node tests/chatlane.test.js */
'use strict';
const assert = require('assert');
const { laneInFlight } = require('../seo-worker/lib/chatlane');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }

t('带确认卡的泳道单算在途：card_kind、博客确认卡链接、落地页确认卡', () => {
  assert.strictEqual(laneInFlight({ card_kind: 'blog_confirm' }), true);
  assert.strictEqual(laneInFlight({ output_url: 'https://agencyreport.example/blog_confirmation_x.html?t=1&k=ab' }), true);
  assert.strictEqual(laneInFlight({ result_note: '[落地页确认卡] 结构类调整需客户确认' }), true);
});
t('静默期放行戳算在途（到点要轮子放行）', () => {
  assert.strictEqual(laneInFlight({ result_note: '[pending-release L2 until 2026-11-16 03:00Z]' }), true);
});
t('普通 chat 改动单、停人单、失败单都不算在途（走到期清单）', () => {
  assert.strictEqual(laneInFlight({ result_note: '执行失败：xxx 任务保持 review' }), false);
  assert.strictEqual(laneInFlight({ result_note: '[hold-human opus] 需人裁决', output_url: '' }), false);
  assert.strictEqual(laneInFlight({}), false);
  assert.strictEqual(laneInFlight(null), false);
});
console.log('chatlane: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
