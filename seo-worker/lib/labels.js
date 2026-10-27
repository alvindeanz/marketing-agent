'use strict';
// T2 标签统一回挂（PLAN W18，2026-10-25 Alvin 批）：五类人工与现实信号收进一个形状，
// 供 judge 校准（Gate A 的 ground truth）与统计打分（tools/label_stats.js）。
// 纯解析在这，网络与 fs 在 tools/label_sync.js。单测 tests/labels.test.js。
//
// label 形状（labels.jsonl 一行一条）：
//   { at, signal, subject, id, client, module, verdict, fable_verdict, why, src }
//   signal: override（人推翻 fable 判决）| plan_reject（方案打回）| spotcheck（事后抽查 fail/warn）
//           | cohort（结果层回测）| card（客户卡上非 agree 表态）
//   module: seo | paid（任务 module 为 paid/sem 算 paid，否则按 ops 词面推断，再否则 seo）
//   id: 全限定去重键的主体（task#N / plan#NvM / spotcheck#N@run / cohort#N@slug@date / card#N@item@at）

/** 去重键：signal + 全限定 id。labels.jsonl 追加前查重用。 */
function labelKey(l) {
  return String(l.signal || '') + '|' + String(l.id || '');
}

const PAID_OPS_RE =
  /(negative-keyword|keyword-(add|bid|remove|final-url|direction)|ad-(pause|create|copy)|adgroup|campaign|bid-adjust|schedule-adjust|creative-direction|pmax)/i;

/** 任务归桶：module 字段优先，缺了按 ops 词面，再缺默认 seo。 */
function moduleOf(task) {
  const m = String((task && task.module) || '').toLowerCase();
  if (m === 'paid' || m === 'sem') return 'paid';
  if (m) return 'seo';
  if (PAID_OPS_RE.test(String((task && task.ops) || ''))) return 'paid';
  return 'seo';
}

/** 人推翻 fable 判决 → label。没有推翻记录返回 null。 */
function overrideLabel(task, clientId) {
  if (!task || !task.review_override || !task.review_override_note) return null;
  return {
    at: String(task.review_reviewed_at || '').slice(0, 10) || null,
    signal: 'override',
    subject: 'task',
    id: 'task#' + task.id,
    client: clientId,
    module: moduleOf(task),
    verdict: String(task.review_override),
    fable_verdict: String(task.review_verdict || ''),
    why: String(task.review_override_note).replace(/\s+/g, ' ').slice(0, 300),
    src: '/tasks',
  };
}

/** 方案被打回 → label。 */
function planRejectLabel(plan, clientId) {
  if (!plan || plan.status !== 'rejected' || !plan.reject_reason) return null;
  return {
    at: String(plan.updated_at || plan.created_at || '').slice(0, 10) || null,
    signal: 'plan_reject',
    subject: 'plan',
    id: 'plan#' + plan.id + 'v' + (plan.version || 1),
    client: clientId,
    module: 'seo',
    verdict: 'rejected',
    fable_verdict: '',
    why: String(plan.reject_reason).replace(/\s+/g, ' ').slice(0, 300),
    src: '/plans',
  };
}

/**
 * spotcheck 台账 md → labels（只收 fail 与 warn，ok 不是信号）。
 * 行形如：- [fail] #729 HornTech AU「标题」ops=page-rewrite,content-edit urls=3
 * 其后的缩进行（  - fail C2 ...）并进 why。
 */
function parseSpotcheckMd(text, runName) {
  const out = [];
  const lines = String(text || '').split('\n');
  let cur = null;
  for (const line of lines) {
    const top = line.match(/^- \[(ok|warn|fail)\] #(\d+) (.+?)「.*?」(?:ops=(\S+))?/);
    if (top) {
      if (cur && cur.verdict !== 'ok') out.push(cur);
      cur = {
        at: (runName.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || null,
        signal: 'spotcheck',
        subject: 'task',
        id: 'spotcheck#' + top[2] + '@' + runName,
        client: top[3].trim(),
        module: PAID_OPS_RE.test(top[4] || '') ? 'paid' : 'seo',
        verdict: top[1],
        fable_verdict: '',
        why: '',
        src: 'spotcheck/' + runName,
      };
      continue;
    }
    const sub = line.match(/^\s+- (fail|warn|info) (.+)$/);
    if (sub && cur) cur.why = (cur.why ? cur.why + '；' : '') + sub[2].replace(/\s+/g, ' ').slice(0, 200);
  }
  if (cur && cur.verdict !== 'ok') out.push(cur);
  return out;
}

/** cohort_backtest 结果 → label（结果层信号，status=measured 才算）。 */
function cohortLabel(rec, slug) {
  if (!rec || rec.status !== 'measured') return null;
  /* paid 行（cohort_backtest 2026-10-27 接线）自带判读与口径说明：verdict 由类型主指标
     （止血 cost/CPA、出价预算 CPA、文案 CTR）算好，低量与混杂的行 status 不是 measured
     天然进不来。 */
  if (rec.channel === 'paid') {
    if (!rec.verdict) return null;
    return {
      at: rec.measured_at || null,
      signal: 'cohort',
      subject: 'task',
      id: 'cohort#' + rec.taskId + '@' + slug + '@' + (rec.measured_at || ''),
      client: slug,
      module: 'paid',
      verdict: rec.verdict,
      fable_verdict: '',
      why: String(rec.why || '').slice(0, 200) + '（' + (rec.klass || '') + '，' + (rec.scope || '') + '，' + (rec.window_days || '') + 'd 窗）',
      src: 'cohort_results.json',
    };
  }
  const d = rec.delta || {};
  const why =
    'Δclicks ' + (d.clicks == null ? '?' : d.clicks) +
    ' Δimpr ' + (d.impressions == null ? '?' : d.impressions) +
    ' Δctr_pp ' + (d.ctr_pp == null ? '?' : d.ctr_pp) +
    ' Δpos ' + (d.position == null ? '?' : d.position) +
    '（' + (rec.window_days || 28) + 'd 窗）';
  return {
    at: rec.measured_at || null,
    signal: 'cohort',
    subject: 'task',
    id: 'cohort#' + rec.taskId + '@' + slug + '@' + (rec.measured_at || ''),
    client: slug,
    module: 'seo',
    verdict: Number(d.clicks) > 0 ? 'improved' : Number(d.clicks) < 0 ? 'declined' : 'flat',
    fable_verdict: '',
    why,
    src: 'cohort_results.json',
  };
}

/** 客户卡反馈行 → label。agree 是流程凭证不是纠偏信号，只收 hold/other/flag。 */
function cardLabel(row, clientId, moduleByTask) {
  if (!row || row.choice === 'agree') return null;
  const at = String(row.created_at || '');
  return {
    at: at.slice(0, 10) || null,
    signal: 'card',
    subject: 'task',
    id: 'card#' + row.task_id + '@' + String(row.item || '_card') + '@' + at,
    client: clientId,
    module: (moduleByTask && moduleByTask[row.task_id]) || 'seo',
    verdict: String(row.choice),
    fable_verdict: '',
    why: String(row.fb || '').replace(/\s+/g, ' ').slice(0, 300),
    src: '/card_feedback',
  };
}

module.exports = {
  labelKey,
  moduleOf,
  overrideLabel,
  planRejectLabel,
  parseSpotcheckMd,
  cohortLabel,
  cardLabel,
  PAID_OPS_RE,
};
