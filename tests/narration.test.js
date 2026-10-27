#!/usr/bin/env node
/* 收口回合（2026-10-27 升级为频道里关于收口的唯一的嘴，match PJ 模式）：
   prompt 的硬边界、SKIP 规整、零模型兜底行、折返反馈摘录。跑法：node tests/narration.test.js
   防的是四件事：系统触发的回合长出执行权（prompt 必须带纯叙述铁律）、
   模型没话找话刷频道（SKIP 必须规整成不发帖）、
   叙述拿滚动单旧标题当内容讲（必须引用最新折返反馈原话）、
   LLM 挂了事实送不到频道（兜底行必须零模型可拼）。 */
const assert = require('assert');
const {
  buildNarrationPrompt,
  narrationBody,
  narrationFallbackLine,
  latestFoldFeedback,
  jobSequenceBlock,
} = require('../seo-worker/runners/chat');
const { headTail } = require('../seo-worker/lib/util');

let fail = 0;
function t(name, fn) {
  try {
    fn();
    console.log('  ok   ' + name);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + name + ' :: ' + e.message);
  }
}

t('prompt 含纯叙述铁律、三要素、唯一的嘴与 SKIP 出口，带任务材料', () => {
  const p = buildNarrationPrompt({
    clientName: 'Ideal Renovation',
    messages: [],
    task: { id: 1375, title: '人工落地：地域定向', result_note_tail: 'capability-gap[cli]：缺 op', output_url: '' },
    closeKind: 'accepted',
  });
  assert.ok(p.includes('纯叙述'));
  assert.ok(p.includes('没有任何执行权'));
  assert.ok(p.includes('账户或站点动没动'));
  assert.ok(p.includes('SKIP'));
  assert.ok(p.includes('#1375'));
  assert.ok(p.includes('capability-gap[cli]'));
  assert.ok(p.includes('账户与站点未因本单改动'));
  assert.ok(p.includes('唯一声音'), '收口回合必须声明自己是唯一的嘴');
});

t('prompt 带折返反馈原话、收口说明、前情摘要与 job 终局序列（louvresky 复盘材料）', () => {
  const p = buildNarrationPrompt({
    clientName: 'Louvresky',
    messages: [],
    task: { id: 1663, title: 'louvresky_paid_20260922.html 修订滚动单', result_note_tail: '检查: 已核', output_url: 'https://agencyreport.horntech-dev.com/x.html' },
    closeKind: 'applied',
    reason: '检查: 三处全核',
    summaryText: '此前讨论过章节顺序',
    feedback: '把 Hamilton 落地页整节删掉',
    jobs: [
      { id: 9983, type: 'execute_task', status: 'done', finished_at: '2026-10-27 10:00' },
      { id: 10016, type: 'apply_task', status: 'done', finished_at: '2026-10-27 10:25' },
    ],
  });
  assert.ok(p.includes('把 Hamilton 落地页整节删掉'));
  assert.ok(p.includes('旧称呼'), '必须提醒模型别按滚动单标题复述内容');
  assert.ok(p.includes('job #9983'));
  assert.ok(p.includes('job #10016'));
  assert.ok(p.includes('此前讨论过章节顺序'));
  assert.ok(p.includes('检查: 三处全核'));
  assert.ok(p.includes('https://agencyreport.horntech-dev.com/x.html'));
});

t('narrationBody：SKIP 与空输出不发帖，正文通过并截断', () => {
  assert.strictEqual(narrationBody('SKIP'), null);
  assert.strictEqual(narrationBody('  SKIP  \n'), null);
  assert.strictEqual(narrationBody('SKIP，没有可补的'), null);
  assert.strictEqual(narrationBody(''), null);
  assert.strictEqual(narrationBody(null), null);
  assert.strictEqual(narrationBody('账户已改完，五条系列全部按清单生效。'), '账户已改完，五条系列全部按清单生效。');
  assert.ok(narrationBody('x'.repeat(5000)).length <= 2003);
});

t('SKIP 只认首行开头，正文里提到 SKIP 不误杀', () => {
  const body = '已收口。说明一下：模型输出 SKIP 时不会发帖。';
  assert.strictEqual(narrationBody(body), body);
});

t('零模型兜底行：带任务号、收口类型、产物链接，不依赖任何模型输出', () => {
  const line = narrationFallbackLine(
    { id: 1663, title: '修订滚动单', output_url: 'https://a.example/x.html' },
    'applied'
  );
  assert.ok(line.includes('#1663'));
  assert.ok(line.includes('已落地并通过自验'));
  assert.ok(line.includes('https://a.example/x.html'));
  const line2 = narrationFallbackLine({ id: 9, title: 't' }, '神秘类型');
  assert.ok(line2.includes('神秘类型'), '未知类型原样透出不吞');
});

t('latestFoldFeedback：取最新一条折返反馈的正文，无折返返回空', () => {
  const detail = [
    '原始委托说明',
    '[折返反馈 2026-10-26（monica）][折返key src:1:0] 同一交付物（a.html）的新反馈并入本单滚动改：',
    '把数据解读一节上移',
    '[折返反馈 2026-10-27（monica）][折返key src:2:0] 同一交付物（a.html）的新反馈并入本单滚动改：',
    '删掉 Hamilton 落地页整节',
    '相关说明第二行',
  ].join('\n');
  const fb = latestFoldFeedback(detail);
  assert.ok(fb.includes('删掉 Hamilton 落地页整节'));
  assert.ok(!fb.includes('上移'), '只取最新一条');
  assert.strictEqual(latestFoldFeedback('没有折返的普通说明'), '');
  assert.strictEqual(latestFoldFeedback(null), '');
});

t('jobSequenceBlock：一行一个终局，空列表给占位', () => {
  const b = jobSequenceBlock([{ id: 1, type: 'execute_task', status: 'done' }]);
  assert.ok(b.includes('job #1 execute_task [done]'));
  assert.strictEqual(jobSequenceBlock([]), '（无关联 job 记录）');
  assert.strictEqual(jobSequenceBlock(null), '（无关联 job 记录）');
});

t('headTail：保头保尾，尾部的最新折返不被砍（review_plan 1500 字留头砍尾的病）', () => {
  const head = '原始委托。'.repeat(100); // 500 字
  const tailMsg = '[折返反馈 2026-10-27] 删掉 Hamilton 整节';
  const s = head + '中间废话'.repeat(800) + tailMsg;
  const cut = headTail(s, 300, 300);
  assert.ok(cut.includes('原始委托'), '头要在');
  assert.ok(cut.includes('删掉 Hamilton 整节'), '尾（最新折返）要在');
  assert.ok(cut.includes('[中间略'), '砍的是中间');
  assert.ok(cut.length < s.length);
  const short = '短文本不动';
  assert.strictEqual(headTail(short, 300, 300), short);
});

console.log(fail ? fail + ' fail' : 'narration: all pass, 0 fail');
process.exit(fail ? 1 : 0);
