'use strict';
/* 复验扫帚的判定核（2026-11-03 Alvin 批）。零 LLM 纯函数，harness 每轮调用。
 *
 * 背景：apply 收口 note 里的「待复验 N 项（…）」靠 manual_done_at 盖章出口，
 * 成功收口（POST /tasks/{id}/complete）有分流路由（数据类归回测、人工类拆 verify 单），
 * 但失败的 apply 只写 note 不走 complete，复验旗挂板上没人收（BensNZ #114 挂 42 天实证）。
 * 检查项是申报式（name+note），不可机械重跑，所以本扫帚只做两类有凭据的确定性收口，
 * 其余带证据摘要升给人：
 *
 * 1. void：全史零落地判不适用。凭据是账本与 changeset，不是模型申报——
 *    条目账本（变更真相源）无 landed/verified 行，且 note 里每一条 changeset 行都是
 *    「（0 文件）」（worker 收尾对账平台清单后写的零模型记录）。两证齐才判。
 *    只看最后一轮会误杀：Sammichelle #311 第一轮落了 15 文件、重试轮 changeset 0 文件，
 *    它的 V6（等 #309 人工完成后核对）必须活着。全史判据下它受保护。
 * 2. backtest：数据类复验归回测管道。全部待复验项都是数据口径（位次/CTR/第 N 天复核…），
 *    且任务已 done、note 带 [applied]（cohort_backtest 的收件判据，照抄不另造），
 *    回测管道满 28 天窗自动测，复验旗可以收口。
 *
 * 误杀出口：manual_done 盖章会在 note 留 [复验扫帚] 标，人翻案时在 note 追注并按需
 * 另建 verify 工单；命中台账 = harness 轮输出逐条打印 + note 标。
 */

const DATA_RE = /GSC|位次|观察|复测|数据|CTR|排名|流量|第\s*\d+\s*天[^，。]*复核/i;

/** 与服务端 manual_checks_of 同口径：最后一条「检查:」行的待复验/待人工项。 */
function pendingItems(note) {
  const all = [];
  const re = /检查:[^\n]*待(?:人工|复验) (\d+) 项(?:（([^）]*)）)?/g;
  let m;
  while ((m = re.exec(String(note || ''))) !== null) all.push(m);
  if (!all.length) return [];
  const last = all[all.length - 1];
  const n = parseInt(last[1], 10) || 0;
  if (n <= 0) return [];
  const raw = (last[2] || '').trim();
  if (!raw) return new Array(n).fill('（未命名检查项）');
  return raw.split(/[、,，]/).map((s) => s.trim()).filter(Boolean);
}

/** note 里每一条 changeset 行的文件数（全史，不是只看最后一轮）。 */
function changesetFileCounts(note) {
  const out = [];
  const re = /changeset: \S+（(\d+) 文件/g;
  let m;
  while ((m = re.exec(String(note || ''))) !== null) out.push(parseInt(m[1], 10) || 0);
  return out;
}

/**
 * 判定一条 manual-pending 任务怎么收。
 * 入参全部是硬凭据：ledgerStates = GET /tasks/{id}/items 各行 state；
 * note = result_note 原文；status = 任务状态。
 * 返回 { action: 'void'|'backtest'|'report', reason }
 */
function decide({ note, ledgerStates, status }) {
  const items = pendingItems(note);
  if (!items.length) return { action: 'none', reason: '无待复验项' };
  const cs = changesetFileCounts(note);
  const landed = (ledgerStates || []).filter((s) => s === 'landed' || s === 'verified').length;
  if (cs.length > 0 && cs.every((n) => n === 0) && landed === 0) {
    return {
      action: 'void',
      reason: '全史零落地：' + cs.length + ' 轮 changeset 全部 0 文件，条目账本 landed/verified 0 行，没有上线过的变更可复核',
    };
  }
  const allData = items.every((it) => DATA_RE.test(it));
  if (allData && String(status) === 'done' && /\[applied\]/.test(String(note || ''))) {
    return {
      action: 'backtest',
      reason: '全部 ' + items.length + ' 项为数据口径复验，任务已 done 且带 [applied]，cohort_backtest 满 28 天窗自动测',
    };
  }
  return {
    action: 'report',
    reason: '落地 ' + landed + ' 行 / changeset ' + (cs.join('+') || '无') + ' 文件，复验项含人工口径，升人处理',
  };
}

module.exports = { pendingItems, changesetFileCounts, decide, DATA_RE };
