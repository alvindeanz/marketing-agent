#!/usr/bin/env node
/* 发布凭证按文章网址关联 + 卡令牌容错（2026-11-17 ticket #62 #63）。跑法：node tests/consent_slug_link.test.js。
   判定在 seo-api.php 的 blog_slug_of / blog_consent_card_by_slug，本测是镜像实现加线上真实任务正文回放
   （Sammichelle #2100 对 #2045），末尾源码同步闸防两边各改各的。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

function slugOf(text) {
  const u = [...new Set([...String(text).matchAll(/\/blog\/([A-Za-z0-9][A-Za-z0-9_-]*)/g)].map((m) => m[1]))];
  return u.length === 1 ? u[0] : '';
}
/* tasks：同客户任务 [{id, note}]；返回这篇文章最新一张确认卡的任务号 */
function cardBySlug(tasks, self) {
  const slug = slugOf((self.detail || '') + '\n' + (self.note || ''));
  if (!slug) return 0;
  if (/blog_confirmation_task-/.test(self.note || '')) return 0;
  const re = new RegExp('/blog/' + slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_-])');
  const c = tasks.filter((x) => x.id !== self.id && /blog_confirmation_task-/.test(x.note || '') && re.test(x.note || ''))
    .sort((a, b) => b.id - a.id);
  return c.length ? c[0].id : 0;
}
function tok(raw) { const m = /^[0-9a-f]{32}/.exec(String(raw)); return m ? m[0] : String(raw); }

/* 线上真实正文（节选，2026-11-17） */
const T2100 = { id: 2100, detail: '把站内草稿 /blog/summer-holiday-packing-list-nz-bach-week/ 按当前版本原样发布，不改正文。客户 Elaine 2026-11-14 群内回复 both articles are good 批准。\n[委托单] 频道 #10307 消息 #10876/1 快路同轮启动',
  note: '预览: https://agencyreport.horntech-dev.com/reports/sanmichellebags/preview/task-2100.html\n目标页面: https://sanmichellebags.co.nz/blog/summer-holiday-packing-list-nz-bach-week/\n[wait-publish-consent] 发布凭证未到' };
const CARD = (id, slug) => ({ id, note: '博客确认卡: https://agencyreport.horntech-dev.com/reports/x/blog_confirmation_task-' + id + '.html?t=' + id + '&k=abc\n平台预览链接：https://sanmichellebags.co.nz/blog/' + slug + '/?preview=77bf' });
const T2045 = CARD(2045, 'summer-holiday-packing-list-nz-bach-week');
const T313 = CARD(313, 'summer-holiday-packing-list-nz-bach-week');

t('#2100 正文不含 #2045，按网址关联到 #2045', () => {
  assert.ok(!/#2045/.test(T2100.detail + T2100.note));
  assert.strictEqual(cardBySlug([T313, T2045, T2100], T2100), 2045);
});
t('同篇多张卡只认单号最大的一张（旧卡同意不替新一版放行）', () => {
  assert.strictEqual(cardBySlug([T2045, T313], T2100), 2045);
  assert.strictEqual(cardBySlug([T313], T2100), 313);
});
t('slug 前缀相近的别篇不串', () => {
  const other = CARD(2200, 'summer-holiday-packing-list-nz-bach-week-2');
  assert.strictEqual(cardBySlug([other], T2100), 0);
});
t('正文里两个不同 slug 不猜', () => {
  const two = { id: 9, detail: '发布 /blog/a-post/ 和 /blog/b-post/', note: '' };
  assert.strictEqual(slugOf(two.detail), '');
  assert.strictEqual(cardBySlug([CARD(5, 'a-post')], two), 0);
});
t('没有卡的同篇任务不算凭证来源，自己也不算', () => {
  assert.strictEqual(cardBySlug([{ id: 2099, note: '改稿 /blog/summer-holiday-packing-list-nz-bach-week/' }, T2100], T2100), 0);
});
t('自己带卡的任务只认自己的卡，不借同篇旧卡（#1588 对 #828）', () => {
  const a = CARD(828, 'motorised-sheer-curtains-planning-checklist'), b = CARD(1588, 'motorised-sheer-curtains-planning-checklist');
  assert.strictEqual(cardBySlug([a, b], b), 0);
  assert.strictEqual(cardBySlug([a, b], a), 0);
});
t('令牌尾巴带右括号照认，位数不够或内容不对照拒', () => {
  const k = '17ab72d8e7f6522666ecbea62dca65e7';
  assert.strictEqual(tok(k + ')'), k);
  assert.strictEqual(tok(k + '）。'), k);
  assert.strictEqual(tok(k), k);
  assert.notStrictEqual(tok(k.slice(0, 31) + ')'), k);
  assert.notStrictEqual(tok('x' + k), k);
});
t('源码同步闸：PHP 与 apply 两侧都接了这条口径', () => {
  const php = fs.readFileSync(path.join(__dirname, '..', 'seo-api.php'), 'utf8');
  assert.ok(php.includes("preg_match_all('#/blog/([A-Za-z0-9][A-Za-z0-9_-]*)#'"), 'blog_slug_of 正则变了');
  assert.ok(php.includes('$slug=task_blog_slug($t);'), '关联卡没先读 [target] 行');
  assert.ok(php.includes("result_note LIKE '%blog_confirmation_task-%'"), '卡任务判据变了');
  assert.ok(php.includes('ORDER BY id DESC LIMIT 10'), '最新一张的排序变了');
  assert.ok(php.includes("if(strpos((string)($t['result_note']??''),'blog_confirmation_task-')!==false)return 0;"), '自带卡不借旧卡的闸没了');
  assert.ok((php.match(/blog_consent_card_by_slug\(/g) || []).length >= 4, '派单、续排、linked 接口三处调用少了');
  assert.ok(php.includes("preg_match('/^[0-9a-f]{32}/',$tok,$tkm)"), '令牌容错没了');
  const js = fs.readFileSync(path.join(__dirname, '..', 'seo-worker', 'runners', 'apply_task.js'), 'utf8');
  /* 2026-11-18 ticket #64：apply 不再自己判，只问服务端同一个函数 */
  assert.ok(js.includes('api.blogConsent(taskId)') && !js.includes('api.cardFeedback(taskId, true)'), 'apply 凭证闸没改成只问服务端');
  assert.ok(php.includes('$lk=blog_consent_card_by_slug($cid,$tid,$t);'), '判定里按文章关联卡没了');
});
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
