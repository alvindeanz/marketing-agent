'use strict';
// Pulling structured blocks back out of model prose.
//
// Models put fenced blocks in markdown. These helpers are deliberately
// forgiving about what surrounds the fence and strict about what comes out.

/**
 * Find the last ```<lang> fenced block.
 * Returns { found, raw, body } where body is everything before the fence.
 */
function extractLastFence(text, lang) {
  const source = String(text || '');
  const marker = '```' + lang;
  const fence = source.lastIndexOf(marker);
  if (fence === -1) return { found: false, raw: '', body: source.trim() };
  const afterFence = source.indexOf('\n', fence);
  if (afterFence === -1) return { found: false, raw: '', body: source.slice(0, fence).trim() };
  const close = source.indexOf('```', afterFence);
  const raw = close === -1 ? source.slice(afterFence + 1) : source.slice(afterFence + 1, close);
  return { found: true, raw, body: source.slice(0, fence).trim() };
}

/**
 * Find the last ```json block and parse it.
 * Returns { body, json, error }. body is what should be stored as prose.
 */
function extractTrailingJson(text) {
  const found = extractLastFence(text, 'json');
  if (!found.found) {
    return { body: found.body, json: null, error: 'no ```json block found in the output' };
  }
  try {
    return { body: found.body, json: JSON.parse(found.raw), error: null };
  } catch (e) {
    return { body: found.body, json: null, error: 'json block did not parse :: ' + e.message };
  }
}

/**
 * Read a fenced block as a list of non empty, non comment lines.
 * Used for the discover NEEDS block, where each line is one gate command.
 */
function extractFencedLines(text, lang) {
  const found = extractLastFence(text, lang);
  if (!found.found) return { found: false, lines: [], body: found.body };
  const lines = found.raw
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter((l) => l && !l.startsWith('#'));
  return { found: true, lines, body: found.body };
}

module.exports = { extractLastFence, extractTrailingJson, extractFencedLines };
