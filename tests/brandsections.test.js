'use strict';
/* 品牌板块：纯函数单测 + 渲染冒烟（复用 report.test.js 的 fakePack 思路但自带最小 pack）。 */
const assert = require('node:assert');
const { buildTop10, buildMarket, buildGroupPages, groupFilters } = require('../seo-worker/lib/brandsections');
const { renderReport } = require('../seo-worker/lib/reporthtml');

// ---- groupFilters ----
{
  const g = groupFilters({ query_regex: 'hermes', exclude_regex: 'jewell' });
  assert.strictEqual(g[0].filters.length, 2);
  assert.strictEqual(g[0].filters[0].operator, 'includingRegex');
  assert.strictEqual(g[0].filters[1].operator, 'excludingRegex');
  const g2 = groupFilters({ query_regex: 'chanel' });
  assert.strictEqual(g2[0].filters.length, 1);
}

// ---- buildTop10：曝光降序取前10，对比期按词 join，缺词给 null ----
{
  const cur = [];
  for (let i = 0; i < 12; i++) cur.push({ query: 'q' + i, clicks: 0, impressions: 100 - i, position: 5 + i });
  const prev = [{ query: 'q0', clicks: 0, impressions: 80, position: 6 }];
  const t = buildTop10(cur, prev);
  assert.strictEqual(t.length, 10);
  assert.strictEqual(t[0].query, 'q0');
  assert.strictEqual(t[0].impr_prev, 80);
  assert.strictEqual(t[0].impr_delta_pct, 0.25);
  assert.strictEqual(t[1].pos_prev, null);
  assert.strictEqual(t[1].impr_delta_pct, null);
}

// ---- buildMarket：latest/环比/同比，序列不足 13 个月无同比 ----
{
  const months = [];
  const series = [];
  for (let y = 2024, m = 6, i = 0; i < 28; i++) {
    months.push(y + '-' + String(m).padStart(2, '0'));
    series.push(1000 + i);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  const mk = buildMarket({ _meta: { months }, groups: { a: series } }, 'a');
  assert.strictEqual(mk.latest, 1027);
  assert.strictEqual(mk.latest_month, '2026-09');
  assert.strictEqual(mk.yoy_value, 1015);
  assert.strictEqual(mk.mom_pct, 0.001); /* round4(1/1026) */
  const short = buildMarket({ _meta: { months: months.slice(0, 5) }, groups: { a: series.slice(0, 5) } }, 'a');
  assert.strictEqual(short.yoy_value, null);
  assert.strictEqual(buildMarket(null, 'a'), null);
  assert.strictEqual(buildMarket({ _meta: { months } , groups: {} }, 'missing'), null);
}

// ---- buildGroupPages：按组正则过滤路径，prev join，坏正则回空不炸 ----
{
  const lpCur = [
    { path: '/collections/hermes-bags', sessions: 50 },
    { path: '/collections/chanel-bags', sessions: 40 },
  ];
  const lpPrev = [{ path: '/collections/hermes-bags', sessions: 60 }];
  const p = buildGroupPages({ query_regex: 'hermes' }, lpCur, lpPrev, 5);
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].sessions_prev, 60);
  assert.deepStrictEqual(buildGroupPages({ query_regex: '([' }, lpCur, lpPrev, 5), []);
}

// ---- 渲染冒烟：带 brand_sections 的 pack 渲出品牌节、节号顺延、无占位符残留 ----
{
  const months = [];
  const series = [];
  for (let y = 2024, m = 6, i = 0; i < 28; i++) {
    months.push(y + '-' + String(m).padStart(2, '0'));
    series.push(10000 + i * 100);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  const pack = {
    meta: {
      client_id: 6, client_name: 'Demo', domain: 'demo.com.au', slug: 'demo',
      report_lang: 'zh', orders_attribution: 'session', biz_type: 'leadgen', market: 'AU',
      period: { type: 'month', start: '2026-09-01', end: '2026-09-30', label: '2026年9月', short: '9月', partial: false, rolling: false },
      compare: { start: '2026-08-01', end: '2026-08-31', label: '2026年8月', short: '8月' },
      generated_at: '2026-10-13', version_hint: 1, leads_source: 'x', leads_override: null, instructions: null,
    },
    gsc: { cur: { clicks: 10, impressions: 100, ctr: 0.1, position: 9 }, prev: { clicks: 8, impressions: 90, ctr: 0.1, position: 10 }, delta: { clicks: 2, impressions: 10, ctr_pp: 0, position: -1 }, brand: null, top_queries: [], zero_exposure_pages: [], coverage: null },
    ga4: { organic: null, channels: [], channels_total: null, funnel: { steps: [], rates: [] }, landing_pages: [], coverage: null },
    brand_sections: [{
      key: 'hermes', label: 'Hermès', accent: '#92400e',
      kw_total: 3121, kw_total_prev: 3198, kw_delta: -77,
      impressions: 29917, impressions_prev: 35916, impressions_delta_pct: -0.167,
      clicks: 60, clicks_prev: 70, position: 12.1, position_prev: 11.5, position_delta: 0.6,
      top10: [{ query: 'hermes picotin', pos_cur: 5.4, pos_prev: 5.5, impr_cur: 1348, impr_prev: 1549, impr_delta_pct: -0.13 }],
      market: { months, series, latest_month: '2026-09', latest: series[27], prev: series[26], mom_pct: 0.01, yoy_value: series[15], yoy_pct: 0.05 },
      pages: [{ path: '/collections/hermes', sessions_cur: 100, sessions_prev: 120 }],
    }],
    yoy: null, rankings: { summary: null, rows: [] }, trend: { months: [], gsc_clicks: [], ga4_sessions_organic: [] },
    work: { items: [] }, next: { items: [] }, facts_for_prompt: [], gaps: [],
    narrative_inputs: { kpi_sentence_parts: [], ranking_highlights: [], ranking_declines: [], page_risers: [], page_fallers: [] },
    pack_inputs: {},
  };
  const narrative = null; // 降级渲染路径必须照样出整节
  const html = renderReport(pack, narrative, {});
  assert.ok(html.includes('品牌与品类表现'), '品牌节标题缺失');
  assert.ok(html.includes('Hermès'), '品牌卡缺失');
  assert.ok(html.includes('hermes picotin'), 'TOP10 行缺失');
  assert.ok(html.includes('市场月度搜索量'), '市场图块缺失');
  assert.ok(html.includes('<svg viewBox="0 0 800 118"'), '市场 SVG 缺失');
  assert.ok(!html.includes('{{'), '占位符残留');
  assert.ok(html.includes('>5<') || html.includes('Section 5'), '品牌节号缺失');
  // 无品牌板块时不渲节，节号不顺延
  const html2 = renderReport(Object.assign({}, pack, { brand_sections: null }), null, {});
  assert.ok(!html2.includes('品牌与品类表现'));
}

console.log('brandsections.test.js ok');
