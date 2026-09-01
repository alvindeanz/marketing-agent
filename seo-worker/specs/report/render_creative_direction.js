'use strict';
// 素材方向卡渲染器：零 LLM。数据 JSON（creative_direction_data.schema.json）->
// direction_card_template.html -> 客户版 HTML。与词卡共用模板与引擎（direction_card_lib.js），
// 槽位键名同构：families 槽在本卡承载「每条广告一张小卡」，negatives 槽承载「素材清理」段落。
// CLI: node render_creative_direction.js <data.json> [template.html] > out.html

const fs = require('fs');
const lib = require('./direction_card_lib.js');

const TITLES = {
  badge: '搜索广告 · 素材方向',
  s1_title: '需要您决定',
  s2_title: '每条广告的成绩单',
  s3_title: '本期清理哪些没在干活的素材',
  s5_title: '上期确认记录',
  s6_title: '名词解释',
  s3_item: 'creative_cleanup_plan',
  s3_hint: '例如：哪些素材想保留、清理节奏想放缓。留空提交等于保持不变。',
};

function validate(d) {
  const need = ['title', 'period_label', 'oneline', 'bignums', 'scope_line', 's1_desc',
    'decisions', 's2_desc', 'families', 'negatives',
    'confirm', 'glossary', 'window_line', 'attach_line'];
  const missing = need.filter((k) => d[k] == null || (Array.isArray(d[k]) && !d[k].length));
  if (missing.length) throw new Error('数据缺槽位: ' + missing.join(', '));
  if (d.bignums.length !== 3) throw new Error('bignums 必须正好 3 个');
  lib.guardDecisions(d.decisions);
  for (const f of d.families) {
    for (const k of ['name', 'cls', 'state_label', 'brief', 'spent', 'got', 'next', 'evidence']) {
      if (!f[k]) throw new Error('广告卡缺 ' + k + ': ' + (f.name || '?'));
    }
    if (!['g', 'h', 'a'].includes(f.cls)) throw new Error('广告卡 cls 只许 g/h/a: ' + f.name);
  }
  lib.guardLatin(d.families.map((f) => f.name), '广告卡名');
  // 立场 2：Ad Strength 是内部检查项，不进客户报告（PAID spec 五立场之一）。
  const all = JSON.stringify(d);
  for (const bad of ['Ad Strength', 'ad strength', '广告强度', '广告评级']) {
    if (all.includes(bad)) throw new Error('Ad Strength 类评级不进客户报告（立场 2）: ' + bad);
  }
  // 立场 1：素材级比率是方向信号，禁止写成素材级单条询价成本。
  if (/素材级?[^。]{0,12}(单条询价|每条询价)/.test(all)) {
    throw new Error('素材级不许算单条询价成本（共同归因，立场 1）');
  }
  lib.guardCommon(d);
}

function renderCard(data, tplPath) {
  validate(data);
  return lib.renderWithTemplate(Object.assign({}, TITLES, data), tplPath);
}

if (require.main === module) {
  const dataPath = process.argv[2];
  if (!dataPath) { console.error('用法: node render_creative_direction.js <data.json> [template.html]'); process.exit(2); }
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  process.stdout.write(renderCard(data, process.argv[3]));
}

module.exports = { renderCard, validate };
