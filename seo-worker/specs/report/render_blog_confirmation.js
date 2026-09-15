'use strict';
// 博客确认卡渲染器：零 LLM。数据 JSON（blog_confirmation_data.schema.json）->
// blog_confirmation_template.html -> 客户版 HTML。引擎与守卫复用 direction_card_lib.js。
// CLI: node render_blog_confirmation.js <data.json> [template.html] > out.html
//
// 语义：这是老客户 sprint 内博客发布前的唯一客户确认闸（Alvin 2026-09-15）。
// 卡内含 draft 预览链接、关键词规划（快赢导向）、内链规划、配图；客户点「同意，安排发布」
// 即 agree，harness 下一轮折叠时排发布任务。方向层的关键词/mapping 老客户已内部静默确认。

const fs = require('fs');
const path = require('path');
const lib = require('./direction_card_lib.js');

const TITLES = {
  badge: '内容 · 待您确认发布',
  s_kw_title: '这篇文章针对的搜索',
  s_kw_desc: '写这篇是为了接住下面这些搜索，把还没覆盖到的意向流量拿回来。',
  s_link_title: '内链怎么连',
  s_link_desc: '这篇和站内其他页面的连接，帮搜索引擎理解页面关系，也把读者引到成交页。',
  s_img_title: '配图',
  s_dec_title: '需要您确认',
  s_dec_desc: '看过上面的预览后点一下就好，同意我们就安排发布；想改哪里直接写给我们。',
};

const TPL_PATH = path.join(__dirname, 'blog_confirmation_template.html');

function validate(d) {
  const need = ['title', 'period_label', 'oneline', 'draft_url', 'draft_hint',
    'keywords', 'images_line', 'decision', 'window_line', 'attach_line'];
  const missing = need.filter((k) => d[k] == null || (Array.isArray(d[k]) && !d[k].length));
  if (missing.length) throw new Error('数据缺槽位: ' + missing.join(', '));
  if (!/^https?:\/\//.test(String(d.draft_url))) throw new Error('draft_url 必须是完整 http(s) 链接');
  for (const kw of d.keywords) {
    for (const k of ['term', 'intent']) {
      if (!kw[k]) throw new Error('关键词规划缺 ' + k + ': ' + (kw.term || '?'));
    }
  }
  const dec = d.decision;
  if (!dec || typeof dec !== 'object') throw new Error('缺 decision 对象');
  for (const k of ['q', 'situation', 'recommendation', 'no_reply', 'item', 'textarea_hint']) {
    if (!dec[k]) throw new Error('决策卡缺 ' + k);
  }
  // foldCards 靠这个 item 认出「同意发布」；写错就折叠不成发布，硬校验。
  if (dec.item !== 'publish_blog') throw new Error('博客确认卡 decision.item 必须是 publish_blog');
  // copy_rules A31：关键词名不能整列被翻译成中文（产品/搜索词用英文原词）。
  lib.guardLatin(d.keywords.map((k) => k.term), '关键词');
  // script / 内部术语 / 破折号（复用方向卡通用守卫）。
  lib.guardCommon(d);
}

function renderCard(data, tplPath) {
  validate(data);
  return lib.renderWithTemplate(Object.assign({}, TITLES, data), tplPath || TPL_PATH);
}

if (require.main === module) {
  const dataPath = process.argv[2];
  if (!dataPath) { console.error('用法: node render_blog_confirmation.js <data.json> [template.html]'); process.exit(2); }
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  process.stdout.write(renderCard(data, process.argv[3]));
}

module.exports = { renderCard, validate, TITLES, TPL_PATH };
