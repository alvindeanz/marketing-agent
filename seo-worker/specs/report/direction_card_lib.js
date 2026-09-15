'use strict';
// 方向卡共用层：mustache 子集渲染引擎 + 通用守卫。
// 词卡与素材卡各自的 renderer 只写 validate 与标题默认值，版式只有一份
// direction_card_template.html，改版式一个 commit 全卡型生效。

const fs = require('fs');
const path = require('path');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// 受限富文本：全转义后只放行成对的 <b>/<i>。
function rich(s) {
  return esc(s).replace(/&lt;(\/?)(b|i)&gt;/g, '<$1$2>');
}

function lookup(ctx, key) {
  if (key === '.') return ctx;
  let v = ctx;
  for (const part of key.split('.')) {
    if (v == null) return undefined;
    v = v[part];
  }
  return v;
}

function render(tpl, ctx) {
  let out = '';
  let i = 0;
  while (i < tpl.length) {
    const open = tpl.indexOf('{{', i);
    if (open === -1) { out += tpl.slice(i); break; }
    out += tpl.slice(i, open);
    if (tpl[open + 2] === '{') {
      const close = tpl.indexOf('}}}', open);
      const key = tpl.slice(open + 3, close).trim();
      const v = lookup(ctx, key);
      if (v != null) out += rich(v);
      i = close + 3;
    } else if (tpl[open + 2] === '#') {
      const close = tpl.indexOf('}}', open);
      const key = tpl.slice(open + 3, close).trim();
      const endTag = '{{/' + key + '}}';
      const end = tpl.indexOf(endTag, close);
      if (end === -1) throw new Error('未闭合的段落: ' + key);
      const inner = tpl.slice(close + 2, end);
      const v = lookup(ctx, key);
      if (Array.isArray(v)) {
        for (const item of v) out += render(inner, item);
      } else if (v) {
        out += render(inner, typeof v === 'object' ? v : ctx);
      }
      i = end + endTag.length;
    } else {
      const close = tpl.indexOf('}}', open);
      const key = tpl.slice(open + 2, close).trim();
      const v = lookup(ctx, key);
      if (v != null) out += esc(v);
      i = close + 2;
    }
  }
  return out;
}

/* 全卡通用守卫：script、内部术语、破折号（copy_rules A1/A12 与语言铁律）。 */
function guardCommon(d) {
  const all = JSON.stringify(d);
  if (/<\s*script/i.test(all)) throw new Error('数据里不许出现 script');
  for (const bad of ['CPC', 'CTR', 'CVR', 'PMax', 'ROAS']) {
    if (all.includes(bad)) throw new Error('数据里出现内部术语: ' + bad);
  }
  if (all.includes('—')) throw new Error('数据里出现破折号');
}

/* copy_rules A31 整卡不变量：名称槽列表里一个拉丁词都没有即拒绝。 */
function guardLatin(names, what) {
  const hasLatin = (t) => /[A-Za-z]{2,}/.test(t);
  if (names.length && !names.some(hasLatin)) {
    throw new Error(what + '全为中文：产品词应用英文原词（copy_rules A31），疑似整卡被翻译');
  }
}

function guardDecisions(decisions) {
  if (decisions.length > 5) throw new Error('决策卡最多 5 张');
  for (const dec of decisions) {
    for (const k of ['q', 'situation', 'recommendation', 'no_reply', 'item', 'textarea_hint']) {
      if (!dec[k]) throw new Error('决策卡缺 ' + k + ': ' + (dec.q || '?'));
    }
    if (!/^[a-z0-9_]{1,60}$/.test(dec.item)) throw new Error('item 只许小写字母数字下划线: ' + dec.item);
  }
}

/* 数据窗口守卫与日期槽生成（2026-09-15 Alvin 定口径）：方向卡数据窗口一律是发卡月往前
   两个完整自然月（如 2026-09 发卡 = 7 月 1 日至 8 月 31 日），词卡与素材卡逐月交替各两月一张。
   period_label 与 window_line 由本函数从 window 算出，模型不写日期（2026-08-31 参数读反
   事故同源治理：日期不经模型的手）。账户投放不足两个月时 start 允许晚于规则日，
   但必须写 exception_note 说明，end 任何情况下都得是发卡月上一个自然月的最后一天。 */
function pad2(n) { return String(n).padStart(2, '0'); }
function cnDate(iso, withYear) {
  const [y, m, d] = iso.split('-').map(Number);
  return (withYear ? y + ' 年 ' : '') + m + ' 月 ' + d + ' 日';
}
function applyWindow(d) {
  if (d.period_label != null || d.window_line != null) {
    throw new Error('period_label / window_line 由渲染器从 window 生成，数据 JSON 不再提供这两个槽');
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(d.issued || ''))) throw new Error('缺 issued（发卡月，YYYY-MM）');
  const w = d.window || {};
  for (const k of ['start', 'end']) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(w[k] || ''))) throw new Error('window.' + k + ' 必须是 YYYY-MM-DD');
  }
  const [iy, im] = d.issued.split('-').map(Number);
  const sy = im <= 2 ? iy - 1 : iy;
  const sm = ((im - 3 + 12) % 12) + 1;
  const ey = im === 1 ? iy - 1 : iy;
  const em = ((im - 2 + 12) % 12) + 1;
  const ruleStart = sy + '-' + pad2(sm) + '-01';
  const ruleEnd = ey + '-' + pad2(em) + '-' + pad2(new Date(Date.UTC(ey, em, 0)).getUTCDate());
  if (w.end !== ruleEnd) {
    throw new Error('window.end 必须是发卡月上一个自然月最后一天 ' + ruleEnd + '，实际 ' + w.end);
  }
  if (w.start !== ruleStart) {
    if (!(String(w.exception_note || '').trim() && w.start > ruleStart && w.start < w.end)) {
      throw new Error('window.start 必须是 ' + ruleStart + '（发卡月前两个完整自然月）；账户投放不足两个月才许晚于此日，且必须写 exception_note');
    }
  }
  const crossYear = w.start.slice(0, 4) !== w.end.slice(0, 4);
  const range = cnDate(w.start, true) + '至 ' + cnDate(w.end, crossYear);
  d.period_label = range + (d.period_note ? '；' + String(d.period_note) : '');
  d.window_line = '数据窗口：' + range + '，取发卡前两个完整自然月。'
    + (w.exception_note ? String(w.exception_note) : '')
    + (w.note ? String(w.note) : '');
  return d;
}

const TPL_PATH = path.join(__dirname, 'direction_card_template.html');

function renderWithTemplate(data, tplPath) {
  const tpl = fs.readFileSync(tplPath || TPL_PATH, 'utf8');
  const html = render(tpl, data);
  const leftover = html.match(/{{[^}]{1,60}}}/);
  if (leftover) throw new Error('模板槽位未填: ' + leftover[0]);
  return html;
}

module.exports = { render, renderWithTemplate, guardCommon, guardLatin, guardDecisions, applyWindow, esc, rich, TPL_PATH };
