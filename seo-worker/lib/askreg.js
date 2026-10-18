'use strict';
/* 出卡登记 Ask（2026-10-18，契约：/mnt/share/aiden/to-aira-asks-contract-20261016.md）。
   卡是渲染，Ask 是待答实体：execute 出卡后把卡登记成 Ask，WF 后台 AsksPanel 与
   agencyreport 邮件卡页才能答同一批题、写同一本账。
   硬口径：登记失败不挡出卡（调用方兜 try，重登是幂等 upsert）；card_token_ref 只传
   指纹不传明文；deadline 用出卡锚点加 14 天，补登也不用补登时刻。 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIRECTION_KINDS = ['keyword_direction', 'creative_direction'];
const DEADLINE_DAYS = 14;
const DATA_FRESH_MS = 6 * 3600 * 1000; // 与客户版 HTML 发布同窗：只认本轮产物

function cardTokenRef(taskId, serviceToken) {
  // 与 lib/publish.injectCardToken 同源派生，取 sha256 前 16 位做指纹（契约 §2 硬约束）。
  const tok = crypto.createHash('md5').update('cardfb' + taskId + String(serviceToken || '')).digest('hex');
  return 'sha256:' + crypto.createHash('sha256').update(tok).digest('hex').slice(0, 16);
}

/* 方向卡的 data JSON 由 agent 写在 reports/ 或 seo-agent-output/，文件名含卡类前缀。
   只认 6 小时内的新鲜产物，多份取最新；读不到返回 null，登记降级为 approve 单题。 */
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
    if (log) log('askreg: ' + path.basename(best.file) + ' 不是合法 JSON，降级 approve 单题 :: ' + e.message);
    return null;
  }
}

function isoPlusDays(days, now) {
  return new Date((now || Date.now()) + days * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/* 否词勾选项是词条字符串直接当选项码：契约只禁逗号，再按长度收一道。
   有一个不合规就整段不出 multi 题（否词段 required false，缺了不挡答齐）。 */
function cleanNegatives(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const s = String(raw || '').trim();
    if (!s || s.indexOf(',') !== -1 || s.length > 60) return null;
    if (out.indexOf(s) === -1) out.push(s);
  }
  return out.length ? out : null;
}

/** 纯函数：从任务与卡数据拼 POST /asks 的 payload。测试直接打它。 */
function buildAsk(opts) {
  const task = opts.task || {};
  const cardKind = String(task.card_kind || '').trim();
  const taskId = Number(task.id);
  const isDirection = DIRECTION_KINDS.indexOf(cardKind) !== -1;
  const data = isDirection ? opts.data || null : null;
  const cardLine = opts.cardUrl ? '卡片全文：' + opts.cardUrl : '卡片全文随邮件送达。';

  const items = [];
  const itemTexts = {};

  if (isDirection && data && Array.isArray(data.decisions) && data.decisions.length) {
    for (const dec of data.decisions) {
      const id = String(dec.item || '').trim();
      if (!id) continue;
      items.push({
        item_id: id,
        type: 'single',
        options: ['agree', 'hold', 'other'],
        required: true,
        requires_text_when: ['other'],
        default_value: 'agree',
      });
      itemTexts[id] = {
        prompt: String(dec.q || id),
        situation: String(dec.situation || ''),
        recommendation: String(dec.recommendation || ''),
        hint: String(dec.textarea_hint || ''),
        options: { agree: '同意建议', hold: '保持现状', other: '其他（请写两句）' },
      };
    }
    const negs = cleanNegatives(data.negatives);
    if (negs) {
      items.push({ item_id: 'negatives', type: 'multi', options: negs, required: false });
      itemTexts.negatives = { prompt: '需要排除的词（勾选后我们不再投入）' };
    }
  }

  if (!items.length) {
    // 确认卡与缺 data 的降级形态：单题 approve，驳回必须给原因。
    items.push({
      item_id: 'approval',
      type: 'approve',
      options: ['approve', 'reject'],
      required: true,
      requires_text_when: ['reject'],
    });
    itemTexts.approval = {
      prompt: '这张确认卡的结论是否通过',
      options: { approve: '确认通过', reject: '驳回（请写明原因）' },
    };
  }

  items.push({ item_id: 'global_note', type: 'text', options: [], required: false });
  itemTexts.global_note = { prompt: '其他留言（可选）' };

  const deadline = opts.deadline || isoPlusDays(DEADLINE_DAYS, opts.now);
  const payload = {
    ask_id: 'ask_t' + taskId + '_' + cardKind,
    client_id: Number(task.client_id || opts.clientId),
    kind: isDirection ? 'direction' : 'confirmation',
    audience: 'both',
    rev: 1,
    deadline,
    items,
    /* 渲染器现阶段中文写死（语言跟随是 Phase 2 产出侧的活），primary 显式 zh，
       免得 report_lang=en 的客户拿到一包货不对板的 texts。 */
    lang_pack: {
      primary: 'zh',
      operator: 'zh',
      texts: {
        zh: {
          title: String((data && data.title) || task.title || cardKind),
          intro: [String((data && data.oneline) || ''), cardLine].filter(Boolean).join('\n'),
          deadline_note: '截止 ' + deadline.slice(0, 10) + '（UTC）',
          default_note: '到期未回复按卡上建议执行',
          items: itemTexts,
        },
      },
    },
    source_ref: {
      task_id: taskId,
      plan_id: Number(task.plan_id) || undefined,
      card_kind: cardKind,
      card_token_ref: cardTokenRef(taskId, opts.serviceToken),
    },
  };
  return payload;
}

/** 出卡后登记。抛错由调用方接住记日志，绝不反噬任务交付。 */
async function registerCardAsk(opts) {
  const { api, task, workspace, cardUrl, log } = opts;
  const cardKind = String((task && task.card_kind) || '').trim();
  if (!cardKind) return null;
  const data = DIRECTION_KINDS.indexOf(cardKind) !== -1 ? findCardData(cardKind, workspace, log) : null;
  const payload = buildAsk({
    task,
    data,
    cardUrl,
    serviceToken: opts.serviceToken,
    deadline: opts.deadline,
    now: opts.now,
  });
  const res = await api.postAsk(payload);
  return { ask_id: payload.ask_id, created: !!(res && res.created), res };
}

module.exports = { buildAsk, registerCardAsk, findCardData, cardTokenRef, cleanNegatives, DIRECTION_KINDS };
