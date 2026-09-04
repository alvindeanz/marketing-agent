'use strict';
// 报告渲染层：零 LLM。facts pack 加叙事 JSON 进，自包含 HTML 出。
//
// 这一层的职责边界很硬：
//   数字全部来自 pack，模型一个数都碰不到；
//   叙事只填 sdesc、callout 正文、work_items 与 next_items 四类字段；
//   叙事为 null 时走固定句降级，报告照样出得来，只是没有解读。
//
// 模板在 specs/report/template_leadgen.html，占位符语法是 mustache 的一个
// 小子集：{{x}} 转义、{{{x}}} 原样、{{#x}}...{{/x}} 循环或条件、
// {{^x}}...{{/x}} 反向条件。渲染完断言不留 {{ 残留。

const fs = require('node:fs');
const path = require('node:path');

const { rankBand } = require('./factspack');

const TEMPLATE_DIR = path.join(__dirname, '..', 'specs', 'report');

// 漏斗三步的配色，与模板里 nth-child 的顶边颜色一致。
const FUNNEL_COLORS = ['#8b5cf6', '#06b6d4', '#10b981'];
const GREEN = '#16a34a';
const RED = '#dc2626';
const MUTED = 'var(--muted)';
const BLUE = '#2563eb';

// hero KPI 允许的键，叙事层只能从这里挑四个。
// dir 说明哪个方向算好：up 是越大越好，down 是越小越好（位次类）。
const KPI_DEFS = {
  gsc_clicks: { label: '自然搜索点击', dir: 'up', kind: 'int' },
  gsc_impressions: { label: '自然搜索曝光', dir: 'up', kind: 'int' },
  gsc_ctr: { label: '搜索点击率', dir: 'up', kind: 'pct' },
  gsc_position: { label: '搜索平均位次', dir: 'down', kind: 'pos' },
  ga4_sessions_organic: { label: '自然搜索访问', dir: 'up', kind: 'int' },
  ga4_new_users: { label: '自然搜索新访客', dir: 'up', kind: 'int' },
  leads: { label: '自然搜索询盘', dir: 'up', kind: 'int' },
  lead_rate: { label: '访问到询盘转化率', dir: 'up', kind: 'pct' },
  channels_sessions: { label: '全渠道访问', dir: 'up', kind: 'int' },
};
const DEFAULT_KPI_KEYS = ['gsc_clicks', 'ga4_sessions_organic', 'leads', 'gsc_position'];

// ---------------------------------------------------------------------------
// 迷你模板引擎
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 把模板切成节点树。未闭合或错配的块直接抛错，模板坏了要当场知道。 */
function parseTemplate(tpl) {
  const re = /\{\{([{#^/]?)\s*([\w.]+)\s*\}?\}\}/g;
  const root = { type: 'root', children: [] };
  const stack = [root];
  let last = 0;
  let m;
  while ((m = re.exec(tpl)) !== null) {
    const top = stack[stack.length - 1];
    if (m.index > last) top.children.push({ type: 'text', value: tpl.slice(last, m.index) });
    last = m.index + m[0].length;
    const sigil = m[1];
    const name = m[2];
    if (sigil === '#' || sigil === '^') {
      const node = { type: sigil === '#' ? 'section' : 'inverted', name, children: [] };
      top.children.push(node);
      stack.push(node);
    } else if (sigil === '/') {
      const node = stack.pop();
      if (!node || node.type === 'root' || node.name !== name) {
        throw new Error('模板块不配对：{{/' + name + '}}');
      }
    } else if (sigil === '{') {
      top.children.push({ type: 'raw', name });
    } else {
      top.children.push({ type: 'var', name });
    }
  }
  if (last < tpl.length) stack[stack.length - 1].children.push({ type: 'text', value: tpl.slice(last) });
  if (stack.length !== 1) throw new Error('模板有未闭合的块：' + stack[stack.length - 1].name);
  return root;
}

function lookup(stack, name) {
  for (let i = stack.length - 1; i >= 0; i--) {
    const scope = stack[i];
    if (scope && typeof scope === 'object' && Object.prototype.hasOwnProperty.call(scope, name)) {
      return scope[name];
    }
  }
  return undefined;
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return !(v === undefined || v === null || v === false || v === '' || v === 0);
}

function renderNodes(nodes, stack) {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') {
      out += n.value;
    } else if (n.type === 'var') {
      const v = lookup(stack, n.name);
      out += v === undefined || v === null ? '' : escapeHtml(v);
    } else if (n.type === 'raw') {
      const v = lookup(stack, n.name);
      out += v === undefined || v === null ? '' : String(v);
    } else if (n.type === 'section') {
      const v = lookup(stack, n.name);
      if (Array.isArray(v)) {
        for (const item of v) {
          out += renderNodes(n.children, stack.concat([item && typeof item === 'object' ? item : { '.': item }]));
        }
      } else if (truthy(v)) {
        out += renderNodes(n.children, stack.concat([v && typeof v === 'object' ? v : {}]));
      }
    } else if (n.type === 'inverted') {
      const v = lookup(stack, n.name);
      if (!truthy(v)) out += renderNodes(n.children, stack);
    }
  }
  return out;
}

function renderTemplate(tpl, data) {
  return renderNodes(parseTemplate(tpl).children, [data]);
}

// ---------------------------------------------------------------------------
// 格式化
// ---------------------------------------------------------------------------

function fmtInt(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '待更新';
  return Math.round(v)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtPct(ratio, digits) {
  const v = Number(ratio);
  if (!Number.isFinite(v)) return '待更新';
  return (v * 100).toFixed(digits === undefined ? 1 : digits) + '%';
}

function fmtPos(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '本月无曝光';
  return v.toFixed(1);
}

function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '待更新';
  const s = v.toFixed(2);
  const [i, d] = s.split('.');
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + d;
}

/** 数量类环比。prev 为 0 时不写百分比，写绝对量。 */
function deltaCount(cur, prev) {
  const c = Number(cur);
  const p = Number(prev);
  if (!Number.isFinite(c) || !Number.isFinite(p)) return { text: '本期无对比', color: MUTED };
  if (p === 0) {
    if (c === 0) return { text: '持平', color: MUTED };
    return { text: '新增 ' + fmtInt(c), color: GREEN };
  }
  const pct = (c - p) / p;
  if (c === p) return { text: '持平', color: MUTED };
  const sign = pct > 0 ? '+' : '';
  return { text: sign + (pct * 100).toFixed(1) + '%', color: pct > 0 ? GREEN : RED };
}

/** 位次环比。数值变小是提升，一律写「提升 N 位」，绝不写收紧。 */
function deltaPosition(cur, prev) {
  const c = Number(cur);
  const p = Number(prev);
  if (!Number.isFinite(c) || c <= 0 || !Number.isFinite(p) || p <= 0) {
    return { text: '本期无对比', color: MUTED };
  }
  const d = c - p;
  if (Math.abs(d) < 0.05) return { text: '基本持平', color: MUTED };
  if (d < 0) return { text: '提升 ' + Math.abs(d).toFixed(1) + ' 位', color: GREEN };
  return { text: '回落 ' + d.toFixed(1) + ' 位', color: RED };
}

/** 比例类环比，用百分点。 */
function deltaPp(cur, prev) {
  const c = Number(cur);
  const p = Number(prev);
  if (!Number.isFinite(c) || !Number.isFinite(p)) return { text: '本期无对比', color: MUTED };
  const d = (c - p) * 100;
  if (Math.abs(d) < 0.05) return { text: '基本持平', color: MUTED };
  const sign = d > 0 ? '+' : '';
  return { text: sign + d.toFixed(1) + ' 个百分点', color: d > 0 ? GREEN : RED };
}

/** 四至八字的短评，给漏斗对比表用，确定性生成，不经模型。 */
function shortNote(cur, prev, higherIsBetter) {
  const c = Number(cur);
  const p = Number(prev);
  if (!Number.isFinite(c) || !Number.isFinite(p)) return '本期无对比';
  if (p === 0 && c === 0) return '两期均为零';
  if (c === p) return '基本持平';
  const up = c > p;
  const good = higherIsBetter === false ? !up : up;
  if (good) return up ? '环比上行' : '环比走低';
  return up ? '环比走高' : '环比回落';
}

// ---------------------------------------------------------------------------
// KPI 取值
// ---------------------------------------------------------------------------

/** 从 pack 取一个 KPI 的本期与对比期原始值。取不到返回 null。 */
function kpiValues(pack, key) {
  const gsc = pack.gsc || {};
  const org = (pack.ga4 && pack.ga4.organic) || {};
  const tot = (pack.ga4 && pack.ga4.channels_total) || null;
  const leadsOverride = pack.meta && pack.meta.leads_override;
  const curLeads =
    leadsOverride === null || leadsOverride === undefined
      ? org.cur && org.cur.leads
      : Number(leadsOverride);
  switch (key) {
    case 'gsc_clicks':
      return gsc.cur ? { cur: gsc.cur.clicks, prev: gsc.prev.clicks } : null;
    case 'gsc_impressions':
      return gsc.cur ? { cur: gsc.cur.impressions, prev: gsc.prev.impressions } : null;
    case 'gsc_ctr':
      return gsc.cur ? { cur: gsc.cur.ctr, prev: gsc.prev.ctr } : null;
    case 'gsc_position':
      return gsc.cur ? { cur: gsc.cur.position, prev: gsc.prev.position } : null;
    case 'ga4_sessions_organic':
      return org.cur ? { cur: org.cur.sessions, prev: org.prev.sessions } : null;
    case 'ga4_new_users':
      return org.cur ? { cur: org.cur.new_users, prev: org.prev.new_users } : null;
    case 'leads':
      return org.cur ? { cur: curLeads, prev: org.prev.leads } : null;
    case 'lead_rate':
      if (!org.cur || !org.cur.sessions) return null;
      return {
        cur: org.cur.sessions > 0 ? curLeads / org.cur.sessions : null,
        prev: org.prev && org.prev.sessions > 0 ? org.prev.leads / org.prev.sessions : null,
      };
    case 'channels_sessions':
      return tot ? { cur: tot.sessions, prev: tot.prev_sessions } : null;
    default:
      return null;
  }
}

/**
 * 一个 KPI 的同比对照。pack.yoy 缺失、该指标去年没数、指标本身没有
 * 同比语义（占比与合计类）时返回 null，模板据此整行不出现。
 */
function kpiYoy(pack, key) {
  const yoy = pack && pack.yoy;
  if (!yoy || !yoy.period) return null;
  const def = KPI_DEFS[key];
  const vals = def ? kpiValues(pack, key) : null;
  if (!def || !vals) return null;
  const g = yoy.gsc || null;
  const o = yoy.ga4_organic || null;
  let prev;
  switch (key) {
    case 'gsc_clicks':
      prev = g && g.clicks;
      break;
    case 'gsc_impressions':
      prev = g && g.impressions;
      break;
    case 'gsc_ctr':
      prev = g && g.ctr;
      break;
    case 'gsc_position':
      prev = g && g.position;
      break;
    case 'ga4_sessions_organic':
      prev = o && o.sessions;
      break;
    case 'ga4_new_users':
      prev = o && o.new_users;
      break;
    case 'leads':
      prev = o && o.leads;
      break;
    default:
      return null;
  }
  if (prev === null || prev === undefined || prev === false) return null;
  let d;
  let prevValue;
  if (def.kind === 'pos') {
    d = deltaPosition(vals.cur, prev);
    prevValue = fmtPos(prev);
  } else if (def.kind === 'pct') {
    d = deltaPp(vals.cur, prev);
    prevValue = fmtPct(prev);
  } else {
    d = deltaCount(vals.cur, prev);
    prevValue = fmtInt(prev);
  }
  return { delta: d.text, delta_color: d.color, prev_value: prevValue, short: yoy.period.short };
}

/**
 * 对比期是不是残月。计数类指标的环比会被对比期天数直接扭曲，位次、点击率、
 * 转化率这类比值不会，所以只有计数类需要按天数归一。source 取 'gsc' 或 'ga4'。
 */
function shortPrevCoverage(pack, source) {
  const node = source === 'gsc' ? pack && pack.gsc : pack && pack.ga4;
  const prev = node && node.coverage && node.coverage.prev;
  if (!prev || !prev.short || !(prev.days > 0) || !(prev.span > 0)) return null;
  return prev;
}

/** 对比期残月时，把对比值折算成整周期应有的量。 */
function coveredBase(prev, shortPrev) {
  if (!shortPrev) return prev;
  return (Number(prev) * shortPrev.span) / shortPrev.days;
}

/** 计数类环比。对比期残月时先折算成整周期，文案标「日均」。 */
function deltaCountCovered(cur, prev, shortPrev) {
  const d = deltaCount(cur, coveredBase(prev, shortPrev));
  return shortPrev ? { text: d.text + '（日均）', color: d.color } : d;
}

/** 对比值后面补一句「仅 N 天」，免得读者以为那是整月数字。 */
function withDayNote(text, shortPrev) {
  return shortPrev ? text + '，仅 ' + shortPrev.days + ' 天' : text;
}

function kpiCoverage(pack, key) {
  return shortPrevCoverage(pack, key.indexOf('gsc_') === 0 ? 'gsc' : 'ga4');
}

function kpiCard(pack, key) {
  const def = KPI_DEFS[key];
  const vals = def ? kpiValues(pack, key) : null;
  if (!def || !vals) return null;
  let value;
  let d;
  // 对比期是残月时，计数类指标按天数折算成整周期再比，卡片上标「日均」。
  // 不折算就会出现正文写日均、头卡写总量的自相矛盾（kuddles 2026-08 v1 的原样）。
  const shortPrev = def.kind === 'pos' || def.kind === 'pct' ? null : kpiCoverage(pack, key);
  if (def.kind === 'pos') {
    value = fmtPos(vals.cur);
    d = deltaPosition(vals.cur, vals.prev);
  } else if (def.kind === 'pct') {
    value = fmtPct(vals.cur);
    d = deltaPp(vals.cur, vals.prev);
  } else {
    value = fmtInt(vals.cur);
    d = deltaCountCovered(vals.cur, vals.prev, shortPrev);
  }
  let prevValue = def.kind === 'pos' ? fmtPos(vals.prev) : def.kind === 'pct' ? fmtPct(vals.prev) : fmtInt(vals.prev);
  prevValue = withDayNote(prevValue, shortPrev);
  return { key, label: def.label, value, note: d.text, delta: d.text, delta_color: d.color, prev_value: prevValue };
}

// ---------------------------------------------------------------------------
// 叙事字段的取用与降级
// ---------------------------------------------------------------------------

function calloutList(list, tonesFallback) {
  const arr = Array.isArray(list) ? list : list ? [list] : [];
  return arr
    .filter((c) => c && (c.body || c.body_html))
    .map((c, i) => ({
      tone: String(c.tone || (tonesFallback && tonesFallback[i]) || 'blue'),
      title: String(c.title || ''),
      body_html: paragraphs(c.body || c.body_html),
      margin_top: i === 0 ? '24px' : '12px',
    }));
}

/** 叙事正文转段落。模型给的是纯文字，这里补 <p>，行内强调保持 <b>。 */
function paragraphs(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return '';
  return s
    .split(/\n{2,}|\n/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => '<p>' + p + '</p>')
    .join('');
}

function fallbackSdesc(pack) {
  return (
    '本报告数据来自 Google Analytics 4 与 Google Search Console，周期 ' +
    pack.meta.period.label +
    '，对比 ' +
    pack.meta.compare.label +
    '。'
  );
}

// ---------------------------------------------------------------------------
// 各 section 的数据装配
// ---------------------------------------------------------------------------

function buildHeroKpis(pack, narrative) {
  const wanted = (narrative && Array.isArray(narrative.hero_kpi_keys) && narrative.hero_kpi_keys.length
    ? narrative.hero_kpi_keys
    : DEFAULT_KPI_KEYS
  ).slice(0, 8);
  const cards = [];
  const used = new Set();
  for (const k of wanted) {
    if (used.has(k)) continue;
    const c = kpiCard(pack, k);
    if (c) {
      used.add(k);
      cards.push(c);
    }
    if (cards.length === 4) break;
  }
  // 叙事挑的键取不到数时，用默认清单补齐，绝不让封面开天窗。
  for (const k of DEFAULT_KPI_KEYS.concat(Object.keys(KPI_DEFS))) {
    if (cards.length >= 4) break;
    if (used.has(k)) continue;
    const c = kpiCard(pack, k);
    if (c) {
      used.add(k);
      cards.push(c);
    }
  }
  return cards.map((c) => {
    const y = kpiYoy(pack, c.key);
    return {
      value: c.value,
      label: c.label,
      note: c.note,
      // 有同比就在环比下面加一行，没有整行不出现（新站、月中出报都走这支）。
      yoy_note: y ? '同比 ' + y.delta : null,
    };
  });
}

function buildGa4Cards(pack) {
  const order = [
    'ga4_sessions_organic',
    'ga4_new_users',
    'leads',
    'gsc_clicks',
    'gsc_impressions',
    'gsc_position',
  ];
  const cards = order.map((k) => kpiCard(pack, k)).filter(Boolean);
  const shortLabel = pack.meta.compare.short;
  const decorate = (c) => {
    const y = kpiYoy(pack, c.key);
    return {
      value: c.value,
      label: c.label,
      delta: c.delta,
      delta_color: c.delta_color,
      prev_value: c.prev_value,
      prev_period_short: shortLabel,
      yoy_delta: y ? y.delta : null,
      yoy_delta_color: y ? y.delta_color : null,
      yoy_prev_value: y ? y.prev_value : null,
      yoy_short: y ? y.short : null,
    };
  };
  return { row1: cards.slice(0, 3).map(decorate), row2: cards.slice(3, 6).map(decorate) };
}

// 排名分布四档的画法：档位颜色与关键词表的分档配色一致，
// 变化列的好坏方向只对首尾两档表态（进前十是好，无曝光变多是坏），
// 中间两档涨跌本身说不清好坏，一律灰。
const RANK_DIST_DEFS = [
  { key: 'top10', label: '第 1 至 10 名', color: GREEN, bar_color: GREEN, good: 'up' },
  { key: 'p11_20', label: '第 11 至 20 名', color: BLUE, bar_color: BLUE, good: null },
  { key: 'p21_plus', label: '第 21 名以后', color: '#64748b', bar_color: '#94a3b8', good: null },
  { key: 'none', label: '本月无曝光', color: '#94a3b8', bar_color: '#cbd5e1', good: 'down' },
];

/** 目标词排名分布：两期分档计数加占比条。词表为空时 total 为 0，整块不渲染。 */
function buildRankDist(pack) {
  const rows = (pack.rankings && pack.rankings.rows) || [];
  const total = rows.length;
  if (!total) return { total: 0, bands: [] };
  const cur = { top10: 0, p11_20: 0, p21_plus: 0, none: 0 };
  const prev = { top10: 0, p11_20: 0, p21_plus: 0, none: 0 };
  for (const r of rows) {
    cur[rankBand(r.pos)] += 1;
    prev[rankBand(r.prev_pos)] += 1;
  }
  const bands = RANK_DIST_DEFS.map((d) => {
    const c = cur[d.key];
    const p = prev[d.key];
    const diff = c - p;
    let deltaText = '持平';
    let deltaColor = MUTED;
    if (diff !== 0) {
      deltaText = (diff > 0 ? '+' : '') + diff;
      if (d.good === 'up') deltaColor = diff > 0 ? GREEN : RED;
      else if (d.good === 'down') deltaColor = diff > 0 ? RED : GREEN;
    }
    return {
      label: d.label,
      color: d.color,
      bar_color: d.bar_color,
      count: c,
      prev_count: p,
      delta_text: deltaText,
      delta_color: deltaColor,
      width_pct: Math.round((c / total) * 1000) / 10,
    };
  });
  return { total, bands };
}

function buildChannelRows(pack) {
  const channels = (pack.ga4 && pack.ga4.channels) || [];
  const total = (pack.ga4 && pack.ga4.channels_total) || { sessions: 0, leads: 0 };
  const totalLeads = Number(total.leads) || 0;
  const rows = channels.map((c) => ({
    channel: c.channel,
    sessions: fmtInt(c.sessions),
    leads: fmtInt(c.leads),
    leads_share: totalLeads > 0 ? fmtPct(c.leads / totalLeads, 1) : '待更新',
    is_organic: !!c.is_organic,
    is_muted: !!c.is_muted,
  }));
  return {
    rows,
    total_sessions: fmtInt(total.sessions),
    total_leads: fmtInt(totalLeads),
  };
}

function buildChannelKpis(pack) {
  const total = (pack.ga4 && pack.ga4.channels_total) || null;
  const org = (pack.ga4 && pack.ga4.organic) || {};
  if (!total || !org.cur) return [];
  const shareCur = total.sessions > 0 ? org.cur.sessions / total.sessions : null;
  const sharePrev = total.prev_sessions > 0 ? org.prev.sessions / total.prev_sessions : null;
  const shortPrev = shortPrevCoverage(pack, 'ga4');
  const dTotal = deltaCountCovered(total.sessions, total.prev_sessions, shortPrev);
  const dLeads = deltaCountCovered(total.leads, total.prev_leads, shortPrev);
  const dShare = deltaPp(shareCur, sharePrev);
  const vsNote = withDayNote('vs ' + pack.meta.compare.short, shortPrev);
  return [
    {
      value: fmtInt(total.sessions),
      label: '全渠道访问',
      delta: dTotal.text,
      delta_color: dTotal.color,
      note: vsNote,
    },
    {
      value: fmtInt(total.leads),
      label: '全渠道询盘',
      delta: dLeads.text,
      delta_color: dLeads.color,
      note: vsNote,
    },
    {
      value: shareCur === null ? '待更新' : fmtPct(shareCur, 1),
      label: '自然搜索访问占比',
      delta: dShare.text,
      delta_color: dShare.color,
      note: 'vs ' + pack.meta.compare.short,
    },
  ];
}

function buildFunnel(pack) {
  const steps = ((pack.ga4 && pack.ga4.funnel && pack.ga4.funnel.steps) || []).slice();
  const override = pack.meta && pack.meta.leads_override;
  if (override !== null && override !== undefined && steps.length) {
    const last = steps[steps.length - 1];
    steps[steps.length - 1] = Object.assign({}, last, { cur: Number(override) });
  }
  const base = steps.length ? Number(steps[0].cur) || 0 : 0;
  const basePrev = steps.length ? Number(steps[0].prev) || 0 : 0;
  const shortPrev = shortPrevCoverage(pack, 'ga4');
  const out = steps.map((s, i) => {
    const d = deltaCountCovered(s.cur, s.prev, shortPrev);
    const rate = i === 0 ? '本期基准' : base > 0 ? fmtPct(Number(s.cur) / base, 2) : '待更新';
    return {
      value: fmtInt(s.cur),
      label: s.label,
      rate_label: rate,
      accent_color: FUNNEL_COLORS[i] || FUNNEL_COLORS[FUNNEL_COLORS.length - 1],
      prev_value: withDayNote(fmtInt(s.prev), shortPrev),
      delta: d.text,
      delta_color: d.color,
      is_last: i === steps.length - 1,
    };
  });
  const rows = steps.map((s) => {
    const d = deltaCountCovered(s.cur, s.prev, shortPrev);
    return {
      metric: s.label,
      prev_value: withDayNote(fmtInt(s.prev), shortPrev),
      value: fmtInt(s.cur),
      delta: d.text,
      delta_color: d.color,
      note: shortNote(s.cur, coveredBase(s.prev, shortPrev), true),
    };
  });
  if (steps.length >= 2) {
    const last = steps[steps.length - 1];
    const curRate = base > 0 ? Number(last.cur) / base : null;
    const prevRate = basePrev > 0 ? Number(last.prev) / basePrev : null;
    const d = deltaPp(curRate, prevRate);
    rows.push({
      metric: '访问到询盘转化率',
      prev_value: prevRate === null ? '待更新' : fmtPct(prevRate, 2),
      value: curRate === null ? '待更新' : fmtPct(curRate, 2),
      delta: d.text,
      delta_color: d.color,
      note: shortNote(curRate, prevRate, true),
    });
  }
  return { steps: out, rows };
}

function buildKeywordRows(pack) {
  const rows = ((pack.rankings && pack.rankings.rows) || []).slice();
  rows.sort((a, b) => (a.is_brand === b.is_brand ? 0 : a.is_brand ? -1 : 1));
  return rows.map((r) => {
    let posColor = MUTED;
    if (r.band === 'top10') posColor = GREEN;
    else if (r.band === 'p11_20') posColor = BLUE;
    let deltaText = '本月无曝光';
    let deltaColor = '';
    if (r.pos !== null && r.prev_pos === null) {
      deltaText = '新进榜';
    } else if (r.delta !== null) {
      if (Math.abs(r.delta) < 0.05) {
        deltaText = '基本持平';
      } else if (r.delta < 0) {
        deltaText = '提升 ' + Math.abs(r.delta).toFixed(1) + ' 位';
        deltaColor = GREEN;
      } else {
        deltaText = '回落 ' + r.delta.toFixed(1) + ' 位';
        deltaColor = RED;
      }
    }
    return {
      keyword: r.keyword,
      prev_pos: r.prev_pos === null ? '无曝光' : Number(r.prev_pos).toFixed(1),
      pos: r.pos === null ? '无曝光' : Number(r.pos).toFixed(1),
      pos_color: posColor,
      delta_text: deltaText,
      delta_color: deltaColor,
      impressions: fmtInt(r.impressions),
      is_brand: !!r.is_brand,
    };
  });
}

function buildPageRows(pack) {
  const rows = (pack.ga4 && pack.ga4.landing_pages) || [];
  const shortPrev = shortPrevCoverage(pack, 'ga4');
  return rows.map((r, i) => {
    let delta = '新进榜';
    let color = MUTED;
    if (r.prev_sessions !== null && r.prev_sessions !== undefined) {
      const d = deltaCountCovered(r.sessions, r.prev_sessions, shortPrev);
      delta = d.text;
      color = d.color;
    }
    return {
      rank: i + 1,
      path: r.path,
      sessions: fmtInt(r.sessions),
      // 每行都缀「仅 N 天」会把表撑得很吵，天数在本节说明里讲一次就够，
      // 这里只保证变化列是折算后的口径。
      prev_sessions: r.prev_sessions === null || r.prev_sessions === undefined ? '新增' : fmtInt(r.prev_sessions),
      delta,
      delta_color: color,
    };
  });
}

const CAT_META = {
  onpage: { cat_class: 'cat-onpage', cat_label: 'On-Page' },
  content: { cat_class: 'cat-content', cat_label: '内容' },
  link: { cat_class: 'cat-link', cat_label: '外链' },
  tech: { cat_class: 'cat-tech', cat_label: 'Technical' },
  ads: { cat_class: 'cat-report', cat_label: '广告账户' },
  report: { cat_class: 'cat-report', cat_label: '报告' },
};
const CAT_ORDER = ['onpage', 'content', 'link', 'tech', 'ads', 'report'];

function buildWorkItems(pack, narrative) {
  const fromModel = narrative && Array.isArray(narrative.work_items) ? narrative.work_items : null;
  if (fromModel && fromModel.length) {
    return fromModel
      .filter((w) => w && (w.title || w.body))
      .map((w) => {
        const meta = CAT_META[String(w.category || '').toLowerCase()] || CAT_META.report;
        return {
          cat_class: meta.cat_class,
          cat_label: meta.cat_label,
          title: String(w.title || ''),
          body: paragraphs(w.body),
        };
      });
  }
  // 降级：按分类把 pack 的原始条目直出，标题原文不改写。
  const byCat = new Map();
  for (const it of (pack.work && pack.work.items) || []) {
    const cat = CAT_META[it.category] ? it.category : 'report';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(it);
  }
  const out = [];
  for (const cat of CAT_ORDER) {
    const list = byCat.get(cat);
    if (!list || !list.length) continue;
    const meta = CAT_META[cat];
    out.push({
      cat_class: meta.cat_class,
      cat_label: meta.cat_label,
      title: meta.cat_label + '相关工作 ' + list.length + ' 项',
      body: paragraphs(list.map((it) => it.date + ' ' + it.title_raw).join('\n')),
    });
  }
  return out;
}

const NEXT_SLOT_CLASS = ['cat-p0', 'cat-p1', 'cat-p1', 'cat-p1', 'cat-link'];
const NEXT_FALLBACK = [
  { priority: 'P1', title: '基于本期数据的优化重点', body: '按本期排名与页面表现，挑出回落词与逼近首页的词，逐一对应到落地页做标题、搜索结果描述与内链的调整。' },
  { priority: 'P2', title: '外链建设', body: '围绕本期带量的核心页面继续做站外布点，优先本地相关站点。' },
  { priority: 'P3', title: '内容更新', body: '按合同节奏推进博客与页面内容，选题方向取本期数据里有需求的方向。' },
  { priority: 'P4', title: '站点健康检查', body: '例行做一轮站点健康检查，覆盖收录、跳转、结构化数据与页面加载。' },
  { priority: 'P5', title: '数据监督与报告交付', body: '继续按月监控搜索表现与询盘，下月按时出报告。' },
];

function buildNextItems(pack, narrative) {
  const fromModel = narrative && Array.isArray(narrative.next_items) ? narrative.next_items : null;
  const items = [];
  for (let i = 0; i < 5; i++) {
    const m = fromModel && fromModel[i];
    const fb = NEXT_FALLBACK[i];
    const title = (m && m.title) || fb.title;
    const body = (m && m.body) || fb.body;
    items.push({
      cat_class: NEXT_SLOT_CLASS[i],
      priority: (m && m.priority) || fb.priority,
      title: String(title),
      body: paragraphs(body),
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// 成对 callout 缺一时把两列容器降成单列
// ---------------------------------------------------------------------------

/**
 * 模板里的 g2 是两列网格，只给一条 callout 会留一半白。
 * 渲染后扫一遍：g2 容器里只有一个 callout 就把 class 换成 g1（单列）。
 */
/**
 * 模板里的注释是写给我们自己看的（哪一行循环几次、配色怎么分档），
 * 客户查看源码不该看到这些。只留 section 边界标记，其余全部去掉。
 */
function stripGuidanceComments(html) {
  return String(html).replace(/<!--([\s\S]*?)-->/g, (full, inner) => {
    const t = String(inner).trim();
    return /^\/?section:[\w-]+$/.test(t) ? full : '';
  });
}

function collapseLoneGrids(html) {
  // 只认「g2 里恰好一个 callout」这一种形状，多一个少一个都原样放过，
  // 免得贪心匹配吃掉后面的卡片。
  const one = /<div class="g2"([^>]*)>(\s*<div class="callout[\s\S]*?<\/div>\s*)<\/div>/g;
  let out = html.replace(one, (full, attrs, body) => {
    const n = (body.match(/<div class="callout/g) || []).length;
    if (n === 1) return '<div class="g1"' + attrs + '>' + body + '</div>';
    return full;
  });
  // 一条都没有的空容器直接拿掉，别在版面上留一条空行。
  out = out.replace(/<div class="g2"[^>]*>\s*<\/div>/g, '');
  return out;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function loadTemplate(bizType) {
  const file = bizType === 'ecommerce' ? 'template_leadgen.html' : 'template_leadgen.html';
  // 电商模板本期还没做，两种客户都落到 leadgen 模板上，
  // 电商专属块在模板里由 if:ecommerce 注释圈着，渲染层不喂数据就不会出现。
  return fs.readFileSync(path.join(TEMPLATE_DIR, file), 'utf8');
}

/**
 * 渲染报告。
 * pack      lib/factspack.js 的产物，所有数字的唯一来源
 * narrative 叙事 JSON，两轮都失败时传 null 走固定句降级
 * opts      { template?: 模板字符串, sections?: 覆盖 section 编号 }
 * 返回 HTML 字符串。渲染后断言无残留占位符，有残留直接抛错，
 * 因为带 {{ 的报告发出去就是事故。
 */
function renderReport(pack, narrative, opts = {}) {
  if (!pack || !pack.meta) throw new Error('renderReport 拿到的 pack 没有 meta，数据层没跑通');
  const n = narrative || null;
  const meta = pack.meta;
  const ga4Cards = buildGa4Cards(pack);
  const channels = buildChannelRows(pack);
  const funnel = buildFunnel(pack);
  const trend = pack.trend || { months: [], gsc_clicks: [], ga4_sessions_organic: [] };
  const trendValues = (trend.ga4_sessions_organic || []).length
    ? trend.ga4_sessions_organic
    : trend.gsc_clicks || [];
  const hasTrend = trendValues.length > 0;

  const partialNote = meta.period.partial
    ? '截至 ' + meta.period.through_day + ' 日，本月尚未结束，环比用上月同一时段。'
    : '';

  const sdesc = (key, fallback) => {
    const v = n && n[key];
    const s = String(v == null ? '' : v).trim();
    return s ? s : fallback;
  };

  // 工作条目先渲染出来，数字条按渲染后的条目统计，保证数字条与正文一致
  // （v1 时数字条按原始条目算出 3 项，正文却列了 5 条）。
  const workItems = buildWorkItems(pack, n);
  const workCount = (label) => String(workItems.filter((w) => w.cat_label === label).length);
  const rankDist = buildRankDist(pack);

  const data = {
    client_name: meta.client_name,
    period_label: meta.period.label,
    prev_period_label: meta.compare.label,
    period_short: meta.period.short,
    prev_period_short: meta.compare.short,
    next_period_short: nextMonthShort(meta.period.start),
    site_domain: meta.domain,
    market: meta.market || '',
    platform: meta.platform || '',
    vertical: meta.vertical || '',
    // 页眉信息条只列有值的项，空字段不显示「待更新」，客户面不该看到占位。
    hdr_chips: [meta.domain, meta.market, meta.platform, meta.vertical]
      .map((s) => String(s || '').trim())
      .filter((s) => s)
      .map((s) => escapeHtml(s))
      .join(' &nbsp;·&nbsp; '),
    hero_headline: (n && n.hero_headline) || '本期搜索表现与工作进展汇总',
    hero_kpis: buildHeroKpis(pack, n),
    // 页眉与 KPI 卡的同比标注。pack.yoy 为 null 时（月中出报、新站、
    // 取数失败）这些字段都是 null，模板里同比相关的块整块不出现。
    yoy_label: pack.yoy && pack.yoy.period ? pack.yoy.period.label : null,
    nav_items: [
      { anchor: 'ga4', label: '流量概览' },
      { anchor: 'channels', label: '全渠道' },
      { anchor: 'funnel', label: '询盘漏斗' },
      { anchor: 'rankings', label: '关键词排名' },
      { anchor: 'pages', label: '重点页面' },
      { anchor: 'work', label: '本期工作' },
      { anchor: 'next', label: '下期计划' },
    ],
    sec_ga4_num: 1,
    sec_channels_num: 2,
    sec_funnel_num: 3,
    sec_rankings_num: 4,
    sec_pages_num: 5,
    sec_work_num: 6,
    sec_next_num: 7,

    ga4_sdesc: paragraphs(sdesc('ga4_sdesc', fallbackSdesc(pack) + partialNote)),
    ga4_kpis_row1: ga4Cards.row1,
    ga4_kpis_row2: ga4Cards.row2,
    ga4_callouts: calloutList(n && n.ga4_callouts, ['green', 'yellow']),
    trend_range_label: hasTrend ? trend.months[0] + ' 至 ' + trend.months[trend.months.length - 1] : '待更新',
    trend_subtitle: hasTrend
      ? '按自然月汇总' + (trend.last_partial ? '，最后一个月为本月未结束的实际值' : '')
      : '历史趋势数据待更新',

    channels_sdesc: paragraphs(
      sdesc('channels_sdesc', '本节按 GA4 默认渠道分组统计全渠道访问与询盘，对比 ' + meta.compare.label + '。')
    ),
    channel_kpis: buildChannelKpis(pack),
    channel_rows: channels.rows,
    total_sessions: channels.total_sessions,
    total_leads: channels.total_leads,
    channels_callout_title: (n && n.channels_callout && n.channels_callout.title) || '全渠道与自然搜索对照',
    channels_callout_body: paragraphs(
      (n && n.channels_callout && n.channels_callout.body) ||
        '本节数字来自 GA4 默认渠道分组，合计按渠道行相加，与上方概览一致。'
    ),

    funnel_sdesc: paragraphs(
      sdesc(
        'funnel_sdesc',
        '漏斗按自然搜索访问、开始填写表单、询盘三步统计，询盘按 ' + meta.leads_source + ' 计入。' +
          (meta.leads_override !== null && meta.leads_override !== undefined
            ? '本期询盘总数按后台实收计入。'
            : '')
      )
    ),
    funnel_steps: funnel.steps,
    funnel_callouts: calloutList(n && n.funnel_callouts, ['green', 'yellow']),
    funnel_compare_rows: funnel.rows,
    aov_callout: null,

    rankings_sdesc: paragraphs(
      sdesc(
        'rankings_sdesc',
        '目标词共 ' + ((pack.rankings && pack.rankings.summary && pack.rankings.summary.total) || 0) +
          ' 个，位次按查询簇的曝光加权计算。表中前 10 名用绿色，11 至 20 名用蓝色，20 名以后用灰色。' +
          '标注本月无曝光的词，多数是精确匹配掉了样本，不代表站点该品类没有流量。'
      )
    ),
    keyword_rows: buildKeywordRows(pack),
    rankings_callouts: calloutList(n && n.rankings_callouts, ['green', 'yellow']),
    rank_dist: rankDist.bands,
    rank_dist_total: rankDist.total,

    pages_sdesc: paragraphs(
      sdesc('pages_sdesc', '数据来自 GA4 自然搜索渠道的落地页访问，对比 ' + meta.compare.label + '。')
    ),
    page_rows: buildPageRows(pack),
    pages_callouts: calloutList(n && n.pages_callouts, ['green', 'yellow']),

    work_sdesc: paragraphs(sdesc('work_sdesc', '本期完成的工作按分类汇总如下。')),
    // 工作量数字条：客户要看到我方做了多少，数字直出不经模型。
    work_total: String(workItems.length),
    work_pages: workCount(CAT_META.onpage.cat_label),
    work_blogs: workCount(CAT_META.content.cat_label),
    work_tech: workCount(CAT_META.tech.cat_label),
    work_ads: workCount(CAT_META.ads.cat_label),
    work_report: workCount(CAT_META.report.cat_label),
    work_items: workItems,

    next_sdesc: paragraphs(sdesc('next_sdesc', '下期按以下五项推进，优先级从上到下。')),
    next_items: buildNextItems(pack, n),

    trend_months_json: JSON.stringify(hasTrend ? trend.months : []),
    trend_values_json: JSON.stringify(hasTrend ? trendValues : []),
  };

  const tpl = opts.template || loadTemplate(meta.biz_type);
  let html = renderTemplate(tpl, data);
  html = stripGuidanceComments(html);
  html = collapseLoneGrids(html);

  const leftover = html.match(/\{\{[^}]{0,40}/);
  if (leftover) throw new Error('渲染后仍有未替换的占位符：' + leftover[0]);
  return html;
}

/** 下一个月的短标签，给「下月工作计划」标题用。 */
function nextMonthShort(startYmd) {
  const m = /^(\d{4})-(\d{2})/.exec(String(startYmd || ''));
  if (!m) return '下月';
  let month = Number(m[2]) + 1;
  if (month > 12) month = 1;
  return month + '月';
}

module.exports = {
  renderReport,
  renderTemplate,
  parseTemplate,
  collapseLoneGrids,
  stripGuidanceComments,
  buildHeroKpis,
  buildFunnel,
  buildKeywordRows,
  buildPageRows,
  buildChannelRows,
  buildChannelKpis,
  buildWorkItems,
  buildNextItems,
  buildRankDist,
  kpiCard,
  kpiValues,
  kpiYoy,
  fmtInt,
  fmtPct,
  fmtPos,
  fmtMoney,
  deltaCount,
  deltaPosition,
  deltaPp,
  shortNote,
  paragraphs,
  escapeHtml,
  nextMonthShort,
  KPI_DEFS,
  DEFAULT_KPI_KEYS,
};
