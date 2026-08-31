'use strict';
// 关键词方向卡渲染器回归：A31 不变量、script 拒绝、widget 原样注入。
const assert = require('assert');
const path = require('path');
const { renderCard, validate } = require('../seo-worker/specs/report/render_keyword_direction.js');
const TPL = path.join(__dirname, '../seo-worker/specs/report/keyword_direction_template.html');

function base() {
  return {
    title: 'T 搜索广告关键词方向', period_label: '2026 年 9 月 1 日至 9 月 14 日期', oneline: '方向。',
    bignums: [{ k: 'a', v: '1', s: 's' }, { k: 'b', v: '2', s: 's' }, { k: 'c', v: '3', s: 's' }],
    fineprint: ['<b>询价</b>口径。'],
    lights: [{ name: 'louvre roof 类搜索', state_label: '加大投入', cls: 'g' }],
    s1_desc: 'd', s2_desc: 'd',
    decisions: [{ q: 'q', situation: 's', recommendation: 'r', no_reply: 'n', item: 'x_y', textarea_hint: 'h' }],
    families: [{ name: 'louvre roof 类搜索', cls: 'g', state_label: '加大投入', spent: 'a', got: 'b', next: 'c', evidence: 'e' }],
    negatives: ['n'], findings_title: 't', findings: ['f'], confirm: ['c'],
    glossary: [{ term: '询价', def: 'd' }], window_line: 'w', attach_line: 'a',
  };
}

// 1) 正常数据渲染，widget 原样在
const html = renderCard(base(), TPL);
assert(html.includes("parseInt(params.get('t'), 10)") && html.includes("params.get('k')"), 'widget 必须原样注入');
assert(html.includes('card_feedback'), '提交端点在');

// 2) A31：词族名与红绿灯名全中文 => 拒绝
const zh = base();
zh.families[0].name = '百叶顶类搜索';
zh.lights[0].name = '百叶顶类搜索';
assert.throws(() => validate(zh), /copy_rules A31/, '全中文名称槽必须被拒');

// 3) 概念类词族纯中文但整卡有拉丁词 => 放行
const mix = base();
mix.families.push({ name: '店名相关搜索', cls: 'h', state_label: '保持', spent: 'a', got: 'b', next: 'c', evidence: 'e' });
validate(mix);

// 4) script 注入 => 拒绝；内部术语 => 拒绝
const bad = base(); bad.negatives = ['<script>x</script>'];
assert.throws(() => validate(bad), /script/);
const jargon = base(); jargon.findings = ['CTR 高'];
assert.throws(() => validate(jargon), /内部术语/);

console.log('kd_render.test ok');
