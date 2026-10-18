'use strict';
// 确认卡渲染器：零 LLM。card_data v1 JSON（card_data_v1.schema.json，kind=confirmation）->
// confirmation_card_template.html -> 客户版 HTML。引擎与守卫复用 direction_card_lib.js。
// CLI: node render_confirmation.js <data.json> [template.html] > out.html
//
// 单一事实源纪律（card_data v1 主轴）：题（data-item 与选项码）只能出自 items[]，
// 本渲染器是这条纪律的结构性保证：模板里不存在 items 之外的任何 data-item 出口，
// agent 不再手写 HTML，也就不可能在 HTML 里另起题。

const fs = require('fs');
const path = require('path');
const lib = require('./direction_card_lib.js');

const TPL_PATH = path.join(__dirname, 'confirmation_card_template.html');

// 选项码与账本口径（与 seo-api asks_code_ok / ASK_CHOICE_COL_MAX 同源）：
// single 固定三态；multi 的 code 是机器短码，HTML 勾选和 WF 答题落账的都是 code，
// label 只做展示，data.json 是唯一解码表。
const SINGLE_CODES = ['agree', 'hold', 'other'];
const MULTI_CODE_RE = /^[a-z0-9_.:-]{1,16}$/;
const ITEM_ID_RE = /^[a-z0-9_]{1,60}$/;
const BLOCK_ID_RE = /^b_[a-z0-9_]{1,30}$/;
const MAX_JSON_BYTES = 196608; // Ask lang_pack 上限 256KB，产出侧压 192KB 留余量

const DEFAULT_SINGLE_LABELS = { agree: '同意按建议执行', hold: '保持现状，继续观察', other: '其他反馈' };
const POLICY_LINES = {
  none: '到期未回复不视为同意：我们会再与您跟进确认，确认之前不会执行。',
  no_reply_follow_recommendation: '到期未回复，按卡上建议执行。',
};
const BADGES = {
  keyword_confirmation: '网站优化 · 目标词与承接确认',
  mapping_confirmation: '网站优化 · 承接页确认',
};

function bad(msg) { throw new Error(msg); }

/* 纯文本守卫：blocks 与 items 的一切文字不收 HTML 标签（同一份内容还要进 WF 的
   lang_pack 纯文本渲染，两边必须看到同一段字）。html_extra 是唯一的版式豁免区。 */
function guardPlainText(v, where) {
  if (typeof v === 'string') {
    if (v.includes('<')) bad(where + ' 含 HTML 标记（blocks 与 items 只收纯文本，版式性内容进 html_extra）');
    return;
  }
  if (Array.isArray(v)) { v.forEach((x, i) => guardPlainText(x, where + '[' + i + ']')); return; }
  if (v && typeof v === 'object') { for (const k of Object.keys(v)) guardPlainText(v[k], where + '.' + k); }
}

function validateBlock(b, i) {
  const at = 'blocks[' + i + ']';
  if (!b || typeof b !== 'object') bad(at + ' 必须是对象');
  if (!BLOCK_ID_RE.test(String(b.id || ''))) bad(at + ' id 必须是 b_ 前缀小写短标识: ' + b.id);
  if (b.type === 'para') {
    if (!String(b.text || '').trim()) bad(at + ' para 缺 text');
  } else if (b.type === 'list') {
    if (!Array.isArray(b.items) || !b.items.length || b.items.length > 40) bad(at + ' list items 需 1 到 40 条');
    for (const it of b.items) if (!String(it || '').trim()) bad(at + ' list 有空条目');
  } else if (b.type === 'table') {
    if (!Array.isArray(b.columns) || !b.columns.length || b.columns.length > 8) bad(at + ' table columns 需 1 到 8 列');
    if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 60) bad(at + ' table rows 需 1 到 60 行');
    for (const r of b.rows) {
      if (!Array.isArray(r) || r.length !== b.columns.length) bad(at + ' 每行列数必须等于 columns 列数');
    }
  } else if (b.type === 'kv') {
    if (!Array.isArray(b.entries) || !b.entries.length || b.entries.length > 24) bad(at + ' kv entries 需 1 到 24 条');
    for (const e of b.entries) if (!e || !String(e.k || '').trim() || !String(e.v || '').trim()) bad(at + ' kv 条目缺 k 或 v');
  } else {
    bad(at + ' type 只许 para / list / table / kv: ' + b.type);
  }
}

function validateItem(it, i, blockIds) {
  const at = 'items[' + i + ']';
  if (!it || typeof it !== 'object') bad(at + ' 必须是对象');
  if (!ITEM_ID_RE.test(String(it.item_id || ''))) bad(at + ' item_id 只许小写字母数字下划线: ' + it.item_id);
  if (!['single', 'multi', 'text'].includes(it.type)) bad(at + ' type 只许 single / multi / text: ' + it.type);
  for (const ref of it.block_refs || []) {
    if (!blockIds.has(ref)) bad(at + ' block_refs 指向不存在的块: ' + ref);
  }
  if (it.type === 'text') {
    // v1 收紧：自由文本题只允许 global_note（浮动留言控件承载）。其余文本诉求走
    // single 的 other 通道。放开任意 text 题等 WF 侧有通用文本题渲染后再议。
    if (it.item_id !== 'global_note') bad(at + ' v1 的 text 题只允许 global_note，其余文本走 single 的 other');
    return;
  }
  if (!String(it.q || '').trim()) bad(at + ' 缺 q');
  if (it.type === 'single') {
    if (!String(it.situation || '').trim()) bad(at + ' single 缺 situation');
    if (!String(it.recommendation || '').trim()) bad(at + ' single 缺 recommendation');
    if (it.options != null) {
      if (!Array.isArray(it.options) || it.options.length !== 3) bad(at + ' single options 必须恰好三项（agree/hold/other）');
      const codes = it.options.map((o) => o && o.code);
      if (codes.join(',') !== SINGLE_CODES.join(',')) bad(at + ' single 选项码必须按序为 agree/hold/other，实际: ' + codes.join(','));
      for (const o of it.options) if (!String(o.label || '').trim()) bad(at + ' single 选项缺 label');
    }
    if (it.default != null && !SINGLE_CODES.includes(it.default)) bad(at + ' default 必须是 agree/hold/other');
    for (const c of it.requires_text_when || []) {
      if (!SINGLE_CODES.includes(c)) bad(at + ' requires_text_when 必须是选项码子集: ' + c);
    }
    return;
  }
  // multi
  if (!Array.isArray(it.options) || !it.options.length || it.options.length > 40) bad(at + ' multi options 需 1 到 40 项');
  const seen = new Set();
  for (const o of it.options) {
    const code = String((o && o.code) || '');
    if (!MULTI_CODE_RE.test(code)) bad(at + ' multi 选项码只许 [a-z0-9_.:-] 且 16 字符内（账本列宽与 asks_code_ok 同源）: ' + (code || '(空)'));
    if (seen.has(code)) bad(at + ' multi 选项码重复: ' + code);
    seen.add(code);
    if (!String(o.label || '').trim()) bad(at + ' multi 选项缺 label: ' + code);
  }
}

function validate(d) {
  if (!d || typeof d !== 'object') bad('数据必须是对象');
  if (d.schema !== 'card_data/v1') bad('schema 必须是 card_data/v1');
  if (d.kind !== 'confirmation') bad('本渲染器只接 kind=confirmation（方向卡走各自渲染器，迁 v1 另议）');
  if (!/^[a-z0-9_]{1,32}$/.test(String(d.card_kind || ''))) bad('card_kind 只许小写字母数字下划线 32 字符内: ' + d.card_kind);
  if (d.service !== 'seo' && d.service !== 'sem' && d.service !== null) bad('service 必填：seo / sem / null（混合卡）');
  if (!['onboard', 'monthly', 'adhoc'].includes(d.cycle)) bad('cycle 只许 onboard / monthly / adhoc');
  if (d.lang !== 'zh') bad('v1 渲染器中文写死，lang 必须是 zh（语言跟随是产出侧 Phase 2）');
  if (!String(d.title || '').trim()) bad('缺 title');
  const oneline = String(d.oneline || '');
  if (!oneline.trim()) bad('缺 oneline');
  if (oneline.length > 60) bad('oneline 超 60 字');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(d.issued || ''))) bad('缺 issued（发卡月，YYYY-MM）');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.deadline || ''))) bad('缺 deadline（YYYY-MM-DD）');
  const dl = new Date(d.deadline + 'T00:00:00Z');
  if (Number.isNaN(dl.getTime()) || d.deadline !== dl.toISOString().slice(0, 10)) bad('deadline 不是有效日期: ' + d.deadline);
  // default_policy 产线必填（card_data v1 修订 2）：kind 只在 askreg 兜底，数据层不许缺省，
  // 否则 page-create 族软闸（14 天视同同意，2026-10-15 闸第一性改版）会被「confirmation 一律 none」误伤。
  if (!['none', 'no_reply_follow_recommendation'].includes(d.default_policy)) {
    bad('default_policy 产线必填：none 或 no_reply_follow_recommendation');
  }
  const blocks = d.blocks || [];
  if (!Array.isArray(blocks) || blocks.length > 24) bad('blocks 最多 24 块');
  const blockIds = new Set();
  blocks.forEach((b, i) => {
    validateBlock(b, i);
    if (blockIds.has(b.id)) bad('blocks id 重复: ' + b.id);
    blockIds.add(b.id);
  });
  if (!Array.isArray(d.items) || !d.items.length || d.items.length > 20) bad('items 需 1 到 20 项');
  const itemIds = new Set();
  d.items.forEach((it, i) => {
    validateItem(it, i, blockIds);
    if (itemIds.has(it.item_id)) bad('item_id 重复: ' + it.item_id);
    itemIds.add(it.item_id);
  });
  if (!d.items.some((it) => it.type !== 'text')) bad('至少要有一道可表态的题（single 或 multi）');
  const he = d.html_extra || {};
  if (typeof he !== 'object' || Array.isArray(he)) bad('html_extra 必须是对象');
  for (const k of Object.keys(he)) {
    if (!['scope_line', 'fineprint'].includes(k)) {
      bad('html_extra v1 只认 scope_line 与 fineprint（任何题和作答依据不得只放这里，扩键先改 spec）: ' + k);
    }
  }
  if (he.fineprint != null) {
    if (!Array.isArray(he.fineprint) || !he.fineprint.length) bad('html_extra.fineprint 必须是非空数组');
    if (!String(he.scope_line || '').trim()) bad('带 fineprint 必须给 scope_line（折叠层的一行摘要）');
  }
  // 纯文本守卫作用于 html_extra 之外的全部字段
  const rest = Object.assign({}, d);
  delete rest.html_extra;
  guardPlainText(rest, 'data');
  if (Buffer.byteLength(JSON.stringify(d), 'utf8') > MAX_JSON_BYTES) bad('数据超 192KB（Ask lang_pack 上限 256KB 的产出侧余量）');
  lib.guardCommon(d); // script / 内部术语 / 破折号
}

function cnDate(iso, withYear) {
  const [y, m, day] = iso.split('-').map(Number);
  return (withYear ? y + ' 年 ' : '') + m + ' 月 ' + day + ' 日';
}

function blockVm(b) {
  return {
    btitle: b.title || null,
    is_para: b.type === 'para',
    text: b.text || '',
    is_list: b.type === 'list',
    litems: b.items || [],
    is_table: b.type === 'table',
    columns: b.columns || [],
    trows: (b.rows || []).map((r) => ({ cells: r })),
    is_kv: b.type === 'kv',
    entries: b.entries || [],
  };
}

/* 数据 -> 模板视图。题面的「不回复」行由 default_policy 生成，模型不写到期文案
   （与方向卡日期不经模型的手同一条治理线）。 */
function viewModel(d) {
  const policyLine = POLICY_LINES[d.default_policy];
  const deadlineLine = '请在 ' + cnDate(d.deadline, true) + '前回复。' + policyLine;
  const [iy, im] = d.issued.split('-').map(Number);
  const refd = new Set();
  for (const it of d.items) for (const ref of it.block_refs || []) refd.add(ref);
  const byId = new Map((d.blocks || []).map((b) => [b.id, b]));
  const cardBlocks = (d.blocks || []).filter((b) => !refd.has(b.id)).map(blockVm);
  const globalNote = d.items.find((it) => it.type === 'text');

  const vitems = d.items.filter((it) => it.type !== 'text').map((it) => {
    const labels = Object.assign({}, DEFAULT_SINGLE_LABELS);
    if (it.type === 'single' && Array.isArray(it.options)) {
      for (const o of it.options) labels[o.code] = o.label;
    }
    return {
      item_id: it.item_id,
      q: it.q,
      situation: it.situation || null,
      recommendation: it.recommendation || null,
      is_single: it.type === 'single',
      is_multi: it.type === 'multi',
      policy_line: policyLine,
      hint: it.hint || '例如：想调整哪一组、有顾虑的地方、想补充的信息，写在这里。',
      btn_agree: labels.agree,
      btn_hold: labels.hold,
      btn_other: labels.other,
      mprompt: it.prompt || '勾选适用的项，点保存：',
      moptions: it.type === 'multi' ? it.options.map((o) => ({ code: o.code, label: o.label, note: o.note || null })) : [],
      save_label: it.save_label || '保存勾选',
      iblocks: (it.block_refs || []).map((ref) => blockVm(byId.get(ref))),
    };
  });

  const he = d.html_extra || {};
  return {
    badge: d.badge || BADGES[d.card_kind] || (d.service === 'sem' ? '搜索广告 · 需要您确认' : '网站优化 · 需要您确认'),
    title: d.title,
    period_label: iy + ' 年 ' + im + ' 月出卡',
    oneline_lab: '这份确认要定的事',
    oneline: d.oneline,
    deadline_line: deadlineLine,
    has_fineprint: !!he.fineprint,
    scope_line: he.scope_line || '',
    fineprint_vm: he.fineprint || [],
    has_blocks: cardBlocks.length > 0,
    s_blocks_title: '本次确认的依据',
    s_blocks_desc: '下面是我们整理的现状与方案，是后面每一项建议的出处。',
    s_items_num: cardBlocks.length ? '2' : '1',
    s_items_title: '需要您确认',
    s_items_desc: '每一项点一下就好。同意就点同意；想改哪里，点其他反馈直接写给我们，或用右下角留言。',
    vitems,
    global_hint: (globalNote && globalNote.hint) || '想到什么写什么：内容有出入、方向不同意、想约通话，都可以。',
    attach_line: d.attach_line || '随附文件：无',
  };
}

function renderCard(data, tplPath) {
  validate(data);
  return lib.renderWithTemplate(viewModel(data), tplPath || TPL_PATH);
}

if (require.main === module) {
  const dataPath = process.argv[2];
  if (!dataPath) { console.error('用法: node render_confirmation.js <data.json> [template.html]'); process.exit(2); }
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  process.stdout.write(renderCard(data, process.argv[3]));
}

module.exports = { renderCard, validate, viewModel, TPL_PATH };
