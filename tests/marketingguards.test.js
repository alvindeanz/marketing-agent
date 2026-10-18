#!/usr/bin/env node
/* WF Marketing Inbox 放行护栏的 worker 侧移植对拍。样例与 WF 共用（tests/fixtures/marketing_guard_cases.json，
   抄自 webforge 仓 test/marketing-inbox.test.ts）：放行样例必须零原因，扣下样例必须命中期望原因。
   本地加严（external_host）单列，不进对拍。跑法：node tests/marketingguards.test.js */
const assert = require('assert');
const path = require('path');
const G = require('../seo-worker/lib/marketingguards');
const FX = require(path.join(__dirname, 'fixtures', 'marketing_guard_cases.json'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
const guard = (body, extra) => G.checkReplyGuards(Object.assign({ body, siteHosts: FX.site_hosts, extraHosts: FX.extra_hosts }, extra || {}));
const local = (body, extra) => G.checkLocalReply(Object.assign({ body, siteHosts: FX.site_hosts, extraHosts: FX.extra_hosts }, extra || {}));

t('阈值与 WF 一致：单条 2000 字符、复读 40 字符', () => {
  assert.strictEqual(G.REPLY_MAX_CHARS, 2000);
  assert.strictEqual(G.ECHO_MIN_CHARS, 40);
  assert.deepStrictEqual(G.DEFAULT_ALLOWED_HOSTS, FX.extra_hosts);
});
t('共用放行样例（中英、站内链接、报告链接、价格时间）WF 口径零原因，本地加严也零原因', () => {
  for (const b of FX.passing) {
    assert.deepStrictEqual(guard(b), [], b);
    assert.deepStrictEqual(local(b), [], 'local: ' + b);
  }
});
t('共用扣下样例逐条命中期望原因（' + FX.held.length + ' 条）', () => {
  for (const h of FX.held) {
    const got = guard(h.body, h.extra);
    assert.ok(got.includes(h.reason), h.reason + ' 期望命中：' + h.body.slice(0, 60) + '（拿到 ' + got.join(',') + '）');
    assert.ok(local(h.body, h.extra).includes(h.reason), '本地自检不得比 WF 宽：' + h.reason);
  }
});
t('复读：40 字符以下的重叠放行，40 字符以上命中', () => {
  const e = FX.echo_pair;
  assert.deepStrictEqual(guard(e.short_overlap_passes, { clientMessages: [e.client] }), []);
  assert.ok(G.echoes(e.long_overlap_echoes, [e.client]));
});
t('链接主机抽取：忽略邮箱域，保留裸域与 www 主机', () => {
  assert.deepStrictEqual(G.linkHosts(FX.link_hosts.text).sort(), FX.link_hosts.hosts.slice().sort());
});
t('按字符不按字节计长度：2000 个汉字放行，2001 个扣下', () => {
  assert.ok(!guard('字'.repeat(2000)).includes('too_long'));
  assert.ok(guard('字'.repeat(2001)).includes('too_long'));
});
t('小写 ma 不算内部名，大写独立 MA 才算', () => {
  assert.deepStrictEqual(guard('We will email you the summary, ma\'am.'), []);
  assert.ok(guard('The MA team agreed.').includes('internal_name'));
});
t('本地加严 external_host：WF 常见后缀外的竞品域名（.ca、.de）WF 漏网、本地拦下；文件名与 i.e. 不误报', () => {
  for (const b of ['Have a look at rivalcafe.ca for ideas.', 'Their shop at mitbewerber.de is similar.']) {
    assert.deepStrictEqual(guard(b), [], 'WF 口径放过：' + b);
    assert.ok(local(b).includes('external_host'), '本地应拦：' + b);
  }
  assert.deepStrictEqual(local('Please send the menu.pdf and logo.png, i.e. the latest versions.'), []);
  assert.deepStrictEqual(local('See www.acme.co.nz/menu or app.webforger.ai.'), []);
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
