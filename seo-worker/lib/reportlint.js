'use strict';
// 客户面报告的机器检查。零 LLM，纯字符串规则。
//
// 规则出处 specs/report/copy_rules.md 的 D 段部署前检查序列，
// 一条不减地搬进来，外加 A4 的 callout 行内 strong 地雷。
// 与 /data/aira/clients/report/scripts/report_lint.py 的分工：
// 那个脚本管 CSS 修复与人手交付前的复查，这里管发布前程序化拦截，
// 两边的正则口径保持一致，改一边要看另一边。
//
// 另外两个导出 numbersFromPack / checkNumbers 服务于叙事层的数字校验：
// 模型只准引用 pack 里出现过的数字，凡是文字里出现而 pack 里没有的，
// 视为编造，触发一次纠错回喂。

// ---------------------------------------------------------------------------
// 规则表
// ---------------------------------------------------------------------------

const RULES = [
  // A1 破折号。中文报告里一个都不许有，改用「至」或「·」。
  { rule: 'dash', re: /[–—]/g, desc: 'em dash 或 en dash' },
  // A2 前后带空格的连字符当分隔符。连接复合词的连字符（180-day）不受限。
  { rule: 'space_hyphen', re: /\S - \S/g, desc: '前后带空格的连字符作分隔' },
  // A3 工具名。统称 keyword research。
  { rule: 'tool_name', re: /\b(semrush|dataforseo|ahrefs|keyword ?planner)\b/gi, desc: '工具名' },
  // A8 排名变好只能写提升、前进。
  { rule: 'ranking_wording', re: /(收紧|收窄|压缩)/g, desc: '排名变好写成了收紧或收窄或压缩' },
  // A9 暴露 AI 工具的措辞。
  { rule: 'ai_phrase', re: /(AI\s*分析|AI\s*辅助|AI-generated|AI-assisted)/gi, desc: 'AI 工具措辞' },
  // A9 兜底：正文里的裸 AI 字样。只查叙事，不查成品 HTML：
  // GA4 的默认渠道分组里真有 AI Assistant 这个标签，它是正当的渠道名，
  // 拿它当违规拦下来会把整条发布线卡死（oakfurniture 的 AI 渠道模块同理）。
  { rule: 'ai_word', re: /\bAI\b/g, desc: 'AI 字样', scope: 'narrative' },
  // A12 内部黑话。
  {
    rule: 'internal_jargon',
    re: /(钱页|重爬|硬塞|裸名|口径|冷启动|蓄水|复盘|死件|僵尸标签|看窄了|SERP)/g,
    desc: '内部黑话',
  },
  // A13 A14 内部周编号与版本号痕迹。
  { rule: 'w_number', re: /(W\d{1,2}\b|v\d\s*修正版|#\d)/g, desc: 'W 编号或版本号痕迹' },
  // A16 emoji。
  {
    rule: 'emoji',
    re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu,
    desc: 'emoji',
  },
];

const SAMPLE_CHARS = 60;

// ---------------------------------------------------------------------------
// 文本提取
// ---------------------------------------------------------------------------

/**
 * 从 HTML 里取出正文文字。
 * script 与 style 整块丢掉，标签全部剥掉：不剥标签的话 #16a34a 这种色值
 * 会被 W 编号规则里的 #\d 命中，误报能把整条发布线卡死。
 */
function textOf(html) {
  return String(html == null ? '' : html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

function sampleAround(text, index, len) {
  const from = Math.max(0, index - Math.floor(SAMPLE_CHARS / 2));
  return text
    .slice(from, from + Math.max(SAMPLE_CHARS, len + 10))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 跑一遍规则表。text 应当已经是剥好标签的正文。
 * opts.scope 为 'html' 时跳过只查叙事的规则（见 ai_word 的注释）。
 * 每条规则最多留三个样本，够定位就行，日志里不刷屏。
 */
function lintText(text, opts) {
  const scope = (opts && opts.scope) || 'narrative';
  const s = String(text == null ? '' : text);
  const hits = [];
  for (const r of RULES) {
    if (r.scope && r.scope !== scope) continue;
    const re = new RegExp(r.re.source, r.re.flags);
    let m;
    let n = 0;
    while ((m = re.exec(s)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      n += 1;
      if (n <= 3) hits.push({ rule: r.rule, desc: r.desc, sample: sampleAround(s, m.index, m[0].length) });
      if (n >= 3) break;
    }
  }
  return { ok: hits.length === 0, hits };
}

/**
 * A4 的 callout 地雷：一个 .callout 里，第一个 <strong> 是标题，
 * 允许存在；除它之外再出现 <strong> 就会被 CSS 撑成块，
 * 行内强调一律用 <b style="color:#16a34a">。
 */
function lintCallouts(html) {
  const s = String(html == null ? '' : html);
  const hits = [];
  const open = /<div class="callout[^"]*"[^>]*>/gi;
  let m;
  while ((m = open.exec(s)) !== null) {
    // 从开标签往后截一段找它的内容。callout 内部按模板只有 strong 与 p，
    // 不会嵌套 div，所以取到下一个 </div> 为止就是完整内容。
    const from = m.index + m[0].length;
    const close = s.indexOf('</div>', from);
    const body = close === -1 ? s.slice(from) : s.slice(from, close);
    const strongs = body.match(/<strong\b/gi) || [];
    if (strongs.length > 1) {
      hits.push({
        rule: 'callout_inline_strong',
        desc: 'callout 内除标题外还有 <strong>，行内强调要用 <b style="color:#16a34a">',
        sample: textOf(body).replace(/\s+/g, ' ').trim().slice(0, SAMPLE_CHARS),
      });
    }
    // A6：callout 里不许放多条目列表。
    if (/<(ul|ol|li)\b/i.test(body)) {
      hits.push({
        rule: 'callout_list',
        desc: 'callout 内出现列表，多条目要用独立的 .analysis 组件',
        sample: textOf(body).replace(/\s+/g, ' ').trim().slice(0, SAMPLE_CHARS),
      });
    }
  }
  return hits;
}

/**
 * A7：封面数字块的琥珀色只能用 class="v amb"，用 "v warn" 会撞上提示框
 * 的 .warn 背景与边框，数字凭空多个米色框。
 */
function lintClassCollision(html) {
  const s = String(html == null ? '' : html);
  const hits = [];
  const re = /class="[^"]*\bv warn\b[^"]*"/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    hits.push({ rule: 'v_warn_class', desc: '数字块用了 v warn，应改 v amb', sample: m[0].slice(0, SAMPLE_CHARS) });
    break;
  }
  return hits;
}

/**
 * 报告 HTML 的完整检查。返回 { ok, hits: [{ rule, sample }] }。
 * exit 0 等价于 ok === true，这是 scp 之前的最后一道闸。
 */
function lintReport(html) {
  const text = textOf(html);
  const base = lintText(text, { scope: 'html' });
  const hits = base.hits.concat(lintCallouts(html), lintClassCollision(html));
  return { ok: hits.length === 0, hits };
}

// ---------------------------------------------------------------------------
// 数字校验
// ---------------------------------------------------------------------------

function withThousands(intStr) {
  return String(intStr).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** 一个数值能被接受的全部书写形式。 */
function numberForms(n) {
  const out = [];
  const v = Number(n);
  if (!Number.isFinite(v)) return out;
  const push = (s) => {
    if (s !== undefined && s !== null && String(s) !== '') out.push(String(s));
  };
  for (const x of [v, Math.abs(v)]) {
    const intPart = Math.trunc(x);
    push(String(x));
    push(String(intPart));
    push(withThousands(String(Math.abs(intPart))));
    push(x.toFixed(1));
    push(x.toFixed(2));
    push(Math.round(x));
    // 比例值（0 到 1 之间的小数）在正文里会以百分数出现。
    if (Math.abs(x) <= 1) {
      const pct = x * 100;
      push(pct.toFixed(0) + '%');
      push(pct.toFixed(1) + '%');
      push(pct.toFixed(2) + '%');
      push(pct.toFixed(0));
      push(pct.toFixed(1));
      push(pct.toFixed(2));
    }
    // 已经是百分数的（环比 12.5 这种）也允许直接带百分号写。
    push(x.toFixed(0) + '%');
    push(x.toFixed(1) + '%');
    push(x.toFixed(2) + '%');
  }
  return out;
}

/**
 * pack 里出现过的全部数字的可接受书写形式。
 * 除了数值字段，字符串里内嵌的数字（周期标签里的 2026、8、22）也收进来，
 * 否则模型照抄一句「截至 22 日」就会被判成编造。
 */
function numbersFromPack(pack) {
  const set = new Set();
  const seenObjects = new Set();
  const walk = (node) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'number') {
      for (const f of numberForms(node)) set.add(f);
      return;
    }
    if (typeof node === 'string') {
      const re = /\d[\d,]*(?:\.\d+)?/g;
      let m;
      while ((m = re.exec(node)) !== null) {
        const raw = m[0];
        set.add(raw);
        set.add(raw.replace(/,/g, ''));
        const num = Number(raw.replace(/,/g, ''));
        if (Number.isFinite(num)) for (const f of numberForms(num)) set.add(f);
      }
      return;
    }
    if (typeof node !== 'object') return;
    if (seenObjects.has(node)) return;
    seenObjects.add(node);
    if (Array.isArray(node)) {
      for (const v of node) walk(v);
      return;
    }
    for (const k of Object.keys(node)) walk(node[k]);
  };
  walk(pack);
  return set;
}

/**
 * 正文里的数字是否都能在 allowed 里找到。
 * 只查「长度 >= 2 或带小数点或带百分号」的数字串，单个数字（三条建议、
 * 两个页面）不管，那是叙述量词不是指标。
 * 返回 { ok, bad: [{ token, sample }] }。
 */
function checkNumbers(text, allowed) {
  const s = String(text == null ? '' : text);
  const bad = [];
  const seen = new Set();
  const re = /\d[\d,]*(?:\.\d+)?%?/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const tok = m[0];
    const digits = tok.replace(/[^\d]/g, '');
    const interesting = digits.length >= 2 || tok.indexOf('.') !== -1 || tok.indexOf('%') !== -1;
    if (!interesting) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    const plain = tok.replace(/,/g, '');
    if (allowed.has(tok) || allowed.has(plain)) continue;
    bad.push({ token: tok, sample: sampleAround(s, m.index, tok.length) });
  }
  return { ok: bad.length === 0, bad };
}

/** 把 hits 与 bad 拼成一句能直接塞进纠错 prompt 的问题清单。 */
function problemList(hits, bad) {
  const lines = [];
  for (const h of hits || []) {
    lines.push('禁用写法「' + h.desc + '」命中，例如：' + h.sample);
  }
  for (const b of bad || []) {
    lines.push('数字 ' + b.token + ' 不在给定数据里，例如：' + b.sample);
  }
  return lines;
}

module.exports = {
  RULES,
  textOf,
  lintText,
  lintReport,
  lintCallouts,
  lintClassCollision,
  numbersFromPack,
  numberForms,
  checkNumbers,
  problemList,
};
