'use strict';
// Shared machinery for the document style runners (plan, report).
//
// The server has no /plans or /reports write endpoint yet, so the MVP puts the
// full text into the job log for a human to read, and keeps a copy on disk in
// the client workspace. When the endpoints land, call them from the postDraft
// hook below and leave everything else alone.

const fs = require('node:fs');
const path = require('node:path');

const { runClaude } = require('./llm');
const { ensureClientWorkspace } = require('./util');

const OUTPUT_DIRNAME = 'seo-agent-output';
const LOG_CHUNK = 1500;

/** Push a long document into the job log in readable chunks. */
function logDocument(log, title, text) {
  const body = String(text || '');
  log('===== ' + title + ' begin, ' + body.length + ' chars =====');
  for (let i = 0; i < body.length; i += LOG_CHUNK) {
    log(body.slice(i, i + LOG_CHUNK));
  }
  log('===== ' + title + ' end =====');
}

/**
 * Generate a document with Claude, save it, log it, and hand it to an optional
 * postDraft hook for future API persistence.
 * opts: { label, prompt, filePrefix, profile, allowedTools, model, postDraft,
 *         logFullText }
 * logFullText defaults to true. Set it false when the text is persisted through
 * a real API endpoint and does not need to live in the job log as well.
 */
async function generateDraft(ctx, opts) {
  const { cfg, log } = ctx;
  const workspace = ensureClientWorkspace(opts.profile, cfg);
  log('workspace: ' + workspace);

  const res = await runClaude(cfg, {
    prompt: opts.prompt,
    cwd: workspace,
    log,
    model: opts.model || cfg.claudeModel,
    allowedTools: opts.allowedTools || 'Read,Glob,Grep,WebFetch,Bash(curl:*)',
    label: opts.label,
  });

  const text = String(res.stdout || '').trim();
  if (!text) throw new Error(opts.label + ': claude produced no output');

  const outDir = path.join(workspace, OUTPUT_DIRNAME);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, opts.filePrefix + '-' + stamp + '.md');
  fs.writeFileSync(file, text, 'utf8');
  log(opts.label + ': saved to ' + file);

  if (opts.logFullText === false) {
    log(opts.label + ': ' + text.length + ' chars, kept out of the job log, see the file above');
  } else {
    logDocument(log, opts.label.toUpperCase(), text);
  }

  if (typeof opts.postDraft === 'function') {
    await opts.postDraft({ text, file, workspace });
  }
  return { text, file, workspace };
}

module.exports = { generateDraft, logDocument, OUTPUT_DIRNAME };
