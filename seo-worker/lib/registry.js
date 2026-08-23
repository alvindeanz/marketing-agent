'use strict';
// 站内内容注册表 + 关键词蚕食检查。零 LLM，全部确定性。
//
// 存在的理由：写博客之前，产线没有任何机械化的撞车检查，选题防重复全靠模型自觉。
// 客户内容全在 WebForger 上，接口可以把页面、collection、博文（含草稿）全枚举出来，
// 所以"站上已经有什么"这件事没有任何理由靠猜。
//
// 这个文件里没有一次模型调用。主词推断、意图分类、重合判定全是写死的启发式：
// 结论可复现、可争论、可以在代码里改。模型只负责在拿到这张表之后写出差异化角度。
//
// 三个职责：
//   1. buildRegistry()    枚举全站内容，产出 registry 对象（落 seo_snapshots）
//   2. cannibalSignals()  从 GSC 的 query×page 行算蚕食信号，随 registry 一起存
//   3. registryBlock() / checkCollision()  注入简报，以及写稿后的机械打回

const path = require('node:path');
const fs = require('node:fs');

const capabilities = require('./capabilities');
const wf = require('./webforger');
const { truncate, ensureClientWorkspace } = require('./util');

const REGISTRY_VERSION = 1;
const SOURCE = 'content_registry';

// ---------------------------------------------------------------------------
// 分词与归一化
// ---------------------------------------------------------------------------

/* 功能词。从主题词集合里剔掉，因为它们描述的是意图和修辞，不是题目本身。
   "best laminate flooring" 和 "laminate flooring" 争的是同一批查询，剔干净之后
   两者的 token 集合相等，正是我们要它被判成撞车的效果。
   注意：地名和年份不在这里。nz、auckland、2026 是真实的限定词，去掉它们会把
   "laminate flooring cost nz" 和 "laminate flooring cost" 强行合并成一条。 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'for', 'of', 'to', 'in', 'on', 'at', 'by',
  'with', 'from', 'as', 'is', 'are', 'be', 'been', 'was', 'were', 'it', 'its',
  'this', 'that', 'these', 'those', 'you', 'your', 'yours', 'my', 'our', 'ours',
  'we', 'us', 'they', 'them', 'their', 'i', 'me', 'he', 'she',
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
  'do', 'does', 'did', 'can', 'could', 'should', 'would', 'will', 'shall', 'may',
  'about', 'into', 'over', 'under', 'than', 'then', 'so', 'not', 'no', 'all',
  'more', 'most', 'some', 'any', 'every', 'each', 'other', 'others', 'one', 'two',
  'guide', 'guides', 'tips', 'tip', 'ultimate', 'complete', 'everything',
  'need', 'know', 'knowing', 'really', 'actually', 'just',
  'vs', 'versus', 'v',
]);

/* 意图标记词。既用来分类，也在主词推断里被剔除，两处共用一张表不会走神。 */
const INTENT_WORDS = {
  commercial: [
    'vs', 'versus', 'compare', 'compared', 'comparison', 'best', 'top', 'better',
    'review', 'reviews', 'alternative', 'alternatives', 'which', 'cheapest',
    'cheap', 'pros', 'cons', 'worth', 'cost', 'costs', 'price', 'prices',
    'pricing', 'budget',
  ],
  transactional: [
    'buy', 'order', 'quote', 'quotes', 'sample', 'samples', 'showroom', 'shop',
    'store', 'stockist', 'stockists', 'supplier', 'suppliers', 'installer',
    'installers', 'near-me', 'nearme', 'sale', 'deal', 'deals', 'book', 'booking',
    'enquiry', 'enquire', 'contact',
  ],
  navigational: [
    'about', 'contact', 'privacy', 'terms', 'policy', 'warranty', 'downloads',
    'download', 'certifications', 'certification', 'gallery', 'careers', 'faq',
    'sitemap', 'login', 'account',
  ],
};

const INTENT_LABEL = {
  informational: '信息型',
  commercial: '商业调查型',
  transactional: '交易型',
  navigational: '导航型',
};

/** 单词归一：小写，去非字母数字，粗暴单复数还原。够用，不追求语言学正确。 */
function stem(word) {
  let w = String(word || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!w) return '';
  if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (w.length > 3 && /(ss|us|is|os)$/.test(w)) return w;
  if (w.length > 3 && /s$/.test(w)) return w.slice(0, -1);
  return w;
}

/** 把任意文本切成词序列，保留顺序，保留停用词。 */
function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/&[a-z]+;/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** 主题 token 集合：去停用词、去意图词、词干化、去重。撞车判定只看这个。 */
function topicTokens(text) {
  const drop = new Set([].concat(INTENT_WORDS.commercial, INTENT_WORDS.transactional));
  const out = [];
  for (const w of words(text)) {
    if (STOPWORDS.has(w)) continue;
    if (drop.has(w)) continue;
    const s = stem(w);
    if (!s || s.length < 2) continue;
    if (out.indexOf(s) === -1) out.push(s);
  }
  return out;
}

/** token 集合的稳定指纹。两条内容指纹相同即视为同题。 */
function termKey(tokens) {
  return (tokens || []).slice().sort().join('|');
}

function jaccard(a, b) {
  const A = new Set(a || []);
  const B = new Set(b || []);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/** slug 归一：去语言前缀、去首尾斜杠、小写。用于精确撞车判定。 */
function normSlug(slug) {
  return String(slug || '')
    .toLowerCase()
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.html?$/, '')
    .replace(/[^a-z0-9/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** url 归一：去协议、去 www、去尾斜杠、去 query 和 hash、小写。 */
function normUrl(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  s = s.split('#')[0].split('?')[0];
  s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  s = s.replace(/\/+$/, '');
  return s.toLowerCase();
}

// ---------------------------------------------------------------------------
// 主词与意图，确定性启发式
// ---------------------------------------------------------------------------

/**
 * 推断主词。优先级写死，不掷骰子：
 *   1. 平台上明确记录的 keyword 字段（博文有，最可信）
 *   2. slug 词干（去停用词与意图词后，按原顺序拼回来）
 *   3. 标题（截到第一个冒号或竖线之前）
 * 返回 { term, tokens, key, from }。
 */
function primaryTerm(entry) {
  const keyword = String((entry && entry.keyword) || '').trim();
  if (keyword) {
    const tokens = topicTokens(keyword);
    if (tokens.length) {
      return { term: keyword.toLowerCase(), tokens, key: termKey(tokens), from: 'keyword' };
    }
  }
  // "index" is a file name, not a topic. The homepage's term comes from its
  // title like any other page whose slug says nothing.
  const rawSlug = String((entry && entry.slug) || '');
  const slugPart = rawSlug === 'index' ? '' : rawSlug.split('/').pop();
  const fromSlug = [];
  const drop = new Set([].concat(INTENT_WORDS.commercial, INTENT_WORDS.transactional));
  for (const w of words(slugPart)) {
    if (STOPWORDS.has(w) || drop.has(w)) continue;
    if (fromSlug.indexOf(w) === -1) fromSlug.push(w);
  }
  if (fromSlug.length) {
    const tokens = topicTokens(slugPart);
    return { term: fromSlug.join(' '), tokens, key: termKey(tokens), from: 'slug' };
  }
  const head = String((entry && entry.title) || '').split(/[:|｜]/)[0];
  const tokens = topicTokens(head);
  return {
    term: tokens.length ? words(head).filter((w) => !STOPWORDS.has(w)).join(' ') : '',
    tokens,
    key: termKey(tokens),
    from: 'title',
  };
}

/**
 * 意图分类。判定顺序固定：内容类型的先验 > 导航词 > 商业调查词 > 交易词 > 默认信息型。
 * 产品 collection 和产品条目天生是交易型，不需要词表投票。
 */
function intentOf(entry) {
  const kind = (entry && entry.kind) || '';
  if (kind === 'collection' || kind === 'collection_item') return 'transactional';
  if (kind === 'page' && String(entry.slug || '') === 'index') return 'navigational';
  const hay = new Set(words((entry.slug || '') + ' ' + (entry.title || '')));
  for (const w of INTENT_WORDS.navigational) if (hay.has(w)) return 'navigational';
  for (const w of INTENT_WORDS.commercial) if (hay.has(w)) return 'commercial';
  for (const w of INTENT_WORDS.transactional) if (hay.has(w)) return 'transactional';
  return 'informational';
}

// ---------------------------------------------------------------------------
// 正文解析
// ---------------------------------------------------------------------------

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

function decodeEntities(s) {
  return String(s || '').replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] || m);
}

function cleanHeading(s) {
  return decodeEntities(String(s || ''))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** markdown 或 html 正文里的 H1 / H2。博文正文两种写法都出现过。 */
function headingsOf(body) {
  const text = String(body || '');
  const h1 = [];
  const h2 = [];
  const mdLines = text.split('\n');
  for (const line of mdLines) {
    const m = line.match(/^\s*(#{1,2})\s+(.+?)\s*$/);
    if (!m) continue;
    const h = cleanHeading(m[2]);
    if (!h) continue;
    if (m[1] === '#') h1.push(h);
    else h2.push(h);
  }
  const htmlH1 = text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/gi) || [];
  for (const hit of htmlH1) {
    const h = cleanHeading(hit.replace(/<\/?h1[^>]*>/gi, ''));
    if (h && h1.indexOf(h) === -1) h1.push(h);
  }
  const htmlH2 = text.match(/<h2[^>]*>([\s\S]*?)<\/h2>/gi) || [];
  for (const hit of htmlH2) {
    const h = cleanHeading(hit.replace(/<\/?h2[^>]*>/gi, ''));
    if (h && h2.indexOf(h) === -1) h2.push(h);
  }
  return { h1: h1[0] || '', h2 };
}

/** 页面 elements 里的 H1 / H2。elements 是页面唯一暴露标题层级的读接口。 */
function headingsOfElements(elements) {
  const h1 = [];
  const h2 = [];
  for (const el of elements || []) {
    const tag = String((el && el.tag) || '').toLowerCase();
    if (tag !== 'h1' && tag !== 'h2') continue;
    const v = cleanHeading(el.value);
    if (!v) continue;
    if (tag === 'h1') h1.push(v);
    else h2.push(v);
  }
  return { h1: h1[0] || '', h2 };
}

// ---------------------------------------------------------------------------
// URL 推导
// ---------------------------------------------------------------------------

/**
 * 站点根 url。profile.domain 可能带协议也可能不带，两种都见过。
 * 拿不到域名时返回空串，注册表退化成只有路径，撞车判定照样能跑。
 */
function baseUrlOf(profile, meta) {
  const domains = (meta && Array.isArray(meta.domains) && meta.domains) || [];
  const primary = domains.find((d) => d && d.primary && d.status === 'active')
    || domains.find((d) => d && d.status === 'active')
    || null;
  const host = primary
    ? String(primary.domain)
    : String((profile && (profile.domain || profile.website || profile.url)) || '');
  if (!host) return '';
  const withProto = /^https?:\/\//i.test(host) ? host : 'https://' + host;
  return withProto.replace(/\/+$/, '');
}

function langPrefix(lang, defaultLang) {
  const l = String(lang || '').trim();
  if (!l || !defaultLang) return '';
  if (l === String(defaultLang).trim()) return '';
  return '/' + l;
}

/**
 * Which language is the site's default. /meta does not expose config.defaultLang,
 * so it is inferred from the posts: the default language is the one most posts
 * are written in. Getting this wrong only mislabels a display url, the collision
 * check works off slugs and terms, but a wrong /en/ prefix in a brief is the
 * kind of small lie that costs someone twenty minutes.
 */
function inferDefaultLang(meta, posts) {
  const declared = (meta && (meta.defaultLang || (meta.config && meta.config.defaultLang))) || '';
  if (declared) return String(declared);
  const tally = new Map();
  for (const p of posts || []) {
    const l = String((p && p.lang) || '').trim();
    if (!l) continue;
    tally.set(l, (tally.get(l) || 0) + 1);
  }
  let best = '';
  let bestN = 0;
  for (const [l, n] of tally) {
    if (n > bestN) {
      best = l;
      bestN = n;
    }
  }
  return best;
}

function joinUrl(base, p) {
  const pathPart = p.startsWith('/') ? p : '/' + p;
  return base ? base + pathPart : pathPart;
}

// ---------------------------------------------------------------------------
// 枚举
// ---------------------------------------------------------------------------

function makeEntry(raw) {
  const entry = {
    kind: raw.kind,
    url: raw.url || '',
    path: raw.path || '',
    slug: raw.slug || '',
    title: cleanHeading(raw.title),
    meta_description: truncate(cleanHeading(raw.meta_description), 400),
    h1: cleanHeading(raw.h1),
    h2: (raw.h2 || []).slice(0, 12),
    status: raw.status || 'published',
    lang: raw.lang || '',
    updated_at: raw.updated_at || '',
    keyword: raw.keyword || '',
  };
  const pt = primaryTerm(entry);
  entry.primary_term = pt.term;
  entry.term_tokens = pt.tokens;
  entry.term_key = pt.key;
  entry.term_from = pt.from;
  entry.intent = intentOf(entry);
  return entry;
}

/**
 * 枚举租户全部内容：页面、collection、collection 条目、博文（含 draft）。
 * ctx: { client, profile, log, meta, withHeadings }
 * 任何单项失败都只降级成一条 note，绝不让整张表塌掉：半张表远好过没有表。
 */
async function buildRegistry(ctx) {
  const client = ctx.client;
  const log = ctx.log || function () {};
  const profile = ctx.profile || {};
  const withHeadings = ctx.withHeadings !== false;
  const notes = [];

  let meta = ctx.meta || null;
  if (!meta) {
    try {
      meta = await client.getMeta();
    } catch (e) {
      meta = null;
      notes.push('站点 meta 读不到：' + e.message);
    }
  }
  const base = baseUrlOf(profile, meta);
  const entries = [];

  // --- 页面注册表 ---------------------------------------------------------
  let pages = [];
  try {
    pages = await client.listPages();
  } catch (e) {
    notes.push('页面注册表读不到：' + e.message);
    log('registry: 页面注册表读不到 :: ' + e.message);
  }
  const collectionPageSlugs = new Set();
  for (const p of pages) {
    if (!p || !p.slug) continue;
    const slug = String(p.slug);
    const isCollection = String(p.type || '') === 'collection';
    if (isCollection) collectionPageSlugs.add(slug);
    const pathPart = slug === 'index' ? '/' : '/' + slug + '/';
    const seo = p.seo || {};
    let h1 = '';
    let h2 = [];
    if (withHeadings) {
      try {
        const els = await client.pageElements('pages/' + slug + '.html');
        const hs = headingsOfElements(els);
        h1 = hs.h1;
        h2 = hs.h2;
      } catch (e) {
        // 常见且无害：某些页面不是 pages/{slug}.html 布局。标题缺失不影响撞车判定。
        notes.push('页面 ' + slug + ' 的标题层级读不到（' + e.message.slice(0, 80) + '）');
      }
    }
    entries.push(
      makeEntry({
        kind: isCollection ? 'collection' : 'page',
        url: joinUrl(base, pathPart),
        path: pathPart,
        slug,
        title: seo.title || p.title,
        meta_description: seo.description || '',
        h1,
        h2,
        status: seo.noindex ? 'noindex' : 'published',
        updated_at: p.updatedAt || p.createdAt || '',
      })
    );
  }

  // --- collection 与条目 --------------------------------------------------
  let collections = [];
  try {
    collections = await client.listCollections();
  } catch (e) {
    notes.push('collections 读不到：' + e.message);
    log('registry: collections 读不到 :: ' + e.message);
  }
  for (const c of collections) {
    if (!c || !c.slug) continue;
    const cslug = String(c.slug);
    // collection 的落地页已经在页面注册表里出现过了，这里只补 SEO 字段，不重复建条目。
    if (collectionPageSlugs.has(cslug)) {
      const hit = entries.find((e) => e.slug === cslug && e.kind === 'collection');
      if (hit) {
        if (!hit.meta_description) hit.meta_description = truncate(cleanHeading(c.seoDescription), 400);
        if (!hit.title) hit.title = cleanHeading(c.seoTitle || c.name);
        if (!hit.h1) hit.h1 = cleanHeading(c.heading);
      }
    } else {
      entries.push(
        makeEntry({
          kind: 'collection',
          url: joinUrl(base, '/' + cslug + '/'),
          path: '/' + cslug + '/',
          slug: cslug,
          title: c.seoTitle || c.name,
          meta_description: c.seoDescription || c.subheading || '',
          h1: c.heading || '',
          h2: [],
          updated_at: c.updatedAt || c.createdAt || '',
        })
      );
    }
    if (c.itemPage === false) continue;
    let items = [];
    try {
      items = await client.listCollectionItems(cslug);
    } catch (e) {
      notes.push('collection ' + cslug + ' 的条目读不到：' + e.message);
      continue;
    }
    for (const it of items) {
      if (!it) continue;
      const islug = String(it.slug || it.id || '');
      if (!islug) continue;
      entries.push(
        makeEntry({
          kind: 'collection_item',
          url: joinUrl(base, '/' + cslug + '/' + islug + '/'),
          path: '/' + cslug + '/' + islug + '/',
          slug: cslug + '/' + islug,
          title: it.seoTitle || it.title || islug,
          meta_description: it.seoDescription || it.description || '',
          h1: it.title || '',
          h2: [],
          status: it.status || 'published',
          updated_at: it.updatedAt || it.createdAt || '',
        })
      );
    }
  }

  // --- 博文，草稿必须一起进来 ---------------------------------------------
  // 草稿是撞车的主要来源：上一轮已经写了草稿还没发，这一轮又选了同一个题。
  let posts = [];
  try {
    posts = await client.listPostsFull();
  } catch (e) {
    notes.push('博文全量读失败，退回摘要模式：' + e.message);
    log('registry: ?full=1 失败，退回摘要模式 :: ' + e.message);
    try {
      posts = await client.listPosts();
    } catch (e2) {
      notes.push('博文列表也读不到：' + e2.message);
      posts = [];
    }
  }
  const defaultLang = inferDefaultLang(meta, posts);
  for (const p of posts) {
    if (!p || !p.slug) continue;
    const slug = String(p.slug);
    const prefix = langPrefix(p.lang, defaultLang);
    const pathPart = prefix + '/blog/' + slug + '/';
    const hs = headingsOf(p.body || '');
    const metaDesc = (p.meta && (p.meta.description || p.meta.desc)) || p.excerpt || '';
    entries.push(
      makeEntry({
        kind: 'post',
        url: joinUrl(base, pathPart),
        path: pathPart,
        slug,
        title: p.title,
        meta_description: metaDesc,
        h1: hs.h1 || p.title,
        h2: hs.h2,
        status: String(p.status || 'draft'),
        lang: p.lang || '',
        updated_at: p.updatedAt || p.publishedAt || p.createdAt || '',
        keyword: p.keyword || '',
      })
    );
  }

  const counts = entries.reduce(
    (acc, e) => {
      acc[e.kind] = (acc[e.kind] || 0) + 1;
      if (e.kind === 'post') acc[e.status === 'published' ? 'post_published' : 'post_draft'] += 1;
      return acc;
    },
    { post_published: 0, post_draft: 0 }
  );

  return {
    version: REGISTRY_VERSION,
    generated_at: new Date().toISOString(),
    site_id: client.siteId || '',
    base_url: base,
    default_lang: defaultLang,
    counts,
    total: entries.length,
    entries,
    notes,
    cannibal: null,
  };
}

// ---------------------------------------------------------------------------
// 蚕食信号
// ---------------------------------------------------------------------------

const CANNIBAL_MIN_URLS = 2;
const CANNIBAL_MIN_IMPRESSIONS = 3; // 单 URL 曝光低于这个数当噪声
const CANNIBAL_MAX_SIGNALS = 40;

/**
 * 从 GSC 的 query×page 行算蚕食信号。零 LLM，纯聚合。
 *
 * 判定：同一 query 在窗口内有 CANNIBAL_MIN_URLS 个以上 URL 产生曝光，即记为信号。
 * severity 只看第二名的曝光占比：占比够大才是真在互相抢，尾巴上蹭一点曝光不算。
 *
 * gscData 必须带 query_pages（dimensions ['query','page'] 的原始行）。老快照没有
 * 这个字段，那就诚实地返回 available:false，绝不用 queries 和 pages 两张独立表
 * 硬凑一个映射出来 —— 那是编造。
 */
function cannibalSignals(gscData, opts = {}) {
  if (!gscData) {
    return {
      available: false,
      reason: '这个客户还没有 GSC 快照，蚕食信号无从算起。先跑一次 pull_data。',
      signals: [],
    };
  }
  const data = gscData;
  const rows = Array.isArray(data.query_pages) ? data.query_pages : null;
  if (!rows) {
    return {
      available: false,
      reason:
        'GSC 快照是加 query_pages 维度之前拉的，蚕食信号无法计算。' +
        '用 payload.fresh=true 重跑一次 pull_data 即可补上。',
      signals: [],
    };
  }
  const minImpr = Number(opts.minImpressions) || CANNIBAL_MIN_IMPRESSIONS;
  const minUrls = Number(opts.minUrls) || CANNIBAL_MIN_URLS;
  const maxSignals = Number(opts.maxSignals) || CANNIBAL_MAX_SIGNALS;

  const byQuery = new Map();
  for (const r of rows) {
    if (!r || !r.query || !r.page) continue;
    const impressions = Number(r.impressions) || 0;
    if (impressions < minImpr) continue;
    const q = String(r.query);
    if (!byQuery.has(q)) byQuery.set(q, []);
    byQuery.get(q).push({
      url: String(r.page),
      impressions,
      clicks: Number(r.clicks) || 0,
      position: Number(r.position) || 0,
    });
  }

  const signals = [];
  for (const [query, urls] of byQuery) {
    if (urls.length < minUrls) continue;
    urls.sort((a, b) => b.impressions - a.impressions);
    const total = urls.reduce((s, u) => s + u.impressions, 0);
    const runnerUpShare = total ? urls[1].impressions / total : 0;
    signals.push({
      query,
      url_count: urls.length,
      impressions_total: total,
      clicks_total: urls.reduce((s, u) => s + u.clicks, 0),
      runner_up_share: Math.round(runnerUpShare * 1000) / 1000,
      // 第二名拿到两成以上曝光，或两个 URL 都有点击，才叫真的在互相抢。
      severity: runnerUpShare >= 0.2 || (urls[0].clicks > 0 && urls[1].clicks > 0) ? 'high' : 'low',
      urls: urls.slice(0, 6).map((u) => ({
        url: u.url,
        impressions: u.impressions,
        clicks: u.clicks,
        position: Math.round(u.position * 10) / 10,
      })),
    });
  }
  signals.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
    return b.impressions_total - a.impressions_total;
  });

  return {
    available: true,
    window: { start: data.period_start || null, end: data.period_end || null },
    rows_scanned: rows.length,
    queries_scanned: byQuery.size,
    min_impressions: minImpr,
    signal_count: signals.length,
    high_count: signals.filter((s) => s.severity === 'high').length,
    signals: signals.slice(0, maxSignals),
  };
}

// ---------------------------------------------------------------------------
// 撞车判定
// ---------------------------------------------------------------------------

const LEVEL_EXACT = 'exact';
const LEVEL_HIGH = 'high';
const LEVEL_NEAR = 'near';
const LEVEL_NONE = 'none';

const HIGH_THRESHOLD = 0.75;
const NEAR_THRESHOLD = 0.45;
const LEVEL_RANK = { none: 0, near: 1, high: 2, exact: 3 };

/**
 * 本次选题和站内已有内容的重合判定。零 LLM。
 *
 * exact：slug 完全相同，或主题 token 指纹完全相同。这是同一篇文章的两个名字。
 * high ：token 集合 Jaccard >= 0.75。差一两个修饰词，搜索引擎会当成同一个题。
 * near ：Jaccard >= 0.45。相关但不是同题，写的时候要主动拉开角度。
 *
 * candidate: { slug, keyword, title }
 * opts: { excludeSlug, excludePath }  改稿轮要把文章自己排除掉，否则它永远和自己撞。
 */
function checkCollision(candidate, registry, opts = {}) {
  const entries = (registry && Array.isArray(registry.entries) && registry.entries) || [];
  const cand = {
    slug: String((candidate && candidate.slug) || ''),
    keyword: String((candidate && candidate.keyword) || ''),
    title: String((candidate && candidate.title) || ''),
  };
  const pt = primaryTerm(cand);
  const candSlug = normSlug(cand.slug);
  const exclude = new Set(
    [opts.excludeSlug, opts.excludePath]
      .filter(Boolean)
      .map((s) => normSlug(String(s).replace(/^.*\/blog\//, '')))
  );

  const conflicts = [];
  for (const e of entries) {
    const eSlug = normSlug(e.slug);
    if (exclude.size && (exclude.has(eSlug) || exclude.has(normSlug(String(e.slug).split('/').pop())))) {
      continue;
    }
    const eTokens = e.term_tokens || topicTokens((e.keyword || '') + ' ' + (e.slug || '') + ' ' + (e.title || ''));
    const score = jaccard(pt.tokens, eTokens);
    let level = LEVEL_NONE;
    let reason = '';
    if (candSlug && eSlug && candSlug === eSlug) {
      level = LEVEL_EXACT;
      reason = 'slug 完全相同';
    } else if (pt.key && e.term_key && pt.key === e.term_key) {
      level = LEVEL_EXACT;
      reason = '主词指纹完全相同（' + pt.term + '）';
    } else if (score >= HIGH_THRESHOLD && pt.tokens.length >= 2 && eTokens.length >= 2) {
      level = LEVEL_HIGH;
      reason = '主词重合度 ' + Math.round(score * 100) + '%';
    } else if (score >= NEAR_THRESHOLD) {
      level = LEVEL_NEAR;
      reason = '主词重合度 ' + Math.round(score * 100) + '%';
    }
    if (level === LEVEL_NONE) continue;
    conflicts.push({
      level,
      score: Math.round(score * 100) / 100,
      reason,
      url: e.url || e.path,
      kind: e.kind,
      slug: e.slug,
      title: e.title,
      status: e.status,
      primary_term: e.primary_term,
      intent: e.intent,
    });
  }
  conflicts.sort((a, b) => {
    if (LEVEL_RANK[b.level] !== LEVEL_RANK[a.level]) return LEVEL_RANK[b.level] - LEVEL_RANK[a.level];
    return b.score - a.score;
  });
  const level = conflicts.length ? conflicts[0].level : LEVEL_NONE;
  return {
    level,
    blocking: level === LEVEL_EXACT || level === LEVEL_HIGH,
    candidate: { slug: cand.slug, primary_term: pt.term, tokens: pt.tokens, term_from: pt.from },
    conflicts,
    blockers: conflicts.filter((c) => c.level === LEVEL_EXACT || c.level === LEVEL_HIGH),
    nears: conflicts.filter((c) => c.level === LEVEL_NEAR),
  };
}

/** 打回时给人看的一段话。写清是什么撞了、撞在哪、下一步怎么办。 */
function collisionReport(verdict) {
  const lines = [];
  lines.push(
    '选题与站内已有内容重合，判定 ' +
      verdict.level +
      '。本次候选主词「' +
      (verdict.candidate.primary_term || '（推断不出主词）') +
      '」，slug ' +
      (verdict.candidate.slug || '（无）') +
      '，主词来源 ' +
      verdict.candidate.term_from +
      '。'
  );
  for (const c of verdict.blockers) {
    lines.push(
      '  冲突：' +
        c.url +
        '（' +
        c.kind +
        '，' +
        c.status +
        '，主词「' +
        (c.primary_term || '未知') +
        '」）：' +
        c.reason
    );
  }
  if (verdict.nears.length) {
    lines.push('  另有 ' + verdict.nears.length + ' 条近似内容，未构成打回条件。');
  }
  lines.push(
    '  处理方式：这不是让模型换个标题就能过的问题，是选题本身撞了。' +
      '要么把任务改成扩写或合并已有那篇，要么换一个真正没被覆盖的角度，由人来定。'
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 简报渲染
// ---------------------------------------------------------------------------

const BLOCK_MAX_ENTRIES = 80;
const BLOCK_MAX_SIGNALS = 15;

function entryLine(e, compact) {
  // compact 模式只给路径，不给完整 url。规划简报有 15KB 硬预算，44 条内容的完整
  // url 就要吃掉近 2KB，而域名对规划毫无信息量。写稿简报不用 compact，那里要
  // 模型能直接把 url 抄进内链。
  return (
    '- ' +
    (compact ? e.path || e.url : e.url || e.path) +
    ' | ' +
    truncate(e.title || '(无标题)', compact ? 60 : 90) +
    ' | 主词：' +
    (e.primary_term || '未知') +
    ' | ' +
    (INTENT_LABEL[e.intent] || e.intent) +
    ' | ' +
    (e.status === 'published' ? '已发布' : e.status === 'draft' ? '草稿' : e.status)
  );
}

/**
 * 注入用的注册表区块。纯文本，中文，和 brief.js 与 distill.js 的其他区块同构。
 * opts: { maxEntries, maxSignals, kinds, compact }
 */
function registryBlock(registry, opts = {}) {
  if (!registry || !Array.isArray(registry.entries)) {
    return (
      '站内内容注册表\n' +
      '还没有注册表快照。跑一次 pull_data 会顺带生成它。没有这张表，选题撞车只能靠人肉记忆。'
    );
  }
  const maxEntries = opts.maxEntries || BLOCK_MAX_ENTRIES;
  const maxSignals = opts.maxSignals || BLOCK_MAX_SIGNALS;
  const kinds = opts.kinds || null;
  let entries = registry.entries;
  if (kinds) entries = entries.filter((e) => kinds.indexOf(e.kind) !== -1);

  // 草稿排最前：它们是撞车高发区，而且人在后台最容易忘掉它们的存在。
  const order = { post: 0, collection: 1, collection_item: 3, page: 2 };
  const sorted = entries.slice().sort((a, b) => {
    const ad = a.status === 'draft' ? 0 : 1;
    const bd = b.status === 'draft' ? 0 : 1;
    if (ad !== bd) return ad - bd;
    const ao = order[a.kind] === undefined ? 9 : order[a.kind];
    const bo = order[b.kind] === undefined ? 9 : order[b.kind];
    if (ao !== bo) return ao - bo;
    return String(b.updated_at).localeCompare(String(a.updated_at));
  });
  const shown = sorted.slice(0, maxEntries);

  const head =
    '站内内容注册表，机械枚举自平台接口，生成于 ' +
    String(registry.generated_at || '').slice(0, 19).replace('T', ' ') +
    '，共 ' +
    registry.total +
    ' 条（博文 ' +
    (registry.counts.post || 0) +
    ' 篇，其中草稿 ' +
    (registry.counts.post_draft || 0) +
    ' 篇；页面 ' +
    (registry.counts.page || 0) +
    '；collection ' +
    (registry.counts.collection || 0) +
    '；产品条目 ' +
    (registry.counts.collection_item || 0) +
    '）。';

  const compact = !!opts.compact;
  const blocks = [
    head,
    '站内已覆盖内容清单（' +
      (compact ? '路径' : 'URL') +
      ' | 标题 | 推断主词 | 意图分类 | 状态）' +
      '\n主词是程序按 slug 词干加标题机械推断的，不是模型判断。它明显错的时候是启发式该改了，不要迁就它。',
    shown.map((e) => entryLine(e, compact)).join('\n'),
  ];
  if (sorted.length > shown.length) {
    blocks.push('（还有 ' + (sorted.length - shown.length) + ' 条未列出）');
  }
  if (registry.notes && registry.notes.length) {
    blocks.push('注册表生成时的缺口：\n' + registry.notes.map((n) => '- ' + n).join('\n'));
  }

  const can = registry.cannibal;
  if (!can || !can.available) {
    blocks.push(
      '关键词蚕食信号\n' +
        ((can && can.reason) || '没有蚕食信号数据。') +
        '\n在拿到数据之前，不要断言站上没有蚕食问题。'
    );
  } else if (!can.signals.length) {
    blocks.push(
      '关键词蚕食信号（GSC ' +
        (can.window.start || '?') +
        ' 到 ' +
        (can.window.end || '?') +
        '）\n扫了 ' +
        can.queries_scanned +
        ' 个 query，没有一个 query 有 2 个以上 URL 同时拿到曝光。窗口内没有蚕食信号。'
    );
  } else {
    const rows = can.signals.slice(0, maxSignals).map((s) => {
      const urls = s.urls
        .map(
          (u) =>
            '    ' + u.url + '：曝光 ' + u.impressions + '，点击 ' + u.clicks + '，均位 ' + u.position
        )
        .join('\n');
      return (
        '- "' +
        s.query +
        '"（' +
        s.url_count +
        ' 个 URL 抢同一个 query，合计曝光 ' +
        s.impressions_total +
        '，' +
        (s.severity === 'high' ? '互抢明显' : '轻微') +
        '）\n' +
        urls
      );
    });
    blocks.push(
      '关键词蚕食信号（GSC ' +
        (can.window.start || '?') +
        ' 到 ' +
        (can.window.end || '?') +
        '，同一 query 在窗口内有 2 个以上 URL 拿到曝光即记为信号）\n' +
        '共 ' +
        can.signal_count +
        ' 条信号，其中互抢明显 ' +
        can.high_count +
        ' 条。' +
        (can.signal_count > maxSignals ? '下面按严重度列前 ' + maxSignals + ' 条。' : '') +
        '\n' +
        rows.join('\n') +
        '\n这些 query 已经在互相抢排名。新稿不许再往这些主词上撞，' +
        '要处理它们只能是合并、改内链指向或明确分工，不是再写一篇。'
    );
  }
  return blocks.join('\n\n');
}

/**
 * 写稿 prompt 用的硬约束段：把站内已占用的 slug 和主词列成禁止清单。
 * 和 registryBlock 分开，因为一个是给模型看的情报，一个是给模型的禁令。
 */
function forbiddenBlock(registry, opts = {}) {
  const entries = (registry && Array.isArray(registry.entries) && registry.entries) || [];
  const excludeSlug = normSlug(opts.excludeSlug || '');
  const posts = entries.filter((e) => e.kind === 'post' && normSlug(e.slug) !== excludeSlug);
  if (!posts.length) return '站上还没有博文，slug 和主词没有已占用的。';
  const slugs = posts.map((e) => e.slug).slice(0, 120);
  const terms = [];
  for (const e of posts) {
    if (e.primary_term && terms.indexOf(e.primary_term) === -1) terms.push(e.primary_term);
  }
  return [
    '已被占用的 slug（一个都不许重复使用，含未发布草稿）：',
    slugs.map((s) => '  ' + s).join('\n'),
    '',
    '已被占用的主词（本篇的主词不许等同于、也不许只差一两个修饰词地重复下面任何一条）：',
    terms.slice(0, 120).map((t) => '  ' + t).join('\n'),
    '',
    '这条是机械校验项：交稿之后程序会拿你的 slug 和 keyword 跟上面这两张表逐条比对，',
    '判定为 exact 或 high 的直接打回，本次任务失败，稿子不会上平台。',
    '如果你调研后认为这个题就是应该写，且站上那篇写得不够，正确做法不是硬写一篇新的，',
    '而是在正文开头明确说明"本题与 XXX 重合，建议改为扩写该篇"，然后照常交 json，让人来定。',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// 客户端装配
// ---------------------------------------------------------------------------

/** 凭据文件路径，和 execute_task 用的是同一套约定。 */
function credentialsPath(workspace, platform) {
  return path.join(workspace, 'notes', capabilities.slugPlatform(platform) + '_credentials.md');
}

/**
 * 按 profile 登录 WebForger。凭据永远从工作区的凭据文件读，不进 config，不进代码。
 * 返回 { client, who }，缺凭据或缺 platform 时抛错，由调用方决定是降级还是失败。
 */
async function openClient(cfg, profile, log) {
  const platform = (profile && (profile.platform || profile.cms)) || '';
  if (!platform) throw new Error('profile 没有 platform 字段，不知道该用哪套凭据');
  const workspace = ensureClientWorkspace(profile, cfg);
  const credPath = credentialsPath(workspace, platform);
  if (!fs.existsSync(credPath)) throw new Error('凭据文件不存在：' + credPath);
  const cred = wf.readCredentials(credPath);
  const client = new wf.WebForger({
    base: cfg.webforgerApi,
    timeoutMs: cfg.httpTimeoutMs,
    lang: cfg.blogLang || '',
  });
  const who = await client.login(cred.email, cred.password);
  if (log) log('registry: 已登录 WebForger，siteId ' + who.siteId);
  return { client, who, workspace };
}

module.exports = {
  SOURCE,
  REGISTRY_VERSION,
  // 枚举
  buildRegistry,
  openClient,
  credentialsPath,
  // 蚕食
  cannibalSignals,
  CANNIBAL_MIN_URLS,
  CANNIBAL_MIN_IMPRESSIONS,
  // 撞车
  checkCollision,
  collisionReport,
  LEVEL_EXACT,
  LEVEL_HIGH,
  LEVEL_NEAR,
  LEVEL_NONE,
  HIGH_THRESHOLD,
  NEAR_THRESHOLD,
  // 渲染
  registryBlock,
  forbiddenBlock,
  INTENT_LABEL,
  // 启发式，导出是为了可以单独被测
  stem,
  words,
  topicTokens,
  termKey,
  jaccard,
  normSlug,
  normUrl,
  primaryTerm,
  intentOf,
  headingsOf,
  headingsOfElements,
  baseUrlOf,
};
