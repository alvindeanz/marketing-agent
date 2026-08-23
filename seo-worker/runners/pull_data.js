'use strict';
// pull_data runner: fetch GSC and GA4 baselines and store them as snapshots.
// Zero LLM. Pure data plumbing, safe to run as often as a human asks.

const { googlePost } = require('../lib/google');
const { seoq, rootDomain } = require('../lib/seoq');
const { reportWindow, safeJson } = require('../lib/util');
const registry = require('../lib/registry');

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

async function pullGsc(ctx, profile, win) {
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
  };

  await api.postSnapshot({
    client_id: job.client_id,
    source: 'ga4',
    period_start: win.start,
    period_end: win.end,
    data,
  });
  log('ga4: snapshot posted, ' + totals.sessions + ' sessions, ' + totals.totalUsers + ' users');
  return totals;
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
  return { status: errors.length ? 'partial' : 'ok', errors };
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
  let gscData = null;

  skipped.gsc = cacheCheck(cacheCtx, latest, 'gsc').skip;
  if (!skipped.gsc) {
    try {
      const res = await pullGsc(ctx, profile, win);
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
      await pullGa4(ctx, profile, win);
    } catch (e) {
      log('ga4: FAILED :: ' + e.message);
      errors.push('ga4: ' + e.message);
    }
  }

  // SEMrush never fails the job. Worst case the section is degraded and the
  // log says so, because gsc and ga4 are the baseline that actually matters.
  skipped.semrush = cacheCheck(cacheCtx, latest, 'semrush').skip;
  if (!skipped.semrush) {
    try {
      await pullSemrush(ctx, profile, win);
    } catch (e) {
      log('semrush: degraded, unexpected error :: ' + (e.stack || e.message));
    }
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
