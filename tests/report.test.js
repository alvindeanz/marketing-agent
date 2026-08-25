#!/usr/bin/env node
/* 报告模块三层的单测。
   跑法：node tests/report.test.js
   覆盖：数据层纯函数（环比、同窗周期、查询归一化与簇加权、分类归组、渠道合并）、
        文案 lint 的每条规则正反例、叙事数字校验、渲染层占位符与降级。
   不碰网络、不调模型、不写 250。 */

const assert = require('assert');
const path = require('path');

const W = path.join(__dirname, '..', 'seo-worker');
const F = require(path.join(W, 'lib', 'factspack'));
const L = require(path.join(W, 'lib', 'reportlint'));
const R = require(path.join(W, 'lib', 'reporthtml'));
const P = require(path.join(W, 'lib', 'publish'));
const R2 = require(path.join(W, 'runners', 'report'));
const D = require(path.join(W, 'lib', 'distill'));
const cfgmod = require(path.join(W, 'lib', 'config'));

let pass = 0,
  fail = 0;
const pending = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(
        r.then(
          () => {
            pass++;
            console.log('  ok   ' + name);
          },
          (e) => {
            fail++;
            console.log('  FAIL ' + name + '\n       ' + e.message);
          }
        )
      );
      return;
    }
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL ' + name + '\n       ' + e.message);
  }
}
function section(s) {
  console.log('\n' + s);
}

/* ---------- 假 pack ---------- */

function fakePack(over) {
  const pack = {
    meta: {
      client_id: 46,
      client_name: '测试窗帘',
      domain: 'example.com',
      slug: 'demo',
      report_lang: 'zh',
      biz_type: 'leadgen',
      market: 'AU',
      platform: 'WebForger',
      vertical: '窗帘',
      period: { type: 'month', start: '2026-07-01', end: '2026-07-31', label: '2026年7月（全月）', short: '7月', partial: false, through_day: null },
      compare: { start: '2026-06-01', end: '2026-06-30', label: 'vs 6月（全月）', short: '6月' },
      generated_at: '2026-08-01T00:00:00Z',
      version_hint: 1,
      leads_source: 'GA4 关键事件 form_submit、generate_lead、click_to_call 之和',
      leads_override: null,
    },
    gsc: {
      cur: { clicks: 1200, impressions: 52000, ctr: 0.023, position: 14.2 },
      prev: { clicks: 1000, impressions: 48000, ctr: 0.021, position: 16.1 },
      delta: { clicks: 200, impressions: 4000, ctr_pp: 0.2, position: -1.9 },
      brand: { cur_clicks: 300, prev_clicks: 280, share_cur: 0.25 },
      top_queries: [{ query: 'sheer curtains', clicks: 40, impressions: 900, position: 8.2, prev_position: 9.9 }],
      zero_exposure_pages: [],
    },
    ga4: {
      organic: {
        cur: { sessions: 900, new_users: 700, leads: 24 },
        prev: { sessions: 800, new_users: 640, leads: 20 },
        delta: { sessions: 100, sessions_pct: 0.125, leads: 4, leads_pct: 0.2 },
      },
      channels: [
        { channel: 'Organic Search', sessions: 900, prev_sessions: 800, leads: 24, prev_leads: 20, revenue: null, prev_revenue: null, is_organic: true, is_muted: false, share: 0.9 },
        { channel: 'Direct', sessions: 40, prev_sessions: 30, leads: 1, prev_leads: 0, revenue: null, prev_revenue: null, is_organic: false, is_muted: false, share: 0.04 },
        { channel: '其他', sessions: 60, prev_sessions: 50, leads: 1, prev_leads: 0, revenue: null, prev_revenue: null, is_organic: false, is_muted: true, share: 0.06 },
      ],
      channels_total: { sessions: 1000, prev_sessions: 880, leads: 26, prev_leads: 20, revenue: null },
      funnel: {
        steps: [
          { key: 'sessions', label: '自然搜索访问', cur: 900, prev: 800 },
          { key: 'form_start', label: '开始填写表单', cur: 60, prev: 50 },
          { key: 'leads', label: '询盘', cur: 24, prev: 20 },
        ],
        rates: [],
      },
      landing_pages: [
        { path: '/', sessions: 400, prev_sessions: 350, delta: 50 },
        { path: '/curtains/', sessions: 200, prev_sessions: null, delta: null },
      ],
      ecommerce: null,
    },
    rankings: {
      method: '按查询簇曝光加权的 GSC 平均位次',
      rows: [
        { keyword: '测试窗帘', pos: 1.2, prev_pos: 1.5, delta: -0.3, impressions: 300, clicks: 100, is_brand: true, band: 'top10' },
        { keyword: 'sheer curtains', pos: 8.2, prev_pos: 9.9, delta: -1.7, impressions: 900, clicks: 40, is_brand: false, band: 'top10' },
        { keyword: 'blockout blinds', pos: null, prev_pos: 12.0, delta: null, impressions: 0, clicks: 0, is_brand: false, band: 'none' },
      ],
      summary: { total: 3, top10: 2, p11_20: 0, improved: 2, declined: 0, no_exposure: 1 },
      near_page1: [],
      declined_with_volume: [],
    },
    trend: { months: ['2026-06', '2026-07'], gsc_clicks: [1000, 1200], ga4_sessions_organic: [800, 900], last_partial: false },
    work: {
      items: [{ date: '2026-07-02', kind: 'apply', category: 'onpage', title_raw: '首页精校', detail_raw: '', source: 'task:1', files: 0 }],
      counts: { onpage: 1, content: 0, tech: 0, link: 0, report: 0 },
      blogs_published: 0,
      pages_optimised: 1,
    },
    next: { plan_sprint: 'S2', tasks: [], open_from_period: [] },
    facts_for_prompt: ['biz.model: 服务型，不是电商'],
    gaps: [],
    narrative_inputs: { kpi_sentence_parts: [], ranking_highlights: [], ranking_declines: [], page_risers: [], page_fallers: [] },
    pack_inputs: {},
  };
  return Object.assign(pack, over || {});
}

function fakeNarrative() {
  return {
    hero_headline: '搜索点击与询盘同步走强',
    hero_kpi_keys: ['gsc_clicks', 'ga4_sessions_organic', 'leads', 'gsc_position'],
    ga4_sdesc: '本报告数据来自 Google Analytics 4 与 Google Search Console，周期为整月，与上一个完整月做对比，本期自然搜索的访问与询盘同步走强。',
    ga4_callouts: [
      { tone: 'green', title: '本月信号', body: '自然搜索的点击与访问同步上行，询盘也跟着增加，说明进站的人更接近有需求的客户。' },
      { tone: 'yellow', title: '需留意', body: '搜索点击率仍然偏低，下月我们重写主要页面的搜索结果描述，把标题写得更贴近客户的问法。' },
    ],
    channels_sdesc: '本节按 GA4 默认渠道分组统计全渠道访问与询盘，并与上一个完整月对比。',
    channels_callout: { tone: 'blue', title: '全渠道与自然搜索对照', body: '全渠道访问与询盘都在上行，其中自然搜索是最大的一块，增量也主要来自它。' },
    funnel_sdesc: '漏斗三步都在上行，其中开始填写表单这一步增幅最大，询盘也随之增加。',
    funnel_callouts: [
      { tone: 'green', title: '关键改善', body: '开始填写表单的人变多，说明页面上的报价入口更容易被看见。' },
      { tone: 'yellow', title: '需观察', body: '从开始填写到真正提交仍有流失，下月我们精简表单字段并把电话入口放到更显眼的位置。' },
    ],
    rankings_sdesc: '目标词共三个，位次按查询簇的曝光加权计算，前十名用绿色，十一至二十名用蓝色，二十名以后用灰色，标注本月无曝光的词多数是精确匹配掉了样本。',
    rankings_callouts: [
      { tone: 'green', title: '排名亮点', body: '品牌词稳定在首位，主力品类词也继续前进，曝光同步增加。' },
      { tone: 'yellow', title: '需关注', body: '有一个词本月没有拿到曝光，下月我们把对应页面的内容补厚并加内链。' },
    ],
    pages_sdesc: '数据来自 GA4 自然搜索渠道的落地页访问，并与上一个完整月对比。',
    pages_callouts: [
      { tone: 'green', title: '领涨页面', body: '首页与品类页同时上行，是本期增量的主要来源。' },
      { tone: 'yellow', title: '回落页面', body: '暂无明显回落的页面，下月继续观察品类页的稳定性。' },
    ],
    work_sdesc: '本期按上期报告的计划逐项执行，完成情况如下。',
    work_items: [{ category: 'onpage', title: '首页与品类页标题精校', body: '重写了首页与主要品类页的标题与搜索结果描述，并补齐了页面之间的内链，让搜索结果里的措辞更贴近客户的问法。' }],
    next_items: [
      { slot: 1, priority: 'P1', title: '把逼近首页的词推进第一页', body: '按本期数据挑出接近首页的词，对应到品类页做标题与内容调整。', urls: ['/curtains/', '/fake-page/'] },
      { slot: 2, priority: 'P2', title: '外链建设', body: '围绕本期带量的页面继续做站外布点。' },
      { slot: 3, priority: 'P3', title: '内容更新', body: '按合同节奏推进内容，选题取本期有需求的方向。' },
      { slot: 4, priority: 'P4', title: '站点健康检查', body: '例行做一轮站点健康检查。' },
      { slot: 5, priority: 'P5', title: '数据监督与报告交付', body: '继续按月监控搜索表现与询盘。' },
    ],
    self_check: { numbers_all_from_pack: true, no_banned_words: true, callouts_paired: true },
  };
}

/* ---------- 环比 ---------- */
section('环比与位次差');
t('pctDelta 常规', () => {
  assert.strictEqual(F.pctDelta(5, 4), 0.25);
  assert.strictEqual(F.pctDelta(3, 4), -0.25);
});
t('pctDelta prev 为 0 返回 null，不返回 Infinity', () => {
  assert.strictEqual(F.pctDelta(5, 0), null);
  assert.strictEqual(F.pctDelta(0, 0), null);
});
t('pctDelta 缺值返回 null', () => {
  assert.strictEqual(F.pctDelta(null, 4), null);
  assert.strictEqual(F.pctDelta(4, undefined), null);
});
t('posDelta 负数代表提升', () => {
  assert.ok(F.posDelta(8.2, 9.9) < 0, '位次从 9.9 到 8.2 是提升，差值必须为负');
  assert.ok(F.posDelta(12, 9) > 0);
  assert.strictEqual(F.posDelta(9, null), null);
});
t('ppDelta 算百分点', () => {
  assert.ok(Math.abs(F.ppDelta(0.023, 0.021) - 0.2) < 1e-9);
});

/* ---------- 周期 ---------- */
section('同窗周期计算');
t('整月：end 落在月末，对比上一个完整月', () => {
  const p = F.computePeriod({ start: '2026-07-01', today: '2026-08-25', lagDays: 3 });
  assert.strictEqual(p.end, '2026-07-31');
  assert.strictEqual(p.partial, false);
  assert.strictEqual(p.through_day, null);
  assert.strictEqual(p.label, '2026年7月（全月）');
  assert.strictEqual(p.compare.start, '2026-06-01');
  assert.strictEqual(p.compare.end, '2026-06-30');
});
t('月中出报：end 是今天减 lag，对比上月同窗', () => {
  const p = F.computePeriod({ start: '2026-08-01', today: '2026-08-25', lagDays: 3 });
  assert.strictEqual(p.end, '2026-08-22');
  assert.strictEqual(p.partial, true);
  assert.strictEqual(p.through_day, 22);
  assert.ok(p.label.indexOf('截至 22 日') > -1);
  assert.strictEqual(p.compare.start, '2026-07-01');
  assert.strictEqual(p.compare.end, '2026-07-22');
});
t('月中出报的对比期日号会被压到上月最后一天', () => {
  const p = F.computePeriod({ start: '2026-03-01', end: '2026-03-30', today: '2026-04-05', lagDays: 3 });
  assert.strictEqual(p.compare.end, '2026-02-28');
});
t('显式 end 超过月末会被夹回月末', () => {
  const p = F.computePeriod({ start: '2026-07-01', end: '2026-09-09', today: '2026-10-01' });
  assert.strictEqual(p.end, '2026-07-31');
  assert.strictEqual(p.partial, false);
});
t('跨年往回推一个月', () => {
  const p = F.computePeriod({ start: '2026-01-01', today: '2026-02-20', lagDays: 3 });
  assert.strictEqual(p.compare.start, '2025-12-01');
  assert.strictEqual(p.compare.end, '2025-12-31');
});
t('monthsBack 出 13 个月且末尾是本月', () => {
  const m = F.monthsBack('2026-08', 13);
  assert.strictEqual(m.length, 13);
  assert.strictEqual(m[0], '2025-08');
  assert.strictEqual(m[12], '2026-08');
});
t('闰年二月天数', () => {
  assert.strictEqual(F.monthEndOf('2024-02-10'), '2024-02-29');
  assert.strictEqual(F.monthEndOf('2026-02-10'), '2026-02-28');
});
t('runner 的默认周期是上一个完整自然月', () => {
  assert.strictEqual(R2.defaultPeriodStart('2026-08-25'), '2026-07-01');
  assert.strictEqual(R2.defaultPeriodStart('2026-01-05'), '2025-12-01');
});

/* ---------- 查询归一化与簇加权 ---------- */
section('查询归一化与簇加权位次');
t('normalizeQuery 归一大小写、连字符与标点', () => {
  assert.strictEqual(F.normalizeQuery('Sheer-Curtains, Auckland!'), 'sheer curtains auckland');
  assert.strictEqual(F.normalizeQuery('  多个   空格 '), '多个 空格');
});
t('queryTokens 空串出空数组', () => {
  assert.deepStrictEqual(F.queryTokens('  '), []);
  assert.deepStrictEqual(F.queryTokens('a b'), ['a', 'b']);
});
t('簇加权位次按曝光加权', () => {
  const rows = [
    { query: 'sheer curtains auckland', impressions: 100, clicks: 5, position: 8 },
    { query: 'sheer curtain nz', impressions: 300, clicks: 3, position: 12 },
    { query: 'blockout blinds', impressions: 900, clicks: 1, position: 2 },
  ];
  const c = F.clusterWeightedPosition(rows, 'sheer curtain');
  assert.strictEqual(c.matched, 2);
  assert.strictEqual(c.impressions, 400);
  assert.strictEqual(c.pos, 11); // (8*100 + 12*300) / 400
  assert.strictEqual(c.clicks, 8);
});
t('簇零曝光时 pos 为 null，不写成 0', () => {
  const c = F.clusterWeightedPosition([{ query: 'blinds', impressions: 10, position: 5 }], 'sheer curtains');
  assert.strictEqual(c.pos, null);
  assert.strictEqual(c.impressions, 0);
  assert.strictEqual(F.rankBand(c.pos), 'none');
});
t('rankBand 三档', () => {
  assert.strictEqual(F.rankBand(1), 'top10');
  assert.strictEqual(F.rankBand(10), 'top10');
  assert.strictEqual(F.rankBand(10.1), 'p11_20');
  assert.strictEqual(F.rankBand(20), 'p11_20');
  assert.strictEqual(F.rankBand(20.1), 'p21_plus');
  assert.strictEqual(F.rankBand(null), 'none');
});

/* ---------- 分类归组 ---------- */
section('工作量分类归组');
t('五类关键词各命中一次', () => {
  assert.strictEqual(F.classifyWork('提交 301 跳转清理'), 'tech');
  assert.strictEqual(F.classifyWork('外链布点第二批'), 'link');
  assert.strictEqual(F.classifyWork('博客发布：小浴室布局'), 'content');
  assert.strictEqual(F.classifyWork('品类页 title 与描述精校'), 'onpage');
  assert.strictEqual(F.classifyWork('七月月报交付'), 'report');
});
t('一个都不沾返回 null', () => {
  assert.strictEqual(F.classifyWork('和客户喝咖啡'), null);
  assert.strictEqual(F.classifyWork(''), null);
});
t('buildWork 只收本期完成的任务并按分类计数', () => {
  const period = { start: '2026-07-01', end: '2026-07-31' };
  const tasks = [
    { id: 1, status: 'done', title: '品类页 title 精校', updated_at: '2026-07-05 10:00:00' },
    { id: 2, status: 'done', title: '博客发布', updated_at: '2026-06-20 10:00:00' },
    { id: 3, status: 'in_progress', title: '外链布点', updated_at: '2026-07-08 10:00:00' },
  ];
  const w = F.buildWork({ tasks, events: [{ d: '2026-07-09', kind: 'publish', label: '博客上线' }], period, outputs: new Map() });
  assert.strictEqual(w.items.length, 2);
  assert.strictEqual(w.counts.onpage, 1);
  assert.strictEqual(w.counts.content, 1);
  assert.strictEqual(w.pages_optimised, 1);
});
t('buildWork 同日同名的事件不与任务重复计', () => {
  const period = { start: '2026-07-01', end: '2026-07-31' };
  const tasks = [{ id: 1, status: 'done', title: '博客上线', updated_at: '2026-07-09 10:00:00' }];
  const w = F.buildWork({ tasks, events: [{ d: '2026-07-09', kind: 'publish', label: '博客上线' }], period, outputs: new Map() });
  assert.strictEqual(w.items.length, 1);
});

/* ---------- 渠道合并 ---------- */
section('渠道合并 5% 规则');
t('小于 5% 的可合并渠道并成其他，自然搜索永不合并', () => {
  const cur = [
    { channel: 'Organic Search', sessions: 900, leads: 24, revenue: null },
    { channel: 'Direct', sessions: 40, leads: 1, revenue: null },
    { channel: 'Organic Social', sessions: 30, leads: 0, revenue: null },
    { channel: 'Email', sessions: 20, leads: 1, revenue: null },
    { channel: 'Referral', sessions: 10, leads: 0, revenue: null },
  ];
  const out = F.mergeChannels(cur, []);
  const names = out.channels.map((c) => c.channel);
  assert.ok(names.indexOf('其他') > -1, '应合出一行其他');
  assert.ok(names.indexOf('Organic Social') === -1);
  assert.ok(names.indexOf('Direct') > -1, 'Direct 不在可合并清单里');
  assert.strictEqual(out.channels[names.indexOf('其他')].sessions, 60);
  assert.strictEqual(out.total.sessions, 1000);
});
t('占比达到 5% 的可合并渠道单独留一行', () => {
  const cur = [
    { channel: 'Organic Search', sessions: 900, leads: 10, revenue: null },
    { channel: 'Email', sessions: 100, leads: 2, revenue: null },
  ];
  const out = F.mergeChannels(cur, []);
  assert.deepStrictEqual(out.channels.map((c) => c.channel), ['Organic Search', 'Email']);
});
t('上期有本期没有的渠道要补一行零', () => {
  const out = F.mergeChannels([{ channel: 'Organic Search', sessions: 500, leads: 5, revenue: null }], [
    { channel: 'Organic Search', sessions: 400, leads: 4, revenue: null },
    { channel: 'Paid Search', sessions: 300, leads: 9, revenue: null },
  ]);
  const paid = out.channels.filter((c) => c.channel === 'Paid Search')[0];
  assert.ok(paid, '上期渠道不能凭空消失');
  assert.strictEqual(paid.sessions, 0);
  assert.strictEqual(paid.prev_sessions, 300);
});
t('合计用渠道行相加', () => {
  const out = F.mergeChannels(
    [
      { channel: 'Organic Search', sessions: 10, leads: 1, revenue: null },
      { channel: 'Direct', sessions: 5, leads: 0, revenue: null },
    ],
    []
  );
  assert.strictEqual(out.total.sessions, 15);
  assert.strictEqual(out.total.leads, 1);
});
t('其他行带 is_muted 与来源清单', () => {
  const out = F.mergeChannels(
    [
      { channel: 'Organic Search', sessions: 990, leads: 3, revenue: null },
      { channel: 'Display', sessions: 10, leads: 0, revenue: null },
    ],
    []
  );
  const other = out.channels[out.channels.length - 1];
  assert.strictEqual(other.channel, '其他');
  assert.strictEqual(other.is_muted, true);
  assert.deepStrictEqual(other.merged_from, ['Display']);
});

/* ---------- 时序聚合 ---------- */
section('时序按月聚合');
t('monthlySum 按自然月求和且忽略坏日期', () => {
  const m = F.monthlySum([{ d: '2026-07-01', v: 10 }, { d: '2026-07-31', v: 5 }, { d: 'bad', v: 99 }, { d: '2026-08-01', v: 2 }]);
  assert.strictEqual(m.get('2026-07'), 15);
  assert.strictEqual(m.get('2026-08'), 2);
});
t('buildTrend 缺的月补 0 保持等长', () => {
  const tr = F.buildTrend({ gsc_clicks: [{ d: '2026-07-05', v: 7 }] }, ['2026-06', '2026-07'], true);
  assert.deepStrictEqual(tr.gsc_clicks, [0, 7]);
  assert.deepStrictEqual(tr.ga4_sessions_organic, [0, 0]);
  assert.strictEqual(tr.last_partial, true);
});

/* ---------- facts 过滤 ---------- */
section('facts 过滤在截断之前');
t('distill.factLines 的 excludePrefixes 先过滤后截断', () => {
  const list = [];
  for (let i = 0; i < 60; i++) list.push({ fact_key: 'internal.x' + i, value: 'v' });
  list.push({ fact_key: 'biz.model', value: '服务型' });
  const text = D.factLines(list, 60, { excludePrefixes: ['internal.'] });
  assert.ok(text.indexOf('biz.model') > -1, '内部条目不该把名额占光');
  assert.strictEqual(text.indexOf('internal.'), -1);
});
t('不传 opts 时行为不变', () => {
  const text = D.factLines([{ fact_key: 'internal.a', value: '1' }], 60);
  assert.ok(text.indexOf('internal.a') > -1);
});
t('factsForPrompt 剔掉 internal 前缀', () => {
  const lines = F.factsForPrompt({ facts: { confirmed: [{ fact_key: 'internal.token', value: 'x' }, { fact_key: 'biz.model', value: '服务型' }], pending: [] } });
  assert.strictEqual(lines.join('|').indexOf('internal.'), -1);
  assert.ok(lines.join('|').indexOf('biz.model') > -1);
});
t('inferBizType 按 facts 与成交数判定', () => {
  assert.strictEqual(F.inferBizType(['biz.model: 服务型，不是电商'], 12), 'leadgen');
  assert.strictEqual(F.inferBizType([], 12), 'ecommerce');
  assert.strictEqual(F.inferBizType([], 0), 'leadgen');
});
t('parseLeadsOverride 读得出人工覆盖', () => {
  assert.strictEqual(F.parseLeadsOverride('询盘总数按后台实收 18'), 18);
  assert.strictEqual(F.parseLeadsOverride('随便写点别的'), null);
});

/* ---------- lint 规则 ---------- */
section('文案 lint 每条规则正反例');
function hasRule(res, rule) {
  return res.hits.some((h) => h.rule === rule);
}
t('dash 正反例', () => {
  assert.ok(hasRule(L.lintText('本期表现 — 很好'), 'dash'));
  assert.ok(hasRule(L.lintText('区间 2026–2027'), 'dash'));
  assert.ok(!hasRule(L.lintText('本期 7 月至 8 月表现很好'), 'dash'));
});
t('空格连字符正反例', () => {
  assert.ok(hasRule(L.lintText('自然搜索 - 询盘'), 'space_hyphen'));
  assert.ok(!hasRule(L.lintText('dual-frequency 与 180-day 都不算'), 'space_hyphen'));
});
t('工具名正反例', () => {
  assert.ok(hasRule(L.lintText('我们用 Semrush 查了一下'), 'tool_name'));
  assert.ok(hasRule(L.lintText('数据来自 Ahrefs'), 'tool_name'));
  assert.ok(!hasRule(L.lintText('我们做了一轮 keyword research'), 'tool_name'));
});
t('排名措辞正反例', () => {
  assert.ok(hasRule(L.lintText('排名从 12 收紧到 8'), 'ranking_wording'));
  assert.ok(hasRule(L.lintText('位次收窄'), 'ranking_wording'));
  assert.ok(!hasRule(L.lintText('排名提升 4 位'), 'ranking_wording'));
});
t('AI 字样正反例', () => {
  assert.ok(hasRule(L.lintText('本报告经 AI 分析得出'), 'ai_phrase'));
  assert.ok(hasRule(L.lintText('AI 写的'), 'ai_word'));
  assert.ok(!hasRule(L.lintText('本报告由我们团队整理'), 'ai_word'));
});
t('裸 AI 字样只拦叙事，成品里的 AI Assistant 渠道名放行', () => {
  assert.ok(hasRule(L.lintText('AI 帮我们写的'), 'ai_word'), '叙事里的裸 AI 要拦住');
  const pack = fakePack();
  pack.ga4.channels.push({ channel: 'AI Assistant', sessions: 96, prev_sessions: 59, leads: 15, prev_leads: 3, revenue: null, prev_revenue: null, is_organic: false, is_muted: false, share: 0.096 });
  const html = R.renderReport(pack, null, {});
  assert.ok(html.indexOf('AI Assistant') > -1);
  const res = L.lintReport(html);
  assert.strictEqual(res.ok, true, JSON.stringify(res.hits));
  assert.ok(hasRule(L.lintReport('<p>本报告经 AI 分析得出</p>'), 'ai_phrase'), '成品里暴露 AI 工具的措辞仍要拦住');
});
t('内部黑话正反例', () => {
  assert.ok(hasRule(L.lintText('这是一个钱页'), 'internal_jargon'));
  assert.ok(hasRule(L.lintText('两边口径不一致'), 'internal_jargon'));
  assert.ok(!hasRule(L.lintText('两边统计说明不一致'), 'internal_jargon'));
});
t('W 编号与版本号痕迹正反例', () => {
  assert.ok(hasRule(L.lintText('见 W34 的安排'), 'w_number'));
  assert.ok(hasRule(L.lintText('深度优化 #1'), 'w_number'));
  assert.ok(!hasRule(L.lintText('见本月的安排'), 'w_number'));
});
t('emoji 正反例', () => {
  assert.ok(hasRule(L.lintText('本月很好 🎉'), 'emoji'));
  assert.ok(!hasRule(L.lintText('本月很好'), 'emoji'));
});
t('色值不会被 W 编号规则误伤', () => {
  const res = L.lintReport('<p><b style="color:#16a34a">提升 4 位</b></p>');
  assert.strictEqual(res.ok, true, JSON.stringify(res.hits));
});
t('callout 行内 strong 正反例', () => {
  const bad = L.lintReport('<div class="callout callout-green"><strong>标题</strong><p>正文 <strong>强调</strong></p></div>');
  assert.ok(hasRule(bad, 'callout_inline_strong'));
  const good = L.lintReport('<div class="callout callout-green"><strong>标题</strong><p>正文 <b style="color:#16a34a">强调</b></p></div>');
  assert.strictEqual(good.ok, true, JSON.stringify(good.hits));
});
t('callout 内列表被拦住', () => {
  const bad = L.lintReport('<div class="callout callout-blue"><strong>标题</strong><ul><li>一</li></ul></div>');
  assert.ok(hasRule(bad, 'callout_list'));
});
t('数字块 v warn 被拦住，v amb 放行', () => {
  assert.ok(hasRule(L.lintReport('<div class="v warn">12</div>'), 'v_warn_class'));
  assert.strictEqual(L.lintReport('<div class="v amb">12</div>').ok, true);
});
t('script 与 style 里的内容不参与正文检查', () => {
  const res = L.lintReport('<style>.x{background:#1f2937}</style><script>const a = 1 - 2;</script><p>正常一句话</p>');
  assert.strictEqual(res.ok, true, JSON.stringify(res.hits));
});

/* ---------- 数字校验 ---------- */
section('叙事数字校验');
t('numbersFromPack 收得到千分位、百分数与一位小数', () => {
  const set = L.numbersFromPack({ clicks: 1200, ctr: 0.023, pos: 14.2 });
  assert.ok(set.has('1200'));
  assert.ok(set.has('1,200'));
  assert.ok(set.has('2.3%'));
  assert.ok(set.has('14.2'));
});
t('numbersFromPack 也收字符串里的数字', () => {
  const set = L.numbersFromPack({ label: '2026年8月（截至 22 日）' });
  assert.ok(set.has('2026'));
  assert.ok(set.has('22'));
});
t('checkNumbers 放行 pack 里的数字', () => {
  const set = L.numbersFromPack(fakePack());
  const res = L.checkNumbers('本期点击 1,200 次，访问 900 次，平均位次 14.2。', set);
  assert.strictEqual(res.ok, true, JSON.stringify(res.bad));
});
t('checkNumbers 抓出编造的数字', () => {
  const set = L.numbersFromPack(fakePack());
  const res = L.checkNumbers('本期点击 1,200 次，另有 7777 次未统计。', set);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.bad[0].token, '7777');
});
t('checkNumbers 不管单个数字', () => {
  const res = L.checkNumbers('我们做了 3 件事。', new Set());
  assert.strictEqual(res.ok, true);
});
t('checkNumbers 抓带小数点与百分号的编造值', () => {
  const set = L.numbersFromPack({ a: 10 });
  assert.strictEqual(L.checkNumbers('转化率 3.7%', set).ok, false);
});
t('problemList 拼得出可回喂的问题清单', () => {
  const lines = L.problemList(L.lintText('排名收紧了').hits, [{ token: '999', sample: 'x 999 y' }]);
  assert.ok(lines.length >= 2);
  assert.ok(lines.join('\n').indexOf('999') > -1);
});
t('validateNarrative 对干净叙事零问题', () => {
  const pack = fakePack();
  const problems = R2.validateNarrative(fakeNarrative(), L.numbersFromPack(pack));
  assert.deepStrictEqual(problems, [], problems.join(' | '));
});
t('validateNarrative 抓出禁词与编造数字', () => {
  const pack = fakePack();
  const bad = fakeNarrative();
  bad.ga4_sdesc = '排名收紧了，另有 8888 次访问。';
  const problems = R2.validateNarrative(bad, L.numbersFromPack(pack));
  assert.ok(problems.length >= 2, JSON.stringify(problems));
});
t('stripUnknownUrls 剔掉 pack 之外的路径', () => {
  const pack = fakePack();
  const n = fakeNarrative();
  R2.stripUnknownUrls(n, pack, null);
  assert.deepStrictEqual(n.next_items[0].urls, ['/curtains/']);
});

/* ---------- 渲染 ---------- */
section('渲染层');
t('带叙事渲染：无残留占位符且过 lint', () => {
  const pack = fakePack();
  const html = R.renderReport(pack, fakeNarrative(), {});
  assert.strictEqual(html.indexOf('{{'), -1, '不能留占位符');
  const res = L.lintReport(html);
  assert.strictEqual(res.ok, true, JSON.stringify(res.hits));
  assert.ok(html.indexOf('搜索点击与询盘同步走强') > -1, 'hero 标题要进页面');
  assert.ok(html.indexOf('noindex, nofollow') > -1, '必须带 robots 标记');
});
t('叙事为 null 时降级渲染仍然完整', () => {
  const pack = fakePack();
  const html = R.renderReport(pack, null, {});
  assert.strictEqual(html.indexOf('{{'), -1);
  const res = L.lintReport(html);
  assert.strictEqual(res.ok, true, JSON.stringify(res.hits));
  assert.ok(html.indexOf('Google Analytics 4') > -1, '降级要用固定的数据来源句');
  assert.ok(html.indexOf('首页精校') > -1, '降级要把原始工作条目直出');
  assert.ok(html.indexOf('站点健康检查') > -1, '降级要保留固定五槽');
});
t('hero KPI 按 narrative.hero_kpi_keys 取，位次变小写提升', () => {
  const pack = fakePack();
  const n = fakeNarrative();
  n.hero_kpi_keys = ['gsc_position', 'leads'];
  const cards = R.buildHeroKpis(pack, n);
  assert.strictEqual(cards.length, 4, '不够四个要用默认清单补齐');
  assert.strictEqual(cards[0].label, '搜索平均位次');
  assert.ok(cards[0].note.indexOf('提升') > -1, '位次变小写提升，实际写的是 ' + cards[0].note);
  assert.strictEqual(cards[0].note.indexOf('收紧'), -1);
});
t('hero KPI 挑到取不到数的键时自动跳过', () => {
  const pack = fakePack();
  pack.ga4.organic = { cur: null, prev: null, delta: null };
  const cards = R.buildHeroKpis(pack, { hero_kpi_keys: ['leads', 'gsc_clicks'] });
  assert.ok(cards.length >= 1);
  assert.strictEqual(cards.filter((c) => c.label === '自然搜索询盘').length, 0);
});
t('成对 callout 缺一条时两列降单列', () => {
  const pack = fakePack();
  const n = fakeNarrative();
  n.funnel_callouts = [n.funnel_callouts[0]];
  const html = R.renderReport(pack, n, {});
  assert.ok(html.indexOf('class="g1"') > -1, '只有一条 callout 时要降成单列');
});
t('一条 callout 都没有时不留空容器', () => {
  const pack = fakePack();
  const n = fakeNarrative();
  n.funnel_callouts = [];
  n.rankings_callouts = [];
  n.pages_callouts = [];
  const html = R.renderReport(pack, n, {});
  assert.strictEqual(html.indexOf('class="g2"'), -1);
});
t('趋势数据注入 chart_script', () => {
  const html = R.renderReport(fakePack(), null, {});
  assert.ok(html.indexOf('["2026-06","2026-07"]') > -1);
  assert.ok(html.indexOf('[800,900]') > -1);
});
t('趋势为空时不炸，注入空数组', () => {
  const pack = fakePack();
  pack.trend = { months: [], gsc_clicks: [], ga4_sessions_organic: [], last_partial: false };
  const html = R.renderReport(pack, null, {});
  assert.ok(html.indexOf('const monthsGG = [];') > -1);
  assert.ok(html.indexOf('待更新') > -1);
});
t('关键词表：无曝光写本月无曝光，不写 0', () => {
  const rows = R.buildKeywordRows(fakePack());
  const none = rows.filter((r) => r.keyword === 'blockout blinds')[0];
  assert.strictEqual(none.pos, '无曝光');
  assert.strictEqual(none.delta_text, '本月无曝光');
  const brand = rows[0];
  assert.strictEqual(brand.is_brand, true, '品牌词置顶');
});
t('页面表：上期无数据写新增与新进榜', () => {
  const rows = R.buildPageRows(fakePack());
  assert.strictEqual(rows[1].prev_sessions, '新增');
  assert.strictEqual(rows[1].delta, '新进榜');
});
t('漏斗三步加一行转化率，询盘数与 pack 一致', () => {
  const f = R.buildFunnel(fakePack());
  assert.strictEqual(f.steps.length, 3);
  assert.strictEqual(f.steps[2].value, '24');
  assert.strictEqual(f.rows.length, 4);
  assert.strictEqual(f.rows[3].metric, '访问到询盘转化率');
});
t('人工覆盖的询盘数会同时改漏斗底与封面，四处一致', () => {
  const pack = fakePack();
  pack.meta.leads_override = 31;
  const f = R.buildFunnel(pack);
  assert.strictEqual(f.steps[2].value, '31');
  const card = R.kpiCard(pack, 'leads');
  assert.strictEqual(card.value, '31');
});
t('渠道表列出访问、询盘与询盘占比，合计取渠道行', () => {
  const c = R.buildChannelRows(fakePack());
  assert.strictEqual(c.total_sessions, '1,000');
  assert.strictEqual(c.total_leads, '26');
  assert.ok(c.rows[0].leads_share.indexOf('%') > -1);
});
t('金额格式恒两位小数', () => {
  assert.strictEqual(R.fmtMoney(3054.5), '3,054.50');
  assert.strictEqual(R.fmtMoney(0), '0.00');
});
t('数量环比在上期为 0 时写绝对量不写百分比', () => {
  assert.strictEqual(R.deltaCount(5, 0).text, '新增 5');
  assert.strictEqual(R.deltaCount(0, 0).text, '持平');
});
t('位次环比一律写提升或回落', () => {
  assert.ok(R.deltaPosition(8.2, 9.9).text.indexOf('提升') > -1);
  assert.ok(R.deltaPosition(12, 9).text.indexOf('回落') > -1);
  assert.strictEqual(R.deltaPosition(9, 9).text, '基本持平');
});
t('模板注释不进成品，section 标记保留', () => {
  const html = R.renderReport(fakePack(), null, {});
  assert.ok(html.indexOf('<!-- section:ga4 -->') > -1, 'section 标记要留着');
  assert.strictEqual(html.indexOf('row:callout'), -1, '内部注释不该出现在客户面成品里');
  const beforeHtml = html.slice(0, html.indexOf('<html')).trim();
  assert.strictEqual(beforeHtml, '<!DOCTYPE html>', '<html> 之前只能有 DOCTYPE，头部说明注释一个字都不能漏出来');
});
t('模板引擎的循环、条件与反向条件', () => {
  const out = R.renderTemplate('{{#list}}[{{v}}{{#f}}!{{/f}}{{^f}}?{{/f}}]{{/list}}', { list: [{ v: 'a', f: true }, { v: 'b', f: false }] });
  assert.strictEqual(out, '[a!][b?]');
});
t('模板块不配对直接抛错', () => {
  assert.throws(() => R.renderTemplate('{{#a}}x{{/b}}', {}), /不配对/);
});
t('未闭合的块直接抛错', () => {
  assert.throws(() => R.renderTemplate('{{#a}}x', {}), /未闭合/);
});
t('渲染后仍有占位符会抛错', () => {
  assert.throws(() => R.renderReport(fakePack(), null, { template: '<p>{{never_defined_marker}}</p>{{' }), /未替换的占位符/);
});
t('pack 缺 meta 直接抛错', () => {
  assert.throws(() => R.renderReport({}, null, {}), /没有 meta/);
});

/* ---------- 发布层 ---------- */
section('发布层');
t('slug 与文件名只放白名单字符', () => {
  assert.strictEqual(P.assertSafeName('benscurtains', 'slug'), 'benscurtains');
  assert.strictEqual(P.assertSafeName('seo_report_2026-08_v1.html', '文件名'), 'seo_report_2026-08_v1.html');
  assert.throws(() => P.assertSafeName('a; rm -rf /', 'slug'), /不安全/);
  assert.throws(() => P.assertSafeName('', 'slug'), /不安全/);
  assert.throws(() => P.assertSafeName('../etc/passwd', 'slug'), /不安全/);
});
t('publishReport 三步命令与返回值（mock 掉 ssh 与 scp）', () => {
  const cp = require('node:child_process');
  const real = cp.execFile;
  const calls = [];
  cp.execFile = function (bin, args, opts, cb) {
    calls.push(bin + ' ' + args.join(' '));
    cb(null, '', '');
  };
  const cfg = {
    reportSsh: 'blogpreview',
    reportRemoteRoot: '/www/wwwroot/blogpreview.horntech-dev.com/reports',
    reportUrlBase: 'https://agencyreport.horntech-dev.com/reports',
  };
  let res = null;
  const done = P.publishReport(cfg, 'demo', 'seo_report_2026-07_v1.html', '/tmp/x.html', null).then((r) => {
    res = r;
  });
  return done.then(() => {
    cp.execFile = real;
    assert.strictEqual(calls.length, 3);
    assert.ok(calls[0].indexOf('mkdir -p') > -1 && calls[0].indexOf('chmod 755') > -1);
    assert.ok(calls[1].indexOf('scp') === 0);
    assert.ok(calls[2].indexOf('chmod 644') > -1);
    assert.strictEqual(res.url, 'https://agencyreport.horntech-dev.com/reports/demo/seo_report_2026-07_v1.html');
    assert.strictEqual(res.remotePath, '/www/wwwroot/blogpreview.horntech-dev.com/reports/demo/seo_report_2026-07_v1.html');
  });
});

/* ---------- 配置与接线 ---------- */
section('配置与接线');
t('报告相关的 config 键都有默认值', () => {
  const d = cfgmod.DEFAULTS;
  assert.strictEqual(d.reportModel, 'opus');
  assert.strictEqual(d.reportSsh, 'blogpreview');
  assert.strictEqual(d.reportTimeoutMin, 45);
  assert.ok(d.reportRemoteRoot.indexOf('/reports') > -1);
  assert.ok(d.reportUrlBase.indexOf('agencyreport') > -1, '对外链接必须走 agencyreport 域名');
});
t('listener 对 type=report 单独取超时', () => {
  const src = require('fs').readFileSync(path.join(W, 'listener.js'), 'utf8');
  assert.ok(/job\.type === 'report' \? cfg\.reportTimeoutMin : cfg\.jobTimeoutMin/.test(src));
});
t('api 有报告要用的五个方法', () => {
  const { Api } = require(path.join(W, 'lib', 'api'));
  for (const m of ['postReport', 'listReports', 'getMetrics', 'getEvents', 'getTasks']) {
    assert.strictEqual(typeof Api.prototype[m], 'function', '缺方法 ' + m);
  }
});
t('runner 导出 run 且 prompt 带铁律与 DATA PACK', () => {
  assert.strictEqual(typeof R2.run, 'function');
  const prompt = R2.buildPrompt(fakePack());
  assert.ok(prompt.indexOf('铁律') > -1);
  assert.ok(prompt.indexOf('DATA PACK') > -1);
  assert.ok(prompt.indexOf('allowed_kpi_keys') > -1);
  assert.ok(prompt.indexOf('只回一个 json 代码块') > -1);
});
t('月中出报的 prompt 会要求标注截至第几日', () => {
  const pack = fakePack();
  pack.meta.period = { type: 'month', start: '2026-08-01', end: '2026-08-22', label: '2026年8月（截至 22 日）', short: '8月', partial: true, through_day: 22 };
  const prompt = R2.buildPrompt(pack);
  assert.ok(prompt.indexOf('截至 22 日，本月尚未结束') > -1);
});
t('喂给模型的 pack 不含内部追溯字段', () => {
  const p = R2.packForPrompt(fakePack());
  assert.strictEqual(p.pack_inputs, undefined);
});

Promise.all(pending).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
