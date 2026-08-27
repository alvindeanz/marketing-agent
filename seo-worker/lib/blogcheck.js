'use strict';
// Mechanical checks on a blog draft, run before anything reaches the platform.
//
// The point is to catch the failures a model reliably makes and a reviewer
// reliably misses: a skeleton labelled but not executed, an internal link to a
// page that does not exist, a word count under the SOP floor, a missing FAQ
// schema block. Everything here is decidable from the text alone. Judgement
// calls (is this actually good writing) stay with the human reviewer.
//
// Rules transcribed from specs/sops/seo-blog-sop.md sections 〇.二, 〇.四 and 一.

const REQUIRED_FIELDS = [
  'title',
  'slug',
  'category',
  'keyword',
  'excerpt',
  'meta_description',
  'body_markdown',
  'social_message',
];

// 一、写作硬规则: at least 1500 words, ceiling 3000. Redline 4 fails under 1200,
// so the floor here is the stricter of the two on purpose.
const WORD_MIN = 1500;
const WORD_MAX = 3000;

const SOCIAL_MIN = 80;
const SOCIAL_MAX = 150;
const PREVIEW_TOKEN = '{PREVIEW_URL}';

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;
const DASH_RE = /[—–]/;

function stripNoise(body) {
  return String(body || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
}

/** Latin word tokens plus CJK characters, so the count works for both languages. */
function countWords(body) {
  const text = stripNoise(body)
    .replace(/<[^>]+>/g, ' ')
    .replace(/[|>#*_`~]/g, ' ');
  const latin = text.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) || [];
  const cjk = text.match(/[一-鿿]/g) || [];
  return latin.length + cjk.length;
}

/** Count blocks of consecutive lines matching a predicate, not individual lines. */
function countBlocks(lines, test) {
  let n = 0;
  let inBlock = false;
  for (const line of lines) {
    if (test(line)) {
      if (!inBlock) n += 1;
      inBlock = true;
    } else if (line.trim() !== '') {
      inBlock = false;
    }
  }
  return n;
}

const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const UL_RE = /^\s*[-*+]\s+\S/;
const OL_RE = /^\s*\d+[.)]\s+\S/;
const BQ_RE = /^\s*>\s?/;

/** Structural counts the skeleton rules are written against. */
function structure(body) {
  const clean = stripNoise(body);
  const lines = clean.split('\n');
  const h2 = [];
  for (const line of lines) {
    const m = line.match(/^\s*##\s+(.+?)\s*$/);
    if (m) h2.push(m[1].trim());
  }
  // 表格两种口径都数：markdown 管道表的分隔行，加 raw HTML 的 <table>。
  // WebForger 的博客渲染器不认管道表（只认 CommonMark，见记忆 feedback_webforger_no_gfm_tables），
  // SOP 让模型写 HTML 表格；校验若只数管道表，Cost Breakdown 骨架在 WebForger 上永远过不了
  // （2026-08-27 Louvresky #89 两次生成都因此打回）。
  const pipeTables = lines.filter((l) => TABLE_SEP_RE.test(l)).length;
  const htmlTables = (clean.match(/<table\b/gi) || []).length;
  const tables = pipeTables + htmlTables;
  const olItems = lines.filter((l) => OL_RE.test(l)).length;
  return {
    tables,
    pipeTables,
    htmlTables,
    uls: countBlocks(lines, (l) => UL_RE.test(l)),
    ols: countBlocks(lines, (l) => OL_RE.test(l)),
    olItems,
    blockquotes: countBlocks(lines, (l) => BQ_RE.test(l)),
    h2,
    h2Count: h2.length,
    images: (clean.match(/!\[[^\]]*\]\([^)]+\)/g) || []).length + (clean.match(/<img\s/gi) || []).length,
    words: countWords(body),
  };
}

/** Every site relative link in the body, markdown and raw html. */
function internalLinks(body) {
  const clean = stripNoise(body);
  const out = [];
  const md = clean.match(/\]\((\/[^)\s]*)\)/g) || [];
  for (const hit of md) out.push(hit.slice(2, -1));
  const html = clean.match(/href\s*=\s*["'](\/[^"']*)["']/gi) || [];
  for (const hit of html) {
    const m = hit.match(/["'](\/[^"']*)["']/);
    if (m) out.push(m[1]);
  }
  return out.map((p) => p.split('#')[0].split('?')[0]).filter(Boolean);
}

function normPath(p) {
  let s = String(p || '').trim();
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/+$/, '');
  return s === '' ? '/' : s.toLowerCase();
}

/** First N words of the body, used for the Story Lead narrative rule. */
function leadText(body, words) {
  const text = stripNoise(body)
    .replace(/^\s*#{1,6}\s+.*$/gm, ' ')
    .replace(/<[^>]+>/g, ' ')
    .trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  return tokens.slice(0, words).join(' ');
}

/**
 * Skeleton execution rules, section 〇.二.
 * Returns a list of error strings, empty when the body honours the skeleton.
 */
function checkSkeleton(skeletonLabel, body, st) {
  const errors = [];
  const lines = stripNoise(body).split('\n');
  switch (skeletonLabel) {
    case 'Cost Breakdown': {
      if (st.tables < 2) errors.push('骨架 Cost Breakdown 要求至少 2 个表格，实际 ' + st.tables + ' 个');
      if (st.uls > 3) errors.push('骨架 Cost Breakdown 要求 UL 列表不超过 3 个，实际 ' + st.uls + ' 个');
      const lead = leadText(body, 100);
      if (!/[$￥€£]|\d/.test(lead) && st.h2Count) {
        errors.push('骨架 Cost Breakdown 要求开头 100 字内出现价格或数字，实际没有');
      }
      break;
    }
    case 'Checklist': {
      if (st.tables > 0) errors.push('骨架 Checklist 禁止表格，实际有 ' + st.tables + ' 个');
      const numberedH2 = st.h2.filter((h) => /^(step\s*\d|第?\s*\d+[.、)]|\d+[.)])/i.test(h)).length;
      const steps = Math.max(numberedH2, st.olItems);
      if (steps < 5) errors.push('骨架 Checklist 要求至少 5 个编号步骤，实际识别到 ' + steps + ' 个');
      break;
    }
    case 'Comparison': {
      const hasVsH2 = st.h2.some((h) => /\bvs\b|versus|对比|pros|cons|option\s/i.test(h));
      const hasProsCons = /\bpros\b[\s\S]{0,400}\bcons\b/i.test(stripNoise(body));
      if (!hasVsH2 && !hasProsCons && st.tables < 1) {
        errors.push('骨架 Comparison 要求至少一个正反对比结构：对比型 H2、pros/cons 段落或对比表，三者都没有');
      }
      if (!st.h2.some((h) => /\bvs\b|versus|对比|option|which|哪种|选哪/i.test(h))) {
        errors.push('骨架 Comparison 要求 H2 标题体现对比，实际没有一个 H2 带对比措辞');
      }
      break;
    }
    case 'Story Lead': {
      if (st.tables > 0) errors.push('骨架 Story Lead 禁止表格，实际有 ' + st.tables + ' 个');
      if (st.uls > 2) errors.push('骨架 Story Lead 要求全篇 UL 不超过 2 个，实际 ' + st.uls + ' 个');
      if (st.blockquotes < 1) errors.push('骨架 Story Lead 要求至少 1 个 blockquote，实际没有');
      const lead = leadText(body, 300);
      if (/[$￥€£]\s?\d|\d+\s?%/.test(lead)) {
        errors.push('骨架 Story Lead 要求前 300 字是纯叙事，不许出现价格或百分比数字，实际出现了');
      }
      const leadLines = lines.slice(0, 40);
      if (leadLines.some((l) => UL_RE.test(l) || OL_RE.test(l))) {
        errors.push('骨架 Story Lead 要求前 300 字是纯叙事，不许出现列表，实际开头就有列表');
      }
      break;
    }
    case 'Q&A 驱动': {
      const notQuestion = st.h2.filter((h) => !/[?？]\s*$/.test(h));
      if (notQuestion.length) {
        errors.push('骨架 Q&A 要求所有 H2 都是问句，以下不是：' + notQuestion.slice(0, 5).join(' / '));
      }
      const banned = st.h2.filter((h) => /^(overview|summary|introduction|conclusion)\b/i.test(h));
      if (banned.length) errors.push('骨架 Q&A 禁止 Overview / Summary 类 H2，实际有：' + banned.join(' / '));
      break;
    }
    default:
      errors.push('未知骨架标签 ' + skeletonLabel + '，无法校验骨架执行');
  }
  return errors;
}

/* =========================================================
   Image briefs
   =========================================================

   The writing pass produces one hero brief plus three body briefs alongside the
   copy, and the image stage turns each of them into a real FLUX generation. A
   brief that binds to an H2 the body does not have, or that carries an abstract
   metaphor prompt, is a defect the writer can fix from the error text, so it is
   checked here and rides the normal one-shot repair loop instead of blowing up
   later in the image stage where a repair costs another whole article.
*/

const IMAGE_SLOTS = ['hero', 'body-1', 'body-2', 'body-3'];

// The tail every FLUX prompt has to carry. FLUX renders garbled pseudo text
// whenever a scene could plausibly contain a sign, and pseudo text is the single
// most common reason a generated image is unusable.
const NO_TEXT_TAIL = 'no text, no signage, no lettering';

// Stock photo metaphor vocabulary. SOP 二: prompts describe what is in frame,
// never what it stands for.
const ABSTRACT_RE = /\b(represent\w*|symboli[sz]\w*|conceptual\w*|metaphor\w*|abstract\w*|allegor\w*|signif\w*\s+of)\b/i;

const FLUX_PROMPT_MIN = 60;
const FLUX_PROMPT_MAX = 600;

/** Heading text reduced to something two spellings of the same H2 both hit. */
function normHeading(s) {
  return String(s || '')
    .replace(/^\s*#+\s*/, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,:;!?。，：；！？、]+$/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Mechanical check on draft.image_briefs.
 * st is the structure() of the body, so anchors are validated against the H2s
 * that actually exist in the copy the model just wrote.
 * Returns a list of error strings, empty when the briefs are usable.
 */
function checkImageBriefs(draft, st) {
  const errors = [];
  const briefs = draft && draft.image_briefs;
  if (!Array.isArray(briefs)) {
    errors.push('json 缺 image_briefs 数组，本轮必须随正文产出 4 份图片 brief');
    return errors;
  }
  if (briefs.length !== IMAGE_SLOTS.length) {
    errors.push('image_briefs 必须正好 ' + IMAGE_SLOTS.length + ' 条（hero 1 张加正文 3 张），实际 ' + briefs.length + ' 条');
  }
  const h2set = new Set((st.h2 || []).map(normHeading));
  const usedAnchors = new Set();
  const usedPrompts = new Set();
  const titleNorm = normHeading(draft && draft.title);

  for (let i = 0; i < briefs.length; i += 1) {
    const b = briefs[i] || {};
    const want = IMAGE_SLOTS[i] || '';
    const label = want || '第 ' + (i + 1) + ' 条';
    if (want && String(b.slot || '').trim() !== want) {
      errors.push('image_briefs 第 ' + (i + 1) + ' 条的 slot 应该是 "' + want + '"，实际 "' + String(b.slot || '') + '"');
    }
    if (!want) {
      errors.push('image_briefs 多出了第 ' + (i + 1) + ' 条，只允许 ' + IMAGE_SLOTS.join('、'));
      continue;
    }

    const anchor = String(b.anchor || '').trim();
    const anchorNorm = normHeading(anchor);
    if (!anchor) {
      errors.push(label + ' 缺 anchor');
    } else if (want === 'hero') {
      if (anchorNorm !== titleNorm) {
        errors.push('hero 的 anchor 必须原样是本篇 title，实际是 "' + anchor.slice(0, 80) + '"');
      }
    } else if (!h2set.has(anchorNorm)) {
      errors.push(
        label + ' 绑的 H2 "' + anchor.slice(0, 80) + '" 在正文里不存在，必须原样照抄正文里某个 H2 的文字'
      );
    } else if (usedAnchors.has(anchorNorm)) {
      errors.push(label + ' 和前面的 brief 绑了同一个 H2 "' + anchor.slice(0, 80) + '"，三张正文图必须绑三个不同的 H2');
    }
    if (want !== 'hero' && anchorNorm) usedAnchors.add(anchorNorm);

    const scene = String(b.scene || '').trim();
    if (scene.length < 10) {
      errors.push(label + ' 的 scene 太短或缺失，要用一到两句中文写清画面里实际能看到什么');
    } else if (!/[一-鿿]/.test(scene)) {
      errors.push(label + ' 的 scene 必须写中文，它是给人复核用的内部产物');
    }

    const alt = String(b.alt || '').trim();
    if (alt.length < 10) errors.push(label + ' 的 alt 太短或缺失，alt 要描述图里实际画面并带上目标关键词的变体');
    if (EMOJI_RE.test(alt) || DASH_RE.test(alt)) errors.push(label + ' 的 alt 里有 emoji 或破折号');

    const prompt = String(b.flux_prompt || '').trim();
    if (prompt.length < FLUX_PROMPT_MIN || prompt.length > FLUX_PROMPT_MAX) {
      errors.push(
        label + ' 的 flux_prompt ' + prompt.length + ' 字符，应在 ' + FLUX_PROMPT_MIN + ' 到 ' + FLUX_PROMPT_MAX + ' 之间'
      );
    }
    if (prompt.toLowerCase().indexOf(NO_TEXT_TAIL) === -1) {
      errors.push(label + ' 的 flux_prompt 必须原样包含 "' + NO_TEXT_TAIL + '"');
    }
    if (ABSTRACT_RE.test(prompt)) {
      errors.push(label + ' 的 flux_prompt 出现了抽象隐喻措辞，必须整句改成具象实景描述');
    }
    if (/[一-鿿]/.test(prompt)) errors.push(label + ' 的 flux_prompt 必须是英文，它直接发给 FLUX');
    const key = prompt.toLowerCase().replace(/\s+/g, ' ');
    if (key && usedPrompts.has(key)) errors.push(label + ' 的 flux_prompt 和前面某一条完全相同，4 张图必须是不同画面');
    if (key) usedPrompts.add(key);
  }
  return errors;
}

/**
 * The full pre flight check.
 * draft: the model's json object.
 * ctx: { roll, allowedPaths:Set|Array, categories:[slug], lang, keepImages,
 *        expectImageBriefs }
 * Returns { ok, errors: [], structure }
 */
/**
 * deliverable_lint_rules.json 的三类规则套到草稿上。规则文件与 PJ 手工产线同一份，
 * 这里只读 banned_terms / absolute_claims / forbidden_openers 三键，别的键不认。
 */
function checkLintRules(d, rules) {
  const r = rules || {};
  const errors = [];
  const fields = ['title', 'excerpt', 'meta_description', 'body_markdown'];
  const banned = Object.assign({}, r.banned_terms || {}, r.banned_terms_page_copy_only || {});
  for (const term of Object.keys(banned)) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    for (const f of fields) {
      if (re.test(String(d[f] || ''))) {
        errors.push(f + ' 出现禁用词「' + term + '」：' + banned[term]);
        break;
      }
    }
  }
  for (const pat of r.absolute_claims || []) {
    let re;
    try { re = new RegExp(pat, 'i'); } catch (e) { continue; }
    for (const f of fields) {
      const m = String(d[f] || '').match(re);
      if (m) { errors.push(f + ' 出现绝对化表述「' + m[0] + '」，禁绝对化'); break; }
    }
  }
  for (const opener of r.forbidden_openers || []) {
    for (const f of ['excerpt', 'meta_description']) {
      if (String(d[f] || '').trim().toLowerCase().indexOf(String(opener).toLowerCase()) === 0) {
        errors.push(f + ' 以禁用开头「' + opener + '」起句');
      }
    }
  }
  return errors;
}

/** 读并合并 lint 规则：_default 加客户层（按客户目录名）。读不到回空对象，不炸。 */
function loadLintRules(file, clientSlug) {
  try {
    const all = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
    const base = all._default || {};
    const c = (clientSlug && all[clientSlug]) || {};
    return {
      banned_terms: Object.assign({}, base.banned_terms || {}, c.banned_terms || {}),
      banned_terms_page_copy_only: Object.assign({}, base.banned_terms_page_copy_only || {}, c.banned_terms_page_copy_only || {}),
      absolute_claims: [].concat(base.absolute_claims || [], c.absolute_claims || []),
      forbidden_openers: [].concat(base.forbidden_openers || [], c.forbidden_openers || []),
    };
  } catch (e) {
    return {};
  }
}

function checkDraft(draft, ctx) {
  const errors = [];
  const d = draft || {};
  for (const f of REQUIRED_FIELDS) {
    if (typeof d[f] !== 'string' || d[f].trim() === '') errors.push('json 缺字段或字段为空：' + f);
  }
  if (errors.length) return { ok: false, errors, structure: null };

  const body = d.body_markdown;
  const st = structure(body);
  const roll = ctx.roll;

  // Style Roll comment, redline 9, plus the label must match what we rolled.
  const styleroll = require('./styleroll');
  const parsed = styleroll.parseRollComment(body);
  if (!parsed.found) {
    errors.push('正文头部缺少 Style Roll 注释');
  } else if (roll && parsed.skeletonLabel !== roll.skeleton.label) {
    errors.push(
      'Style Roll 注释里的骨架是 ' + parsed.skeletonLabel + '，本次指定的是 ' + roll.skeleton.label + '，不许自己改'
    );
  }

  if (roll) {
    for (const e of checkSkeleton(roll.skeleton.label, body, st)) errors.push(e);
  }

  if (st.words < WORD_MIN) errors.push('正文 ' + st.words + ' 词，低于下限 ' + WORD_MIN + ' 词');
  if (st.words > WORD_MAX) errors.push('正文 ' + st.words + ' 词，超过上限 ' + WORD_MAX + ' 词');

  // Images: a revision must carry every existing image through untouched (the
  // image pass placed them, the model does not get to drop or invent any); a
  // fresh write carries none, images are a separate stage.
  const keep = Array.isArray(ctx.keepImages) ? ctx.keepImages : [];
  if (keep.length) {
    for (const img of keep) {
      if (body.indexOf(img) === -1) errors.push('原稿图片被改动或删除，必须原样保留：' + img.slice(0, 80));
    }
    if (st.images !== keep.length) {
      errors.push('图片数量应为 ' + keep.length + ' 张（与原稿一致），实际 ' + st.images + ' 张');
    }
  } else if (st.images > 0) {
    errors.push('本轮不许插图，正文里出现了 ' + st.images + ' 张图片');
  }

  // The image briefs travel with a fresh write only. A revision reuses whatever
  // the image stage already placed, so asking for briefs there would be asking
  // the model to redo images it was just told not to touch.
  if (ctx.expectImageBriefs) {
    for (const e of checkImageBriefs(d, st)) errors.push(e);
  }

  // Redline 3: internal links exist, and every one of them must be real.
  const links = internalLinks(body);
  if (!links.length) errors.push('正文没有任何内链，SOP 红线第 3 条');
  if (links.length > 3) errors.push('内链 ' + links.length + ' 条，SOP 要求最多 2 主加 1 次');
  const allowed = new Set((Array.isArray(ctx.allowedPaths) ? ctx.allowedPaths : Array.from(ctx.allowedPaths || [])).map(normPath));
  const bad = links.filter((p) => !allowed.has(normPath(p)));
  if (bad.length) {
    errors.push('内链指向站上不存在的路径：' + Array.from(new Set(bad)).slice(0, 5).join('、'));
  }

  // Redline 6: FAQPage JSON-LD in the body.
  if (!/application\/ld\+json/i.test(body) || !/FAQPage/i.test(body)) {
    errors.push('正文末尾缺少 FAQPage 的 JSON-LD schema，SOP 红线第 6 条');
  }

  // Redline 8: the title has to carry the target keyword.
  const kw = String(d.keyword || '').toLowerCase().trim();
  const titleLc = String(d.title || '').toLowerCase();
  if (kw) {
    const tokens = kw.split(/\s+/).filter((t) => t.length > 2);
    const hit = tokens.length ? tokens.filter((t) => titleLc.indexOf(t) !== -1).length / tokens.length : 0;
    if (titleLc.indexOf(kw) === -1 && hit < 0.6) errors.push('标题不含目标关键词 "' + d.keyword + '"');
  }

  // No emoji, no em dash or en dash, anywhere a human will read it.
  for (const f of ['title', 'excerpt', 'meta_description', 'body_markdown', 'social_message']) {
    if (EMOJI_RE.test(d[f])) errors.push(f + ' 里出现了 emoji');
    if (DASH_RE.test(d[f])) errors.push(f + ' 里出现了破折号，用逗号句号或分号替代');
  }

  // 交付 lint 规则（与 PJ 手工产线共用同一份 scripts/deliverable_lint_rules.json）：
  // 禁用词、绝对化表述、meta / excerpt 的禁用开头。ctx.lintRules 是合并好的 _default 加客户层。
  for (const e of checkLintRules(d, ctx.lintRules)) errors.push(e);

  // Category has to be one that already exists.
  const cats = (ctx.categories || []).map((c) => String(c).toLowerCase());
  if (cats.length && cats.indexOf(String(d.category).toLowerCase()) === -1) {
    errors.push('分类 "' + d.category + '" 不在站点现有分类里：' + cats.join('、'));
  }

  // Slug shape. Default language slugs are ASCII only per the platform doc.
  if (!ctx.lang && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(String(d.slug))) {
    errors.push('slug "' + d.slug + '" 不符合默认语言的 ASCII 小写连字符格式');
  }

  const meta = String(d.meta_description).trim();
  if (meta.length < 50 || meta.length > 165) {
    errors.push('meta_description ' + meta.length + ' 字符，应在 50 到 165 之间');
  }

  // The social message is what a human forwards to the client, so its shape is
  // part of the deliverable, not decoration.
  const social = String(d.social_message).trim();
  if (social.indexOf(PREVIEW_TOKEN) === -1) {
    errors.push('social_message 里必须保留 ' + PREVIEW_TOKEN + ' 占位符，由 runner 替换成真实预览链接');
  }
  const socialLen = social.replace(PREVIEW_TOKEN, '').replace(/\s+/g, '').length;
  if (socialLen < SOCIAL_MIN || socialLen > SOCIAL_MAX) {
    errors.push('social_message 去掉占位符和空白后 ' + socialLen + ' 字，应在 ' + SOCIAL_MIN + ' 到 ' + SOCIAL_MAX + ' 字之间');
  }
  if (!/[一-鿿]/.test(social)) errors.push('social_message 必须是中文');

  return { ok: errors.length === 0, errors, structure: st };
}

module.exports = {
  checkDraft,
  checkLintRules,
  loadLintRules,
  checkSkeleton,
  checkImageBriefs,
  structure,
  countWords,
  internalLinks,
  normPath,
  normHeading,
  leadText,
  stripNoise,
  REQUIRED_FIELDS,
  WORD_MIN,
  WORD_MAX,
  SOCIAL_MIN,
  SOCIAL_MAX,
  PREVIEW_TOKEN,
  IMAGE_SLOTS,
  NO_TEXT_TAIL,
  ABSTRACT_RE,
  FLUX_PROMPT_MIN,
  FLUX_PROMPT_MAX,
};
