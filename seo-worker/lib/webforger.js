'use strict';
// Minimal WebForger API client for the blog pipeline.
//
// Only the endpoints the blog runners actually use are here. Everything else
// stays out on purpose: this file is the whole surface through which a runner
// can touch a client site, and a short surface is an auditable one.
//
// Credential discipline, non negotiable:
//   the token lives in memory on the instance and nowhere else;
//   nothing in this file logs a token, an email or a password;
//   callers get { ok } style objects, never the raw Authorization header.

const fs = require('node:fs');

const { requestJson, request } = require('./http');

const DEFAULT_BASE = 'https://api.webforger.ai';

/**
 * Pull the bot email and password out of the workspace credentials note.
 * The file is hand maintained, so the parser is deliberately forgiving about
 * markdown decoration: bold, backticks, table cells and full width colons all
 * appear in the wild. Values are never logged, only their presence.
 */
function parseCredentials(text) {
  const out = { email: '', password: '' };
  const lines = String(text || '').split('\n');
  let inFence = false;
  // Strip markdown noise and quoting, keep the first whitespace-free token.
  const clean = (v) =>
    String(v || '')
      .replace(/[|*`'"，,{}]/g, ' ')
      .trim()
      .split(/\s+/)[0] || '';
  for (const raw of lines) {
    const line = String(raw);
    // Example commands (curl bodies and the like) live inside fences and must
    // never be mistaken for the real values. That exact bug shipped once.
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    let key = '';
    let val = '';
    if (line.trim().startsWith('|')) {
      // Markdown table row: | Email | `x@y` |  (no colon anywhere)
      const cells = line
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);
      if (cells.length < 2) continue;
      key = cells[0].toLowerCase();
      val = clean(cells.slice(1).join(' '));
    } else if (/[:：]/.test(line)) {
      const parts = line.split(/[:：]/);
      key = parts[0].toLowerCase();
      val = clean(parts.slice(1).join(':'));
    } else {
      continue;
    }
    if (!out.email && /(email|账号|帐号|用户名|username)/.test(key) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
      out.email = val;
    }
    if (!out.password && /(password|密码|口令)/.test(key) && val) {
      out.password = val;
    }
  }
  return out;
}

function readCredentials(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error('凭据文件读不到：' + file + '（' + e.message + '）');
  }
  const cred = parseCredentials(text);
  if (!cred.email || !cred.password) {
    throw new Error(
      '凭据文件里没解析出 email 和 password：' + file + '。需要形如 "email: xxx@yyy" 和 "password: zzz" 的行'
    );
  }
  return cred;
}

class WebForger {
  constructor(opts = {}) {
    this.base = String(opts.base || DEFAULT_BASE).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs || 60000;
    this.token = '';
    this.siteId = '';
    this.lang = opts.lang || '';
  }

  headers() {
    const h = { Accept: 'application/json' };
    if (this.token) h.Authorization = 'Bearer ' + this.token;
    return h;
  }

  async req(method, path, body) {
    return requestJson(this.base + path, {
      method,
      body,
      timeoutMs: this.timeoutMs,
      headers: this.headers(),
    });
  }

  /** Query suffix for a non default language, empty for the default one. */
  langQuery(joiner) {
    if (!this.lang) return '';
    return (joiner || '?') + 'lang=' + encodeURIComponent(this.lang);
  }

  /**
   * POST /api/auth/login. Sets this.token and this.siteId from user.shadowOf.
   * Throws when the account is not a shadow bot: a real user token would let a
   * runner write to a site it was never scoped to.
   */
  async login(email, password) {
    const res = await requestJson(this.base + '/api/auth/login', {
      method: 'POST',
      body: { email, password },
      timeoutMs: this.timeoutMs,
      headers: { Accept: 'application/json' },
    });
    const token = res && res.token;
    const user = (res && res.user) || {};
    if (!token) throw new Error('登录响应里没有 token');
    if (!user.isShadow || !user.shadowOf) {
      throw new Error('登录成功但这不是 shadow bot 账号，拒绝继续（shadowOf 缺失）');
    }
    this.token = token;
    this.siteId = String(user.shadowOf);
    return { siteId: this.siteId, username: user.username || '' };
  }

  /**
   * POST /api/changesets/{siteId} { reason, taskId } -> { id }
   * apply 阶段的安全网：worker 自己开，把 id 塞进 prompt，模型每个写请求带
   * X-WF-Changeset。开不出来就不 apply，没有安全网的写一次都不发。
   */
  async openChangeset(reason, taskId) {
    const res = await this.req('POST', '/api/changesets/' + encodeURIComponent(this.siteId), {
      reason: String(reason || '').slice(0, 200),
      taskId: String(taskId || ''),
    });
    const id = res && (res.id || (res.changeset && res.changeset.id));
    if (!id) throw new Error('changeset 响应里没有 id：' + JSON.stringify(res || {}).slice(0, 200));
    return String(id);
  }

  /** GET /api/changesets/{siteId}/{csId} -> { changeset: { files: [...] , ... } } */
  async getChangeset(csId) {
    const res = await this.req(
      'GET',
      '/api/changesets/' + encodeURIComponent(this.siteId) + '/' + encodeURIComponent(csId)
    );
    const cs = (res && (res.changeset || res)) || {};
    const entries = Array.isArray(cs.files)
      ? cs.files
          .map((f) => {
            if (typeof f === 'string') return { path: f, op: '', preEtag: '', postEtag: '' };
            const o = f || {};
            return {
              path: String(o.path || o.file || o.name || ''),
              op: String(o.op || ''),
              preEtag: String(o.preEtag || o.pre_etag || ''),
              postEtag: String(o.postEtag || o.post_etag || ''),
            };
          })
          .filter((e) => e.path)
      : [];
    return { raw: cs, files: entries.map((e) => e.path), entries, status: cs.status || '' };
  }

  /** GET /api/blog/{siteId} -> summary rows, no bodies. */
  async listPosts() {
    const res = await this.req('GET', '/api/blog/' + encodeURIComponent(this.siteId) + this.langQuery('?'));
    if (Array.isArray(res)) return res;
    return (res && (res.posts || res.items)) || [];
  }

  /** GET /api/blog/{siteId}/{slug} -> { post, previewUrl } */
  async getPost(slug) {
    return this.req(
      'GET',
      '/api/blog/' + encodeURIComponent(this.siteId) + '/' + encodeURIComponent(slug) + this.langQuery('?')
    );
  }

  /** POST /api/blog/{siteId} -> { post, previewUrl }. Always creates a draft. */
  async createPost(body) {
    return this.req('POST', '/api/blog/' + encodeURIComponent(this.siteId) + this.langQuery('?'), body);
  }

  /** PATCH /api/blog/{siteId}/{slug}. Does not rotate the preview token. */
  async patchPost(slug, body) {
    return this.req(
      'PATCH',
      '/api/blog/' + encodeURIComponent(this.siteId) + '/' + encodeURIComponent(slug) + this.langQuery('?'),
      body
    );
  }

  /** POST /api/blog/{siteId}/{slug}/publish. Deletes the preview token. */
  async publishPost(slug) {
    return this.req(
      'POST',
      '/api/blog/' + encodeURIComponent(this.siteId) + '/' + encodeURIComponent(slug) + '/publish' + this.langQuery('?'),
      {}
    );
  }

  /**
   * GET /api/blog/{siteId}?full=1 -> whole post objects, body and meta included.
   * The platform warns this is slow on a large blog, so the registry builder
   * falls back to per slug reads when it fails or times out.
   */
  async listPostsFull() {
    const q = this.lang ? '?full=1&lang=' + encodeURIComponent(this.lang) : '?full=1';
    const res = await this.req('GET', '/api/blog/' + encodeURIComponent(this.siteId) + q);
    if (Array.isArray(res)) return res;
    return (res && (res.posts || res.items)) || [];
  }

  /** GET /api/blog/{siteId}/categories */
  async listCategories() {
    const res = await this.req('GET', '/api/blog/' + encodeURIComponent(this.siteId) + '/categories');
    if (Array.isArray(res)) return res;
    return (res && (res.categories || res.items)) || [];
  }

  /** GET /api/pages/{siteId} -> the page registry, used to police internal links. */
  async listPages() {
    const res = await this.req('GET', '/api/pages/' + encodeURIComponent(this.siteId));
    if (Array.isArray(res)) return res;
    return (res && (res.pages || res.items)) || [];
  }

  /**
   * GET /api/collections/{siteId} -> { collections: { slug: schema } }.
   * Normalized to an array so callers never have to know it is a map.
   */
  async listCollections() {
    const res = await this.req('GET', '/api/collections/' + encodeURIComponent(this.siteId));
    const raw = (res && (res.collections || res.items)) || res || {};
    if (Array.isArray(raw)) return raw;
    if (typeof raw !== 'object') return [];
    return Object.keys(raw).map((slug) => Object.assign({ slug }, raw[slug] || {}));
  }

  /** GET /api/collections/{siteId}/{collSlug}/items -> { items, schema } */
  async listCollectionItems(collSlug) {
    const res = await this.req(
      'GET',
      '/api/collections/' +
        encodeURIComponent(this.siteId) +
        '/' +
        encodeURIComponent(collSlug) +
        '/items'
    );
    if (Array.isArray(res)) return res;
    return (res && (res.items || [])) || [];
  }

  /**
   * GET /api/content/{siteId}/elements?page=pages/{slug}.html
   * The only read that exposes a page's headings. The page argument is the
   * repository path, not the public url: static and collection landing pages
   * both live at pages/{slug}.html, and anything else 404s with
   * "Page not found", which the caller treats as "no headings available".
   */
  async pageElements(pagePath) {
    const res = await this.req(
      'GET',
      '/api/content/' +
        encodeURIComponent(this.siteId) +
        '/elements?page=' +
        encodeURIComponent(pagePath)
    );
    if (Array.isArray(res)) return res;
    return (res && res.elements) || [];
  }

  /** GET /api/content/{siteId}/meta -> site status and domains. */
  async getMeta() {
    return this.req('GET', '/api/content/' + encodeURIComponent(this.siteId) + '/meta');
  }

  /**
   * POST /api/content/{siteId}/generate-image -> { ok, url, used, limit }.
   *
   * FLUX 1.1 Pro through the platform. The call is synchronous from our side:
   * the platform talks to Replicate and polls it for up to 60s before answering,
   * so nothing here needs a polling loop, it just needs a timeout wide enough to
   * outlast the platform's own. url comes back as a site relative asset path,
   * for example /assets/1712345678-flux-oak-floor.jpg.
   *
   * A shadow account bypasses the plan gate and the monthly cap, and its
   * generations are billed to the platform rather than the client's counter.
   */
  async generateImage(prompt, opts = {}) {
    const text = String(prompt || '').trim();
    if (text.length < 3) throw new Error('generate-image 的 prompt 不能为空');
    const body = { prompt: text, aspect_ratio: opts.aspectRatio || '16:9' };
    if (opts.style) body.style = String(opts.style);
    const res = await requestJson(
      this.base + '/api/content/' + encodeURIComponent(this.siteId) + '/generate-image',
      {
        method: 'POST',
        body,
        timeoutMs: opts.timeoutMs || 150000,
        headers: this.headers(),
      }
    );
    const url = String((res && res.url) || '');
    if (!url) throw new Error('generate-image 响应里没有 url 字段');
    return { url, used: res && res.used, limit: res && res.limit };
  }
}

/** Scheme plus host of a url, for turning /assets/... into something fetchable. */
function originOf(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol + '//' + u.host;
  } catch (e) {
    return '';
  }
}

/** Plain unauthenticated GET of a live page, for post publish verification. */
async function fetchPublic(url, timeoutMs) {
  const r = await request(url, {
    method: 'GET',
    timeoutMs: timeoutMs || 30000,
    headers: { Accept: 'text/html', 'User-Agent': 'horntech-seo-worker' },
  });
  return { status: r.status, headers: r.headers || {}, text: r.text || '' };
}

/** Strip the ?preview=token query off a preview URL to get the live one. */
function publicUrlOf(previewUrl) {
  const s = String(previewUrl || '');
  const q = s.indexOf('?');
  return q === -1 ? s : s.slice(0, q);
}

/**
 * Pull the blog slug out of a preview or live blog URL.
 * Handles /blog/{slug}/ and /{lang}/blog/{slug}/ shapes.
 */
function slugFromBlogUrl(url) {
  const clean = publicUrlOf(url).replace(/\/+$/, '');
  const m = clean.match(/\/blog\/([^/?#]+)$/);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]);
  } catch (e) {
    return m[1];
  }
}

/** Is this url a blog post url on the client's own site? */
function isBlogUrl(url, domain) {
  const s = String(url || '');
  if (!/^https?:\/\//.test(s)) return false;
  if (s.indexOf('/blog/') === -1) return false;
  if (!domain) return true;
  let host = '';
  try {
    host = new URL(s).host.toLowerCase().replace(/^www\./, '');
  } catch (e) {
    return false;
  }
  let want = '';
  try {
    want = new URL(String(domain).match(/^https?:\/\//) ? domain : 'https://' + domain)
      .host.toLowerCase()
      .replace(/^www\./, '');
  } catch (e) {
    want = String(domain).toLowerCase().replace(/^www\./, '');
  }
  // Platform preview hosts ({siteId}.webforger.site) count as the site too.
  return host === want || host.endsWith('.webforger.site');
}

module.exports = {
  WebForger,
  parseCredentials,
  readCredentials,
  fetchPublic,
  publicUrlOf,
  originOf,
  slugFromBlogUrl,
  isBlogUrl,
  DEFAULT_BASE,
};
