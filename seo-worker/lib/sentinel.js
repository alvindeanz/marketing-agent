'use strict';

// 指标哨兵（2026-10-16 Alvin 批：HornTech 两站曝光跳崖一个月无人发现后补的机制）。
// pull_data 收尾时对库里已清洗的时序（非品牌、剔 spam）做零模型周环比回归，
// 命中阈值就开一张诊断任务进看板，由轮次判定官决定做不做。
// 铁律：纯算术，不碰 LLM；任何失败只降级，不拖垮 pull job。

const TITLE_PREFIX = '[指标哨兵]';
const DEDUP_DAYS = 14;
const LOOKBACK_DAYS = 35; // 3 个整周 + GSC 迟到缓冲

// weeks=1：最近整周 w0 对上一周 w1；weeks=2：w0 与 w1 都对基线周 w2（连续两周才算，
// 防单周噪音——曝光这种虚指标只有持续塌方才值得一张单）。
// floor 是对「上一期/基线」的最低量门槛，小样本客户不开单。
const RULES = [
  { metric: 'gsc_clicks', label: '自然点击', drop: 0.3, floor: 20, weeks: 1, coverage: 5 },
  { metric: 'ga4_leads', label: '自然询盘', drop: 0.5, floor: 4, weeks: 1, coverage: 0 },
  { metric: 'gsc_impressions', label: '搜索曝光', drop: 0.4, floor: 1000, weeks: 2, coverage: 5 },
];

function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

function ymd(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

const DAY = 24 * 3600 * 1000;

/** 一个整周窗口的和与有数据的天数。series 是 {d,v} 数组，end 含当天。 */
function windowSum(byDay, endTs) {
  let sum = 0;
  let covered = 0;
  for (let i = 0; i < 7; i++) {
    const key = ymd(endTs - i * DAY);
    if (Object.prototype.hasOwnProperty.call(byDay, key)) {
      sum += byDay[key];
      covered += 1;
    }
  }
  return { sum, covered };
}

/**
 * 纯函数：seriesByMetric = { metric: [{d,v},...] }，返回命中的告警数组。
 * anchor 取全部序列的最新日期（ga4_leads 只在有询盘的日子才有行，缺行就是 0，
 * 不能拿它自己的最新行当锚，否则询盘枯竭这种最该报的情况反而永远测不到）。
 */
function evalSentinel(seriesByMetric) {
  let anchorTs = null;
  const maps = {};
  for (const rule of RULES) {
    const pts = (seriesByMetric && seriesByMetric[rule.metric]) || [];
    const byDay = {};
    for (const p of pts) {
      const ts = parseYmd(p && p.d);
      if (ts == null) continue;
      byDay[ymd(ts)] = Number(p.v) || 0;
      if (rule.metric !== 'ga4_leads' && (anchorTs == null || ts > anchorTs)) anchorTs = ts;
    }
    maps[rule.metric] = byDay;
  }
  if (anchorTs == null) return [];

  const alerts = [];
  for (const rule of RULES) {
    const byDay = maps[rule.metric];
    const w0 = windowSum(byDay, anchorTs);
    const w1 = windowSum(byDay, anchorTs - 7 * DAY);
    const w2 = windowSum(byDay, anchorTs - 14 * DAY);
    // GSC 序列应当天天有行，覆盖不足说明窗口里有取数空洞，宁可漏报不误报。
    if (rule.coverage && (w0.covered < rule.coverage || w1.covered < rule.coverage)) continue;
    const keep = 1 - rule.drop;
    let hit = false;
    let base = 0;
    if (rule.weeks === 2) {
      if (rule.coverage && w2.covered < rule.coverage) continue;
      base = w2.sum;
      hit = base >= rule.floor && w0.sum <= keep * base && w1.sum <= keep * base;
    } else {
      base = w1.sum;
      hit = base >= rule.floor && w0.sum <= keep * base;
    }
    if (hit) {
      alerts.push({
        metric: rule.metric,
        label: rule.label,
        cur: w0.sum,
        base,
        dropPct: base > 0 ? Math.round((1 - w0.sum / base) * 100) : 0,
        weeks: rule.weeks,
        anchor: ymd(anchorTs),
      });
    }
  }
  return alerts;
}

/** 去重：同客户已有未结哨兵单，或 DEDUP_DAYS 内开过（无论结没结），都不再开。 */
function sentinelBlocked(tasks, nowTs) {
  for (const t of tasks || []) {
    const title = String((t && t.title) || '');
    if (!title.startsWith(TITLE_PREFIX)) continue;
    if (t.status !== 'done') return '已有未结哨兵单 #' + t.id;
    const created = parseYmd(t.created_at);
    if (created != null && nowTs - created < DEDUP_DAYS * DAY) {
      return DEDUP_DAYS + ' 天内已开过哨兵单 #' + t.id;
    }
  }
  return null;
}

function buildTask(clientName, alerts, pageLines) {
  const parts = alerts.map(
    (a) =>
      a.label +
      ' 近 7 天 ' +
      a.cur +
      '，对' +
      (a.weeks === 2 ? '基线周（两周前）' : '上一周') +
      ' ' +
      a.base +
      ' 掉 ' +
      a.dropPct +
      '%'
  );
  const lines = [
    '指标哨兵在 pull_data 收尾的周环比回归里命中阈值（锚定日 ' + alerts[0].anchor + '，GSC 口径为库内非品牌剔 spam 序列）：',
    '',
  ];
  for (const p of parts) lines.push('- ' + p);
  if (pageLines && pageLines.length) {
    lines.push('', '页面级拆解（两窗曝光差额最大的页面，GSC 现拉）：');
    for (const l of pageLines) lines.push('- ' + l);
  }
  lines.push(
    '',
    '任务要求：定位掉幅主因并分类——测量口径变化 / 我方改动后果 / 排名真实下跌 / 追踪断点，四选一给结论；若是真实下跌，给出止血动作清单。只做诊断不动站。'
  );
  return {
    title:
      TITLE_PREFIX +
      ' ' +
      alerts.map((a) => a.label + '降' + a.dropPct + '%').join('、') +
      '（' +
      alerts[0].anchor +
      ' 锚）',
    detail: lines.join('\n'),
    module: 'technical',
    owner_type: 'agent',
    status: 'proposed',
    priority: 'P1',
  };
}

/**
 * pull_data 收尾调用。读库内时序、评估、去重、（命中 GSC 项时）拉页面级拆解、开单。
 * 返回一句给 job log 的话。任何异常让调用方 catch 掉。
 */
async function check(ctx, clientId, profile, tasks) {
  const { api } = ctx;
  const now = Date.now();
  const from = ymd(now - LOOKBACK_DAYS * DAY);
  const to = ymd(now);
  const res = await api.getMetrics(clientId, from, to, 'gsc_clicks,gsc_impressions,ga4_leads');
  const series = (res && res.metrics) || {};
  const alerts = evalSentinel(series);
  if (!alerts.length) return '周环比正常，不开单';
  const blocked = sentinelBlocked(tasks, now);
  if (blocked) return '命中 ' + alerts.length + ' 项但去重拦下：' + blocked;

  let pageLines = [];
  const gscHit = alerts.some((a) => a.metric !== 'ga4_leads');
  const property = profile && (profile.gsc_property || profile.gsc_site);
  if (gscHit && property) {
    try {
      pageLines = await pageSplit(ctx, property, alerts[0].anchor);
    } catch (e) {
      pageLines = ['（页面级拆解失败，降级：' + e.message + '）'];
    }
  }
  const task = buildTask((profile && profile.name) || clientId, alerts, pageLines);
  const out = await api.postTasksBulk({ client_id: clientId, tasks: [task] });
  const id = out && out.ids && out.ids[0];
  return '命中 ' + alerts.map((a) => a.metric).join(',') + '，已开诊断单 #' + (id || '?');
}

/** 两窗页面级曝光差额 top 8。窗口：锚定日往前 7 天 vs 再往前 7 天。 */
async function pageSplit(ctx, property, anchorYmdStr) {
  const metrics = require('./metrics');
  const anchorTs = parseYmd(anchorYmdStr);
  const win = (endTs) => ({ start: ymd(endTs - 6 * DAY), end: ymd(endTs) });
  const a = win(anchorTs);
  const b = win(anchorTs - 7 * DAY);
  const pull = async (w) => {
    const r = await metrics.gscQuery(ctx.cfg, property, {
      startDate: w.start,
      endDate: w.end,
      dimensions: ['page'],
      rowLimit: 100,
    });
    const m = {};
    for (const row of (r && r.rows) || []) m[row.keys[0]] = row.impressions || 0;
    return m;
  };
  const cur = await pull(a);
  const prev = await pull(b);
  const keys = new Set([...Object.keys(cur), ...Object.keys(prev)]);
  const rows = [...keys].map((k) => ({ k, d: (prev[k] || 0) - (cur[k] || 0), p: prev[k] || 0, c: cur[k] || 0 }));
  rows.sort((x, y) => y.d - x.d);
  return rows
    .slice(0, 8)
    .filter((r) => r.d > 0)
    .map((r) => r.k + ' ：' + r.p + ' -> ' + r.c);
}

module.exports = { evalSentinel, sentinelBlocked, buildTask, check, TITLE_PREFIX, RULES, DEDUP_DAYS };
