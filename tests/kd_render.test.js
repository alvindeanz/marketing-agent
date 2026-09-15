'use strict';
// 关键词方向卡渲染器回归：A31 不变量、script 拒绝、widget 原样注入。
const assert = require('assert');
const { renderCard, validate } = require('../seo-worker/specs/report/render_keyword_direction.js');

function base() {
  return {
    title: 'T 搜索广告关键词方向', issued: '2026-09', window: { start: '2026-07-01', end: '2026-08-31' },
    oneline: '方向。', scope_line: '询价只算表单。',
    bignums: [{ k: 'a', v: '1', s: 's' }, { k: 'b', v: '2', s: 's' }, { k: 'c', v: '3', s: 's' }],
    fineprint: ['<b>询价</b>口径。'],
    s1_desc: 'd', s2_desc: 'd',
    decisions: [{ q: 'q', situation: 's', recommendation: 'r', no_reply: 'n', item: 'x_y', textarea_hint: 'h' }],
    families: [{ name: 'louvre roof 类搜索', cls: 'g', state_label: '加大投入', brief: 'b', spent: 'a', got: 'b', next: 'c', evidence: 'e' }],
    negatives: ['n'], confirm: ['c'],
    glossary: [{ term: '询价', def: 'd' }], attach_line: 'a',
  };
}

// 1) 正常数据渲染，widget 原样在
const html = renderCard(base());
assert(html.includes("parseInt(params.get('t'), 10)") && html.includes("params.get('k')"), 'widget 必须原样注入');
assert(html.includes('card_feedback'), '提交端点在');
// 2026-09-08 外网保存事故：对客页首选同域中继，看板域只能是降级备胎（外网 403）
assert(html.includes("'/reports/card_feedback.php'"), '首选端点必须是同域中继');
assert(html.includes('API_FALLBACK'), '必须带看板域降级备胎，否则中继落位前内网也存不了');

// 2) A31：词族名与红绿灯名全中文 => 拒绝
const zh = base();
zh.families[0].name = '百叶顶类搜索';
assert.throws(() => validate(zh), /copy_rules A31/, '全中文名称槽必须被拒');

// 3) 概念类词族纯中文但整卡有拉丁词 => 放行
const mix = base();
mix.families.push({ name: '店名相关搜索', cls: 'h', state_label: '保持', brief: 'b', spent: 'a', got: 'b', next: 'c', evidence: 'e' });
validate(mix);

// 4) script 注入 => 拒绝；内部术语 => 拒绝
const bad = base(); bad.negatives = ['<script>x</script>'];
assert.throws(() => validate(bad), /script/);
const jargon = base(); jargon.negatives = ['CTR 高'];
assert.throws(() => validate(jargon), /内部术语/);

// 5) 数据窗口（2026-09-15 Alvin 口径：发卡月前两个完整自然月，日期渲染器生成）
assert(html.includes('2026 年 7 月 1 日至 8 月 31 日'), '周期与窗口日期由渲染器从 window 生成');
const wEnd = base(); wEnd.window.end = '2026-09-14';
assert.throws(() => validate(wEnd), /上一个自然月最后一天/, 'end 不是上月末必须拒');
const wStart = base(); wStart.window.start = '2026-07-12';
assert.throws(() => validate(wStart), /exception_note/, '窗口不足两整月且无说明必须拒');
wStart.window.exception_note = '账户 2026 年 7 月 12 日才开始投放，按实际天数计。';
const shortHtml = renderCard(wStart);
assert(shortHtml.includes('7 月 12 日') && shortHtml.includes('按实际天数计'), '例外窗口带说明放行且进页脚');
const hand = base(); hand.period_label = '手写周期';
assert.throws(() => validate(hand), /渲染器/, '模型手写 period_label 必须拒');
const xy = base(); xy.issued = '2027-01'; xy.window = { start: '2026-11-01', end: '2026-12-31' };
assert(renderCard(xy).includes('2026 年 11 月 1 日至 12 月 31 日'), '跨年窗口日期正确');

console.log('kd_render.test ok');
