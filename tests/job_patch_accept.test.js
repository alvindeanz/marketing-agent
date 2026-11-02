'use strict';
/* PATCH /jobs/{id} 回包验收（2026-11-02 job 11718 事故）：PHP fatal 回 HTTP 200 加错误文本，
   worker 只验 2xx 当成功，终态丢失、pending_terminal 补投全程没触发。
   本测用本地 http server 回放各种回包，验 Api.patchJob 只认 JSON 且 ok === true。不出网。 */
const assert = require('node:assert');
const http = require('node:http');
const { Api, acceptJobPatch } = require('../seo-worker/lib/api');

function server(status, bodyText, ctype) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, body: raw });
      res.writeHead(status, { 'Content-Type': ctype || 'application/json' });
      res.end(bodyText);
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, hits }));
  });
}

async function patchAgainst(status, bodyText, ctype) {
  const { srv, port, hits } = await server(status, bodyText, ctype);
  const api = new Api({ apiBase: 'http://127.0.0.1:' + port + '/seo-api.php', serviceToken: 't', httpTimeoutMs: 5000 });
  try {
    const r = await api.patchJob(11718, { status: 'done', log_append: 'x' });
    return { r, hits };
  } catch (e) {
    return { e, hits };
  } finally {
    srv.close();
  }
}

let n = 0;
async function t(name, fn) {
  await fn();
  n += 1;
  console.log('  ok   ' + name);
}

(async () => {
  await t('HTTP 200 但正文是 PHP Fatal 文本：必须抛错', async () => {
    const fatal = '<br />\n<b>Fatal error</b>:  Uncaught PDOException: SQLSTATE[HY000]: General error: 1205 Lock wait timeout exceeded in /www/wwwroot/always/seo-api.php:2745';
    const { e, hits } = await patchAgainst(200, fatal, 'text/html');
    assert.ok(e, '应抛错');
    assert.ok(/HTTP 200/.test(e.message), '错误要带状态码');
    assert.ok(e.message.includes('Fatal error'), '错误要带正文片段');
    assert.strictEqual(e.status, 200);
    assert.strictEqual(hits.length, 1, '不重试');
    assert.strictEqual(hits[0].method, 'PATCH');
    assert.strictEqual(hits[0].url, '/seo-api.php/jobs/11718');
  });

  await t('HTTP 200 JSON 但无 ok：必须抛错', async () => {
    const { e } = await patchAgainst(200, JSON.stringify({ job: null }));
    assert.ok(e, '应抛错');
    assert.ok(e.message.includes('not ok:true'));
  });

  await t('HTTP 200 JSON ok:false / ok:"true" 字符串：抛错', async () => {
    const a = await patchAgainst(200, JSON.stringify({ ok: false, error: 'x' }));
    assert.ok(a.e);
    const b = await patchAgainst(200, JSON.stringify({ ok: 'true' }));
    assert.ok(b.e, 'ok 必须严格是布尔 true');
  });

  await t('HTTP 200 空正文：抛错', async () => {
    const { e } = await patchAgainst(200, '');
    assert.ok(e);
  });

  await t('HTTP 5xx（新全局处理器的 internal_error）：抛错（回归）', async () => {
    const { e } = await patchAgainst(500, JSON.stringify({ ok: false, error: 'internal_error' }));
    assert.ok(e);
    assert.strictEqual(e.status, 500);
    assert.ok(/HTTP 500/.test(e.message));
  });

  await t('HTTP 404：抛错（回归）', async () => {
    const { e } = await patchAgainst(404, JSON.stringify({ error: 'Job not found' }));
    assert.ok(e);
    assert.strictEqual(e.status, 404);
  });

  await t('{ok:true,status_changed:false,current_status:failed}：不抛错，原样返回', async () => {
    const { r, e } = await patchAgainst(200, JSON.stringify({ ok: true, status_changed: false, current_status: 'failed' }));
    assert.ok(!e, e && e.message);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status_changed, false);
    assert.strictEqual(r.current_status, 'failed');
  });

  await t('{ok:true}（log-only flush 的常规回包）：不抛错', async () => {
    const { r, e } = await patchAgainst(200, JSON.stringify({ ok: true }));
    assert.ok(!e);
    assert.strictEqual(r.ok, true);
  });

  await t('acceptJobPatch 纯函数：正文截 300 字', async () => {
    let err = null;
    try { acceptJobPatch({ status: 200, text: 'F'.repeat(2000), json: null }, '/jobs/1'); } catch (x) { err = x; }
    assert.ok(err);
    const tail = err.message.split(' :: ')[1];
    assert.strictEqual(tail.length, 300);
    assert.throws(() => acceptJobPatch(null, '/jobs/1'));
    assert.deepStrictEqual(acceptJobPatch({ status: 204, text: '{"ok":true}', json: { ok: true } }), { ok: true });
  });

  console.log('\n' + n + ' passed');
})().catch((e) => {
  console.error('FAIL', e && e.stack ? e.stack : e);
  process.exit(1);
});
