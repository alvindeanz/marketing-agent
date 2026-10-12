'use strict';
// 品牌/品类板块：客户点名的分析模块（2026-10-13 LuxeLink 首例，Alvin 定）。
// 数据三件套全部零 LLM：
//   1. 品类聚合卡 + TOP10 词表：GSC query 维度按组正则独立拉取（不吃 5000 行截断的
//      全站拉取，词数与 GSC 一致），平均排名直接用 GSC totals 的加权值不自己算。
//   2. 市场月度搜索量：读客户目录 market_volume_ledger.json（历史由 PJ 报告反解回填，
//      后续按月追加），这里只算 latest/环比/同比，不碰外部接口。
//   3. 组内落地页：复用 factspack 已拉的 GA4 落地页行，按组正则过滤。
// 板块定义在客户目录 reports/report_sections_seo.json，没有该文件的客户整个模块不存在。

const { gscQuery } = require('./metrics');

function round1(n) { return Math.round(Number(n) * 10) / 10; }
function round4(n) { return Math.round(Number(n) * 10000) / 10000; }
function pctDelta(cur, prev) {
  if (!(Number(prev) > 0)) return null;
  return round4((Number(cur) - Number(prev)) / Number(prev));
}

function groupFilters(group) {
  const filters = [{ dimension: 'query', operator: 'includingRegex', expression: String(group.query_regex || '') }];
  if (group.exclude_regex) {
    filters.push({ dimension: 'query', operator: 'excludingRegex', expression: String(group.exclude_regex) });
  }
  return [{ filters }];
}

async function groupTotals(cfg, property, range, group) {
  const res = await gscQuery(cfg, property, {
    startDate: range.start,
    endDate: range.end,
    dimensions: [],
    dimensionFilterGroups: groupFilters(group),
    rowLimit: 1,
  });
  const row = ((res && res.rows) || [])[0] || {};
  return {
    clicks: Number(row.clicks) || 0,
    impressions: Number(row.impressions) || 0,
    position: round1(row.position) || 0,
  };
}

async function groupQueryRows(cfg, property, range, group) {
  const res = await gscQuery(cfg, property, {
    startDate: range.start,
    endDate: range.end,
    dimensions: ['query'],
    dimensionFilterGroups: groupFilters(group),
    rowLimit: 25000,
  });
  return ((res && res.rows) || []).map((r) => ({
    query: String((r.keys || [])[0] || ''),
    clicks: Number(r.clicks) || 0,
    impressions: Number(r.impressions) || 0,
    position: round1(r.position) || 0,
  }));
}

/** TOP10 词表：本期曝光降序，对比期按词 join。纯函数，单测在 tests/brandsections.test.js。 */
function buildTop10(curRows, prevRows) {
  const prevMap = new Map();
  for (const r of prevRows) prevMap.set(r.query, r);
  return curRows
    .slice()
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 10)
    .map((r) => {
      const p = prevMap.get(r.query) || null;
      return {
        query: r.query,
        pos_cur: r.position,
        pos_prev: p ? p.position : null,
        impr_cur: r.impressions,
        impr_prev: p ? p.impressions : null,
        impr_delta_pct: p ? pctDelta(r.impressions, p.impressions) : null,
      };
    });
}

/** 市场量节点：台账 months 与该组序列，产出画图序列 + 最新/环比/同比。纯函数。 */
function buildMarket(ledger, key) {
  if (!ledger || !ledger._meta || !Array.isArray(ledger._meta.months)) return null;
  const series = (ledger.groups || {})[key];
  if (!Array.isArray(series) || !series.length) return null;
  const months = ledger._meta.months.slice(0, series.length);
  const n = series.length;
  const latest = series[n - 1];
  const prev = n >= 2 ? series[n - 2] : null;
  const yoy = n >= 13 ? series[n - 13] : null;
  return {
    months,
    series,
    latest_month: months[n - 1],
    latest,
    prev,
    mom_pct: prev === null ? null : pctDelta(latest, prev),
    yoy_value: yoy,
    yoy_pct: yoy === null ? null : pctDelta(latest, yoy),
  };
}

/** 组内落地页：按正则过滤 factspack 已有的 GA4 落地页行（cur 排序取前 N，prev join）。纯函数。 */
function buildGroupPages(group, lpCur, lpPrev, topN) {
  let inc, exc;
  try {
    inc = new RegExp(group.query_regex, 'i');
    exc = group.exclude_regex ? new RegExp(group.exclude_regex, 'i') : null;
  } catch (e) {
    return [];
  }
  const prevMap = new Map();
  for (const r of lpPrev || []) prevMap.set(r.path, r.sessions);
  return (lpCur || [])
    .filter((r) => inc.test(r.path) && !(exc && exc.test(r.path)))
    .slice(0, topN || 5)
    .map((r) => ({
      path: r.path,
      sessions_cur: r.sessions,
      sessions_prev: prevMap.has(r.path) ? prevMap.get(r.path) : null,
    }));
}

/**
 * 主入口。groups 来自客户目录 report_sections_seo.json，ledger 可为 null（图降级不出）。
 * 每组 4 次 GSC 调用（totals/query 乘 本期/对比期）。
 */
async function buildBrandSections(opts) {
  const { cfg, property, per, groups, ledger, lpCur, lpPrev, log } = opts;
  const say = log || function () {};
  const out = [];
  for (const g of groups) {
    const [curT, prevT, curRows, prevRows] = [
      await groupTotals(cfg, property, per, g),
      await groupTotals(cfg, property, per.compare, g),
      await groupQueryRows(cfg, property, per, g),
      await groupQueryRows(cfg, property, per.compare, g),
    ];
    const section = {
      key: g.key,
      label: g.label,
      accent: g.accent || '',
      kw_total: curRows.length,
      kw_total_prev: prevRows.length,
      kw_delta: curRows.length - prevRows.length,
      impressions: curT.impressions,
      impressions_prev: prevT.impressions,
      impressions_delta_pct: pctDelta(curT.impressions, prevT.impressions),
      clicks: curT.clicks,
      clicks_prev: prevT.clicks,
      position: curT.position,
      position_prev: prevT.position,
      position_delta: round1(curT.position - prevT.position),
      top10: buildTop10(curRows, prevRows),
      market: buildMarket(ledger, g.key),
      pages: buildGroupPages(g, lpCur, lpPrev, 5),
    };
    say('品类板块 ' + g.label + '：词 ' + section.kw_total + '（上期 ' + section.kw_total_prev + '）、曝光 ' + section.impressions + '、均位 ' + section.position);
    out.push(section);
  }
  return out;
}

module.exports = { buildBrandSections, buildTop10, buildMarket, buildGroupPages, groupFilters };
