#!/usr/bin/env node
'use strict';
// T4 统计打分（PLAN W18，2026-10-25 Alvin 批）。零 LLM，人触发：随月底 DEFECTS 复盘跑，
// 平时想看随时跑。先 label_sync 采新标签（--no-sync 跳过），再按 seo / paid 分桶打印
// 四道 Gate 的进度。门槛管解锁动作，日历只管跑本工具（W18 定版）。
//   Gate A judge 校准：override 配对标签 总量>=50 且单一 fable 判决类型>=20
//   Gate B ACE 蒸馏升级：标签流落地满 30 天
//   Gate C 结果层回测：按动作类型成熟窗（cohort 已接 SEO 侧；paid 回测未接，欠账打印）
//   Gate D GEPA prompt 优化：golden>=50 且 holdout>=25 且 Gate A 已过 且目标 runner trace>=100
//   用法：SEO_AGENT_TOKEN=<admin jwt> node tools/label_stats.js [--no-sync]
// golden 标注集：<traces>/golden/{good,bad,holdout}/ 每个条目一个文件或目录，月底复盘时
// 从 traces 里挑当月 3 到 5 条好坏样本复制进来（首跑自动建骨架带 README）。

const fs = require('fs');
const path = require('path');
const sync = require('./label_sync');

const TRACES_DIR = process.env.TRACES_DIR || '/data/aira/seo-worker/traces';
const JUDGE_RUNNERS = ['review_plan', 'plan_review', 'release_review'];

function readJsonl(p) {
  const out = [];
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (e) { /* 坏行跳过 */ }
    }
  } catch (e) { /* 无文件 */ }
  return out;
}

function countEntries(dir) {
  try { return fs.readdirSync(dir).filter((f) => !f.startsWith('.') && f !== 'README.md').length; }
  catch (e) { return 0; }
}

function ensureGoldenSkeleton() {
  const g = path.join(TRACES_DIR, 'golden');
  try {
    for (const d of ['good', 'bad', 'holdout']) fs.mkdirSync(path.join(g, d), { recursive: true });
    const readme = path.join(g, 'README.md');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, [
        '# golden 标注集（PLAN W18 T3）',
        '',
        '月底 DEFECTS 复盘时从 ../<client_id>/<job_id>-<type>/ 里挑当月样本，整目录复制进来：',
        '- good/ 判得好或产出好的 trace',
        '- bad/ 翻车的 trace（附一行 why.md 说明哪里错）',
        '- holdout/ 从 good/bad 里随机匀出约三分之一，留作回归集，任何 prompt 优化不许看它',
        '',
        '清扫豁免：trace 日度清扫永不碰本目录。计数进 label_stats 的 Gate D。',
      ].join('\n') + '\n');
    }
  } catch (e) { /* 骨架失败不挡统计 */ }
}

/** trace 目录按 job 类型计数：<traces>/<client>/<jobid>-<type>/ 的目录名后缀即类型。 */
function traceCountsByType() {
  const counts = {};
  try {
    for (const c of fs.readdirSync(TRACES_DIR)) {
      if (c.startsWith('.') || c === 'golden') continue;
      const cdir = path.join(TRACES_DIR, c);
      let names;
      try { names = fs.readdirSync(cdir); } catch (e) { continue; }
      for (const n of names) {
        const m = n.match(/^\d+-(.+)$/);
        if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
      }
    }
  } catch (e) { /* traces 未建 */ }
  return counts;
}

/** Gate A 判定（纯函数，单测用）：override 标签总量与单类型峰值。 */
function gateA(overrides) {
  const perType = {};
  for (const l of overrides) {
    const t = l.fable_verdict || '?';
    perType[t] = (perType[t] || 0) + 1;
  }
  const best = Object.values(perType).reduce((a, b) => Math.max(a, b), 0);
  return { total: overrides.length, perType, open: overrides.length >= 50 && best >= 20 };
}

function fmtGate(name, open, detail) {
  return (open ? '[开] ' : '[关] ') + name + '：' + detail;
}

async function main() {
  const noSync = process.argv.includes('--no-sync');
  if (!noSync) {
    const r = await sync.sync([]);
    console.log('label_sync：新增 ' + r.fresh.length + ' 条\n');
  }
  ensureGoldenSkeleton();

  const all = readJsonl(sync.OUT);
  const history = readJsonl(sync.HISTORY);
  const buckets = { seo: all.filter((l) => l.module !== 'paid'), paid: all.filter((l) => l.module === 'paid') };

  console.log('=== 标签账本 ' + sync.OUT + '（共 ' + all.length + ' 条） ===');
  for (const mod of ['seo', 'paid']) {
    const ls = buckets[mod];
    const bySignal = {};
    for (const l of ls) bySignal[l.signal] = (bySignal[l.signal] || 0) + 1;
    console.log(
      mod + '：' +
      (Object.keys(bySignal).map((k) => k + ' ' + bySignal[k]).join('，') || '无')
    );
  }

  if (history.length) {
    const first = history[0];
    const last = history[history.length - 1];
    const rate = (s) => (s.judged ? ((100 * s.overridden) / s.judged).toFixed(1) + '%' : 'n/a');
    const rateP = (s) => (s.judged_paid ? ((100 * s.overridden_paid) / s.judged_paid).toFixed(1) + '%' : 'n/a');
    console.log('\n推翻率（overridden/judged）：首测 ' + first.at + ' ' + rate(first) + ' -> 最新 ' + last.at + ' ' + rate(last) + '（paid ' + rateP(last) + '，judged ' + last.judged + '）');
  }

  console.log('\n=== Gate 进度 ===');
  for (const mod of ['seo', 'paid']) {
    const a = gateA(buckets[mod].filter((l) => l.signal === 'override'));
    const perType = Object.keys(a.perType).map((k) => k + ' ' + a.perType[k]).join('，') || '无';
    console.log(fmtGate('A judge 校准 ' + mod, a.open, a.total + '/50 配对标签，单类型（' + perType + '）需 >=20'));
  }

  let bOpen = false, bDetail = '标签账本尚无快照';
  if (history.length) {
    const days = Math.floor((Date.now() - new Date(history[0].at + 'T00:00:00Z').getTime()) / 86400000);
    bOpen = days >= 30;
    bDetail = '标签流落地 ' + days + '/30 天（首快照 ' + history[0].at + '）';
  }
  console.log(fmtGate('B ACE 蒸馏升级', bOpen, bDetail));

  const cohortN = buckets.seo.filter((l) => l.signal === 'cohort').length;
  console.log(fmtGate('C 结果层 seo', cohortN > 0, 'cohort 已测批次 ' + cohortN + ' 条（成熟窗 28d，cohort_backtest 在管）'));
  console.log(fmtGate('C 结果层 paid', false, '回测未接线（W18 欠账：cohort_backtest 补 paid 侧，止血类 14d、出价预算类学习期+28d、低量户按转化满 30）'));

  const good = countEntries(path.join(TRACES_DIR, 'golden', 'good'));
  const bad = countEntries(path.join(TRACES_DIR, 'golden', 'bad'));
  const hold = countEntries(path.join(TRACES_DIR, 'golden', 'holdout'));
  const tcounts = traceCountsByType();
  const judgeTraces = JUDGE_RUNNERS.map((t) => t + ' ' + (tcounts[t] || 0)).join('，');
  const aAny = gateA(buckets.seo.filter((l) => l.signal === 'override')).open || gateA(buckets.paid.filter((l) => l.signal === 'override')).open;
  const dOpen = good + bad >= 50 && hold >= 25 && aAny && JUDGE_RUNNERS.some((t) => (tcounts[t] || 0) >= 100);
  console.log(fmtGate('D GEPA prompt 优化', dOpen, 'golden ' + (good + bad) + '/50（good ' + good + '，bad ' + bad + '），holdout ' + hold + '/25，判决 trace（' + judgeTraces + '）需单类 >=100，且 Gate A 先过'));

  console.log('\ntrace 归档：' + TRACES_DIR + '，按类型 ' + (Object.keys(tcounts).map((k) => k + ' ' + tcounts[k]).join('，') || '尚无'));
}

if (require.main === module) {
  main().catch((e) => { console.error('label_stats 中止：' + e.message); process.exit(1); });
}

module.exports = { gateA, traceCountsByType };
