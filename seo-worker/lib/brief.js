'use strict';
// Turns GET /context into a compact plain text brief for the LLM prompts.
// Shared by plan, report and execute_task so every runner sees the same facts.

const { safeJson, truncate } = require('./util');

function line(label, value) {
  if (value === undefined || value === null || value === '') return null;
  return label + ': ' + String(value);
}

function profileBlock(profile) {
  if (!profile) return 'Client profile: not available.';
  const p = profile;
  const rows = [
    line('Name', p.name || p.client_name),
    line('Website', p.website || p.domain || p.url),
    line('Market', p.market || p.country),
    line('Industry', p.industry || p.vertical),
    line('GSC property', p.gsc_property),
    line('GA4 property', p.ga4_property),
    line('Target keywords', p.target_keywords),
    line('Priority pages', p.priority_pages),
    line('Notes', truncate(p.notes || p.brief || '', 1200)),
  ].filter(Boolean);
  return 'CLIENT PROFILE\n' + (rows.length ? rows.join('\n') : 'no fields set');
}

function planBlock(activePlan) {
  if (!activePlan) return 'ACTIVE PLAN\nnone on record';
  const p = activePlan;
  const body = p.body || p.content || p.summary || '';
  const rows = [
    line('Title', p.title),
    line('Period', (p.period_start || '?') + ' to ' + (p.period_end || '?')),
    line('Status', p.status),
  ].filter(Boolean);
  return 'ACTIVE PLAN\n' + rows.join('\n') + (body ? '\n' + truncate(String(body), 3000) : '');
}

function taskLine(t) {
  const bits = [
    '#' + t.id,
    '[' + (t.status || 'unknown') + ']',
    t.title || t.name || '(untitled)',
  ];
  if (t.due_date) bits.push('due ' + t.due_date);
  if (t.priority) bits.push('priority ' + t.priority);
  return '- ' + bits.join(' ');
}

function tasksBlock(tasks, limit) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!list.length) return 'TASKS\nnone on record';
  const shown = list.slice(0, limit || 40).map(taskLine);
  const more = list.length > shown.length ? '\n(and ' + (list.length - shown.length) + ' more)' : '';
  return 'TASKS\n' + shown.join('\n') + more;
}

function snapshotBlock(latest) {
  const snaps = Array.isArray(latest) ? latest : latest ? Object.values(latest) : [];
  if (!snaps.length) return 'LATEST DATA SNAPSHOTS\nnone on record, run a pull_data job first';
  const out = [];
  for (const snap of snaps) {
    if (!snap) continue;
    const data = safeJson(snap.data, {}) || {};
    const head = [
      (snap.source || 'unknown').toUpperCase(),
      (snap.period_start || '?') + ' to ' + (snap.period_end || '?'),
    ].join(' ');
    const parts = [head];
    if (data.totals) parts.push('totals: ' + JSON.stringify(data.totals));
    if (Array.isArray(data.queries) && data.queries.length) {
      const top = data.queries
        .slice(0, 15)
        .map(
          (q) =>
            q.query +
            ' (clicks ' +
            q.clicks +
            ', impr ' +
            q.impressions +
            ', pos ' +
            Number(q.position).toFixed(1) +
            ')'
        );
      parts.push('top queries: ' + top.join('; '));
    }
    if (Array.isArray(data.pages) && data.pages.length) {
      const top = data.pages
        .slice(0, 10)
        .map((p) => p.page + ' (clicks ' + p.clicks + ', impr ' + p.impressions + ')');
      parts.push('top pages: ' + top.join('; '));
    }
    if (Array.isArray(data.channels) && data.channels.length) {
      const top = data.channels
        .slice(0, 10)
        .map((c) => c.sessionDefaultChannelGroup + ' (sessions ' + c.sessions + ')');
      parts.push('channels: ' + top.join('; '));
    }
    out.push(parts.join('\n'));
  }
  return 'LATEST DATA SNAPSHOTS\n' + out.join('\n\n');
}

/**
 * Build the shared brief. opts: { includeTasks, taskLimit }
 * Kept plain text on purpose so it survives being passed as a CLI argument.
 */
function buildBrief(context, opts = {}) {
  const ctx = context || {};
  const blocks = [profileBlock(ctx.profile), planBlock(ctx.active_plan)];
  if (opts.includeTasks !== false) blocks.push(tasksBlock(ctx.tasks, opts.taskLimit));
  blocks.push(snapshotBlock(ctx.latest_snapshots));
  return blocks.join('\n\n');
}

module.exports = { buildBrief, profileBlock, planBlock, tasksBlock, snapshotBlock };
