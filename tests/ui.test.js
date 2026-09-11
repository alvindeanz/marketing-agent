#!/usr/bin/env node
/* 看板内联 JS 的渲染冒烟测试。
   跑法：node tests/ui.test.js
   把 static/seo-agent.html 的 <script> 装进一个最小 DOM 桩里，灌一份真实任务数据
   （tests/fixtures/tasks_louvresky.json，2026-08-26 快照），跑一遍任务视图的渲染函数。
   抓的是「函数被切掉 / 变量未定义 / 渲染中途抛异常」这类让整页空白的错，
   不检查像素。不碰网络。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n       ')); }
}

const html = fs.readFileSync(path.join(__dirname, '..', 'static', 'seo-agent.html'), 'utf8');
const scripts = [];
html.replace(/<script>([\s\S]*?)<\/script>/g, (m, s) => { scripts.push(s); return m; });
assert.ok(scripts.length >= 1, 'no inline script found');
let src = scripts.join('\n').replace(/\nboot\(\);\s*$/, '\n');

const els = {};
function el(id) {
  if (!els[id]) els[id] = {
    id, style: {}, innerHTML: '', textContent: '', className: '', disabled: false, value: '', files: [],
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; }, focus() {}, click() {},
  };
  return els[id];
}
const document = {
  getElementById: el, visibilityState: 'visible', activeElement: null, body: el('body'),
  addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return null; },
  createElement() { return el('tmp' + Math.random()); },
};
const window = { innerWidth: 1600, location: { hash: '', href: '' }, addEventListener() {}, localStorage: { getItem() { return null; }, setItem() {} } };
const ctx = {
  document, window, localStorage: window.localStorage, console,
  setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; }, clearTimeout() {},
  fetch() { return new Promise(() => {}); }, prompt() { return ''; }, confirm() { return true; }, alert() {},
  location: window.location, history: { replaceState() {}, pushState() {} },
  Date, JSON, Math, Number, String, Object, Array, parseInt, parseFloat, isNaN, isFinite,
  encodeURIComponent, decodeURIComponent, Promise, Infinity, NaN, URL, Blob: function () {}, FormData: function () {},
};
ctx.window = Object.assign(window, ctx);
ctx.self = ctx;
vm.createContext(ctx);

console.log('inline script');
t('loads without throwing', () => { vm.runInContext(src, ctx, { filename: 'seo-agent.inline.js' }); });

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'tasks_louvresky.json'), 'utf8'));
vm.runInContext('tasksData=' + JSON.stringify(fixture.tasks) + ';curId=16;curView="tasks";token="x";sprintScope="all";', ctx);

console.log('task view');
t('renderLanes renders every task into the owner lanes with a state line', () => {
  vm.runInContext('renderLanes()', ctx);
  const out = el('lanes').innerHTML;
  assert.ok(out.length > 1000, 'lanes html too short');
  ['Agent 机器'].forEach((n) => assert.ok(out.indexOf(n) > -1, 'lane ' + n + ' missing'));
  assert.ok(out.indexOf('等我') > -1, 'state line missing');
  fixture.tasks.filter((x) => x.human_state !== 'closed').forEach((x) => {
    assert.ok(out.indexOf('#' + x.id + '</span>') > -1, 'task #' + x.id + ' missing from lanes');
  });
});
t('closed column shows when 显示已结束 is on', () => {
  vm.runInContext('showDone=true;renderLanes();showDone=false', ctx);
  const out = el('lanes').innerHTML;
  fixture.tasks.filter((x) => x.human_state === 'closed').forEach((x) => {
    assert.ok(out.indexOf('#' + x.id + '</span>') > -1, 'closed task #' + x.id + ' missing');
  });
});
t('a card with an open items panel renders the item ledger (W15; task threads retired by W16)', () => {
  const id = fixture.tasks[0].id;
  vm.runInContext('itOpen[' + id + ']=true;itData[' + id + ']={items:[{seq:0,op:"final-url-change",entity:"ad 811766076864",state:"landed",owner:"machine",evidence:"回读一致"},{seq:1,op:"keyword-add",entity:"14 行加词",state:"blocked",owner:"agency",block_reason:"缺执行器 op keyword-add"}]};renderLanes();itOpen[' + id + ']=false', ctx);
  const html = el('lanes').innerHTML;
  assert.ok(html.indexOf('已落地') > -1, '缺已落地条目');
  assert.ok(html.indexOf('落不了') > -1, '缺 blocked 条目');
  assert.ok(html.indexOf('缺执行器 op keyword-add') > -1, '缺 block_reason');
  assert.ok(html.indexOf('>线程<') === -1, '任务卡不该再有线程按钮');
});
t('queue strip and pick hint render', () => {
  vm.runInContext('qsQueue={running:[{id:1,client_name:"L",type:"execute_task",task_id:' + fixture.tasks[0].id + ',elapsed_sec:70}],queued:[{id:2,lane:"light"}]};renderQueueStrip();renderPickHint()', ctx);
  assert.ok(el('queueStrip').textContent.indexOf('运行中 L · 任务 #' + fixture.tasks[0].id) > -1, '队列条编号用任务号');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
