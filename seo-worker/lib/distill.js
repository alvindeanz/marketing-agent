'use strict';
// Briefing distiller for the plan runner. Pure node, zero LLM.
//
// Cost control lives here. Raw snapshots are large and mostly noise, so nothing
// from a snapshot reaches a prompt without passing through this file. The output
// is capped at MAX_BYTES by progressively tightening the row limits.

const { safeJson, truncate } = require('./util');
const capabilities = require('./capabilities');
const registry = require('./registry');

const MAX_BYTES = 15 * 1024;

// Tried in order until the briefing fits.
const LIMIT_STEPS = [
  { queries: 20, pages: 15, rankings: 30, channels: 12, tasks: 60, profileChars: 4000, registryEntries: 40, cannibal: 10 },
  { queries: 16, pages: 12, rankings: 22, channels: 10, tasks: 45, profileChars: 3000, registryEntries: 30, cannibal: 8 },
  { queries: 12, pages: 8, rankings: 15, channels: 8, tasks: 30, profileChars: 2000, registryEntries: 22, cannibal: 6 },
  { queries: 8, pages: 6, rankings: 10, channels: 6, tasks: 20, profileChars: 1200, registryEntries: 14, cannibal: 4 },
];

function num(v, digits) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v == null ? '' : v);
  return digits ? n.toFixed(digits) : String(Math.round(n));
}

function snapshotFor(latest, source) {
  if (!latest) return null;
  if (Array.isArray(latest)) return latest.find((s) => s && s.source === source) || null;
  if (typeof latest === 'object') return latest[source] || null;
  return null;
}

function snapshotData(latest, source) {
  const snap = snapshotFor(latest, source);
  if (!snap) return null;
  const data = safeJson(snap.data, null);
  if (!data) return null;
  return { snap, data };
}

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

function profileSection(profile, limits) {
  if (!profile) return 'CLIENT PROFILE\nnot available';
  const rows = [];
  for (const key of Object.keys(profile)) {
    const v = profile[key];
    if (v === null || v === undefined || v === '') continue;
    const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
    rows.push(key + ': ' + truncate(text, 1200));
  }
  return 'CLIENT PROFILE\n' + truncate(rows.join('\n'), limits.profileChars);
}

function ledgerSection(tasks, limits) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length) return 'EXISTING TASK LEDGER\nempty, this is the first plan';
  const rows = list
    .slice(0, limits.tasks)
    .map((t) =>
      [
        '#' + t.id,
        t.module || 'nomodule',
        t.owner_type || 'noowner',
        t.status || 'nostatus',
        t.title || t.name || '(untitled)',
      ].join(' | ')
    );
  const more = list.length > rows.length ? '\n(and ' + (list.length - rows.length) + ' more)' : '';
  return (
    'EXISTING TASK LEDGER (id | module | owner_type | status | title)\n' + rows.join('\n') + more
  );
}

/** Feedback from a plan a human rejected. Do not repeat a rejected idea. */
function feedbackSection(context, log) {
  const plan = context && context.active_plan;
  const reason = plan && (plan.reject_reason || plan.rejection_reason);
  if (!reason) {
    if (log) log('briefing: no reject_reason available on active_plan, section skipped');
    return null;
  }
  const head = [
    plan.id ? 'plan #' + plan.id : null,
    plan.version ? 'version ' + plan.version : null,
    plan.status ? 'status ' + plan.status : null,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    'PREVIOUS PLAN FEEDBACK' +
    (head ? ' (' + head + ')' : '') +
    '\nA human rejected the previous plan for this reason. Do not repeat the mistake.\n' +
    truncate(String(reason), 2000)
  );
}

/** Sum the daily GSC rows into weekly buckets, oldest first. */
function weeklyTrend(dates) {
  const rows = (Array.isArray(dates) ? dates : [])
    .filter((r) => r && r.date)
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!rows.length) return [];
  const weeks = [];
  for (let i = 0; i < rows.length; i += 7) {
    const chunk = rows.slice(i, i + 7);
    let clicks = 0;
    let impressions = 0;
    let posWeight = 0;
    let posSum = 0;
    for (const r of chunk) {
      clicks += Number(r.clicks) || 0;
      impressions += Number(r.impressions) || 0;
      const w = Number(r.impressions) || 0;
      posSum += (Number(r.position) || 0) * w;
      posWeight += w;
    }
    weeks.push({
      from: chunk[0].date,
      to: chunk[chunk.length - 1].date,
      clicks,
      impressions,
      position: posWeight ? posSum / posWeight : 0,
    });
  }
  return weeks;
}

function gscSection(latest, limits) {
  const found = snapshotData(latest, 'gsc');
  if (!found) return 'SEARCH CONSOLE\nno snapshot on record';
  const { snap, data } = found;
  const out = [
    'SEARCH CONSOLE ' +
      (snap.period_start || '?') +
      ' to ' +
      (snap.period_end || '?') +
      ', spam queries already filtered out (' +
      (data.spam_exclude_regex || 'no filter recorded') +
      ')',
  ];
  if (data.totals) {
    out.push(
      'totals: clicks ' + num(data.totals.clicks) + ', impressions ' + num(data.totals.impressions)
    );
  }

  const queries = (Array.isArray(data.queries) ? data.queries : [])
    .slice()
    .sort((a, b) => (Number(b.clicks) || 0) - (Number(a.clicks) || 0))
    .slice(0, limits.queries);
  if (queries.length) {
    out.push(
      'top queries by clicks (query | clicks | impressions | avg position)\n' +
        queries
          .map(
            (q) =>
              q.query +
              ' | ' +
              num(q.clicks) +
              ' | ' +
              num(q.impressions) +
              ' | ' +
              num(q.position, 1)
          )
          .join('\n')
    );
  }

  const pages = (Array.isArray(data.pages) ? data.pages : [])
    .slice()
    .sort((a, b) => (Number(b.clicks) || 0) - (Number(a.clicks) || 0))
    .slice(0, limits.pages);
  if (pages.length) {
    out.push(
      'top pages by clicks (page | clicks | impressions | avg position)\n' +
        pages
          .map(
            (p) =>
              p.page + ' | ' + num(p.clicks) + ' | ' + num(p.impressions) + ' | ' + num(p.position, 1)
          )
          .join('\n')
    );
  }

  const weeks = weeklyTrend(data.dates);
  if (weeks.length) {
    out.push(
      'weekly trend (week | clicks | impressions | avg position)\n' +
        weeks
          .map(
            (w) =>
              w.from +
              ' to ' +
              w.to +
              ' | ' +
              num(w.clicks) +
              ' | ' +
              num(w.impressions) +
              ' | ' +
              num(w.position, 1)
          )
          .join('\n')
    );
  }
  return out.join('\n');
}

function ga4Section(latest, limits) {
  const found = snapshotData(latest, 'ga4');
  if (!found) return 'GA4\nno snapshot on record';
  const { snap, data } = found;
  const out = ['GA4 ' + (snap.period_start || '?') + ' to ' + (snap.period_end || '?')];
  if (data.totals) {
    out.push(
      'totals: sessions ' +
        num(data.totals.sessions) +
        ', users ' +
        num(data.totals.totalUsers) +
        ', conversions ' +
        num(data.totals.conversions)
    );
  }
  const channels = (Array.isArray(data.channels) ? data.channels : [])
    .slice()
    .sort((a, b) => (Number(b.sessions) || 0) - (Number(a.sessions) || 0))
    .slice(0, limits.channels);
  if (channels.length) {
    out.push(
      'channels (channel | sessions | users | conversions)\n' +
        channels
          .map(
            (c) =>
              (c.sessionDefaultChannelGroup || 'unknown') +
              ' | ' +
              num(c.sessions) +
              ' | ' +
              num(c.totalUsers) +
              ' | ' +
              num(c.conversions || c.keyEvents || 0)
          )
          .join('\n')
    );
  }
  return out.join('\n');
}

/** Unwrap the seoq envelope, which nests the useful payload under data. */
function seoqPayload(part) {
  if (!part) return null;
  if (part.data && typeof part.data === 'object') return part.data;
  return part;
}

function rankingRows(part) {
  const payload = seoqPayload(part);
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  for (const key of ['rankings', 'positions', 'organic', 'keywords', 'rows', 'items']) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function semrushSection(latest, limits) {
  const found = snapshotData(latest, 'semrush');
  if (!found) return 'SEMRUSH\nno snapshot on record';
  const { snap, data } = found;
  const out = [
    'SEMRUSH ' +
      (data.domain || '') +
      ' db ' +
      (data.db || '') +
      ', ' +
      (snap.period_start || '?') +
      ' to ' +
      (snap.period_end || '?'),
  ];
  if (data.errors && data.errors.length) {
    out.push('note: this snapshot is degraded, ' + data.errors.length + ' subcommand failed');
  }

  const overview = seoqPayload(data.domain_overview);
  if (overview) {
    // summary and backlinks_summary are already small, keep them verbatim.
    const picked = {};
    if (overview.summary !== undefined) picked.summary = overview.summary;
    if (overview.backlinks_summary !== undefined) {
      picked.backlinks_summary = overview.backlinks_summary;
    }
    const body = Object.keys(picked).length ? picked : overview;
    out.push('domain overview\n' + truncate(JSON.stringify(body, null, 1), 3000));
  }

  const rows = rankingRows(data.rankings).slice(0, limits.rankings);
  if (rows.length) {
    out.push(
      'rankings top ' +
        rows.length +
        ' (keyword | position | volume | url)\n' +
        rows
          .map((r) => {
            const kw = r.keyword || r.query || r.phrase || '?';
            const pos = r.position !== undefined ? r.position : r.pos !== undefined ? r.pos : '?';
            const vol =
              r.volume !== undefined
                ? r.volume
                : r.search_volume !== undefined
                  ? r.search_volume
                  : '';
            const url = r.url || r.landing_page || '';
            return kw + ' | ' + pos + ' | ' + vol + ' | ' + truncate(String(url), 120);
          })
          .join('\n')
    );
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// platform capabilities
// ---------------------------------------------------------------------------

/**
 * Only the planning view table goes into a plan briefing. The full manifest,
 * with its endpoints and risk notes, belongs to the execute and apply stages.
 */
function capabilitiesSection(profile) {
  const platform = profile && (profile.platform || profile.cms);
  if (!platform) {
    return (
      'PLATFORM CAPABILITIES\n' +
      'The client profile does not say which platform the site runs on, so no capability' +
      '\nmanifest could be loaded. Any task that changes the site goes to owner_type agency.'
    );
  }
  const view = capabilities.planningView(platform);
  if (!view.found) {
    return (
      'PLATFORM CAPABILITIES\n' +
      'Platform is ' +
      platform +
      ', and there is no capability manifest for it. Any task that changes the site goes' +
      '\nto owner_type agency, because nothing has been cleared for an agent to do here.'
    );
  }
  return (
    'PLATFORM CAPABILITIES, platform ' +
    platform +
    '\nThese are the operations an agent can carry out on this site. An operation listed as' +
    '\nagent_apply or agent_prepare can be given to an agent. human_only cannot.\n\n' +
    view.text
  );
}

// ---------------------------------------------------------------------------
// facts ledger
// ---------------------------------------------------------------------------

const FACT_VALUE_CHARS = 400;

/**
 * opts.excludePrefixes: 按 fact_key 前缀丢弃的条目，例如 ['internal.']。
 * 过滤必须发生在 slice 之前：60 条是硬上限且按字典序静默截断，先截后滤
 * 会让内部条目白占名额，客户面能看到的事实凭空变少。
 * 不传 opts 时行为与从前逐字一致。
 */
function factLines(list, limit, opts) {
  const skip = (opts && Array.isArray(opts.excludePrefixes) && opts.excludePrefixes) || [];
  return (list || [])
    .filter((f) => {
      if (!skip.length) return true;
      const key = (f && (f.fact_key || f.key)) || '';
      return !skip.some((p) => p && String(key).indexOf(p) === 0);
    })
    .slice(0, limit || 60)
    .map((f) => {
      const key = (f && (f.fact_key || f.key)) || '(no key)';
      const value = truncate(String((f && f.value) !== undefined ? f.value : ''), FACT_VALUE_CHARS);
      const source = f && f.source ? ' [from ' + f.source + ']' : '';
      return '- ' + key + ': ' + value + source;
    })
    .join('\n');
}

/**
 * The facts ledger. This section exists to stop the same question being asked
 * every quarter, so the wording is directive rather than descriptive.
 */
function factsSection(context, opts) {
  const facts = (context && context.facts) || null;
  const confirmed = (facts && Array.isArray(facts.confirmed) && facts.confirmed) || [];
  const pending = (facts && Array.isArray(facts.pending) && facts.pending) || [];
  if (!confirmed.length && !pending.length) {
    return 'FACTS LEDGER\nnothing on record yet. Anything you need to know about this client is still an open question.';
  }
  const blocks = ['FACTS LEDGER'];
  if (confirmed.length) {
    blocks.push(
      'CONFIRMED, a human has verified these. They are settled. Do not ask for them again,' +
        '\ndo not list them as unknowns, and do not create a task to go and find them out.\n' +
        factLines(confirmed, null, opts)
    );
  } else {
    blocks.push('CONFIRMED\nnone yet');
  }
  if (pending.length) {
    blocks.push(
      'PENDING, an agent checked these and a human has not confirmed them yet. You may' +
        '\nrely on them, but say "pending confirmation" whenever you do.\n' +
        factLines(pending, null, opts)
    );
  }
  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// content registry and cannibalisation
// ---------------------------------------------------------------------------

/**
 * The site's own content, enumerated from the platform, plus the query level
 * cannibalisation signal. Planning without this section is how a quarter ends
 * up proposing an article the site already has.
 */
function contentRegistrySection(context, limits) {
  const found = snapshotData(context && context.latest_snapshots, registry.SOURCE);
  if (!found) {
    return (
      'SITE CONTENT REGISTRY\n' +
      '还没有站内内容注册表快照，也就没有蚕食信号。跑一次 pull_data 会顺带生成它。\n' +
      '在拿到这张表之前，不许断言站上缺某个主题，也不许断言站上没有蚕食问题：那是没测量。'
    );
  }
  return (
    'SITE CONTENT REGISTRY, 快照日期 ' +
    (found.snap.created_at || '未知') +
    '\n' +
    registry.registryBlock(found.data, {
      maxEntries: limits.registryEntries,
      maxSignals: limits.cannibal,
      compact: true,
    })
  );
}

// ---------------------------------------------------------------------------
// discovery dossier
// ---------------------------------------------------------------------------

const DOSSIER_MAX_BYTES = 8 * 1024;
const DOSSIER_STALE_DAYS = 100;

/**
 * What we know about the newest discovery dossier, without rendering it.
 * Returns { present, date, ageDays, specVersion, unknowns, id, hydrated }.
 */
function dossierMeta(context) {
  const snap = snapshotFor(context && context.latest_snapshots, 'discovery');
  if (!snap) return { present: false, hydrated: false };
  const data = safeJson(snap.data, null);
  const dateStr =
    (data && data.generated_at) || snap.period_end || snap.created_at || null;
  let ageDays = null;
  if (dateStr) {
    const t = Date.parse(String(dateStr).replace(' ', 'T'));
    if (Number.isFinite(t)) ageDays = Math.floor((Date.now() - t) / 86400000);
  }
  return {
    present: true,
    hydrated: !!(data && data.dossier_md),
    id: snap.id !== undefined ? snap.id : null,
    date: dateStr ? String(dateStr).slice(0, 10) : null,
    ageDays,
    stale: ageDays !== null && ageDays > DOSSIER_STALE_DAYS,
    specVersion: (data && data.spec_version) || null,
    unknowns: (data && Array.isArray(data.unknowns) && data.unknowns) || [],
  };
}

/**
 * The dossier is already a distilled artifact, so it is quoted rather than
 * re summarised. Only the size cap applies.
 */
function dossierSection(context) {
  const meta = dossierMeta(context);
  if (!meta.present) {
    return (
      'DISCOVERY DOSSIER\nnone on record. There has been no structural survey of this' +
      ' client, so competitive and authority questions are open. Say so in Data gaps.'
    );
  }
  const snap = snapshotFor(context.latest_snapshots, 'discovery');
  const data = safeJson(snap.data, {}) || {};
  const md = String(data.dossier_md || '');
  const head =
    'DISCOVERY DOSSIER, spec ' +
    (meta.specVersion || 'unknown') +
    ', dated ' +
    (meta.date || 'unknown') +
    (meta.ageDays === null ? '' : ', ' + meta.ageDays + ' days old') +
    (meta.stale ? ' (older than ' + DOSSIER_STALE_DAYS + ' days, treat its conclusions with care)' : '');
  if (!md) {
    return (
      head +
      '\nthe dossier body could not be loaded, only its metadata is available.' +
      (meta.unknowns.length ? '\nrecorded unknowns:\n- ' + meta.unknowns.join('\n- ') : '')
    );
  }
  let body = md;
  if (Buffer.byteLength(body, 'utf8') > DOSSIER_MAX_BYTES) {
    body =
      body.slice(0, DOSSIER_MAX_BYTES - 200) +
      '\n\n[dossier truncated here to fit the briefing budget. The full dossier is stored' +
      ' in the discovery snapshot. Anything you need from the missing part counts as a' +
      ' data gap, not as a fact.]';
  }
  const unknowns = meta.unknowns.length
    ? '\n\nRECORDED UNKNOWNS FROM THE DOSSIER\n- ' + meta.unknowns.join('\n- ')
    : '';
  return head + '\nEvery conclusion below carries its own confidence label. Carry the label\nthrough when you cite it.\n\n' + body + unknowns;
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

function assemble(context, limits, log) {
  const latest = context && context.latest_snapshots;
  const blocks = [
    profileSection(context && context.profile, limits),
    capabilitiesSection(context && context.profile),
    factsSection(context),
    ledgerSection(context && context.tasks, limits),
    feedbackSection(context, log),
    contentRegistrySection(context, limits),
    gscSection(latest, limits),
    ga4Section(latest, limits),
    semrushSection(latest, limits),
  ].filter(Boolean);
  return blocks.join('\n\n');
}

/**
 * Build the planning briefing. Returns { text, bytes, step, dataBytes,
 * dossierBytes, dossier }.
 *
 * The data blocks are fitted to MAX_BYTES by tightening row limits. The dossier
 * is appended after that fit and carries its own 8KB cap, because it is already
 * a distilled artifact and squeezing the tables to make room for it would trade
 * good information for good information.
 */
function buildPlanningBriefing(context, opts = {}) {
  const maxBytes = opts.maxBytes || MAX_BYTES;
  const log = opts.log;
  let text = '';
  let step = 0;
  for (let i = 0; i < LIMIT_STEPS.length; i += 1) {
    step = i;
    text = assemble(context, LIMIT_STEPS[i], i === 0 ? log : null);
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) break;
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    text =
      text.slice(0, maxBytes - 80) + '\n\n[briefing truncated to fit the size budget]';
  }
  const dataBytes = Buffer.byteLength(text, 'utf8');

  const meta = dossierMeta(context);
  const dossier = dossierSection(context);
  text = text + '\n\n' + dossier;

  return {
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    dataBytes,
    dossierBytes: Buffer.byteLength(dossier, 'utf8'),
    step,
    dossier: meta,
  };
}

module.exports = {
  buildPlanningBriefing,
  capabilitiesSection,
  contentRegistrySection,
  factsSection,
  factLines,
  dossierMeta,
  dossierSection,
  weeklyTrend,
  MAX_BYTES,
  LIMIT_STEPS,
  DOSSIER_MAX_BYTES,
  DOSSIER_STALE_DAYS,
};
