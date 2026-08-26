'use strict';
// Platform capability manifests: specs/capabilities/{platform}.md
//
// The manifest is the contract between what a plan may propose and what an
// agent may actually do. Planning only ever sees the planning view table, the
// short one. Execute and apply stages get the full document, because that is
// where the risk notes and the endpoint detail matter.

const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'specs', 'capabilities');
const START = '<!-- PLANNING_VIEW_START -->';
const END = '<!-- PLANNING_VIEW_END -->';

// agent_readonly: the agent may run it, but it is a read, so execute_task takes
// it through analysis mode in one pass (no change plan, no apply stage). Added
// 2026-08-26 after a gsc-audit task spent 12 minutes writing a plan for a read.
const AUTONOMY_LEVELS = ['agent_apply', 'agent_prepare', 'agent_readonly', 'human_only'];

function slugPlatform(platform) {
  return String(platform || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '');
}

/** Read the manifest for a platform. Returns { found, platform, file, text }. */
function loadManifest(platform) {
  const slug = slugPlatform(platform);
  if (!slug) return { found: false, platform: slug, file: null, text: '' };
  const file = path.join(DIR, slug + '.md');
  try {
    return { found: true, platform: slug, file, text: fs.readFileSync(file, 'utf8') };
  } catch (e) {
    return { found: false, platform: slug, file, text: '' };
  }
}

/**
 * The planning view: the operation table between the markers, and nothing else.
 * This is the only part that ever reaches a planning prompt.
 */
function planningView(platform) {
  const manifest = loadManifest(platform);
  if (!manifest.found) return { found: false, platform: manifest.platform, text: '' };
  const start = manifest.text.indexOf(START);
  const end = manifest.text.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    return { found: false, platform: manifest.platform, text: '', error: 'markers missing' };
  }
  return {
    found: true,
    platform: manifest.platform,
    text: manifest.text.slice(start + START.length, end).trim(),
  };
}

/** Operation names and autonomy levels, parsed out of the planning view table. */
function operations(platform) {
  const view = planningView(platform);
  if (!view.found) return [];
  const out = [];
  for (const line of view.text.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // | name | autonomy | note |  ->  ['', name, autonomy, note, '']
    if (cells.length < 4) continue;
    const name = cells[1];
    const autonomy = cells[2];
    if (!name || name === 'operation' || /^-+$/.test(name)) continue;
    if (!AUTONOMY_LEVELS.includes(autonomy)) continue;
    out.push({ name, autonomy, note: cells[3] || '' });
  }
  return out;
}

function operationNames(platform) {
  return operations(platform).map((o) => o.name);
}

function autonomyOf(platform, name) {
  const hit = operations(platform).find((o) => o.name === name);
  return hit ? hit.autonomy : null;
}

/** The full manifest text, for the execute and apply stages only. */
function fullText(platform) {
  return loadManifest(platform).text;
}

/**
 * The manifest section for one operation, sliced from its `## name` heading to
 * the next heading of the same or higher level. Used to keep an execute prompt
 * focused on the operations a task actually needs.
 */
function sectionFor(platform, name) {
  const text = fullText(platform);
  if (!text || !name) return '';
  const lines = text.split('\n');
  const startIdx = lines.findIndex((l) => l.trim() === '## ' + name);
  if (startIdx === -1) return '';
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (/^#{1,2} /.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join('\n').trim();
}

/** The global risk notes block, which every execute and apply prompt carries. */
function riskNotes(platform) {
  const text = fullText(platform);
  if (!text) return '';
  const start = text.indexOf('## 全局风险注记');
  if (start === -1) return '';
  const rest = text.slice(start);
  const next = rest.indexOf('\n## ', 3);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

module.exports = {
  loadManifest,
  planningView,
  operations,
  operationNames,
  autonomyOf,
  fullText,
  sectionFor,
  riskNotes,
  slugPlatform,
  AUTONOMY_LEVELS,
  DIR,
};
