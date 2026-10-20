'use strict';
/* 能力断言匹配（纯函数，capability_broadcast 用，单测在 tests/capability_broadcast.test.js）。
   两档：
   strong：文本点名该 op（标准措辞「缺执行器 <op>」，或 op 名出现在缺口语境行里）。
   wide：泛能力断言（没点名 op，只说平台没这能力），仅当客户平台与 op 所属清单一致才算，
         盖章与否由调用方 --wide 决定（Apex #663「平台能力清单无新建页面操作」就是这类）。
   match 的输入是任务的三块文本；断言只认「缺口语境」，避免把正常提到 op 名的任务全扫进来。 */

const GENERIC_CLAIM = /平台能力清单无|能力清单(里|中)?没有|没有看到[^\n]{0,20}已注册 op|无[^\n]{0,12}已注册 op|不在平台 manifest|能力缺口|机器做不了|执行步机器做不了|需人在/;

function matchCapabilityClaim(task, op, opts) {
  const text = [task.detail, task.review_reason, task.result_note].map((x) => String(x || '')).join('\n');
  if (!text.trim()) return null;
  const esc = op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp('缺执行器\\s+' + esc + '\\b').test(text)) return 'strong';
  // op 名出现在缺口语境的同一行才算强命中，正常引用 op 名（如方案步骤）不算
  for (const line of text.split('\n')) {
    if (line.indexOf(op) === -1) continue;
    if (/缺|没有|无法|不支持|未注册|不在|做不了/.test(line)) return 'strong';
  }
  if (opts && opts.platformMatches && GENERIC_CLAIM.test(text)) return 'wide';
  return null;
}

module.exports = { matchCapabilityClaim, GENERIC_CLAIM };
