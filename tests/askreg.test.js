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
    { item: 'd1', q: '零售词要不要跟', situation: '现状', recommendation: '建议跟', textarea_hint: '写两句', no_reply: '不回按建议',
      picks: { ph: '勾选要保留的竞品词', save_item: 'keep_terms', entries: [
        { kw: 'harvey norman', label: 'harvey norman', note: '' },
        { kw: 'free website builder online today', label: 'free website builder online today', note: '' },
        { kw: '免费建站', label: '免费建站', note: '' },
      ] } },
    { item: 'd2', q: '品牌词守不守', situation: 'S', recommendation: 'R' },
  ],
  negatives: ['挡掉 <b>free</b> 类搜索，每月约省 120 元', '招聘类搜索全部挡掉'],
};
const fx1464 = require('./fixtures/card_data_t1464.json');

console.log('buildAsk legacy direction (adapter, kept until 2027-01)');
t('legacy direction maps decisions to single, picks to multi with short codes, negatives to a list block', () => {
  const p = A.buildAsk({ task: dirTask, data, cardUrl: 'https://agencyreport.example/x.html?t=1500&k=abc', serviceToken: 'tok', now: Date.parse('2026-10-18T00:00:00Z') });
  assert.strictEqual(p.ask_id, 'ask_t1500_keyword_direction');
  assert.strictEqual(p.kind, 'direction');
  assert.strictEqual(p.service, 'sem');
  assert.strictEqual(p.default_policy, 'no_reply_follow_recommendation');
  assert.strictEqual(p.client_id, 55);
  assert.strictEqual(p.audience, 'both');
  assert.deepStrictEqual(p.items.map((i) => i.item_id), ['d1', 'keep_terms', 'd2', 'global_note']);
  assert.deepStrictEqual(p.items[0].options, ['agree', 'hold', 'other']);
  assert.strictEqual(p.items[0].default_value, 'agree');
  const multi = p.items[1];
  assert.strictEqual(multi.type, 'multi');
  assert.strictEqual(multi.required, false);
  assert.deepStrictEqual(multi.options, ['harvey_norman', 'p2', 'p3'], 'readable slug when it fits, position code otherwise');
  for (const c of multi.options) assert.ok(/^[a-z0-9_.:-]{1,16}$/.test(c), 'code passes asks_code_ok and the 16-char column: ' + c);
  const zh = p.lang_pack.texts.zh;
  assert.deepStrictEqual(zh.items.keep_terms.options, { harvey_norman: 'harvey norman', p2: 'free website builder online today', p3: '免费建站' });
  assert.deepStrictEqual(zh.blocks, [{ id: 'b_negatives', type: 'list', title: '否词与止血', items: ['挡掉 free 类搜索，每月约省 120 元', '招聘类搜索全部挡掉'] }]);
  assert.strictEqual(p.deadline, '2026-11-01T00:00:00Z');
  assert.strictEqual(zh.title, '十月关键词方向卡');
  assert.ok(zh.intro.includes('https://agencyreport.example/x.html'));
  assert.strictEqual(zh.items.d1.prompt, '零售词要不要跟');
  assert.strictEqual(zh.default_note, '到期未回复按卡上建议执行');
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
t('no card data means no Ask (no more approve degrade: two channels must answer the same items)', () => {
  assert.strictEqual(A.buildAsk({ task: dirTask, data: null, serviceToken: 'tok' }), null);
  assert.strictEqual(A.buildAsk({ task: confTask, data: null, serviceToken: 'tok' }), null);
  assert.strictEqual(A.buildAsk({ task: confTask, data: { title: 'hand written html era' }, serviceToken: 'tok' }), null);
});

console.log('buildAsk card_data v1');
t('1464 fixture registers as rev 2 with the four HTML items, seo lane, no default consent, NZ end of day deadline', () => {
  const p = A.buildAsk({ task: confTask, data: fx1464, cardUrl: 'https://agencyreport.example/kc.html?t=1464&k=' + 'a'.repeat(32), serviceToken: 'tok', rev: 2 });
  assert.strictEqual(p.ask_id, 'ask_t1464_keyword_confirmation');
  assert.strictEqual(p.rev, 2);
  assert.strictEqual(p.kind, 'confirmation');
  assert.strictEqual(p.service, 'seo');
  assert.strictEqual(p.default_policy, 'none');
  assert.strictEqual(p.deadline, '2026-10-30T10:59:00Z');
  assert.deepStrictEqual(p.items.map((i) => i.item_id), ['group_first', 'group_next', 'group_hold', 'mapping_overall', 'global_note']);
  assert.ok(!p.items.some((i) => i.type === 'approve'), 'card asks never use approve');
  for (const i of p.items.slice(0, 4)) { assert.deepStrictEqual(i.options, ['agree', 'hold', 'other']); assert.deepStrictEqual(i.requires_text_when, ['other']); }
  assert.strictEqual(p.items[4].required, false);
  const zh = p.lang_pack.texts.zh;
  assert.strictEqual(zh.items.mapping_overall.options.agree, '同意，按这份分工执行');
  assert.strictEqual(zh.items.group_first.options.hold, '保持现状', 'default single labels fill in');
  assert.deepStrictEqual(p.items[1].block_refs, ['b_next_rank', 'b_next_lowcomp', 'b_next_new']);
  assert.strictEqual(zh.blocks.length, fx1464.blocks.length);
  assert.strictEqual(zh.default_note, '到期未回复不视为同意，我们会再跟进确认');
  assert.ok(zh.intro.includes('kc.html'));
  assert.ok(!JSON.stringify(p).includes('a'.repeat(32)), 'plaintext card token must not enter the payload');
});
t('payload for 1464 matches the committed fixture that the PHP suite feeds to asks_norm_register', () => {
  const want = require('./fixtures/ask_t1464_rev2.json');
  const p = A.buildAsk({ task: { id: 1464, client_id: 55, card_kind: 'keyword_confirmation', title: 'onboard 闸材料：词表与 mapping 确认路径判定与产出' }, data: fx1464, cardUrl: 'https://agencyreport.horntech-dev.com/reports/webforger/keyword_mapping_confirmation_2026-10.html', serviceToken: 'fixture', rev: 2 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p)), want);
});
t('v1 option codes are checked against the shared guard; bad cards throw instead of registering a mismatched Ask', () => {
  const bad = (mut) => { const d = JSON.parse(JSON.stringify(fx1464)); mut(d); return () => A.buildAsk({ task: confTask, data: d, serviceToken: 'tok' }); };
  assert.throws(bad((d) => d.items.push({ item_id: 'new_terms', type: 'multi', options: [{ code: 'free website', label: 'free website' }] })), /选项码/);
  assert.throws(bad((d) => d.items.push({ item_id: 'new_terms', type: 'multi', options: [{ code: 'flag', label: 'x' }] })), /选项码/);
  assert.throws(bad((d) => { d.items[0].options = [{ code: 'approve', label: 'x' }, { code: 'reject', label: 'y' }]; }), /agree\/hold\/other/);
  assert.throws(bad((d) => { d.items[0].block_refs = ['b_missing']; }), /b_missing/);
  assert.throws(bad((d) => { d.card_kind = 'mapping_confirmation'; }), /不符/);
  assert.throws(bad((d) => { d.service = 'ads'; }), /service/);
});
t('v1 multi keeps code to label, default_policy comes from the card, missing service falls back to the registry', () => {
  const d = JSON.parse(JSON.stringify(fx1464));
  d.items.splice(4, 0, { item_id: 'new_terms', type: 'multi', required: false, q: '想加哪些词', options: [{ code: 'gutter_clean', label: 'gutter cleaning auckland' }, { code: 't2', label: '排水沟清理' }] });
  d.default_policy = 'no_reply_follow_recommendation';
  delete d.service;
  const p = A.buildAsk({ task: confTask, data: d, serviceToken: 'tok' });
  const nt = p.items.find((i) => i.item_id === 'new_terms');
  assert.deepStrictEqual(nt.options, ['gutter_clean', 't2']);
  assert.deepStrictEqual(p.lang_pack.texts.zh.items.new_terms.options, { gutter_clean: 'gutter cleaning auckland', t2: '排水沟清理' });
  assert.strictEqual(p.default_policy, 'no_reply_follow_recommendation', 'card value wins over the kind fallback');
  assert.strictEqual(p.service, 'seo', 'registry fallback');
});
t('registry file in the repo resolves every known card kind with a lane', () => {
  const k = A.loadCardKinds();
  for (const name of ['keyword_direction', 'creative_direction', 'keyword_confirmation', 'mapping_confirmation', 'blog_confirmation', 'onsite_confirm']) {
    assert.ok(k[name], name);
    assert.ok(['seo', 'sem'].includes(k[name].service), name + ' lane');
  }
  assert.strictEqual(A.loadCardKinds('/nonexistent.json').keyword_direction.service, 'sem', 'fallback when the file is missing');
});

console.log('buildPlanApprovalAsk');
t('plan approval ask matches the manual precedent shape', () => {
  const p = A.buildPlanApprovalAsk({ clientId: 55, planId: 69, version: 8, summary: '方案 v8 方向确认 · WebForger\n目标：...' });
  assert.strictEqual(p.ask_id, 'ask_plan_approval_69');
  assert.strictEqual(p.kind, 'plan_approval');
  assert.strictEqual(p.default_policy, 'none');
  assert.strictEqual(p.items.length, 1, 'exactly one approve item');
  assert.strictEqual(p.items[0].item_id, 'plan_approve');
  assert.deepStrictEqual(p.items[0].requires_text_when, ['reject']);
  assert.strictEqual(p.deadline, undefined, 'approval gate has no expiry');
  assert.deepStrictEqual(p.source_ref, { plan_id: 69 });
  assert.ok(p.lang_pack.texts.zh.intro.includes('方向确认'));
});

console.log('registerCardAsk');
t('reads a fresh card_data v1 from reports/ and posts it through api.postAsk', async () => {
  const fs = require('fs'); const os = require('os');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'askreg-'));
  fs.mkdirSync(path.join(ws, 'reports'));
  fs.writeFileSync(path.join(ws, 'reports', 'keyword_confirmation_webforger_2026-10.data.json'), JSON.stringify(fx1464));
  let got = null;
  const fakeApi = { postAsk: async (b) => { got = b; return { ok: true, ask_id: b.ask_id, created: true }; } };
  const reg = await A.registerCardAsk({ api: fakeApi, task: confTask, workspace: ws, cardUrl: '', serviceToken: 'tok', log: () => {} });
  assert.strictEqual(reg.ask_id, 'ask_t1464_keyword_confirmation');
  assert.strictEqual(reg.created, true);
  assert.strictEqual(got.client_id, 55);
  assert.strictEqual(got.items[0].item_id, 'group_first');
});
t('card task without card data logs and registers nothing', async () => {
  const logs = [];
  const reg = await A.registerCardAsk({ api: { postAsk: async () => { throw new Error('must not be called'); } }, task: confTask, workspace: '/nonexistent', serviceToken: 'tok', log: (m) => logs.push(m) });
  assert.strictEqual(reg, null);
  assert.ok(logs.some((m) => m.includes('不登记')));
});
t('task without card_kind registers nothing', async () => {
  const reg = await A.registerCardAsk({ api: { postAsk: async () => { throw new Error('must not be called'); } }, task: { id: 9, client_id: 1 }, workspace: '/nonexistent', serviceToken: 'tok' });
  assert.strictEqual(reg, null);
});

if (!waiting) finish();
