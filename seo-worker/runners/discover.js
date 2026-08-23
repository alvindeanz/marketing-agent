'use strict';
// discover runner: the structural survey that a plan run stands on.
//
// Two stages, and the split is the whole point:
//   script stage, zero LLM, gathers raw material through the seoq gate, the
//   sitemap and the existing snapshots, and writes it to disk
//   analysis stage, one model pass over a distilled version of that material,
//   producing a dossier with a confidence label on every conclusion
//
// Depth is triggered by the material, per specs/discover.md, not by a fixed
// quota. The model may ask for one round of extra gate calls, capped at
// T2_CALL_BUDGET, and the runner is the one that decides whether each requested
// command is allowed to run.

const fs = require('node:fs');
const path = require('node:path');

const { seoq, rootDomain, sanitizeSubcommand, CallBudget, rowsOf, payloadOf } = require('../lib/seoq');
const sitemap = require('../lib/sitemap');
const { factsSection } = require('../lib/distill');
const { runClaude } = require('../lib/llm');
const { extractTrailingJson, extractFencedLines } = require('../lib/mdjson');
const { ensureClientWorkspace, localYmd, truncate, safeJson } = require('../lib/util');

const SPEC_VERSION = 'v2';
const SPEC_PATH = path.join(__dirname, '..', 'specs', 'discover.md');
const T2_CALL_BUDGET = 10;
const MATERIAL_MAX_BYTES = 20 * 1024;
// Machine anchors. These are Chinese because the dossier is an internal
// document, and they must match specs/discover.md character for character.
const REQUIRED_HEADINGS = [
  '## 竞争格局',
  '## 关键词全集',
  '## 权威度差距',
  '## 本地格局',
  '## 季节性与内容形态',
  '## 未知项',
];

// Row limits, tightened in order until the material fits the byte budget.
const MATERIAL_STEPS = [
  { gap: 40, competitors: 10, rankings: 40, queries: 25, sitemapSections: 25 },
  { gap: 28, competitors: 8, rankings: 28, queries: 20, sitemapSections: 18 },
  { gap: 18, competitors: 6, rankings: 18, queries: 15, sitemapSections: 12 },
  { gap: 12, competitors: 5, rankings: 12, queries: 10, sitemapSections: 8 },
];

// Enough to spot local intent in New Zealand queries without a paid dataset.
const NZ_PLACE_WORDS = [
  'auckland', 'wellington', 'christchurch', 'hamilton', 'tauranga', 'dunedin',
  'napier', 'hastings', 'palmerston', 'nelson', 'rotorua', 'whangarei',
  'invercargill', 'queenstown', 'new plymouth', 'gisborne', 'timaru', 'taupo',
  'north shore', 'manukau', 'waikato', 'canterbury', 'otago', 'bay of plenty',
  'northland', 'nz', 'new zealand', 'near me',
];

function localIntentShare(queries) {
  const list = (queries || []).map((q) => String(q.query || q.keyword || '').toLowerCase());
  if (!list.length) return { queries_checked: 0, local_queries: 0, share: 0 };
  const hits = list.filter((q) => NZ_PLACE_WORDS.some((w) => q.includes(w)));
  return {
    queries_checked: list.length,
    local_queries: hits.length,
    share: Math.round((hits.length / list.length) * 1000) / 1000,
    sample: hits.slice(0, 8),
  };
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
  return safeJson(snap.data, null);
}

function writeRaw(dir, name, value, log) {
  const file = path.join(dir, name + '.json');
  const text = JSON.stringify(value, null, 1);
  fs.writeFileSync(file, text, 'utf8');
  log('material: ' + name + '.json, ' + Buffer.byteLength(text, 'utf8') + ' bytes');
  return file;
}

// ---------------------------------------------------------------------------
// script stage
// ---------------------------------------------------------------------------

/** Best guess at the competitor domain field, across gate payload shapes. */
function competitorDomain(row) {
  return String(row.domain || row.competitor || row.site || row.url || '')
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
}

function competitorOverlap(row) {
  const v = row.common_keywords !== undefined ? row.common_keywords : row.commonKeywords;
  return Number(v) || 0;
}

async function collect(ctx, profile, context, workspace) {
  const { cfg, log } = ctx;
  const root = rootDomain(profile);
  if (!root) throw new Error('cannot derive a root domain from the client profile');
  const db = cfg.semrushDb;
  // Local date, so the snapshot period matches the day the board is showing.
  const today = localYmd();
  const rawDir = path.join(workspace, 'temp', 'discover-' + today);
  fs.mkdirSync(rawDir, { recursive: true });
  log('script stage: root ' + root + ', db ' + db + ', raw material in ' + rawDir);

  const raw = {};
  const errors = [];
  let calls = 0;

  async function gate(name, command) {
    const started = Date.now();
    try {
      const res = await seoq(cfg, command, log);
      calls += 1;
      raw[name] = res;
      writeRaw(rawDir, name, res, log);
      log(name + ': ok in ' + Math.round((Date.now() - started) / 1000) + 's');
      return res;
    } catch (e) {
      calls += 1;
      log(name + ': FAILED :: ' + e.message);
      errors.push(name + ': ' + e.message);
      return null;
    }
  }

  // 1. organic competitors
  await gate('competitors', 'competitors --domain ' + root + ' --db ' + db);

  // 2. own rankings, reused from the semrush snapshot when one is already stored
  const semrushSnap = snapshotData(context && context.latest_snapshots, 'semrush');
  const storedRankings = semrushSnap && semrushSnap.rankings;
  if (storedRankings && rowsOf(storedRankings, ['rankings']).length) {
    raw.rankings = storedRankings;
    log(
      'rankings: reused from the stored semrush snapshot, ' +
        rowsOf(storedRankings, ['rankings']).length +
        ' rows, no gate call'
    );
    writeRaw(rawDir, 'rankings', storedRankings, log);
  } else {
    await gate('rankings', 'rankings --domain ' + root + ' --db ' + db);
  }

  // 3. the real rivals, top 3 by keyword overlap
  const competitorRows = rowsOf(raw.competitors, ['competitors'])
    .map((r) => ({ domain: competitorDomain(r), overlap: competitorOverlap(r), row: r }))
    .filter((r) => r.domain && r.domain !== root)
    .sort((a, b) => b.overlap - a.overlap);
  const rivals = competitorRows.slice(0, 3).map((r) => r.domain);
  if (rivals.length) {
    log('rivals for the gap and backlink calls: ' + rivals.join(', '));
    const vs = rivals.join(',');
    await gate(
      'keyword_gap_missing',
      'keyword-gap --domain ' + root + ' --vs ' + vs + ' --db ' + db + ' --type missing'
    );
    await gate(
      'keyword_gap_untapped',
      'keyword-gap --domain ' + root + ' --vs ' + vs + ' --db ' + db + ' --type untapped'
    );
    // Authority gap: seoq has no comparison subcommand, so pull each rival's
    // domain-overview (authorityScore + referring domains) and let the
    // analysis stage line them up against our own overview.
    for (let i = 0; i < rivals.length; i++) {
      await gate(
        'rival_overview_' + (i + 1),
        'domain-overview --domain ' + rivals[i] + ' --db ' + db
      );
    }
  } else {
    log('no usable competitor domains returned, gap and backlink comparison skipped');
    errors.push('competitors: no usable competitor domains, keyword gap and backlink comparison skipped');
  }

  // 4. site structure, no gate call, straight off the site
  let siteMap = null;
  try {
    // profile.sitemap_url wins when the client keeps its sitemap somewhere odd.
    const candidates = profile.sitemap_url ? [String(profile.sitemap_url)] : undefined;
    siteMap = await sitemap.inventory(root, { log, candidates });
    writeRaw(rawDir, 'sitemap', siteMap, log);
  } catch (e) {
    log('sitemap: FAILED :: ' + e.message);
    errors.push('sitemap: ' + e.message);
  }

  // 5. index gap against the Search Console pages we already store
  const gsc = snapshotData(context && context.latest_snapshots, 'gsc');
  let gap = null;
  if (siteMap && siteMap.ok && gsc && Array.isArray(gsc.pages)) {
    gap = sitemap.indexGap(siteMap.urls, gsc.pages);
    log(
      'index gap: ' +
        gap.urls_absent_from_gsc +
        ' of ' +
        gap.sitemap_urls +
        ' sitemap urls never appear in Search Console (' +
        Math.round(gap.absent_ratio * 100) +
        ' percent)'
    );
    writeRaw(rawDir, 'index_gap', gap, log);
  } else {
    log('index gap: not computed, need both a sitemap and a gsc snapshot with pages');
    errors.push('index_gap: not computed, sitemap or gsc pages missing');
  }

  const local = localIntentShare(
    (gsc && Array.isArray(gsc.queries) ? gsc.queries : []).concat(
      rowsOf(raw.rankings, ['rankings']).slice(0, 100)
    )
  );
  log(
    'local intent hint: ' +
      Math.round(local.share * 100) +
      ' percent of ' +
      local.queries_checked +
      ' queries contain a place word'
  );

  return {
    root,
    db,
    raw,
    errors,
    calls,
    sitemap: siteMap,
    indexGap: gap,
    gsc,
    local,
    facts: (context && context.facts) || null,
    rawDir,
    today,
  };
}

// ---------------------------------------------------------------------------
// material distillation, zero LLM
// ---------------------------------------------------------------------------

function tableFrom(rows, limit, columns) {
  const head = columns.map((c) => c.label).join(' | ');
  const body = rows
    .slice(0, limit)
    .map((r) => columns.map((c) => truncate(String(c.get(r) === undefined ? '' : c.get(r)), 120)).join(' | '))
    .join('\n');
  return head + '\n' + body;
}

function first(row, keys, fallback) {
  for (const k of keys) {
    if (row && row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  }
  return fallback === undefined ? '' : fallback;
}

function gapTable(part, limits) {
  const rows = rowsOf(part, ['keywords', 'gap', 'rankings']);
  if (!rows.length) return 'no rows';
  return tableFrom(rows, limits.gap, [
    { label: 'keyword', get: (r) => first(r, ['keyword', 'query', 'phrase']) },
    { label: 'volume', get: (r) => first(r, ['volume', 'search_volume']) },
    { label: 'client position', get: (r) => first(r, ['position', 'domain_position', 'pos'], '-') },
    { label: 'best rival position', get: (r) => first(r, ['competitor_position', 'vs_position', 'rival_position'], '-') },
    { label: 'difficulty', get: (r) => first(r, ['difficulty', 'kd', 'keyword_difficulty'], '') },
  ]);
}

function assembleMaterial(collected, limits) {
  const { raw, root, db, sitemap: siteMap, indexGap: gap, gsc, local, errors } = collected;
  const blocks = [];

  blocks.push(
    [
      'RUN CONTEXT',
      'client root domain: ' + root,
      'semrush database: ' + db,
      'date: ' + collected.today,
      'gate calls in the script stage: ' + collected.calls,
      errors.length ? 'collection problems:\n- ' + errors.join('\n- ') : 'collection problems: none',
    ].join('\n')
  );

  const compRows = rowsOf(raw.competitors, ['competitors']);
  blocks.push(
    'ORGANIC COMPETITORS (' + compRows.length + ' returned)\n' +
      (compRows.length
        ? tableFrom(compRows, limits.competitors, [
            { label: 'domain', get: (r) => competitorDomain(r) },
            { label: 'common keywords', get: (r) => competitorOverlap(r) },
            { label: 'total keywords', get: (r) => first(r, ['keywords', 'total_keywords', 'organic_keywords']) },
            { label: 'traffic', get: (r) => first(r, ['traffic', 'organic_traffic']) },
            { label: 'authority', get: (r) => first(r, ['authority_score', 'as', 'authority'], '') },
          ])
        : 'no competitor rows returned')
  );

  const rankRows = rowsOf(raw.rankings, ['rankings']);
  blocks.push(
    'CLIENT RANKINGS (' + rankRows.length + ' returned)\n' +
      (rankRows.length
        ? tableFrom(rankRows, limits.rankings, [
            { label: 'keyword', get: (r) => first(r, ['keyword', 'query', 'phrase']) },
            { label: 'position', get: (r) => first(r, ['position', 'pos']) },
            { label: 'volume', get: (r) => first(r, ['volume', 'search_volume']) },
            { label: 'url', get: (r) => first(r, ['url', 'landing_page']) },
          ])
        : 'no ranking rows returned')
  );

  blocks.push('KEYWORD GAP, MISSING (rivals rank, client does not)\n' + gapTable(raw.keyword_gap_missing, limits));
  blocks.push('KEYWORD GAP, UNTAPPED (nobody owns it yet)\n' + gapTable(raw.keyword_gap_untapped, limits));

  const rivalOverviews = Object.keys(raw)
    .filter((k) => k.indexOf('rival_overview_') === 0)
    .map((k) => payloadOf(raw[k]))
    .filter(Boolean)
    .map((p) => {
      const s = (p && p.summary) || p || {};
      return {
        domain: s.domain,
        authorityScore: s.authorityScore,
        referringDomains: s.referringDomains,
        backlinks: s.backlinks,
        organicKeywords: s.organicKeywords,
        organicTraffic: s.organicTraffic,
      };
    });
  blocks.push(
    'AUTHORITY COMPARISON (client versus rivals, from domain overviews)\n' +
      (rivalOverviews.length
        ? truncate(JSON.stringify(rivalOverviews, null, 1), 2500)
        : 'not available, treat the authority gap as unknown')
  );

  if (siteMap && siteMap.ok) {
    const sections = ((siteMap.summary && siteMap.summary.sections) || []).slice(0, limits.sitemapSections);
    blocks.push(
      [
        'SITE STRUCTURE (from ' + siteMap.source + ')',
        'urls found: ' + siteMap.count + (siteMap.truncated ? ' (capped at the crawl limit)' : ''),
        'sitemap files: ' + siteMap.sitemaps.length,
        'depth distribution: ' + JSON.stringify((siteMap.summary && siteMap.summary.depths) || {}),
        'sections (first path segment | urls)\n' +
          sections.map((s) => s.section + ' | ' + s.urls).join('\n'),
      ].join('\n')
    );
  } else {
    blocks.push('SITE STRUCTURE\nno sitemap could be read, site structure is unknown');
  }

  blocks.push(
    'INDEX GAP APPROXIMATION\n' +
      (gap
        ? [
            'sitemap urls: ' + gap.sitemap_urls,
            'pages with impressions in Search Console: ' + gap.gsc_pages_with_impressions,
            'sitemap urls absent from Search Console: ' + gap.urls_absent_from_gsc + ' (' + Math.round(gap.absent_ratio * 100) + ' percent)',
            'sample of absent urls:\n' + gap.sample_absent.slice(0, 10).join('\n'),
            gap.note,
          ].join('\n')
        : 'not computed, sitemap or Search Console page data was missing')
  );

  if (gsc) {
    const queries = (Array.isArray(gsc.queries) ? gsc.queries : [])
      .slice()
      .sort((a, b) => (Number(b.clicks) || 0) - (Number(a.clicks) || 0));
    blocks.push(
      [
        'SEARCH CONSOLE, spam already filtered (' + (gsc.spam_exclude_regex || 'no filter recorded') + ')',
        'totals: ' + JSON.stringify(gsc.totals || {}),
        'top queries (query | clicks | impressions | position)\n' +
          tableFrom(queries, limits.queries, [
            { label: 'query', get: (r) => r.query },
            { label: 'clicks', get: (r) => r.clicks },
            { label: 'impressions', get: (r) => r.impressions },
            { label: 'position', get: (r) => Number(r.position || 0).toFixed(1) },
          ]),
      ].join('\n')
    );
  } else {
    blocks.push('SEARCH CONSOLE\nno snapshot on record');
  }

  blocks.push(
    'LOCAL INTENT HINT (computed by the runner, place words in queries)\n' +
      JSON.stringify(local)
  );

  // Known facts, so the dossier does not list a settled question as an unknown.
  blocks.push(
    factsSection({ facts: collected.facts }) +
      '\nA confirmed fact must never appear in your Unknowns section. A pending fact may be' +
      '\ncited, labelled [inferred] at best, and say it is pending confirmation.'
  );

  return blocks.join('\n\n');
}

/** Fit the material into MATERIAL_MAX_BYTES by tightening row limits. */
function distilMaterial(collected, log) {
  let text = '';
  let step = 0;
  for (let i = 0; i < MATERIAL_STEPS.length; i += 1) {
    step = i;
    text = assembleMaterial(collected, MATERIAL_STEPS[i]);
    if (Buffer.byteLength(text, 'utf8') <= MATERIAL_MAX_BYTES) break;
  }
  if (Buffer.byteLength(text, 'utf8') > MATERIAL_MAX_BYTES) {
    text = text.slice(0, MATERIAL_MAX_BYTES - 90) + '\n\n[material truncated to fit the size budget]';
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  log('material distilled: ' + bytes + ' bytes at detail step ' + step + ', budget ' + MATERIAL_MAX_BYTES + ' bytes');
  return { text, bytes, step };
}

// ---------------------------------------------------------------------------
// analysis stage
// ---------------------------------------------------------------------------

function readSpec() {
  try {
    return fs.readFileSync(SPEC_PATH, 'utf8');
  } catch (e) {
    throw new Error('cannot read the discover spec at ' + SPEC_PATH + ' :: ' + e.message);
  }
}

function buildPrompt(spec, material, extraMaterial, today) {
  const parts = [
    spec,
    '',
    '# RUN DATE',
    today,
    '',
    '# T1 MATERIAL',
    material,
  ];
  if (extraMaterial) {
    parts.push(
      '',
      '# T2 MATERIAL, the results of the extra calls you requested',
      extraMaterial,
      '',
      'The extra round is spent. Write the final dossier now, in Chinese, with the six',
      'required Chinese headings and the closing json block. Do not request anything else.',
      'Anything the extra calls failed to answer belongs in 未知项.'
    );
  } else {
    parts.push(
      '',
      'Now either request one round of extra calls with a ```needs block, per the T2',
      'rules in the spec, or write the dossier. Do not do both.',
      'When you write the dossier: Chinese prose, the six Chinese headings exactly as the',
      'spec lists them, and every conclusion labelled [确认] / [推断] / [未知].'
    );
  }
  return parts.join('\n');
}

/** Run the model requested follow up calls, inside the budget and the allow list. */
async function runNeeds(ctx, lines, budget) {
  const { cfg, log } = ctx;
  const results = [];
  for (const line of lines) {
    const checked = sanitizeSubcommand(line);
    if (!checked.ok) {
      log('t2 request refused: "' + truncate(line, 120) + '" :: ' + checked.reason);
      results.push({ command: line, ok: false, error: 'refused by the runner: ' + checked.reason });
      continue;
    }
    if (!budget.take(checked.command)) {
      results.push({ command: checked.command, ok: false, error: 'budget exhausted, not run' });
      continue;
    }
    try {
      const res = await seoq(cfg, checked.command, log);
      results.push({ command: checked.command, ok: true, result: res });
    } catch (e) {
      log('t2 call FAILED :: ' + e.message);
      results.push({ command: checked.command, ok: false, error: e.message });
    }
  }
  return results;
}

function renderNeedsResults(results) {
  return results
    .map((r) => {
      if (!r.ok) return 'COMMAND: ' + r.command + '\nFAILED: ' + r.error;
      const rows = rowsOf(r.result, []);
      const body = rows.length
        ? 'rows: ' + rows.length + '\n' + truncate(JSON.stringify(rows.slice(0, 40), null, 1), 6000)
        : truncate(JSON.stringify(payloadOf(r.result), null, 1), 4000);
      return 'COMMAND: ' + r.command + '\n' + body;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function run(ctx) {
  const { job, api, log, cfg } = ctx;
  const startedAt = Date.now();

  const context = await api.getContext(job.client_id);
  const profile = (context && context.profile) || null;
  if (!profile) throw new Error('context returned no profile for client_id ' + job.client_id);
  const workspace = ensureClientWorkspace(profile, cfg);
  log('discover spec ' + SPEC_VERSION + ', workspace ' + workspace);

  // Stage 1, no LLM.
  log('stage 1 of 3: collecting raw material, zero LLM');
  const collected = await collect(ctx, profile, context, workspace);
  const material = distilMaterial(collected, log);

  // Stage 2, the analysis pass.
  const spec = readSpec();
  const budget = new CallBudget(T2_CALL_BUDGET, log);
  const model = cfg.discoverModel;
  log('stage 2 of 3: analysis pass, model ' + model + ', spec ' + Buffer.byteLength(spec, 'utf8') + ' bytes');

  const prompt1 = buildPrompt(spec, material.text, null, collected.today);
  log('pass 1 prompt: ' + prompt1.length + ' chars');
  const pass1 = await runClaude(cfg, {
    prompt: prompt1,
    cwd: workspace,
    log,
    model,
    allowedTools: 'Read',
    label: 'discover pass 1',
  });

  let output = String(pass1.stdout || '').trim();
  let needsRound = null;
  const needs = extractFencedLines(output, 'needs');
  if (needs.found && needs.lines.length) {
    const requested = needs.lines.slice(0, T2_CALL_BUDGET);
    log('t2 triggered: model requested ' + needs.lines.length + ' extra call(s), running ' + requested.length + ' within budget ' + T2_CALL_BUDGET);
    const results = await runNeeds(ctx, requested, budget);
    const okCount = results.filter((r) => r.ok).length;
    log('t2 round finished: ' + okCount + ' ok, ' + (results.length - okCount) + ' failed, budget used ' + budget.used + '/' + budget.max);
    writeRaw(collected.rawDir, 't2_results', results, log);

    const extra = renderNeedsResults(results);
    const prompt2 = buildPrompt(spec, material.text, extra, collected.today);
    log('pass 2 prompt: ' + prompt2.length + ' chars');
    const pass2 = await runClaude(cfg, {
      prompt: prompt2,
      cwd: workspace,
      log,
      model,
      allowedTools: 'Read',
      label: 'discover pass 2',
    });
    output = String(pass2.stdout || '').trim();
    needsRound = {
      requested: needs.lines.length,
      run: results.length,
      ok: okCount,
      commands: results.map((r) => ({ command: r.command, ok: r.ok, error: r.error || null })),
    };
  } else {
    log('t2 not triggered, no extra calls requested');
  }

  if (!output) throw new Error('the analysis pass produced no output');

  // Stage 3, persist.
  log('stage 3 of 3: persisting the dossier');
  const parsed = extractTrailingJson(output);
  if (parsed.error) log('machine block: ' + parsed.error + ', storing the dossier without it');
  const meta = parsed.json && typeof parsed.json === 'object' ? parsed.json : {};
  const dossierMd = parsed.body || output;

  const missingHeadings = REQUIRED_HEADINGS.filter((h) => dossierMd.indexOf(h) === -1);
  if (missingHeadings.length) {
    log('dossier is missing section(s): ' + missingHeadings.join(', ') + '. Stored anyway, review it by hand');
  }

  const unknowns = Array.isArray(meta.unknowns) ? meta.unknowns : [];
  // A collection failure is a data gap, so it belongs in unknowns whether or not
  // the model noticed it.
  const collectionGaps = collected.errors.map((e) => 'collection gap, ' + e);
  const allUnknowns = unknowns.concat(collectionGaps);

  const data = {
    spec_version: SPEC_VERSION,
    generated_at: new Date().toISOString(),
    model,
    root_domain: collected.root,
    semrush_db: collected.db,
    dossier_md: dossierMd,
    unknowns: allUnknowns,
    confidence_summary: meta.confidence_summary || null,
    machine_block_ok: !parsed.error,
    missing_sections: missingHeadings,
    seoq_calls: { t1: collected.calls, t2: budget.used, budget: T2_CALL_BUDGET },
    t2_round: needsRound,
    collection_errors: collected.errors,
    material_bytes: material.bytes,
    sitemap_summary: collected.sitemap
      ? {
          ok: collected.sitemap.ok,
          source: collected.sitemap.source,
          count: collected.sitemap.count,
          truncated: collected.sitemap.truncated,
          sections: (collected.sitemap.summary && collected.sitemap.summary.sections) || [],
        }
      : null,
    index_gap: collected.indexGap,
    local_intent: collected.local,
    raw_material_dir: collected.rawDir,
  };

  await api.postSnapshot({
    client_id: job.client_id,
    source: 'discovery',
    period_start: collected.today,
    period_end: collected.today,
    data,
  });
  log('discovery snapshot posted, spec ' + SPEC_VERSION + ', ' + allUnknowns.length + ' unknown(s)');

  const outDir = path.join(workspace, 'seo-agent-output');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'dossier-' + collected.today + '.md');
  fs.writeFileSync(file, dossierMd, 'utf8');
  log('dossier saved to ' + file + ', ' + dossierMd.length + ' chars');

  log(
    'discover finished in ' +
      Math.round((Date.now() - startedAt) / 1000) +
      's, gate calls ' +
      (collected.calls + budget.used) +
      ', unknowns ' +
      allUnknowns.length
  );
  return { tokenUsage: 0 };
}

module.exports = {
  run,
  buildPrompt,
  distilMaterial,
  localIntentShare,
  runNeeds,
  SPEC_VERSION,
  T2_CALL_BUDGET,
  REQUIRED_HEADINGS,
};
