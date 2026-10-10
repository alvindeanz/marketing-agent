'use strict';
// 落地页确认卡渲染器：零 LLM。结构类改动（page-create / 301 / 删并页 / 导航）在 apply
// 硬闸前把方案翻译成客户语言出卡，客户点「同意，按方案调整」落 onsite_confirm=agree，
// 闸读到凭证即放行落地（apply_task.js STRUCTURAL_CONFIRM_OPS 硬闸，Alvin 2026-09-17 定；
// 卡产线 2026-10-10 补齐，此前闸的报错让人「出卡」但没有任何工具出卡）。
// 数据形状与博客确认卡同构（keywords 槽位装「改动清单」，term=动作，intent=客户话说明），
// 模板引擎、反馈通路、token 注入全部复用。
// CLI: node render_onsite_confirm.js <data.json> [template.html] > out.html

const fs = require('fs');
const path = require('path');
const lib = require('./direction_card_lib.js');

const TITLES = {
  badge: '站点调整 · 待您确认',
  s_kw_title: '这次要做的调整',
  s_kw_desc: '下面是这次会在您站上做的每一项动作，每项都写了做它的原因。',
  s_link_title: '与现有页面的关系',
  s_link_desc: '新页面或调整后的页面与站内其他页面怎么连接，不会影响现有页面的内容。',
  s_img_title: '我们不会动的',
  s_dec_title: '需要您确认',
  s_dec_desc: '看过上面的清单后点一下就好，同意我们就按方案执行；有顾虑直接写给我们。',
};

const TPL_PATH = path.join(__dirname, 'onsite_confirm_template.html');

function validate(d) {
  const need = ['title', 'period_label', 'oneline', 'draft_hint',
    'keywords', 'images_line', 'decision', 'window_line', 'attach_line'];
  const missing = need.filter((k) => d[k] == null || (Array.isArray(d[k]) && !d[k].length));
  if (missing.length) throw new Error('数据缺槽位: ' + missing.join(', '));
  // 预览可选：新建页在客户同意前不存在，没有可看的东西就不放按钮。
  if (d.draft_url && !/^https?:\/\//.test(String(d.draft_url))) throw new Error('draft_url 必须是完整 http(s) 链接');
  for (const kw of d.keywords) {
    for (const k of ['term', 'intent']) {
      if (!kw[k]) throw new Error('改动清单缺 ' + k + ': ' + (kw.term || '?'));
    }
  }
  const dec = d.decision;
  if (!dec || typeof dec !== 'object') throw new Error('缺 decision 对象');
  for (const k of ['q', 'situation', 'recommendation', 'no_reply', 'item', 'textarea_hint']) {
    if (!dec[k]) throw new Error('决策卡缺 ' + k);
  }
  // apply 的结构硬闸只认 onsite_confirm 的 agree；写错 item 闸永远读不到凭证，硬校验。
  if (dec.item !== 'onsite_confirm') throw new Error('落地页确认卡 decision.item 必须是 onsite_confirm');
  // script / 内部术语 / 破折号（复用方向卡通用守卫）。改动清单的 term 多为 slug 或
  // 英文页面名，不做 guardLatin 反向断言。
  lib.guardCommon(d);
}

function renderCard(data, tplPath) {
  validate(data);
  return lib.renderWithTemplate(Object.assign({}, TITLES, data), tplPath || TPL_PATH);
}

if (require.main === module) {
  const dataPath = process.argv[2];
  if (!dataPath) { console.error('用法: node render_onsite_confirm.js <data.json> [template.html]'); process.exit(2); }
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  process.stdout.write(renderCard(data, process.argv[3]));
}

module.exports = { renderCard, validate, TITLES, TPL_PATH };
