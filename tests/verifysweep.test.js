#!/usr/bin/env node
/* 复验扫帚判定核单测。零网络零模型。跑法：node tests/verifysweep.test.js */
'use strict';
const assert = require('assert');
const path = require('path');
const V = require(path.join(__dirname, '..', 'seo-worker', 'lib', 'verifysweep'));
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); } }

console.log('解析');
t('pendingItems 取最后一条检查行；0 项回空；未命名按数量补位', () => {
  const note = [
    '检查: 通过 3 项，待复验 2 项（V1 旧项、V2 旧项）',
    '中间别的话',
    '检查: 通过 5 项，未通过 2 项（V4 x、V8 y），待复验 1 项（V6 配件总页人工完成后核对）',
  ].join('\n');
  assert.deepStrictEqual(V.pendingItems(note), ['V6 配件总页人工完成后核对']);
  assert.deepStrictEqual(V.pendingItems('检查: 通过 9 项，待复验 0 项'), []);
  assert.deepStrictEqual(V.pendingItems('检查: 通过 1 项，待人工 2 项'), ['（未命名检查项）', '（未命名检查项）']);
  assert.deepStrictEqual(V.pendingItems('没有检查行'), []);
});

t('changesetFileCounts 收全史不只最后一轮', () => {
  const note = 'changeset: cs_a（15 文件: pages/index.html 等）\n…\nchangeset: cs_b（0 文件）\nchangeset: cs_c（0 文件）';
  assert.deepStrictEqual(V.changesetFileCounts(note), [15, 0, 0]);
  assert.deepStrictEqual(V.changesetFileCounts('无'), []);
});

console.log('判定');
const mk = (lines) => lines.join('\n');
t('#114 形状：三轮 changeset 全 0、账本空 → void', () => {
  const note = mk([
    'changeset: cs_1（0 文件）', '检查: 通过 0 项，未通过 11 项（V1 x），待复验 1 项（V12 第 21 天与第 28 天复核）',
    'changeset: cs_2（0 文件）', 'changeset: cs_3（0 文件）',
    '检查: 通过 0 项，未通过 12 项（V1 y），待复验 1 项（V13 第 21 天与第 28 天复核）',
  ]);
  const d = V.decide({ note, ledgerStates: [], status: 'review' });
  assert.strictEqual(d.action, 'void');
  assert.ok(/全史零落地/.test(d.reason));
});

t('#311 形状：首轮 15 文件落了地 → 不 void，升人（V6 等人工完成后核对）', () => {
  const note = mk([
    'changeset: cs_a（15 文件: pages/index.html 等）',
    '检查: 通过 5 项，未通过 2 项（V4 x、V8 y），待复验 1 项（V6 配件总页人工完成后核对）',
    'changeset: cs_b（0 文件）',
    '检查: 通过 5 项，未通过 2 项（V4 x、V8 y），待复验 1 项（V6 配件总页人工完成后核对）',
  ]);
  const d = V.decide({ note, ledgerStates: ['authorized', 'authorized'], status: 'review' });
  assert.strictEqual(d.action, 'report');
});

t('账本有 landed 行即使 changeset 行全 0 也不 void', () => {
  const note = 'changeset: cs_x（0 文件）\n检查: 通过 1 项，待复验 1 项（V9 第 28 天复核）';
  const d = V.decide({ note, ledgerStates: ['landed'], status: 'review' });
  assert.notStrictEqual(d.action, 'void');
});

t('note 里没有 changeset 行就缺一条腿，不 void（账本空也不行）', () => {
  const note = '检查: 通过 1 项，待复验 1 项（V9 第 28 天复核）';
  const d = V.decide({ note, ledgerStates: [], status: 'review' });
  assert.strictEqual(d.action, 'report');
});

t('全数据口径 + done + [applied] → backtest；缺任一条件回 report', () => {
  const note = 'changeset: cs_a（3 文件: x）\n[applied]\n检查: 通过 8 项，待复验 2 项（V9 第 21 天位次复核、V10 CTR 复测）';
  assert.strictEqual(V.decide({ note, ledgerStates: ['landed'], status: 'done' }).action, 'backtest');
  assert.strictEqual(V.decide({ note, ledgerStates: ['landed'], status: 'review' }).action, 'report');
  const noApplied = note.replace('[applied]\n', '');
  assert.strictEqual(V.decide({ note: noApplied, ledgerStates: ['landed'], status: 'done' }).action, 'report');
  const mixed = note.replace('V10 CTR 复测', 'V10 Rich Results 人工跑');
  assert.strictEqual(V.decide({ note: mixed, ledgerStates: ['landed'], status: 'done' }).action, 'report');
});

t('无待复验项 → none', () => {
  assert.strictEqual(V.decide({ note: '检查: 通过 9 项，待复验 0 项', ledgerStates: [], status: 'done' }).action, 'none');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
