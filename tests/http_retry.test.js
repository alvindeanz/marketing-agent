'use strict';
/* http.js 瞬断原地重试：GET 自动重试一次；非幂等 POST 不重试；isTransient 分类。
   用本地 http server 模拟首连即断（ECONNRESET），不出网。 */
const assert = require('node:assert');
const http = require('node:http');
const { request, isTransient } = require('../seo-worker/lib/http');

function flakyServer(failTimes) {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits += 1;
    if (hits <= failTimes) {
      req.socket.destroy(); // 客户端视角 ECONNRESET / socket hang up
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, hits }));
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, hitCount: () => hits }));
  });
}

(async () => {
  // isTransient 分类
  assert.ok(isTransient({ code: 'ETIMEDOUT' }));
  assert.ok(isTransient({ code: 'ECONNRESET' }));
  assert.ok(isTransient(new Error('socket hang up')));
  assert.ok(isTransient(new Error('http timeout after 60000ms: https://x')));
  assert.ok(!isTransient(new Error('HTTP 500 GET https://x :: boom')));
  assert.ok(!isTransient({ code: 'ENOTDIR' }));

  // GET 首连被掐，重试一次后成功
  {
    const { srv, port, hitCount } = await flakyServer(1);
    const r = await request('http://127.0.0.1:' + port + '/a');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(hitCount(), 2, 'GET 应重试一次');
    srv.close();
  }

  // GET 连断两次：只重试一次，第二次失败照抛，且错误带重试标注
  {
    const { srv, port, hitCount } = await flakyServer(2);
    let threw = null;
    try {
      await request('http://127.0.0.1:' + port + '/b');
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, '两连断应最终抛错');
    assert.ok(String(threw.message).includes('原地重试一次'), '错误信息应标注已重试');
    assert.strictEqual(hitCount(), 2, '只允许一次重试，不许退避循环');
    srv.close();
  }

  // 非幂等 POST：瞬断不重试
  {
    const { srv, port, hitCount } = await flakyServer(1);
    let threw = null;
    try {
      await request('http://127.0.0.1:' + port + '/c', { method: 'POST', body: { x: 1 } });
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, '非幂等 POST 首断即抛');
    assert.strictEqual(hitCount(), 1, '非幂等 POST 不许重试');
    srv.close();
  }

  // 声明幂等的 POST：重试一次后成功
  {
    const { srv, port, hitCount } = await flakyServer(1);
    const r = await request('http://127.0.0.1:' + port + '/d', {
      method: 'POST', body: { x: 1 }, idempotent: true,
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(hitCount(), 2, '幂等 POST 应重试一次');
    srv.close();
  }

  console.log('http_retry.test.js ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
