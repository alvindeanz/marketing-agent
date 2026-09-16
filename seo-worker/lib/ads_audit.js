'use strict';
/* agent 泳道的零模型后置对账（2026-09-14 Alvin 定下放后的钢板）。
   前置白名单退位成路由偏好后，安全底换成这块：agent 说做了不算，账户硬读出来才算。
   输入 agent 上报的条目行（landed/verified），凡 entity/evidence 里带 Google Ads
   resource name 的，按类型 GAQL 读回来比对存在性与关键值；一行都对不上或
   agent 泳道零行可审，都算对账不过，任务不许收口。
   查询函数可注入（单测用假数据），默认走 gaql_query.py 子进程（只读通道）。 */
const { execFileSync } = require('node:child_process');
const GAQL = '/data/aira/seo-worker/lib/gaql_query.py';

function runGaqlDefault(customerId, query) {
  const out = execFileSync('python3', [GAQL, customerId, query], { timeout: 60000 }).toString().trim();
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const RES_RE = /customers\/\d+\/(assetGroups|campaignBudgets|campaigns|conversionActions|assets|adGroups|campaignCriteria|adGroupCriteria)\/[\w~-]+/;

/* 每类资源：查什么、怎么算符合。expectText 是条目 target_value+evidence 的合并文本，
   用来抠期望状态或 micros 数值。 */
const CHECKS = {
  assetGroups: {
    query: (rn) => "SELECT asset_group.resource_name, asset_group.status FROM asset_group WHERE asset_group.resource_name = '" + rn + "'",
    verify(rows, expectText) {
      if (!rows.length) return '账户里查无此 asset group';
      const st = String(rows[0].asset_group_status || '');
      if (/ENABLED/i.test(expectText) && st !== 'ENABLED') return '期望 ENABLED 实际 ' + st;
      if (st !== 'ENABLED' && st !== 'PAUSED') return '状态异常 ' + st;
      return '';
    },
  },
  campaignBudgets: {
    query: (rn) => "SELECT campaign_budget.resource_name, campaign_budget.amount_micros FROM campaign_budget WHERE campaign_budget.resource_name = '" + rn + "'",
    verify(rows, expectText) {
      if (!rows.length) return '账户里查无此 budget';
      const m = expectText.match(/(\d{6,})\s*micros/);
      if (m && String(rows[0].campaign_budget_amount_micros) !== m[1]) {
        return '期望 ' + m[1] + ' micros 实际 ' + rows[0].campaign_budget_amount_micros;
      }
      return '';
    },
  },
  campaigns: {
    query: (rn) => "SELECT campaign.resource_name, campaign.status FROM campaign WHERE campaign.resource_name = '" + rn + "'",
    verify(rows, expectText) {
      if (!rows.length) return '账户里查无此 campaign';
      const st = String(rows[0].campaign_status || '');
      const want = (expectText.match(/\b(ENABLED|PAUSED)\b/) || [])[1];
      if (want && st !== want) return '期望 ' + want + ' 实际 ' + st;
      return '';
    },
  },
  conversionActions: {
    query: (rn) => "SELECT conversion_action.resource_name, conversion_action.status FROM conversion_action WHERE conversion_action.resource_name = '" + rn + "'",
    verify(rows) { return rows.length ? '' : '账户里查无此 conversion action'; },
  },
  assets: {
    query: (rn) => "SELECT asset.resource_name FROM asset WHERE asset.resource_name = '" + rn + "'",
    verify(rows) { return rows.length ? '' : '账户里查无此 asset'; },
  },
  adGroups: {
    query: (rn) => "SELECT ad_group.resource_name, ad_group.status FROM ad_group WHERE ad_group.resource_name = '" + rn + "'",
    verify(rows, expectText) {
      if (!rows.length) return '账户里查无此 ad group';
      const st = String(rows[0].ad_group_status || '');
      const want = (expectText.match(/\b(ENABLED|PAUSED)\b/) || [])[1];
      if (want && st !== want) return '期望 ' + want + ' 实际 ' + st;
      return '';
    },
  },
  /* 2026-09-16 #740 教训：agent 泳道最常写的恰是这两类（否词/关键词），不在表里
     导致 60 行全带资源名仍「零行可硬审」。verify 从 expectText 抠期望的匹配类型与状态。 */
  campaignCriteria: {
    query: (rn) => "SELECT campaign_criterion.resource_name, campaign_criterion.status, campaign_criterion.negative, campaign_criterion.keyword.text, campaign_criterion.keyword.match_type FROM campaign_criterion WHERE campaign_criterion.resource_name = '" + rn + "'",
    verify(rows, expectText) {
      if (!rows.length) return '账户里查无此 campaign criterion';
      const st = String(rows[0].campaign_criterion_status || '');
      const mt = String(rows[0].campaign_criterion_keyword_match_type || '');
      const wantMt = (expectText.match(/\b(PHRASE|BROAD|EXACT)\b/) || [])[1];
      if (wantMt && mt && mt !== wantMt) return '期望 ' + wantMt + ' 实际 ' + mt;
      const wantSt = /\bPAUSED\b/.test(expectText) ? 'PAUSED' : 'ENABLED';
      if (st && st !== wantSt) return '期望 ' + wantSt + ' 实际 ' + st;
      return '';
    },
  },
  adGroupCriteria: {
    query: (rn) => "SELECT ad_group_criterion.resource_name, ad_group_criterion.status, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM ad_group_criterion WHERE ad_group_criterion.resource_name = '" + rn + "'",
    verify(rows, expectText) {
      if (!rows.length) return '账户里查无此 ad group criterion';
      const st = String(rows[0].ad_group_criterion_status || '');
      const mt = String(rows[0].ad_group_criterion_keyword_match_type || '');
      const wantMt = (expectText.match(/\b(PHRASE|BROAD|EXACT)\b/) || [])[1];
      if (wantMt && mt && mt !== wantMt) return '期望 ' + wantMt + ' 实际 ' + mt;
      const wantSt = /\bPAUSED\b/.test(expectText) ? 'PAUSED' : 'ENABLED';
      if (st && st !== wantSt) return '期望 ' + wantSt + ' 实际 ' + st;
      return '';
    },
  },
};

/**
 * @param {string} customerId 无横杠客户号
 * @param {Array} items agent 上报条目行 {entity,op,state,target_value?,evidence?}
 * @param {Function} [runGaql] (customerId, query) => rows，注入用
 * @returns {{ok:boolean, checked:number, unaudited:number, failures:Array<{entity:string,why:string}>}}
 */
function auditAgentItems(customerId, items, runGaql) {
  const q = runGaql || runGaqlDefault;
  const failures = [];
  let checked = 0;
  let unaudited = 0;
  for (const it of items || []) {
    const st = String((it && it.state) || '');
    if (st !== 'landed' && st !== 'verified') continue;
    const hay = String((it && it.entity) || '') + ' ' + String((it && it.evidence) || '');
    const m = RES_RE.exec(hay);
    if (!m) { unaudited += 1; continue; }
    const kind = m[1];
    const rn = m[0];
    const chk = CHECKS[kind];
    if (!chk) { unaudited += 1; continue; }
    const expectText = String((it && it.target_value) || '') + ' ' + String((it && it.evidence) || '');
    let why = '';
    try { why = chk.verify(q(customerId, chk.query(rn)), expectText); }
    catch (e) { why = '对账查询失败：' + String(e.message || e).slice(0, 120); }
    checked += 1;
    if (why) failures.push({ entity: rn, why });
  }
  /* 钢板判定：有失败即不过；一行都没审到也不过（agent 泳道要求 entity 带 resource name，
     全部缺失说明产出不合契约，不能靠「查不了」蒙混收口）。 */
  const ok = failures.length === 0 && checked > 0;
  return { ok, checked, unaudited, failures };
}

module.exports = { auditAgentItems, RES_RE };
