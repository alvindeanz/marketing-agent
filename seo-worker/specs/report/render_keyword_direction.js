'use strict';
// 关键词方向卡渲染器：零 LLM。数据 JSON（keyword_direction_data.schema.json）->
// direction_card_template.html -> 客户版 HTML。引擎与守卫在 direction_card_lib.js。
// CLI: node render_keyword_direction.js <data.json> [template.html] > out.html

const fs = require('fs');
const lib = require('./direction_card_lib.js');

const TITLES = {
  badge: '搜索广告 · 关键词方向',
  s1_title: '需要您决定',
  s2_title: '每一族搜索的成绩单',
  s3_title: '本期词表手术：挡、移、加',
  s5_title: '上期确认记录',
  s6_title: '名词解释',
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
      if (!f[k]) throw new Error('词族卡缺 ' + k + ': ' + (f.name || '?'));
    }
    if (!['g', 'h', 'a'].includes(f.cls)) throw new Error('词族 cls 只许 g/h/a: ' + f.name);
  }
  // copy_rules A31 整卡不变量（错误文案保持含 copy_rules A31 供测试与排障定位）
  lib.guardLatin(d.families.map((f) => f.name), '词族名');
  lib.guardCommon(d);
}

function renderCard(data, tplPath) {
  validate(data);
  return lib.renderWithTemplate(Object.assign({}, TITLES, data), tplPath);
}

if (require.main === module) {
  const dataPath = process.argv[2];
  if (!dataPath) { console.error('用法: node render_keyword_direction.js <data.json> [template.html]'); process.exit(2); }
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  process.stdout.write(renderCard(data, process.argv[3]));
}

module.exports = { renderCard, validate };
