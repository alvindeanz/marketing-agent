#!/usr/bin/env node
/* asks API 的折叠口径与 cardfold 一致性（node 侧）。同一夹具 tests/fixtures/asks_feedback_rows.json
   由 php 侧 tests/asksapi.test.php 用 asks_fold_effective 折叠，两边都对 expected 断言，
   即 seo-api 的 effective_answer 投影与 harness 放行认的 cardfold 同口径（Phase 1 入账序）。
   跑法：node tests/asksfold.test.js */
const assert = require('assert');
const fx = require('./fixtures/asks_feedback_rows.json');
const { foldCardFeedback } = require('../seo-worker/lib/cardfold');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

const f = foldCardFeedback(fx.rows);
/* 已知差异：自定义选项码 php 侧算表态、cardfold 不折（见夹具 _doc），这些 item 从期望里剔除。 */
const ignores = new Set(fx.cardfold_ignores || []);

t('表态折叠：每项取入账序最后一次，other 不覆盖', () => {
  const got = {};
  for (const v of [...f.agreed, ...f.holds]) got[v.item] = { choice: v.choice, fb: v.fb };
  const want = {};
  for (const [k, v] of Object.entries(fx.expected.stance)) if (!ignores.has(k)) want[k] = { choice: v.choice, fb: v.fb };
  assert.deepStrictEqual(got, want);
});

t('已知差异仍在：cardfold 不折自定义码 item（差异收口时删夹具 cardfold_ignores）', () => {
  const items = new Set([...f.agreed, ...f.holds].map((v) => v.item));
  for (const k of ignores) assert.ok(!items.has(k), k + ' 被 cardfold 折了，差异已收口，删夹具 cardfold_ignores');
});

t('旁注：非空 other 全部保留按序，空白 other 丢弃', () => {
  const got = {};
  for (const x of f.texts) (got[x.item] = got[x.item] || []).push(x.text);
  assert.deepStrictEqual(got, fx.expected.notes);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
