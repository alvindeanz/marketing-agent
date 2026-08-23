'use strict';
// Style Roll engine for the blog SOP.
//
// The dice are rolled here, in code, never by the model. Two reasons: a model
// asked to "pick randomly" collapses onto the same two or three combinations
// forever, and the SOP's rule that no two consecutive posts share a skeleton
// can only be enforced by something that remembers the last post.
//
// The weights and the conflict table are a transcription of specs/sops/
// seo-blog-sop.md section 〇.一. If that file changes, change this with it.

const { randomInt } = require('node:crypto');

// Skeleton 1 to 5, rotated by post number, not weighted.
const SKELETONS = [
  { n: 1, label: 'Cost Breakdown' },
  { n: 2, label: 'Checklist' },
  { n: 3, label: 'Comparison' },
  { n: 4, label: 'Story Lead' },
  { n: 5, label: 'Q&A 驱动' },
];

const DIMENSIONS = {
  tone: [
    { label: 'Friendly', weight: 50 },
    { label: 'Expert', weight: 30 },
    { label: 'Direct', weight: 20 },
  ],
  opening: [
    { label: '数据炸弹', weight: 30 },
    { label: '痛点场景', weight: 30 },
    { label: '反常识', weight: 20 },
    { label: '直接回答', weight: 20 },
  ],
  cta: [
    { label: '紧迫型', weight: 30 },
    { label: '价值型', weight: 40 },
    { label: '软着陆', weight: 30 },
  ],
  title: [
    { label: '利益导向', weight: 40 },
    { label: '问题导向', weight: 30 },
    { label: '结果导向', weight: 30 },
  ],
  density: [
    { label: '轻快', weight: 50 },
    { label: '中等', weight: 50 },
  ],
};

// 冲突排除表. Each entry is a combination that must never ship.
const CONFLICTS = [
  { skeleton: 'Q&A 驱动', tone: 'Direct', why: 'Q&A 加 Direct 会变成客服单句问答，太干' },
  { skeleton: 'Story Lead', tone: 'Direct', why: '故事需要语气，Direct 会割裂叙事' },
];

function pickWeighted(options) {
  const total = options.reduce((sum, o) => sum + o.weight, 0);
  let roll = randomInt(0, total);
  for (const o of options) {
    roll -= o.weight;
    if (roll < 0) return o.label;
  }
  return options[options.length - 1].label;
}

function conflictOf(skeletonLabel, tone) {
  return CONFLICTS.find((c) => c.skeleton === skeletonLabel && c.tone === tone) || null;
}

/** Skeleton number from the post count, 1 based, wrapping every 5. */
function skeletonForIndex(postCount) {
  return ((Number(postCount) || 0) % 5) + 1;
}

function skeletonByNumber(n) {
  return SKELETONS.find((s) => s.n === n) || SKELETONS[0];
}

function skeletonByLabel(label) {
  const want = String(label || '').trim();
  return SKELETONS.find((s) => s.label === want) || null;
}

/** Next skeleton in the rotation, used when the previous post already used this one. */
function nextSkeleton(n) {
  return (Number(n) % 5) + 1;
}

/**
 * Roll one combination.
 * opts: { postCount, previousSkeletonLabel }
 * Returns { skeleton: {n,label}, tone, opening, cta, title, density, notes: [] }
 */
function roll(opts = {}) {
  const notes = [];
  let n = skeletonForIndex(opts.postCount);
  const prev = skeletonByLabel(opts.previousSkeletonLabel);
  if (prev && prev.n === n) {
    const bumped = nextSkeleton(n);
    notes.push(
      '轮换落到骨架 ' + n + '（' + skeletonByNumber(n).label + '），与上一篇相同，' +
        '按 SOP 禁止连续两篇同骨架，顺延到 ' + bumped + '（' + skeletonByNumber(bumped).label + '）'
    );
    n = bumped;
  }
  const skeleton = skeletonByNumber(n);

  let tone = pickWeighted(DIMENSIONS.tone);
  let guard = 0;
  while (conflictOf(skeleton.label, tone) && guard < 50) {
    const hit = conflictOf(skeleton.label, tone);
    notes.push('语气 ' + tone + ' 与骨架 ' + skeleton.label + ' 冲突（' + hit.why + '），重抽语气');
    tone = pickWeighted(DIMENSIONS.tone);
    guard += 1;
  }
  if (conflictOf(skeleton.label, tone)) {
    // Deterministic escape hatch. Never ship a conflicting combination just
    // because the random walk was unlucky.
    const legal = DIMENSIONS.tone.filter((o) => !conflictOf(skeleton.label, o.label));
    tone = legal.length ? legal[0].label : 'Friendly';
    notes.push('重抽 50 次仍冲突，退回权重最高的合法语气 ' + tone);
  }

  return {
    skeleton,
    tone,
    opening: pickWeighted(DIMENSIONS.opening),
    cta: pickWeighted(DIMENSIONS.cta),
    title: pickWeighted(DIMENSIONS.title),
    density: pickWeighted(DIMENSIONS.density),
    notes,
  };
}

/** The comment the SOP requires at the top of the body, exact format. */
function rollComment(r) {
  return (
    '<!-- Style Roll: 骨架=' + r.skeleton.label +
    ' | 语气=' + r.tone +
    ' | 开头=' + r.opening +
    ' | CTA=' + r.cta +
    ' | 标题=' + r.title +
    ' | 密度=' + r.density +
    ' -->'
  );
}

/** Human readable version for prompts and job logs. */
function rollSummary(r) {
  return (
    '骨架 ' + r.skeleton.n + ' ' + r.skeleton.label +
    '，语气 ' + r.tone +
    '，开头 ' + r.opening +
    '，CTA ' + r.cta +
    '，标题 ' + r.title +
    '，密度 ' + r.density
  );
}

/**
 * Read a Style Roll comment back out of a body.
 * Returns { found, fields: {骨架, 语气, ...}, skeletonLabel } and tolerates the
 * 轻快型 / 轻快 spelling drift between the SOP's table and its own example.
 */
function parseRollComment(body) {
  const m = String(body || '').match(/<!--\s*Style Roll:\s*([^>]*?)-->/);
  if (!m) return { found: false, fields: {}, skeletonLabel: null };
  const fields = {};
  for (const part of m[1].split('|')) {
    const kv = part.split('=');
    if (kv.length < 2) continue;
    fields[kv[0].trim()] = kv.slice(1).join('=').trim();
  }
  return { found: true, fields, skeletonLabel: fields['骨架'] || null };
}

module.exports = {
  SKELETONS,
  DIMENSIONS,
  CONFLICTS,
  roll,
  rollComment,
  rollSummary,
  parseRollComment,
  skeletonForIndex,
  skeletonByNumber,
  skeletonByLabel,
  nextSkeleton,
  conflictOf,
  pickWeighted,
};
