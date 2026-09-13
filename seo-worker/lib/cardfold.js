'use strict';
/* 方向卡客户反馈折叠（2026-09-13 Alvin 定第一性版：反馈翻任务状态，harness 读状态分岔）。
   输入 seo_card_feedback 的行（按 id 升序即时间序），输出三份：
     agreed  每个决策项的最终表态是 agree 或 flag（flag 带勾选清单在 fb 里），可以落地
     holds   最终表态是 hold，记观察不动账户
     texts   other 的文本反馈，全部保留（不是表态是话，每条都要有人接）
   规则：同一 item 多次表态取最后一次（客户改主意以最新为准）；other 不覆盖表态，
   只进 texts；没有 item 的表态归入 _card（整卡态度）。 */
function foldCardFeedback(rows) {
  const byItem = new Map();
  const texts = [];
  for (const r of rows || []) {
    const item = String(r.item || '').trim() || '_card';
    const choice = String(r.choice || '');
    if (choice === 'other') {
      const t = String(r.fb || '').trim();
      if (t) texts.push({ item, text: t, at: r.created_at || '' });
      continue;
    }
    if (choice === 'agree' || choice === 'hold' || choice === 'flag') {
      byItem.set(item, { item, choice, fb: String(r.fb || ''), at: r.created_at || '' });
    }
  }
  const agreed = [];
  const holds = [];
  for (const v of byItem.values()) (v.choice === 'hold' ? holds : agreed).push(v);
  return { agreed, holds, texts, hasAny: !!(rows && rows.length) };
}

/* 折叠结果压成一段中文摘要，写 facts 和任务 note 用。 */
function summariseFold(f) {
  const seg = [];
  if (f.agreed.length) seg.push('同意 ' + f.agreed.length + ' 项（' + f.agreed.map((x) => x.item).join('、') + '）');
  if (f.holds.length) seg.push('保持观察 ' + f.holds.length + ' 项（' + f.holds.map((x) => x.item).join('、') + '）');
  if (f.texts.length) seg.push('文本反馈 ' + f.texts.length + ' 条');
  return seg.length ? seg.join('；') : '无有效表态';
}

module.exports = { foldCardFeedback, summariseFold };
