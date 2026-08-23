'use strict';
// 日粒度时序指标：拉取、推导、写入。零 LLM，从头到尾是 API 读加确定性计算。
//
// 为什么要有这一层：seo_snapshots 存的是 28 天窗口的一大坨 JSON，能回答
// "这一期怎么样"，回答不了"每天怎么样"。这个文件负责把三个数据源摊成
// (日期, 指标名, 值) 的三元组，POST 给 /metrics 落进 seo_metrics_daily。
//
// 分工：
//   pull*Daily / pull*Brand / pull*Organic  对外拉数据，pull_data 和
//     backfill_metrics 共用，唯一区别是窗口长度
//   metricsFromSnapshots                    纯函数，快照 JSON 进、指标行出，
//     不碰网络，单测就测它
//
// 口径上的两条硬规矩，改之前先读懂：
//   1. 排名分档只算自然结果。Semrush 的 position 字段在 positionIsSERPFeature
//      为 true 时是 SERP feature 占位（AI Overview 引用那种），不是自然位次。
//      2026-08 就栽在这上面：Semrush 显示某词第 1 位，GSC 显示 21.9 位，
//      对不上账，最后发现那个 1 是 AI Overview 引用。
//   2. 品牌词拆分只能得到"至少这么多"。GSC 会把长尾 query 匿名化掉，
//      按 query 维度拉到的行加起来永远小于按 date 维度的总量，所以
//      gsc_*_brand <= gsc_*，两者相减得到的"非品牌"里混着匿名部分。

const { googlePost } = require('./google');
const { ymd } = require('./util');

const GSC_SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly'];
const GA4_SCOPES = ['https://www.googleapis.com/auth/analytics.readonly'];

/** 指标名的唯一权威清单，必须与 seo-api.php 的 METRIC_NAMES 逐字一致。 */
const METRICS = [
  'gsc_impressions',
  'gsc_clicks',
  'gsc_impressions_brand',
  'gsc_clicks_brand',
  'ga4_sessions_organic',
  'ga4_leads',
  'rank_top3',
  'rank_top10',
  'rank_top20',
  'rank_tracked',
  'ref_domains',
];

/** GA4 里算作一条 lead 的三个事件。三者之和就是 ga4_leads。 */
const LEAD_EVENTS = ['form_submit', 'generate_lead', 'click_to_call'];

/** GA4 自然搜索渠道的标签。比较时不区分大小写，见 ga4OrganicRows。 */
const ORGANIC_CHANNEL = 'organic search';

// GSC 单次请求的行数上限是 25000。date x query 两维在长窗口上会贴满，
// 所以既分段又翻页。
const GSC_ROW_LIMIT = 25000;
// 一次拉多少天。date 单维一天一行，随便拉；date x query 一天可能几百上千行，
// 分小段才不会每段都撞上 25000 的天花板。
const GSC_DATE_CHUNK_DAYS = 90;
const GSC_QUERY_CHUNK_DAYS = 14;
// 翻页上限，防止分页条件写错时无限翻。20 页 x 25000 = 50 万行，远超任何真实场景。
const GSC_MAX_PAGES = 20;

// GA4 Data API 一次最多回 250000 行，但长区间容易碰上采样和配额，分段更稳。
const GA4_CHUNK_DAYS = 90;
const GA4_ROW_LIMIT = 100000;

// 两次外部请求之间的间隔，纯粹为了对配额客气一点。
const PAUSE_MS = 250;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 日期与分段
// ---------------------------------------------------------------------------

/** 'YYYY-MM-DD' -> Date（UTC 零点）。格式不对返回 null。 */
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** GA4 的 date 维度回的是 20260815，统一成 2026-08-15。已经是横杠格式的原样返回。 */
function normalizeDate(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  return null;
}

/**
 * 把 [start, end] 切成不超过 days 天的若干段，含首含尾。
 * 返回 [{ start, end }, ...]，start/end 都是 'YYYY-MM-DD'。
 */
function chunkRange(start, end, days) {
  const s = parseYmd(start);
  const e = parseYmd(end);
  if (!s || !e || s > e) return [];
  const out = [];
  let cur = s;
  while (cur <= e) {
    const stop = new Date(cur.getTime());
    stop.setUTCDate(stop.getUTCDate() + (days - 1));
    out.push({ start: ymd(cur), end: ymd(stop > e ? e : stop) });
    cur = new Date(stop.getTime());
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 品牌词正则
// ---------------------------------------------------------------------------

/**
 * 拆品牌名时要丢掉的通用词。丢掉它们是为了让正则命中"power dekor flooring"
 * 而不是只命中一模一样的全称。行业词和公司后缀都在里面。
 */
const BRAND_STOPWORDS = [
  'flooring', 'floors', 'floor', 'timber', 'wood', 'group', 'holdings',
  'ltd', 'limited', 'llc', 'inc', 'pty', 'co', 'company', 'corp',
  'nz', 'au', 'com', 'net', 'org', 'shop', 'store', 'online',
  'services', 'service', 'solutions', 'the', 'and',
];

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** https://www.powerdekorfloors.co.nz/ -> powerdekorfloors */
function domainLabel(domain) {
  return String(domain || '')
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./i, '')
    .split('.')[0]
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** 只留字母数字的小写词，其余全当分隔符。驼峰也在这里拆开。 */
function nameTokens(name) {
  return String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

/**
 * 域名主体是一整坨字母，没有分隔符可拆，靠字典才知道 powerdekorfloors 该断在哪。
 * 不引字典，改用一条确定性的放宽规则：允许任意两个字符之间夹空白或连字符。
 * powerdekor -> p[\s-]*o[\s-]*w... 能同时命中 powerdekor / power dekor / power-dekor，
 * 而字符顺序必须完全一致，误伤概率约等于零。
 */
function interleave(blob) {
  return blob.split('').map(escapeRe).join('[\\s\\-]*');
}

/**
 * 推导品牌词正则。三级优先：
 *   1. profile.brand_regex 有值就用它，人工填的永远胜过推导的
 *   2. 客户名有值就用它。客户名自带词边界（"Power Dekor Floors"），
 *      去掉通用词后拼成 power[\s-]*dekor，这是最准的一路
 *   3. 只剩域名主体时，先剥掉结尾的通用词（powerdekorfloors -> powerdekor），
 *      再用 interleave 放宽
 * 返回 { pattern, source, regex }，source 取 profile / client_name / domain / none。
 * 推不出来时 regex 为 null，调用方据此跳过品牌拆分而不是拿空正则去匹配一切。
 */
function deriveBrandRegex(opts = {}) {
  const explicit = String(opts.brandRegex || '').trim();
  if (explicit) {
    try {
      return { pattern: explicit, source: 'profile', regex: new RegExp(explicit, 'i') };
    } catch (e) {
      // 坏正则不能让整个拉取挂掉，降级去走推导那条路，并让调用方能记 log。
      return {
        pattern: '',
        source: 'none',
        regex: null,
        error: 'profile.brand_regex 不是合法正则：' + e.message,
      };
    }
  }

  const tokens = nameTokens(opts.clientName).filter((t) => BRAND_STOPWORDS.indexOf(t) === -1);
  if (tokens.length) {
    const pattern = tokens.map(escapeRe).join('[\\s\\-]*');
    return { pattern, source: 'client_name', regex: new RegExp(pattern, 'i') };
  }

  let blob = domainLabel(opts.domain);
  if (blob) {
    // 结尾的通用词逐个剥，剥到只剩 4 个字符就停：再剥下去就不是品牌了。
    let changed = true;
    while (changed) {
      changed = false;
      for (const w of BRAND_STOPWORDS) {
        if (blob.length - w.length >= 4 && blob.endsWith(w)) {
          blob = blob.slice(0, blob.length - w.length);
          changed = true;
          break;
        }
      }
    }
    if (blob.length >= 3) {
      const pattern = interleave(blob);
      return { pattern, source: 'domain', regex: new RegExp(pattern, 'i') };
    }
  }

  return { pattern: '', source: 'none', regex: null };
}

// ---------------------------------------------------------------------------
// GSC
// ---------------------------------------------------------------------------

function gscUrl(property) {
  return (
    'https://www.googleapis.com/webmasters/v3/sites/' +
    encodeURIComponent(property) +
    '/searchAnalytics/query'
  );
}

/** 排除垃圾词的过滤组，与 pull_data 的基线口径保持一致。 */
function spamFilterGroups(regex) {
  if (!regex) return undefined;
  return [
    {
      groupType: 'and',
      filters: [{ dimension: 'query', operator: 'excludingRegex', expression: regex }],
    },
  ];
}

async function gscQuery(cfg, property, body) {
  return googlePost(cfg.ga4KeyFile, GSC_SCOPES, gscUrl(property), body, cfg.httpTimeoutMs);
}

/**
 * 按日拉 GSC 曝光和点击。dimensions 只有 date，一天一行。
 * 返回 [{ date, clicks, impressions }, ...]，日期升序。
 */
async function pullGscDaily(ctx, property, range, spamRegex) {
  const { cfg, log } = ctx;
  const out = [];
  const chunks = chunkRange(range.start, range.end, GSC_DATE_CHUNK_DAYS);
  for (const c of chunks) {
    const res = await gscQuery(cfg, property, {
      startDate: c.start,
      endDate: c.end,
      dimensions: ['date'],
      dimensionFilterGroups: spamFilterGroups(spamRegex),
      rowLimit: GSC_ROW_LIMIT,
    });
    const rows = (res && res.rows) || [];
    for (const r of rows) {
      const d = normalizeDate((r.keys || [])[0]);
      if (!d) continue;
      out.push({ date: d, clicks: r.clicks || 0, impressions: r.impressions || 0 });
    }
    log('gsc daily: ' + c.start + ' 到 ' + c.end + '，' + rows.length + ' 行');
    await sleep(PAUSE_MS);
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/**
 * 按日拉品牌词部分。dimensions 是 date + query，逐行判品牌再按日汇总。
 * GSC 一次能同时给这两个维度，rowLimit 上限 25000，所以既分段又用 startRow 翻页。
 * 返回 [{ date, clicks, impressions }, ...]，只含品牌命中的那部分。
 *
 * 注意：GSC 匿名化掉的长尾 query 根本不会出现在这个维度里，所以这里的和
 * 恒小于 pullGscDaily 的和。这是 GSC 的性质，不是 bug。
 */
async function pullGscDailyBrand(ctx, property, range, spamRegex, brandRe) {
  const { cfg, log } = ctx;
  if (!brandRe) return null;
  const byDate = new Map();
  let scanned = 0;
  let hit = 0;
  const chunks = chunkRange(range.start, range.end, GSC_QUERY_CHUNK_DAYS);
  for (const c of chunks) {
    let startRow = 0;
    for (let page = 0; page < GSC_MAX_PAGES; page++) {
      const res = await gscQuery(cfg, property, {
        startDate: c.start,
        endDate: c.end,
        dimensions: ['date', 'query'],
        dimensionFilterGroups: spamFilterGroups(spamRegex),
        rowLimit: GSC_ROW_LIMIT,
        startRow,
      });
      const rows = (res && res.rows) || [];
      for (const r of rows) {
        scanned++;
        const keys = r.keys || [];
        const d = normalizeDate(keys[0]);
        if (!d) continue;
        if (!brandRe.test(String(keys[1] || ''))) continue;
        hit++;
        const acc = byDate.get(d) || { date: d, clicks: 0, impressions: 0 };
        acc.clicks += r.clicks || 0;
        acc.impressions += r.impressions || 0;
        byDate.set(d, acc);
      }
      await sleep(PAUSE_MS);
      if (rows.length < GSC_ROW_LIMIT) break;
      startRow += rows.length;
      if (page === GSC_MAX_PAGES - 1) {
        log('gsc brand: ' + c.start + ' 到 ' + c.end + ' 翻页到上限仍未取完，该段品牌值偏低');
      }
    }
  }
  log('gsc brand: 扫 ' + scanned + ' 行 date x query，命中品牌 ' + hit + ' 行，覆盖 ' + byDate.size + ' 天');
  return Array.from(byDate.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---------------------------------------------------------------------------
// GA4
// ---------------------------------------------------------------------------

function ga4Url(propertyId) {
  const id = String(propertyId).replace(/^properties\//, '');
  return (
    'https://analyticsdata.googleapis.com/v1beta/properties/' + encodeURIComponent(id) + ':runReport'
  );
}

function ga4Rows(res) {
  const dimHeaders = ((res && res.dimensionHeaders) || []).map((h) => h.name);
  const metHeaders = ((res && res.metricHeaders) || []).map((h) => h.name);
  return ((res && res.rows) || []).map((r) => {
    const out = {};
    (r.dimensionValues || []).forEach((v, i) => {
      out[dimHeaders[i] || 'dim' + i] = v.value;
    });
    (r.metricValues || []).forEach((v, i) => {
      const n = Number(v.value);
      out[metHeaders[i] || 'metric' + i] = Number.isFinite(n) ? n : v.value;
    });
    return out;
  });
}

/** 跑一段 GA4 报表，按 rowCount 翻页取全。 */
async function ga4Report(ctx, propertyId, body) {
  const { cfg } = ctx;
  const all = [];
  let offset = 0;
  for (let page = 0; page < GSC_MAX_PAGES; page++) {
    const req = Object.assign({ limit: GA4_ROW_LIMIT, offset }, body);
    const res = await googlePost(cfg.ga4KeyFile, GA4_SCOPES, ga4Url(propertyId), req, cfg.httpTimeoutMs);
    const rows = ga4Rows(res);
    all.push.apply(all, rows);
    const total = Number(res && res.rowCount);
    await sleep(PAUSE_MS);
    if (!rows.length || !Number.isFinite(total) || all.length >= total) break;
    offset += rows.length;
  }
  return all;
}

/**
 * 按日拉自然搜索会话。维度 date x sessionDefaultChannelGroup，不加过滤器，
 * 回来自己挑 Organic Search：万一 GA4 改了渠道标签，log 里能看见实际有哪些，
 * 比静悄悄返回 0 强。
 * 返回 [{ date, sessions }, ...]。
 */
async function pullGa4OrganicDaily(ctx, propertyId, range) {
  const { log } = ctx;
  const byDate = new Map();
  const channels = new Set();
  for (const c of chunkRange(range.start, range.end, GA4_CHUNK_DAYS)) {
    const rows = await ga4Report(ctx, propertyId, {
      dateRanges: [{ startDate: c.start, endDate: c.end }],
      dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }],
    });
    for (const r of rows) {
      const d = normalizeDate(r.date);
      if (!d) continue;
      const ch = String(r.sessionDefaultChannelGroup || '');
      channels.add(ch);
      if (ch.trim().toLowerCase() !== ORGANIC_CHANNEL) continue;
      byDate.set(d, (byDate.get(d) || 0) + (Number(r.sessions) || 0));
    }
    log('ga4 organic: ' + c.start + ' 到 ' + c.end + '，' + rows.length + ' 行');
  }
  log('ga4 organic: 见到的渠道 [' + Array.from(channels).join(', ') + ']，命中 ' + byDate.size + ' 天');
  return Array.from(byDate.entries())
    .map(([date, sessions]) => ({ date, sessions }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * 按日拉三个 lead 事件的次数之和。维度 date x eventName，指标 eventCount。
 *
 * 为什么用 eventCount 而不是 keyEvents/conversions：keyEvents 只统计被标成
 * 关键事件之后的数据，PD 的关键事件是 2026-08-22 才标对的，用它回填 180 天
 * 会得到一条前面全是 0 的假曲线。eventCount 与标记无关，历史可比。
 * 返回 [{ date, leads }, ...]。
 */
async function pullGa4LeadsDaily(ctx, propertyId, range) {
  const { log } = ctx;
  const byDate = new Map();
  for (const c of chunkRange(range.start, range.end, GA4_CHUNK_DAYS)) {
    const rows = await ga4Report(ctx, propertyId, {
      dateRanges: [{ startDate: c.start, endDate: c.end }],
      dimensions: [{ name: 'date' }, { name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: {
        filter: {
          fieldName: 'eventName',
          inListFilter: { values: LEAD_EVENTS, caseSensitive: true },
        },
      },
    });
    for (const r of rows) {
      const d = normalizeDate(r.date);
      if (!d) continue;
      if (LEAD_EVENTS.indexOf(String(r.eventName || '')) === -1) continue;
      byDate.set(d, (byDate.get(d) || 0) + (Number(r.eventCount) || 0));
    }
    log('ga4 leads: ' + c.start + ' 到 ' + c.end + '，' + rows.length + ' 行');
  }
  log('ga4 leads: 覆盖 ' + byDate.size + ' 天，事件口径 ' + LEAD_EVENTS.join(' + '));
  return Array.from(byDate.entries())
    .map(([date, leads]) => ({ date, leads }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Semrush 快照 -> 排名分档与引荐域
// ---------------------------------------------------------------------------

/** 剥掉 seoq 的信封，取里面真正的载荷。 */
function seoqPayload(part) {
  if (!part) return null;
  if (part.data && typeof part.data === 'object') return part.data;
  return part;
}

/**
 * 从 semrush 快照里算排名分档。
 *
 * 首选 rankings.data.summary.position_bands：seoq 用带位次过滤器的
 * organic.PositionsTotal 单独查出来的，覆盖 top100 全集而不只是回传的那几行，
 * 而且明确写了 positions_counted = "organic results only"，SERP feature 占位
 * 已经被排除（那份 summary 里的 serp_feature_positions_excluded 就是被排掉的数量）。
 *
 * 没有 position_bands 时退到逐行统计，此时必须自己滤掉
 * positionIsSERPFeature 为 true 的行，否则 AI Overview 引用会被当成第 1 位。
 * 逐行统计只能覆盖回传的行，所以标成 basis=rows 让调用方知道这是近似值。
 *
 * 返回 { top3, top10, top20, tracked, basis } 或 null。
 * 三个 top 都是累计值（top10 含 top3），与 Semrush 自己的口径一致。
 */
function rankBuckets(semrushData) {
  const payload = seoqPayload(semrushData && semrushData.rankings);
  if (!payload) return null;

  const bands = payload.summary && payload.summary.position_bands;
  if (bands && Number.isFinite(Number(bands.top3_cumulative))) {
    return {
      top3: Number(bands.top3_cumulative),
      top10: Number(bands.top10_cumulative),
      top20: Number(bands.top20_cumulative),
      tracked: Number(bands.top100_cumulative),
      basis: 'position_bands',
    };
  }

  const rows = Array.isArray(payload.positions)
    ? payload.positions
    : Array.isArray(payload)
      ? payload
      : [];
  if (!rows.length) return null;

  // 一个词可能对应多个 URL，逐行会重复计数，所以按词收敛到最好的自然位次。
  const best = new Map();
  for (const r of rows) {
    if (r && r.positionIsSERPFeature === true) continue; // AI Overview 之类的占位，不是排名
    const kw = String((r && (r.phrase || r.keyword || r.query)) || '');
    if (!kw) continue;
    const pos = Number(r && r.position);
    if (!Number.isFinite(pos) || pos < 1) continue;
    if (!best.has(kw) || pos < best.get(kw)) best.set(kw, pos);
  }
  if (!best.size) return null;
  let top3 = 0;
  let top10 = 0;
  let top20 = 0;
  for (const pos of best.values()) {
    if (pos <= 3) top3++;
    if (pos <= 10) top10++;
    if (pos <= 20) top20++;
  }
  return { top3, top10, top20, tracked: best.size, basis: 'rows' };
}

/** 从 domain_overview 取引荐域总数。summary 优先，退到 backlinks_summary。 */
function refDomains(semrushData) {
  const payload = seoqPayload(semrushData && semrushData.domain_overview);
  if (!payload) return null;
  const cands = [
    payload.summary && payload.summary.referringDomains,
    payload.backlinks_summary && payload.backlinks_summary.referringDomains,
  ];
  for (const c of cands) {
    const n = Number(c);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

/**
 * 排名和引荐域是"拉取当天的一个点"，不是按日连续的量，所以要一个采样日期。
 * 优先用 seoq 信封里的 fetched_at：同一份缓存重跑会写回同一天，重跑幂等；
 * 用"今天"的话，缓存命中的重跑会把昨天的数字盖到今天，凭空造出一个假数据点。
 */
function semrushSampleDate(semrushData, fallbackDate) {
  const parts = [
    semrushData && semrushData.rankings && semrushData.rankings.fetched_at,
    semrushData && semrushData.domain_overview && semrushData.domain_overview.fetched_at,
    semrushData && semrushData.fetched_at,
  ];
  for (const p of parts) {
    const d = normalizeDate(String(p || '').slice(0, 10));
    if (d) return d;
  }
  return fallbackDate || ymd(new Date());
}

// ---------------------------------------------------------------------------
// 快照 -> 指标行
// ---------------------------------------------------------------------------

/**
 * 纯函数：把三个源的快照 data 转成待写入的指标行。不碰网络，单测就测它。
 *
 * gscData 需要带 dates（pull_data 一直就有）和 dates_brand（本期新增，
 * 老快照没有就跳过品牌拆分，不报错）。
 * ga4Data 需要带 dates_organic 和 dates_leads（同样是本期新增）。
 * semrushData 给排名分档和引荐域，按采样日期记一行。
 *
 * 返回 { rows, notes }：rows 是 [{d, m, v}]，notes 是给 log 用的中文说明。
 */
function metricsFromSnapshots(opts = {}) {
  const rows = [];
  const notes = [];
  const push = (d, m, v) => {
    const day = normalizeDate(d);
    if (!day) return;
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    rows.push({ d: day, m, v: n });
  };

  const gsc = opts.gscData;
  if (gsc && Array.isArray(gsc.dates) && gsc.dates.length) {
    for (const r of gsc.dates) {
      push(r.date, 'gsc_impressions', r.impressions);
      push(r.date, 'gsc_clicks', r.clicks);
    }
    notes.push('gsc 按日 ' + gsc.dates.length + ' 天');
  } else {
    notes.push('gsc 快照没有 dates，跳过曝光点击');
  }

  if (gsc && Array.isArray(gsc.dates_brand)) {
    for (const r of gsc.dates_brand) {
      push(r.date, 'gsc_impressions_brand', r.impressions);
      push(r.date, 'gsc_clicks_brand', r.clicks);
    }
    notes.push(
      'gsc 品牌拆分 ' + gsc.dates_brand.length + ' 天（正则来源 ' + (gsc.brand_regex_source || '未记') + '）'
    );
  } else {
    notes.push('gsc 快照没有 dates_brand，跳过品牌拆分');
  }

  const ga4 = opts.ga4Data;
  if (ga4 && Array.isArray(ga4.dates_organic)) {
    for (const r of ga4.dates_organic) push(r.date, 'ga4_sessions_organic', r.sessions);
    notes.push('ga4 自然会话 ' + ga4.dates_organic.length + ' 天');
  } else {
    notes.push('ga4 快照没有 dates_organic，跳过自然会话');
  }
  if (ga4 && Array.isArray(ga4.dates_leads)) {
    for (const r of ga4.dates_leads) push(r.date, 'ga4_leads', r.leads);
    notes.push('ga4 lead 事件 ' + ga4.dates_leads.length + ' 天');
  } else {
    notes.push('ga4 快照没有 dates_leads，跳过 lead');
  }

  const sem = opts.semrushData;
  if (sem) {
    const day = semrushSampleDate(sem, opts.today);
    const b = rankBuckets(sem);
    if (b) {
      push(day, 'rank_top3', b.top3);
      push(day, 'rank_top10', b.top10);
      push(day, 'rank_top20', b.top20);
      push(day, 'rank_tracked', b.tracked);
      notes.push(
        '排名分档 ' + day + '：top3 ' + b.top3 + ' / top10 ' + b.top10 + ' / top20 ' + b.top20 +
          ' / 追踪 ' + b.tracked + '（依据 ' + b.basis + '）'
      );
    } else {
      notes.push('semrush 快照里读不出排名分档，跳过');
    }
    const rd = refDomains(sem);
    if (rd !== null) {
      push(day, 'ref_domains', rd);
      notes.push('引荐域 ' + day + '：' + rd);
    } else {
      notes.push('semrush 快照里读不出引荐域，跳过');
    }
  }

  return { rows, notes };
}

/**
 * 分块 POST /metrics。一次 500 行，远低于服务端 2000 的上限。
 * 幂等靠服务端的 UNIQUE(client_id,d,m)，这里不需要做任何去重。
 */
async function postMetricRows(api, clientId, rows, log) {
  if (!rows || !rows.length) {
    if (log) log('metrics: 没有可写的行');
    return 0;
  }
  let written = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const res = await api.postMetrics(clientId, chunk);
    written += (res && Number(res.rows)) || 0;
  }
  if (log) log('metrics: 已 upsert ' + written + ' 行（共提交 ' + rows.length + ' 行）');
  return written;
}

module.exports = {
  METRICS,
  LEAD_EVENTS,
  ORGANIC_CHANNEL,
  GSC_ROW_LIMIT,
  GSC_QUERY_CHUNK_DAYS,
  chunkRange,
  normalizeDate,
  parseYmd,
  domainLabel,
  nameTokens,
  deriveBrandRegex,
  pullGscDaily,
  pullGscDailyBrand,
  pullGa4OrganicDaily,
  pullGa4LeadsDaily,
  rankBuckets,
  refDomains,
  semrushSampleDate,
  metricsFromSnapshots,
  postMetricRows,
};
