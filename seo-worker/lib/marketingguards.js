'use strict';
// WebForger Marketing Inbox 放行护栏的 worker 侧移植（2026-10-18）。
//
// 事实来源：webforge 仓 packages/api/src/services/marketingGuards.ts（WF 侧零 LLM 确定性护栏）。
// 本文件 checkReplyGuards 是逐条照抄的移植，口径必须与 WF 一致：WF 扣下两条就熔断该站
// （release 自动转 manual，要人工恢复），所以 MA 在出口前先用同一套规则自检，不过关不写出口表。
// 改规则时两边一起改；共用样例在 tests/fixtures/marketing_guard_cases.json（抄自 WF 的
// test/marketing-inbox.test.ts），tests/marketingguards.test.js 逐条对拍，防两侧漂移。
//
// checkLocalReply 在移植规则之外加 worker 侧更严的一道（只增不减）：WF 的裸域名规则只认常见
// 顶级域，竞品站常见的 .ca、.de、.co.uk 二级等其他后缀漏网；本地对任意字母后缀的主机名一律按
// 外链处理（排除常见文件扩展名），原因记 external_host，不进 WF 对拍。

const REPLY_MAX_CHARS = 2000;
const ECHO_MIN_CHARS = 40;

const NAME_RES = [
  /(?<![A-Za-z0-9])MA(?![A-Za-z0-9])/,
  /\b(?:aira|kira|agents?|opus|fable|harness|claude|anthropic|llms?)\b/i,
  /智能体/,
];

const REF_RES = [
  /\b(?:job|task|plan|ticket\s*job)s?\s*(?:#|no\.?|id|number)?\s*[:#-]?\s*\d{1,}\b/i,
  /\b(?:job|task|plan)[_-]?id\b/i,
  /\b[JTP]-\d{2,}\b/,
  /\b(?:verdict|guardrails?|fence[_ ]triggered|auto[- ]?release|release[_ ](?:queue|gate|mode|pipeline)|held[_ ](?:queue|reply|replies)|hold[_ ]queue|circuit[_ ]breaker)\b/i,
  /(?:判决|放行|扣下|护栏|熔断|围栏|任务编号|工单编号|计划编号)/,
];

const ID_RES = [
  /\bclient[_\s-]?id\b/i,
  /\bmaClientId\b/i,
  /\b(?:localhost|[a-z0-9-]+\.(?:internal|local|lan|corp))\b/i,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
  /\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){4,7}\b/i,
];
const DEV_HOST_RE = /\b((?:[a-z0-9-]+\.)+)horntech-dev\.com\b/gi;

const URL_HOST_RE = /\b(?:https?:\/\/|www\.)([a-z0-9.-]+\.[a-z]{2,})/gi;
const BARE_HOST_RE = /(?<![@\w.-])((?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|co|nz|au|dev|app|site|info|biz|me|xyz|online|store|shop|cn|uk|us))(?![\w-])/gi;

const DEFAULT_ALLOWED_HOSTS = ['webforger.ai', 'agencyreport.horntech-dev.com'];

function hostAllowed(host, allowed) {
  const h = String(host).toLowerCase().replace(/^www\./, '').replace(/\.+$/, '');
  return allowed.some((a) => {
    const d = String(a || '').toLowerCase().replace(/^www\./, '');
    return d && (h === d || h.endsWith('.' + d));
  });
}

function linkHosts(text) {
  const out = new Set();
  for (const m of String(text).matchAll(URL_HOST_RE)) out.add(m[1].toLowerCase().replace(/\.+$/, ''));
  for (const m of String(text).matchAll(BARE_HOST_RE)) out.add(m[1].toLowerCase().replace(/\.+$/, ''));
  return [...out];
}

function normalizeForEcho(s) {
  return String(s).replace(/\s+/g, ' ').trim().toLowerCase();
}

function echoes(reply, sources, minChars) {
  const n = minChars || ECHO_MIN_CHARS;
  const r = normalizeForEcho(reply);
  if (r.length < n) return false;
  const shingles = new Set();
  for (const src of sources) {
    const s = normalizeForEcho(src || '');
    for (let i = 0; i + n <= s.length; i++) shingles.add(s.slice(i, i + n));
  }
  if (!shingles.size) return false;
  for (let i = 0; i + n <= r.length; i++) if (shingles.has(r.slice(i, i + n))) return true;
  return false;
}

/** WF 口径逐条移植。input: { body, fenceTriggered, attachments, siteHosts, extraHosts, clientMessages } */
function checkReplyGuards(input) {
  const body = String(input.body == null ? '' : input.body);
  const out = [];
  if (!body.trim()) out.push('empty');
  if ([...body].length > REPLY_MAX_CHARS) out.push('too_long');
  if (NAME_RES.some((re) => re.test(body))) out.push('internal_name');
  if (REF_RES.some((re) => re.test(body))) out.push('internal_ref');
  const allowed = [...(input.siteHosts || []), ...(input.extraHosts || DEFAULT_ALLOWED_HOSTS)];
  let internalHost = false;
  for (const m of body.matchAll(DEV_HOST_RE)) {
    if (!hostAllowed(m[1] + 'horntech-dev.com', allowed)) internalHost = true;
  }
  if (internalHost || ID_RES.some((re) => re.test(body))) out.push('internal_id');
  if (linkHosts(body).some((h) => !hostAllowed(h, allowed))) out.push('link_not_allowed');
  if (input.fenceTriggered) out.push('fence_triggered');
  if (input.clientMessages && input.clientMessages.length && echoes(body, input.clientMessages)) out.push('echo');
  if ((input.attachments || 0) > 0) out.push('attachments');
  return out;
}

// worker 侧加严：任意字母后缀的主机名（a.b 形），去掉常见文件扩展名的误报。
const ANY_HOST_RE = /(?<![@\w.-])((?:[a-z0-9-]+\.)+[a-z]{2,24})(?![\w-])/gi;
const FILE_EXT = /\.(?:html?|php|aspx?|jsx?|tsx?|css|pdf|png|jpe?g|gif|svg|webp|json|xml|txt|csv|md|docx?|xlsx?|pptx?|zip|mp4|mov)$/i;
function strictHosts(text) {
  const out = new Set();
  for (const m of String(text).matchAll(ANY_HOST_RE)) {
    const h = m[1].toLowerCase().replace(/\.+$/, '');
    if (FILE_EXT.test(h)) continue;
    out.add(h);
  }
  return [...out];
}

/** 本地自检 = WF 移植规则 + external_host 加严。返回原因数组，空即过。 */
function checkLocalReply(input) {
  const out = checkReplyGuards(input);
  const allowed = [...(input.siteHosts || []), ...(input.extraHosts || DEFAULT_ALLOWED_HOSTS)];
  if (strictHosts(String(input.body || '')).some((h) => !hostAllowed(h, allowed))) out.push('external_host');
  return out;
}

module.exports = {
  REPLY_MAX_CHARS, ECHO_MIN_CHARS, DEFAULT_ALLOWED_HOSTS,
  checkReplyGuards, checkLocalReply, linkHosts, echoes, hostAllowed, strictHosts,
};
