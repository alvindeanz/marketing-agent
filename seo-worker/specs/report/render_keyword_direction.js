'use strict';
// 关键词方向卡渲染器：零 LLM。模板 keyword_direction_template.html + 数据 JSON -> 客户版 HTML。
// 模板语法（mustache 子集）：
//   {{key}}      转义后插入（默认通道，模型产出的一切文本走这里）
//   {{{key}}}    受限富文本：先转义，再只放行 <b>、<i> 成对标签（段落里允许加粗）
//   {{#key}}..{{/key}}  数组循环（元素为对象则进上下文，{{.}} 取字符串元素本身）；
//                        对象或真值渲染一次；假值/空数组跳过
// 模型只产 JSON（schema 见 keyword_direction_data.schema.json），不产 HTML 不产脚本。
// CLI: node render_keyword_direction.js <data.json> [template.html] > out.html

const fs = require('fs');
const path = require('path');

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// 受限富文本：全转义后把 <b>/<i> 还原（只认成对小写裸标签）。
function rich(s) {
  return esc(s)
    .replace(/&lt;(\/?)(b|i)&gt;/g, '<$1$2>');
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
    if (tpl[open + 2] === '{') {                       // {{{raw}}}
      const close = tpl.indexOf('}}}', open);
      const key = tpl.slice(open + 3, close).trim();
      const v = lookup(ctx, key);
      if (v != null) out += rich(v);
      i = close + 3;
    } else if (tpl[open + 2] === '#') {                // {{#section}}
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
    } else {                                           // {{key}}
      const close = tpl.indexOf('}}', open);
      const key = tpl.slice(open + 2, close).trim();
      const v = lookup(ctx, key);
      if (v != null) out += esc(v);
      i = close + 2;
    }
  }
  return out;
}

// 渲染前的硬校验：槽位齐不齐在这里炸，不留空板块给客户看。
function validate(d) {
  const need = ['title', 'period_label', 'oneline', 'bignums', 'lights', 's1_desc',
    'decisions', 's2_desc', 'families', 'negatives', 'findings_title', 'findings',
    'confirm', 'glossary', 'window_line', 'attach_line'];
  const missing = need.filter((k) => d[k] == null || (Array.isArray(d[k]) && !d[k].length));
  if (missing.length) throw new Error('数据缺槽位: ' + missing.join(', '));
  if (d.bignums.length !== 3) throw new Error('bignums 必须正好 3 个');
  if (d.lights.length > 8) throw new Error('lights 最多 8 个');
  if (d.decisions.length > 5) throw new Error('决策卡最多 5 张');
  for (const dec of d.decisions) {
    for (const k of ['q', 'situation', 'recommendation', 'no_reply', 'item', 'textarea_hint']) {
      if (!dec[k]) throw new Error('决策卡缺 ' + k + ': ' + (dec.q || '?'));
    }
    if (!/^[a-z0-9_]{1,60}$/.test(dec.item)) throw new Error('item 只许小写字母数字下划线: ' + dec.item);
  }
  for (const f of d.families) {
    for (const k of ['name', 'cls', 'state_label', 'spent', 'got', 'next', 'evidence']) {
      if (!f[k]) throw new Error('词族卡缺 ' + k + ': ' + (f.name || '?'));
    }
    if (!['g', 'h', 'a'].includes(f.cls)) throw new Error('词族 cls 只许 g/h/a: ' + f.name);
  }
  for (const l of d.lights) {
    if (!['g', 'h', 'a'].includes(l.cls)) throw new Error('红绿灯 cls 只许 g/h/a: ' + l.name);
  }
  const all = JSON.stringify(d);
  if (/<\s*script/i.test(all)) throw new Error('数据里不许出现 script');
  for (const bad of ['CPC', 'CTR', 'CVR', 'PMax', 'ROAS']) {
    if (all.includes(bad)) throw new Error('数据里出现内部术语: ' + bad);
  }
  if (all.includes('—')) throw new Error('数据里出现破折号');
}

function renderCard(data, tplPath) {
  const tpl = fs.readFileSync(tplPath || path.join(__dirname, 'keyword_direction_template.html'), 'utf8');
  validate(data);
  return render(tpl, data);
}

if (require.main === module) {
  const dataPath = process.argv[2];
  if (!dataPath) { console.error('用法: node render_keyword_direction.js <data.json> [template.html]'); process.exit(2); }
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  process.stdout.write(renderCard(data, process.argv[3]));
}

module.exports = { renderCard, render, validate };
