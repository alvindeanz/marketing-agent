'use strict';
/* 出卡登记 Ask（2026-10-18 起，契约：/mnt/share/aiden/to-aira-asks-contract-20261016.md；
   2026-10-19 改读 card_data v1，规格 specs/report/card_data_v1.md，架构条子
   /mnt/share/aiden/to-aira-confirmation-architecture-20261019.md 及 Aira 回条）。
   卡是渲染，Ask 是待答实体：execute 出卡后把卡登记成 Ask，WF 后台 AsksPanel 与
   agencyreport 邮件卡页答同一批题、写同一本账。
   单一事实源：题（item_id、题型、选项码）与内容块只取自卡产线的 data.json，HTML 卡与 Ask
   出自同一份。读不到合规 data 就不登记（不再降级成 approve 单题：那会让两个通道答两批不同的题，
   1464 实证），HTML 卡照常出，登记日志留一行。approve 题型只留给 plan_approval。
   硬口径：登记失败不挡出卡（调用方兜 try，重登是幂等 upsert）；card_token_ref 只传指纹不传明文；
   deadline 优先取卡数据的截止日（按新西兰当日 23:59 换 UTC），缺省出卡锚点加 14 天。 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIRECTION_KINDS = ['keyword_direction', 'creative_direction'];
const DEADLINE_DAYS = 14;
const DATA_FRESH_MS = 6 * 3600 * 1000; // 与客户版 HTML 发布同窗：只认本轮产物
const CODE_RE = /^[a-z0-9_.:-]{1,16}$/; // card_data v1 选项码（与 asks_code_ok、choice 列宽同源）
const ITEM_RE = /^[a-z0-9_]{1,60}$/;
const BLOCK_RE = /^b_[a-z0-9_]{1,30}$/;
const SINGLE_CODES = ['agree', 'hold', 'other'];
const SINGLE_LABELS = { agree: '同意建议', hold: '保持现状', other: '其他（请写两句）' };
const LANG_PACK_MAX = 250000; // 服务端 256KB 上限留余量
const DEADLINE_TZ = 'Pacific/Auckland';

/* 卡类注册表：specs/card_kinds.json，seo-api card_kind_of 读同一份。读不到退回内置表。 */
const KINDS_FALLBACK = {
  keyword_direction: { service: 'sem', kind: 'direction' },
  creative_direction: { service: 'sem', kind: 'direction' },
  keyword_confirmation: { service: 'seo', kind: 'confirmation' },
  mapping_confirmation: { service: 'seo', kind: 'confirmation' },
  blog_confirmation: { service: 'seo', kind: 'confirmation' },
  onsite_confirm: { service: 'seo', kind: 'confirmation' },
};
function loadCardKinds(file) {
  try {
    const reg = JSON.parse(fs.readFileSync(file || path.join(__dirname, '..', 'specs', 'card_kinds.json'), 'utf8'));
    if (reg && reg.kinds && typeof reg.kinds === 'object' && Object.keys(reg.kinds).length) return reg.kinds;
  } catch (e) { /* 退回内置表 */ }
  return KINDS_FALLBACK;
}
const CARD_KINDS = loadCardKinds();

function cardTokenRef(taskId, serviceToken) {
  // 与 lib/publish.injectCardToken 同源派生，取 sha256 前 16 位做指纹（契约 §2 硬约束）。
  const tok = crypto.createHash('md5').update('cardfb' + taskId + String(serviceToken || '')).digest('hex');
  return 'sha256:' + crypto.createHash('sha256').update(tok).digest('hex').slice(0, 16);
}

/* 卡的 data JSON 由 agent 写在 reports/ 或 seo-agent-output/，文件名含卡类前缀。
   只认 6 小时内的新鲜产物，多份取最新；读不到返回 null。全部卡类都读（10-19 前只读方向卡）。 */
function findCardData(cardKind, workspace, log) {
  let best = null;
  for (const dir of [path.join(workspace, 'reports'), path.join(workspace, 'seo-agent-output')]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    for (const f of names) {
      if (!f.endsWith('.data.json') || f.indexOf(cardKind) === -1) continue;
      let mtime = 0;
      try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch (e) { continue; }
      if (Date.now() - mtime >= DATA_FRESH_MS) continue;
      if (!best || mtime > best.mtime) best = { file: path.join(dir, f), mtime };
    }
  }
  if (!best) return null;
  try {
    return JSON.parse(fs.readFileSync(best.file, 'utf8'));
  } catch (e) {
    if (log) log('askreg: ' + path.basename(best.file) + ' 不是合法 JSON，不登记 :: ' + e.message);
    return null;
  }
}

function isoPlusDays(days, now) {
  return new Date((now || Date.now()) + days * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/* 某时区在给定时刻的 UTC 偏移（分钟）。 */
function tzOffsetMinutes(tz, at) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)) p[x.type] = x.value;
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - at.getTime()) / 60000;
}
/* 卡面截止日 YYYY-MM-DD 解释为新西兰当日 23:59，换成 ISO8601 UTC（与 1464 首登 10:59Z 同口径）。 */
function deadlineFromDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  if (!m) return null;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59, 0);
  const off = tzOffsetMinutes(DEADLINE_TZ, new Date(naive - 13 * 3600000));
  return new Date(naive - off * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function stripTags(s) { return String(s || '').replace(/<\/?[a-z][^>]*>/gi, '').trim(); }

/* 词面到选项码：可读 slug 优先（16 字符内且不撞），放不下或撞了用位置码 p1/p2。 */
function codeFor(term, idx, used) {
  const slug = String(term || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  let c = slug && slug.length <= 16 && CODE_RE.test(slug) && !used.has(slug) ? slug : '';
  if (!c) { c = 'p' + (idx + 1); while (used.has(c)) c = c + 'x'; }
  used.add(c);
  return c;
}

/* 旧方向卡 data（decisions[] / picks / negatives 段落）转 card_data v1 形态。
   适配保留到 2027-01（card_data_v1.md 迁移节）。negatives 在旧 schema 里是「否词与止血」段落（允许 <b>），
   不是勾选名单（10-18 版误当选项码）；它转成卡级 list 内容块。勾选名单在 decisions[].picks，
   转 multi 题，item_id 沿用 picks.save_item（与旧 HTML 卡 data-item 一致，存量账本行无迁移挂上）。
   旧 HTML 勾选落账的是 kw 词面，WF 落账的是码，解码表 label 存词面，折叠层两种都认。 */
function adaptLegacyDirection(data, cardKind) {
  const items = [];
  const seen = new Set();
  for (const dec of Array.isArray(data.decisions) ? data.decisions : []) {
    const id = String(dec.item || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push({
      item_id: id, type: 'single', default: 'agree',
      q: String(dec.q || id), situation: String(dec.situation || ''),
      recommendation: String(dec.recommendation || ''), hint: String(dec.textarea_hint || ''),
    });
    const pk = dec.picks;
    if (pk && pk.save_item && Array.isArray(pk.entries) && pk.entries.length && !seen.has(String(pk.save_item))) {
      seen.add(String(pk.save_item));
      const used = new Set();
      items.push({
        item_id: String(pk.save_item), type: 'multi', required: false,
        q: String(pk.ph || dec.q || '勾选'),
        options: pk.entries.slice(0, 40).map((e, i) => ({
          code: codeFor(e.kw, i, used),
          label: String(e.label || e.kw || ''),
        })),
      });
    }
  }
  const blocks = [];
  const neg = (Array.isArray(data.negatives) ? data.negatives : []).map(stripTags).filter(Boolean).slice(0, 40);
  if (neg.length) blocks.push({ id: 'b_negatives', type: 'list', title: '否词与止血', items: neg });
  return {
    schema: 'legacy_direction', card_kind: cardKind, kind: 'direction',
    service: (CARD_KINDS[cardKind] || {}).service || 'sem',
    lang: 'zh', title: String(data.title || ''), oneline: String(data.oneline || ''),
    default_policy: 'no_reply_follow_recommendation', blocks, items,
  };
}

/* 入口：v1 原样，旧方向卡适配，其余（缺 data、旧确认卡手写 HTML）返回 null = 不登记。 */
function normalizeCardData(data, cardKind) {
  if (!data || typeof data !== 'object') return null;
  if (data.schema === 'card_data/v1') return data;
  if (DIRECTION_KINDS.indexOf(cardKind) !== -1 && Array.isArray(data.decisions) && data.decisions.length) {
    return adaptLegacyDirection(data, cardKind);
  }
  return null;
}

function fail(msg) { throw new Error('askreg: card_data 不合规，不登记 :: ' + msg); }

/** 纯函数：从任务与卡数据拼 POST /asks 的 payload；无合规卡数据返回 null。不合规抛错（调用方记日志）。 */
function buildAsk(opts) {
  const task = opts.task || {};
  const cardKind = String(task.card_kind || '').trim();
  const taskId = Number(task.id);
  const card = normalizeCardData(opts.data, cardKind);
  if (!card) return null;
  if (card.card_kind && card.card_kind !== cardKind) fail('card_kind ' + card.card_kind + ' 与任务 ' + cardKind + ' 不符');
  const reg = CARD_KINDS[cardKind] || {};
  const kind = card.kind || reg.kind || 'confirmation';
  if (['direction', 'confirmation'].indexOf(kind) === -1) fail('kind ' + kind);
  const service = Object.prototype.hasOwnProperty.call(card, 'service') ? card.service : (reg.service || null);
  if (service !== null && service !== 'seo' && service !== 'sem') fail('service ' + service);
  /* default_policy 产线必填（v1 修订 2）；kind 兜底只给适配层与缺字段的旧数据。 */
  const policy = card.default_policy || (kind === 'confirmation' ? 'none' : 'no_reply_follow_recommendation');
  if (['none', 'no_reply_follow_recommendation'].indexOf(policy) === -1) fail('default_policy ' + policy);
  const lang = String(card.lang || 'zh');

  const blocks = Array.isArray(card.blocks) ? card.blocks : [];
  const blockIds = new Set();
  for (const b of blocks) {
    if (!b || !BLOCK_RE.test(String(b.id || ''))) fail('block id ' + (b && b.id));
    if (['para', 'list', 'table', 'kv'].indexOf(b.type) === -1) fail('block ' + b.id + ' type ' + b.type);
    blockIds.add(b.id);
  }

  const items = [];
  const itemTexts = {};
  for (const it of Array.isArray(card.items) ? card.items : []) {
    const id = String((it && it.item_id) || '');
    if (!ITEM_RE.test(id)) fail('item_id ' + id);
    if (itemTexts[id]) fail('item_id 重复 ' + id);
    const type = it.type;
    if (['single', 'multi', 'text'].indexOf(type) === -1) fail('item ' + id + ' type ' + type);
    const refs = Array.isArray(it.block_refs) ? it.block_refs.map(String) : [];
    for (const r of refs) if (!blockIds.has(r)) fail('item ' + id + ' block_ref ' + r + ' 不存在');
    let options = [];
    const labels = {};
    if (type === 'single') {
      const given = Array.isArray(it.options) && it.options.length ? it.options : SINGLE_CODES.map((c) => ({ code: c }));
      options = given.map((o) => String(o.code));
      if (options.join(',') !== SINGLE_CODES.join(',')) fail('item ' + id + ' single 码必须按序 agree/hold/other');
      for (const o of given) labels[o.code] = String(o.label || SINGLE_LABELS[o.code]);
    } else if (type === 'multi') {
      if (!Array.isArray(it.options) || !it.options.length || it.options.length > 40) fail('item ' + id + ' multi 需 1 到 40 个选项');
      for (const o of it.options) {
        const c = String((o && o.code) || '');
        if (!CODE_RE.test(c) || c === 'flag' || c === 'other') fail('item ' + id + ' 选项码 ' + c);
        if (options.indexOf(c) !== -1) fail('item ' + id + ' 选项码重复 ' + c);
        options.push(c);
        labels[c] = String(o.label || c);
      }
    }
    const rtw = Array.isArray(it.requires_text_when) ? it.requires_text_when.map(String) : (type === 'single' ? ['other'] : []);
    for (const c of rtw) if (options.indexOf(c) === -1) fail('item ' + id + ' requires_text_when ' + c);
    const dv = type === 'single' && it.default ? String(it.default) : null;
    if (dv !== null && options.indexOf(dv) === -1) fail('item ' + id + ' default ' + dv);
    const required = typeof it.required === 'boolean' ? it.required : type !== 'text';
    const item = { item_id: id, type, options, required, requires_text_when: rtw };
    if (dv !== null) item.default_value = dv;
    if (refs.length) item.block_refs = refs;
    items.push(item);
    const tx = { prompt: String(it.q || it.prompt || (type === 'text' ? '其他留言（可选）' : id)) };
    if (it.situation) tx.situation = String(it.situation);
    if (it.recommendation) tx.recommendation = String(it.recommendation);
    if (it.hint) tx.hint = String(it.hint);
    if (Object.keys(labels).length) tx.options = labels;
    itemTexts[id] = tx;
  }
  if (!items.some((i) => i.type === 'single' || i.type === 'multi')) fail('没有可表态的题');
  if (!itemTexts.global_note) {
    items.push({ item_id: 'global_note', type: 'text', options: [], required: false, requires_text_when: [] });
    itemTexts.global_note = { prompt: '其他留言（可选）' };
  }

  // 防御性剥参：带 ?t=&k= 的链接含明文卡 token，服务端整包 422；裸链接打开即可提交。
  const bareUrl = String(opts.cardUrl || '').replace(/\?t=\d+&k=[0-9a-f]{32}\b.*$/, '');
  const cardLine = bareUrl ? '卡片全文：' + bareUrl : '卡片全文随邮件送达。';
  const deadline = opts.deadline || deadlineFromDate(card.deadline) || isoPlusDays(DEADLINE_DAYS, opts.now);
  const texts = {
    title: String(card.title || task.title || cardKind),
    intro: [String(card.oneline || ''), cardLine].filter(Boolean).join('\n'),
    deadline_note: '请在 ' + (card.deadline || deadline.slice(0, 10)) + ' 前回复',
    default_note: policy === 'none' ? '到期未回复不视为同意，我们会再跟进确认' : '到期未回复按卡上建议执行',
    items: itemTexts,
  };
  if (blocks.length) texts.blocks = blocks.map((b) => {
    const o = { id: b.id, type: b.type };
    if (b.title) o.title = String(b.title);
    if (b.type === 'para') o.text = String(b.text || '');
    if (b.type === 'list') o.items = (b.items || []).map(String);
    if (b.type === 'table') { o.columns = (b.columns || []).map(String); o.rows = (b.rows || []).map((r) => (r || []).map(String)); }
    if (b.type === 'kv') o.entries = (b.entries || []).map((e) => ({ k: String(e.k), v: String(e.v) }));
    return o;
  });
  const langPack = { primary: lang, operator: 'zh', texts: { [lang]: texts } };
  if (texts.blocks && JSON.stringify(langPack).length > LANG_PACK_MAX) {
    /* 超限只丢内容块不丢题：题是账本对齐的根，块缺了 WF 面板退回卡链接看全文。 */
    delete texts.blocks;
    for (const i of items) delete i.block_refs;
    if (opts.log) opts.log('askreg: lang_pack 超 ' + LANG_PACK_MAX + ' 字节，内容块未登记（题照登）');
  }

  return {
    ask_id: 'ask_t' + taskId + '_' + cardKind,
    client_id: Number(task.client_id || opts.clientId),
    kind,
    service,
    audience: 'both',
    rev: Number(opts.rev) > 1 ? Number(opts.rev) : 1,
    deadline,
    default_policy: policy,
    items,
    lang_pack: langPack,
    source_ref: {
      task_id: taskId,
      plan_id: Number(task.plan_id) || undefined,
      card_kind: cardKind,
      card_token_ref: cardTokenRef(taskId, opts.serviceToken),
    },
  };
}

/* plan_approval 审批实体：方案 v2 落库即登记，任一渠道批准或驳回直接生效（Aiden 缺口 B）。
   形态对齐手工先例（ask_plan_approval_67/69）：单 approve 题，item_id plan_approve，
   default_policy none（审批类闸门不自动放行），不设 deadline。 */
function buildPlanApprovalAsk(opts) {
  const planId = Number(opts.planId);
  const summary = String(opts.summary || '').slice(0, 1500);
  /* 泳道标识（2026-10-19 plans service 上线后）：审批卡标题带 SEO/SEM，客户看得出批的是哪条线。
     只收 sem，其余一律按 seo，与服务端 IFNULL 兜底同口径。 */
  const lane = String(opts.service || '').trim().toLowerCase() === 'sem' ? 'SEM' : 'SEO';
  return {
    ask_id: 'ask_plan_approval_' + planId,
    client_id: Number(opts.clientId),
    kind: 'plan_approval',
    audience: 'both',
    rev: 1,
    default_policy: 'none',
    items: [
      {
        item_id: 'plan_approve',
        type: 'approve',
        options: ['approve', 'reject'],
        required: true,
        requires_text_when: ['reject'],
      },
    ],
    lang_pack: {
      primary: 'zh',
      operator: 'zh',
      texts: {
        zh: {
          title: lane + ' 方案 v' + opts.version + ' 审批（plan #' + planId + '）',
          intro: summary,
          default_note: '审批类不自动放行，批准或驳回之前方案保持待批',
          items: {
            plan_approve: {
              prompt: '是否批准这版方案',
              options: { approve: '批准执行', reject: '驳回（请写明原因）' },
            },
          },
        },
      },
    },
    source_ref: { plan_id: planId },
  };
}

async function registerPlanApprovalAsk(opts) {
  const payload = buildPlanApprovalAsk(opts);
  const res = await opts.api.postAsk(payload);
  return { ask_id: payload.ask_id, created: !!(res && res.created), res };
}

/** 出卡后登记。抛错由调用方接住记日志，绝不反噬任务交付。无合规卡数据返回 null。 */
async function registerCardAsk(opts) {
  const { api, task, workspace, cardUrl, log } = opts;
  const cardKind = String((task && task.card_kind) || '').trim();
  if (!cardKind) return null;
  const data = findCardData(cardKind, workspace, log);
  const payload = buildAsk({
    task,
    data,
    cardUrl,
    serviceToken: opts.serviceToken,
    deadline: opts.deadline,
    now: opts.now,
    log,
  });
  if (!payload) {
    if (log) log('askreg: task ' + (task && task.id) + ' 无合规 card_data（' + cardKind + '），不登记 Ask；HTML 卡照常');
    return null;
  }
  const res = await api.postAsk(payload);
  return { ask_id: payload.ask_id, created: !!(res && res.created), res };
}

module.exports = {
  buildAsk,
  registerCardAsk,
  buildPlanApprovalAsk,
  registerPlanApprovalAsk,
  findCardData,
  normalizeCardData,
  adaptLegacyDirection,
  deadlineFromDate,
  cardTokenRef,
  loadCardKinds,
  CARD_KINDS,
  DIRECTION_KINDS,
};
