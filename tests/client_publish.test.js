'use strict';
/* 客户版发布清单（2026-11-11 ticket #60）。回放 Midea #1992 的真实回复：agent 改了
   reports/ 下的正式报告，回复只写「已覆盖原文件」没点文件名，旧判据静默不发布。
   判据必须是文件变没变，不是回复里有没有文件名。零网络，临时目录。 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { htmlMtimes, clientFilesToPublish } = require('../seo-worker/runners/execute_task');

const REPLY_1992 =
  '我已改完黑五 PMax 审核页并覆盖原文件，客户链接不变。按前台显示口径，134 个商品里 **128 个可投放**，' +
  '这 128 个就是建议进黑五 asset group 的数量；另外 6 个网站有货但不在商品源里，暂时进不了广告。\n' +
  'OPS_CHECK: capability-gap 页面写的是待执行的广告账户改动';
const REPORT = 'blackfriday_pmax_promo_review_2026-11.html';

let pass = 0;
function t(name, fn) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cpub-'));
  fs.mkdirSync(path.join(ws, 'reports'));
  fs.mkdirSync(path.join(ws, 'seo-agent-output'));
  try { fn(ws); pass++; console.log('  ok   ' + name); }
  finally { fs.rmSync(ws, { recursive: true, force: true }); }
}
function put(ws, dir, f, ageMs) {
  const p = path.join(ws, dir, f);
  fs.writeFileSync(p, '<html>' + f + '</html>');
  const when = new Date(Date.now() - (ageMs || 0));
  fs.utimesSync(p, when, when);
}
const names = (list) => list.map((x) => x.f).sort();

t('#1992 回放：改了正式报告但回复没点文件名，必须发布', (ws) => {
  put(ws, 'reports', REPORT, 3600e3);
  const before = htmlMtimes(path.join(ws, 'reports'));
  put(ws, 'reports', REPORT, 0);
  assert.deepStrictEqual(names(clientFilesToPublish(ws, REPLY_1992, '', before)), [REPORT]);
});

t('没改过也没点名的旧报告不发', (ws) => {
  put(ws, 'reports', REPORT, 3600e3);
  put(ws, 'reports', 'seo_monthly_2026-10.html', 3600e3);
  const before = htmlMtimes(path.join(ws, 'reports'));
  put(ws, 'reports', REPORT, 0);
  assert.deepStrictEqual(names(clientFilesToPublish(ws, REPLY_1992, '', before)), [REPORT]);
});

t('本任务新建的报告没点名也发', (ws) => {
  const before = htmlMtimes(path.join(ws, 'reports'));
  put(ws, 'reports', 'haakaa_collection_intro_4pages_confirm_2026-11.html', 0);
  assert.strictEqual(clientFilesToPublish(ws, '确认卡已做好。', '', before).length, 1);
});

t('*.pending.html 待放行草稿改了也不自动发，点名才发', (ws) => {
  const before = htmlMtimes(path.join(ws, 'reports'));
  put(ws, 'reports', 'report_template_seo.pending.html', 0);
  assert.deepStrictEqual(clientFilesToPublish(ws, '模板已蒸馏。', '', before), []);
  assert.strictEqual(clientFilesToPublish(ws, '见 report_template_seo.pending.html', '', before).length, 1);
});

t('seo-agent-output 只认点名：runner 落的内部审阅壳不会被当客户版发', (ws) => {
  const before = htmlMtimes(path.join(ws, 'reports'));
  put(ws, 'seo-agent-output', 'preview-task-1992.html', 0);
  put(ws, 'seo-agent-output', 'keyword_card.html', 0);
  assert.deepStrictEqual(names(clientFilesToPublish(ws, '卡在 keyword_card.html', '', before)), ['keyword_card.html']);
});

t('旧点名规则保留：点了名且 6 小时内改过的照发，超 6 小时不发；产线确认卡点名放行', (ws) => {
  put(ws, 'reports', 'a.html', 3600e3);
  put(ws, 'reports', 'old.html', 7 * 3600e3);
  put(ws, 'reports', 'card.html', 60e3);
  const before = htmlMtimes(path.join(ws, 'reports'));
  assert.deepStrictEqual(names(clientFilesToPublish(ws, '见 a.html 与 old.html', 'card.html', before)), ['a.html', 'card.html']);
});

t('reports 目录不存在不抛错', (ws) => {
  fs.rmSync(path.join(ws, 'reports'), { recursive: true });
  assert.deepStrictEqual(htmlMtimes(path.join(ws, 'reports')), {});
  assert.deepStrictEqual(clientFilesToPublish(ws, 'x', '', {}), []);
});

console.log('\n' + pass + ' passed');
