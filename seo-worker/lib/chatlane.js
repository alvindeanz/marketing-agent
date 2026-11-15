'use strict';
/* chat 泳道新口径（2026-11-15 Alvin 定：chat 单一律当场处理不进 harness，积压直接废，例外是经 chat
   更新 sprint 的单）。10-24 脱轮配套让轮子按 origin 把泳道单整体拉进停滞台账与放行窗，等于替 chat 单
   续命，和「当场处理」打架。收窄成看载荷不看出身：
   - 有 sprint 章的泳道单（人工补章 = 转正入轮）本来就按 sprint 口径走，不靠 origin；
   - 无 sprint 的泳道单只有手里带着轮子才能推进的在途载荷才留在放行窗：客户确认卡（客户点同意或
     卡到期后要有人续排发布，spawn 来源没有自己的续排链）、静默期放行戳（到点要轮子放行）；
   - 其余无 sprint 的泳道单轮子不推、不进停滞台账，超 3 天进「chat 泳道到期清单」，开轮时批量废。
   纯函数，harness 用，tests/chatlane.test.js 回放。 */
function laneInFlight(t) {
  const sig = String((t && t.output_url) || '') + ' ' + String((t && t.result_note) || '');
  if (t && t.card_kind) return true;
  if (/blog_confirmation|\[落地页确认卡\]/.test(sig)) return true;
  if (/\[pending-release /.test(sig)) return true;
  return false;
}

module.exports = { laneInFlight };
