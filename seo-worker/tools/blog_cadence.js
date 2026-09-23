#!/usr/bin/env node
'use strict';
/**
 * 博客节奏补缺（一个 sprint 一篇，2026-09-23 Alvin 定）。零模型；--apply 建的任务会照常进判定门。
 *
 * 用法：SEO_WORKER_CONFIG=/data/aira/seo-worker/config.json node tools/blog_cadence.js [--apply] [cid...]
 *   默认只打印缺口；--apply 才建占位任务。不给 cid 时现查 /board，只处理开了
 *   fact contract.blog_per_sprint 的客户。
 * 人手触发（硬规矩 1：建任务会连带排判定 job 调模型，不许挂 cron）。
 * 多 worker 安全：只在人手跑的这一个进程里写；重复跑幂等，因为已补的占位任务会计入 sprint 计数。
 */
const { Api } = require('../lib/api');
const cfg = require('../lib/config').load();
const blogcadence = require('../lib/blogcadence');
const capabilities = require('../lib/capabilities');

async function main() {
  const api = new Api(cfg);
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const argIds = argv.filter((a) => /^\d+$/.test(a)).map(Number);
  const today = new Date(Date.now() + 12 * 3600 * 1000).toISOString().slice(0, 10); // NZ 日期
  const board = await api.req('GET', '/board');
  const rows = ((board && board.clients) || []).filter((c) => !argIds.length || argIds.includes(Number(c.client_id)));
  let total = 0;
  for (const c of rows) {
    const cid = Number(c.client_id);
    const ctx = await api.getContext(cid);
    const quota = blogcadence.quotaOf(ctx);
    if (!quota) {
      if (argIds.length) console.log('[' + cid + ' ' + c.name + '] 没开博客节奏（缺 fact ' + blogcadence.FACT_KEY + '），跳过');
      continue;
    }
    const anchor = ctx.active_plan && ctx.active_plan.created_at ? String(ctx.active_plan.created_at).slice(0, 10) : '';
    const cur = blogcadence.currentSprint(anchor, today);
    const g = blogcadence.gaps(ctx, today);
    const by = blogcadence.countBySprint(ctx.tasks || []);
    const line = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'].map((s) => s + ':' + by[s].length).join(' ');
    console.log('[' + cid + ' ' + c.name + '] 每 sprint ' + quota + ' 篇，锚点 ' + anchor + '，当前 S' + cur + ' | ' + line);
    if (!g.length) { console.log('   无缺口'); continue; }
    const platform = (ctx.profile && (ctx.profile.platform || ctx.profile.cms)) || '';
    const hasBlogOp = platform ? capabilities.operations(platform).some((o) => o.name === 'blog-draft') : false;
    const tasks = [];
    for (const gap of g) {
      console.log('   ' + gap.sprint + '（' + gap.range.start + ' 至 ' + gap.range.end + '）缺 ' + gap.missing + (gap.catchup ? '，欠交，补在 ' + gap.target : ''));
      for (let k = 0; k < gap.missing; k++) tasks.push(blogcadence.placeholderTask(gap, k, hasBlogOp));
    }
    total += tasks.length;
    if (!apply) continue;
    const res = await api.postTasksBulk({ client_id: cid, tasks });
    console.log('   已建 ' + tasks.length + ' 个占位任务：' + ((res && res.ids) || []).map((x) => '#' + x).join(' ') + (res && res.review_job_id ? '，判定 job ' + res.review_job_id : ''));
  }
  console.log((apply ? '完成，建了 ' : '预览，将建 ') + total + ' 个占位任务' + (apply ? '' : '（加 --apply 才建）'));
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
