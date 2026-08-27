#!/usr/bin/env node
/* 博客机器校验的结构计数。跑法：node tests/blogcheck.test.js。零网络零模型。 */
const assert = require('assert');
const path = require('path');
const C = require(path.join(__dirname, '..', 'seo-worker', 'lib', 'blogcheck'));
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }
console.log('structure');
t('管道表与 HTML 表都算表格', () => {
  const body = '## Cost\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<table><thead><tr><th>x</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>\n\n<TABLE><tr><td>y</td></tr></TABLE>\n';
  const st = C.structure(body);
  assert.strictEqual(st.pipeTables, 1);
  assert.strictEqual(st.htmlTables, 2);
  assert.strictEqual(st.tables, 3);
});
t('没有表格计 0', () => {
  assert.strictEqual(C.structure('## A\n\ntext\n\n- a\n- b\n').tables, 0);
});
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
