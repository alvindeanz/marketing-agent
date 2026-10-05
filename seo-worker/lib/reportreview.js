'use strict';
// 报告审核官（2026-10-05 Alvin 定：每份报告出稿后过一遍审核，不靠人逐份上手）。
//
// 位置在渲染之后、交付之前：拿成品的纯文本按 specs/report/client_reporting_frame.md
// 审一遍，产出 pass 或至多 6 条修订意见；runner 拿意见回喂叙事层重出一轮（至多一轮）。
// 三条性质：
//   1. 只读不写：审核官没有工具，看到什么审什么，意见只针对叙事层能改的东西。
//   2. 审核失败不挡交付：解析不出来、超时，照常交付首版，note 里记一笔。
//   3. 不审数字真伪：数字校验是 reportlint 的活，这里审的是取景与叙事立场。

const fs = require('node:fs');
const path = require('node:path');

const { runClaude } = require('./llm');
const { extractLastFence } = require('./mdjson');

const FRAME_SPEC = path.join(__dirname, '..', 'specs', 'report', 'client_reporting_frame.md');
const MAX_REVISIONS = 6;
const MAX_TEXT_CHARS = 16000;

function frameSpecText() {
  try {
    return fs.readFileSync(FRAME_SPEC, 'utf8');
  } catch (e) {
    return '';
  }
}

function buildReviewPrompt(reportText, pack) {
  const hints = [];
  if (pack && pack.ga4 && pack.ga4.anomaly) {
    hints.push('pack 带 ga4.anomaly：剔除异常后全渠道环比 ' +
      (pack.ga4.anomaly.all_sessions_adj_delta_pct === null
        ? '不可算'
        : (pack.ga4.anomaly.all_sessions_adj_delta_pct * 100).toFixed(1) + '%') +
      '；' + String(pack.ga4.anomaly.note || ''));
  }
  const br = pack && pack.gsc && pack.gsc.brand;
  if (br && br.nonbrand_cur_clicks !== undefined && br.nonbrand_cur_clicks !== null) {
    hints.push('非品牌点击 本期 ' + br.nonbrand_cur_clicks + '、上期 ' + br.nonbrand_prev_clicks +
      '；品牌点击 本期 ' + br.cur_clicks + '、上期 ' + br.prev_clicks);
  }
  // 本期工作原始清单（2026-10-05 sungait 实证：54 条压成 8 组时丢了客户自写博文
  // 两条，prompt 的「每条都要有归宿」没人在查）。审核官逐条对照报告工作节，
  // 漏项点名打回。
  const workItems = (pack && pack.work && pack.work.items) || [];
  if (workItems.length) {
    const lines = workItems.slice(0, 60).map((w) => (w.date || '') + ' ' + String(w.title_raw || '').slice(0, 60));
    hints.push('本期工作原始清单（共 ' + workItems.length + ' 条，逐条核对报告「本月工作」是否都有归宿，实质性漏项要打回）：\n  - ' + lines.join('\n  - '));
  }
  return [
    '你是这家 agency 的客户报告审核官。下面是一份即将交付客户的 SEO 报告成品的全文（纯文本），',
    '按审核清单过一遍，判断能不能交。',
    '',
    '===== 审核清单开始 =====',
    frameSpecText(),
    '===== 审核清单结束 =====',
    '',
    hints.length ? '数据背景（审核参考，不是要你塞进报告的内容）：\n- ' + hints.join('\n- ') : '',
    '',
    '===== 报告全文开始 =====',
    String(reportText || '').slice(0, MAX_TEXT_CHARS),
    '===== 报告全文结束 =====',
    '',
    '只回一个 json 代码块，块外一个字不要有：{"pass": true} 或 {"pass": false, "revisions": ["..."]}。',
  ].join('\n');
}

/**
 * 审一份成品。返回 { pass, revisions, note }；任何失败都回 pass=true 加 note，
 * 绝不抛错，审核挂了不许连累交付。
 */
async function reviewReport(cfg, opts) {
  const { reportText, pack, workspace, log, label } = opts;
  try {
    const res = await runClaude(cfg, {
      prompt: buildReviewPrompt(reportText, pack),
      cwd: workspace,
      log,
      model: cfg.reportReviewModel || cfg.reviewModel || 'opus',
      allowedTools: 'Read',
      label: (label || 'report') + ' review',
      timeoutMs: 10 * 60 * 1000,
    });
    const fence = extractLastFence(String(res.stdout || '').trim(), 'json');
    if (!fence.found) return { pass: true, revisions: [], note: '审核官没有输出 json，按通过处理' };
    let j = null;
    try {
      j = JSON.parse(fence.raw);
    } catch (e) {
      return { pass: true, revisions: [], note: '审核官 json 解析失败，按通过处理' };
    }
    if (!j || typeof j !== 'object') return { pass: true, revisions: [], note: '审核官输出不是对象，按通过处理' };
    const revisions = (Array.isArray(j.revisions) ? j.revisions : [])
      .map((r) => String(r || '').trim())
      .filter(Boolean)
      .slice(0, MAX_REVISIONS);
    if (j.pass === true || !revisions.length) return { pass: true, revisions: [], note: '' };
    return { pass: false, revisions, note: '' };
  } catch (e) {
    return { pass: true, revisions: [], note: '审核官运行失败（' + String(e.message || e).slice(0, 120) + '），按通过处理' };
  }
}

module.exports = { reviewReport, buildReviewPrompt, frameSpecText };
