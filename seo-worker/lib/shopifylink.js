'use strict';
/**
 * Shopify 博客任务卡片链接（2026-09-22 Alvin 定，sungait #619 事故：草稿建好后卡上没有任何链接，
 * 人只看到「done」，不知道文章一直是隐藏的草稿）。
 *
 * 规则：已发布 = 正式链接（https://<站点域名>/blogs/<blog>/<handle>）；
 *       未发布 = Shopify admin 文章页（https://<店>.myshopify.com/admin/articles/<id>，后台可预览）。
 *
 * 零模型。读文章只走 shopseo CLI 的读命令（token 服务现取，不落盘）。
 * 多 worker 安全：只做「读平台 -> 算链接 -> 值不同才写」，幂等，谁先跑都一样。
 */
const fs = require('fs');
const { execFile } = require('child_process');

const SHOPSEO_DIR = '/data/aira/tools/shopseo';
const SHOPSEO_CLI = SHOPSEO_DIR + '/shopseo';
const STORES_CONF = SHOPSEO_DIR + '/stores.conf';

const ADMIN_RE = /^https:\/\/([a-z0-9-]+\.myshopify\.com)\/admin\/articles\/(\d+)/i;

function parseStores(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^([a-z0-9_-]+)=(\S+\.myshopify\.com)/i);
    if (m) out[m[1].toLowerCase()] = m[2].toLowerCase();
  }
  return out;
}

/** 按 profile.workspace_dir 匹配店铺别名，口径与 apply_task 的 Shopify 泳道一致。 */
function storeFor(profile, storesText) {
  const stores = parseStores(storesText !== undefined ? storesText : safeRead(STORES_CONF));
  const ws = String((profile && profile.workspace_dir) || '').toLowerCase();
  if (!ws) return null;
  for (const alias of Object.keys(stores)) {
    if (ws === alias || ws.indexOf(alias) === 0) return { alias, myshopify: stores[alias] };
  }
  return null;
}

function safeRead(f) {
  try { return fs.readFileSync(f, 'utf8'); } catch (e) { return ''; }
}

function siteOrigin(profile) {
  const d = String((profile && profile.domain) || '').trim().replace(/\/+$/, '');
  if (!d) return '';
  return /^https?:\/\//.test(d) ? d.replace(/^http:/, 'https:') : 'https://' + d;
}

/** 文章对象（articles list 或 article get 的 JSON）算卡片链接。 */
function linkFor(article, profile, myshopify) {
  if (!article) return '';
  const published = article.published === true || (article.published !== false && !!article.published_at);
  const blog = article.blog || article.blog_handle || '';
  if (published && blog && article.handle) {
    const origin = siteOrigin(profile);
    if (origin) return origin + '/blogs/' + blog + '/' + article.handle;
  }
  if (article.id && myshopify) return 'https://' + myshopify + '/admin/articles/' + article.id;
  return '';
}

/**
 * 从任务的 output_url / result_note 里认出它指的是哪篇文章。
 * 认 admin 链接里的 id、「article id 123」、以及 blogs/<blog>/<handle> 路径。
 */
function articleRefOf(task) {
  const ou = String((task && task.output_url) || '');
  const am = ou.match(ADMIN_RE);
  if (am) return { id: am[2] };
  const text = ou + '\n' + String((task && task.result_note) || '');
  const idm = text.match(/article id\s*(\d{6,})/i);
  const hm = text.match(/blogs\/([a-z0-9-]+)\/([a-z0-9][a-z0-9-]*[a-z0-9])/i);
  if (!idm && !hm) return null;
  return { id: idm ? idm[1] : '', blog: hm ? hm[1] : '', handle: hm ? hm[2] : '' };
}

function isShopifyBlogTask(task) {
  const ops = String((task && task.ops) || '');
  return /blog-draft|article-/.test(ops) || ADMIN_RE.test(String((task && task.output_url) || ''));
}

function runShopseo(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(SHOPSEO_CLI, args, {
      timeout: timeoutMs || 90000,
      maxBuffer: 32 * 1024 * 1024,
      env: Object.assign({}, process.env, {
        SHOPSEO_ENV: SHOPSEO_DIR + '/.env',
        SHOPSEO_STORES: STORES_CONF,
        SHOPSEO_SNAPSHOTS: SHOPSEO_DIR + '/snapshots',
      }),
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error('shopseo ' + args.join(' ') + ' :: ' + String(stderr || err.message).slice(0, 300)));
      resolve(String(stdout || ''));
    });
  });
}

async function listArticles(alias) {
  const out = await runShopseo(['--shop', alias, 'articles', 'list', '--json']);
  const d = JSON.parse(out);
  return Array.isArray(d) ? d : (d && Array.isArray(d.articles) ? d.articles : []);
}

/* 轻量只读（2026-09-22）：articles list 逐篇拉 SEO 字段，十家店扫一遍要几分钟，不适合每小时跑。
   链接只要 id/handle/blog/published_at，一篇一个 GET，只读不写（写仍然只走 shopseo）。
   token 与 shopseo 同源：.env 的 TOKEN_ENDPOINT + TOKEN_KEY 现取，不缓存不落盘。 */
const API_VER = '2025-07';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readEnv(file) {
  const out = {};
  for (const line of safeRead(file).split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function getToken(myshopify) {
  const env = readEnv(SHOPSEO_DIR + '/.env');
  if (!env.TOKEN_ENDPOINT || !env.TOKEN_KEY) throw new Error('shopseo .env 缺 TOKEN_ENDPOINT/TOKEN_KEY');
  const r = await fetch(env.TOKEN_ENDPOINT + '?shop=' + encodeURIComponent(myshopify) + '&key=' + encodeURIComponent(env.TOKEN_KEY));
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) throw new Error('token 服务没给 access_token（' + myshopify + '）：' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

async function adminGet(myshopify, token, pathQ) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch('https://' + myshopify + '/admin/api/' + API_VER + pathQ, { headers: { 'X-Shopify-Access-Token': token } });
    if (r.status === 429) { await sleep(2000 * (i + 1)); continue; }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('GET ' + pathQ + ' HTTP ' + r.status);
    await sleep(600); // 每店 2 req/s
    return r.json();
  }
  throw new Error('GET ' + pathQ + ' 连续 429');
}

/** 只取 refs 指到的文章，返回与 articles list 同形的精简对象（id/handle/blog/published_at/published）。 */
async function fetchArticles(myshopify, refs) {
  const token = await getToken(myshopify);
  const bj = await adminGet(myshopify, token, '/blogs.json?fields=id,handle');
  const blogs = (bj && bj.blogs) || [];
  const handleOf = {};
  for (const b of blogs) handleOf[String(b.id)] = b.handle;
  const out = [];
  const seen = new Set();
  const push = (a) => {
    if (!a || seen.has(String(a.id))) return;
    seen.add(String(a.id));
    out.push({ id: a.id, handle: a.handle, blog: handleOf[String(a.blog_id)] || '', published_at: a.published_at || null, published: !!a.published_at });
  };
  for (const ref of refs) {
    if (!ref) continue;
    if (ref.id) {
      const j = await adminGet(myshopify, token, '/articles/' + ref.id + '.json?fields=id,handle,published_at,blog_id');
      if (j && j.article) { push(j.article); continue; }
    }
    if (ref.handle) {
      for (const b of blogs) {
        if (ref.blog && b.handle !== ref.blog) continue;
        const j = await adminGet(myshopify, token, '/blogs/' + b.id + '/articles.json?handle=' + encodeURIComponent(ref.handle) + '&fields=id,handle,published_at,blog_id');
        const a = j && j.articles && j.articles[0];
        if (a) { push(Object.assign({ blog_id: b.id }, a)); break; }
      }
    }
  }
  return out;
}

function findArticle(list, ref) {
  if (!ref) return null;
  if (ref.id) {
    const byId = list.find((a) => String(a.id) === String(ref.id));
    if (byId) return byId;
  }
  if (ref.handle) {
    return list.find((a) => a.handle === ref.handle && (!ref.blog || (a.blog || a.blog_handle) === ref.blog)) || null;
  }
  return null;
}

/**
 * 一个客户的 Shopify 博客任务链接对齐。返回 { checked, changed, skipped }。
 * 只改 output_url，不动状态；确认卡链接（?t=&k=）不覆盖，那是客户要点的卡。
 */
async function syncClientLinks(api, clientId, profile, log, deps) {
  const say = log || function () {};
  const store = storeFor(profile);
  if (!store) return { checked: 0, changed: 0, skipped: 'no store alias' };
  /* 任务从 /context 取（auth_worker，SELECT * 带 output_url/result_note/ops）；GET /tasks 是人工登录鉴权，worker 进不去。 */
  let tasks = deps && deps.tasks;
  if (!tasks) {
    const ctx = await api.getContext(clientId);
    tasks = (ctx && ctx.tasks) || [];
  }
  const cands = [];
  for (const t of (Array.isArray(tasks) ? tasks : tasks.tasks || [])) {
    if (!isShopifyBlogTask(t)) continue;
    if (/\?t=\d+&k=[a-f0-9]+/.test(String(t.output_url || ''))) continue;
    const ref = articleRefOf(t);
    if (ref) cands.push({ t, ref });
  }
  if (!cands.length) return { checked: 0, changed: 0 };
  const list = (deps && deps.articles) || (await fetchArticles(store.myshopify, cands.map((c) => c.ref)));
  let checked = 0;
  let changed = 0;
  for (const { t, ref } of cands) {
    const art = findArticle(list, ref);
    checked++;
    if (!art) {
      say('shopify 链接：任务 #' + t.id + ' 指向的文章在店里找不到（' + JSON.stringify(ref) + '），不改');
      continue;
    }
    const want = linkFor(art, profile, store.myshopify);
    if (!want || want === String(t.output_url || '')) continue;
    await api.setTaskOutputUrl(t.id, want);
    changed++;
    say('shopify 链接：任务 #' + t.id + ' ' + (t.output_url || '（空）') + ' -> ' + want);
  }
  return { checked, changed };
}

module.exports = {
  parseStores,
  storeFor,
  linkFor,
  articleRefOf,
  isShopifyBlogTask,
  findArticle,
  listArticles,
  fetchArticles,
  syncClientLinks,
};
