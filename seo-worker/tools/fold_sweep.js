#!/usr/bin/env node
'use strict';
// fold_sweep：卡片收口日扫（2026-09-24 Alvin 批：卡完成了就该标完成，不等 harness 顺路）。
// 零 LLM。补的是卡生命周期缺的那一环：客户点完卡到下一轮 harness 之间的不定长空窗。
//
// 扫描口径：card_feedback_at 非空（有反馈未折叠）且最后一条反馈已安静满 --quiet-hours
// （默认 24，防抢跑：客户常下午点一轮傍晚再点一轮，sungait #641 实证）。
// 分流（硬规矩 1：cron 不得触发 LLM，建任务会连带排闸A判定，所以本工具永不建任务）：
//   1. 纯 hold / 无 agree 无追问 → 当场收口：写 outcome fact + 卡置 done + 清反馈标记。零 LLM 全闭环。
//   2. 有 agree 或有文本追问（折叠时要建跟进任务）→ 不动状态，标 attention=1 加 [fold_sweep] note
//      亮进红点与清理队列，折叠建单留给下轮 harness（人触发）。窗口从「隐形」变「点名可见」。
//   3. 博客确认卡（publish_blog 项）整个跳过：凭证契约要求反馈行留给 runBlogPublish 硬闸，
//      且 agree 即排发布 apply，都不是 cron 该碰的。
//
// 用法：node tools/fold_sweep.js [--dry] [--quiet-hours 24] [--client <id>]
// token：SEO_AGENT_TOKEN 环境变量，缺省读 /data/aira/.secrets/ma_skill.jwt（cron 行不放密钥）。
// cron：每日 20:00 UTC（NZ 上午），与周日巡检家族错开。

const fs = require('node:fs');
const { foldCardFeedback, summariseFold } = require('../lib/cardfold');

const API = process.env.SEO_API_BASE || 'https://always.horntech-dev.com/seo-api.php';
const TOKEN = (process.env.SEO_AGENT_TOKEN || (() => {
  try { return fs.readFileSync('/data/aira/.secrets/ma_skill.jwt', 'utf8').trim(); } catch (e) { return ''; }
})());
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const QUIET_H = (() => { const i = argv.indexOf('--quiet-hours'); return i === -1 ? 24 : (parseFloat(argv[i + 1]) || 24); })();
const ONLY_CLIENT = (() => { const i = argv.indexOf('--client'); return i === -1 ? 0 : parseInt(argv[i + 1], 10) || 0; })();
if (!TOKEN) { console.error('缺 SEO_AGENT_TOKEN 且读不到 /data/aira/.secrets/ma_skill.jwt'); process.exit(2); }

const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');

async function call(method, p, body) {
  const r = await fetch(API + p, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = { raw: t.slice(0, 200) }; }
  if (!r.ok) throw new Error(method + ' ' + p + ' -> ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  return j;
}

function hoursSince(mysqlTs) {
  const t = new Date(String(mysqlTs).replace(' ', 'T') + (String(mysqlTs).indexOf('Z') === -1 ? 'Z' : ''));
  return (Date.now() - t.getTime()) / 3600000;
}

async function runClient(c) {
  const cid = Number(c.client_id);
  const all = (await call('GET', '/tasks?client_id=' + cid)).tasks || [];
  const out = [];
  for (const card of all.filter((t) => t.card_feedback_at && t.status !== 'done')) {
    let rows;
    try { rows = (await call('GET', '/card_feedback?task_id=' + card.id)).rows || []; } catch (e) { continue; }
    if (!rows.length) continue;
    if (rows.some((r) => String(r.item) === 'publish_blog')) { out.push('#' + card.id + ' 博客确认卡，跳过（凭证契约归发布闸）'); continue; }
    const last = rows[rows.length - 1];
    const quiet = hoursSince(last.created_at);
    if (quiet < QUIET_H) { out.push('#' + card.id + ' 最后反馈仅 ' + quiet.toFixed(1) + 'h，未满安静期 ' + QUIET_H + 'h，下轮再看'); continue; }
    const f = foldCardFeedback(rows);
    if (!f.hasAny) continue;
    const needsFollowUp = f.agreed.length > 0 || f.texts.length > 0;
    const summary = summariseFold(f);
    if (needsFollowUp) {
      // 折叠要建跟进任务（建任务连带排判定 = LLM），cron 只点名不动手。
      const already = String(card.result_note || '').indexOf('[fold_sweep]') !== -1;
      out.push('#' + card.id + ' 反馈已齐（安静 ' + quiet.toFixed(0) + 'h）：' + summary + ' -> ' + (already ? '已点名过，等 harness' : (DRY ? '将标 attention 点名' : '标 attention 点名，折叠留 harness')));
      if (DRY || already) continue;
      await call('PATCH', '/tasks/' + card.id, {
        attention: 1,
        result_note: String(card.result_note || '') + '\n[fold_sweep ' + stamp() + '] 客户反馈已齐且安静满 ' + QUIET_H + ' 小时（' + summary + '），待下轮 harness 折叠建跟进；cron 不建任务（硬规矩 1）。',
      });
      continue;
    }
    // 纯 hold：无跟进要建，零 LLM 全闭环收口。
    out.push('#' + card.id + ' 纯保持观察（' + summary + '）-> ' + (DRY ? '将收口' : '收口 done + outcome fact'));
    if (DRY) continue;
    await call('POST', '/facts', {
      client_id: cid, fact_key: 'cards.t' + card.id + '.outcome',
      value: '卡 #' + card.id + '（' + String(card.title || '').slice(0, 40) + '）客户表态：' + summary + '。无跟进项，fold_sweep 收口。',
      source: 'manual', status: 'confirmed',
    });
    await call('PATCH', '/tasks/' + card.id, {
      status: 'done',
      result_note: String(card.result_note || '') + '\n[卡反馈折叠 fold_sweep ' + stamp() + '] ' + summary + '，全部保持观察无跟进，卡使命完成自动收口。',
      card_feedback_done: 1,
    });
  }
  return out;
}

(async () => {
  const board = await call('GET', '/board');
  let clients = board.clients || [];
  if (ONLY_CLIENT) clients = clients.filter((c) => Number(c.client_id) === ONLY_CLIENT);
  let lines = 0;
  console.log('===== fold_sweep ' + stamp() + (DRY ? '（dry）' : '') + ' 安静期 ' + QUIET_H + 'h =====');
  for (const c of clients) {
    try {
      const out = await runClient(c);
      if (out.length) { console.log('-- ' + (c.name || c.client_id)); for (const l of out) console.log('   ' + l); lines += out.length; }
    } catch (e) { console.log('-- ' + (c.name || c.client_id) + ': ' + e.message); lines++; }
  }
  if (!lines) console.log('全船队没有待收口的卡反馈，干净。');
})();
