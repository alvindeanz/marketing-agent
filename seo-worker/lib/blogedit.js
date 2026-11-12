'use strict';
/* 博客改稿 = 原地改（2026-11-12，Alvin 批，第一性原理重做）。
 *
 * 旧做法是让模型把整篇文章重新生成一遍，再拿新稿的全套契约去验：改三句话、删一张图的单
 * 死在字数、配图数、H2 句式、话术长度这些和任务无关的规则上（#2006/#2007/#2042，之前
 * #1597/#1608/#1574 同病，每次都是给校验器再补一个例外）。
 *
 * 新做法只有两条规矩：
 * 1. 模型只交替换清单（find 原文片段 → replace 新片段），机器套到原稿上。没点名的部分
 *    逐字不变是机制保证的，不靠校验去抓。
 * 2. 校验只问一件事：改完有没有比改之前多出新毛病。原稿本来就有的问题不是这张单的事。
 *
 * 零网络零模型，纯函数，测试在 tests/blogedit.test.js。
 */

/** 模型可以顺带改的字段（任务点名才改）。slug、category、keyword 不许动。 */
const EDITABLE_FIELDS = ['title', 'excerpt', 'meta_description'];

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) { n += 1; i = hay.indexOf(needle, i + needle.length); }
  return n;
}

/**
 * 把替换清单套到原稿上。
 * base: { title, slug, category, keyword, excerpt, meta_description, body }（平台现状）
 * out:  模型交回的对象 { edits:[{find,replace}], title?, excerpt?, meta_description?, cover_image?, social_message }
 * 返回 { ok, errors, draft, changed:[字段名], applied:数量, noop:套完一个字没变 }
 */
function applyEdits(base, out) {
  const errors = [];
  const o = out && typeof out === 'object' ? out : {};
  const edits = Array.isArray(o.edits) ? o.edits : null;
  if (!edits) errors.push('json 里没有 edits 数组。改稿只交替换清单，不交整篇正文');
  let body = String((base && base.body) || '');
  let applied = 0;
  for (let i = 0; edits && i < edits.length; i += 1) {
    const e = edits[i] || {};
    const find = typeof e.find === 'string' ? e.find : '';
    const tag = 'edits[' + i + ']';
    if (!find) { errors.push(tag + ' 的 find 是空的'); continue; }
    if (typeof e.replace !== 'string') { errors.push(tag + ' 缺 replace（要删除就给空字符串）'); continue; }
    const n = countOccurrences(body, find);
    if (n === 0) {
      errors.push(tag + ' 的 find 在原稿里找不到，必须从「当前草稿全文」里逐字照抄（含标点、空格、换行）：' + find.slice(0, 80));
      continue;
    }
    if (n > 1) {
      errors.push(tag + ' 的 find 在原稿里出现 ' + n + ' 次，带上前后文让它唯一：' + find.slice(0, 80));
      continue;
    }
    if (find === e.replace) continue;
    body = body.replace(find, () => e.replace);
    applied += 1;
  }
  const changed = [];
  const draft = {
    title: String((base && base.title) || ''),
    slug: String((base && base.slug) || ''),
    category: String((base && base.category) || ''),
    keyword: String((base && base.keyword) || ''),
    excerpt: String((base && base.excerpt) || ''),
    meta_description: String((base && base.meta_description) || ''),
    body_markdown: body,
    social_message: typeof o.social_message === 'string' ? o.social_message : '',
  };
  for (const f of EDITABLE_FIELDS) {
    if (typeof o[f] === 'string' && o[f].trim() !== '' && o[f] !== draft[f]) {
      draft[f] = o[f];
      changed.push(f);
    }
  }
  /* 封面是文章上的一个字段（平台 meta.ogImage），不在正文里，替换清单够不着（ticket #61：
     Sammichelle #2080 要换封面，改稿流程没有这个字段，agent 回「平台没有换封面的操作」原样收口）。
     只收站内素材路径；存不存在由 runner 拿素材库核，这里只管形状。 */
  draft.cover_image = String((base && base.cover_image) || '');
  if (typeof o.cover_image === 'string' && o.cover_image.trim() !== '') {
    const cv = o.cover_image.trim();
    if (!/^\/assets\/[^\s"'<>]+\.(jpe?g|png|webp|avif)$/i.test(cv)) {
      errors.push('cover_image 只能是站内素材路径（/assets/ 开头的图片文件），不收外链和编造的路径：' + cv.slice(0, 120));
    } else if (cv !== draft.cover_image) {
      draft.cover_image = cv;
      changed.push('cover_image');
    }
  }
  if (applied > 0) changed.push('body');
  if (!draft.social_message.trim()) errors.push('json 缺 social_message（发给客户的中文微信话术，说明这次改了哪几处）');
  /* 一个字没变不是错：任务要的改动可能早就落在线上了（#2006 实证：上一轮已删图，任务没收口）。
     如实回 noop，由 runner 决定要不要再确认一次；硬判失败等于逼模型为了过校验去乱改。 */
  const noop = !errors.length && !changed.length;
  return { ok: errors.length === 0, errors, draft, changed, applied, noop };
}

/** 报错文本里的数字会随正文长短浮动（「正文 1398 词」对「1401 词」），比对时抹平。 */
function errorKey(e) {
  return String(e || '').replace(/\d+/g, '#');
}

/** 只留改稿新带进来的毛病：原稿校验本来就报的那些不算。 */
function newErrors(baseErrors, nextErrors) {
  const had = new Set((baseErrors || []).map(errorKey));
  return (nextErrors || []).filter((e) => !had.has(errorKey(e)));
}

/**
 * 站内链接补尾斜杠（#2003：模型两次都漏，job 整个失败；这是机器能确定的事，不该让模型重写）。
 * 只动 markdown 链接与 href 里的站内页面路径：无扩展名、无 query、无 fragment、不是 /assets/。
 * 图片引用不动。返回 { body, fixed:[路径] }。
 */
function fixTrailingSlashes(body) {
  const fixed = [];
  const needs = (p) => p.length > 1 && !/\/$/.test(p) && !/\.[a-z0-9]{2,5}$/i.test(p)
    && p.indexOf('?') === -1 && p.indexOf('#') === -1 && p.indexOf('/assets/') !== 0;
  let s = String(body || '').replace(/(!?)\]\((\/[^)\s]*)\)/g, (m, bang, p) => {
    if (bang || !needs(p)) return m;
    fixed.push(p);
    return '](' + p + '/)';
  });
  s = s.replace(/(href\s*=\s*)(["'])(\/[^"']*)\2/gi, (m, pre, q, p) => {
    if (!needs(p)) return m;
    fixed.push(p);
    return pre + q + p + '/' + q;
  });
  return { body: s, fixed };
}

/** 任务文本里逐字出现的现有文章 slug（长 slug 才算，短词会误中普通单词）。 */
function slugsMentioned(text, slugs) {
  const t = String(text || '');
  const out = [];
  for (const raw of slugs || []) {
    const s = String(raw || '');
    if (s.length < 12 || s.indexOf('-') === -1) continue;
    const re = new RegExp('(^|[^A-Za-z0-9_-])' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_-])');
    if (re.test(t) && out.indexOf(s) === -1) out.push(s);
  }
  return out;
}

module.exports = { applyEdits, newErrors, errorKey, fixTrailingSlashes, slugsMentioned, EDITABLE_FIELDS };
