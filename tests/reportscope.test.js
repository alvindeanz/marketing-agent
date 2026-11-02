'use strict';
/* 报告口径 scope（ticket #54，Haakaa AU 月报）：纯函数单测。
   覆盖 GSC 多属性合并与 country 注入、GA4 country AND 合并、
   profile.report_scope 解析（坏值必须炸不许静默回落）、日均比。 */
const assert = require('node:assert');
const { normGscScope, withGscCountry, withGa4Country, mergeGscResponses } = require('../seo-worker/lib/metrics');
const { parseReportScope, dailyAvgCompare } = require('../seo-worker/lib/factspack');

// ---- normGscScope：旧的单属性字符串与 scope 对象都收 ----
{
  assert.deepStrictEqual(normGscScope('https://a.example/'), { properties: ['https://a.example/'], country: '' });
  assert.deepStrictEqual(normGscScope(''), { properties: [], country: '' });
  assert.deepStrictEqual(normGscScope(null), { properties: [], country: '' });
  const s = normGscScope({ properties: [' https://a/ ', '', 'https://b/'], country: 'AUS' });
  assert.deepStrictEqual(s.properties, ['https://a/', 'https://b/']);
  assert.strictEqual(s.country, 'aus');
}

// ---- withGscCountry：无组新建一组；有组时并进每一组（组间 OR 组内 AND） ----
{
  const noCountry = withGscCountry({ dimensions: ['query'] }, '');
  assert.strictEqual(noCountry.dimensionFilterGroups, undefined);

  const fresh = withGscCountry({ dimensions: ['query'] }, 'aus');
  assert.strictEqual(fresh.dimensionFilterGroups.length, 1);
  assert.deepStrictEqual(fresh.dimensionFilterGroups[0].filters[0], {
    dimension: 'country', operator: 'equals', expression: 'aus',
  });

  const body = {
    dimensions: ['query'],
    dimensionFilterGroups: [
      { groupType: 'and', filters: [{ dimension: 'query', operator: 'excludingRegex', expression: 'spam' }] },
      { groupType: 'and', filters: [{ dimension: 'query', operator: 'includingRegex', expression: 'brand' }] },
    ],
  };
  const merged = withGscCountry(body, 'aus');
  assert.strictEqual(merged.dimensionFilterGroups.length, 2);
  for (const g of merged.dimensionFilterGroups) {
    assert.strictEqual(g.filters.length, 2);
    assert.strictEqual(g.filters[1].dimension, 'country');
  }
  // 原 body 不被改写
  assert.strictEqual(body.dimensionFilterGroups[0].filters.length, 1);
}

// ---- mergeGscResponses：同 key 相加，position 按曝光加权，ctr 重算，排序 clicks 降序 ----
{
  const a = { rows: [
    { keys: ['kw1'], clicks: 10, impressions: 100, ctr: 0.1, position: 5 },
    { keys: ['kw2'], clicks: 1, impressions: 10, ctr: 0.1, position: 20 },
  ] };
  const b = { rows: [
    { keys: ['kw1'], clicks: 2, impressions: 100, ctr: 0.02, position: 15 },
    { keys: ['kw3'], clicks: 5, impressions: 50, ctr: 0.1, position: 3 },
  ] };
  const m = mergeGscResponses([a, b]);
  assert.strictEqual(m.rows.length, 3);
  const kw1 = m.rows.find((r) => r.keys[0] === 'kw1');
  assert.strictEqual(kw1.clicks, 12);
  assert.strictEqual(kw1.impressions, 200);
  assert.strictEqual(kw1.ctr, 0.06);
  assert.strictEqual(kw1.position, 10); // (5*100 + 15*100) / 200
  assert.strictEqual(m.rows[0].keys[0], 'kw1'); // clicks 降序
  // 无维度汇总（keys 为空数组）也按同 key 合并成单行
  const t = mergeGscResponses([
    { rows: [{ keys: [], clicks: 3, impressions: 30, ctr: 0.1, position: 4 }] },
    { rows: [{ keys: [], clicks: 7, impressions: 70, ctr: 0.1, position: 6 }] },
  ]);
  assert.strictEqual(t.rows.length, 1);
  assert.strictEqual(t.rows[0].clicks, 10);
  assert.strictEqual(t.rows[0].position, 5.4); // (4*30+6*70)/100
  // 空响应不炸
  assert.deepStrictEqual(mergeGscResponses([{}, { rows: [] }]).rows, []);
}

// ---- withGa4Country：无既有过滤直挂；有既有过滤包 andGroup ----
{
  const plain = withGa4Country({ dimensions: [{ name: 'date' }] }, 'Australia');
  assert.strictEqual(plain.dimensionFilter.filter.fieldName, 'country');
  assert.strictEqual(plain.dimensionFilter.filter.stringFilter.value, 'Australia');

  const existing = { filter: { fieldName: 'eventName', inListFilter: { values: ['purchase'] } } };
  const merged = withGa4Country({ dimensionFilter: existing }, 'Australia');
  assert.strictEqual(merged.dimensionFilter.andGroup.expressions.length, 2);
  assert.strictEqual(merged.dimensionFilter.andGroup.expressions[0], existing);
  assert.strictEqual(merged.dimensionFilter.andGroup.expressions[1].filter.fieldName, 'country');

  const none = withGa4Country({ dimensionFilter: existing }, '');
  assert.strictEqual(none.dimensionFilter, existing);
}

// ---- parseReportScope：空=null，坏 JSON 与列表必须炸，字段归一化 ----
{
  assert.strictEqual(parseReportScope(null), null);
  assert.strictEqual(parseReportScope({}), null);
  assert.strictEqual(parseReportScope({ report_scope: '' }), null);
  assert.strictEqual(parseReportScope({ report_scope: '   ' }), null);
  assert.throws(() => parseReportScope({ report_scope: '{bad json' }), /不是合法 JSON/);
  assert.throws(() => parseReportScope({ report_scope: '[1,2]' }), /JSON 对象/);
  const s = parseReportScope({
    report_scope: JSON.stringify({
      gsc_properties: ['https://www.haakaa.co.nz/', 'https://www.haakaa.com.au/'],
      gsc_country: 'AUS',
      ga4_country: 'Australia',
      currency_label: 'USD',
      compare: 'daily_avg',
      market_label: 'AU',
    }),
  });
  assert.strictEqual(s.gsc_properties.length, 2);
  assert.strictEqual(s.gsc_country, 'aus');
  assert.strictEqual(s.ga4_country, 'Australia');
  assert.strictEqual(s.currency_label, 'USD');
  assert.strictEqual(s.compare, 'daily_avg');
  assert.strictEqual(s.market_label, 'AU');
  // 已是对象（GET /profile 某些路径可能已解 JSON）也收
  const o = parseReportScope({ report_scope: { gsc_country: 'nzl' } });
  assert.strictEqual(o.gsc_country, 'nzl');
  assert.deepStrictEqual(o.gsc_properties, []);
}

// ---- dailyAvgCompare：日均与日均环比，零天数与零基数回 null ----
{
  const d = dailyAvgCompare(310, 300, 31, 30);
  assert.strictEqual(d.cur_per_day, 10);
  assert.strictEqual(d.prev_per_day, 10);
  assert.strictEqual(d.delta_pct, 0);
  const up = dailyAvgCompare(330, 300, 30, 30);
  assert.strictEqual(up.delta_pct, 0.1);
  const zeroDays = dailyAvgCompare(100, 300, 0, 30);
  assert.strictEqual(zeroDays.cur_per_day, null);
  assert.strictEqual(zeroDays.delta_pct, null);
  const zeroPrev = dailyAvgCompare(100, 0, 30, 30);
  assert.strictEqual(zeroPrev.delta_pct, null);
}

console.log('reportscope.test.js 全部通过');
