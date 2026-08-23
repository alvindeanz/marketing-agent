'use strict';
// Sitemap crawler. Zero dependencies, node built-ins only.
//
// Deliberately shallow: fetch /sitemap.xml, follow a sitemap index one level
// down, stop at MAX_URLS. This exists to inventory site structure for the
// discover job, not to be a crawler.

const https = require('node:https');
const http = require('node:http');
const { URL } = require('node:url');

const MAX_URLS = 500;
const MAX_CHILD_SITEMAPS = 20;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 20000;

/** GET a URL as text, following a few redirects. Resolves { status, url, body }. */
function getText(urlStr, timeoutMs, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(new Error('bad sitemap url: ' + urlStr));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': 'seo-worker sitemap inventory (ops-tracker)',
          Accept: 'application/xml,text/xml,*/*',
        },
      },
      (res) => {
        const status = res.statusCode;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          if (redirectsLeft <= 0) {
            resolve({ status, url: urlStr, body: '', redirectedTo: location });
            return;
          }
          const next = new URL(location, urlStr).toString();
          resolve(getText(next, timeoutMs, redirectsLeft - 1));
          return;
        }
        const chunks = [];
        let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
          // A sitemap larger than 8MB is not something we need in full.
          if (bytes <= 8 * 1024 * 1024) chunks.push(c);
        });
        res.on('end', () =>
          resolve({ status, url: urlStr, body: Buffer.concat(chunks).toString('utf8') })
        );
        res.on('error', reject);
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('sitemap fetch timeout: ' + urlStr)));
    req.on('error', reject);
    req.end();
  });
}

/** Pull every <loc> out of a sitemap document. */
function parseLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(String(xml || '')))) {
    out.push(m[1].replace(/&amp;/g, '&').trim());
  }
  return out;
}

function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(String(xml || ''));
}

function pathOf(urlStr) {
  try {
    return new URL(urlStr).pathname || '/';
  } catch (e) {
    return String(urlStr);
  }
}

/** Normalised comparison key: no protocol, no www, no trailing slash. */
function urlKey(urlStr) {
  return String(urlStr || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

/** Group URLs by first path segment and by depth. */
function summarise(urls) {
  const sections = {};
  const depths = {};
  for (const u of urls) {
    const p = pathOf(u);
    const parts = p.split('/').filter(Boolean);
    const section = parts.length ? parts[0] : '(root)';
    sections[section] = (sections[section] || 0) + 1;
    const d = parts.length;
    depths['depth_' + d] = (depths['depth_' + d] || 0) + 1;
  }
  const topSections = Object.keys(sections)
    .map((k) => ({ section: k, urls: sections[k] }))
    .sort((a, b) => b.urls - a.urls)
    .slice(0, 25);
  return { sections: topSections, depths };
}

/**
 * Inventory a site's sitemap.
 * Returns { ok, source, urls, count, truncated, sitemaps, summary, errors }.
 * Never throws, a site with no sitemap is a finding, not a crash.
 */
async function inventory(rootDomainName, opts = {}) {
  const log = opts.log || function () {};
  const maxUrls = opts.maxUrls || MAX_URLS;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const candidates = opts.candidates || [
    'https://' + rootDomainName + '/sitemap.xml',
    'https://www.' + rootDomainName + '/sitemap.xml',
    'https://' + rootDomainName + '/sitemap_index.xml',
  ];
  const errors = [];

  let root = null;
  for (const candidate of candidates) {
    try {
      const res = await getText(candidate, timeoutMs, MAX_REDIRECTS);
      if (res.status === 200 && /<(urlset|sitemapindex)[\s>]/i.test(res.body)) {
        root = res;
        log('sitemap: found at ' + res.url + ' (' + res.body.length + ' bytes)');
        break;
      }
      errors.push(candidate + ': HTTP ' + res.status);
    } catch (e) {
      errors.push(candidate + ': ' + e.message);
    }
  }
  if (!root) {
    log('sitemap: no sitemap found, tried ' + candidates.length + ' locations');
    return { ok: false, source: null, urls: [], count: 0, truncated: false, sitemaps: [], summary: null, errors };
  }

  const sitemaps = [root.url];
  let urls = [];
  let truncated = false;

  if (isSitemapIndex(root.body)) {
    const children = parseLocs(root.body).slice(0, MAX_CHILD_SITEMAPS);
    log('sitemap: index with ' + children.length + ' child sitemap(s), fetching one level down');
    for (const child of children) {
      if (urls.length >= maxUrls) {
        truncated = true;
        break;
      }
      try {
        const res = await getText(child, timeoutMs, MAX_REDIRECTS);
        if (res.status !== 200) {
          errors.push(child + ': HTTP ' + res.status);
          continue;
        }
        sitemaps.push(child);
        // One level only. A nested index below this is recorded, not followed.
        if (isSitemapIndex(res.body)) {
          errors.push(child + ': nested sitemap index, not followed');
          continue;
        }
        urls = urls.concat(parseLocs(res.body));
      } catch (e) {
        errors.push(child + ': ' + e.message);
      }
    }
  } else {
    urls = parseLocs(root.body);
  }

  if (urls.length > maxUrls) {
    truncated = true;
    urls = urls.slice(0, maxUrls);
  }
  log(
    'sitemap: ' +
      urls.length +
      ' url(s) from ' +
      sitemaps.length +
      ' sitemap file(s)' +
      (truncated ? ', truncated at the ' + maxUrls + ' url cap' : '')
  );

  return {
    ok: true,
    source: root.url,
    urls,
    count: urls.length,
    truncated,
    sitemaps,
    summary: summarise(urls),
    errors,
  };
}

/**
 * Approximate index gap: sitemap URLs that never appear in the GSC page rows.
 * GSC only reports pages with impressions, so this is a signal, not a verdict.
 */
function indexGap(sitemapUrls, gscPages) {
  const seen = new Set((gscPages || []).map((p) => urlKey(p && (p.page || p.url))));
  const missing = [];
  for (const u of sitemapUrls || []) {
    if (!seen.has(urlKey(u))) missing.push(u);
  }
  const total = (sitemapUrls || []).length;
  return {
    sitemap_urls: total,
    gsc_pages_with_impressions: seen.size,
    urls_absent_from_gsc: missing.length,
    absent_ratio: total ? Math.round((missing.length / total) * 1000) / 1000 : 0,
    sample_absent: missing.slice(0, 20),
    note: 'GSC only reports pages that received impressions, so absence is a signal of thin or unindexed pages, not proof of deindexing',
  };
}

module.exports = { inventory, indexGap, parseLocs, summarise, urlKey, MAX_URLS };
