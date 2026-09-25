#!/usr/bin/env node
'use strict';
// 存量卡批文回填（F 刀，2026-09-24 Alvin 批）。
// 背景：「卡反馈折叠自动落批文放行」机制 2026-09-21 才上线（harness foldCards），
// 之前收货的卡有客户表态却没有 cards.tN.outcome 批文 fact，同簇任务也没挂 [backing]，
// 于是顶着「客户批后执行」的帽子空等早已存在的同意（sungait #641 -> #642 实证，等了 15 天）。
// 本工具只补历史欠账，不产新机制：
//   1. 扫任务里有 seo_card_feedback 行、但没有 cards.tN.outcome fact 的卡
//   2. 折叠表态（lib/cardfold，与 harness 同一份确定性规则）
//   3. 有 agree 项的：写 outcome fact + 给同簇未落地任务挂 [backing]
// 默认只出预览清单（零写入），人过目后 --apply 才落。到期视同同意不在本工具范围
// （那是 harness 的活，锚点规则别写两份）。
//
// 用法：SEO_AGENT_TOKEN=<admin jwt> node tools/backfill_card_outcomes.js [--client <id>] [--apply] [--skip-tasks 1,2,3]
//   --client     只跑一个客户，缺省全船队（/board 的全部客户）
//   --apply      真写。缺省预览
//   --skip-tasks 逗号分隔任务 id，这些任务不挂 [backing]（预览里看到不该挂的填这里）

const { foldCardFeedback, summariseFold } = require('../lib/cardfold');

const API = process.env.SEO_API_BASE || 'https://always.horntech-dev.com/seo-api.php';
const TOKEN = process.env.SEO_AGENT_TOKEN || '';
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const ONLY_CLIENT = (() => { const i = argv.indexOf('--client'); return i === -1 ? 0 : parseInt(argv[i + 1], 10) || 0; })();
const SKIP = (() => {
  const i = argv.indexOf('--skip-tasks');
  return i === -1 ? new Set() : new Set(String(argv[i + 1] || '').split(',').map((x) => parseInt(x, 10)).filter(Boolean));
})();
if (!TOKEN) { console.error('用法：SEO_AGENT_TOKEN=... node tools/backfill_card_outcomes.js [--client id] [--apply]'); process.exit(2); }

async function call(method, p, body) {
  const r = await fetch(API + p, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = { raw: t.slice(0, 200) }; }
  if (!r.ok) throw new Error(method + ' ' + p + ' -> ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  return j;
}

// 疑似卡任务：出过卡（card_kind / 反馈时间戳）或名字口径像卡。宁多查一次反馈表也别漏。
function looksLikeCard(t) {
  if (t.card_kind) return true;
  if (t.card_feedback_at || t.card_feedback_done) return true;
  return /方向卡|确认卡|direction|confirmation/i.test(String(t.title || '') + ' ' + String(t.ops || ''));
}

// [backing] 同簇范围：与 harness 词表/mapping 卡分支同一把尺（onpage/content、未落地、
// 没挂过 backing、非博客成稿），存量回填对全部卡型生效，因为跟进任务当年已经建过了，
// 再开新任务只会重复；预览清单供人剔除不该挂的（--skip-tasks）。
function backingScope(all, card) {
  return all.filter((t) => t.id !== card.id
    && ['onpage', 'content'].indexOf(String(t.module || '')) !== -1
    && ['proposed', 'approved', 'review'].indexOf(String(t.status || '')) !== -1
    && String(t.detail || '').indexOf('[backing]') === -1
    && !/blog-draft/.test(String(t.ops || ''))
    && !SKIP.has(Number(t.id)));
}

async function runClient(c) {
  const cid = Number(c.client_id);
  const all = (await call('GET', '/tasks?client_id=' + cid)).tasks || [];
  const facts = (await call('GET', '/facts?client_id=' + cid)).facts || [];
  const haveOutcome = new Set(facts.map((f) => String(f.fact_key || f.key || '')).filter((k) => /^cards\.t\d+\.outcome$/.test(k)));
  let acted = 0;
  for (const card of all.filter(looksLikeCard)) {
    if (haveOutcome.has('cards.t' + card.id + '.outcome')) continue;
    let rows;
    try { rows = (await call('GET', '/card_feedback?task_id=' + card.id)).rows || []; } catch (e) { continue; }
    if (!rows.length) continue;
    const f = foldCardFeedback(rows);
    if (!f.hasAny || (!f.agreed.length && !f.holds.length)) continue;
    // 博客发布卡不回填：publish_blog 的凭证契约是留在 seo_card_feedback 表供 runBlogPublish 查
    if (rows.some((r) => String(r.item) === 'publish_blog')) continue;
    const proxyBy = [...new Set(rows.filter((r) => String(r.actor || '').indexOf('agency:') === 0).map((r) => String(r.actor).slice(7)))];
    const summary = summariseFold(f) + (proxyBy.length ? '。含 agency 代确认（' + proxyBy.join('、') + '）' : '');
    const scope = f.agreed.length ? backingScope(all, card) : [];
    acted++;
    console.log('\n== ' + (c.name || cid) + ' 卡 #' + card.id + '（' + String(card.title || '').slice(0, 46) + '，' + card.status + '）');
    console.log('   折叠：' + summary);
    if (f.holds.length) console.log('   注意 hold 项：' + f.holds.map((x) => x.item).join('、') + '（挂 backing 前想想同簇任务是否正对着 hold 项）');
    for (const x of f.texts) console.log('   客户原话[' + x.item + ']：' + x.text.slice(0, 120).replace(/\n/g, ' '));
    console.log('   将写 fact cards.t' + card.id + '.outcome' + (f.agreed.length ? '，并给 ' + scope.length + ' 个任务挂 [backing]：' + scope.map((t) => '#' + t.id + '(' + String(t.title).slice(0, 18) + ')').join(' ') : '，无 agree 项不挂 backing'));
    if (!APPLY) continue;
    await call('POST', '/facts', {
      client_id: cid, fact_key: 'cards.t' + card.id + '.outcome',
      value: '卡 #' + card.id + '（' + String(card.title || '').slice(0, 40) + '）客户表态：' + summary + '。存量回填（折叠机制 2026-09-21 上线前收货的卡，工具 backfill_card_outcomes）。',
      source: 'client', status: 'confirmed',
    });
    const bk = '[backing] cards.t' + card.id + '.outcome';
    for (const t of scope) await call('PATCH', '/tasks/' + t.id, { detail: String(t.detail || '') + '\n' + bk });
    // 退场标记（2026-09-25 UI 钉卡实证）：note 无 [卡反馈折叠 的卡永远钉人工泳道，回填批文时一并补
    if (String(card.status) === 'done') {
      await call('PATCH', '/tasks/' + card.id, { result_note: String(card.result_note || '') + '\n[卡反馈折叠 存量回填] 批文已落 cards.t' + card.id + '.outcome，生命周期完结退场。', card_feedback_done: 1 });
    }
    console.log('   已写入' + (scope.length ? '，backing 已挂 ' + scope.length + ' 个任务' : ''));
  }
  return acted;
}

(async () => {
  const board = await call('GET', '/board');
  let clients = board.clients || [];
  if (ONLY_CLIENT) clients = clients.filter((c) => Number(c.client_id) === ONLY_CLIENT);
  let total = 0;
  for (const c of clients) {
    try { total += await runClient(c); } catch (e) { console.error((c.name || c.client_id) + ': ' + e.message); }
  }
  console.log('\n' + (APPLY ? '已回填' : '预览（零写入，--apply 才落）') + '：' + total + ' 张卡待补批文。');
})();
