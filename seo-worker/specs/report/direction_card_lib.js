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

const TPL_PATH = path.join(__dirname, 'direction_card_template.html');

function renderWithTemplate(data, tplPath) {
  const tpl = fs.readFileSync(tplPath || TPL_PATH, 'utf8');
  const html = render(tpl, data);
  const leftover = html.match(/{{[^}]{1,60}}}/);
  if (leftover) throw new Error('模板槽位未填: ' + leftover[0]);
  return html;
}

module.exports = { render, renderWithTemplate, guardCommon, guardLatin, guardDecisions, esc, rich, TPL_PATH };
