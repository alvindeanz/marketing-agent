#!/usr/bin/env node
/* 双写手时间戳守卫：feedback 不覆盖晚于自己入队时间的 fact。跑法：node tests/factguard.test.js
   防的是批五事故链：chat 按「冲突即凭证」当轮改档后，慢一拍的 feedback 把同一条消息
   解析出的旧口径写回去，新授权被静默回滚。 */
const assert = require('assert');
const { filterStaleFacts } = require('../seo-worker/runners/feedback');

let fail = 0;
function t(name, fn) {
  try {
    fn();
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + e.message);
  }
}

const F = (k) => ({ fact_key: k, value: 'v' });

t('库内版本晚于反馈入队时间的 key 被跳过，其余照写', () => {
  const existing = [
    { fact_key: 'paid.geo_alignment_approved', updated_at: '2026-10-16 13:07:00' },
    { fact_key: 'biz.showroom_count', updated_at: '2026-10-01 09:00:00' },
  ];
  const out = filterStaleFacts([F('paid.geo_alignment_approved'), F('biz.showroom_count')], existing, '2026-10-16 13:06:10');
  assert.deepStrictEqual(out.map((f) => f.fact_key), ['biz.showroom_count']);
});

t('库内版本早于入队时间，正常覆盖', () => {
  const existing = [{ fact_key: 'a.b', updated_at: '2026-10-16 13:05:00' }];
  assert.strictEqual(filterStaleFacts([F('a.b')], existing, '2026-10-16 13:06:10').length, 1);
});

t('新 key（库内不存在）不受守卫影响', () => {
  assert.strictEqual(filterStaleFacts([F('new.key')], [], '2026-10-16 13:06:10').length, 1);
});

t('入队时间缺失时不拦（宁可照写，别静默丢人话）', () => {
  const existing = [{ fact_key: 'a.b', updated_at: '2026-10-16 13:07:00' }];
  assert.strictEqual(filterStaleFacts([F('a.b')], existing, '').length, 1);
  assert.strictEqual(filterStaleFacts([F('a.b')], existing, null).length, 1);
});

console.log(fail ? fail + ' fail' : 'factguard: all pass, 0 fail');
process.exit(fail ? 1 : 0);
