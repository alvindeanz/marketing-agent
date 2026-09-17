#!/usr/bin/env node
'use strict';
// W5 agent harness（2026-08-29 Alvin 定：人不再逐个点按钮）。
// 一个客户从「待拍板」跑到「待放行」：
//   1. 本期 sprint 里有 fable 判决且未过期的任务 → POST /tasks/apply_verdicts（do 排 execute，drop/merge/later 按判决收口）
//   2. 轮询 execute job；方案 lint 打回的任务重排一次（仅一次，且是这次人起跑授权的，不是 cron）
//   3. 队列空了收阻塞：执行失败两次 / 方案里「需要人定」段 / 待判（fable 没判）/ 判决过期 / 待人工验证项
//   4. 阻塞写回看板（任务 attention=1，note 尾部加 [harness] 段）并追加到 PJ 的 TODO.md 批注段
//   5. 打印放行卡链接清单，人只看卡点放行
// 用法：SEO_AGENT_TOKEN=<admin jwt> node tools/harness.js <client_id> [--dry] [--no-todo]
// 硬规矩不破：放行（apply）永远不在这里点；不做也不在这里判（drop 只按 fable 判决）。

const fs = require('fs');
const path = require('path');
const { foldCardFeedback, summariseFold } = require('../lib/cardfold');
const API = process.env.SEO_API_BASE || 'https://always.horntech-dev.com/seo-api.php';
const TOKEN = process.env.SEO_AGENT_TOKEN || '';
const TODO = process.env.MA_TODO || '/data/aira/projects/MA/memory/TODO.md';
const argv = process.argv.slice(2);
const cid = parseInt(argv[0], 10);
const DRY = argv.includes('--dry');
const NO_TODO = argv.includes('--no-todo');
const IDS = (() => { const i = argv.indexOf('--ids'); return i === -1 ? null : String(argv[i + 1] || '').split(',').map((x) => parseInt(x, 10)).filter(Boolean); })();
const SPRINT_ARG = (() => { const i = argv.indexOf('--sprint'); return i === -1 ? '' : String(argv[i + 1] || '').toUpperCase(); })();
const GRACE_DAYS = (() => { const i = argv.indexOf('--card-grace-days'); return i === -1 ? 14 : (parseInt(argv[i + 1], 10) || 14); })();
const POLL_MS = 45000;
const BUDGET_MS = 3 * 60 * 60 * 1000;
if (!cid || !TOKEN) { console.error('用法：SEO_AGENT_TOKEN=... node tools/harness.js <client_id> [--dry] [--no-todo]'); process.exit(2); }

const ts = () => new Date().toISOString().slice(11, 19);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(ts() + ' ' + m);

async function call(method, p, body) {
  const r = await fetch(API + p, { method, headers: { Authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = { raw: t.slice(0, 200) }; }
  if (!r.ok) throw new Error(method + ' ' + p + ' -> ' + r.status + ' ' + JSON.stringify(j).slice(0, 300));
  return j;
}
async function tasks() { const d = await call('GET', '/tasks?client_id=' + cid); return d.tasks || d; }
async function boardClient() {
  const b = await call('GET', '/board');
  return (b.clients || []).find((c) => Number(c.client_id) === cid) || null;
}

/* 从方案 note 里抠「需要人定」段：以该标题起，到下一个 ** 标题或 --- 为止 */
function humanDecisions(note) {
  const n = String(note || '');
  const m = n.match(/\*\*需要人定\*\*\s*([\s\S]*?)(?=\n\*\*|\n---|$)/);
  if (!m) return [];
  return m[1].split('\n').map((s) => s.trim()).filter((s) => /^\d+[.)]|^[-*]/.test(s)).map((s) => s.replace(/^(\d+[.)]|[-*])\s*/, ''));
}

/* 0. 卡反馈折叠（2026-09-13 Alvin 定第一性版）：客户在方向卡上提交过反馈的任务
   card_feedback_at 非空，harness 读到就分岔，不靠 webhook 不靠巡检。放在确认闸之前：
   反馈处理是已发出卡的收口，不该被 onboard 闸挡住。零 LLM：表态折叠是确定性规则
   （lib/cardfold.js），agree 项与文本反馈立跟进任务，POST /tasks 自动排闸A，
   后续走既有 判决 -> 放行 -> 执行 链。到期兜底同在这里：发出超过 --card-grace-days
   （默认 14 天）零反馈的方向卡，按卡上「未回复按建议执行」承诺视同同意。 */
async function foldCards(sprint) {
  const all = await tasks();
  const stamp = () => new Date().toISOString().slice(0, 16).replace('T', ' ');
  for (const card of all.filter((t) => t.card_feedback_at)) {
    const rows = (await call('GET', '/card_feedback?task_id=' + card.id)).rows || [];
    const f = foldCardFeedback(rows);
    if (!f.hasAny) { if (!DRY) await call('PATCH', '/tasks/' + card.id, { card_feedback_done: 1 }); continue; }
    const summary = summariseFold(f);
    log('#' + card.id + ' 卡反馈折叠：' + summary);
    if (DRY) continue;
    // 博客确认卡（publish_blog）不走泛方向卡折叠：agree 的凭证要留在 seo_card_feedback 表里，
    // 供博客任务 apply 时查（runBlogPublish 硬闸）。agree = 发布凭证 = 放行凭证（2026-09-17
    // Alvin 定，撤销 09-15「发布留人工前端」的旧否决）：这里直接 POST /tasks/release 排 apply，
    // runBlogPublish 仍会二次核对 agree，双保险。只有客户写了修改意见才开修订任务。
    // card_feedback_done 只清 card_feedback_at 标记不删表行。
    if (rows.some((r) => String(r.item) === 'publish_blog')) {
      const pub = rows.filter((r) => String(r.item) === 'publish_blog');
      const lastPub = pub[pub.length - 1];
      let revId = null;
      if (f.texts.length) {
        const lines = ['客户对这篇博客的修改意见（逐条处理，改完重新产确认卡再走客户确认）：'];
        for (const x of f.texts) lines.push('- ' + x.text.slice(0, 500));
        lines.push('来源：博客确认卡 #' + card.id + '，表态历史见该任务 note。');
        const r = await call('POST', '/tasks', {
          client_id: cid,
          title: '博客修订：' + String(card.title).replace(/^(\[[^\]]*\]\s*)+/, '').slice(0, 52),
          module: card.module || 'content', sprint, priority: 'P1', owner_type: 'agent',
          detail: lines.join('\n'),
        });
        revId = r.id;
        log('#' + card.id + ' -> 博客修订任务 #' + revId);
      }
      let state;
      if (lastPub.choice === 'agree') {
        state = '客户同意发布，已排 apply 发布';
        try {
          if (String(card.status) === 'review') await call('POST', '/tasks/release', { client_id: cid, task_ids: [card.id] });
          else state = '客户同意发布，但任务不在 review 态（' + card.status + '），未排 apply，需人工看一眼';
        } catch (e) {
          state = '客户同意发布，排 apply 失败：' + (e && e.message ? e.message : e);
        }
        log('#' + card.id + ' ' + state);
      } else if (lastPub.choice === 'hold') {
        state = '客户暂不发布，保持草稿';
      } else {
        state = '客户有修改意见' + (revId ? '，已开修订 #' + revId : '');
      }
      await call('POST', '/facts', { client_id: cid, fact_key: 'cards.t' + card.id + '.outcome', value: '博客确认卡 #' + card.id + '（' + String(card.title).slice(0, 40) + '）：' + summary + (revId ? '。修订 #' + revId : ''), source: 'client', status: 'confirmed' });
      await call('PATCH', '/tasks/' + card.id, { result_note: String(card.result_note || '') + '\n\n[卡反馈折叠 ' + stamp() + '] ' + state, card_feedback_done: 1 });
      continue;
    }
    let followId = null;
    if (f.agreed.length || f.texts.length) {
      const lines = [];
      if (f.agreed.length) {
        lines.push('客户已同意的项，按卡内建议落地（放行按 release_policy 分档，卡：' + (card.output_url || '#' + card.id) + '）：');
        for (const a of f.agreed) lines.push('- ' + a.item + (a.choice === 'flag' && a.fb ? '（勾选：' + a.fb.slice(0, 200) + '）' : ''));
      }
      if (f.holds.length) lines.push('客户要求保持观察不动：' + f.holds.map((x) => x.item).join('、'));
      if (f.texts.length) {
        lines.push('客户文本反馈（逐条处置：是纠偏写 facts，是新需求单独立项，不许留在本任务里烂掉）：');
        for (const x of f.texts) lines.push('- [' + x.item + '] ' + x.text.slice(0, 500));
      }
      lines.push('来源：方向卡 #' + card.id + ' 的客户反馈折叠，表态历史见该任务 note。');
      const r = await call('POST', '/tasks', {
        client_id: cid,
        title: '卡反馈落地：' + String(card.title).replace(/^(\[[^\]]*\]\s*)+/, '').slice(0, 60),
        module: card.module || 'technical', sprint, priority: 'P1', owner_type: 'agent',
        detail: lines.join('\n'),
      });
      followId = r.id;
      log('#' + card.id + ' -> 跟进任务 #' + followId + '，闸A 已排（job ' + (r.review_job_id || '?') + '）');
    }
    await call('POST', '/facts', { client_id: cid, fact_key: 'cards.t' + card.id + '.outcome', value: '方向卡 #' + card.id + '（' + String(card.title).slice(0, 40) + '）客户表态：' + summary + (followId ? '。跟进任务 #' + followId : '。全部保持观察，无跟进'), source: 'client', status: 'confirmed' });
    /* 折叠即收口（2026-09-16 Alvin 定）：卡的使命是收客户表态，表态已折叠、跟进任务
       已接棒（或明确无跟进），卡任务当场置 done(accepted)，不再杵在泳道里等人批。
       博客确认卡不走这里（挂在博客任务上，由发布流程收口）。 */
    await call('PATCH', '/tasks/' + card.id, { status: 'done', result_note: String(card.result_note || '') + '\n\n[卡反馈折叠 ' + stamp() + '] ' + summary + (followId ? '，跟进 #' + followId : '，无需跟进') + '\n[accepted] 客户表态已折叠，卡使命完成，自动收口。', card_feedback_done: 1 });
  }
  // 到期视同同意：只认已标记发出（sent_at）的方向卡，折叠过的不重跑。
  // 锚点是发出时间不是产出时间：卡产出后没发给客户不该开始计时，否则卡还没发就被
  // 误触到期（#145 事故，见 DEFECTS 2026-09-14）。sent_at 由人工前端发卡后 PATCH card_sent 打点。
  const auto = all.filter((t) => t.status === 'review' && !t.card_feedback_at && t.sent_at
    && /方向卡|direction/i.test(String(t.title) + ' ' + String(t.ops || ''))
    && !/\[卡反馈折叠/.test(String(t.result_note || '')));
  for (const card of auto) {
    const sent = String(card.sent_at || '');
    if (!sent) continue;
    const days = (Date.now() - new Date(sent.replace(' ', 'T')).getTime()) / 86400000;
    if (!(days >= GRACE_DAYS)) continue;
    log('#' + card.id + ' 发出 ' + Math.floor(days) + ' 天零反馈，到期视同同意');
    if (DRY) continue;
    const r = await call('POST', '/tasks', {
      client_id: cid,
      title: '卡到期落地（视同同意）：' + String(card.title).replace(/^(\[[^\]]*\]\s*)+/, '').slice(0, 60),
      module: card.module || 'technical', sprint, priority: 'P1', owner_type: 'agent',
      detail: '方向卡 #' + card.id + ' 发出 ' + Math.floor(days) + ' 天无客户反馈，按卡上「未回复将按建议执行」的承诺落地全部建议项。卡：' + (card.output_url || '（无链接，见任务 note）'),
    });
    await call('PATCH', '/tasks/' + card.id, { status: 'done', result_note: String(card.result_note || '') + '\n\n[卡反馈折叠 ' + stamp() + '] 到期（' + Math.floor(days) + ' 天）零反馈视同同意，跟进 #' + r.id + '\n[accepted] 到期视同同意，卡使命完成，自动收口。' });
  }
}

async function main() {
  const bc = await boardClient();
  if (!bc) throw new Error('board 上没有 client ' + cid);
  const sprintEarly = /^S/.test(String(bc.current_sprint)) ? String(bc.current_sprint) : 'S' + bc.current_sprint;
  await foldCards(sprintEarly);
  // 入 sprint 前的两道客户确认闸（2026-09-09 Alvin 定的全局流程：轻链方向卡 → 客户确认关键词 →
  // 客户确认 mapping → 才进 sprint）。证据看 facts：词表确认与 mapping 确认各要一条 confirmed 记录。
  // --skip-gates 显式跳过（如老客户补跑、或本次 --ids 只跑与词表无关的技术项），跳过原因进日志。
  if (!argv.includes('--skip-gates')) {
    const fr = await call('GET', '/facts?client_id=' + cid);
    const facts = (fr.facts || []).filter((f) => String(f.status || '') === 'confirmed');
    // 闸门 false-positive 修复（2026-09-17，playmate/luxelink/sunseeker 实证）：旧正则只要
    // fact_key 含 lock 就算过，被 keywords.lock_state 这类「状态记录」骗过——它们的 key 有 lock，
    // 值却明说「未锁定 / board profile 未锁定 / onboard gap / 词表未锁」。闸门要的是肯定的锁定，
    // 不是名字里带 lock。修法：先排除否定语的状态记录，再要求值里有肯定的锁定/确认信号。
    // 2026-09-17 二次修：光排否定语不够，措辞是「无定稿/未经客户锁定/锁词未定」时 NEG 抓不全
    // 又含「锁定/确认」肯定词，goodie 实测仍误过。根治：*.state / *_state 是「状态记录」不是
    // 「锁定决定」，一律排除出闸门（keywords.state/keywords.lock_state/seo.mapping_state 都是状态）；
    // 闸门只认肯定的锁定 fact（midea keywords.lock_2026_04 / seo.mapping_v1 / badger 客户确认簇）。
    const STATE_KEY = /(^|[._])state($|[._])/i; // 名字里带 state 段的都是状态记录，非锁定
    const NEG = /(未锁|无定稿|未定稿|未确认|无客户确认|没有确认|尚未|未经|留空|待定稿|锁词未定|onboard gap|\bgap\b|not locked|unlocked|内部方向表)/i;
    const POS = /(锁定|已确认|客户确认|定稿|locked|confirmed by|client.confirm)/i;
    const kwOk = facts.some((f) => /^keywords\./.test(f.fact_key) && !STATE_KEY.test(f.fact_key)
      && !NEG.test(String(f.value)) && POS.test(String(f.fact_key) + ' ' + String(f.value)));
    const mapOk = facts.some((f) => /^seo\.(mapping|page_mapping|money_pages)/.test(f.fact_key)
      && !STATE_KEY.test(f.fact_key) && !NEG.test(String(f.value)));
    if (!kwOk || !mapOk) {
      throw new Error('两道确认闸未过：' + (kwOk ? '' : '关键词未经客户确认（缺 keywords.* 的 confirmed 锁定记录）；')
        + (mapOk ? '' : 'mapping 未定稿（缺 seo.mapping* 的 confirmed 记录）；')
        + '流程是 方向卡 → 词表客户确认 → mapping 确认 → sprint。确有理由跳过用 --skip-gates。');
    }
    log('两道确认闸通过：词表已确认、mapping 已定稿');
  } else {
    log('注意：--skip-gates 跳过词表与 mapping 确认闸，理由自负');
  }
  /* 「本期」是推导值不是存量值（2026-09-17，midea S1 实证：板上指针 S2、plan v2 任务标 S1，
     默认口径一条都扫不到，只能 --ids 硬点）。推导规则：未结任务（proposed/approved/blocked）
     里最小的 S 号就是本期；两处真相只留一处，板上 current_sprint 降级为无未结任务时的兜底。
     人要强指用 --sprint SN。 */
  const boardSprint = /^S/.test(String(bc.current_sprint)) ? String(bc.current_sprint) : 'S' + bc.current_sprint;
  let sprint = boardSprint;
  if (SPRINT_ARG) {
    sprint = SPRINT_ARG;
    log('本期由 --sprint 指定为 ' + sprint);
  } else {
    const openNums = (await tasks())
      .filter((t) => ['proposed', 'approved', 'blocked'].includes(t.status))
      .map((t) => { const m = /^S(\d+)$/i.exec(String(t.sprint || '')); return m ? parseInt(m[1], 10) : null; })
      .filter((n) => n !== null);
    if (openNums.length) {
      sprint = 'S' + Math.min.apply(null, openNums);
      if (sprint !== boardSprint) log('本期推导为 ' + sprint + '（未结任务最小期），板上指针 ' + boardSprint + ' 仅作展示，建议对齐');
    }
  }
  log(`${bc.name}（${cid}）本期 ${sprint}` + (IDS ? '，只处理 #' + IDS.join(' #') : ''));
  /* --ids：跨 sprint 指定任务，本次运行把「本期」的口径换成这批 id */
  const inScope = (t) => (IDS ? IDS.includes(t.id) : t.sprint === sprint);

  // 0.4 later 存量挪期（2026-09-17）：apply_verdicts 的挪期分支只管新落的判决，规则上线前
  // 已判 later 的 review 态任务会一直留在本期占泳道（run_20260917-0324 七条实证）。这里补扫：
  // 本期 review+later 一律挪下一期，产出与判决保留，到期随下期自然进放行流程。只在整期
  // 口径下扫（--ids 指定任务时不动别的任务）。
  if (!IDS) {
    const allNow = await tasks();
    const laterStuck = allNow.filter((t) => t.status === 'review' && t.sprint === sprint
      && String(t.review_effective || t.review_verdict || '') === 'later');
    for (const t of laterStuck) {
      const m = /^S(\d)$/i.exec(String(t.sprint || ''));
      if (!m) continue;
      const next = 'S' + Math.min(parseInt(m[1], 10) + 1, 9);
      if (DRY) { log('#' + t.id + ' later 存量，would 挪 ' + next); continue; }
      await call('PATCH', '/tasks/' + t.id, { sprint: next, result_note: String(t.result_note || '') + '\n[later] 存量挪期到 ' + next + '（判决与产出保留，到期随下期进放行流程）' });
      log('#' + t.id + ' later 存量，挪 ' + next);
    }
  }

  // 0.5 本期还没有判决的任务（含 later 自动挪期后清了判决的）先排一轮闸A，判完再拍板。
  // 2026-09-16 Alvin 定：stale 判决（老 plan 时代判的、detail 或事实已变）一并自动重判，
  // 别让换挡后的新当期卡在「待拍板」（Apollo S3 与 Louvresky S4 两例实证；fable 批量判决
  // 一个 job 万级 token，成本可忽略）。
  let all = await tasks();
  const noVerdict = all.filter((t) => inScope(t)
    && !t.review_pending && !(t.job_state && t.job_state.status)
    && ((t.status === 'proposed' && !t.review_effective)
      // approved+agent 从未判决的也要排闸A（2026-09-17：转位 PATCH 后这类任务落在
      // 「approved 且无判决」的组合上，旧过滤两个分支都接不住，只能人工重排）
      || (t.status === 'approved' && t.owner_type === 'agent' && !t.review_effective)
      || (['proposed', 'approved'].includes(t.status) && t.owner_type === 'agent'
        && t.review_effective && t.review_stale))).map((t) => t.id);
  const pendingNow = all.filter((t) => inScope(t) && t.review_pending).map((t) => t.id);
  if ((noVerdict.length || pendingNow.length) && !DRY) {
    if (noVerdict.length) {
      const r = await call('POST', '/tasks/review', { client_id: cid, task_ids: noVerdict.slice(0, 20) });
      log('本期 ' + noVerdict.length + ' 条无判决，已排闸A（job ' + (r.job_id || '?') + '），等判定');
    }
    for (const id of pendingNow) if (!noVerdict.includes(id)) noVerdict.push(id);
    if (pendingNow.length) log('另有 ' + pendingNow.length + ' 条判定在飞，一并等');
    const t1 = Date.now();
    for (;;) {
      await sleep(20000);
      all = await tasks();
      const pending = all.filter((t) => noVerdict.includes(t.id) && !t.review_effective);
      if (!pending.length) break;
      if (Date.now() - t1 > 15 * 60 * 1000) { log('判定超 15 分钟未齐，先拍已有判决的'); break; }
    }
  }

  // 1. 拍板：本期、有判决、未过期、还没动过的
  const verdictIds = all.filter((t) => inScope(t) && ['proposed', 'approved', 'blocked'].includes(t.status)
    && t.review_effective && !t.review_stale && !t.review_pending && !(t.job_state && t.job_state.status)
    && !(t.status === 'approved' && t.owner_type !== 'agent')).map((t) => t.id);
  if (verdictIds.length) {
    log('按判决处置 ' + verdictIds.length + ' 条：' + verdictIds.join(' '));
    if (!DRY) {
      const r = await call('POST', '/tasks/apply_verdicts', { client_id: cid, task_ids: verdictIds });
      log('apply_verdicts -> ' + JSON.stringify(r.done) + ' jobs ' + JSON.stringify(r.job_ids) + (r.skipped.length ? ' skipped ' + JSON.stringify(r.skipped) : ''));
    }
  } else {
    // 空拍板必须给逐条原因（2026-09-17 midea S1：连续三跑只说「没有可拍板」，真凶是
    // sprint 错位，却被误诊成判决时效，白烧了一次 fable 重判。无声失败禁止再犯。）
    log('没有可拍板的任务，未结任务逐条原因：');
    const open = all.filter((t) => ['proposed', 'approved', 'blocked', 'review'].includes(t.status));
    if (!open.length) log('  （没有未结任务）');
    for (const t of open.slice(0, 25)) {
      const why = [];
      if (!inScope(t)) why.push('不在本期（任务 ' + (t.sprint || '无标签') + '，本期口径 ' + (IDS ? '--ids' : sprint) + '）');
      else {
        if (t.status === 'review') why.push('已出方案，在放行/发卡阶段');
        if (t.review_pending) why.push('判定中');
        else if (!t.review_effective) why.push('无判决（应已被 0.5 段排闸A，若反复出现是 bug）');
        else if (t.review_stale) why.push('判决过期');
        if (t.job_state && t.job_state.status) why.push('有 job 在册（' + t.job_state.status + '）');
        if (t.status === 'approved' && t.owner_type !== 'agent') why.push('人工位（owner=' + t.owner_type + '）');
        if (!why.length) why.push('条件全过但未入选，检查过滤器逻辑');
      }
      log('  #' + t.id + ' ' + why.join('；'));
    }
    if (open.length > 25) log('  …另有 ' + (open.length - 25) + ' 条未列');
  }
  if (DRY) { await report(await tasks(), sprint, {}); return; }

  // 2. 等 execute 跑完；lint 打回重排一次
  const retried = {};
  const t0 = Date.now();
  for (;;) {
    await sleep(POLL_MS);
    all = await tasks();
    const mine = all.filter(inScope);
    const running = mine.filter((t) => t.human_state === 'running');
    const lintFailed = mine.filter((t) => t.human_state === 'wait_me' && /lint 未过/.test(t.fail_reason || '') && !retried[t.id]);
    for (const t of lintFailed) {
      retried[t.id] = true;
      const r = await call('POST', '/tasks/' + t.id + '/decide', { yes: true, note: 'harness：方案 lint 打回，重出一次' });
      log('#' + t.id + ' lint 打回，重排 -> job ' + JSON.stringify(r.job_ids));
    }
    if (!running.length && !lintFailed.length) break;
    log('在跑 ' + running.map((t) => '#' + t.id + '(' + t.run_note + ')').join(' '));
    if (Date.now() - t0 > BUDGET_MS) { log('超过 3 小时预算，先收口'); break; }
  }
  await report(await tasks(), sprint, retried);
  /* 收尾：把人推翻的判决与打回的方案抓进经验层，零 LLM */
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('node', [require('path').join(__dirname, 'experience_sync.js'), String(cid)], { env: process.env, timeout: 120000 }).toString().trim();
    log('experience_sync：' + out.split('\n')[0]);
  } catch (e) { log('experience_sync 失败（不影响本次）：' + String(e.message).slice(0, 120)); }
}

async function report(all, sprint, retried) {
  const mine = all.filter((t) => (IDS ? IDS.includes(t.id) : t.sprint === sprint));
  const blockers = [];
  const ready = [];
  for (const t of mine) {
    if (t.status === 'review') {
      const pv = (String(t.result_note || '').match(/预览: (\S+)/) || [])[1] || t.output_url || '';
      ready.push({ id: t.id, title: t.title, preview: pv });
      for (const q of humanDecisions(t.result_note)) blockers.push({ id: t.id, kind: '需要人定', text: q });
      // note 每轮追加一段「要点」，配图计数取最后一次出现的
      const imgAll = [...String(t.result_note || '').matchAll(/配图 (\d+)\/(\d+)/g)];
      const img = imgAll.length ? imgAll[imgAll.length - 1] : null;
      if (img && Number(img[1]) < Number(img[2])) blockers.push({ id: t.id, kind: '待人工配图', text: '配图 ' + img[1] + '/' + img[2] + '，缺 ' + ((String(t.result_note).match(/缺 ([^（。]+?)待人工配图/) || [])[1] || '').trim() });
      if (t.manual_pending) blockers.push({ id: t.id, kind: '待人工验证', text: (t.manual_checks || []).filter((c) => !c.done).map((c) => c.text || c).join('；') });
      continue;
    }
    if (t.human_state !== 'wait_me') continue;
    if (t.fail_reason) blockers.push({ id: t.id, kind: retried[t.id] ? '重排后仍失败' : '执行失败', text: t.fail_reason });
    else if (t.review_pending) blockers.push({ id: t.id, kind: '待判', text: 'fable 还没判' });
    else if (t.review_stale) blockers.push({ id: t.id, kind: '判决过期', text: 'facts 更新后需重判' });
    else if (!t.review_effective) blockers.push({ id: t.id, kind: '无判决', text: '没有 fable 判决，需先跑 review' });
    else if (t.owner_type !== 'agent' && t.status === 'approved') blockers.push({ id: t.id, kind: '人工任务', text: 'owner=' + t.owner_type + '，机器不执行，等人做' });
  }

  // 写回看板：attention + note 尾部 [harness] 段（同任务多条合并）
  const byTask = {};
  for (const b of blockers) (byTask[b.id] = byTask[b.id] || []).push(b);
  for (const [id, list] of Object.entries(byTask)) {
    const t = mine.find((x) => x.id === Number(id));
    const block = '\n\n[harness ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + '] 阻塞：\n' + list.map((b) => '- ' + b.kind + '：' + b.text).join('\n');
    const note = String(t.result_note || '');
    if (note.includes('[harness ') && list.every((b) => note.includes(b.text))) continue;
    if (!DRY) await call('PATCH', '/tasks/' + id, { attention: 1, result_note: note + block });
  }

  // 输出
  console.log('\n## 放行卡（' + ready.length + '）');
  for (const r of ready) console.log('- #' + r.id + ' ' + r.title + (r.preview ? ' ' + r.preview : ''));
  console.log('\n## 阻塞与待人定（' + blockers.length + '）');
  for (const b of blockers) console.log('- #' + b.id + ' ' + b.kind + '：' + b.text);

  // 能力重绑定候选（2026-09-17，midea S1 实证：plan 是车道接通前建的，12 条全落人工位，
  // 车道通了没人发现，只能人肉逐条 PATCH。原则：owner 位是建计划时的快照，能力表是活的，
  // 每次 harness 跑都要把「人工位存量 × 已接通车道」摆到人眼前。只提示不自动转：
  // 转位即 mandate（policy mandate_doc），必须人说了算。）
  try {
    const caps = require('../lib/capabilities');
    const bcNow = await boardClient();
    const manifest = caps.loadManifest(String((bcNow && bcNow.platform) || ''));
    if (manifest.found) {
      const cands = all.filter((t) => ['proposed', 'approved', 'blocked'].includes(t.status)
        && String(t.owner_type || '') === 'agency');
      if (cands.length) {
        console.log('\n## 转位候选（' + cands.length + '，平台 ' + manifest.platform + ' 车道已接通，人工位存量建议逐条决定转或留）');
        for (const t of cands.slice(0, 15)) console.log('- #' + t.id + ' [' + (t.sprint || '无期') + '] ' + t.title);
        if (cands.length > 15) console.log('- …另有 ' + (cands.length - 15) + ' 条');
        console.log('  转位：node tools/machine_run.js ' + cid + ' <id[:ops[:module]],...> --reason "..."（转完 harness 会自动重判再拍板）');
      }
    }
  } catch (e) { log('转位候选段跳过：' + e.message); }

  // 追加到 TODO.md 批注段
  if (!NO_TODO && !DRY && fs.existsSync(TODO)) {
    const s = fs.readFileSync(TODO, 'utf8');
    const head = '## 批注（手写）';
    const i = s.indexOf(head);
    if (i !== -1) {
      const bc = await boardClient();
      const stamp = new Date().toISOString().slice(0, 10);
      const lines = ['', `- [harness ${stamp}] ${bc ? bc.name : cid}：待放行 ${ready.length} 条${blockers.length ? '；阻塞 ' + blockers.length + ' 条：' + blockers.map((b) => '#' + b.id + ' ' + b.kind).join('、') : '，无阻塞'}`];
      const j = s.indexOf('\n', s.indexOf('\n', i) + 1); // 跳过标题行和说明行
      const out = s.slice(0, j) + lines.join('\n') + s.slice(j);
      fs.writeFileSync(TODO, out);
      log('已写 TODO.md 批注段');
    }
  }
}

main().catch((e) => { console.error(ts() + ' harness 中止：' + e.message); process.exit(1); });
