#!/usr/bin/env node
'use strict';
/* 能力广播（2026-10-20 Alvin 定，review_glue_failures_2026-10-20.md 第三部分）。
   第一性：能力清单是唯一事实源，任务文本里的能力断言是写入时为真的缓存；登记新 op 必须是
   一个会叫醒全舰队的事件，否则缓存永不失效（#813 修了清单、#1310 原样复发的根因）。
   做什么：给定一个已登记的 op，扫全部 active 客户未结任务的 detail / review_reason /
   result_note，命中旧能力断言的在 detail 盖 [capability-update] 章。盖章改 detail 即改
   review_text_hash，旧判决自然过期（review_stale），下轮 harness 0.5 段自动重判吃新事实；
   owner=agency 的翻位仍归 capgap 收编扫帚（政策表口径），这里不抢它的活。
   零 LLM，只走 admin API，不碰部署。登记新 op 的流程里跑它（见 CLAUDE.md 部署节）。

   用法：SEO_AGENT_TOKEN=... node tools/capability_broadcast.js --op <name> [--apply] [--wide]
     默认 dry-run 只列命中。--apply 盖「强命中」（文本点名该 op 或标准措辞「缺执行器 <op>」）。
     --wide 连「泛能力断言」（平台能力清单无/没有已注册 op/能力缺口 等措辞，且客户平台与该
     op 所属清单一致）一起盖。泛断言不点名 op，机器只能确认平台对得上，盖前人眼扫一遍清单。 */
const path = require('path');
const { matchCapabilityClaim } = require('../lib/capclaim');
const capabilities = require(path.join(__dirname, '..', 'lib', 'capabilities'));

const API = process.env.SEO_API_BASE || 'https://always.horntech-dev.com/seo-api.php';
const TOKEN = process.env.SEO_AGENT_TOKEN || '';
const argv = process.argv.slice(2);
const OP = (() => { const i = argv.indexOf('--op'); return i === -1 ? '' : String(argv[i + 1] || '').trim(); })();
const APPLY = argv.includes('--apply');
const WIDE = argv.includes('--wide');
if (!TOKEN || !OP) { console.error('用法：SEO_AGENT_TOKEN=... node tools/capability_broadcast.js --op <name> [--apply] [--wide]'); process.exit(2); }

async function call(method, p, body) {
  const r = await fetch(API + p, {
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = {}; }
  if (!r.ok) throw new Error(method + ' ' + p + ' -> ' + r.status + ' ' + t.slice(0, 120));
  return j;
}

(async () => {
  // op 必须真的已登记，广播一个不存在的能力比不广播更糟
  const PLATFORMS = ['webforger', 'shopify', 'wordpress', 'googleads'];
  const homes = PLATFORMS.filter((p) => capabilities.operationNames(p).includes(OP));
  if (!homes.length) { console.error('op「' + OP + '」不在任何平台能力清单里，先登记再广播'); process.exit(2); }
  let policyClass = '';
  try { policyClass = (require(path.join(__dirname, '..', 'specs', 'release_policy.json')).risk_class_by_op || {})[OP] || ''; } catch (e) { /* 政策表读不到不挡广播，提示人 */ }
  if (!policyClass) console.error('提醒：op「' + OP + '」不在 release_policy.json 风险表（capgap 收编扫帚认不到它），建议同 commit 补登记');
  console.log('op ' + OP + ' 所属清单：' + homes.join(',') + (policyClass ? '（risk: ' + policyClass + '）' : ''));

  const clients = (await call('GET', '/clients')).clients.filter((c) => c.status === 'active');
  const stamp = '\n[capability-update ' + new Date().toISOString().slice(0, 10) + '] ' + OP
    + ' 已登记 ' + homes.join('/') + ' 能力清单' + (policyClass ? '（risk: ' + policyClass + '）' : '')
    + '，本任务文本里的能力断言以清单为准，旧判决作废，下轮重判按清单重验前置条件。';
  let strong = 0, wide = 0, stamped = 0;
  for (const c of clients) {
    const plat = capabilities.slugPlatform(c.platform);
    const ts = (await call('GET', '/tasks?client_id=' + c.client_id)).tasks || [];
    for (const t of ts) {
      if (t.status === 'done') continue;
      if (String(t.result_note || '').includes('[capability-update') && new RegExp('\\] ' + OP + ' ').test(String(t.result_note || ''))) continue; /* 已广播过的不重复盖 */
      if (String(t.detail || '').includes('[capability-update') && new RegExp('\\] ' + OP + ' ').test(String(t.detail || ''))) continue;
      const hit = matchCapabilityClaim({ detail: t.detail, review_reason: t.review_reason, result_note: t.result_note }, OP, { platformMatches: homes.includes(plat) });
      if (!hit) continue;
      if (hit === 'strong') strong++; else wide++;
      const doStamp = APPLY && (hit === 'strong' || (WIDE && hit === 'wide'));
      console.log((doStamp ? '[盖章] ' : '[命中] ') + c.name + ' #' + t.id + ' (' + hit + '/' + (t.status || '') + '/' + (t.owner_type || '') + ') ' + String(t.title || '').slice(0, 44));
      if (doStamp) {
        await call('PATCH', '/tasks/' + t.id, { detail: String(t.detail || '') + stamp });
        stamped++;
      }
    }
  }
  console.log('强命中 ' + strong + '，泛断言 ' + wide + '，已盖章 ' + stamped + (APPLY ? '' : '（dry-run，--apply 盖强命中，--wide 连泛断言）'));
})().catch((e) => { console.error('capability_broadcast 失败：' + e.message); process.exit(1); });
