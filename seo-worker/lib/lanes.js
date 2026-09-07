'use strict';
// Job lanes. Two single flight drain loops in the listener, one per lane.
//
//   heavy: jobs that spend minutes of opus and may write to a client site.
//          Strictly one at a time, because two writers on one site race.
//   light: jobs that read the board and write the board. Seconds of fable or
//          sonnet, no site writes. They must not wait behind a ten minute
//          execute_task, which is the whole reason the lanes exist: a review
//          verdict that arrives in 30 seconds is useful, one that arrives in
//          12 minutes is a coin someone already flipped by hand.
//
// The same table lives in seo-api.php as JOB_LANES. A type missing from both
// lists lands in heavy on both sides, so a new job type is never lost, only
// slow until someone files it.

const LANES = {
  heavy: ['pull_data', 'discover', 'plan', 'execute_task', 'apply_task', 'report', 'backfill_metrics'],
  light: ['review_plan', 'ruling', 'feedback', 'triage', 'plan_review'],
  // chat 单独一条道（2026-09-07）：聊天是人在等的交互，几十秒的回复不能排在
  // 几分钟的 fable 评审后面。同一会话仍一轮一问（服务端 409 闸），道内跨会话串行。
  chat: ['chat'],
};

function laneOf(type) {
  const t = String(type || '');
  for (const name of Object.keys(LANES)) {
    if (name !== 'heavy' && LANES[name].indexOf(t) !== -1) return name;
  }
  return 'heavy';
}

module.exports = { LANES, laneOf, LANE_NAMES: Object.keys(LANES) };
