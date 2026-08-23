'use strict';
// report runner: draft a monthly client report from the stored snapshots.
//
// MVP: same shape as plan. The draft goes into the job log and onto disk for a
// human to review and send. Extension point marked below.

const { generateDraft } = require('../lib/draft');
const { buildBrief } = require('../lib/brief');
const { reportWindow } = require('../lib/util');

function buildPrompt(brief, period, extraInstructions) {
  return [
    'You are the SEO account manager for a New Zealand digital marketing agency.',
    'Draft the client facing monthly report covering ' + period + '. You are running',
    'headless, nobody can answer questions, so state your assumptions and finish.',
    '',
    brief,
    '',
    extraInstructions || '',
    'WHAT TO PRODUCE',
    '1. Headline summary in plain language a business owner understands, three or four',
    '   sentences, no jargon.',
    '2. Performance section: search clicks and impressions, sessions and users, key',
    '   queries and pages that moved. Quote the actual numbers from the snapshots and say',
    '   which period they cover.',
    '3. What we did this period, mapped to the tasks in the brief and their status.',
    '4. What it means: two or three honest observations, including anything that got',
    '   worse. Flag spam or bot style queries as noise rather than as wins.',
    '5. Next period focus: three to five items, each one sentence.',
    '',
    'RULES',
    'Only use numbers that appear in the brief. If a comparison period is not available,',
    'say so instead of estimating. No promises about rankings or revenue.',
    'English output, markdown. No emoji. No em dash or en dash, use commas, full stops or',
    'semicolons instead.',
  ]
    .filter((s) => s !== '')
    .join('\n');
}

async function run(ctx) {
  const { job, api, log } = ctx;
  const payload = job.payload || {};

  const context = await api.getContext(job.client_id);
  const profile = (context && context.profile) || null;
  if (!profile) throw new Error('context returned no profile for client_id ' + job.client_id);

  const win = reportWindow(Number(payload.window_days) || 28, Number(payload.lag_days) || 3);
  const period = payload.period || win.start + ' to ' + win.end;
  log('reporting period ' + period + ' for ' + (profile.name || job.client_id));

  const brief = buildBrief(context, { includeTasks: true, taskLimit: 60 });
  const prompt = buildPrompt(brief, period, payload.instructions);

  await generateDraft(ctx, {
    label: 'report draft',
    prompt,
    filePrefix: 'report-' + win.end,
    profile,
    postDraft: async () => {
      // Extension point: when the server exposes POST /reports, persist here
      // with { client_id, period_start, period_end, body } and drop the log dump.
      log('report draft kept in job log and on disk for ' + period);
    },
  });

  return { tokenUsage: 0 };
}

module.exports = { run, buildPrompt };
