'use strict';
/* 任务的目标文章（2026-11-18 ticket #64 与 Ben's NZ #2151 同根）。

   派单的人和 chat 在派单那一刻明确知道要动哪篇文章，但任务上没有地方放这个事实，
   只能写进任务书的句子里，执行器和发布闸再用正则从正文猜回来。任务书一旦提到第二篇
   文章（比如「和 /blog/另一篇/ 分开角度」）就猜不出，猜错一次补一条正则，补过六轮
   （ticket #43 #47 #48 #63，#2006/#2017，#2151）。

   这里把它变成任务书上的一行标记，和 [backing]、[委托单] 同一套约定：
     [target] /blog/<slug>/
   独占一行才算。chat 派单时由生产端校验落这一行；执行器和服务端都先读它，
   没有这一行的旧单才退回扫正文。服务端的同名实现在 seo-api.php 的 task_target_of / task_blog_slug。 */

const TARGET_LINE_RE = /^\[target\][ \t]*(\S+)[ \t]*$/m;
const BLOG_PATH_RE = /\/blog\/([A-Za-z0-9][A-Za-z0-9_-]*)/;

/** 任务书里的 [target] 行，没有返回空串。 */
function targetOf(detail) {
  const m = TARGET_LINE_RE.exec(String(detail || ''));
  return m ? m[1] : '';
}

/** 把模型或人给的目标（相对路径或完整网址）规整成 /blog/<slug>/，不是博客文章返回空串。 */
function normalizeBlogTarget(raw) {
  const m = BLOG_PATH_RE.exec(String(raw || '').trim());
  return m ? '/blog/' + m[1] + '/' : '';
}

/** 一段文字里出现的全部不同博客 slug（按出现顺序）。 */
function blogSlugsIn(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\/blog\/([A-Za-z0-9][A-Za-z0-9_-]*)/g)) {
    if (out.indexOf(m[1]) === -1) out.push(m[1]);
  }
  return out;
}

function opsList(ops) {
  return (Array.isArray(ops) ? ops : String(ops || '').split(','))
    .map((x) => String(x || '').trim().toLowerCase()).filter(Boolean);
}

/** 这张单动的是站上已有的某一篇文章，目标必须明确：
    发布单（blog-publish，同意是按篇给的），或走博客模式的改稿单（blog-draft 加 blog-edit）。
    新写一篇（只有 blog-draft）不算；只有 blog-edit 的是方案泳道的批量改（一张单改多篇内链、title），
    目标在方案条目里逐条列，不归这里管。 */
function needsBlogTarget(ops) {
  const l = opsList(ops);
  if (l.indexOf('blog-publish') !== -1) return true;
  return l.indexOf('blog-edit') !== -1 && l.indexOf('blog-draft') !== -1;
}

/** 申报了改已有文章。执行器定位不到目标时凭它停下，不许退回写新稿。 */
function declaresEdit(ops) {
  return opsList(ops).indexOf('blog-edit') !== -1;
}

/**
 * 派单时给任务书落 [target] 行。返回 { detail, target, error }。
 *   给了 target 且是博客文章 → 落行；
 *   没给、是博客单、任务书（含标题）里恰好只有一篇 → 用它落行，这是确定的不是猜；
 *   改稿或发布单没给、任务书里又出现多篇 → error，单不能出，让派单方把目标写明。
 * 已有 [target] 行的不重复落。
 */
function stampTarget(draft) {
  const detail = String((draft && draft.detail) || '');
  const existing = normalizeBlogTarget(targetOf(detail));
  if (existing) return { detail, target: existing, error: '' };
  let target = normalizeBlogTarget(draft && draft.target);
  const blogOps = opsList(draft && draft.ops).some((o) => o.indexOf('blog-') === 0);
  const slugs = blogOps ? blogSlugsIn(String((draft && draft.title) || '') + '\n' + detail) : [];
  if (!target && slugs.length === 1) target = '/blog/' + slugs[0] + '/';
  if (!target) {
    /* 只拦真有歧义的：任务书里出现了多篇文章又没说动哪篇。一篇都没出现的不拦
       （网址不带 /blog/ 的站、只写了文章标题的单），照旧由执行器现有办法定位。 */
    if (needsBlogTarget(draft && draft.ops) && slugs.length > 1) {
      return { detail, target: '', error: '任务书里出现了 ' + slugs.length + ' 篇文章（' + slugs.slice(0, 3).join('、')
        + '），没写明这张单动哪一篇：target 填目标文章的站内路径 /blog/<slug>/ 后重出' };
    }
    return { detail, target: '', error: '' };
  }
  return { detail: detail.replace(/\s+$/, '') + '\n[target] ' + target, target, error: '' };
}

module.exports = { targetOf, normalizeBlogTarget, blogSlugsIn, needsBlogTarget, declaresEdit, stampTarget, TARGET_LINE_RE };
