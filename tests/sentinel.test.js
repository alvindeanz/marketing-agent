#!/usr/bin/env node
/* 指标哨兵：周期回归的命中、门槛、覆盖保护、投放断流与去重；外加按源缓存 TTL。
   跑法：node tests/sentinel.test.js
   防的是三类事故：小样本客户被噪音开单刷屏、真塌方时因取数空洞静默漏报、
   日跑 pull 把 semrush 付费额度烧穿。 */
const assert = require('assert');
const sentinel = require('../seo-worker/lib/sentinel');
const { pickWatchCallout } = require('../seo-worker/runners/report');
const { cacheCheck } = require('../seo-worker/runners/pull_data');

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

/** 造一段逐日序列：days 个点，按回调给值，锚定在 2026-10-14 往回数。i=0 是最新一天。 */
function series(days, valueOf) {
  const out = [];
  const end = Date.UTC(2026, 9, 14);
  for (let i = 0; i < days; i++) {
    const d = new Date(end - i * 86400000).toISOString().slice(0, 10);
    out.push({ d, v: valueOf(i) });
  }
  return out;
}

t('点击周环比掉 50% 且基数够，命中', () => {
  const s = { gsc_clicks: series(21, (i) => (i < 7 ? 2 : 4)) }; // w0=14, w1=28
  const alerts = sentinel.evalSentinel(s);
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].metric, 'gsc_clicks');
  assert.strictEqual(alerts[0].dropPct, 50);
  assert.strictEqual(alerts[0].anchor, '2026-10-14');
});

t('点击掉得狠但上周不足 20 次（小样本），不开单', () => {
  const s = { gsc_clicks: series(21, (i) => (i < 7 ? 0 : 2)) }; // w1=14 < floor 20
  assert.strictEqual(sentinel.evalSentinel(s).length, 0);
});

t('点击只掉 20%，不到 30% 阈值，不开单', () => {
  const s = { gsc_clicks: series(21, (i) => (i < 7 ? 8 : 10)) };
  assert.strictEqual(sentinel.evalSentinel(s).length, 0);
});

t('曝光单周掉 40% 不算，连续两周对基线掉 40% 才命中', () => {
  // w0 与 w1 都跌破基线周 w2 的 60%：w2=7000, w1=3500, w0=3500
  const hit = { gsc_impressions: series(21, (i) => (i < 14 ? 500 : 1000)) };
  const a = sentinel.evalSentinel(hit);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].metric, 'gsc_impressions');
  assert.strictEqual(a[0].weeks, 2);
  // 只有最近一周塌，上一周还在基线水平：不算持续，不开单
  const single = { gsc_impressions: series(21, (i) => (i < 7 ? 500 : 1000)) };
  assert.strictEqual(sentinel.evalSentinel(single).length, 0);
});

t('GSC 窗口取数空洞（覆盖不足 5 天），宁可漏报不误报', () => {
  const s = { gsc_clicks: series(21, (i) => (i < 7 ? 1 : 5)).filter((_, idx) => idx % 2 === 0) };
  assert.strictEqual(sentinel.evalSentinel(s).length, 0);
});

t('询盘走 14 天窗基数 10：缺行按 0、锚取 GSC 最新日，询盘枯竭测得到', () => {
  const s = {
    gsc_clicks: series(35, () => 10), // 提供锚，自身平稳不命中
    ga4_leads: series(35, (i) => (i < 14 ? 0 : 1)).filter((p) => p.v > 0), // 近 14 天一行都没有，前 14 天共 14 条
  };
  const alerts = sentinel.evalSentinel(s);
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].metric, 'ga4_leads');
  assert.strictEqual(alerts[0].cur, 0);
});

t('询盘 14 天基数 8 不足 10（泊松噪音区），不开单', () => {
  const s = {
    gsc_clicks: series(35, () => 10),
    ga4_leads: series(35, (i) => (i >= 14 && i < 22 ? 1 : 0)).filter((p) => p.v > 0), // 前窗 8 条
  };
  assert.strictEqual(sentinel.evalSentinel(s).length, 0);
});

t('投放断流：近 3 天花费 0 且前 7 天 >= 50，命中；长期停投（基数 0）不命中', () => {
  const hit = { ads_cost: series(14, (i) => (i < 3 ? 0 : 30)) }; // 前 7 天 210
  const a = sentinel.evalSentinel(hit);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].metric, 'ads_cost');
  assert.strictEqual(a[0].tag, '广告花费断流');
  const paused = { ads_cost: series(14, () => 0) };
  assert.strictEqual(sentinel.evalSentinel(paused).length, 0);
  const small = { ads_cost: series(14, (i) => (i < 3 ? 0 : 5)) }; // 前 7 天 35 < 50
  assert.strictEqual(sentinel.evalSentinel(small).length, 0);
});

t('空输入不炸不报', () => {
  assert.deepStrictEqual(sentinel.evalSentinel({}), []);
  assert.deepStrictEqual(sentinel.evalSentinel(null), []);
});

t('去重：未结哨兵单拦住，14 天内结过的也拦，老单不拦', () => {
  const now = Date.UTC(2026, 9, 14);
  const open = [{ id: 9, title: sentinel.TITLE_PREFIX + ' x', status: 'proposed', created_at: '2026-08-01' }];
  assert.ok(sentinel.sentinelBlocked(open, now));
  const recent = [{ id: 9, title: sentinel.TITLE_PREFIX + ' x', status: 'done', created_at: '2026-10-05' }];
  assert.ok(sentinel.sentinelBlocked(recent, now));
  const old = [{ id: 9, title: sentinel.TITLE_PREFIX + ' x', status: 'done', created_at: '2026-09-01' }];
  assert.strictEqual(sentinel.sentinelBlocked(old, now), null);
  const other = [{ id: 9, title: '普通任务', status: 'proposed', created_at: '2026-10-13' }];
  assert.strictEqual(sentinel.sentinelBlocked(other, now), null);
});

t('开单文案：标题带降幅与锚定日，detail 带生态级并单指引与四选一要求，置顶', () => {
  const alerts = sentinel.evalSentinel({ gsc_clicks: series(21, (i) => (i < 7 ? 2 : 4)) });
  const task = sentinel.buildTask('X', alerts, ['https://a/ ：100 -> 10']);
  assert.ok(task.title.startsWith(sentinel.TITLE_PREFIX));
  assert.ok(task.title.includes('降50%'));
  assert.ok(task.detail.includes('四选一'));
  assert.ok(task.detail.includes('生态级'));
  assert.ok(task.detail.includes('100 -> 10'));
  assert.strictEqual(task.owner_type, 'agent');
  assert.strictEqual(task.status, 'proposed');
  assert.strictEqual(task.attention, 1);
});

t('报告需观察 callout 挑选：黄取正文，缺了返回 null', () => {
  const n = {
    funnel_callouts: [
      { tone: 'green', title: '关键改善', body: 'aaa' },
      { tone: 'yellow', title: '需观察', body: ' 询盘回落 ' },
    ],
  };
  const c = pickWatchCallout(n);
  assert.strictEqual(c.body, '询盘回落');
  assert.strictEqual(pickWatchCallout({ funnel_callouts: [{ tone: 'yellow', body: '  ' }] }), null);
  assert.strictEqual(pickWatchCallout(null), null);
});

t('按源缓存 TTL：30 小时旧快照，gsc 过期要拉，semrush 在 144h 内跳过', () => {
  const created = new Date(Date.now() - 30 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const latest = [
    { source: 'gsc', created_at: created },
    { source: 'semrush', created_at: created },
  ];
  const ctx = { cfg: { cacheTtlHours: 24, sourceTtlHours: { semrush: 144 } }, log: () => {}, fresh: false };
  assert.strictEqual(cacheCheck(ctx, latest, 'gsc').skip, false);
  assert.strictEqual(cacheCheck(ctx, latest, 'semrush').skip, true);
});

console.log(fail ? fail + ' fail' : 'sentinel: all pass, 0 fail');
process.exit(fail ? 1 : 0);
