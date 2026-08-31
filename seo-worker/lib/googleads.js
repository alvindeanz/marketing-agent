'use strict';
// Google Ads 只读拉数 adapter（paid 类目第一个渠道，W8 批 1）。
// 全部走子进程 gaql_query.py（google-ads SDK 在 python 侧），本文件零凭据零 mutate。
// 指标口径：ads_cost 与 ads_conv_value 换算成账户币种的元；渠道前缀 ads_ 专属 Google，
// 后续渠道用自己的前缀（见 seo-api METRIC_NAMES 注释）。

const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'gaql_query.py');
const TIMEOUT_MS = 120000;

function gaql(customerId, query, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [SCRIPT, String(customerId), '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, opts.timeoutMs || TIMEOUT_MS);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error('gaql exit ' + code + ' :: ' + err.replace(/\s+/g, ' ').slice(0, 400)));
        return;
      }
      const rows = [];
      for (const line of out.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { rows.push(JSON.parse(t)); } catch (e) { /* 非 JSON 行忽略 */ }
      }
      resolve(rows);
    });
    child.stdin.end(query);
  });
}

const num = (v) => Number(v) || 0;

/** 账户级按日指标。range {start,end} YYYY-MM-DD 含首尾。 */
async function dailyMetrics(customerId, range) {
  const rows = await gaql(customerId,
    "SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions, metrics.conversions_value " +
    "FROM customer WHERE segments.date BETWEEN '" + range.start + "' AND '" + range.end + "' ORDER BY segments.date");
  return rows.map((r) => ({
    date: r.segments_date,
    cost: Math.round(num(r.metrics_cost_micros) / 1e6 * 100) / 100,
    clicks: num(r.metrics_clicks),
    impressions: num(r.metrics_impressions),
    conversions: num(r.metrics_conversions),
    conv_value: Math.round(num(r.metrics_conversions_value) * 100) / 100,
  }));
}

/** campaign 结构与近窗表现（facts 与快照用）。 */
async function campaigns(customerId, range) {
  const rows = await gaql(customerId,
    "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, " +
    "campaign_budget.amount_micros, metrics.cost_micros, metrics.clicks, metrics.conversions " +
    "FROM campaign WHERE segments.date BETWEEN '" + range.start + "' AND '" + range.end + "' AND campaign.status != 'REMOVED'");
  const by = new Map();
  for (const r of rows) {
    const id = String(r.campaign_id);
    const cur = by.get(id) || {
      id,
      name: r.campaign_name,
      status: r.campaign_status,
      type: r.campaign_advertising_channel_type,
      bidding: r.campaign_bidding_strategy_type || '',
      daily_budget: Math.round(num(r.campaign_budget_amount_micros) / 1e6 * 100) / 100,
      cost: 0, clicks: 0, conversions: 0,
    };
    cur.cost += num(r.metrics_cost_micros) / 1e6;
    cur.clicks += num(r.metrics_clicks);
    cur.conversions += num(r.metrics_conversions);
    by.set(id, cur);
  }
  return Array.from(by.values()).map((c) => Object.assign(c, { cost: Math.round(c.cost * 100) / 100 }));
}

/** 启用中的 conversion actions（转化口径核对用）。 */
async function conversionActions(customerId) {
  const rows = await gaql(customerId,
    "SELECT conversion_action.id, conversion_action.name, conversion_action.type, conversion_action.primary_for_goal, conversion_action.status " +
    "FROM conversion_action WHERE conversion_action.status = 'ENABLED'");
  return rows.map((r) => ({
    id: String(r.conversion_action_id),
    name: r.conversion_action_name,
    type: r.conversion_action_type,
    primary: !!r.conversion_action_primary_for_goal,
  }));
}

/** 按日指标转 seo_metrics_daily 行。 */
function metricRows(daily) {
  const rows = [];
  for (const r of daily || []) {
    if (!r.date) continue;
    rows.push({ d: r.date, m: 'ads_cost', v: r.cost });
    rows.push({ d: r.date, m: 'ads_clicks', v: r.clicks });
    rows.push({ d: r.date, m: 'ads_impressions', v: r.impressions });
    rows.push({ d: r.date, m: 'ads_conversions', v: r.conversions });
    rows.push({ d: r.date, m: 'ads_conv_value', v: r.conv_value });
  }
  return rows;
}

module.exports = { gaql, dailyMetrics, campaigns, conversionActions, metricRows };
