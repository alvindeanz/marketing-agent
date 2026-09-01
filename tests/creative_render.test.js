'use strict';
// 素材方向卡渲染器回归：立场 1/2 强制、A31、widget 注入、共用模板槽位闭合。
const assert = require('assert');
const { renderCard, validate } = require('../seo-worker/specs/report/render_creative_direction.js');

function base() {
  return {
    title: 'T 搜索广告素材方向', period_label: '2026 年 8 月', oneline: '方向。', scope_line: '询价只算表单。',
    bignums: [{ k: '花了', v: '1', s: 's' }, { k: '最佳广告换来', v: '2', unit: '条', s: 'Free Quotation 那条' }, { k: '一条', v: '3', s: 's' }],
    fineprint: ['<b>询价</b>口径。'],
    s1_desc: 'd', s2_desc: 'd',
    decisions: [{ q: 'q', situation: 's', recommendation: 'r', no_reply: 'n', item: 'copy_batch_1', textarea_hint: 'h',
      picks: { ph: 'p', save_item: 'zero_impression_cleanup', entries: [{ kw: 'a', label: 'A', note: 'n' }] } }],
    families: [{ name: 'louvre roof 组的广告一', cls: 'g', state_label: '保持', brief: 'b', spent: 'a', got: 'b', next: 'c', evidence: 'e' }],
    negatives: ['清理段。'], confirm: ['首版。'],
    glossary: [{ term: '询价', def: 'd' }], window_line: 'w', attach_line: '随附文件：无',
  };
}

const html = renderCard(base());
assert(html.includes("parseInt(params.get('t'), 10)"), 'widget 原样注入');
assert(html.includes('素材方向'), 'badge 是素材方向');
assert(html.includes('每条广告的成绩单'), '素材卡章节标题');
assert(!/{{[^}]+}}/.test(html), '无未填槽位');

// 立场 2：Ad Strength 不进客户报告
const s2 = base(); s2.negatives = ['这条广告 Ad Strength 低'];
assert.throws(() => validate(s2), /立场 2/);
// 立场 1：素材级不算单条询价成本
const s1 = base(); s1.negatives = ['素材级单条询价成本 5 纽币'];
assert.throws(() => validate(s1), /立场 1/);
// A31
const zh = base(); zh.families[0].name = '百叶顶组的广告';
assert.throws(() => validate(zh), /copy_rules A31/);

console.log('creative_render.test ok');
