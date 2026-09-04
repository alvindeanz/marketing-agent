'use strict';
// Thin client for the ops-tracker SEO agent API (seo-api.php).

const { requestJson, downloadTo, postMultipart } = require('./http');

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

  /**
   * POST /jobs/claim body { lane? } -> { job: {...} } or { job: null }
   * lane 'heavy' | 'light' restricts the pick to that lane's job types (see
   * lib/lanes.js). Omitted means any type, which is what a single drain did
   * before the lanes existed; the server treats it the same way.
   */
  async claimJob(lane) {
    const res = await this.req('POST', '/jobs/claim', lane ? { lane } : {});
    return res && res.job ? res.job : null;
  }

  /** POST /jobs/reap -> 启动收尸：把上一世遗留的 running 孤儿行判 failed，返回 {reaped:[ids]} */
  async reapJobs() {
    return this.req('POST', '/jobs/reap', {});
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

  /**
   * POST /tasks/{id}/deliverables -> upload one finished file for a human to
   * collect off the board. multipart, field "file", plus a "name" field so the
   * server does not have to trust the multipart filename.
   * The server replaces an earlier upload with the same name on the same task,
   * so re-running a task does not stack copies on the card.
   * Returns { ok, id, orig_name, stored_name, bytes, mime, replaced, orphan_files }.
   */
  async uploadTaskDeliverable(taskId, opts) {
    return postMultipart(this.base + '/tasks/' + encodeURIComponent(taskId) + '/deliverables', {
      timeoutMs: this.timeoutMs,
      headers: {
        Authorization: 'Bearer ' + this.token,
        Accept: 'application/json',
      },
      fields: { name: opts.filename },
      file: {
        field: 'file',
        filename: opts.filename,
        contentType: opts.contentType || 'application/octet-stream',
        buffer: opts.buffer,
      },
    });
  }

  /** GET /tasks/{id}/deliverables -> { deliverables: [...] } oldest first. */
  async listTaskDeliverables(taskId) {
    return this.req('GET', '/tasks/' + encodeURIComponent(taskId) + '/deliverables');
  }

  /** POST /snapshots body { client_id, source, period_start, period_end, data } */
  async postSnapshot(body) {
    return this.req('POST', '/snapshots', body);
  }

  /**
   * POST /metrics body { client_id, rows: [{ d, m, v }] } -> { ok, rows }
   * 日粒度时序的批量 upsert，幂等：服务端靠 UNIQUE(client_id,d,m) 覆盖同名同日的值，
   * 所以同一窗口重跑多少次结果都一样。服务端单批上限 2000 行，调用方自己分块。
   */
  async postMetrics(clientId, rows) {
    return this.req('POST', '/metrics', { client_id: clientId, rows });
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

  /**
   * POST /tasks/review_result body { client_id, job_id, summary, verdicts: [...] }
   * -> { ok, written }. review_plan 的唯一写操作：把 fable 的判决落到任务行上，
   * 不改任何任务状态。状态改动只发生在人点「按推荐执行」之后的 admin 端点。
   */
  /** GET /plans/{id} -> { plan, tasks }，plan_review 读草稿全文用。 */
  async getPlan(id) {
    return this.req('GET', '/plans/' + encodeURIComponent(id));
  }

  /** POST /plans/{id}/review_result body { body, tasks, changes, card } -> { plan_id, version, ids, closed, card_id } */
  async postPlanReviewResult(id, body) {
    return this.req('POST', '/plans/' + encodeURIComponent(id) + '/review_result', body);
  }

  async postReviewResult(body) {
    return this.req('POST', '/tasks/review_result', body);
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

  /**
   * GET /inbox/{id} -> { item, replies, ref_tasks }
   * One decision inbox row plus the task rows its refs point at. This is the
   * only read the ruling runner needs: it never enumerates the board.
   */
  async getInboxItem(id) {
    return this.req('GET', '/inbox/' + encodeURIComponent(id));
  }

  /**
   * POST /inbox body { client_id, kind: 'digest'|'ack', body, refs, reply_to, resolve }
   * The worker may only write a digest or an ack. A ruling is a human's own
   * words and can only be created through the admin endpoint.
   * resolve carries a digest id to settle in the same call.
   */
  async postInbox(body) {
    return this.req('POST', '/inbox', body);
  }

  /**
   * POST /inbox/{id}/actions body { ruling_id, actions: [...] } -> { results }
   * Hands the server the action list read out of one ruling. The server owns
   * the whitelist and the refs scope check; nothing is executed on this side.
   * Individual actions may be refused, which is reported per action rather
   * than as a request failure.
   */
  async postInboxActions(digestId, body) {
    return this.req('POST', '/inbox/' + encodeURIComponent(digestId) + '/actions', body);
  }

  /**
   * POST /inbox/{root_id}/chat_reply body { body, drafts? } -> { message_id, drafts }
   * 收件箱对话里 opus 的一条回复。drafts 是任务草案，服务端原样规整后存进
   * 这一行的 refs.drafts，不会建任何任务：草案要人在界面上点「立项」才落账。
   * 这是 chat runner 唯一的写操作，除此之外整条链路只读。
   */
  /* body.actions（任务线程里模型提议的动作）随 drafts 一起原样交给服务端规整存进 refs。 */
  async postChatReply(rootId, body) {
    return this.req('POST', '/inbox/' + encodeURIComponent(rootId) + '/chat_reply', body);
  }

  /**
   * POST /reports body
   * { client_id, period_type, period_start, period_end, url, html_path,
   *   facts_pack, narrative_status } -> { ok, id, version }
   * 版本号由服务端按 (client_id, period_type, period_start) 取 MAX+1，
   * worker 自己算的版本号只用来先起个文件名，最终以这里返回的 version 为准。
   */
  async postReport(body) {
    return this.req('POST', '/reports', body);
  }

  /**
   * GET /reports?client_id= -> { reports: [...] }
   * 按 period_start 降序、version 降序，不带 facts_pack 正文（只有 has_pack 标记）。
   */
  async listReports(clientId) {
    return this.req('GET', '/reports?client_id=' + encodeURIComponent(clientId));
  }

  /**
   * GET /metrics?client_id=&from=&to=&metrics= ->
   * { ok, from, to, metrics: { <name>: [{ d, v }] } }
   * 缺的日子不补零，请求过的指标即使无数据也回空数组。
   * 端点在改成 auth_any 之前对 worker 回 403，调用方要自己兜住并把趋势块留空。
   */
  async getMetrics(clientId, from, to, metrics) {
    const q = ['client_id=' + encodeURIComponent(clientId)];
    if (from) q.push('from=' + encodeURIComponent(from));
    if (to) q.push('to=' + encodeURIComponent(to));
    if (metrics && metrics.length) {
      q.push('metrics=' + encodeURIComponent(Array.isArray(metrics) ? metrics.join(',') : metrics));
    }
    return this.req('GET', '/metrics?' + q.join('&'));
  }

  /**
   * GET /events?client_id=&from=&to= -> { ok, from, to, events: [{ d, label, kind }] }
   * 动作标注，零新表，从任务、facts、job 完成时刻推导。
   * 同 getMetrics，改成 auth_any 之前对 worker 回 403。
   */
  async getEvents(clientId, from, to) {
    const q = ['client_id=' + encodeURIComponent(clientId)];
    if (from) q.push('from=' + encodeURIComponent(from));
    if (to) q.push('to=' + encodeURIComponent(to));
    return this.req('GET', '/events?' + q.join('&'));
  }

  /**
   * GET /tasks?client_id= -> { tasks: [...] } 每行带 deliverables。
   * 注意：这个端点是 auth_admin，worker 的服务令牌拿不到，调用必然 403。
   * worker 侧要任务列表请改用 getContext(clientId).tasks，那条支路是 auth_worker，
   * 字段够用（id、title、status、module、priority、result_note、updated_at）。
   * 这个方法留着只为将来端点放开权限时不用再补，现在别在 runner 里直接依赖它。
   */
  async getTasks(clientId) {
    return this.req('GET', '/tasks?client_id=' + encodeURIComponent(clientId));
  }
}

module.exports = { Api };
