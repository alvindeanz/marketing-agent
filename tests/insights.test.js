#!/usr/bin/env node
/* Dashboard 数据洞察区的纯函数单测。
   跑法：node tests/insights.test.js
   原理：从 static/seo-agent.html 里按 INSIGHTS-PURE-START / INSIGHTS-PURE-END 标记
   把纯函数块抠出来 eval，不依赖 DOM。改标记文字要同步改这里的正则。 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const HTML = path.join(__dirname, '..', 'static', 'seo-agent.html');
const src = fs.readFileSync(HTML, 'utf8');
const m = src.match(/\/\* INSIGHTS-PURE-START \*\/([\s\S]*?)\/\* INSIGHTS-PURE-END \*\//);
if (!m) {
  console.error('找不到 INSIGHTS-PURE-START / END 标记，检查 static/seo-agent.html');
  process.exit(1);
}

const EXPORTS = [
  'insEsc', 'insD', 'insDs', 'insShift', 'insDiff', 'insRange', 'insMonday',
  'insMonthStart', 'insMonthEnd', 'insMD', 'insBuckets', 'insMapOf', 'insFill',
  'insSumRange', 'insLastIn', 'insLastPoint', 'insAgg', 'insSmooth', 'insLastNonNull',
  'insKpiPeriod', 'insDelta', 'insDeltaPP', 'insFmtNum', 'insFmtShort', 'insFmtPct',
  'insKpiCards', 'insRateSeries', 'insRankBands', 'insBrandSplit',
  'insGroupEventsByDay', 'insEventsToBuckets', 'insNiceMax', 'insMaxOf', 'insHasFinite',
  'insPath', 'insIsolated', 'insEmptyBox', 'insChart', 'insStack',
  'insDeltaHtml', 'insKpiHtml', 'insLegendHtml', 'insRateCardHtml', 'insRankHtml',
  'insBrandHtml', 'insHasAny', 'insBody', 'insRng', 'insMockEvents', 'insMockMetrics',
  'INS_COLOR', 'INS_EVENT_COLOR', 'INS_EVENT_NAME', 'INS_GRAN',
  'repGran', 'repBuckets', 'repKpiPeriod'
];
const P = new Function(m[1] + '\nreturn {' + EXPORTS.join(',') + '};')();

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
function section(s) { console.log('\n' + s); }

const TODAY = '2026-08-24'; // 周一

/* ---------- 日期基元 ---------- */
section('日期基元');
t('insShift 跨月跨年', () => {
  assert.strictEqual(P.insShift('2026-03-01', -1), '2026-02-28');
  assert.strictEqual(P.insShift('2026-01-01', -1), '2025-12-31');
  assert.strictEqual(P.insShift('2024-02-28', 1), '2024-02-29'); // 闰年
});
t('insMonday 把任意日拉回本周一', () => {
  assert.strictEqual(P.insMonday('2026-08-24'), '2026-08-24'); // 周一自己
  assert.strictEqual(P.insMonday('2026-08-23'), '2026-08-17'); // 周日归上一周
  assert.strictEqual(P.insMonday('2026-08-28'), '2026-08-24');
});
t('insMonthEnd 各种月长', () => {
  assert.strictEqual(P.insMonthEnd('2026-02-10'), '2026-02-28');
  assert.strictEqual(P.insMonthEnd('2024-02-10'), '2024-02-29');
  assert.strictEqual(P.insMonthEnd('2026-12-01'), '2026-12-31');
  assert.strictEqual(P.insMonthEnd('2026-04-30'), '2026-04-30');
});
t('insRange 端点闭区间', () => {
  assert.deepStrictEqual(P.insRange('2026-08-01', '2026-08-03'), ['2026-08-01', '2026-08-02', '2026-08-03']);
  assert.strictEqual(P.insRange('2026-08-01', '2026-08-01').length, 1);
});

/* ---------- 桶边界 ---------- */
section('桶边界：只取完整周期');
t('day 粒度 30 天，止于昨天', () => {
  const b = P.insBuckets('day', TODAY);
  assert.strictEqual(b.length, 30);
  assert.strictEqual(b[29].to, '2026-08-23');
  assert.strictEqual(b[0].from, '2026-07-25');
  assert.ok(b.every(x => x.from === x.to), '日桶起止必须同日');
});
t('d90 粒度 90 天，止于昨天', () => {
  const b = P.insBuckets('d90', TODAY);
  assert.strictEqual(b.length, 90);
  assert.strictEqual(b[89].to, '2026-08-23');
  assert.strictEqual(b[0].from, '2026-05-26');
});
t('week 粒度 13 个完整自然周，不含本周', () => {
  const b = P.insBuckets('week', TODAY);
  assert.strictEqual(b.length, 13);
  assert.strictEqual(b[12].from, '2026-08-17');
  assert.strictEqual(b[12].to, '2026-08-23');
  assert.ok(b.every(x => P.insDiff(x.from, x.to) === 6), '每周必须 7 天');
  // 桶之间首尾相接，不重不漏
  for (let i = 1; i < b.length; i++) assert.strictEqual(P.insShift(b[i - 1].to, 1), b[i].from);
});
t('week 粒度在周日当天也只取到上一个完整周', () => {
  const b = P.insBuckets('week', '2026-08-23'); // 周日，本周还没完
  assert.strictEqual(b[12].to, '2026-08-16');
});
t('month 粒度 6 个完整月，不含本月', () => {
  const b = P.insBuckets('month', TODAY);
  assert.strictEqual(b.length, 6);
  assert.strictEqual(b[5].from, '2026-07-01');
  assert.strictEqual(b[5].to, '2026-07-31');
  assert.strictEqual(b[0].from, '2026-02-01');
  assert.strictEqual(b[0].to, '2026-02-28');
  for (let i = 1; i < b.length; i++) assert.strictEqual(P.insShift(b[i - 1].to, 1), b[i].from);
});
t('month 粒度跨年回退', () => {
  const b = P.insBuckets('month', '2026-01-15');
  assert.strictEqual(b[5].from, '2025-12-01');
  assert.strictEqual(b[0].from, '2025-07-01');
});

/* ---------- 聚合与和守恒 ---------- */
section('聚合正确性与和守恒');
const rawSum = s => s.reduce((a, p) => a + p.v, 0);

t('周聚合和守恒', () => {
  const b = P.insBuckets('week', TODAY);
  const days = P.insRange(b[0].from, b[12].to);
  const series = days.map((d, i) => ({ d, v: i + 1 }));
  const agg = P.insAgg(series, b, 'sum');
  assert.strictEqual(agg.reduce((a, v) => a + v, 0), rawSum(series));
  assert.strictEqual(agg.length, 13);
  assert.strictEqual(agg[0], 1 + 2 + 3 + 4 + 5 + 6 + 7);
});
t('月聚合和守恒', () => {
  const b = P.insBuckets('month', TODAY);
  const days = P.insRange(b[0].from, b[5].to);
  const series = days.map((d, i) => ({ d, v: 3 }));
  const agg = P.insAgg(series, b, 'sum');
  assert.strictEqual(agg.reduce((a, v) => a + v, 0), rawSum(series));
  assert.strictEqual(agg[0], 28 * 3); // 2026-02 有 28 天
});
t('聚合忽略窗口外的点，不多算', () => {
  const b = P.insBuckets('day', TODAY);
  const series = [
    { d: '2026-07-24', v: 999 },  // 窗口前一天
    { d: '2026-07-25', v: 5 },
    { d: '2026-08-23', v: 7 },
    { d: '2026-08-24', v: 999 }   // 今天，未完整，不算
  ];
  const agg = P.insAgg(series, b, 'sum');
  assert.strictEqual(agg.reduce((a, v) => a + v, 0), 12);
  assert.strictEqual(agg[0], 5);
  assert.strictEqual(agg[29], 7);
});
t('缺日在 sum 模式下补零，不出现 null/NaN', () => {
  const b = P.insBuckets('day', TODAY);
  const agg = P.insAgg([{ d: '2026-08-01', v: 10 }], b, 'sum');
  assert.strictEqual(agg.length, 30);
  assert.ok(agg.every(v => typeof v === 'number' && isFinite(v)));
  assert.strictEqual(agg.reduce((a, v) => a + v, 0), 10);
});
t('last 模式取桶内最后一个点，无点给 null', () => {
  const b = P.insBuckets('week', TODAY);
  const s = [{ d: '2026-08-17', v: 4 }, { d: '2026-08-20', v: 9 }];
  const agg = P.insAgg(s, b, 'last');
  assert.strictEqual(agg[12], 9);
  assert.strictEqual(agg[11], null);
});
t('insFill 把缺日补成 0 且长度对', () => {
  const f = P.insFill([{ d: '2026-08-02', v: 5 }], '2026-08-01', '2026-08-03');
  assert.deepStrictEqual(f, [{ d: '2026-08-01', v: 0 }, { d: '2026-08-02', v: 5 }, { d: '2026-08-03', v: 0 }]);
});
t('insSmooth 七日均值，前缀窗口自适应', () => {
  const s = P.insSmooth([1, 2, 3, 4, 5, 6, 7, 8], 7);
  assert.strictEqual(s[0], 1);
  assert.strictEqual(s[1], 1.5);
  assert.strictEqual(s[7], (2 + 3 + 4 + 5 + 6 + 7 + 8) / 7);
  assert.strictEqual(s.length, 8);
});
t('insSmooth 全 null 段落给 null 而不是 NaN', () => {
  const s = P.insSmooth([null, null], 7);
  assert.deepStrictEqual(s, [null, null]);
});

/* ---------- 环比 ---------- */
section('环比计算');
t('day 粒度是近 30 天 vs 前 30 天，不是昨日对前日', () => {
  const p = P.insKpiPeriod('day', TODAY);
  assert.strictEqual(p.cur.to, '2026-08-23');
  assert.strictEqual(P.insDiff(p.cur.from, p.cur.to), 29);
  assert.strictEqual(P.insDiff(p.prev.from, p.prev.to), 29);
  assert.strictEqual(P.insShift(p.prev.to, 1), p.cur.from, '两段必须相邻不重叠');
  assert.strictEqual(p.cmp, '近 30 天 vs 前 30 天');
});
t('day 粒度的 KPI 窗口和主趋势图窗口完全一致', () => {
  const b = P.insBuckets('day', TODAY);
  const p = P.insKpiPeriod('day', TODAY);
  assert.strictEqual(b[0].from, p.cur.from);
  assert.strictEqual(b[b.length - 1].to, p.cur.to);
});
t('week 粒度是上周 vs 前一周，两段各 7 天且相邻', () => {
  const p = P.insKpiPeriod('week', TODAY);
  assert.deepStrictEqual(p.cur, { from: '2026-08-17', to: '2026-08-23' });
  assert.deepStrictEqual(p.prev, { from: '2026-08-10', to: '2026-08-16' });
});
t('month 粒度是上月 vs 上上月，各自完整月', () => {
  const p = P.insKpiPeriod('month', TODAY);
  assert.deepStrictEqual(p.cur, { from: '2026-07-01', to: '2026-07-31' });
  assert.deepStrictEqual(p.prev, { from: '2026-06-01', to: '2026-06-30' });
});
t('d90 粒度是近 90 天 vs 前 90 天，无重叠', () => {
  const p = P.insKpiPeriod('d90', TODAY);
  assert.strictEqual(p.cur.to, '2026-08-23');
  assert.strictEqual(P.insDiff(p.cur.from, p.cur.to), 89);
  assert.strictEqual(P.insDiff(p.prev.from, p.prev.to), 89);
  assert.strictEqual(P.insShift(p.prev.to, 1), p.cur.from);
});
t('insDelta 基本方向与百分比', () => {
  assert.strictEqual(Math.round(P.insDelta(120, 100).pct), 20);
  assert.strictEqual(P.insDelta(120, 100).dir, 'up');
  assert.strictEqual(P.insDelta(80, 100).dir, 'down');
  assert.strictEqual(P.insDelta(100, 100).dir, 'flat');
});
t('insDelta 前期为 0 或缺失时不除零', () => {
  assert.deepStrictEqual(P.insDelta(50, 0), { pct: null, dir: 'na' });
  assert.deepStrictEqual(P.insDelta(50, null), { pct: null, dir: 'na' });
  assert.deepStrictEqual(P.insDelta(null, 10), { pct: null, dir: 'na' });
  assert.deepStrictEqual(P.insDelta(0, 0), { pct: null, dir: 'na' });
});
t('insDeltaPP 率类走百分点', () => {
  const d = P.insDeltaPP(0.05, 0.04);
  assert.ok(Math.abs(d.pp - 1) < 1e-9);
  assert.strictEqual(d.dir, 'up');
  assert.strictEqual(P.insDeltaPP(0.05, null).dir, 'na');
});
t('KPI 卡：CTR 由点击除曝光算出，曝光为零不产生 NaN', () => {
  // day 粒度是滚动 30 天：8-23 落在当期窗口，7-01 落在上一窗口
  const m = {
    gsc_impressions: [{ d: '2026-07-01', v: 800 }, { d: '2026-08-23', v: 1000 }],
    gsc_clicks: [{ d: '2026-07-01', v: 32 }, { d: '2026-08-23', v: 50 }]
  };
  const p = P.insKpiPeriod('day', TODAY);
  assert.ok('2026-08-23' >= p.cur.from && '2026-08-23' <= p.cur.to, '前提：8-23 在当期');
  assert.ok('2026-07-01' >= p.prev.from && '2026-07-01' <= p.prev.to, '前提：7-01 在上期');
  const k = P.insKpiCards(m, 'day', TODAY);
  const ctr = k.cards.filter(c => c.key === 'ctr')[0];
  assert.strictEqual(ctr.txt, '5.00%');
  assert.ok(Math.abs(ctr.d.pp - 1) < 1e-9); // 5% vs 4%
  const k2 = P.insKpiCards({}, 'day', TODAY);
  k2.cards.forEach(c => {
    assert.strictEqual(c.has, false);
    assert.ok(!/NaN/.test(c.txt), c.key + ' 出现 NaN');
  });
});
t('KPI 卡：5 张、顺序固定', () => {
  const k = P.insKpiCards({}, 'week', TODAY);
  assert.deepStrictEqual(k.cards.map(c => c.key), ['impr', 'clicks', 'ctr', 'sessions', 'leads']);
});

/* ---------- 除零跳过 ---------- */
section('逐层转化率除零跳过');
t('分母为零的桶给 null，不给 0 也不给 Infinity', () => {
  const b = P.insBuckets('week', TODAY);
  const m = {
    gsc_impressions: [{ d: '2026-08-17', v: 1000 }],
    gsc_clicks: [{ d: '2026-08-17', v: 40 }],
    ga4_sessions_organic: [{ d: '2026-08-17', v: 36 }],
    ga4_leads: [{ d: '2026-08-17', v: 3 }]
  };
  const r = P.insRateSeries(m, b);
  assert.ok(Math.abs(r.ctr[12] - 0.04) < 1e-9);
  assert.ok(Math.abs(r.fit[12] - 0.9) < 1e-9);
  assert.ok(Math.abs(r.cvr[12] - (3 / 36)) < 1e-9);
  for (let i = 0; i < 12; i++) {
    assert.strictEqual(r.ctr[i], null, 'ctr[' + i + ']');
    assert.strictEqual(r.fit[i], null, 'fit[' + i + ']');
    assert.strictEqual(r.cvr[i], null, 'cvr[' + i + ']');
  }
});
t('有点击无会话时 CVR 为 null 而不是 0', () => {
  const b = P.insBuckets('week', TODAY);
  const r = P.insRateSeries({
    gsc_clicks: [{ d: '2026-08-17', v: 40 }],
    ga4_leads: [{ d: '2026-08-17', v: 2 }]
  }, b);
  assert.strictEqual(r.cvr[12], null);
  assert.strictEqual(r.fit[12], 0); // 会话 0 除以点击 40，合法的 0
});
t('全空指标不产生任何非 null 率', () => {
  const b = P.insBuckets('week', TODAY);
  const r = P.insRateSeries({}, b);
  ['ctr', 'fit', 'cvr'].forEach(k => assert.ok(r[k].every(v => v === null), k));
});

/* ---------- 排名分档 ---------- */
section('排名分档拆桶');
t('嵌套桶拆成互斥 band 且非负', () => {
  const b = P.insBuckets('day', TODAY);
  const m = {
    rank_top3: [{ d: '2026-08-23', v: 5 }],
    rank_top10: [{ d: '2026-08-23', v: 18 }],
    rank_top20: [{ d: '2026-08-23', v: 30 }]
  };
  const r = P.insRankBands(m, b);
  assert.strictEqual(r.t3[29], 5);
  assert.strictEqual(r.t4_10[29], 13);
  assert.strictEqual(r.t11_20[29], 12);
  assert.strictEqual(r.t3[0], null);
});
t('脏数据 top10 < top3 时钳到 0，不出负面积', () => {
  const b = P.insBuckets('day', TODAY);
  const r = P.insRankBands({
    rank_top3: [{ d: '2026-08-23', v: 20 }],
    rank_top10: [{ d: '2026-08-23', v: 8 }],
    rank_top20: [{ d: '2026-08-23', v: 8 }]
  }, b);
  assert.strictEqual(r.t4_10[29], 0);
  assert.strictEqual(r.t11_20[29], 0);
});

/* ---------- 事件合并 ---------- */
section('事件按日合并');
t('同日多事件合并成一条，按日期升序', () => {
  const g = P.insGroupEventsByDay([
    { d: '2026-08-23', label: 'A', kind: 'apply' },
    { d: '2026-08-20', label: 'B', kind: 'publish' },
    { d: '2026-08-23', label: 'C', kind: 'offpage' }
  ]);
  assert.strictEqual(g.length, 2);
  assert.strictEqual(g[0].d, '2026-08-20');
  assert.strictEqual(g[1].d, '2026-08-23');
  assert.deepStrictEqual(g[1].items.map(x => x.label), ['A', 'C']);
});
t('缺 d 的脏事件被丢掉，缺 kind 落 manual', () => {
  const g = P.insGroupEventsByDay([{ label: 'x' }, { d: '2026-08-01', label: 'y' }]);
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].items[0].kind, 'manual');
});
t('周粒度下同一周的不同天也合并进一个标记', () => {
  const b = P.insBuckets('week', TODAY);
  const g = P.insGroupEventsByDay([
    { d: '2026-08-17', label: 'A', kind: 'apply' },
    { d: '2026-08-19', label: 'B', kind: 'publish' },
    { d: '2026-08-10', label: 'C', kind: 'config' }
  ]);
  const e = P.insEventsToBuckets(g, b);
  assert.strictEqual(e.length, 2);
  assert.strictEqual(e[0].i, 11);
  assert.strictEqual(e[1].i, 12);
  assert.deepStrictEqual(e[1].items.map(x => x.label), ['A', 'B']);
});
t('窗口外事件不落桶', () => {
  const b = P.insBuckets('day', TODAY);
  const e = P.insEventsToBuckets(P.insGroupEventsByDay([{ d: '2020-01-01', label: 'old', kind: 'apply' }]), b);
  assert.strictEqual(e.length, 0);
});

/* ---------- 数字与刻度 ---------- */
section('数字格式与刻度');
t('千分位', () => {
  assert.strictEqual(P.insFmtNum(1234567), '1,234,567');
  assert.strictEqual(P.insFmtNum(999), '999');
  assert.strictEqual(P.insFmtNum(0), '0');
  assert.strictEqual(P.insFmtNum(null), '--');
  assert.strictEqual(P.insFmtNum(NaN), '--');
});
t('百分比不吐 NaN', () => {
  assert.strictEqual(P.insFmtPct(0.0523, 2), '5.23%');
  assert.strictEqual(P.insFmtPct(null), '--');
  assert.strictEqual(P.insFmtPct(Infinity), '--');
});
t('insNiceMax 永远为正，零和负输入不炸', () => {
  assert.strictEqual(P.insNiceMax(0), 1);
  assert.strictEqual(P.insNiceMax(-5), 1);
  assert.strictEqual(P.insNiceMax(NaN), 1);
  assert.ok(P.insNiceMax(9700) >= 9700);
  assert.ok(P.insNiceMax(1) >= 1);
});

/* ---------- SVG 生成 ---------- */
section('SVG 生成');
t('折线在 null 处断开，不把缺口连成直线', () => {
  const xs = [0, 10, 20, 30];
  const d = P.insPath([1, null, 3, 4], xs, v => v);
  assert.strictEqual((d.match(/M/g) || []).length, 2, '应该有两段');
  assert.strictEqual((d.match(/L/g) || []).length, 1);
});
t('孤点被识别出来单独画圆', () => {
  assert.deepStrictEqual(P.insIsolated([5, null, 7, 8]), [0]);
  assert.deepStrictEqual(P.insIsolated([null, 5, null]), [1]);
  assert.deepStrictEqual(P.insIsolated([1, 2, 3]), []);
});
t('insChart 单点序列不炸且产出合法 svg', () => {
  const h = P.insChart({ labels: ['8/23'], series: [{ name: '点击', color: '#fff', values: [5] }] });
  assert.ok(h.indexOf('<svg') > -1);
  assert.ok(h.indexOf('NaN') === -1, '出现 NaN');
  assert.ok(h.indexOf('Infinity') === -1);
});
t('insChart 全 null 走空态而不是画空图', () => {
  const h = P.insChart({ labels: ['a', 'b'], series: [{ name: 'x', color: '#fff', values: [null, null] }], empty: '没数据' });
  assert.ok(h.indexOf('ins-empty') > -1);
  assert.ok(h.indexOf('没数据') > -1);
});
t('insChart 空 labels 走空态', () => {
  assert.ok(P.insChart({ labels: [], series: [] }).indexOf('ins-empty') > -1);
});
t('insChart 的 data-ins 能被 JSON 解回来，长度对齐', () => {
  const labels = ['1/1', '1/2', '1/3'];
  const h = P.insChart({
    labels, series: [
      { name: '曝光', color: '#818cf8', values: [10, null, 30], axis: 'r' },
      { name: '点击', color: '#38bdf8', values: [1, 2, 3] }
    ],
    events: [{ i: 1, items: [{ d: '2026-01-02', label: 'x', kind: 'apply' }] }]
  });
  const raw = h.match(/data-ins="([^"]*)"/)[1]
    .replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  const pay = JSON.parse(raw);
  assert.strictEqual(pay.n, 3);
  assert.strictEqual(pay.xs.length, 3);
  assert.strictEqual(pay.s.length, 2);
  assert.strictEqual(pay.s[0].y[1], null);
  assert.strictEqual(pay.s[0].t[2], '30');
  assert.ok(pay.e['1'], '事件应挂在索引 1');
});
t('事件标签里的尖括号引号被转义，不破坏属性', () => {
  const h = P.insChart({
    labels: ['a', 'b'],
    series: [{ name: 'x', color: '#fff', values: [1, 2] }],
    events: [{ i: 0, items: [{ d: '2026-01-01', label: '<img src=x onerror="alert(1)">', kind: 'apply' }] }]
  });
  assert.strictEqual(h.indexOf('onerror="alert'), -1);
  assert.ok(h.indexOf('&lt;img') > -1);
});
t('insStack 少于两个有数据的桶返回空串', () => {
  assert.strictEqual(P.insStack({ labels: ['a', 'b', 'c'], bands: [{ color: '#fff', values: [null, 3, null] }] }), '');
  assert.strictEqual(P.insStack({ labels: [], bands: [] }), '');
});
t('insStack 两点起画图，band 数对得上', () => {
  const h = P.insStack({
    labels: ['a', 'b', 'c'],
    bands: [
      { color: '#4ade80', values: [1, 2, 3] },
      { color: '#60a5fa', values: [1, 1, 1] }
    ]
  });
  assert.ok(h.indexOf('<svg') > -1);
  assert.strictEqual((h.match(/<path /g) || []).length, 2);
  assert.strictEqual(h.indexOf('NaN'), -1);
});
t('insStack 全零也不除零', () => {
  const h = P.insStack({ labels: ['a', 'b'], bands: [{ color: '#fff', values: [0, 0] }] });
  assert.ok(h.indexOf('<svg') > -1);
  assert.strictEqual(h.indexOf('NaN'), -1);
});

/* ---------- 品牌拆分 ---------- */
section('品牌拆分');
t('缺品牌序列 -> ok:false，界面走未配置文案', () => {
  assert.strictEqual(P.insBrandSplit({ gsc_clicks: [{ d: '2026-08-23', v: 10 }] }, 'day', TODAY).ok, false);
  assert.strictEqual(P.insBrandSplit({ gsc_clicks_brand: [] }, 'day', TODAY).ok, false);
  assert.ok(P.insBrandHtml({ ok: false }).indexOf('未配置品牌词规则') > -1);
});
t('有品牌序列时占比与非品牌相加为全量', () => {
  const m = {
    gsc_clicks: [{ d: '2026-07-01', v: 80 }, { d: '2026-08-23', v: 100 }],
    gsc_clicks_brand: [{ d: '2026-07-01', v: 40 }, { d: '2026-08-23', v: 40 }]
  };
  const b = P.insBrandSplit(m, 'day', TODAY);
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.brand + b.nonbrand, b.total);
  assert.ok(Math.abs(b.share - 0.4) < 1e-9);
  assert.strictEqual(b.dNon.dir, 'up');   // 60 vs 40
  assert.strictEqual(b.dBrand.dir, 'flat'); // 40 vs 40
});
t('品牌点击大于总点击时非品牌钳到 0', () => {
  const b = P.insBrandSplit({
    gsc_clicks: [{ d: '2026-08-23', v: 10 }],
    gsc_clicks_brand: [{ d: '2026-08-23', v: 30 }]
  }, 'day', TODAY);
  assert.strictEqual(b.nonbrand, 0);
});
t('该周期无点击时不产生 NaN 宽度', () => {
  const h = P.insBrandHtml({ ok: true, total: 0, brand: 0, nonbrand: 0, share: null, period: { cmp: 'x' }, dBrand: { dir: 'na' }, dNon: { dir: 'na' } });
  assert.strictEqual(h.indexOf('NaN'), -1);
});

/* ---------- Mock 与整块渲染 ---------- */
section('Mock 数据与整块渲染');
t('mock 确定性：同种子两次结果一致', () => {
  const a = JSON.stringify(P.insMockMetrics({ today: TODAY, days: 180 }));
  const b = JSON.stringify(P.insMockMetrics({ today: TODAY, days: 180 }));
  assert.strictEqual(a, b);
});
t('mock 有缺日空洞、日期升序、不含今天', () => {
  const m = P.insMockMetrics({ today: TODAY, days: 180 });
  assert.ok(m.gsc_impressions.length > 100);
  assert.ok(m.gsc_impressions.length < 180, '应该有缺日空洞');
  for (let i = 1; i < m.gsc_impressions.length; i++) {
    assert.ok(m.gsc_impressions[i].d > m.gsc_impressions[i - 1].d, '日期必须升序');
  }
  assert.ok(m.gsc_impressions[m.gsc_impressions.length - 1].d < TODAY);
});
t('mock 有周末效应', () => {
  const m = P.insMockMetrics({ today: TODAY, days: 180 });
  let we = 0, wec = 0, wd = 0, wdc = 0;
  m.gsc_impressions.forEach(p => {
    const dow = new Date(P.insD(p.d)).getUTCDay();
    if (dow === 0 || dow === 6) { we += p.v; wec++; } else { wd += p.v; wdc++; }
  });
  assert.ok(we / wec < wd / wdc * 0.85, '周末均值应明显低于工作日');
});
t('mock 排名序列是超短序列', () => {
  const m = P.insMockMetrics({ today: TODAY, days: 180, rankDays: 12 });
  assert.strictEqual(m.rank_top3.length, 12);
  const b = P.insBuckets('month', TODAY);
  assert.strictEqual(P.insStack({
    labels: b.map(x => x.label),
    bands: [{ color: '#fff', values: P.insRankBands(m, b).t3 }]
  }), '', '月粒度下只有一个桶有数据，必须退成只显示数字');
});
t('mock 事件有同日多条', () => {
  const e = P.insMockEvents({ today: TODAY, days: 180 }).events;
  assert.ok(e.length > 3);
  const g = P.insGroupEventsByDay(e);
  assert.ok(g.some(x => x.items.length > 1), '应至少有一天挂两条事件');
});
t('insBody 四个粒度都能渲染，不出 NaN/undefined/Infinity', () => {
  const m = P.insMockMetrics({ today: TODAY, days: 180 });
  const e = P.insMockEvents({ today: TODAY, days: 180 }).events;
  ['day', 'week', 'month', 'd90'].forEach(g => {
    const h = P.insBody(m, e, g, TODAY, '');
    assert.ok(h.length > 2000, g + ' 输出太短');
    assert.strictEqual(h.indexOf('NaN'), -1, g + ' 出现 NaN');
    assert.strictEqual(h.indexOf('undefined'), -1, g + ' 出现 undefined');
    assert.strictEqual(h.indexOf('Infinity'), -1, g + ' 出现 Infinity');
    assert.ok(h.indexOf('ins-kpis') > -1, g + ' 缺 KPI 行');
    assert.ok(h.indexOf('逐层转化率') > -1, g + ' 缺转化率区');
    assert.ok(h.indexOf('排名分档') > -1, g + ' 缺排名区');
    assert.ok(h.indexOf('品牌拆分') > -1, g + ' 缺品牌区');
  });
});
t('insBody 全空数据走空态，不报错不出 NaN', () => {
  ['day', 'week', 'month', 'd90'].forEach(g => {
    const h = P.insBody({}, [], g, TODAY, '');
    assert.ok(h.indexOf('ins-empty') > -1, g);
    assert.strictEqual(h.indexOf('NaN'), -1, g);
    assert.strictEqual(h.indexOf('undefined'), -1, g);
  });
});
t('insBody 无品牌数据时品牌卡走未配置文案', () => {
  const m = P.insMockMetrics({ today: TODAY, days: 180, noBrand: true });
  const h = P.insBody(m, [], 'week', TODAY, '');
  assert.ok(h.indexOf('未配置品牌词规则') > -1);
  assert.strictEqual(h.indexOf('NaN'), -1);
});
t('insBody 只有一天数据也能渲染', () => {
  const m = {
    gsc_impressions: [{ d: '2026-08-23', v: 100 }],
    gsc_clicks: [{ d: '2026-08-23', v: 4 }],
    rank_top3: [{ d: '2026-08-23', v: 2 }]
  };
  ['day', 'week', 'month', 'd90'].forEach(g => {
    const h = P.insBody(m, [], g, TODAY, '');
    assert.strictEqual(h.indexOf('NaN'), -1, g);
    assert.strictEqual(h.indexOf('undefined'), -1, g);
  });
});
t('insBody 零值数据（全 0 不是缺失）不产生除零', () => {
  const days = P.insRange('2026-06-01', '2026-08-23');
  const zero = days.map(d => ({ d, v: 0 }));
  const h = P.insBody({
    gsc_impressions: zero, gsc_clicks: zero,
    ga4_sessions_organic: zero, ga4_leads: zero
  }, [], 'week', TODAY, '');
  assert.strictEqual(h.indexOf('NaN'), -1);
  assert.strictEqual(h.indexOf('Infinity'), -1);
});
t('insBody 粒度按钮当前项高亮唯一', () => {
  const m = P.insMockMetrics({ today: TODAY, days: 180 });
  const h = P.insBody(m, [], 'month', TODAY, '');
  assert.strictEqual((h.match(/class="on" onclick="setInsGran/g) || []).length, 1);
  assert.ok(h.indexOf('setInsGran(\'month\')') > -1);
});
t('界面文案不含 emoji 与破折号', () => {
  const m = P.insMockMetrics({ today: TODAY, days: 180 });
  const h = P.insBody(m, P.insMockEvents({ today: TODAY, days: 180 }).events, 'week', TODAY, '');
  assert.strictEqual(h.indexOf('—'), -1, '出现 em dash');
  assert.strictEqual(h.indexOf('–'), -1, '出现 en dash');
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(h.replace(/[▲▼●]/g, '')), '出现 emoji');
});

t('回填按钮：未入队可点，已入队置灰改文案', () => {
  const m = P.insMockMetrics({ today: TODAY, days: 180 });
  const a = P.insBody(m, [], 'week', TODAY, '', false);
  assert.ok(a.indexOf('onclick="fireBackfill(this)"') > -1);
  assert.ok(a.indexOf('回填历史数据') > -1);
  assert.strictEqual(a.indexOf('已入队'), -1);
  const b = P.insBody(m, [], 'week', TODAY, '', true);
  assert.ok(b.indexOf('已入队，稍后刷新') > -1);
  assert.ok(b.indexOf('disabled') > -1);
  assert.strictEqual(b.indexOf('onclick="fireBackfill(this)"'), -1, '已入队不该还能点');
});
t('回填按钮在空态下也在，新客户才最需要它', () => {
  const h = P.insBody({}, [], 'day', TODAY, '', false);
  assert.ok(h.indexOf('fireBackfill') > -1);
  assert.ok(h.indexOf('ins-empty') > -1);
});

/* ---------- 有状态部分的两处小改，单独抠出来验 ---------- */
section('数据锚点与开关定稿');
const impureNames = ['INS_LAG_DAYS', 'insToday', 'INS_USE_MOCK', 'INS_DAYS', 'INS_REFRESH_MS', 'INS_METRIC_LIST'];
const impure = new Function(
  src.match(/\/\* 数据锚点：[\s\S]*?\n\}/)[0] + '\n' +
  src.match(/^var INS_USE_MOCK=.*$/m)[0] + '\n' +
  src.match(/^var INS_DAYS=.*$/m)[0] + '\n' +
  src.match(/^var INS_REFRESH_MS=.*$/m)[0] + '\n' +
  src.match(/^var INS_METRIC_LIST=.*$/m)[0] + '\n' +
  'return {' + impureNames.join(',') + '};'
)();

t('锚点回退 3 天，避开 GSC 与 GA4 的回填延迟', () => {
  assert.strictEqual(impure.INS_LAG_DAYS, 3);
  const now = new Date(Date.now() - 3 * 86400000);
  const mm = now.getMonth() + 1, dd = now.getDate();
  const want = now.getFullYear() + '-' + (mm < 10 ? '0' : '') + mm + '-' + (dd < 10 ? '0' : '') + dd;
  assert.strictEqual(impure.insToday(), want);
});
t('锚点下最近完整周期不会碰到未回填的尾部', () => {
  const anchor = impure.insToday();
  const real = new Date();
  const rmm = real.getMonth() + 1, rdd = real.getDate();
  const realToday = real.getFullYear() + '-' + (rmm < 10 ? '0' : '') + rmm + '-' + (rdd < 10 ? '0' : '') + rdd;
  assert.strictEqual(P.insDiff(anchor, realToday), 3);
  // 日粒度窗口末点应落在真实今天之前 4 天
  assert.strictEqual(P.insDiff(P.insKpiPeriod('day', anchor).cur.to, realToday), 4);
});
t('USE_MOCK 定稿为 false，mock 代码仍保留可调试', () => {
  assert.strictEqual(impure.INS_USE_MOCK, false);
  assert.strictEqual(typeof P.insMockMetrics, 'function');
  assert.strictEqual(typeof P.insMockEvents, 'function');
});
t('拉数窗口够月粒度 6 个完整月加一个对比月', () => {
  const anchor = impure.insToday();
  const need = P.insDiff(P.insKpiPeriod('month', anchor).prev.from, anchor);
  assert.ok(impure.INS_DAYS > need, 'INS_DAYS=' + impure.INS_DAYS + ' 必须大于 ' + need);
});
t('请求的 metrics 名单只含契约里的指标，且不含 ref_domains', () => {
  const allowed = ['gsc_impressions', 'gsc_clicks', 'gsc_impressions_brand', 'gsc_clicks_brand',
    'ga4_sessions_organic', 'ga4_leads', 'rank_top3', 'rank_top10', 'rank_top20', 'rank_tracked', 'ref_domains'];
  const asked = impure.INS_METRIC_LIST.split(',');
  asked.forEach(k => assert.ok(allowed.indexOf(k) > -1, '契约外指标: ' + k));
  assert.strictEqual(asked.indexOf('ref_domains'), -1, 'ref_domains 维持不拉不画');
});

/* ---------- 表单与 job 提交的接线（字符串层面验，不起 DOM） ---------- */
section('brand_regex 字段与回填 job 接线');
t('brand_regex 进了 PROFILE_FIELDS，存取自动覆盖', () => {
  const line = src.match(/^const PROFILE_FIELDS=\[.*$/m)[0];
  assert.ok(line.indexOf("'brand_regex'") > -1);
});
t('档案表单有 pf_brand_regex 输入框和报错位', () => {
  assert.ok(src.indexOf('id="pf_brand_regex"') > -1);
  assert.ok(src.indexOf('id="pfBrandErr"') > -1);
  assert.ok(/if\(d&&d\._status===400\)setBrandErr/.test(src), '400 时要把后端报错贴到字段下面');
});
t('回填 job 的 type 和 payload 跟后端约定一致', () => {
  assert.ok(/type:'backfill_metrics',payload:\{days:180\}/.test(src));
  assert.ok(/JOB_LABEL=\{[^}]*backfill_metrics:'回填历史数据'/.test(src), 'Jobs 表格要能显示中文名');
});

/* ---------- 报告 tab 的区间版分桶与对比期 ---------- */
section('报告 tab：区间版纯函数');
t('repGran 按区间长度自动选粒度，45 与 200 是边界', () => {
  assert.strictEqual(P.repGran('2026-07-01', '2026-08-14'), 'day');   // 45 天
  assert.strictEqual(P.repGran('2026-07-01', '2026-08-15'), 'week');  // 46 天
  assert.strictEqual(P.repGran('2026-01-01', '2026-07-19'), 'week');  // 200 天
  assert.strictEqual(P.repGran('2026-01-01', '2026-07-20'), 'month'); // 201 天
  assert.strictEqual(P.repGran('2026-07-01', '2026-07-01'), 'day');
});
t('repBuckets 日粒度逐日铺满，端点闭区间', () => {
  const b = P.repBuckets('2026-07-01', '2026-07-31', 'day');
  assert.strictEqual(b.length, 31);
  assert.strictEqual(b[0].from, '2026-07-01');
  assert.strictEqual(b[30].to, '2026-07-31');
  assert.ok(b.every(x => x.from === x.to), '日桶起止必须同日');
});
t('repBuckets 周粒度首尾桶被区间裁短，桶间首尾相接', () => {
  const b = P.repBuckets('2026-07-01', '2026-08-31', 'week'); // 7-01 是周三
  assert.strictEqual(b[0].from, '2026-07-01', '首桶从区间起点算，不回退到周一');
  assert.strictEqual(b[0].to, '2026-07-05');
  assert.strictEqual(b[b.length - 1].to, '2026-08-31', '末桶到区间终点为止');
  for (let i = 1; i < b.length; i++) assert.strictEqual(P.insShift(b[i - 1].to, 1), b[i].from);
});
t('repBuckets 月粒度跨年，端点月是半个月也照样成桶', () => {
  const b = P.repBuckets('2025-11-20', '2026-02-10', 'month');
  assert.strictEqual(b.length, 4);
  assert.deepStrictEqual([b[0].from, b[0].to], ['2025-11-20', '2025-11-30']);
  assert.deepStrictEqual([b[1].from, b[1].to], ['2025-12-01', '2025-12-31']);
  assert.deepStrictEqual([b[3].from, b[3].to], ['2026-02-01', '2026-02-10']);
});
t('repBuckets 单日成一桶，起晚于止返回空数组', () => {
  assert.strictEqual(P.repBuckets('2026-07-01', '2026-07-01', 'day').length, 1);
  assert.deepStrictEqual(P.repBuckets('2026-07-31', '2026-07-01', 'day'), []);
  assert.deepStrictEqual(P.repBuckets('', '2026-07-01', 'day'), []);
});
t('repKpiPeriod 完整自然月走整月对整月，长短不同也不拉齐', () => {
  const p = P.repKpiPeriod('2026-07-01', '2026-07-31');
  assert.deepStrictEqual(p.cur, { from: '2026-07-01', to: '2026-07-31' });
  assert.deepStrictEqual(p.prev, { from: '2026-06-01', to: '2026-06-30' });
  assert.strictEqual(P.insShift(p.prev.to, 1), p.cur.from, '两段必须相邻不重叠');
  assert.ok(p.cmp.indexOf('6 月') > -1 && p.cmp.indexOf('全月') > -1, 'cmp 要写明对比的是整月');
  // 3 月对 2 月：28 天对 31 天，正是自然月口径与等长口径的分水岭
  const mar = P.repKpiPeriod('2026-03-01', '2026-03-31');
  assert.deepStrictEqual(mar.prev, { from: '2026-02-01', to: '2026-02-28' });
  // 1 月回退跨年
  assert.deepStrictEqual(P.repKpiPeriod('2026-01-01', '2026-01-31').prev, { from: '2025-12-01', to: '2025-12-31' });
});
t('repKpiPeriod 非完整月退回等长上一段，紧邻不重叠', () => {
  const p = P.repKpiPeriod('2026-07-01', '2026-07-20'); // 缺月末，不算整月
  assert.deepStrictEqual(p.prev, { from: '2026-06-11', to: '2026-06-30' });
  assert.strictEqual(P.insDiff(p.prev.from, p.prev.to), P.insDiff(p.cur.from, p.cur.to));
  assert.strictEqual(P.insShift(p.prev.to, 1), p.cur.from);
  assert.ok(p.cmp.indexOf('前 20 天') > -1);
  // 缺月初同样不算整月
  assert.deepStrictEqual(P.repKpiPeriod('2026-07-02', '2026-07-31').prev, { from: '2026-06-02', to: '2026-07-01' });
  // 单日跨月回退
  assert.deepStrictEqual(P.repKpiPeriod('2026-03-02', '2026-03-02').prev, { from: '2026-03-01', to: '2026-03-01' });
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
