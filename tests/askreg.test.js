#!/usr/bin/env node
/* 出卡登记 Ask（lib/askreg.js）的干跑单测。跑法：node tests/askreg.test.js
   契约：/mnt/share/aiden/to-aira-asks-contract-20261016.md。不碰网络、不读 NFS。 */
const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

const A = require(path.join(__dirname, '..', 'seo-worker', 'lib', 'askreg'));

let pass = 0, fail = 0;
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') { r.then(() => { pass++; console.log('  ok   ' + name); done(); }, (e) => { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); done(); }); waiting++; return; }
    pass++; console.log('  ok   ' + name);
  } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
let waiting = 0;
function done() { waiting--; if (!waiting) finish(); }
function finish() { console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0); }

const dirTask = { id: 1500, client_id: 55, plan_id: 69, card_kind: 'keyword_direction', title: '十月关键词方向' };
const confTask = { id: 1464, client_id: 55, plan_id: 68, card_kind: 'keyword_confirmation', title: 'onboard 闸材料：词表与 mapping 确认' };
const data = {
  title: '十月关键词方向卡',
  oneline: '三张商业页冲首页',
  decisions: [
    { item: 'd1', q: '零售词要不要跟', situation: '现状', recommendation: '建议跟', textarea_hint: '写两句', no_reply: '不回按建议' },
    { item: 'd2', q: '品牌词守不守', situation: 'S', recommendation: 'R' },
  ],
  negatives: ['free website builder', 'wordpress hosting'],
};

console.log('buildAsk direction');
t('direction card maps decisions, negatives and global_note with zh lang pack', () => {
  const p = A.buildAsk({ task: dirTask, data, cardUrl: 'https://agencyreport.example/x.html?t=1500&k=abc', serviceToken: 'tok', now: Date.parse('2026-10-18T00:00:00Z') });
  assert.strictEqual(p.ask_id, 'ask_t1500_keyword_direction');
  assert.strictEqual(p.kind, 'direction');
  assert.strictEqual(p.client_id, 55);
  assert.strictEqual(p.audience, 'both');
  assert.deepStrictEqual(p.items.map((i) => i.item_id), ['d1', 'd2', 'negatives', 'global_note']);
  assert.deepStrictEqual(p.items[0].options, ['agree', 'hold', 'other']);
  assert.deepStrictEqual(p.items[2].options, ['free website builder', 'wordpress hosting']);
  assert.strictEqual(p.items[2].required, false);
  assert.strictEqual(p.deadline, '2026-11-01T00:00:00Z');
  const zh = p.lang_pack.texts.zh;
  assert.strictEqual(zh.title, '十月关键词方向卡');
  assert.ok(zh.intro.includes('https://agencyreport.example/x.html'));
  assert.strictEqual(zh.items.d1.prompt, '零售词要不要跟');
  assert.strictEqual(p.source_ref.task_id, 1500);
  assert.strictEqual(p.source_ref.card_kind, 'keyword_direction');
});
t('card_token_ref is a sha256 fingerprint of the md5 card token, never the token itself', () => {
  const p = A.buildAsk({ task: dirTask, data, serviceToken: 'tok' });
  const md5 = crypto.createHash('md5').update('cardfb1500tok').digest('hex');
  const want = 'sha256:' + crypto.createHash('sha256').update(md5).digest('hex').slice(0, 16);
  assert.strictEqual(p.source_ref.card_token_ref, want);
  assert.ok(!JSON.stringify(p).includes(md5), 'md5 card token must not appear anywhere in the payload');
});
t('negatives containing a comma drop the whole multi item, answerability intact', () => {
  const p = A.buildAsk({ task: dirTask, data: Object.assign({}, data, { negatives: ['a, b'] }), serviceToken: 'tok' });
  assert.ok(!p.items.some((i) => i.item_id === 'negatives'));
  assert.ok(p.items.some((i) => i.item_id === 'd1'));
});

console.log('buildAsk confirmation');
t('confirmation card degrades to a single approve item plus note', () => {
  const p = A.buildAsk({ task: confTask, cardUrl: 'https://agencyreport.example/kc.html?t=1464&k=z', serviceToken: 'tok' });
  assert.strictEqual(p.ask_id, 'ask_t1464_keyword_confirmation');
  assert.strictEqual(p.kind, 'confirmation');
  assert.deepStrictEqual(p.items.map((i) => i.item_id), ['approval', 'global_note']);
  assert.deepStrictEqual(p.items[0].options, ['approve', 'reject']);
  assert.deepStrictEqual(p.items[0].requires_text_when, ['reject']);
  assert.ok(p.lang_pack.texts.zh.intro.includes('kc.html'));
});
t('direction card without a data json also degrades instead of failing', () => {
  const p = A.buildAsk({ task: dirTask, data: null, serviceToken: 'tok' });
  assert.deepStrictEqual(p.items.map((i) => i.item_id), ['approval', 'global_note']);
  assert.strictEqual(p.kind, 'direction');
});

console.log('registerCardAsk');
t('posts the payload through api.postAsk and reports created', async () => {
  let got = null;
  const fakeApi = { postAsk: async (b) => { got = b; return { ok: true, ask_id: b.ask_id, created: true }; } };
  const reg = await A.registerCardAsk({ api: fakeApi, task: confTask, workspace: '/nonexistent', cardUrl: '', serviceToken: 'tok', log: () => {} });
  assert.strictEqual(reg.ask_id, 'ask_t1464_keyword_confirmation');
  assert.strictEqual(reg.created, true);
  assert.strictEqual(got.client_id, 55);
});
t('task without card_kind registers nothing', async () => {
  const reg = await A.registerCardAsk({ api: { postAsk: async () => { throw new Error('must not be called'); } }, task: { id: 9, client_id: 1 }, workspace: '/nonexistent', serviceToken: 'tok' });
  assert.strictEqual(reg, null);
});

if (!waiting) finish();
