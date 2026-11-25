/* 频道 PJ 化（2026-11-25）：篇幅卡口、预览页不进频道、身份与边界提示词。 */
const assert = require('assert');
const C = require('../seo-worker/runners/chat');

/* 链接不计入篇幅 */
assert.strictEqual(C.replyTextLen('改好了 https://agencyreport.horntech-dev.com/reports/x/y.html'), 3);
const long = '结论'.repeat(300);
/* KEEP、空、没变短：退回原文 */
assert.strictEqual(C.pickCompressed(long, 'KEEP'), long);
assert.strictEqual(C.pickCompressed(long, ''), long);
assert.strictEqual(C.pickCompressed('短', '比原文还长的一句话'), '短');
/* 压短了就用压缩稿；丢掉的成品链接补回，预览链接不补 */
const orig = long + ' https://agencyreport.horntech-dev.com/reports/x/report.html 以及 https://agencyreport.horntech-dev.com/reports/x/preview/task-9.html';
const out = C.pickCompressed(orig, '改好了，数字已更新。');
assert.ok(out.indexOf('改好了') === 0 && out.indexOf('/reports/x/report.html') !== -1, '成品链接要在');
assert.ok(out.indexOf('/preview/task-9') === -1, '预览链接不补回');

/* 预览行整行拿掉，别的行不动 */
const note = '客户版: https://a/reports/x/r.html\n预览: https://a/reports/x/preview/task-12.html\n摘要：改了三处';
const st = C.stripPreviewLinks(note);
assert.ok(st.indexOf('preview/task-12') === -1 && st.indexOf('客户版: https://a/reports/x/r.html') !== -1 && st.indexOf('改了三处') !== -1);

/* 压缩提示词带上限和人话 */
const cp = C.buildCompressPrompt('帮我 enable', '很长的回话', 120);
assert.ok(cp.indexOf('120 字以内') !== -1 && cp.indexOf('帮我 enable') !== -1 && cp.indexOf('KEEP') !== -1);

/* 频道提示词：同事身份、指令即放行、预览页不进频道；任务线程提示词不带频道边界 */
const base = { clientName: 'X', title: '频道', briefing: 'b', messages: [{ id: 1, role: 'user', body: '帮我 enable', kind: 'chat_user' }] };
const p = C.buildPrompt(base);
assert.ok(p.indexOf('同事') !== -1 && p.indexOf('你的身份是顾问，不是执行器') === -1, '频道身份改同事');
assert.ok(p.indexOf('运营亲口下的明确指令就是放行') !== -1);
assert.ok(p.indexOf('预览页不进频道') !== -1 && p.indexOf(String(C.REPLY_SOFT_CAP)) !== -1);
assert.ok(p.indexOf('在原文件上原地修改并发布到原链接') !== -1);

/* 收口提示词：预览产物链接不喂、字数上限在 */
const np = C.buildNarrationPrompt({ clientName: 'X', messages: [], task: { id: 5, title: 't', output_url: 'https://a/reports/x/preview/task-5.html', result_note_tail: '预览: https://a/reports/x/preview/task-5.html\n已暂停 1 个词' }, closeKind: 'applied', jobs: [] });
assert.ok(np.indexOf('preview/task-5') === -1 && np.indexOf('已暂停 1 个词') !== -1 && np.indexOf(C.NARRATION_CAP + ' 字以内') !== -1);
console.log('chat_concise ok');
