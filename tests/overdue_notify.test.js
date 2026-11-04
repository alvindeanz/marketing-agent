#!/usr/bin/env node
/* 等人件逾期通知判定单测（2026-11-04 Alvin 定）。零网络零模型。跑法：node tests/overdue_notify.test.js */
'use strict';
const assert = require('assert');
const path = require('path');
const O = require(path.join(__dirname, '..', 'seo-worker', 'lib', 'overdue_notify'));
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }

const NOW = Date.parse('2026-11-04T00:00:00Z');
const d = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString().slice(0, 19).replace('T', ' ');

console.log('判定');
t('人工任务停满 3 天才首发，不足不发', () => {
  const tasks = [
    { id: 1, title: 'A', module: 'onpage', updated_at: d(4), result_note: '[确认等人 2026-10-30] 预览: https://x/a' },
    { id: 2, title: 'B', module: 'onpage', updated_at: d(1), result_note: '[确认等人 2026-11-03]' },
  ];
  const blockers = [
    { id: 1, kind: '人工任务', text: 'owner=agency' },
    { id: 2, kind: '人工任务', text: 'owner=agency' },
  ];
  const r = O.decideNotify(tasks, blockers, NOW);
  assert.deepStrictEqual(r.seo.map((x) => x.id), [1]);
  assert.strictEqual(r.sem.length, 0);
  assert.strictEqual(r.seo[0].url, 'https://x/a');
});
t('paid 归 sem，其余归 seo', () => {
  const tasks = [
    { id: 3, title: 'P', module: 'paid', updated_at: d(5), result_note: '[确认等人 2026-10-28]' },
    { id: 4, title: 'C', module: 'content', updated_at: d(5), result_note: '[确认等人 2026-10-28]' },
  ];
  const blockers = [
    { id: 3, kind: '人工任务', text: '' },
    { id: 4, kind: '待人工验证', text: '复验' },
  ];
  const r = O.decideNotify(tasks, blockers, NOW);
  assert.deepStrictEqual(r.sem.map((x) => x.id), [3]);
  assert.deepStrictEqual(r.seo.map((x) => x.id), [4]);
});
t('机器类阻塞（待判/判决过期/执行失败）不发人', () => {
  const tasks = [{ id: 5, title: 'M', module: 'onpage', updated_at: d(10), result_note: '[确认等人 2026-10-20]' }];
  const r = O.decideNotify(tasks, [
    { id: 5, kind: '待判', text: '' },
    { id: 5, kind: '判决过期', text: '' },
    { id: 5, kind: '执行失败', text: '' },
  ], NOW);
  assert.strictEqual(r.seo.length + r.sem.length, 0);
});
t('有 [逾期通知] 戳后按戳算：7 天内不重发，满 7 天重发', () => {
  const recent = { id: 6, title: 'R', module: 'onpage', updated_at: d(30), result_note: '[确认等人 2026-10-20]\n[逾期通知 2026-11-01 → seo] 已邮件通知' };
  const old = { id: 7, title: 'O', module: 'onpage', updated_at: d(30), result_note: '[确认等人 2026-10-10]\n[逾期通知 2026-10-20 → seo] 已邮件通知' };
  const blockers = [
    { id: 6, kind: '人工任务', text: '' },
    { id: 7, kind: '人工任务', text: '' },
  ];
  const r = O.decideNotify([recent, old], blockers, NOW);
  assert.deepStrictEqual(r.seo.map((x) => x.id), [7]);
});
t('同任务多条阻塞只报一次', () => {
  const tasks = [{ id: 8, title: 'D', module: 'content', updated_at: d(5), result_note: '[确认等人 2026-10-28]' }];
  const r = O.decideNotify(tasks, [
    { id: 8, kind: '人工任务', text: '' },
    { id: 8, kind: '待人工配图', text: '配图 0/4' },
  ], NOW);
  assert.strictEqual(r.seo.length, 1);
});

t('确认闸：没盖 [确认等人] 的停多久都不追，盖了撤销戳的也不追', () => {
  const tasks = [
    { id: 10, title: 'N', module: 'onpage', updated_at: d(30), result_note: '' },
    { id: 11, title: 'V', module: 'onpage', updated_at: d(30), result_note: '[确认等人 2026-10-01]\n[确认等人撤销 2026-10-15]' },
  ];
  const blockers = [
    { id: 10, kind: '人工任务', text: '' },
    { id: 11, kind: '人工任务', text: '' },
  ];
  const r = O.decideNotify(tasks, blockers, NOW);
  assert.strictEqual(r.seo.length + r.sem.length, 0);
});

t('交办戳即确认：按戳里的人分流，summer 归 seo，monica 归 sem，客户按 module', () => {
  const tasks = [
    { id: 20, title: 'H1', module: 'paid', updated_at: d(4), result_note: '[交办 2026-10-30 → summer] 包已发' },
    { id: 21, title: 'H2', module: 'content', updated_at: d(4), result_note: '[交办 2026-10-30 → monica] 包已发' },
    { id: 22, title: 'H3', module: 'paid', updated_at: d(4), result_note: '[交办 2026-10-30 → 客户] 等客户贴' },
    { id: 23, title: 'H4', module: 'content', updated_at: d(4), result_note: '[交办 2026-10-01 → summer]\n[交办撤销 2026-10-20]' },
  ];
  const blockers = tasks.map((t2) => ({ id: t2.id, kind: '交办中', text: '' }));
  const r = O.decideNotify(tasks, blockers, NOW);
  assert.deepStrictEqual(r.seo.map((x) => x.id).sort(), [20]);
  assert.deepStrictEqual(r.sem.map((x) => x.id).sort(), [21, 22]);
});
t('lastHandover 取最后一枚，撤销后为 null', () => {
  assert.deepStrictEqual(O.lastHandover('[交办 2026-10-01 → monica] x [交办 2026-10-05 → summer] y'), { date: '2026-10-05', who: 'summer' });
  assert.strictEqual(O.lastHandover('[交办 2026-10-01 → summer]\n[交办撤销 2026-10-02]'), null);
  assert.strictEqual(O.lastHandover('没有戳'), null);
});

console.log('邮件装配');
t('主题带客户名与数量，正文转义且含链接与天数', () => {
  const mail = O.buildEmail('Louvresky', 'seo', [
    { id: 9, title: 'A <b>', kind: '人工任务', text: 'owner=agency', days: 4, url: 'https://x/p?t=1&k=2' },
  ], '2026-11-04');
  assert.ok(mail.subject.indexOf('Louvresky') > -1 && mail.subject.indexOf('1 项') > -1, mail.subject);
  assert.ok(mail.html.indexOf('&lt;b&gt;') > -1, '标题要转义');
  assert.ok(mail.html.indexOf('已等 4 天') > -1);
  assert.ok(mail.html.indexOf('https://x/p?t=1&amp;k=2') > -1);
  assert.ok(!/[—–]/.test(mail.html) && !/\p{Extended_Pictographic}/u.test(mail.html), '零破折号零 emoji');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
