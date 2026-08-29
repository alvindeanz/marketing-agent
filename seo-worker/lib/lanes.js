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
  light: ['review_plan', 'ruling', 'feedback', 'chat', 'triage', 'plan_review'],
};

function laneOf(type) {
  return LANES.light.indexOf(String(type || '')) !== -1 ? 'light' : 'heavy';
}

module.exports = { LANES, laneOf, LANE_NAMES: Object.keys(LANES) };
