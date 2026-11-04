'use strict';
// 等人件逾期通知（2026-11-04 Alvin 定）：真正等人的任务停超时限就发邮件给对应负责人，
// SEM（module=paid）归 Monica，SEO 归 Summer。发信走 seo-api /ops_notify（Resend key 在
// 250 不出机器），本文件只做纯判定与邮件装配（零网络，好测）；调用与盖章在 harness。
//
// 口径：
// - 确认闸（2026-11-04 Alvin 补刀「只有我们走到最后，我确认真正等人的才追」）：任务 note 里
//   必须有 [确认等人 YYYY-MM-DD] 戳才进追人面。戳由 Alvin 在清单上逐项确认后盖，
//   没戳的一律不追，不管停了多久。误盖出口：把戳行改成 [确认等人撤销] 即退出追人面。
// - 只认真正等人的阻塞类别（HUMAN_KINDS），机器环节（待判/判决过期/执行失败）不发人。
// - 首发：任务停滞（updated_at 起算，确认盖章也会 bump 它）满 OVERDUE_DAYS 天，
//   即确认后再停 3 天才发第一封。
// - 重发：note 里最后一枚 [逾期通知 YYYY-MM-DD → role] 戳满 RENOTIFY_DAYS 天且仍在等人。
//   盖章会 bump updated_at，所以有戳后一律按戳算，不回看 updated_at。

const HUMAN_KINDS = ['人工任务', '待人工验证', '待人工配图', '需要人定'];
const OVERDUE_DAYS = 3;
const RENOTIFY_DAYS = 7;
const STAMP_RE = /\[逾期通知 (\d{4}-\d{2}-\d{2}) → (sem|seo)\]/g;
const CONFIRM_RE = /\[确认等人 \d{4}-\d{2}-\d{2}[^\]]*\]/;
const CONFIRM_REVOKE_RE = /\[确认等人撤销/;

function roleOf(task) {
  return String((task && task.module) || '') === 'paid' ? 'sem' : 'seo';
}

/**
 * tasks：本轮窗口内任务（带 result_note / updated_at / module / title / output_url）。
 * blockers：harness 已算好的阻塞清单 [{id,kind,text}]。
 * now：毫秒时间戳。
 * 返回 { sem: [item], seo: [item] }，item = {id,title,kind,text,days,url}。
 */
function decideNotify(tasks, blockers, now) {
  const byId = new Map((tasks || []).map((t) => [Number(t.id), t]));
  const seen = new Set();
  const out = { sem: [], seo: [] };
  for (const b of blockers || []) {
    if (HUMAN_KINDS.indexOf(b.kind) === -1) continue;
    if (seen.has(Number(b.id))) continue;
    const t = byId.get(Number(b.id));
    if (!t) continue;
    const note = String(t.result_note || '');
    if (!CONFIRM_RE.test(note) || CONFIRM_REVOKE_RE.test(note)) continue; // 确认闸：没盖 [确认等人] 或已撤销的不追
    const stamps = [...note.matchAll(STAMP_RE)];
    let due = false;
    let days = 0;
    if (stamps.length) {
      const last = Date.parse(stamps[stamps.length - 1][1] + 'T00:00:00+13:00');
      days = Math.floor((now - last) / 86400000);
      due = days >= RENOTIFY_DAYS;
    } else {
      const upd = Date.parse(String(t.updated_at || t.created_at || '').replace(' ', 'T') + 'Z');
      if (!isNaN(upd)) {
        days = Math.floor((now - upd) / 86400000);
        due = days >= OVERDUE_DAYS;
      }
    }
    if (!due) continue;
    seen.add(Number(b.id));
    const url = (note.match(/预览: (\S+)/) || [])[1] || String(t.output_url || '');
    out[roleOf(t)].push({
      id: Number(b.id),
      title: String(t.title || ''),
      kind: String(b.kind || ''),
      text: String(b.text || ''),
      days,
      url,
    });
  }
  return out;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 装配一封给单一角色的邮件。对外同事可读：不带内部行话，不带 token 链接以外的内部细节。 */
function buildEmail(clientName, role, items, dateStr) {
  const who = role === 'sem' ? 'SEM' : 'SEO';
  const subject = '[等人件提醒] ' + clientName + ' 有 ' + items.length + ' 项 ' + who + ' 任务等人处理';
  const rows = items
    .map(
      (it) =>
        '<li style="margin:8px 0"><b>#' + it.id + '</b> ' + esc(it.title) +
        '<br>等待原因：' + esc(it.kind) + (it.text ? '（' + esc(it.text) + '）' : '') +
        '，已等 ' + it.days + ' 天' +
        (it.url ? '<br><a href="' + esc(it.url) + '">查看</a>' : '') +
        '</li>'
    )
    .join('');
  const html =
    '<div style="font-family:sans-serif;font-size:14px;color:#222;line-height:1.6">' +
    '<p>你好，' + esc(clientName) + ' 的以下任务在等人处理，已超时限（' + esc(dateStr) + ' 盘点）：</p>' +
    '<ul style="padding-left:18px">' + rows + '</ul>' +
    '<p>处理完或有疑问请在看板对应任务上备注。此邮件由看板自动盘点发出，处理前任务持续计时，每 7 天提醒一次。</p>' +
    '</div>';
  return { subject, html };
}

module.exports = { decideNotify, buildEmail, roleOf, HUMAN_KINDS, OVERDUE_DAYS, RENOTIFY_DAYS, CONFIRM_RE };
