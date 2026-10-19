#!/usr/bin/env node
/* 卡反馈折叠的纯逻辑单测。用例底稿是 Sammichelle #306 的真实反馈序列
   （2026-09-13：同项反复表态、测试提交、other 里埋新需求）。跑法：node tests/cardfold.test.js */
const assert = require('assert');
const { foldCardFeedback, summariseFold, specFactsFromFold } = require('../seo-worker/lib/cardfold');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

const r = (item, choice, fb) => ({ item, choice, fb: fb || '', created_at: '2026-09-10 10:00:00' });

t('同一 item 反复表态取最后一次（sammichelle 商场词：同意 保持 保持 同意 = 同意）', () => {
  const f = foldCardFeedback([r('retailer_terms', 'agree'), r('retailer_terms', 'hold'), r('retailer_terms', 'hold'), r('retailer_terms', 'agree')]);
  assert.strictEqual(f.agreed.length, 1);
  assert.strictEqual(f.holds.length, 0);
  assert.strictEqual(f.agreed[0].item, 'retailer_terms');
});

t('other 不覆盖表态，文本单独保留', () => {
  const f = foldCardFeedback([r('keyword_plan', 'agree'), r('keyword_plan', 'other', 'suitcase 订单下滑帮我分析')]);
  assert.strictEqual(f.agreed.length, 1);
  assert.strictEqual(f.texts.length, 1);
  assert.ok(f.texts[0].text.includes('suitcase'));
});

t('空文本的 other 行不进 texts（api 层已转 hold，这里兜底）', () => {
  const f = foldCardFeedback([r('x', 'other', ''), r('x', 'other', '  ')]);
  assert.strictEqual(f.texts.length, 0);
  assert.strictEqual(f.agreed.length + f.holds.length, 0);
});

t('flag 算可执行确认，勾选清单在 fb 里', () => {
  const f = foldCardFeedback([r('cleanup_list', 'flag', 'asset 1,asset 3')]);
  assert.strictEqual(f.agreed.length, 1);
  assert.strictEqual(f.agreed[0].choice, 'flag');
  assert.strictEqual(f.agreed[0].fb, 'asset 1,asset 3');
});

t('无 item 的表态归 _card', () => {
  const f = foldCardFeedback([r('', 'agree')]);
  assert.strictEqual(f.agreed[0].item, '_card');
});

t('多项混合：最终每项一个归宿，摘要三段齐', () => {
  const f = foldCardFeedback([
    r('a', 'agree'), r('b', 'hold'), r('c', 'agree'), r('c', 'hold'),
    r('d', 'other', '换个说法'),
  ]);
  assert.deepStrictEqual(f.agreed.map((x) => x.item).sort(), ['a']);
  assert.deepStrictEqual(f.holds.map((x) => x.item).sort(), ['b', 'c']);
  assert.strictEqual(f.texts.length, 1);
  const s = summariseFold(f);
  assert.ok(s.includes('同意 1 项') && s.includes('保持观察 2 项') && s.includes('文本反馈 1 条'), s);
});

t('空输入不炸，hasAny false', () => {
  const f = foldCardFeedback([]);
  assert.strictEqual(f.hasAny, false);
  assert.strictEqual(summariseFold(f), '无有效表态');
});

t('未知 choice 不炸也不静默：不算表态，原样进 texts 并点名 attention（2026-10-19 口径，旧口径是静默忽略）', () => {
  const f = foldCardFeedback([{ item: 'x', choice: 'maybe', fb: '' }]);
  assert.strictEqual(f.agreed.length + f.holds.length, 0);
  assert.strictEqual(f.texts.length, 1);
  assert.ok(f.texts[0].text.includes('maybe'));
  assert.deepStrictEqual(f.attention, [{ item: 'x', reason: 'unknown_code', choice: 'maybe' }]);
  assert.strictEqual(f.hasStance, true);
});

/* 防御性映射回归（2026-10-19，问题 A：WF 对确认卡答 approve 曾被折成「无有效表态」并收口，驳回理由丢失）。 */
t('回归：WF 答 approve 不得再被折成无有效表态，视同 agree 可落地', () => {
  const f = foldCardFeedback([{ id: 1, item: 'approval', choice: 'approve', fb: '' }]);
  assert.strictEqual(f.agreed.length, 1);
  assert.strictEqual(f.agreed[0].choice, 'agree');
  assert.strictEqual(f.agreed[0].mapped_from, 'approve');
  assert.notStrictEqual(summariseFold(f), '无有效表态');
  assert.strictEqual(f.attention.length, 0);
});
t('回归：reject 视同 hold，驳回理由必须进 texts，并点名 attention', () => {
  const f = foldCardFeedback([{ id: 1, item: 'approval', choice: 'reject', fb: '首页不要动 title' }]);
  assert.strictEqual(f.holds.length, 1);
  assert.strictEqual(f.holds[0].mapped_from, 'reject');
  assert.strictEqual(f.texts.length, 1);
  assert.ok(f.texts[0].text.includes('首页不要动 title'));
  assert.deepStrictEqual(f.attention, [{ item: 'approval', reason: 'reject' }]);
  const g = foldCardFeedback([{ id: 2, item: 'approval', choice: 'reject', fb: '' }]);
  assert.ok(g.texts[0].text.includes('未附理由'), '空理由也要留痕');
});
t('只有空码行：hasAny 为真但 hasStance 为假，调用方据此不许收口', () => {
  const f = foldCardFeedback([{ id: 1, item: 'x', choice: '', fb: '' }]);
  assert.strictEqual(f.hasAny, true);
  assert.strictEqual(f.hasStance, false);
});
t('v1 勾选行按解码表还原词面，codes 留原值；旧 HTML 词面行原样；两种形态同卡混合也对', () => {
  const decode = { new_terms: { gutter_clean: 'gutter cleaning auckland', t2: '排水沟清理' } };
  const f = foldCardFeedback([{ id: 1, item: 'new_terms', choice: 'flag', fb: 'gutter_clean, t2' }], { decode });
  assert.strictEqual(f.agreed[0].fb, 'gutter cleaning auckland, 排水沟清理');
  assert.deepStrictEqual(f.agreed[0].codes, ['gutter_clean', 't2']);
  const legacy = foldCardFeedback([{ id: 1, item: 'keep_terms', choice: 'flag', fb: 'harvey norman, noel leeming' }], { decode: { keep_terms: { harvey_norman: 'harvey norman' } } });
  assert.strictEqual(legacy.agreed[0].fb, 'harvey norman, noel leeming', '旧卡落的是词面，不在码表里，原样');
  const mixed = foldCardFeedback([{ id: 1, item: 'keep_terms', choice: 'flag', fb: 'harvey_norman, noel leeming' }], { decode: { keep_terms: { harvey_norman: 'harvey norman' } } });
  assert.strictEqual(mixed.agreed[0].fb, 'harvey norman, noel leeming');
  const nodec = foldCardFeedback([{ id: 1, item: 'new_terms', choice: 'flag', fb: 'gutter_clean,t2' }]);
  assert.strictEqual(nodec.agreed[0].fb, 'gutter_clean,t2', '无解码表时 fb 字节不变');
});
t('带 at_utc 的行按作答时刻排序（WF 补发晚到不抢先），缺 at_utc 退回 id 序', () => {
  const rows = [
    { id: 10, item: 'g', choice: 'agree', fb: '', at_utc: '2026-10-20T01:00:00Z' },
    { id: 11, item: 'g', choice: 'hold', fb: '', at_utc: '2026-10-19T23:00:00Z' },
  ];
  assert.strictEqual(foldCardFeedback(rows, { byAnsweredAt: true }).agreed.length, 1, '按作答时刻 agree 在后');
  assert.strictEqual(foldCardFeedback(rows).holds.length, 1, '不开开关仍是 id 序');
  const partial = [rows[0], { id: 11, item: 'g', choice: 'hold', fb: '' }];
  assert.strictEqual(foldCardFeedback(partial, { byAnsweredAt: true }).holds.length, 1, '有行缺 at_utc 整体退回 id 序');
});

/* 到期时钟锚点（2026-09-20 出卡日起算）。 */
const { cardClockAnchor } = require('../seo-worker/lib/cardfold');

t('锚点取最早交付附件时间（无 sent_at 也起钟，出卡日口径）', () => {
  const a = cardClockAnchor({ sent_at: null, deliverables: [{ created_at: '2026-09-20 11:40:37' }, { created_at: '2026-09-21 08:00:00' }] });
  assert.strictEqual(a, '2026-09-20 11:40:37');
});

t('sent_at 早于附件时取 sent_at（人工提前标发仍有效）', () => {
  const a = cardClockAnchor({ sent_at: '2026-09-19 09:00:00', deliverables: [{ created_at: '2026-09-20 11:40:37' }] });
  assert.strictEqual(a, '2026-09-19 09:00:00');
});

t('sent_at 与附件都没有的旧卡不起钟（#145 兜底）', () => {
  assert.strictEqual(cardClockAnchor({ sent_at: null, deliverables: [] }), null);
  assert.strictEqual(cardClockAnchor({}), null);
});

/* ---- 规格 fact 直落（批⑤二件，#1517/#1519 底稿）---- */

const FM = {
  budget_monthly: 'ads.budget_monthly',
  hard_rules: 'ads.rules',
  brand_style: ['ads.creative.brand_style', 'ads.creative.asset_sources'],
};
const CTX = { askId: 'ask_t1517_sem_onboard', rev: 1, itemTexts: { budget_monthly: { recommendation: '统计修好之前不放量，起步每月 NZ$900。' } }, cardUrl: 'https://x/card.html' };

t('直落：agree 带卡上 recommendation 原文与 ask 署名', () => {
  const f = foldCardFeedback([r('budget_monthly', 'agree')]);
  const out = specFactsFromFold(f, FM, CTX);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].fact_key, 'ads.budget_monthly');
  assert.ok(out[0].value.includes('NZ$900'));
  assert.ok(out[0].value.includes('ask_t1517_sem_onboard'));
});

t('直落：映射外的 item 不落，hold 不落', () => {
  const f = foldCardFeedback([r('target_goal', 'agree'), r('budget_monthly', 'hold')]);
  assert.strictEqual(specFactsFromFold(f, FM, CTX).length, 0);
});

t('直落：multi 勾选落词面，none 单独出现落无客户限制', () => {
  const dec = { hard_rules: { no_free: '广告不说 free', none: '以上都不适用' } };
  const f1 = foldCardFeedback([r('hard_rules', 'flag', 'no_free')], { decode: dec });
  const o1 = specFactsFromFold(f1, FM, CTX);
  assert.strictEqual(o1[0].fact_key, 'ads.rules');
  assert.ok(o1[0].value.includes('广告不说 free'));
  const f2 = foldCardFeedback([r('hard_rules', 'flag', 'none')], { decode: dec });
  assert.ok(specFactsFromFold(f2, FM, CTX)[0].value.includes('无客户限制'));
  const f3 = foldCardFeedback([r('hard_rules', 'flag', 'none,no_free')], { decode: dec });
  assert.ok(!specFactsFromFold(f3, FM, CTX)[0].value.includes('无客户限制'));
});

t('直落：一个 item 映射多键时每键各落一条同值', () => {
  const f = foldCardFeedback([r('brand_style', 'agree')]);
  const out = specFactsFromFold(f, FM, CTX);
  assert.deepStrictEqual(out.map((x) => x.fact_key), ['ads.creative.brand_style', 'ads.creative.asset_sources']);
  assert.strictEqual(out[0].value, out[1].value);
});

t('直落：无 recommendation 时回退指卡链接，不编内容', () => {
  const f = foldCardFeedback([r('brand_style', 'agree')]);
  const out = specFactsFromFold(f, FM, { ...CTX, itemTexts: {} });
  assert.ok(out[0].value.includes('https://x/card.html'));
  assert.ok(out[0].value.includes('brand_style'));
});

t('直落：没有映射表或空折叠回空数组', () => {
  const f = foldCardFeedback([r('budget_monthly', 'agree')]);
  assert.deepStrictEqual(specFactsFromFold(f, null, CTX), []);
  assert.deepStrictEqual(specFactsFromFold(foldCardFeedback([]), FM, CTX), []);
});

console.log(pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
