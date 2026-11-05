#!/usr/bin/env node
'use strict';
// 月报数据包落盘（ticket #57 / CtoMi #1716，2026-11-06）。
//
// 背景：monthly-report-generate 是 agent_apply 泳道的 op，但 apply 的无头 agent
// 不许自带取数脚本（San Michelle #1887 实证：方案让 agent 跑 /data/aira/scripts/
// 下的孤儿脚本，Mac worker 上缺依赖缺密钥，apply 中止）。数字只能有一个来源：
// lib/factspack.js。本工具把那一层包装成 agent 可调用的一条命令：依赖走部署目录
// 的 node_modules，凭据走部署目录的 config.json（与 pull_data 同一套，两台 worker
// 都有），零 LLM，零写入平台，只写客户工作区一个 JSON 文件。
//
// 用法（在 /data/aira/seo-worker 下跑，apply 方案里写死这个绝对路径）：
//   node /data/aira/seo-worker/tools/report_pack.js <client_id> [--month YYYY-MM] [--out <path>]
//
//   <client_id>   看板客户号（方案里有）
//   --month       报告月份，缺省为上个自然月
//   --out         输出路径，缺省 clients/<工作区>/seo-agent-output/report-<YYYY-MM>.pack.json
//
// 输出文件就是 buildFactsPack 的完整产物：报告里允许出现的每一个数字都在里面，
// 铁律同报告产线（模型只许照抄 pack 数字）。市场拆分、目标词实际排名页面、
// low_sample 旗等字段见 lib/factspack.js 的 ticket #57 注释。

const fs = require('node:fs');
const path = require('node:path');

const config = require('../lib/config');
const { Api } = require('../lib/api');
const { buildFactsPack, computePeriod, ptCutoffYmd } = require('../lib/factspack');
const { ensureClientWorkspace, clientDirName, localYmd } = require('../lib/util');

function die(msg) { console.error('report_pack: ' + msg); process.exit(2); }

function lastMonthYm(today) {
  const [y, m] = today.slice(0, 7).split('-').map(Number);
  const t = y * 12 + (m - 1) - 1;
  return Math.floor(t / 12) + '-' + String((t % 12) + 1).padStart(2, '0');
}

(async () => {
  const argv = process.argv.slice(2);
  const clientId = parseInt(argv[0], 10) || 0;
  if (!clientId) die('用法：node tools/report_pack.js <client_id> [--month YYYY-MM] [--out <path>]');
  const monthIx = argv.indexOf('--month');
  const outIx = argv.indexOf('--out');
  const today = localYmd();
  const month = monthIx === -1 ? lastMonthYm(today) : String(argv[monthIx + 1] || '');
  if (!/^\d{4}-\d{2}$/.test(month)) die('--month 必须是 YYYY-MM');

  const cfg = config.load();
  if (!cfg.serviceToken) die('config.json 里没有 serviceToken，请在部署目录（/data/aira/seo-worker）下运行');
  const api = new Api(cfg);
  const log = (s) => console.error('[report_pack] ' + s);

  const context = await api.getContext(clientId);
  const profile = (context && context.profile) || null;
  if (!profile) die('GET /context 没拿到 client_id ' + clientId + ' 的 profile');

  const workspace = ensureClientWorkspace(profile, cfg);
  const slug = clientDirName(profile, cfg);

  const period = computePeriod({
    type: 'month',
    start: month + '-01',
    end: null,
    today,
    lagDays: 3,
    clampEnd: ptCutoffYmd(),
  });
  log('客户 ' + clientId + '（' + slug + '），周期 ' + period.start + ' 至 ' + period.end +
    '，对比 ' + period.compare.start + ' 至 ' + period.compare.end);

  const ctx = { cfg, api, log, job: { client_id: clientId } };
  const pack = await buildFactsPack(ctx, profile, context, period, { workspace, slug });
  if (pack.gaps && pack.gaps.length) log('数据缺口 ' + pack.gaps.length + ' 条：' + pack.gaps.join('；'));

  const outPath = outIx === -1
    ? path.join(workspace, 'seo-agent-output', 'report-' + month + '.pack.json')
    : String(argv[outIx + 1] || '');
  if (!outPath) die('--out 给了旗没给值');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(pack, null, 1), 'utf8');
  // stdout 只给机器可读的落点与要点，凭据永不出现。
  console.log(JSON.stringify({
    ok: true,
    out: outPath,
    period: { start: period.start, end: period.end, label: period.label },
    gaps: pack.gaps || [],
    has_markets: !!(pack.gsc && pack.gsc.markets),
    rank_rows: pack.rankings && pack.rankings.rows ? pack.rankings.rows.length : 0,
  }));
})().catch((e) => { die(e.stack || e.message || String(e)); });
