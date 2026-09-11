'use strict';
// F2 条件巡检（2026-09-11，#680 教训，PJ 基准：等条件就挂起，到点自己续跑）。
// 零 LLM：条件核对全部走 GAQL 只读或日期比较，续跑通过 condition_met 端点交回服务端，
// 服务端按放行政策决定排 apply 还是回频道要放行。授权是委托单那一次给的，这里只推迟时点。
//
// 条件语法 V1（与 execute_task 方案契约、seo-api ensure_change_items 对齐）：
//   ad_approved:<ad_id>   该广告 policy_summary.approval_status 为 APPROVED
//   after:YYYY-MM-DD      本地日期已到（含当天）
//   manual_signal:<text>  只有人能确认，巡检永远跳过，等人在频道说
const { execFileSync } = require('node:child_process');

const GAQL_SCRIPT = '/data/aira/seo-worker/lib/gaql_query.py';

/** 单个条件是否满足。返回 { met, evidence }；判不了（语法未知/manual_signal/查询失败）按未满足。 */
function checkCondition(cond, customerId, log) {
  const say = log || function () {};
  const c = String(cond || '').trim();
  const mAd = c.match(/^ad_approved:(\d+)$/);
  if (mAd) {
    if (!customerId) return { met: false, evidence: '' };
    try {
      const q = 'SELECT ad_group_ad.policy_summary.approval_status FROM ad_group_ad WHERE ad_group_ad.ad.id = ' + mAd[1];
      const out = execFileSync('python3', [GAQL_SCRIPT, customerId, q], { timeout: 60000, maxBuffer: 1024 * 1024 }).toString();
      if (/APPROVED(_LIMITED)?/.test(out) && !/DISAPPROVED/.test(out)) {
        return { met: true, evidence: 'ad ' + mAd[1] + ' 审核状态 APPROVED（GAQL 实读）' };
      }
      return { met: false, evidence: '' };
    } catch (e) {
      say('条件巡检：ad_approved:' + mAd[1] + ' 查询失败，按未满足 :: ' + String(e.message || '').slice(0, 120));
      return { met: false, evidence: '' };
    }
  }
  const mDate = c.match(/^after:(\d{4}-\d{2}-\d{2})$/);
  if (mDate) {
    const today = new Date().toISOString().slice(0, 10);
    return today >= mDate[1] ? { met: true, evidence: '已到 ' + mDate[1] } : { met: false, evidence: '' };
  }
  // manual_signal 与未知语法：巡检不裁，等人。
  return { met: false, evidence: '' };
}

/**
 * 一轮巡检：拉等条件任务，逐任务核全部条件，全满足的交 condition_met。
 * 任何一个任务出错不拖累其他任务。挂在 listener 的兜底轮询上，约每小时一轮。
 */
async function conditionProbeTick(api, log) {
  const say = log || function () {};
  let list;
  try {
    const r = await api.getPendingConditions();
    list = (r && r.tasks) || [];
  } catch (e) {
    say('条件巡检：取数失败，本轮跳过 :: ' + String(e.message || '').slice(0, 120));
    return;
  }
  if (!list.length) return;
  say('条件巡检：' + list.length + ' 个任务在等条件');
  for (const t of list) {
    try {
      const cid = String(t.ads_customer_id || '').replace(/-/g, '');
      const conds = Array.isArray(t.conditions) ? t.conditions : [];
      if (!conds.length) continue;
      const evid = [];
      let allMet = true;
      for (const c of conds) {
        const r = checkCondition(c, cid, say);
        if (!r.met) { allMet = false; break; }
        evid.push(r.evidence);
      }
      if (!allMet) continue;
      const res = await api.postConditionMet(t.task_id, evid.join('；'));
      say('条件巡检：任务 #' + t.task_id + ' 条件全满足，已续跑（' + ((res && res.did) || '?') + (res && res.job_id ? ' job #' + res.job_id : '') + '）');
    } catch (e) {
      say('条件巡检：任务 #' + t.task_id + ' 处理失败，下一轮再试 :: ' + String(e.message || '').slice(0, 150));
    }
  }
}

module.exports = { conditionProbeTick, checkCondition };
