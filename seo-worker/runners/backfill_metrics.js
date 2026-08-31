'use strict';
// backfill_metrics runner：把 GSC 和 GA4 的历史按日数据补进 seo_metrics_daily。
// 零 LLM，从头到尾是 API 读加确定性计算。幂等，随便重跑。
//
// 为什么要单独一个 job：pull_data 只覆盖 28 天窗口，趋势图第一天上线就只有
// 28 个点。这个 job 一次把 180 天补齐，之后交给 pull_data 逐日往前滚。
//
// 回填得到什么、回填不到什么：
//   能回填  gsc_impressions / gsc_clicks / gsc_impressions_brand /
//           gsc_clicks_brand / ga4_sessions_organic / ga4_leads
//           GSC 可回溯 16 个月，GA4 从 property 建立起，都够 180 天
//   回填不到 rank_top3 / rank_top10 / rank_top20 / rank_tracked / ref_domains
//           Semrush 的排名和引荐域只有"现在"这一个值，历史要按天的得订
//           历史数据接口，我们没有。所以这五个指标从今天起由 pull_data
//           每次拉取记一个点，慢慢攒出曲线，回填这里一行都不写。
//           不写假数据比画一条编出来的线重要。
//
// payload:
//   { days: 180 }              回填多少天，默认 180，上限 500
//   { to: '2026-08-21' }       窗口右端，默认 今天 - LAG_DAYS
//   { sources: ['gsc','ga4'] } 只跑其中一部分，默认两个都跑

const { reportWindow, ymd } = require('../lib/util');
const metrics = require('../lib/metrics');
const googleads = require('../lib/googleads');

const DEFAULT_DAYS = 180;
const MAX_DAYS = 500;
// GSC 最后两三天的数据还没收全，和 pull_data 用同一个滞后天数，
// 免得回填写进去一个偏低的值又被后续拉取改写。
const LAG_DAYS = 3;

/** 把 to 往前推 days-1 天，得到含首含尾的窗口。 */
function windowFrom(to, days) {
  const end = metrics.parseYmd(to);
  if (!end) return null;
  const start = new Date(end.getTime());
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start: ymd(start), end: ymd(end) };
}

async function run(ctx) {
  const { job, api, log } = ctx;
  const payload = job.payload || {};

  let days = Number(payload.days);
  if (!Number.isFinite(days) || days < 1) days = DEFAULT_DAYS;
  if (days > MAX_DAYS) days = MAX_DAYS;

  const to = metrics.normalizeDate(payload.to) || reportWindow(1, LAG_DAYS).end;
  const win = windowFrom(to, days);
  if (!win) throw new Error('回填窗口算不出来，payload.to 不合法：' + payload.to);

  const wanted = Array.isArray(payload.sources) && payload.sources.length
    ? payload.sources.map((s) => String(s).toLowerCase())
    : ['gsc', 'ga4', 'ads'];

  const context = await api.getContext(job.client_id);
  const profile = (context && context.profile) || null;
  if (!profile) throw new Error('context returned no profile for client_id ' + job.client_id);
  const clientName = (context && context.client && context.client.name) || '';
  log(
    '回填窗口 ' + win.start + ' 到 ' + win.end + '（' + days + ' 天），源 [' + wanted.join(', ') + ']，客户 ' +
      (clientName || profile.name || job.client_id)
  );

  const rows = [];
  const errors = [];

  // ---- GSC ----
  if (wanted.indexOf('gsc') !== -1) {
    const property = profile.gsc_property || profile.gsc_site;
    if (!property) {
      log('gsc: profile 没有 gsc_property，跳过');
    } else {
      const spam = ctx.cfg.gscSpamExcludeRegex;
      log('gsc: property ' + property + '，垃圾词过滤 ' + spam);
      try {
        const daily = await metrics.pullGscDaily(ctx, property, win, spam);
        for (const r of daily) {
          rows.push({ d: r.date, m: 'gsc_impressions', v: r.impressions });
          rows.push({ d: r.date, m: 'gsc_clicks', v: r.clicks });
        }
        log('gsc: 曝光点击拿到 ' + daily.length + ' 天');
      } catch (e) {
        log('gsc: 按日曝光点击 FAILED :: ' + e.message);
        errors.push('gsc daily: ' + e.message);
      }

      // 品牌拆分。date x query 两维一次能拉，rowLimit 25000，按 14 天分段加翻页。
      const brand = metrics.deriveBrandRegex({
        brandRegex: profile.brand_regex,
        clientName,
        domain: profile.domain,
      });
      if (brand.error) log('gsc: ' + brand.error + '，改用推导');
      if (!brand.regex) {
        log('gsc: 推不出品牌正则，跳过品牌拆分（可在 profile.brand_regex 手填）');
      } else {
        log('gsc: 品牌正则 /' + brand.pattern + '/i，来源 ' + brand.source);
        try {
          const bd = await metrics.pullGscDailyBrand(ctx, property, win, spam, brand.regex);
          for (const r of bd || []) {
            rows.push({ d: r.date, m: 'gsc_impressions_brand', v: r.impressions });
            rows.push({ d: r.date, m: 'gsc_clicks_brand', v: r.clicks });
          }
          log('gsc: 品牌拆分拿到 ' + ((bd && bd.length) || 0) + ' 天');
        } catch (e) {
          log('gsc: 品牌拆分 FAILED :: ' + e.message);
          errors.push('gsc brand: ' + e.message);
        }
      }
    }
  }

  // ---- GA4 ----
  if (wanted.indexOf('ga4') !== -1) {
    const propertyId = profile.ga4_property || profile.ga4_property_id;
    if (!propertyId) {
      log('ga4: profile 没有 ga4_property，跳过');
    } else {
      log('ga4: property ' + propertyId);
      try {
        const org = await metrics.pullGa4OrganicDaily(ctx, propertyId, win);
        for (const r of org) rows.push({ d: r.date, m: 'ga4_sessions_organic', v: r.sessions });
        log('ga4: 自然会话拿到 ' + org.length + ' 天');
      } catch (e) {
        log('ga4: 按日自然会话 FAILED :: ' + e.message);
        errors.push('ga4 organic: ' + e.message);
      }
      try {
        const leads = await metrics.pullGa4LeadsDaily(ctx, propertyId, win);
        for (const r of leads) rows.push({ d: r.date, m: 'ga4_leads', v: r.leads });
        log('ga4: lead 事件拿到 ' + leads.length + ' 天');
      } catch (e) {
        log('ga4: 按日 lead 事件 FAILED :: ' + e.message);
        errors.push('ga4 leads: ' + e.message);
      }
    }
  }

  log('排名分档与引荐域不回填：Semrush 只给当下的值，没有按日历史，这五个指标从今起由 pull_data 逐次累积');

  // 越界的行一律丢掉。理论上不会有，真出现了说明上游给了窗口外的日期，
  // 与其写进去污染时序，不如丢掉并记一句。
  const inRange = rows.filter((r) => r.d >= win.start && r.d <= win.end);
  if (inRange.length !== rows.length) {
    log('丢弃 ' + (rows.length - inRange.length) + ' 行窗口外数据');
  }

  if (wanted.indexOf('ads') !== -1) {
    const adsCid = String(profile.ads_customer_id || '').replace(/-/g, '');
    if (!adsCid) {
      log('ads: profile 没有 ads_customer_id，跳过');
    } else {
      try {
        const daily = await googleads.dailyMetrics(adsCid, win);
        for (const row of googleads.metricRows(daily)) rows.push(row);
        log('ads: 日指标拿到 ' + daily.length + ' 天');
      } catch (e) {
        log('ads: 回填 FAILED :: ' + e.message);
        errors.push('ads daily: ' + e.message);
      }
    }
  }

  const written = await metrics.postMetricRows(api, job.client_id, inRange, log);
  log('回填完成，写入 ' + written + ' 行' + (errors.length ? '，' + errors.length + ' 处降级' : ''));

  // 一个源挂了不算成功：回填是人工触发的一次性动作，失败必须显眼，
  // 否则趋势图上会留一段谁都不知道为什么空着的区间。
  if (errors.length) {
    throw new Error('backfill_metrics 完成但有失败项 :: ' + errors.join(' | '));
  }
  return { tokenUsage: 0 };
}

module.exports = { run, windowFrom, DEFAULT_DAYS, MAX_DAYS, LAG_DAYS };
