'use strict';

// 指标哨兵（2026-10-16 Alvin 批：HornTech 两站曝光跳崖一个月无人发现后补的机制；
// 同日第一性复盘后调整：询盘改 14 天窗防泊松噪音、加投放断流规则、任务置顶、生态级并单指引）。
// pull_data 收尾时对库里已清洗的时序（非品牌、剔 spam）做零模型周环比回归，
// 命中阈值就开一张诊断任务进看板，由轮次判定官决定做不做。
// 铁律：纯算术，不碰 LLM；任何失败只降级，不拖垮 pull job。

const TITLE_PREFIX = '[指标哨兵]';
const DEDUP_DAYS = 14;
const LOOKBACK_DAYS = 35; // 询盘两个 14 天窗 28 天 + GSC 迟到缓冲

// 回归规则。winDays 是单窗长度；weeks=2 时 w0 与 w1 都要跌破基线窗 w2（连续塌方才算，
// 防单窗噪音——曝光这种虚指标只有持续塌方才值得一张单）。
// floor 是对「上一窗/基线窗」的最低量门槛，小样本客户不开单。
// 询盘用 14 天窗：周窗基数 4 的 -50% 泊松误报率约 24%，14 天窗基数 10 压到 7% 以下。
// coverage 是每窗至少要有数据行的天数（GSC 序列天天有行，覆盖不足说明取数空洞，宁漏不误报）。
// 点击改两窗连续塌方（2026-10-25 Alvin 批，HornTech #1373 学费：周基数 24 刚过 floor 20，
// 正常振荡 22,15,15,22,24,11,17 也能触发 -50% 单；floor 提 50 会让周基数 20 量级的站对真塌方
// 永久失聪，所以收紧的是持续性不是基数，与曝光同口径，代价是报警晚一个窗）。
const RULES = [
  { metric: 'gsc_clicks', label: '自然点击', winDays: 7, drop: 0.3, floor: 20, weeks: 2, coverage: 5 },
  { metric: 'ga4_leads', label: '自然询盘', winDays: 14, drop: 0.5, floor: 10, weeks: 1, coverage: 0 },
  { metric: 'gsc_impressions', label: '搜索曝光', winDays: 7, drop: 0.4, floor: 1000, weeks: 2, coverage: 5 },
];

// 投放断流：锚定日往前 3 天花费合计为 0（含缺行），再往前 7 天花费 >= floor。
// 捕获的是预算烧完、账单失败、全量拒登、误暂停、取数断流这类「没人动手却停了」的事故。
const ADS_STOP = { metric: 'ads_cost', label: '广告花费', stopDays: 3, baseDays: 7, floor: 50 };

function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

function ymd(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

const DAY = 24 * 3600 * 1000;

/** 一个窗口的和与有数据的天数。end 含当天，往回数 days 天。 */
function windowSum(byDay, endTs, days) {
  let sum = 0;
  let covered = 0;
  for (let i = 0; i < days; i++) {
    const key = ymd(endTs - i * DAY);
    if (Object.prototype.hasOwnProperty.call(byDay, key)) {
      sum += byDay[key];
      covered += 1;
    }
  }
  return { sum, covered };
}

function toByDay(pts) {
  const byDay = {};
  let maxTs = null;
  for (const p of pts || []) {
    const ts = parseYmd(p && p.d);
    if (ts == null) continue;
    byDay[ymd(ts)] = Number(p.v) || 0;
    if (maxTs == null || ts > maxTs) maxTs = ts;
  }
  return { byDay, maxTs };
}

/**
 * 纯函数：seriesByMetric = { metric: [{d,v},...] }，返回命中的告警数组。
 * 回归规则的锚取 GSC 系列的最新日期（ga4_leads 只在有询盘的日子才有行，缺行就是 0，
 * 不能拿它自己的最新行当锚，否则询盘枯竭这种最该报的情况反而永远测不到）。
 * 投放断流用 ads_cost 自己的锚（两套取数各有各的迟到节奏）。
 */
function evalSentinel(seriesByMetric) {
  const src = seriesByMetric || {};
  let anchorTs = null;
  const maps = {};
  for (const rule of RULES) {
    const { byDay, maxTs } = toByDay(src[rule.metric]);
    maps[rule.metric] = byDay;
    if (rule.metric !== 'ga4_leads' && maxTs != null && (anchorTs == null || maxTs > anchorTs)) {
      anchorTs = maxTs;
    }
  }

  const alerts = [];
  if (anchorTs != null) {
    for (const rule of RULES) {
      const byDay = maps[rule.metric];
      const W = rule.winDays * DAY;
      const w0 = windowSum(byDay, anchorTs, rule.winDays);
      const w1 = windowSum(byDay, anchorTs - W, rule.winDays);
      const w2 = windowSum(byDay, anchorTs - 2 * W, rule.winDays);
      if (rule.coverage && (w0.covered < rule.coverage || w1.covered < rule.coverage)) continue;
      const keep = 1 - rule.drop;
      let hit = false;
      let base = 0;
      let baseName = '';
      if (rule.weeks === 2) {
        if (rule.coverage && w2.covered < rule.coverage) continue;
        base = w2.sum;
        baseName = '基线窗（两窗前）';
        hit = base >= rule.floor && w0.sum <= keep * base && w1.sum <= keep * base;
      } else {
        base = w1.sum;
        baseName = '上一窗';
        hit = base >= rule.floor && w0.sum <= keep * base;
      }
      if (hit) {
        const dropPct = base > 0 ? Math.round((1 - w0.sum / base) * 100) : 0;
        alerts.push({
          metric: rule.metric,
          label: rule.label,
          cur: w0.sum,
          base,
          dropPct,
          weeks: rule.weeks,
          anchor: ymd(anchorTs),
          tag: rule.label + '降' + dropPct + '%',
          line:
            rule.label + ' 近 ' + rule.winDays + ' 天 ' + w0.sum + '，对' + baseName + ' ' + base + ' 掉 ' + dropPct + '%',
        });
      }
    }
  }

  // 投放断流
  const ads = toByDay(src[ADS_STOP.metric]);
  if (ads.maxTs != null) {
    const last = windowSum(ads.byDay, ads.maxTs, ADS_STOP.stopDays);
    const base = windowSum(ads.byDay, ads.maxTs - ADS_STOP.stopDays * DAY, ADS_STOP.baseDays);
    if (base.sum >= ADS_STOP.floor && last.sum === 0) {
      alerts.push({
        metric: ADS_STOP.metric,
        label: ADS_STOP.label,
        cur: 0,
        base: base.sum,
        dropPct: 100,
        weeks: 1,
        anchor: ymd(ads.maxTs),
        tag: '广告花费断流',
        line:
          '广告花费 近 ' +
          ADS_STOP.stopDays +
          ' 天为 0（含缺行），此前 ' +
          ADS_STOP.baseDays +
          ' 天合计 ' +
          base.sum +
          '：投放疑似停摆（预算烧完、账单失败、全量拒登、误暂停或取数断流），先核账户状态再谈其他',
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
  const lines = [
    '指标哨兵在 pull_data 收尾的周期回归里命中阈值（锚定日 ' + alerts[0].anchor + '，GSC 口径为库内非品牌剔 spam 序列）：',
    '',
  ];
  for (const a of alerts) lines.push('- ' + a.line);
  if (pageLines && pageLines.length) {
    lines.push('', '页面级拆解（两窗曝光差额最大的页面，GSC 现拉）：');
    for (const l of pageLines) lines.push('- ' + l);
  }
  lines.push(
    '',
    '判定前先横向核对：看板搜 [指标哨兵]，若组合内多客户同窗同向命中，大概率是生态级事件（算法更新、测量规则变化），' +
      '只在一张单上定性，其余引用该单收口，不要逐家烧一遍诊断。',
    '',
    '任务要求：定位掉幅主因并分类——测量口径变化 / 我方改动后果 / 排名真实下跌 / 追踪断点，四选一给结论；若是真实下跌，给出止血动作清单。只做诊断不动站。'
  );
  return {
    title: TITLE_PREFIX + ' ' + alerts.map((a) => a.tag).join('、') + '（' + alerts[0].anchor + ' 锚）',
    detail: lines.join('\n'),
    module: 'technical',
    owner_type: 'agent',
    status: 'proposed',
    priority: 'P1',
    attention: 1,
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
  const res = await api.getMetrics(clientId, from, to, 'gsc_clicks,gsc_impressions,ga4_leads,ads_cost');
  const series = (res && res.metrics) || {};
  const alerts = evalSentinel(series);
  if (!alerts.length) return '周期回归正常，不开单';
  const blocked = sentinelBlocked(tasks, now);
  if (blocked) return '命中 ' + alerts.length + ' 项但去重拦下：' + blocked;

  let pageLines = [];
  const gscHit = alerts.some((a) => a.metric === 'gsc_clicks' || a.metric === 'gsc_impressions');
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

module.exports = { evalSentinel, sentinelBlocked, buildTask, check, TITLE_PREFIX, RULES, ADS_STOP, DEDUP_DAYS };
