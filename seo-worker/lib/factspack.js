'use strict';
// 报告数据层：零 LLM，所有数字只在这里产生。
//
// 契约在 specs/report/facts_pack.schema.md，这个文件是它唯一的实现。
// 分工与 lib/metrics.js 一致：带 ctx 的 async 函数负责对外拉数，
// 其余全是纯函数，进出都是普通对象，单测只测纯函数那一半。
//
// 三条硬口径，改之前先读懂：
//   1. 缺的数据一律 null 并进 gaps，绝不估算。报告里写「待更新」比写个
//      看起来合理的数字安全得多。
//   2. 位次变小是好事。delta = cur - prev，负数代表提升，渲染层据此写
//      「提升 N 位」，绝不写「收紧」。
//   3. 渠道合计用渠道行相加，不用 GA4 的 overall 节点。overall 在几个客户
//      身上偶发虚高，渠道级汇总才对得上账。

const fs = require('node:fs');
const path = require('node:path');

const {
  gscQuery,
  ga4Report,
  spamFilterGroups,
  LEAD_EVENTS,
  ORGANIC_CHANNEL,
  deriveBrandRegex,
} = require('./metrics');
const { factLines } = require('./distill');
const { truncate } = require('./util');

// GSC 单次现拉的行数。query 维度一个自然月通常几百到两三千行，5000 够用，
// 再大就该分段翻页了，那是 pull_data 的活，报告不需要。
const GSC_ROW_LIMIT = 5000;
// 落地页与目标词表在报告里各露几行。
const TOP_QUERIES = 20;
const TOP_PAGES = 10;
// 趋势图往前看多少个月。
const TREND_MONTHS = 13;
// 渠道占比低于这个数且属于可合并类别的，并进「其他」。
const CHANNEL_MERGE_SHARE = 0.05;
// facts 进 prompt 的条数与单条长度。
const FACTS_LIMIT = 60;
const FACT_VALUE_CHARS = 400;

// 名字里带这些词的渠道，量小的时候可以并进「其他」。
// 自然搜索、直接访问、付费搜索永远单列，它们是报告要讲的主角。
const MERGEABLE_CHANNEL_WORDS = ['social', 'email', 'referral', 'unassigned', 'display', 'audio', 'video', 'sms', 'push', 'affiliate'];

// 工作量分类关键词，出处 facts_pack.schema.md 的计算规则。
const WORK_CATEGORIES = [
  ['tech', ['301', 'sitemap', 'schema', '收录', '审计', 'redirect', '索引', '抓取', 'audit', 'canonical', '重定向', '结构化数据']],
  ['link', ['外链', 'backlink', 'disavow', '引荐域', '布点', 'outreach']],
  ['ads', ['广告', '否定词', '否定关键词', 'campaign', 'brand search', 'pmax', 'performance max', '出价', '投放', 'negative keyword', 'google ads']],
  ['content', ['博客', '文章', '选题', 'blog', 'article', '改写', 'refresh']],
  ['onpage', ['title', 'meta', '内链', '页面优化', '精校', '重写', 'page', '标题', '描述', '集合页', '产品页', 'pageopt']],
  ['report', ['报告', '分析', '数据', '清单', '月报', '交付']],
];

// ---------------------------------------------------------------------------
// 纯函数：日期与周期
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' -> {y,m,d}，格式不对返回 null。 */
function splitYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 该月最后一天的日号。 */
function daysInMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 任意日期 -> 当月 1 号。 */
function monthStartOf(s) {
  const p = splitYmd(s);
  if (!p) return null;
  return p.y + '-' + pad2(p.m) + '-01';
}

/** 任意日期 -> 当月最后一天。 */
function monthEndOf(s) {
  const p = splitYmd(s);
  if (!p) return null;
  return p.y + '-' + pad2(p.m) + '-' + pad2(daysInMonth(p.y, p.m));
}

/** 月份平移，日号会被压到目标月的最后一天（1 月 31 日往前一个月得到 12 月 31 日）。 */
function addMonths(s, n) {
  const p = splitYmd(s);
  if (!p) return null;
  let y = p.y;
  let m = p.m + n;
  while (m > 12) {
    m -= 12;
    y += 1;
  }
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  const d = Math.min(p.d, daysInMonth(y, m));
  return y + '-' + pad2(m) + '-' + pad2(d);
}

/** 日期加减天数。 */
function addDays(s, n) {
  const p = splitYmd(s);
  if (!p) return null;
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' -> 'YYYY-MM'。 */
function ymOf(s) {
  return String(s || '').slice(0, 7);
}

/** 从 endYm 往回数 n 个月，返回 ['2025-08', ... , endYm]，正序。 */
function monthsBack(endYm, n) {
  const out = [];
  let cur = String(endYm || '') + '-01';
  for (let i = 0; i < n; i++) {
    out.unshift(ymOf(cur));
    cur = addMonths(cur, -1);
  }
  return out;
}

/**
 * 算出本期与对比期。
 * opts: { type, start, end, today, lagDays }
 *   start 必填，月初；end 可省，省了就取「月末」与「今天减 lagDays」里较早的那个。
 * 返回 { type, start, end, label, short, partial, through_day,
 *        compare: { start, end, label, short } }
 * 规则出处 README.md 周期规则：整月对上一个完整月，月中出报对上月同窗，
 * 且全文要标「截至 N 日，本月尚未结束」，不做同比。
 */
function computePeriod(opts) {
  const o = opts || {};
  const type = o.type || 'month';
  const start = monthStartOf(o.start) || o.start;
  const p = splitYmd(start);
  if (!p) throw new Error('computePeriod 拿到的 period_start 不是 YYYY-MM-DD：' + o.start);
  const mEnd = monthEndOf(start);
  const lag = Number.isFinite(Number(o.lagDays)) ? Number(o.lagDays) : 3;
  const today = o.today || new Date().toISOString().slice(0, 10);
  const lagged = addDays(today, -lag);

  // 不管有没有显式给 end，都要夹到「今天减延迟天数」：GSC 最近几天没数据，
  // 传月末进来照拉会把 22 天当 31 天比，环比全是假下滑（2026-08-25 v1 踩过）。
  let end = o.end ? String(o.end) : mEnd;
  if (end > lagged) end = lagged;
  if (end > mEnd) end = mEnd;
  if (end < start) end = start;

  const endParts = splitYmd(end);
  const partial = end < mEnd;
  const throughDay = partial ? endParts.d : null;

  const short = p.m + '月';
  const label = p.y + '年' + p.m + '月' + (partial ? '（截至 ' + throughDay + ' 日）' : '（全月）');

  const prevStart = addMonths(start, -1);
  const prevParts = splitYmd(prevStart);
  const prevMonthEnd = monthEndOf(prevStart);
  let prevEnd = prevMonthEnd;
  if (partial) {
    const want = prevParts.y + '-' + pad2(prevParts.m) + '-' + pad2(Math.min(throughDay, daysInMonth(prevParts.y, prevParts.m)));
    prevEnd = want;
  }
  const prevShort = prevParts.m + '月';
  const prevLabel = partial
    ? 'vs ' + prevShort + '同期（1 日至 ' + splitYmd(prevEnd).d + ' 日）'
    : 'vs ' + prevShort + '（全月）';

  return {
    type,
    start,
    end,
    label,
    short,
    partial,
    through_day: throughDay,
    compare: { start: prevStart, end: prevEnd, label: prevLabel, short: prevShort },
  };
}

/**
 * 同比周期：去年同一个自然月。只对整月报告成立，月中出报的契约是
 * 只与上月同窗环比、不做同比（README 周期规则），传 partial 进来返回 null。
 */
function yoyPeriodOf(per) {
  if (!per || per.partial) return null;
  const start = addMonths(per.start, -12);
  if (!start) return null;
  const p = splitYmd(start);
  return {
    start,
    end: monthEndOf(start),
    label: p.y + '年' + p.m + '月（全月）',
    short: '去年' + p.m + '月',
  };
}

// ---------------------------------------------------------------------------
// 纯函数：环比
// ---------------------------------------------------------------------------

/**
 * 数值化。null、undefined、空串一律当缺失（NaN），不当成 0：
 * Number(null) 是 0，直接用会把「没这个数」和「这个数是零」混成一件事。
 */
function num(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * 环比。prev 为 0 或缺失时返回 null，不返回 Infinity 也不当成 100%。
 * 「从 0 涨到 5」这件事没有百分比可言，报告里要写绝对量。
 */
function pctDelta(cur, prev) {
  const c = num(cur);
  const p = num(prev);
  if (!Number.isFinite(c) || !Number.isFinite(p)) return null;
  if (p === 0) return null;
  return (c - p) / p;
}

/** 绝对差。任一侧缺失返回 null。 */
function absDelta(cur, prev) {
  const c = num(cur);
  const p = num(prev);
  if (!Number.isFinite(c) || !Number.isFinite(p)) return null;
  return c - p;
}

/** 位次差。负数是提升。 */
function posDelta(cur, prev) {
  return absDelta(cur, prev);
}

/** 百分点差（CTR 这类本身就是比例的指标用它，不用环比）。 */
function ppDelta(cur, prev) {
  const d = absDelta(cur, prev);
  return d === null ? null : d * 100;
}

// ---------------------------------------------------------------------------
// 纯函数：查询归一化与目标词簇
// ---------------------------------------------------------------------------

/**
 * 查询归一化：小写、连字符与下划线与斜杠当空格、丢掉其余标点、压缩空白。
 * 中日韩字符原样保留，别的语言的报告也能用同一套。
 */
function normalizeQuery(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[\-_/\\]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 归一化后按空格切 token，空串返回空数组。 */
function queryTokens(s) {
  const n = normalizeQuery(s);
  return n ? n.split(' ') : [];
}

/**
 * 目标词的查询簇加权位次。
 * 簇 = 归一化后包含该词全部 token 的查询（token 用包含匹配，这样单复数
 * 与词尾变化不会把簇切碎）。位次 = Σ(position × impressions) / Σ(impressions)。
 * 簇零曝光时 pos 为 null，渲染层写「本月无曝光」，绝不写 0。
 * rows: [{ query, clicks, impressions, position }]
 */
function clusterWeightedPosition(rows, keyword) {
  const tokens = queryTokens(keyword);
  const out = { pos: null, impressions: 0, clicks: 0, matched: 0 };
  if (!tokens.length) return out;
  let weighted = 0;
  for (const r of rows || []) {
    const q = normalizeQuery(r && r.query);
    if (!q) continue;
    let all = true;
    for (const t of tokens) {
      if (q.indexOf(t) === -1) {
        all = false;
        break;
      }
    }
    if (!all) continue;
    const imp = Number(r.impressions) || 0;
    const pos = Number(r.position);
    out.matched += 1;
    out.impressions += imp;
    out.clicks += Number(r.clicks) || 0;
    if (Number.isFinite(pos) && imp > 0) weighted += pos * imp;
  }
  if (out.impressions > 0) out.pos = round1(weighted / out.impressions);
  return out;
}

/**
 * 目标词按位次分档计数。field 传 'prev' 时按 prev_pos 分档，
 * 给排名分布图的两期对照用。rows 是 rankings.rows 形状的数组。
 */
function bandCounts(rows, field) {
  const out = { top10: 0, p11_20: 0, p21_plus: 0, none: 0 };
  for (const r of rows || []) {
    out[rankBand(field === 'prev' ? r && r.prev_pos : r && r.pos)] += 1;
  }
  return out;
}

/** 位次分档。null 一律 none，渲染层据此走「本月无曝光」那一支。 */
function rankBand(pos) {
  const p = Number(pos);
  if (!Number.isFinite(p) || p <= 0) return 'none';
  if (p <= 10) return 'top10';
  if (p <= 20) return 'p11_20';
  return 'p21_plus';
}

// round 系列对 null 必须回 null：Number(null) 是 0，不挡的话
// 「pctDelta 上期为 0 回 null」会被静默改写成 0，把「没有百分比可言」
// 变成「零变化」（2026-09-01 powerdekor v2 的 yoy.leads_pct 踩到）。
function round1(n) {
  if (n === null || n === undefined || n === '') return null;
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}

function round2(n) {
  if (n === null || n === undefined || n === '') return null;
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

function round4(n) {
  if (n === null || n === undefined || n === '') return null;
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null;
}

/** 环比比例统一保留三位小数（即百分数一位小数），叙事与 KPI 卡才不会一个写 11.69% 一个写 11.7%。 */
function round3(n) {
  if (n === null || n === undefined || n === '') return null;
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
}

// ---------------------------------------------------------------------------
// 纯函数：工作量分类
// ---------------------------------------------------------------------------

/**
 * 一条任务或大事记归到哪个分类。匹配顺序是固定的：
 * tech 与 link 的词最专，先判；content 与 onpage 有交叠（「改写」既像内容
 * 又像页面），按 schema 的清单，博客类归 content；report 兜底。
 * 一个都不沾返回 null，调用方决定是丢弃还是归 report。
 */
function classifyWork(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  if (!s.trim()) return null;
  for (const [cat, words] of WORK_CATEGORIES) {
    for (const w of words) {
      if (s.indexOf(w) !== -1) return cat;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 纯函数：渠道合并
// ---------------------------------------------------------------------------

function isOrganicChannel(name) {
  return String(name || '').trim().toLowerCase() === ORGANIC_CHANNEL;
}

function isMergeableChannel(name) {
  const s = String(name || '').toLowerCase();
  return MERGEABLE_CHANNEL_WORDS.some((w) => s.indexOf(w) !== -1);
}

/**
 * 渠道表。入参是已经按渠道汇好的两期数据：
 *   cur / prev: [{ channel, sessions, leads, revenue }]
 * 规则：按本期 sessions 降序；Social、Email、Referral、Unassigned、Display
 * 这类渠道各自占比低于 5% 时并成一行「其他」放末尾；合计用渠道行相加。
 * 返回 { channels, total }。
 */
function mergeChannels(cur, prev) {
  const prevMap = new Map();
  for (const r of prev || []) prevMap.set(String(r.channel || ''), r);
  const rows = (cur || []).map((r) => {
    const p = prevMap.get(String(r.channel || '')) || {};
    return {
      channel: String(r.channel || '(未分类)'),
      sessions: Number(r.sessions) || 0,
      prev_sessions: Number(p.sessions) || 0,
      leads: Number(r.leads) || 0,
      prev_leads: Number(p.leads) || 0,
      revenue: r.revenue === null || r.revenue === undefined ? null : Number(r.revenue),
      prev_revenue: p.revenue === null || p.revenue === undefined ? null : Number(p.revenue),
      is_organic: isOrganicChannel(r.channel),
    };
  });
  // 只在本期出现过的渠道之外，把上期有本期没有的渠道也补进来，否则
  // 「上月还有 300 访问的渠道本月归零」这件事会在表里彻底消失。
  for (const [name, p] of prevMap.entries()) {
    if (rows.some((r) => r.channel === name)) continue;
    rows.push({
      channel: name || '(未分类)',
      sessions: 0,
      prev_sessions: Number(p.sessions) || 0,
      leads: 0,
      prev_leads: Number(p.leads) || 0,
      revenue: p.revenue === null || p.revenue === undefined ? null : 0,
      prev_revenue: p.revenue === null || p.revenue === undefined ? null : Number(p.revenue),
      is_organic: isOrganicChannel(name),
    });
  }

  const totalSessions = rows.reduce((a, r) => a + r.sessions, 0);
  const keep = [];
  const merge = [];
  for (const r of rows) {
    const share = totalSessions > 0 ? r.sessions / totalSessions : 0;
    if (!r.is_organic && isMergeableChannel(r.channel) && share < CHANNEL_MERGE_SHARE) merge.push(r);
    else keep.push(r);
  }
  keep.sort((a, b) => b.sessions - a.sessions);

  const out = keep.map((r) =>
    Object.assign({}, r, {
      share: totalSessions > 0 ? round4(r.sessions / totalSessions) : null,
      is_muted: false,
    })
  );
  if (merge.length) {
    const agg = merge.reduce(
      (a, r) => {
        a.sessions += r.sessions;
        a.prev_sessions += r.prev_sessions;
        a.leads += r.leads;
        a.prev_leads += r.prev_leads;
        if (r.revenue !== null) a.revenue = (a.revenue || 0) + r.revenue;
        if (r.prev_revenue !== null) a.prev_revenue = (a.prev_revenue || 0) + r.prev_revenue;
        return a;
      },
      { sessions: 0, prev_sessions: 0, leads: 0, prev_leads: 0, revenue: null, prev_revenue: null }
    );
    out.push({
      channel: '其他',
      sessions: agg.sessions,
      prev_sessions: agg.prev_sessions,
      leads: agg.leads,
      prev_leads: agg.prev_leads,
      revenue: agg.revenue,
      prev_revenue: agg.prev_revenue,
      is_organic: false,
      share: totalSessions > 0 ? round4(agg.sessions / totalSessions) : null,
      is_muted: true,
      merged_from: merge.map((r) => r.channel),
    });
  }

  const total = out.reduce(
    (a, r) => {
      a.sessions += r.sessions;
      a.prev_sessions += r.prev_sessions;
      a.leads += r.leads;
      a.prev_leads += r.prev_leads;
      if (r.revenue !== null) a.revenue = (a.revenue || 0) + r.revenue;
      if (r.prev_revenue !== null) a.prev_revenue = (a.prev_revenue || 0) + r.prev_revenue;
      return a;
    },
    { sessions: 0, prev_sessions: 0, leads: 0, prev_leads: 0, revenue: null, prev_revenue: null }
  );

  return { channels: out, total };
}

// ---------------------------------------------------------------------------
// 纯函数：时序按月聚合
// ---------------------------------------------------------------------------

/**
 * GET /metrics 的一条序列（[{d,v}]）按自然月求和。
 * 缺的日子服务端不补零，这里也不补：一个月只要有数据就出一个点。
 * 返回 Map<'YYYY-MM', number>。
 */
function monthlySum(series) {
  const out = new Map();
  for (const row of series || []) {
    const d = String((row && row.d) || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const key = d.slice(0, 7);
    out.set(key, (out.get(key) || 0) + (Number(row.v) || 0));
  }
  return out;
}

/**
 * 趋势块。months 是要出的月份清单（正序），没数据的月给 0，
 * 这样柱状图不会因为缺一个月而错位。
 * metrics: GET /metrics 的 metrics 字段。
 */
function buildTrend(metrics, months, lastPartial) {
  const m = metrics || {};
  const clicks = monthlySum(m.gsc_clicks);
  const sessions = monthlySum(m.ga4_sessions_organic);
  return {
    months: months.slice(),
    gsc_clicks: months.map((k) => clicks.get(k) || 0),
    ga4_sessions_organic: months.map((k) => sessions.get(k) || 0),
    last_partial: !!lastPartial,
  };
}

// ---------------------------------------------------------------------------
// 纯函数：客户面 facts
// ---------------------------------------------------------------------------

/**
 * 进 prompt 的客户事实。internal.* 一律不给模型看，过滤发生在 60 条
 * 上限之前（见 distill.factLines 的注释）。返回 ['key: value', ...]。
 */
function factsForPrompt(context) {
  const facts = (context && context.facts) || {};
  const confirmed = Array.isArray(facts.confirmed) ? facts.confirmed : [];
  const pending = Array.isArray(facts.pending) ? facts.pending : [];
  const text = factLines(confirmed.concat(pending), FACTS_LIMIT, {
    excludePrefixes: ['internal.'],
  });
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(/^-\s*/, '').trim())
    .filter((l) => l.length > 0)
    .map((l) => truncate(l, FACT_VALUE_CHARS + 80));
}

/**
 * 客户类型。顺序照 README：facts 里明说不是电商就 leadgen，
 * GA4 有成交计数就 ecommerce，其余 leadgen。
 */
function inferBizType(factLinesArr, purchases) {
  const blob = (factLinesArr || []).join('\n').toLowerCase();
  if (/biz\.model/.test(blob) && /(不是电商|非电商|lead|询盘|服务型)/.test(blob)) return 'leadgen';
  if (Number(purchases) > 0) return 'ecommerce';
  return 'leadgen';
}

/** instructions 里的人工覆盖：「询盘总数按后台实收 12」。 */
function parseLeadsOverride(instructions) {
  const m = /询盘(?:总数)?[^0-9]{0,12}?实收[^0-9]{0,6}(\d+)/.exec(String(instructions || ''));
  if (m) return Number(m[1]);
  return null;
}

// ---------------------------------------------------------------------------
// 取数：GSC
// ---------------------------------------------------------------------------

/**
 * 反垃圾正则只能用「先取全量再减去垃圾」的方式扣，不能直接挂到汇总查询上。
 *
 * GSC 把曝光过低的查询匿名化，匿名行没有 query 维度值，所以任何挂在 query 上的
 * 过滤器（哪怕是 excludingRegex）都会连带把这批行整个排除掉。小站上匿名查询占
 * 一半以上，结果就是汇总数字被腰斩。实测 kuddles 2026 年 8 月：不挂过滤器
 * 102 点击 / 2723 曝光，挂上 metrics.spamFilterGroups 只剩 45 / 1339。
 *
 * 正确口径：全量查一次，垃圾词用 includingRegex 单独查一次，两者相减。
 * 位次是按曝光加权的均值，所以扣除后要按曝光重新加权。
 */
function spamIncludeGroups(regex) {
  if (!regex) return undefined;
  return [
    {
      groupType: 'and',
      filters: [{ dimension: 'query', operator: 'includingRegex', expression: regex }],
    },
  ];
}

function subtractSpamTotals(all, spam) {
  const impressions = all.impressions - spam.impressions;
  const clicks = all.clicks - spam.clicks;
  if (!(impressions > 0) || !(clicks >= 0)) return all;
  const weighted = all.position * all.impressions - spam.position * spam.impressions;
  return {
    clicks,
    impressions,
    ctr: round4(clicks / impressions),
    position: round1(weighted / impressions),
  };
}

async function gscTotals(cfg, property, range, spamRegex) {
  const read = async (groups) => {
    const res = await gscQuery(cfg, property, {
      startDate: range.start,
      endDate: range.end,
      dimensions: [],
      dimensionFilterGroups: groups,
      rowLimit: 1,
    });
    const row = ((res && res.rows) || [])[0] || {};
    return {
      clicks: Number(row.clicks) || 0,
      impressions: Number(row.impressions) || 0,
      ctr: round4(row.ctr) || 0,
      position: round1(row.position) || 0,
    };
  };
  const all = await read(undefined);
  if (!spamRegex) return all;
  const spam = await read(spamIncludeGroups(spamRegex));
  if (!(spam.impressions > 0)) return all;
  return subtractSpamTotals(all, spam);
}

async function gscByDimension(cfg, property, range, dimension, spamRegex) {
  // query 维度本来就不含匿名行，excludingRegex 在这里是安全且直接的。
  // 其余维度（page）要走全量减垃圾，否则同样丢掉匿名查询贡献的那一半。
  const onQuery = dimension === 'query';
  const read = async (groups) => {
    const res = await gscQuery(cfg, property, {
      startDate: range.start,
      endDate: range.end,
      dimensions: [dimension],
      dimensionFilterGroups: groups,
      rowLimit: GSC_ROW_LIMIT,
    });
    return ((res && res.rows) || []).map((r) => ({
      key: String((r.keys || [])[0] || ''),
      query: String((r.keys || [])[0] || ''),
      page: String((r.keys || [])[0] || ''),
      clicks: Number(r.clicks) || 0,
      impressions: Number(r.impressions) || 0,
      ctr: Number(r.ctr) || 0,
      position: Number(r.position) || 0,
    }));
  };
  if (onQuery) return read(spamFilterGroups(spamRegex));
  const all = await read(undefined);
  if (!spamRegex) return all;
  const spam = await read(spamIncludeGroups(spamRegex));
  if (!spam.length) return all;
  const spamByKey = new Map(spam.map((r) => [r.key, r]));
  return all
    .map((r) => {
      const s = spamByKey.get(r.key);
      if (!s) return r;
      const t = subtractSpamTotals(r, s);
      return { ...r, clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, position: t.position };
    })
    .filter((r) => r.impressions > 0 || r.clicks > 0);
}

// ---------------------------------------------------------------------------
// 周期覆盖天数：环比能不能按总量说
// ---------------------------------------------------------------------------

/**
 * 一个周期里两个数据源各自真的有几天数据。
 *
 * 新站或刚接入数据源的客户，GSC 与 GA4 的起始日往往还不一样（kuddles：GSC 从
 * 2026-07-11 回填、GA4 从 07-13 开始收），拿这种残月当环比基数会把「本月涨了
 * 24%」写进客户报告，按日均算其实是跌的。这里只负责把天数摆出来，怎么措辞交给
 * 叙事层，但覆盖不足会进 gaps，报告里就不会假装那是个完整的对比期。
 */
function spanDays(range) {
  const a = Date.parse(String(range.start) + 'T00:00:00Z');
  const b = Date.parse(String(range.end) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

const COVERAGE_MIN_RATIO = 0.9;

function buildCoverage(range, days) {
  const span = spanDays(range);
  const d = Number(days) || 0;
  return {
    days: d,
    span,
    ratio: span > 0 ? round3(d / span) : null,
    short: span > 0 && d < Math.ceil(span * COVERAGE_MIN_RATIO),
  };
}

async function gscDayCount(cfg, property, range) {
  const res = await gscQuery(cfg, property, {
    startDate: range.start,
    endDate: range.end,
    dimensions: ['date'],
    rowLimit: 1000,
  });
  return ((res && res.rows) || []).length;
}

async function ga4DayCount(ctx, propertyId, range) {
  const rows = await ga4Report(ctx, propertyId, {
    dateRanges: [{ startDate: range.start, endDate: range.end }],
    dimensions: [{ name: 'date' }],
    metrics: [{ name: 'sessions' }],
  });
  return rows.filter((r) => (Number(r.sessions) || 0) > 0).length;
}

function coverageGaps(source, per, cur, prev) {
  const out = [];
  const shape = (c) => c.days + ' 天数据，周期本身 ' + c.span + ' 天';
  if (cur && cur.short) {
    out.push(source + ' 本期（' + per.label + '）只有 ' + shape(cur) + '，本期总量并非整周期口径');
  }
  if (prev && prev.short) {
    out.push(
      source +
        ' 对比期（' +
        per.compare.label +
        '）只有 ' +
        shape(prev) +
        '，' +
        source +
        ' 的总量环比会虚高，点击、曝光、会话一类的环比必须改用日均口径，并在报告里写明对比期缺天数'
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// 取数：GA4
// ---------------------------------------------------------------------------

async function ga4Channels(ctx, propertyId, range) {
  const rows = await ga4Report(ctx, propertyId, {
    dateRanges: [{ startDate: range.start, endDate: range.end }],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }, { name: 'newUsers' }],
  });
  return rows.map((r) => ({
    channel: String(r.sessionDefaultChannelGroup || ''),
    sessions: Number(r.sessions) || 0,
    new_users: Number(r.newUsers) || 0,
  }));
}

/** 渠道 x 事件的次数。用来同时得到分渠道询盘数与自然搜索的表单开始数。 */
async function ga4ChannelEvents(ctx, propertyId, range, eventNames) {
  const rows = await ga4Report(ctx, propertyId, {
    dateRanges: [{ startDate: range.start, endDate: range.end }],
    dimensions: [{ name: 'sessionDefaultChannelGroup' }, { name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        inListFilter: { values: eventNames, caseSensitive: true },
      },
    },
  });
  return rows.map((r) => ({
    channel: String(r.sessionDefaultChannelGroup || ''),
    event: String(r.eventName || ''),
    count: Number(r.eventCount) || 0,
  }));
}

async function ga4LandingPages(ctx, propertyId, range) {
  const rows = await ga4Report(ctx, propertyId, {
    dateRanges: [{ startDate: range.start, endDate: range.end }],
    dimensions: [{ name: 'landingPagePlusQueryString' }, { name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }],
  });
  const byPath = new Map();
  for (const r of rows) {
    if (!isOrganicChannel(r.sessionDefaultChannelGroup)) continue;
    const p = String(r.landingPagePlusQueryString || '');
    if (!p) continue;
    byPath.set(p, (byPath.get(p) || 0) + (Number(r.sessions) || 0));
  }
  return Array.from(byPath.entries())
    .map(([p, sessions]) => ({ path: p, sessions }))
    .sort((a, b) => b.sessions - a.sessions);
}

/** 电商四件套。属性没开电商上报时 GA4 会直接报错，这里吞掉并回 null。 */
async function ga4Ecommerce(ctx, propertyId, range, log) {
  try {
    const rows = await ga4Report(ctx, propertyId, {
      dateRanges: [{ startDate: range.start, endDate: range.end }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [
        { name: 'addToCarts' },
        { name: 'checkouts' },
        { name: 'ecommercePurchases' },
        { name: 'purchaseRevenue' },
      ],
    });
    const all = { add_to_carts: 0, checkouts: 0, purchases: 0, revenue: 0 };
    const organic = { add_to_carts: 0, checkouts: 0, purchases: 0, revenue: 0 };
    for (const r of rows) {
      const bucket = isOrganicChannel(r.sessionDefaultChannelGroup) ? organic : null;
      const add = Number(r.addToCarts) || 0;
      const co = Number(r.checkouts) || 0;
      const pu = Number(r.ecommercePurchases) || 0;
      const rev = Number(r.purchaseRevenue) || 0;
      all.add_to_carts += add;
      all.checkouts += co;
      all.purchases += pu;
      all.revenue += rev;
      if (bucket) {
        bucket.add_to_carts += add;
        bucket.checkouts += co;
        bucket.purchases += pu;
        bucket.revenue += rev;
      }
    }
    all.revenue = round2(all.revenue);
    organic.revenue = round2(organic.revenue);
    return { all, organic };
  } catch (e) {
    if (log) log('ga4 电商指标取不到（多半是该属性未上报电商事件），本期按非电商处理：' + e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 取数：工作量
// ---------------------------------------------------------------------------

/** 一条任务的完成时间，尽量取能拿到的最准的那个。 */
function taskDoneDate(task) {
  const raw = (task && (task.completed_at || task.updated_at || task.created_at)) || '';
  const s = String(raw).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function inRange(d, range) {
  return !!d && d >= range.start && d <= range.end;
}

/**
 * 扫工作区里本期产出的交付文件数。
 * seo-agent-output/task-{id}/ 一个目录对应一个任务，顶层文件计数即可，
 * 不递归也不读内容：这里只需要「做了几件」这个量。
 */
function countTaskOutputs(workspace, taskIds) {
  const out = new Map();
  if (!workspace) return out;
  const base = path.join(workspace, 'seo-agent-output');
  let entries = [];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (e) {
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const m = /^task-(\d+)$/.exec(ent.name);
    if (!m) continue;
    const id = Number(m[1]);
    if (taskIds && taskIds.size && !taskIds.has(id)) continue;
    let files = [];
    try {
      files = fs.readdirSync(path.join(base, ent.name), { withFileTypes: true });
    } catch (e) {
      continue;
    }
    out.set(id, files.filter((f) => f.isFile()).length);
  }
  return out;
}

/**
 * 本期工作量。三个来源合并：
 *   context.tasks 里本期完成的任务、GET /events 的动作标注、工作区交付文件计数。
 * 合并同类留给叙事层，pack 保留原始条目（title_raw / detail_raw）。
 */
function buildWork(opts) {
  const { tasks, events, period, outputs } = opts;
  const items = [];
  const doneIds = new Set();

  for (const t of tasks || []) {
    if (String(t.status || '').toLowerCase() !== 'done') continue;
    const d = taskDoneDate(t);
    if (!inRange(d, period)) continue;
    doneIds.add(Number(t.id));
    const title = String(t.title || '').trim();
    const detail = String(t.detail || t.result_note || '').trim();
    const cat = classifyWork(title + ' ' + detail + ' ' + String(t.module || '')) || 'report';
    items.push({
      date: d,
      kind: 'apply',
      category: cat,
      title_raw: title,
      detail_raw: truncate(detail, 400),
      source: 'task:' + t.id,
      files: (outputs && outputs.get(Number(t.id))) || 0,
    });
  }

  for (const ev of events || []) {
    const d = String((ev && ev.d) || '').slice(0, 10);
    if (!inRange(d, period)) continue;
    const kind = String(ev.kind || '').toLowerCase();
    // manual 与 offpage 也算工作：报告交付、方案交付、disavow 提交都是客户该看到的投入。
    if (['apply', 'publish', 'config', 'manual', 'offpage'].indexOf(kind) === -1) continue;
    const label = String(ev.label || '').trim();
    if (!label) continue;
    // 任务类事件与上面的任务条目是同一件事，标题一样就不重复计。
    if (items.some((it) => it.title_raw === label && it.date === d)) continue;
    items.push({
      date: d,
      kind,
      category: classifyWork(label) || 'report',
      title_raw: label,
      detail_raw: '',
      source: 'event',
      files: 0,
    });
  }

  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const counts = { onpage: 0, content: 0, tech: 0, link: 0, ads: 0, report: 0 };
  for (const it of items) {
    if (counts[it.category] === undefined) counts[it.category] = 0;
    counts[it.category] += 1;
  }
  const blogs = items.filter((it) => it.category === 'content');
  return {
    items,
    counts,
    blogs_published: blogs.reduce((a, it) => a + (it.files > 0 ? it.files : 1), 0),
    pages_optimised: items.filter((it) => it.category === 'onpage').length,
  };
}

/** 下期计划输入：活跃方案的 sprint 加尚未完成的任务。 */
function buildNext(context, period) {
  const plan = (context && context.active_plan) || null;
  const tasks = (context && context.tasks) || [];
  const open = tasks.filter((t) => ['proposed', 'approved', 'in_progress', 'review', 'blocked'].indexOf(String(t.status || '')) !== -1);
  return {
    plan_sprint: (plan && (plan.sprint || plan.version || null)) || null,
    tasks: open.slice(0, 12).map((t) => ({
      id: Number(t.id) || 0,
      title: String(t.title || ''),
      module: String(t.module || ''),
      detail: truncate(String(t.detail || ''), 300),
    })),
    open_from_period: open
      .filter((t) => inRange(taskDoneDate(t), period))
      .slice(0, 8)
      .map((t) => ({ id: Number(t.id) || 0, title: String(t.title || '') })),
  };
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------

/**
 * 组装 facts pack。零 LLM。
 * ctx     runner 的 { job, cfg, api, log }
 * profile GET /context 的 profile
 * context GET /context 全量
 * period  computePeriod 的产物；只给 {type,start,end} 也行，这里会补算
 * opts    { workspace, instructions, versionHint }
 */
async function buildFactsPack(ctx, profile, context, period, opts = {}) {
  const { cfg, api, log } = ctx;
  const say = log || function () {};
  const per = period && period.compare ? period : computePeriod(period || {});
  const gaps = [];
  const inputs = { gsc_calls: 0, ga4_calls: 0, api_calls: 0, gsc_query_rows: 0, gsc_page_rows: 0 };

  const clientId = Number((profile && profile.client_id) || (ctx.job && ctx.job.client_id) || 0);
  const domain = String((profile && profile.domain) || '');
  const gscProperty = (profile && (profile.gsc_property || profile.gsc_site)) || '';
  const ga4Property = (profile && (profile.ga4_property || profile.ga4_property_id)) || '';
  if (!gscProperty && !ga4Property) {
    throw new Error('客户档案里 gsc_property 与 ga4_property 都是空的，没有任何数据源可拉，报告无法生成');
  }

  const brand = deriveBrandRegex({
    brandRegex: profile && profile.brand_regex,
    clientName: profile && profile.name,
    domain,
  });
  const spamRegex = cfg.gscSpamExcludeRegex || '';

  // ---- GSC ----
  let gsc = {
    cur: null,
    prev: null,
    delta: null,
    brand: null,
    top_queries: [],
    zero_exposure_pages: [],
  };
  let curQueryRows = [];
  let prevQueryRows = [];
  let curPageRows = [];
  let prevPageRows = [];
  let gscCoverage = null;
  let ga4Coverage = null;
  if (gscProperty) {
    say('gsc: 拉本期 ' + per.start + ' 至 ' + per.end + '，对比期 ' + per.compare.start + ' 至 ' + per.compare.end);
    const curTotals = await gscTotals(cfg, gscProperty, per, spamRegex);
    const prevTotals = await gscTotals(cfg, gscProperty, per.compare, spamRegex);
    curQueryRows = await gscByDimension(cfg, gscProperty, per, 'query', spamRegex);
    prevQueryRows = await gscByDimension(cfg, gscProperty, per.compare, 'query', spamRegex);
    curPageRows = await gscByDimension(cfg, gscProperty, per, 'page', spamRegex);
    prevPageRows = await gscByDimension(cfg, gscProperty, per.compare, 'page', spamRegex);
    gscCoverage = {
      cur: buildCoverage(per, await gscDayCount(cfg, gscProperty, per)),
      prev: buildCoverage(per.compare, await gscDayCount(cfg, gscProperty, per.compare)),
    };
    for (const g of coverageGaps('GSC', per, gscCoverage.cur, gscCoverage.prev)) gaps.push(g);
    say(
      'gsc: 覆盖天数 本期 ' + gscCoverage.cur.days + '/' + gscCoverage.cur.span +
        '，对比期 ' + gscCoverage.prev.days + '/' + gscCoverage.prev.span
    );
    inputs.gsc_calls = 8;
    inputs.gsc_query_rows = curQueryRows.length;
    inputs.gsc_page_rows = curPageRows.length;
    say('gsc: query 本期 ' + curQueryRows.length + ' 行、对比期 ' + prevQueryRows.length + ' 行；page 本期 ' + curPageRows.length + ' 行');

    const brandCur = brand.regex ? curQueryRows.filter((r) => brand.regex.test(r.query)) : [];
    const brandPrev = brand.regex ? prevQueryRows.filter((r) => brand.regex.test(r.query)) : [];
    const brandCurClicks = brandCur.reduce((a, r) => a + r.clicks, 0);
    const brandPrevClicks = brandPrev.reduce((a, r) => a + r.clicks, 0);
    if (!brand.regex) gaps.push('推不出品牌词正则（档案里 brand_regex 为空），品牌与非品牌未拆分');

    const prevQueryMap = new Map();
    for (const r of prevQueryRows) prevQueryMap.set(normalizeQuery(r.query), r);

    gsc = {
      cur: curTotals,
      prev: prevTotals,
      delta: {
        clicks: absDelta(curTotals.clicks, prevTotals.clicks),
        impressions: absDelta(curTotals.impressions, prevTotals.impressions),
        ctr_pp: round2(ppDelta(curTotals.ctr, prevTotals.ctr)),
        position: round1(posDelta(curTotals.position, prevTotals.position)),
      },
      brand: {
        cur_clicks: brandCurClicks,
        prev_clicks: brandPrevClicks,
        share_cur: curTotals.clicks > 0 ? round4(brandCurClicks / curTotals.clicks) : null,
      },
      top_queries: curQueryRows
        .slice()
        .sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
        .slice(0, TOP_QUERIES)
        .map((r) => {
          const p = prevQueryMap.get(normalizeQuery(r.query));
          return {
            query: r.query,
            clicks: r.clicks,
            impressions: r.impressions,
            position: round1(r.position),
            prev_position: p ? round1(p.position) : null,
          };
        }),
      // sitemap 对照要另拉一次站点地图，报告不为它多花一次外部请求。
      zero_exposure_pages: [],
    };
    gaps.push('GSC 页面收录状态与零曝光页未拉取，页面表只含本期有曝光的页面');
  } else {
    gaps.push('客户档案没有 GSC 属性，搜索表现、目标词排名两块本期为空');
  }

  // ---- GA4 ----
  let ga4 = {
    organic: { cur: null, prev: null, delta: null },
    channels: [],
    channels_total: null,
    funnel: { steps: [], rates: [] },
    landing_pages: [],
  };
  let ecom = null;
  if (ga4Property) {
    say('ga4: 属性 ' + ga4Property + '，拉渠道、事件、落地页');
    const curCh = await ga4Channels(ctx, ga4Property, per);
    const prevCh = await ga4Channels(ctx, ga4Property, per.compare);
    const wantEvents = LEAD_EVENTS.concat(['form_start']);
    const curEv = await ga4ChannelEvents(ctx, ga4Property, per, wantEvents);
    const prevEv = await ga4ChannelEvents(ctx, ga4Property, per.compare, wantEvents);
    const curLp = await ga4LandingPages(ctx, ga4Property, per);
    const prevLp = await ga4LandingPages(ctx, ga4Property, per.compare);
    ga4Coverage = {
      cur: buildCoverage(per, await ga4DayCount(ctx, ga4Property, per)),
      prev: buildCoverage(per.compare, await ga4DayCount(ctx, ga4Property, per.compare)),
    };
    for (const g of coverageGaps('GA4', per, ga4Coverage.cur, ga4Coverage.prev)) gaps.push(g);
    say(
      'ga4: 覆盖天数 本期 ' + ga4Coverage.cur.days + '/' + ga4Coverage.cur.span +
        '，对比期 ' + ga4Coverage.prev.days + '/' + ga4Coverage.prev.span
    );
    inputs.ga4_calls = 8;

    const leadsByChannel = (rows) => {
      const m = new Map();
      for (const r of rows) {
        if (LEAD_EVENTS.indexOf(r.event) === -1) continue;
        m.set(r.channel, (m.get(r.channel) || 0) + r.count);
      }
      return m;
    };
    const eventTotal = (rows, name, organicOnly) =>
      rows
        .filter((r) => r.event === name && (!organicOnly || isOrganicChannel(r.channel)))
        .reduce((a, r) => a + r.count, 0);

    const curLeadMap = leadsByChannel(curEv);
    const prevLeadMap = leadsByChannel(prevEv);

    const merged = mergeChannels(
      curCh.map((c) => ({ channel: c.channel, sessions: c.sessions, leads: curLeadMap.get(c.channel) || 0, revenue: null })),
      prevCh.map((c) => ({ channel: c.channel, sessions: c.sessions, leads: prevLeadMap.get(c.channel) || 0, revenue: null }))
    );

    const orgCur = curCh.filter((c) => isOrganicChannel(c.channel));
    const orgPrev = prevCh.filter((c) => isOrganicChannel(c.channel));
    const sum = (arr, k) => arr.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const curLeadsOrganic = LEAD_EVENTS.reduce((a, n) => a + eventTotal(curEv, n, true), 0);
    const prevLeadsOrganic = LEAD_EVENTS.reduce((a, n) => a + eventTotal(prevEv, n, true), 0);
    const curFormStart = eventTotal(curEv, 'form_start', true);
    const prevFormStart = eventTotal(prevEv, 'form_start', true);
    if (curFormStart === 0 && prevFormStart === 0) {
      gaps.push('GA4 本期与对比期都没有 form_start 事件，漏斗中间一步按 0 呈现，不代表页面上没有表单');
    }

    const organicCur = { sessions: sum(orgCur, 'sessions'), new_users: sum(orgCur, 'new_users'), leads: curLeadsOrganic };
    const organicPrev = { sessions: sum(orgPrev, 'sessions'), new_users: sum(orgPrev, 'new_users'), leads: prevLeadsOrganic };

    const prevLpMap = new Map();
    for (const r of prevLp) prevLpMap.set(r.path, r.sessions);

    ecom = await ga4Ecommerce(ctx, ga4Property, per, say);
    if (ecom) inputs.ga4_calls += 1;

    ga4 = {
      organic: {
        cur: organicCur,
        prev: organicPrev,
        delta: {
          sessions: absDelta(organicCur.sessions, organicPrev.sessions),
          sessions_pct: round4(pctDelta(organicCur.sessions, organicPrev.sessions)),
          new_users: absDelta(organicCur.new_users, organicPrev.new_users),
          new_users_pct: round4(pctDelta(organicCur.new_users, organicPrev.new_users)),
          leads: absDelta(organicCur.leads, organicPrev.leads),
          leads_pct: round4(pctDelta(organicCur.leads, organicPrev.leads)),
        },
      },
      channels: merged.channels,
      channels_total: merged.total,
      funnel: {
        steps: [
          { key: 'sessions', label: '自然搜索访问', cur: organicCur.sessions, prev: organicPrev.sessions },
          { key: 'form_start', label: '开始填写表单', cur: curFormStart, prev: prevFormStart },
          { key: 'leads', label: '询盘', cur: organicCur.leads, prev: organicPrev.leads },
        ],
        rates: [
          {
            from: 'sessions',
            to: 'form_start',
            cur: organicCur.sessions > 0 ? round4(curFormStart / organicCur.sessions) : null,
            prev: organicPrev.sessions > 0 ? round4(prevFormStart / organicPrev.sessions) : null,
          },
          {
            from: 'sessions',
            to: 'leads',
            cur: organicCur.sessions > 0 ? round4(organicCur.leads / organicCur.sessions) : null,
            prev: organicPrev.sessions > 0 ? round4(organicPrev.leads / organicPrev.sessions) : null,
          },
        ],
      },
      landing_pages: curLp.slice(0, TOP_PAGES).map((r) => {
        const prev = prevLpMap.has(r.path) ? prevLpMap.get(r.path) : null;
        return {
          path: r.path,
          sessions: r.sessions,
          prev_sessions: prev,
          delta: prev === null ? null : absDelta(r.sessions, prev),
        };
      }),
    };
    if (ecom) {
      ga4.ecommerce = {
        cur: ecom.organic,
        all: ecom.all,
      };
    } else {
      ga4.ecommerce = null;
    }
  } else {
    gaps.push('客户档案没有 GA4 属性，流量、渠道、漏斗三块本期为空');
  }

  // ---- 目标词排名 ----
  let targetKeywords = (profile && profile.target_keywords) || [];
  if (typeof targetKeywords === 'string') {
    targetKeywords = targetKeywords.split(/[\n,，]+/).map((s) => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(targetKeywords)) targetKeywords = [];
  const rankRows = targetKeywords.map((kw) => {
    const cur = clusterWeightedPosition(curQueryRows, kw);
    const prev = clusterWeightedPosition(prevQueryRows, kw);
    return {
      keyword: String(kw),
      pos: cur.pos,
      prev_pos: prev.pos,
      delta: cur.pos !== null && prev.pos !== null ? round1(posDelta(cur.pos, prev.pos)) : null,
      impressions: cur.impressions,
      clicks: cur.clicks,
      is_brand: brand.regex ? brand.regex.test(String(kw)) : false,
      band: rankBand(cur.pos),
    };
  });
  if (!targetKeywords.length) gaps.push('客户档案没有目标关键词表，排名追踪一节本期为空');
  const rankings = {
    method: '按查询簇曝光加权的 GSC 平均位次，簇 = 归一化后包含该词全部 token 的查询',
    rows: rankRows,
    summary: {
      total: rankRows.length,
      top10: rankRows.filter((r) => r.band === 'top10').length,
      p11_20: rankRows.filter((r) => r.band === 'p11_20').length,
      p21_plus: rankRows.filter((r) => r.band === 'p21_plus').length,
      improved: rankRows.filter((r) => r.delta !== null && r.delta < 0).length,
      declined: rankRows.filter((r) => r.delta !== null && r.delta > 0).length,
      no_exposure: rankRows.filter((r) => r.band === 'none').length,
    },
    // 上期同一批词的分档计数，排名分布图的对照列。
    summary_prev: (() => {
      const c = bandCounts(rankRows, 'prev');
      return { top10: c.top10, p11_20: c.p11_20, p21_plus: c.p21_plus, no_exposure: c.none };
    })(),
    near_page1: rankRows
      .filter((r) => r.pos !== null && r.pos > 10 && r.pos <= 15)
      .sort((a, b) => a.pos - b.pos)
      .slice(0, 8)
      .map((r) => ({ keyword: r.keyword, pos: r.pos })),
    declined_with_volume: rankRows
      .filter((r) => r.delta !== null && r.delta > 0 && r.impressions > 0)
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, 8)
      .map((r) => ({ keyword: r.keyword, pos: r.pos, prev_pos: r.prev_pos, impressions: r.impressions })),
  };

  // ---- 同比（去年同月） ----
  // 只对整月报告做：月中出报的契约是同窗环比、不做同比。GSC 保留约 16 个月
  // 数据，去年同月在窗口内；GA4 更久。两个源在去年同期都是零，多半是站点
  // 或数据源当时还没接入，这时同比没有对照意义，整块置空并进 gaps。
  let yoy = null;
  const yoyPer = yoyPeriodOf(per);
  if (yoyPer) {
    try {
      let yoyGsc = null;
      if (gscProperty) {
        yoyGsc = await gscTotals(cfg, gscProperty, yoyPer, spamRegex);
        inputs.gsc_calls += 1;
      }
      let yoyOrganic = null;
      if (ga4Property) {
        const yoyCh = await ga4Channels(ctx, ga4Property, yoyPer);
        const yoyEv = await ga4ChannelEvents(ctx, ga4Property, yoyPer, LEAD_EVENTS);
        inputs.ga4_calls += 2;
        const org = yoyCh.filter((c) => isOrganicChannel(c.channel));
        yoyOrganic = {
          sessions: org.reduce((a, r) => a + (Number(r.sessions) || 0), 0),
          new_users: org.reduce((a, r) => a + (Number(r.new_users) || 0), 0),
          leads: yoyEv
            .filter((r) => isOrganicChannel(r.channel) && LEAD_EVENTS.indexOf(r.event) !== -1)
            .reduce((a, r) => a + r.count, 0),
        };
      }
      const noGscData = !yoyGsc || (yoyGsc.clicks === 0 && yoyGsc.impressions === 0);
      const noGa4Data = !yoyOrganic || yoyOrganic.sessions === 0;
      if (noGscData && noGa4Data) {
        gaps.push('去年同期（' + yoyPer.label + '）两个数据源都没有数据，多半是站点或数据源当时未接入，本期不做同比');
      } else {
        const orgCurY = (ga4.organic && ga4.organic.cur) || null;
        yoy = {
          period: yoyPer,
          gsc: noGscData ? null : yoyGsc,
          ga4_organic: noGa4Data ? null : yoyOrganic,
          delta: {
            clicks_pct: !noGscData && gsc.cur ? round3(pctDelta(gsc.cur.clicks, yoyGsc.clicks)) : null,
            impressions_pct: !noGscData && gsc.cur ? round3(pctDelta(gsc.cur.impressions, yoyGsc.impressions)) : null,
            position: !noGscData && gsc.cur ? round1(posDelta(gsc.cur.position, yoyGsc.position)) : null,
            sessions_pct: !noGa4Data && orgCurY ? round3(pctDelta(orgCurY.sessions, yoyOrganic.sessions)) : null,
            new_users_pct: !noGa4Data && orgCurY ? round3(pctDelta(orgCurY.new_users, yoyOrganic.new_users)) : null,
            leads_pct: !noGa4Data && orgCurY ? round3(pctDelta(orgCurY.leads, yoyOrganic.leads)) : null,
          },
        };
        say('yoy: 取到去年同期 ' + yoyPer.start + ' 至 ' + yoyPer.end + ' 的对照数据');
      }
    } catch (e) {
      gaps.push('去年同期数据未取到（' + String(e.message || e).slice(0, 120) + '），本期不做同比');
      say('yoy: 取数失败，本期不做同比：' + e.message);
    }
  }

  // ---- 趋势 ----
  const months = monthsBack(ymOf(per.start), TREND_MONTHS);
  let trend = { months, gsc_clicks: [], ga4_sessions_organic: [], last_partial: !!per.partial };
  try {
    const from = months[0] + '-01';
    const res = await api.getMetrics(clientId, from, per.end, ['gsc_clicks', 'ga4_sessions_organic']);
    inputs.api_calls += 1;
    trend = buildTrend(res && res.metrics, months, per.partial);
    say('trend: 取到 ' + months.length + ' 个月的时序');
  } catch (e) {
    // 这个端点现在还是 admin only，worker 拿到 403 是已知状态，不该把报告拖挂。
    trend = { months, gsc_clicks: [], ga4_sessions_organic: [], last_partial: !!per.partial };
    gaps.push('历史趋势数据本期未取到（' + String(e.message || e).slice(0, 120) + '），趋势图暂缺');
    say('trend: 取数失败，按空趋势处理：' + e.message);
  }

  // ---- 工作量与下期 ----
  let events = [];
  try {
    const evRes = await api.getEvents(clientId, per.start, per.end);
    inputs.api_calls += 1;
    events = (evRes && evRes.events) || [];
  } catch (e) {
    gaps.push('动作标注本期未取到（' + String(e.message || e).slice(0, 120) + '），工作内容只按任务记录汇总');
    say('events: 取数失败，按空事件处理：' + e.message);
  }
  const tasks = (context && context.tasks) || [];
  const doneIds = new Set(
    tasks.filter((t) => String(t.status || '').toLowerCase() === 'done').map((t) => Number(t.id))
  );
  const outputs = countTaskOutputs(opts.workspace, doneIds);
  const work = buildWork({ tasks, events, period: per, outputs });
  const next = buildNext(context, per);

  // ---- facts 与客户类型 ----
  const facts = factsForPrompt(context);
  const bizType = inferBizType(facts, ecom && ecom.all ? ecom.all.purchases : 0);
  const leadsOverride = parseLeadsOverride(opts.instructions);
  if (leadsOverride !== null) {
    say('instructions 指定询盘总数按后台实收 ' + leadsOverride + '，pack 记录覆盖值');
  }

  // ---- narrative_inputs ----
  const org = ga4.organic || {};
  const kpiParts = [];
  if (gsc.cur) {
    kpiParts.push({
      name: '自然搜索点击',
      cur: gsc.cur.clicks,
      prev: gsc.prev.clicks,
      delta_pct: round3(pctDelta(gsc.cur.clicks, gsc.prev.clicks)),
    });
    kpiParts.push({
      name: '自然搜索曝光',
      cur: gsc.cur.impressions,
      prev: gsc.prev.impressions,
      delta_pct: round3(pctDelta(gsc.cur.impressions, gsc.prev.impressions)),
    });
    kpiParts.push({
      name: 'GSC 平均位次',
      cur: gsc.cur.position,
      prev: gsc.prev.position,
      delta_pct: null,
    });
  }
  if (org.cur) {
    kpiParts.push({
      name: '自然搜索访问',
      cur: org.cur.sessions,
      prev: org.prev.sessions,
      delta_pct: round3(pctDelta(org.cur.sessions, org.prev.sessions)),
    });
    kpiParts.push({
      name: '自然搜索新访客',
      cur: org.cur.new_users,
      prev: org.prev.new_users,
      delta_pct: round3(pctDelta(org.cur.new_users, org.prev.new_users)),
    });
    kpiParts.push({
      name: '询盘',
      cur: leadsOverride === null ? org.cur.leads : leadsOverride,
      prev: org.prev.leads,
      delta_pct: leadsOverride === null ? round3(pctDelta(org.cur.leads, org.prev.leads)) : null,
    });
  }

  const highlights = rankRows
    .filter((r) => r.delta !== null && r.delta < 0)
    .sort((a, b) => a.delta - b.delta || b.impressions - a.impressions)
    .slice(0, 8)
    .map((r) => ({ keyword: r.keyword, prev_pos: r.prev_pos, pos: r.pos, delta: r.delta, impressions: r.impressions }));
  const declines = rankRows
    .filter((r) => r.delta !== null && r.delta > 0)
    .sort((a, b) => b.delta - a.delta || b.impressions - a.impressions)
    .slice(0, 8)
    .map((r) => ({ keyword: r.keyword, prev_pos: r.prev_pos, pos: r.pos, delta: r.delta, impressions: r.impressions }));
  const lp = ga4.landing_pages || [];
  const pageRisers = lp
    .filter((r) => r.delta !== null && r.delta > 0)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 5)
    .map((r) => ({ path: r.path, prev: r.prev_sessions, cur: r.sessions }));
  const pageFallers = lp
    .filter((r) => r.delta !== null && r.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, 5)
    .map((r) => ({ path: r.path, prev: r.prev_sessions, cur: r.sessions }));

  const pack = {
    meta: {
      client_id: clientId,
      client_name: String(
        (profile && profile.name) ||
          (profile && profile.client_name) ||
          (context && context.client && context.client.name) ||
          domain ||
          ('客户 ' + clientId)
      ),
      domain,
      slug: String(opts.slug || ''),
      report_lang: String((profile && profile.report_lang) || 'zh'),
      biz_type: bizType,
      // 市场优先取档案字段，没有就按域名后缀推：.com.au 澳洲、.co.nz 新西兰，其余留空不猜。
      market: String(
        (profile && (profile.market || profile.country)) ||
          (/\.com\.au(\/|$)/i.test(String(domain)) ? 'AU' : /\.co\.nz(\/|$)/i.test(String(domain)) ? 'NZ' : '')
      ),
      platform: String((profile && (profile.platform || profile.cms)) || ''),
      vertical: String((profile && (profile.vertical || profile.industry)) || ''),
      period: {
        type: per.type,
        start: per.start,
        end: per.end,
        label: per.label,
        short: per.short,
        partial: per.partial,
        through_day: per.through_day,
      },
      compare: {
        start: per.compare.start,
        end: per.compare.end,
        label: per.compare.label,
        short: per.compare.short,
      },
      generated_at: new Date().toISOString(),
      version_hint: Number(opts.versionHint) || 1,
      leads_source: 'GA4 关键事件 ' + LEAD_EVENTS.join('、') + ' 之和',
      leads_override: leadsOverride,
      brand_regex_source: brand.source,
    },
    gsc: { ...gsc, coverage: gscCoverage },
    ga4: { ...ga4, coverage: ga4Coverage },
    // 去年同月对照。月中出报、去年无数据、取数失败时为 null，缘由在 gaps。
    yoy,
    rankings,
    trend,
    work,
    next,
    facts_for_prompt: facts,
    gaps,
    narrative_inputs: {
      kpi_sentence_parts: kpiParts,
      ranking_highlights: highlights,
      ranking_declines: declines,
      page_risers: pageRisers,
      page_fallers: pageFallers,
    },
    pack_inputs: Object.assign(
      {
        period: per.start + ' 至 ' + per.end,
        compare: per.compare.start + ' 至 ' + per.compare.end,
        gsc_property: gscProperty || null,
        ga4_property: ga4Property || null,
      },
      inputs
    ),
  };
  say('facts pack 组装完成：目标词 ' + rankRows.length + ' 个、渠道 ' + (ga4.channels || []).length + ' 行、工作条目 ' + work.items.length + ' 条、gaps ' + gaps.length + ' 条');
  return pack;
}

module.exports = {
  buildFactsPack,
  // 纯函数，单测直接打
  num,
  splitYmd,
  daysInMonth,
  monthStartOf,
  monthEndOf,
  addMonths,
  addDays,
  ymOf,
  monthsBack,
  computePeriod,
  pctDelta,
  absDelta,
  posDelta,
  ppDelta,
  spamIncludeGroups,
  spanDays,
  buildCoverage,
  coverageGaps,
  subtractSpamTotals,
  normalizeQuery,
  queryTokens,
  clusterWeightedPosition,
  rankBand,
  bandCounts,
  yoyPeriodOf,
  classifyWork,
  isOrganicChannel,
  isMergeableChannel,
  mergeChannels,
  monthlySum,
  buildTrend,
  factsForPrompt,
  inferBizType,
  parseLeadsOverride,
  buildWork,
  buildNext,
  countTaskOutputs,
  taskDoneDate,
  round1,
  round2,
  round4,
  CHANNEL_MERGE_SHARE,
  TREND_MONTHS,
};
