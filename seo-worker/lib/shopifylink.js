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
  const tasks = (deps && deps.tasks) || (await api.getTasks(clientId)) || [];
  const list = (deps && deps.articles) || (await listArticles(store.alias));
  let checked = 0;
  let changed = 0;
  for (const t of (Array.isArray(tasks) ? tasks : tasks.tasks || [])) {
    if (!isShopifyBlogTask(t)) continue;
    if (/\?t=\d+&k=[a-f0-9]+/.test(String(t.output_url || ''))) continue;
    const ref = articleRefOf(t);
    if (!ref) continue;
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
  syncClientLinks,
};
