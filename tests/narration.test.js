#!/usr/bin/env node
/* 叙述回合：prompt 的硬边界与 SKIP 规整。跑法：node tests/narration.test.js
   防的是两件事：系统触发的回合长出执行权（prompt 必须带纯叙述铁律），
   和模型没话找话刷频道（SKIP 必须规整成不发帖）。 */
const assert = require('assert');
const { buildNarrationPrompt, narrationBody } = require('../seo-worker/runners/chat');

let fail = 0;
function t(name, fn) {
  try {
    fn();
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + e.message);
  }
}

t('prompt 含纯叙述铁律、三要素与 SKIP 出口，带任务材料', () => {
  const p = buildNarrationPrompt({
    clientName: 'Ideal Renovation',
    messages: [],
    task: { id: 1375, title: '人工落地：地域定向', result_note_tail: 'capability-gap[cli]：缺 op', output_url: '' },
    closeKind: 'accepted',
  });
  assert.ok(p.includes('纯叙述'));
  assert.ok(p.includes('没有任何执行权'));
  assert.ok(p.includes('账户或站点动没动'));
  assert.ok(p.includes('SKIP'));
  assert.ok(p.includes('#1375'));
  assert.ok(p.includes('capability-gap[cli]'));
  assert.ok(p.includes('账户与站点未因本单改动'));
});

t('narrationBody：SKIP 与空输出不发帖，正文通过并截断', () => {
  assert.strictEqual(narrationBody('SKIP'), null);
  assert.strictEqual(narrationBody('  SKIP  \n'), null);
  assert.strictEqual(narrationBody('SKIP，没有可补的'), null);
  assert.strictEqual(narrationBody(''), null);
  assert.strictEqual(narrationBody(null), null);
  assert.strictEqual(narrationBody('账户已改完，五条系列全部按清单生效。'), '账户已改完，五条系列全部按清单生效。');
  assert.ok(narrationBody('x'.repeat(5000)).length <= 2003);
});

t('SKIP 只认首行开头，正文里提到 SKIP 不误杀', () => {
  const body = '已收口。说明一下：模型输出 SKIP 时不会发帖。';
  assert.strictEqual(narrationBody(body), body);
});

console.log(fail ? fail + ' fail' : 'narration: all pass, 0 fail');
process.exit(fail ? 1 : 0);
