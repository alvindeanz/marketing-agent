'use strict';
/* 方向卡客户反馈折叠（2026-09-13 Alvin 定第一性版：反馈翻任务状态，harness 读状态分岔）。
   输入 seo_card_feedback 的行（按 id 升序即时间序），输出：
     agreed     每个决策项的最终表态是 agree 或 flag（flag 带勾选清单在 fb 里），可以落地
     holds      最终表态是 hold，记观察不动账户
     texts      other 的文本反馈，全部保留（不是表态是话，每条都要有人接）
     attention  需要人看一眼的项（驳回、未识别码），调用方据此打 attention 不静默收口
     hasStance  有没有任何可折叠的表态或文本；hasAny 为真而 hasStance 为假 = 有行但全是折不动的码
   规则：同一 item 多次表态取最后一次（客户改主意以最新为准）；other 不覆盖表态，
   只进 texts；没有 item 的表态归入 _card（整卡态度）。
   2026-10-19 防御性映射（card_data v1 桥侧，口径见 specs/report/card_data_v1.md「与账本、折叠的关系」）：
     approve 视同 agree；reject 视同 hold，理由进 texts 并进 attention（驳回理由不许丢）；
     其余非空码（自定义码、未来新码）不当表态，原样进 texts 并进 attention，不再静默丢弃。
     账本不归一，存的是客户实际点的码；归一只在这里发生。
   opts.decode：item => { code => label } 解码表（GET /asks/{id} 的 decode）。flag 行的 fb 是逗号拼接的值，
     v1 卡与 WF 落的是 code，旧 HTML 卡落的是词面；表里有的 code 还原成 label，表里没有的原样保留，
     两种落账形态同一套逻辑处理，codes 字段留原值供审计。
   opts.byAnsweredAt：行带 at_utc（GET /asks/{id} 账本行）时按作答时刻排序，同刻按 id；
     与 seo-api asks_fold_effective 带 offset 时的排序同口径。缺 at_utc 的行集合退回 id 序。 */
const DEFENSIVE = { approve: 'agree', reject: 'hold' };
function orderRows(rows, byAnsweredAt) {
  const list = (rows || []).slice();
  if (byAnsweredAt && list.length && list.every((r) => r && r.at_utc)) {
    return list.sort((a, b) => (a.at_utc < b.at_utc ? -1 : a.at_utc > b.at_utc ? 1 : Number(a.id) - Number(b.id)));
  }
  return list;
}
function decodeFlag(fb, table) {
  const codes = String(fb || '').split(/\s*,\s*/).map((x) => x.trim()).filter(Boolean);
  const labels = codes.map((c) => (table && Object.prototype.hasOwnProperty.call(table, c) && table[c] ? table[c] : c));
  return { codes, labels };
}
function foldCardFeedback(rows, opts) {
  const o = opts || {};
  const decode = o.decode && typeof o.decode === 'object' ? o.decode : null;
  const byItem = new Map();
  const texts = [];
  const attention = [];
  for (const r of orderRows(rows, o.byAnsweredAt)) {
    const item = String(r.item || '').trim() || '_card';
    const raw = String(r.choice || '');
    const at = r.at_utc || r.created_at || '';
    const fbRaw = String(r.fb || '');
    if (raw === 'other') {
      const t = fbRaw.trim();
      if (t) texts.push({ item, text: t, at });
      continue;
    }
    if (raw === '') continue;
    const choice = DEFENSIVE[raw] || raw;
    if (choice === 'agree' || choice === 'hold' || choice === 'flag') {
      const v = { item, choice, fb: fbRaw, at };
      if (choice === 'flag') {
        const d = decodeFlag(fbRaw, decode && decode[item]);
        v.codes = d.codes;
        if (d.labels.some((x, i) => x !== d.codes[i])) v.fb = d.labels.join(', '); // 有解码才改写，旧 HTML 词面原样
      }
      if (DEFENSIVE[raw]) v.mapped_from = raw;
      byItem.set(item, v);
      if (raw === 'reject') {
        const t = fbRaw.trim();
        texts.push({ item, text: '驳回' + (t ? '：' + t : '（未附理由）'), at });
        attention.push({ item, reason: 'reject' });
      }
      continue;
    }
    texts.push({ item, text: '[未识别表态 ' + raw + ']' + (fbRaw.trim() ? ' ' + fbRaw.trim() : ''), at });
    attention.push({ item, reason: 'unknown_code', choice: raw });
  }
  const agreed = [];
  const holds = [];
  for (const v of byItem.values()) (v.choice === 'hold' ? holds : agreed).push(v);
  return {
    agreed, holds, texts, attention,
    hasAny: !!(rows && rows.length),
    hasStance: byItem.size > 0 || texts.length > 0,
  };
}

/* 折叠结果压成一段中文摘要，写 facts 和任务 note 用。 */
function summariseFold(f) {
  const seg = [];
  if (f.agreed.length) seg.push('同意 ' + f.agreed.length + ' 项（' + f.agreed.map((x) => x.item).join('、') + '）');
  if (f.holds.length) seg.push('保持观察 ' + f.holds.length + ' 项（' + f.holds.map((x) => x.item).join('、') + '）');
  if (f.texts.length) seg.push('文本反馈 ' + f.texts.length + ' 条');
  return seg.length ? seg.join('；') : '无有效表态';
}

/* 到期时钟锚点（2026-09-20 Alvin 定：出卡日起算，发卡打点不再是时钟前提，卡出即社媒送达）。
   取 sent_at 与最早一条交付附件 created_at 里更早的那个；两者都没有回 null（旧卡无附件，
   不起钟，保守不误触）。输入是 GET /tasks 的任务行（含 deliverables 数组）。 */
function cardClockAnchor(task) {
  const times = [];
  if (task && task.sent_at) times.push(String(task.sent_at));
  const dels = (task && Array.isArray(task.deliverables)) ? task.deliverables : [];
  for (const d of dels) { if (d && d.created_at) times.push(String(d.created_at)); }
  if (!times.length) return null;
  times.sort();
  return times[0];
}

module.exports = { foldCardFeedback, summariseFold, cardClockAnchor, decodeFlag };
