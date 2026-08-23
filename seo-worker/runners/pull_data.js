'use strict';
// pull_data runner: fetch GSC and GA4 baselines and store them as snapshots.
// Zero LLM. Pure data plumbing, safe to run as often as a human asks.

const { googlePost } = require('../lib/google');
const { seoq, rootDomain } = require('../lib/seoq');
const { reportWindow, safeJson } = require('../lib/util');
const registry = require('../lib/registry');
const metrics = require('../lib/metrics');

const GSC_SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly'];
const GA4_SCOPES = ['https://www.googleapis.com/auth/analytics.readonly'];

const WINDOW_DAYS = 28;
const LAG_DAYS = 3; // GSC data is not complete for the last couple of days
const ROW_LIMIT = 100;
// query x page pairs. This is the only dimension that can prove cannibalisation,
// and it is the wide one, so it gets its own bigger limit.
const PAIR_ROW_LIMIT = 1000;

// GA4 renamed conversions to keyEvents. Try in order, keep the first that works.
const GA4_METRIC_SETS = [
  ['sessions', 'totalUsers', 'conversions'],
  ['sessions', 'totalUsers', 'keyEvents'],
  ['sessions', 'totalUsers'],
];

// ---------------------------------------------------------------------------
// snapshot cache
// ---------------------------------------------------------------------------

/**
 * Parse a MySQL DATETIME string. It carries no timezone suffix, so it is read
 * as server local time. An hour or two of drift does not matter here.
 * Returns null when it cannot be parsed, which the caller treats as a miss.
 */
function parseMysqlDatetime(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) {
    const loose = new Date(s);
    return Number.isNaN(loose.getTime()) ? null : loose;
  }
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] || 0)
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** latest_snapshots is keyed by source, but tolerate an array too. */
function snapshotFor(latest, source) {
  if (!latest) return null;
  if (Array.isArray(latest)) return latest.find((s) => s && s.source === source) || null;
  if (typeof latest === 'object') return latest[source] || null;
  return null;
}

/**
 * Decide whether to skip a source. Returns { skip, ageHours, reason }.
 * Anything unparseable or missing counts as a miss, so we pull fresh.
 */
function cacheCheck(ctx, latest, source) {
  const { cfg, log, fresh } = ctx;
  if (fresh) {
    log(source + ': payload.fresh set, cache bypassed');
    return { skip: false };
  }
  const ttl = Number(cfg.cacheTtlHours);
  if (!(ttl > 0)) return { skip: false };

  const snap = snapshotFor(latest, source);
  if (!snap) return { skip: false };

  const created = parseMysqlDatetime(snap.created_at);
  if (!created) {
    log(source + ': latest snapshot has no usable created_at, pulling fresh');
    return { skip: false };
  }
  const ageHours = (Date.now() - created.getTime()) / 3600000;
  if (ageHours >= ttl) return { skip: false, ageHours };

  const shown = Math.round(Math.max(ageHours, 0) * 10) / 10;
  log(
    source +
      ': cache hit (age ' +
      shown +
      'h), skipped. Covers ' +
      (snap.period_start || '?') +
      ' to ' +
      (snap.period_end || '?') +
      '. Queue with payload.fresh=true to force a pull.'
  );
  return { skip: true, ageHours };
}

function gscUrl(property) {
  return (
    'https://www.googleapis.com/webmasters/v3/sites/' +
    encodeURIComponent(property) +
    '/searchAnalytics/query'
  );
}

/** Exclude the spam query cluster this client was hit with. Baselines must be clean. */
function spamFilterGroups(regex) {
  return [
    {
      groupType: 'and',
      filters: [
        {
          dimension: 'query',
          operator: 'excludingRegex',
          expression: regex,
        },
      ],
    },
  ];
}

function gscRows(res, dimensionNames) {
  const rows = (res && res.rows) || [];
  return rows.map((r) => {
    const out = {
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      ctr: r.ctr || 0,
      position: r.position || 0,
    };
    (r.keys || []).forEach((k, i) => {
      out[dimensionNames[i] || 'key' + i] = k;
    });
    return out;
  });
}

async function gscQuery(cfg, property, body) {
  return googlePost(cfg.ga4KeyFile, GSC_SCOPES, gscUrl(property), body, cfg.httpTimeoutMs);
}

async function pullGsc(ctx, profile, win, clientName) {
  const { cfg, log, api, job } = ctx;
  const property = profile && (profile.gsc_property || profile.gsc_site);
  if (!property) {
    log('gsc: profile has no gsc_property, skipped');
    return null;
  }
  const regex = cfg.gscSpamExcludeRegex;
  const base = {
    startDate: win.start,
    endDate: win.end,
    dimensionFilterGroups: spamFilterGroups(regex),
  };
  log('gsc: property ' + property + ', window ' + win.start + ' to ' + win.end + ', spam filter ' + regex);

  const byQuery = await gscQuery(cfg, property, Object.assign({}, base, {
    dimensions: ['query'],
    rowLimit: ROW_LIMIT,
  }));
  log('gsc: query rows ' + ((byQuery && byQuery.rows) || []).length);

  const byPage = await gscQuery(cfg, property, Object.assign({}, base, {
    dimensions: ['page'],
    rowLimit: ROW_LIMIT,
  }));
  log('gsc: page rows ' + ((byPage && byPage.rows) || []).length);

  // Daily trend, same spam filter so the trend line matches the tables.
  const byDate = await gscQuery(cfg, property, Object.assign({}, base, {
    dimensions: ['date'],
    rowLimit: 500,
  }));
  log('gsc: date rows ' + ((byDate && byDate.rows) || []).length);

  // query x page pairs. Without this dimension there is no way to know which
  // URL answered which query, and the cannibalisation check would have to guess.
  // It never guesses: a missing query_pages field degrades the signal to
  // "not computable" rather than to an invented mapping.
  let queryPages = [];
  try {
    const byQueryPage = await gscQuery(cfg, property, Object.assign({}, base, {
      dimensions: ['query', 'page'],
      rowLimit: PAIR_ROW_LIMIT,
    }));
    queryPages = gscRows(byQueryPage, ['query', 'page']);
    log('gsc: query x page rows ' + queryPages.length);
  } catch (e) {
    // The three single dimension pulls above are the baseline and already
    // succeeded. Losing the pair dimension costs the cannibalisation signal,
    // not the snapshot, so it degrades instead of failing.
    log('gsc: query x page dimension FAILED, cannibalisation signal will be unavailable :: ' + e.message);
  }

  // 品牌词按日拆分。date x query 两维 GSC 一次就能给，逐行判品牌再按日汇总。
  // 拿不到品牌正则（客户名和域名都推不出来）时整段跳过，不写一个假的 0。
  // 失败只降级：品牌拆分没了趋势图少一条线，基线三块数据一点不受影响。
  let datesBrand = null;
  const brand = metrics.deriveBrandRegex({
    brandRegex: profile && profile.brand_regex,
    clientName,
    domain: profile && profile.domain,
  });
  if (brand.error) log('gsc: ' + brand.error + '，改用推导');
  if (brand.regex) {
    log('gsc: 品牌正则 /' + brand.pattern + '/i，来源 ' + brand.source);
    try {
      datesBrand = await metrics.pullGscDailyBrand(ctx, property, win, regex, brand.regex);
    } catch (e) {
      log('gsc: 品牌拆分 FAILED，趋势图会少一条品牌线 :: ' + e.message);
    }
  } else {
    log('gsc: 推不出品牌正则（profile.brand_regex 为空且客户名/域名不可用），跳过品牌拆分');
  }

  const queries = gscRows(byQuery, ['query']);
  const pages = gscRows(byPage, ['page']);
  const dates = gscRows(byDate, ['date']);
  const totals = dates.reduce(
    (acc, r) => {
      acc.clicks += r.clicks;
      acc.impressions += r.impressions;
      return acc;
    },
    { clicks: 0, impressions: 0 }
  );

  const data = {
    property,
    window_days: WINDOW_DAYS,
    lag_days: LAG_DAYS,
    spam_exclude_regex: regex,
    fetched_at: new Date().toISOString(),
    // Carried inside the payload too, so a consumer holding only the data blob
    // still knows what window the cannibalisation signal covers.
    period_start: win.start,
    period_end: win.end,
    totals,
    queries,
    pages,
    query_pages: queryPages,
    dates,
    // 本期新增，供 seo_metrics_daily 的品牌拆分用。老快照没有这几个字段，
    // metricsFromSnapshots 读不到就跳过，不会炸。
    dates_brand: datesBrand,
    brand_regex: brand.pattern || null,
    brand_regex_source: brand.source,
  };

  await api.postSnapshot({
    client_id: job.client_id,
    source: 'gsc',
    period_start: win.start,
    period_end: win.end,
    data,
  });
  log(
    'gsc: snapshot posted, ' +
      queries.length +
      ' queries, ' +
      pages.length +
      ' pages, ' +
      queryPages.length +
      ' query x page pairs, ' +
      totals.clicks +
      ' clicks, ' +
      totals.impressions +
      ' impressions'
  );
  return { queries: queries.length, pages: pages.length, totals, data };
}

function ga4Url(propertyId) {
  const id = String(propertyId).replace(/^properties\//, '');
  return 'https://analyticsdata.googleapis.com/v1beta/properties/' + encodeURIComponent(id) + ':runReport';
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

/** Run a GA4 report, falling back through metric sets when a metric is rejected. */
async function ga4Report(ctx, propertyId, dimensions, win) {
  const { cfg, log } = ctx;
  let lastErr = null;
  for (const metrics of GA4_METRIC_SETS) {
    const body = {
      dateRanges: [{ startDate: win.start, endDate: win.end }],
      dimensions: dimensions.map((name) => ({ name })),
      metrics: metrics.map((name) => ({ name })),
      limit: 500,
    };
    try {
      const res = await googlePost(cfg.ga4KeyFile, GA4_SCOPES, ga4Url(propertyId), body, cfg.httpTimeoutMs);
      return { res, metrics };
    } catch (e) {
      lastErr = e;
      if (e.status === 400) {
        log('ga4: metric set [' + metrics.join(',') + '] rejected, trying a narrower set');
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('ga4: every metric set failed');
}

async function pullGa4(ctx, profile, win) {
  const { log, api, job } = ctx;
  const propertyId = profile && (profile.ga4_property || profile.ga4_property_id);
  if (!propertyId) {
    log('ga4: profile has no ga4_property, skipped');
    return null;
  }
  log('ga4: property ' + propertyId + ', window ' + win.start + ' to ' + win.end);

  const daily = await ga4Report(ctx, propertyId, ['date'], win);
  const dates = ga4Rows(daily.res);
  log('ga4: daily rows ' + dates.length + ', metrics [' + daily.metrics.join(',') + ']');

  const byChannel = await ga4Report(ctx, propertyId, ['sessionDefaultChannelGroup'], win);
  const channels = ga4Rows(byChannel.res);
  log('ga4: channel rows ' + channels.length);

  // 按日的自然会话和 lead 事件，供 seo_metrics_daily 用。上面那两块是窗口汇总，
  // 画不了逐层转化率曲线，这两块才是按天的。任一失败只降级，基线快照照存。
  let datesOrganic = null;
  let datesLeads = null;
  try {
    datesOrganic = await metrics.pullGa4OrganicDaily(ctx, propertyId, win);
  } catch (e) {
    log('ga4: 按日自然会话 FAILED :: ' + e.message);
  }
  try {
    datesLeads = await metrics.pullGa4LeadsDaily(ctx, propertyId, win);
  } catch (e) {
    log('ga4: 按日 lead 事件 FAILED :: ' + e.message);
  }

  const totals = dates.reduce(
    (acc, r) => {
      acc.sessions += Number(r.sessions) || 0;
      acc.totalUsers += Number(r.totalUsers) || 0;
      acc.conversions += Number(r.conversions || r.keyEvents) || 0;
      return acc;
    },
    { sessions: 0, totalUsers: 0, conversions: 0 }
  );

  const data = {
    property: String(propertyId),
    window_days: WINDOW_DAYS,
    metrics: daily.metrics,
    fetched_at: new Date().toISOString(),
    totals,
    dates,
    channels,
    // 本期新增。dates_organic 是 Organic Search 渠道的按日会话，
    // dates_leads 是 form_submit + generate_lead + click_to_call 的按日之和。
    dates_organic: datesOrganic,
    dates_leads: datesLeads,
    lead_events: metrics.LEAD_EVENTS,
  };

  await api.postSnapshot({
    client_id: job.client_id,
    source: 'ga4',
    period_start: win.start,
    period_end: win.end,
    data,
  });
  log('ga4: snapshot posted, ' + totals.sessions + ' sessions, ' + totals.totalUsers + ' users');
  return { totals, data };
}

// ---------------------------------------------------------------------------
// semrush, through the internal seoq gate
// ---------------------------------------------------------------------------

/**
 * Pull SEMrush through seoq. Partial success is fine: one subcommand failing
 * still stores the other. Both failing degrades the section, it never fails
 * the whole job.
 */
async function pullSemrush(ctx, profile, win) {
  const { cfg, log, api, job } = ctx;
  const domain = rootDomain(profile);
  if (!domain) {
    log('semrush: profile has no domain, skipped');
    return { status: 'skipped' };
  }
  const db = cfg.semrushDb;
  log('semrush: domain ' + domain + ', db ' + db);

  const wanted = [
    { key: 'domain_overview', cmd: 'domain-overview --domain ' + domain + ' --db ' + db },
    { key: 'rankings', cmd: 'rankings --domain ' + domain + ' --db ' + db },
  ];

  const parts = {};
  const errors = [];
  for (const item of wanted) {
    try {
      const res = await seoq(cfg, item.cmd, log);
      parts[item.key] = res;
      log('semrush: ' + item.key + ' ok, fetched_at ' + (res.fetched_at || 'unknown'));
    } catch (e) {
      log('semrush: ' + item.key + ' FAILED :: ' + e.message);
      errors.push(item.key + ': ' + e.message);
    }
  }

  if (!Object.keys(parts).length) {
    log('semrush: degraded, both subcommands failed, nothing stored. gsc and ga4 are unaffected');
    return { status: 'error', errors };
  }

  const data = {
    domain,
    db,
    gate: 'seoq',
    fetched_at: new Date().toISOString(),
    domain_overview: parts.domain_overview || null,
    rankings: parts.rankings || null,
  };
  if (errors.length) data.errors = errors;

  await api.postSnapshot({
    client_id: job.client_id,
    source: 'semrush',
    period_start: win.start,
    period_end: win.end,
    data,
  });
  log(
    'semrush: snapshot posted with ' +
      Object.keys(parts).join(' and ') +
      (errors.length ? ', degraded, ' + errors.length + ' subcommand failed' : '')
  );
  return { status: errors.length ? 'partial' : 'ok', errors, data };
}

// ---------------------------------------------------------------------------
// content registry, through the platform API
// ---------------------------------------------------------------------------

/**
 * Enumerate every page, collection, collection item and blog post (drafts
 * included) on the client's platform, attach the cannibalisation signal
 * computed from the GSC pull, and store the lot as one snapshot.
 *
 * Zero LLM. Everything in here is an API read plus deterministic string work.
 *
 * gscData is the payload from this run's GSC pull when there was one; when GSC
 * came from cache the caller passes the cached snapshot's data instead. Either
 * way the signal is computed from real stored rows, never invented.
 *
 * Never fails the job: a client on a platform we have no client for, or a
 * missing credentials file, degrades to a logged skip. The registry is a
 * safety net, and a safety net that takes the pipeline down with it is worse
 * than no net.
 */
async function pullContentRegistry(ctx, profile, win, gscData) {
  const { cfg, log, api, job } = ctx;
  const platform = (profile && (profile.platform || profile.cms)) || '';
  if (!platform) {
    log('content_registry: profile 没有 platform 字段，跳过');
    return { status: 'skipped' };
  }
  // The enumerator is WebForger specific. Another platform is not an error, it
  // just has no registry until someone writes its client.
  if (String(platform).toLowerCase().indexOf('webforger') === -1) {
    log('content_registry: platform "' + platform + '" 还没有枚举实现，跳过');
    return { status: 'skipped' };
  }

  let client;
  try {
    const opened = await registry.openClient(cfg, profile, log);
    client = opened.client;
  } catch (e) {
    log('content_registry: 登录平台失败，跳过 :: ' + e.message);
    return { status: 'skipped', error: e.message };
  }

  const reg = await registry.buildRegistry({ client, profile, log });
  reg.cannibal = registry.cannibalSignals(gscData || null);
  if (reg.cannibal.available) {
    log(
      'content_registry: 蚕食扫描 ' +
        reg.cannibal.rows_scanned +
        ' 行 / ' +
        reg.cannibal.queries_scanned +
        ' 个 query，命中 ' +
        reg.cannibal.signal_count +
        ' 条信号（互抢明显 ' +
        reg.cannibal.high_count +
        ' 条）'
    );
  } else {
    log('content_registry: ' + reg.cannibal.reason);
  }

  await api.postSnapshot({
    client_id: job.client_id,
    source: registry.SOURCE,
    period_start: win.start,
    period_end: win.end,
    data: reg,
  });
  log(
    'content_registry: 快照已提交，共 ' +
      reg.total +
      ' 条（博文 ' +
      (reg.counts.post || 0) +
      '，其中草稿 ' +
      (reg.counts.post_draft || 0) +
      '；页面 ' +
      (reg.counts.page || 0) +
      '；collection ' +
      (reg.counts.collection || 0) +
      '；产品条目 ' +
      (reg.counts.collection_item || 0) +
      '）' +
      (reg.notes.length ? '，' + reg.notes.length + ' 处缺口' : '')
  );
  for (const n of reg.notes) log('content_registry: 缺口 :: ' + n);
  return { status: 'ok', total: reg.total };
}

/**
 * Refresh every source, honouring the snapshot cache. Shared with the plan
 * runner so a planning run always sits on top of current data.
 * opts: { fresh, context } . Returns { errors, skipped, profile, window }.
 * Never throws for a source failure, the caller decides what that means.
 */
async function refreshSources(ctx, opts = {}) {
  const { job, api, log } = ctx;
  const context = opts.context || (await api.getContext(job.client_id));
  const profile = (context && context.profile) || null;
  if (!profile) throw new Error('context returned no profile for client_id ' + job.client_id);
  log('profile loaded: ' + (profile.name || profile.slug || job.client_id));

  const win = reportWindow(WINDOW_DAYS, LAG_DAYS);
  const latest = context.latest_snapshots;
  const fresh =
    opts.fresh !== undefined ? !!opts.fresh : !!(job.payload && job.payload.fresh === true);
  const cacheCtx = Object.assign({}, ctx, { fresh });
  log(
    fresh
      ? 'payload.fresh=true, pulling every source regardless of cache'
      : 'cache ttl ' + ctx.cfg.cacheTtlHours + 'h'
  );
  const errors = [];
  const skipped = {};

  // Kept so the registry step can compute the cannibalisation signal from the
  // rows this run actually pulled, without a second read of the API.
  // ga4Data / semrushData 是同样的道理，供后面的时序指标写入用：缓存命中时
  // 直接读 /context 已经解好的旧快照，不为了写指标再拉一次外部接口。
  let gscData = null;
  let ga4Data = null;
  let semrushData = null;
  const clientName = (context && context.client && context.client.name) || '';

  skipped.gsc = cacheCheck(cacheCtx, latest, 'gsc').skip;
  if (!skipped.gsc) {
    try {
      const res = await pullGsc(ctx, profile, win, clientName);
      gscData = (res && res.data) || null;
    } catch (e) {
      log('gsc: FAILED :: ' + e.message);
      errors.push('gsc: ' + e.message);
    }
  } else {
    // Cache hit: /context already handed us the decoded blob, reuse it rather
    // than re-pulling GSC just to feed the signal.
    const cachedGsc = snapshotFor(latest, 'gsc');
    gscData = cachedGsc ? safeJson(cachedGsc.data, null) : null;
  }

  skipped.ga4 = cacheCheck(cacheCtx, latest, 'ga4').skip;
  if (!skipped.ga4) {
    try {
      const res = await pullGa4(ctx, profile, win);
      ga4Data = (res && res.data) || null;
    } catch (e) {
      log('ga4: FAILED :: ' + e.message);
      errors.push('ga4: ' + e.message);
    }
  } else {
    const cachedGa4 = snapshotFor(latest, 'ga4');
    ga4Data = cachedGa4 ? safeJson(cachedGa4.data, null) : null;
  }

  // SEMrush never fails the job. Worst case the section is degraded and the
  // log says so, because gsc and ga4 are the baseline that actually matters.
  skipped.semrush = cacheCheck(cacheCtx, latest, 'semrush').skip;
  if (!skipped.semrush) {
    try {
      const res = await pullSemrush(ctx, profile, win);
      semrushData = (res && res.data) || null;
    } catch (e) {
      log('semrush: degraded, unexpected error :: ' + (e.stack || e.message));
    }
  } else {
    const cachedSem = snapshotFor(latest, 'semrush');
    semrushData = cachedSem ? safeJson(cachedSem.data, null) : null;
  }

  // 时序写入。跑在三个源之后，读的全是刚才存下（或缓存里读回）的快照数据，
  // 不再额外打任何外部接口。幂等：同一窗口重跑只覆盖同名同日的值。
  // 和 semrush 一样绝不拖垮 job：写指标失败只是趋势图少一段，快照已经落地了。
  try {
    const { rows, notes } = metrics.metricsFromSnapshots({ gscData, ga4Data, semrushData });
    for (const n of notes) log('metrics: ' + n);
    await metrics.postMetricRows(ctx.api, job.client_id, rows, log);
  } catch (e) {
    log('metrics: 写入失败，降级，快照不受影响 :: ' + (e.stack || e.message));
  }

  // The content registry runs last, because it wants the GSC rows this pass
  // just stored. It never fails the job, same rule as semrush.
  skipped.content_registry = cacheCheck(cacheCtx, latest, registry.SOURCE).skip;
  if (!skipped.content_registry) {
    try {
      await pullContentRegistry(ctx, profile, win, gscData);
    } catch (e) {
      log('content_registry: degraded, unexpected error :: ' + (e.stack || e.message));
    }
  }

  return { errors, skipped, profile, window: win };
}

async function run(ctx) {
  const res = await refreshSources(ctx);
  if (res.errors.length) {
    throw new Error('pull_data finished with errors :: ' + res.errors.join(' | '));
  }
  return { tokenUsage: 0 };
}

module.exports = {
  run,
  refreshSources,
  pullContentRegistry,
  rootDomain,
  parseMysqlDatetime,
  cacheCheck,
  snapshotFor,
  WINDOW_DAYS,
  LAG_DAYS,
};
