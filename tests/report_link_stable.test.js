/* 报告在原链接上更新（2026-11-25）：非卡页不带令牌、旧补参脚本剥掉；卡页照旧。 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../seo-worker/lib/publish');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rls-'));
const rep = path.join(dir, 'x_paid_monthly_2026-10.html');
const card = path.join(dir, 'card.html');
const TAG = '<script data-card-autotoken>if(!new URLSearchParams(location.search).get("k"))location.replace(location.pathname+"?t=1&k=abc");</script>';
fs.writeFileSync(rep, '<html><body><h1>月报</h1>\n' + TAG + '\n</body></html>');
fs.writeFileSync(card, '<html><body><script>var API="/reports/card_feedback.php";</script></body></html>');

assert.strictEqual(P.isCardPage(rep), false, '月报不是卡');
assert.strictEqual(P.isCardPage(card), true, '带反馈通路的是卡');
assert.strictEqual(P.isCardPage(path.join(dir, 'nope.html')), false, '读不到按非卡');

assert.strictEqual(P.stripCardToken(rep), true);
const after = fs.readFileSync(rep, 'utf8');
assert.ok(after.indexOf('data-card-autotoken') === -1 && after.indexOf('<h1>月报</h1>') !== -1, '只剥脚本，正文不动');
assert.strictEqual(P.stripCardToken(rep), false, '幂等');

(async () => {
  /* 没有对应草稿、或自己就是草稿：不发跳转 */
  assert.strictEqual(await P.publishDraftRedirect({}, 'x', 'x_paid_monthly_2026-10.html', dir), null);
  assert.strictEqual(await P.publishDraftRedirect({}, 'x', 'a.draft.html', dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('report_link_stable ok');
})().catch((e) => { console.error(e); process.exit(1); });
