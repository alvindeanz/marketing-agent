'use strict';
// Thin client for the ops-tracker SEO agent API (seo-api.php).

const { requestJson, downloadTo } = require('./http');

class Api {
  constructor(cfg) {
    this.base = cfg.apiBase;
    this.token = cfg.serviceToken;
    this.timeoutMs = cfg.httpTimeoutMs || 60000;
  }

  async req(method, path, body) {
    return requestJson(this.base + path, {
      method,
      body,
      timeoutMs: this.timeoutMs,
      headers: {
        Authorization: 'Bearer ' + this.token,
        Accept: 'application/json',
      },
    });
  }

  /** POST /jobs/claim -> { job: {...} } or { job: null } */
  async claimJob() {
    const res = await this.req('POST', '/jobs/claim', {});
    return res && res.job ? res.job : null;
  }

  /** PATCH /jobs/{id} body { status?, log_append?, token_usage? } */
  async patchJob(id, body) {
    return this.req('PATCH', '/jobs/' + encodeURIComponent(id), body);
  }

  /** POST /tasks/{id}/result body { output_url, note } */
  async postTaskResult(id, body) {
    return this.req('POST', '/tasks/' + encodeURIComponent(id) + '/result', body);
  }

  /** POST /plans body { client_id, body, authored_by } -> { ok, id, version } */
  async postPlan(body) {
    return this.req('POST', '/plans', body);
  }

  /**
   * POST /tasks/bulk body { client_id, plan_id, tasks: [...] } -> { ok, ids }
   * Server caps a batch at 20 and rejects the whole batch on a validation error.
   */
  async postTasksBulk(body) {
    return this.req('POST', '/tasks/bulk', body);
  }

  /**
   * POST /tasks/{id}/complete body { note } -> marks the task done.
   * Only apply_task calls this, and only after its own verification passed.
   */
  async completeTask(id, body) {
    return this.req('POST', '/tasks/' + encodeURIComponent(id) + '/complete', body);
  }

  /**
   * POST /facts body { client_id, fact_key, value }
   * Stored as source=agent, status=unconfirmed, upserted on (client_id, fact_key).
   * A fact a human already confirmed is never overwritten, the response says so
   * with a skipped flag.
   */
  async postFact(clientId, factKey, value) {
    return this.req('POST', '/facts', {
      client_id: clientId,
      fact_key: factKey,
      value,
    });
  }

  /**
   * POST /facts body { client_id, facts: [{ fact_key, value }], feedback_id }
   * Batch write, server caps it at 50. With feedback_id the facts came out of a
   * human note, so the server stores them confirmed under the feedback row's
   * own source and lets them overwrite an existing confirmed value.
   */
  async postFacts(clientId, facts, feedbackId) {
    const body = { client_id: clientId, facts };
    if (feedbackId) body.feedback_id = feedbackId;
    return this.req('POST', '/facts', body);
  }

  /**
   * POST /tasks/{id}/feedback_result
   * body { feedback_id, summary, complete } on a successful parse, or
   * body { feedback_id, failed: true, error } when the note could not be parsed.
   */
  async postTaskFeedbackResult(taskId, body) {
    return this.req('POST', '/tasks/' + encodeURIComponent(taskId) + '/feedback_result', body);
  }

  /**
   * GET /feedback_file/{name} -> the screenshot bytes, written to destPath.
   * The images sit outside the webroot, this endpoint is the only way in and it
   * wants the service token like everything else here.
   */
  async downloadFeedbackImage(name, destPath) {
    return downloadTo(this.base + '/feedback_file/' + encodeURIComponent(name), destPath, {
      timeoutMs: this.timeoutMs,
      maxBytes: 8 * 1024 * 1024,
      headers: {
        Authorization: 'Bearer ' + this.token,
        Accept: 'image/*',
      },
    });
  }

  /** POST /snapshots body { client_id, source, period_start, period_end, data } */
  async postSnapshot(body) {
    return this.req('POST', '/snapshots', body);
  }

  /**
   * GET /snapshots?client_id=&source=&limit= -> history list without the full
   * data blob. Use getSnapshot for the body of one row.
   */
  async listSnapshots(params = {}) {
    const q = [];
    if (params.client_id !== undefined) q.push('client_id=' + encodeURIComponent(params.client_id));
    if (params.source) q.push('source=' + encodeURIComponent(params.source));
    if (params.limit) q.push('limit=' + encodeURIComponent(params.limit));
    return this.req('GET', '/snapshots' + (q.length ? '?' + q.join('&') : ''));
  }

  /** GET /snapshots/{id} -> one snapshot including its full data */
  async getSnapshot(id) {
    return this.req('GET', '/snapshots/' + encodeURIComponent(id));
  }

  /** GET /context?client_id= -> { profile, active_plan, tasks, latest_snapshots } */
  async getContext(clientId) {
    return this.req('GET', '/context?client_id=' + encodeURIComponent(clientId));
  }

  /**
   * GET /jobs?client_id=&limit= -> { jobs: [...] } newest first.
   * The worker sees a narrower row than the console: no payload, no created_by.
   * Read only, used by triage to see what has been failing.
   */
  async listJobs(clientId, limit) {
    const q = '/jobs?client_id=' + encodeURIComponent(clientId) + (limit ? '&limit=' + encodeURIComponent(limit) : '');
    return this.req('GET', q);
  }

  /**
   * GET /attention?client_id= ->
   * { flagged_tasks, client_open, failed_jobs, pending_facts_count }
   */
  async getAttention(clientId) {
    return this.req('GET', '/attention?client_id=' + encodeURIComponent(clientId));
  }

  /** GET /facts?client_id= -> { facts: [...] } including status and source. */
  async listFacts(clientId) {
    return this.req('GET', '/facts?client_id=' + encodeURIComponent(clientId));
  }

  /**
   * GET /blog_review_watch -> { tasks: [...] }
   * Blog tasks in review with a preview link, across every client. The only
   * cross client read the worker has, and it exists for the review sweep.
   */
  async listBlogReviewWatch() {
    return this.req('GET', '/blog_review_watch');
  }

  /**
   * POST /tasks/{id}/revise -> { ok, job_id }
   * Ask for one execute_task pass on a single blog task the client sent back.
   * 409 when an execute_task for that client is already queued or running, which
   * the caller should treat as "try again next tick", not as an error.
   */
  async requestRevise(taskId, reason) {
    return this.req('POST', '/tasks/' + encodeURIComponent(taskId) + '/revise', { reason: reason || '' });
  }
}

module.exports = { Api };
