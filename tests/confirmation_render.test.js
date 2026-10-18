'use strict';
// 确认卡渲染器回归（card_data v1）：单一事实源纪律（题只出自 items）、选项码护栏
// （asks_code_ok 与 choice 列宽同源）、default_policy 必填与到期文案生成、纯文本守卫、widget 原样注入。
const assert = require('assert');
const path = require('path');
const R = require(path.join(__dirname, '..', 'seo-worker', 'specs', 'report', 'render_confirmation.js'));

function base() {
  return {
    schema: 'card_data/v1',
    card_kind: 'keyword_confirmation',
    kind: 'confirmation',
    service: 'seo',
    cycle: 'onboard',
    lang: 'zh',
    title: 'T 目标词与承接确认',
    oneline: '先打快赢组，词和页面的分工按下表来。',
    issued: '2026-10',
    deadline: '2026-10-30',
    default_policy: 'none',
    blocks: [
      { id: 'b_groups', type: 'table', title: '目标词分组', columns: ['词', '归属页', '当前位次'], rows: [['curtains auckland', '/curtains/', '12'], ['blinds nz', '/blinds/', '28']] },
      { id: 'b_note', type: 'para', text: '第一批先做已有页面能接住的词。' },
      { id: 'b_list', type: 'list', title: '要建的新页', items: ['/roman-blinds/', '/sheer-curtains/'] },
      { id: 'b_kv', type: 'kv', entries: [{ k: '现状', v: '首页接了全部词' }, { k: '方案', v: '按组分流到对应页' }] },
    ],
    items: [
      { item_id: 'group_first', type: 'single', q: '第一批主攻这组行不行', situation: '这组已有排名基础。', recommendation: '先做这组。', block_refs: ['b_groups'] },
      { item_id: 'mapping_overall', type: 'single', q: '词和页面的分工这样定行不行', situation: '现状见下。', recommendation: '按方案分流。', block_refs: ['b_kv'],
        options: [{ code: 'agree', label: '同意这样分工' }, { code: 'hold', label: '先不动' }, { code: 'other', label: '要调整' }] },
      { item_id: 'new_terms', type: 'multi', q: '这些建议新增的词，勾掉不想做的', options: [
        { code: 'roman_blinds', label: 'roman blinds auckland', note: '月均曝光 900' },
        { code: 'sheer', label: 'sheer curtains nz' },
      ] },
      { item_id: 'global_note', type: 'text', hint: '其他想法写这里。' },
    ],
    html_extra: { scope_line: '位次口径一行说明', fineprint: ['位次为 <b>2026-10-17</b> 现测。'] },
  };
}

// 1) 正常渲染：widget 原样注入（双端点、令牌判卡），无剩余槽位（renderWithTemplate 自查）
const html = R.renderCard(base());
assert(html.includes("parseInt(params.get('t'), 10)") && html.includes("params.get('k')"), 'widget 必须原样注入');
assert(html.includes("'/reports/card_feedback.php'") && html.includes('API_FALLBACK'), '双端点约定必须在（2026-09-08 外网保存事故）');

// 2) 单一事实源：每个可表态 item 都有且只有 items[] 来的 data-item；global_note 走浮动控件
for (const id of ['group_first', 'mapping_overall', 'new_terms']) {
  assert(html.includes('data-item="' + id + '"'), '缺 data-item: ' + id);
}
const diCount = (html.split('<script>')[0].match(/data-item="/g) || []).length;
assert.strictEqual(diCount, 3, 'data-item 只能出自 items[]，实际 ' + diCount + ' 个');
assert(html.includes("post('global_note', 'other', v)"), 'global_note 浮动留言在');

// 3) 选项码落 checkbox 的是 code，label 只展示
assert(html.includes('data-kw="roman_blinds"') && html.includes('roman blinds auckland'), 'multi 勾选必须带 code，词条原文在 label');
assert(!html.includes('data-kw="roman blinds auckland"'), '词条原文不得当码');

// 4) 到期文案由 default_policy 生成
assert(html.includes('不视为同意'), 'none 口径的到期行必须由渲染器生成');
const soft = base(); soft.default_policy = 'no_reply_follow_recommendation';
assert(R.renderCard(soft).includes('按卡上建议执行'), '软闸口径到期行');
const noPolicy = base(); delete noPolicy.default_policy;
assert.throws(() => R.validate(noPolicy), /default_policy 产线必填/, 'default_policy 缺省必须拒（v1 修订 2）');

// 5) 选项码护栏（v1 修订 1）：空格、超长、重复都拒；single 码只许三态按序
const sp = base(); sp.items[2].options[0].code = 'roman blinds';
assert.throws(() => R.validate(sp), /16 字符内/, '带空格的码必须拒');
const lg = base(); lg.items[2].options[0].code = 'a_very_long_code_over16';
assert.throws(() => R.validate(lg), /16 字符内/);
const dup = base(); dup.items[2].options[1].code = 'roman_blinds';
assert.throws(() => R.validate(dup), /重复/);
const badSingle = base(); badSingle.items[1].options[0].code = 'approve';
assert.throws(() => R.validate(badSingle), /agree\/hold\/other/, '卡类不再使用 approve');

// 6) 纯文本守卫：blocks/items 里出现 HTML 标记拒；html_extra 的 fineprint 放行 <b>
const tag = base(); tag.blocks[1].text = '第一批<b>先做</b>。';
assert.throws(() => R.validate(tag), /纯文本/, 'blocks 不收 HTML');
assert(html.includes('<b>2026-10-17</b>'), 'html_extra.fineprint 的 <b> 要活着');
const extraKey = base(); extraKey.html_extra.bignums = [];
assert.throws(() => R.validate(extraKey), /html_extra v1 只认/, 'html_extra 未知键必须拒（退役 HTML 便宜的红线）');

// 7) 结构守卫：block_refs 悬空、text 题越界、行列不齐、kind 不符
const ref = base(); ref.items[0].block_refs = ['b_nope'];
assert.throws(() => R.validate(ref), /不存在的块/);
const txt = base(); txt.items[3].item_id = 'free_text';
assert.throws(() => R.validate(txt), /只允许 global_note/);
const row = base(); row.blocks[0].rows[0] = ['只有一列'];
assert.throws(() => R.validate(row), /列数/);
const dir = base(); dir.kind = 'direction';
assert.throws(() => R.validate(dir), /kind=confirmation/);

// 8) 通用守卫复用：script、内部术语、破折号
const scr = base(); scr.blocks[1].text = 'x <script>y</script>';
assert.throws(() => R.validate(scr), /script|纯文本/);
const jargon = base(); jargon.oneline = 'CTR 会更好';
assert.throws(() => R.validate(jargon), /内部术语/);
const dash = base(); dash.oneline = '快赢—先做';
assert.throws(() => R.validate(dash), /破折号/);

// 9) 卡级块与题下块分流：未被引用的 b_note/b_list 进卡级节，被引用的挂题下
assert(html.indexOf('本次确认的依据') !== -1, '有未引用块时卡级节在');
const allRef = base();
allRef.items[0].block_refs = ['b_groups', 'b_note', 'b_list', 'b_kv'];
const html2 = R.renderCard(allRef);
assert(html2.indexOf('本次确认的依据') === -1, '全部块被引用时不出卡级节');
assert(/snum">1</.test(html2), '无卡级节时确认节编号是 1');

// 10) 自定义 label 生效，默认 label 兜底
assert(html.includes('同意这样分工') && html.includes('同意按建议执行'), '自定义与默认按钮文案并存');

console.log('confirmation_render: all ok');
