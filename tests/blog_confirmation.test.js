#!/usr/bin/env node
/* 博客确认卡渲染器单测。跑法：node tests/blog_confirmation.test.js
   覆盖：validate 的槽位/publish_blog item/draft_url/关键词拉丁词/破折号守卫，
        renderCard 渲染出的卡含 draft 预览按钮、发布决策、card_feedback 反馈通路且无残留槽位。
   不碰网络、不调模型、不写 250。 */

const assert = require('assert');
const path = require('path');
const R = require(path.join(__dirname, '..', 'seo-worker', 'specs', 'report', 'render_blog_confirmation.js'));

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '：' + e.message); fail++; }
}

function good() {
  return {
    title: '纱帘晚上开灯会不会透出人影',
    period_label: '草稿待您确认 · 2026-09',
    oneline: '讲清纱帘夜间隐私的真相，接住相关搜索。',
    draft_url: 'https://benscurtains.com.au/blog/a/?preview=abc',
    draft_hint: '这是只有您能看到的预览链接。',
    keywords: [
      { term: 'are sheer curtains see through at night', intent: '买前顾虑：担心夜里透光' },
      { term: 'sheer curtains privacy', intent: '在找方案', note: '站内空白' },
    ],
    images_line: '配了 4 张图。',
    links_out: [{ page: '/sheer-curtains/', anchor: 'sheer curtains' }],
    links_in: [{ page: '/how-to-choose-curtains/' }],
    decision: {
      q: '这篇文章可以发布吗？',
      situation: '夜间隐私这个顾虑站内还没有页面回答',
      recommendation: '发出去能接住搜这个问题的访客',
      no_reply: '不回复就先留草稿不发',
      item: 'publish_blog',
      textarea_hint: '哪里想改直接写。',
    },
    window_line: '口径见附件。',
    attach_line: '完整文章见预览。',
  };
}

t('好数据渲染出卡，无残留槽位，含发布决策与反馈通路', () => {
  const h = R.renderCard(good());
  assert(!/{{/.test(h), '有残留模板槽位');
  assert(h.includes('publish_blog'), '缺 publish_blog item');
  assert(h.includes('card_feedback.php'), '缺反馈通路');
  assert(h.includes('先看这篇文章的完整预览'), '缺 draft 预览按钮');
  assert(h.includes('同意，安排发布'), '缺同意发布按钮');
  assert(h.includes('are sheer curtains see through at night'), '缺关键词');
});

t('缺 keywords 报缺槽位', () => {
  const d = good(); delete d.keywords;
  assert.throws(() => R.validate(d), /缺槽位/);
});

t('decision.item 必须是 publish_blog（foldCards 靠它认发布）', () => {
  const d = good(); d.decision.item = 'other_thing';
  assert.throws(() => R.validate(d), /publish_blog/);
});

t('draft_url 必须是完整 http 链接', () => {
  const d = good(); d.draft_url = '/blog/a';
  assert.throws(() => R.validate(d), /draft_url/);
});

t('关键词整列全中文报错（copy_rules A31）', () => {
  const d = good(); d.keywords = [{ term: '纱帘', intent: 'x' }];
  assert.throws(() => R.validate(d));
});

t('数据里出现破折号被守卫拦下', () => {
  const d = good(); d.oneline = '纱帘—夜间隐私';
  assert.throws(() => R.validate(d), /破折号/);
});

t('links_out 可空（有的博客没内链）', () => {
  const d = good(); d.links_out = []; delete d.links_in;
  const h = R.renderCard(d);
  assert(!/{{/.test(h));
});

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
