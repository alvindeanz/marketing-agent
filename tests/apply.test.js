#!/usr/bin/env node
/* apply 落地闭环的纯函数单测。
   跑法：node tests/apply.test.js
   覆盖：outcome 新契约的解析与归一化、checks 成败判定（延后项不算失败、
        当场失败项算失败、老字段 verification_passed 兼容）、result_note 头部组装、
        prepare 阶段的 target_urls 与「目标页面」一行、publishFile 的远端路径。
   不碰网络、不调模型、不写 250。 */

const assert = require('assert');
const path = require('path');

const W = path.join(__dirname, '..', 'seo-worker');
const A = require(path.join(W, 'runners', 'apply_task'));
const E = require(path.join(W, 'runners', 'execute_task'));
const P = require(path.join(W, 'lib', 'publish'));

let pass = 0,
  fail = 0;
const pending = [];
function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      pending.push(
        r.then(
          () => {
            pass++;
            console.log('  ok   ' + name);
          },
          (e) => {
            fail++;
            console.log('  FAIL ' + name + '\n       ' + e.message);
          }
        )
      );
      return;
    }
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL ' + name + '\n       ' + e.message);
  }
}
function section(s) {
  console.log('\n' + s);
}

/** 把 outcome json 包成一段模型回复，末尾一个 json 块。 */
function reply(json, prose) {
  return (prose || '## 执行记录\n七步全部执行完毕。') + '\n\n```json\n' + JSON.stringify(json) + '\n```';
}
const quiet = () => {};

/* ---------- checks 归一化 ---------- */
section('checks 归一化');
t('normalizeChecks 强制字段类型，脏数据丢掉', () => {
  const c = A.normalizeChecks([
    { name: 'V1 接口返回', passed: true },
    { name: '  V2 线上状态码  ', passed: 'true', deferred: 1, note: 'ok' },
    null,
    'V3',
    { passed: true },
  ]);
  assert.strictEqual(c.length, 3);
  assert.deepStrictEqual(c[0], { name: 'V1 接口返回', passed: true, deferred: false, note: '' });
  // 只有严格 true 才算 true，字符串 'true' 与数字 1 都不认
  assert.strictEqual(c[1].name, 'V2 线上状态码');
  assert.strictEqual(c[1].passed, false);
  assert.strictEqual(c[1].deferred, false);
  assert.strictEqual(c[2].name, '未命名检查项');
});
t('normalizeChecks 非数组一律给空数组', () => {
  assert.deepStrictEqual(A.normalizeChecks(null), []);
  assert.deepStrictEqual(A.normalizeChecks('V1'), []);
  assert.deepStrictEqual(A.normalizeChecks({ name: 'V1' }), []);
});
t('normalizeUrls 只留完整 http(s) 地址并去重', () => {
  const u = A.normalizeUrls([
    'https://a.co/x/',
    'https://a.co/x/',
    '/relative/path',
    'ftp://a.co/f',
    '  https://b.co/y/  ',
    '',
  ]);
  assert.deepStrictEqual(u, ['https://a.co/x/', 'https://b.co/y/']);
  assert.deepStrictEqual(A.normalizeUrls(null), []);
  assert.deepStrictEqual(A.normalizeUrls('https://c.co/z/'), ['https://c.co/z/']);
});

/* ---------- 成败判定 ---------- */
section('成败判定');
t('judgeChecks 延后项不算失败，只记录', () => {
  const j = A.judgeChecks({
    checks: [
      { name: 'V1 接口返回', passed: true, deferred: false },
      { name: 'V11 移动端不溢出', passed: true, deferred: false },
      { name: 'V12 Rich Results Test', passed: false, deferred: true, note: '需浏览器' },
      { name: 'V13 收录跟进', passed: false, deferred: true },
    ],
  });
  assert.strictEqual(j.mode, 'checks');
  assert.strictEqual(j.ok, true, '两条延后项不该把一次全绿的落地判成失败');
  assert.strictEqual(j.passedCount, 2);
  assert.strictEqual(j.deferred.length, 2);
  assert.strictEqual(j.failed.length, 0);
});
t('judgeChecks 当场可验的项没过就是失败', () => {
  const j = A.judgeChecks({
    checks: [
      { name: 'V1 接口返回', passed: true, deferred: false },
      { name: 'V3 禁区词清零', passed: false, deferred: false, note: 'thermal 仍有 1 处' },
      { name: 'V13 收录跟进', passed: false, deferred: true },
    ],
  });
  assert.strictEqual(j.ok, false);
  assert.strictEqual(j.failed.length, 1);
  assert.strictEqual(j.failed[0].name, 'V3 禁区词清零');
  assert.strictEqual(j.passedCount, 1);
});
t('judgeChecks 没有 checks 时回落老字段 verification_passed', () => {
  const okd = A.judgeChecks({ verification_passed: true });
  assert.strictEqual(okd.mode, 'legacy');
  assert.strictEqual(okd.ok, true);
  const bad = A.judgeChecks({ verification_passed: false });
  assert.strictEqual(bad.mode, 'legacy');
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(A.judgeChecks({}).ok, false);
  assert.strictEqual(A.judgeChecks(null).ok, false);
});
t('有 checks 时 checks 说了算，老字段不再翻盘', () => {
  // task 61 的原样：V1 到 V11 全过、V12 V13 延后，模型自己写了 verification_passed=false
  const j = A.judgeChecks({
    verification_passed: false,
    checks: [
      { name: 'V1', passed: true, deferred: false },
      { name: 'V12', passed: false, deferred: true },
    ],
  });
  assert.strictEqual(j.ok, true);
  // 反过来，老字段写 true 也救不了一条当场没过的项
  const j2 = A.judgeChecks({
    verification_passed: true,
    checks: [{ name: 'V3', passed: false, deferred: false }],
  });
  assert.strictEqual(j2.ok, false);
});

/* ---------- readOutcome ---------- */
section('readOutcome');
t('success 加延后项：判成功，延后项照实带出来', () => {
  const o = A.readOutcome(
    reply({
      status: 'success',
      verification_passed: false,
      affected_urls: ['https://benscurtains.com.au/made-to-measure-curtains/'],
      snapshot_label: 'task-61-mtm-rewrite-pre',
      before_archive: '/data/aira/clients/benscurtains/backups/2026-08-25-task-61/before-rendered.html',
      checks: [
        { name: 'V1 接口返回', passed: true, deferred: false },
        { name: 'V12 Rich Results Test', passed: false, deferred: true },
      ],
      note: '七步执行完毕',
    }),
    quiet
  );
  assert.strictEqual(o.status, 'success');
  assert.deepStrictEqual(o.affectedUrls, ['https://benscurtains.com.au/made-to-measure-curtains/']);
  assert.strictEqual(o.snapshotLabel, 'task-61-mtm-rewrite-pre');
  assert.ok(o.beforeArchive.endsWith('before-rendered.html'));
  assert.strictEqual(o.judge.deferred.length, 1);
});
t('success 但当场可验项没过：降级成 failed，理由写进 note', () => {
  const o = A.readOutcome(
    reply({
      status: 'success',
      verification_passed: true,
      checks: [
        { name: 'V1 接口返回', passed: true, deferred: false },
        { name: 'V3 禁区词清零', passed: false, deferred: false },
      ],
      note: '看起来没问题',
    }),
    quiet
  );
  assert.strictEqual(o.status, 'failed');
  assert.ok(o.note.indexOf('V3 禁区词清零') > -1);
});
t('老格式 verification_passed 仍然认，两个方向都对', () => {
  const good = A.readOutcome(reply({ status: 'success', verification_passed: true, note: '全过' }), quiet);
  assert.strictEqual(good.status, 'success');
  const bad = A.readOutcome(reply({ status: 'success', verification_passed: false, note: '有一条没跑' }), quiet);
  assert.strictEqual(bad.status, 'failed');
});
t('json 块缺失或状态值非法一律判失败，且判定字段是空值不是 undefined', () => {
  const none = A.readOutcome('只有正文没有 json 块', quiet);
  assert.strictEqual(none.status, 'failed');
  assert.deepStrictEqual(none.affectedUrls, []);
  assert.strictEqual(none.snapshotLabel, '');
  assert.strictEqual(none.judge.ok, false);
  const weird = A.readOutcome(reply({ status: 'partially-done' }), quiet);
  assert.strictEqual(weird.status, 'failed');
  assert.deepStrictEqual(weird.affectedUrls, []);
});
t('aborted 原样保留，不被判定逻辑改写', () => {
  const o = A.readOutcome(reply({ status: 'aborted', note: '第 3 步响应不符，停下' }), quiet);
  assert.strictEqual(o.status, 'aborted');
  assert.ok(o.note.indexOf('第 3 步') > -1);
});

/* ---------- note 头部 ---------- */
section('result_note 头部');
t('四行齐全时按固定顺序组装，--- 收尾', () => {
  const h = A.buildNoteHeader({
    affectedUrls: ['https://a.co/x/', 'https://b.co/y/'],
    archiveUrl: 'https://agencyreport.horntech-dev.com/reports/demo/qa/task-61-before.html',
    snapshotLabel: 'task-61-pre',
    judge: A.judgeChecks({
      checks: [
        { name: 'V1', passed: true, deferred: false },
        { name: 'V2', passed: true, deferred: false },
        { name: 'V12 Rich Results Test', passed: false, deferred: true },
        { name: 'V13 收录跟进', passed: false, deferred: true },
      ],
    }),
  });
  const lines = h.split('\n');
  assert.strictEqual(lines[0], '受影响页面: https://a.co/x/ , https://b.co/y/');
  assert.strictEqual(
    lines[1],
    '改前存档: https://agencyreport.horntech-dev.com/reports/demo/qa/task-61-before.html'
  );
  assert.strictEqual(lines[2], '快照: task-61-pre');
  assert.strictEqual(lines[3], '检查: 通过 2 项，待复验 2 项（V12 Rich Results Test、V13 收录跟进）');
  assert.strictEqual(lines[4], '---');
  assert.ok(h.endsWith('---\n'));
});
t('没有存档与快照就整行不写，受影响页面与检查两行永远在', () => {
  const h = A.buildNoteHeader({ affectedUrls: [], judge: A.judgeChecks({ checks: [] }) });
  const lines = h.trim().split('\n');
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines[0], '受影响页面: 未提供');
  assert.ok(lines[1].indexOf('检查: ') === 0);
  assert.strictEqual(lines[2], '---');
});
t('失败时头部点名是哪条没过', () => {
  const h = A.buildNoteHeader({
    affectedUrls: ['https://a.co/x/'],
    judge: A.judgeChecks({
      checks: [
        { name: 'V1', passed: true, deferred: false },
        { name: 'V3 禁区词清零', passed: false, deferred: false },
        { name: 'V13 收录跟进', passed: false, deferred: true },
      ],
    }),
  });
  assert.ok(h.indexOf('检查: 通过 1 项，未通过 1 项（V3 禁区词清零），待复验 1 项（V13 收录跟进）') > -1);
});
t('老格式没有 checks 时头部也写得出一行', () => {
  const okd = A.buildNoteHeader({ affectedUrls: [], judge: A.judgeChecks({ verification_passed: true }) });
  assert.ok(okd.indexOf('检查: 旧格式，模型声明全部通过') > -1);
  const bad = A.buildNoteHeader({ affectedUrls: [], judge: A.judgeChecks({ verification_passed: false }) });
  assert.ok(bad.indexOf('检查: 旧格式，模型未声明全部通过') > -1);
});
t('头部的分隔符与前端截断口径一致', () => {
  const h = A.buildNoteHeader({ affectedUrls: ['https://a.co/x/'], judge: A.judgeChecks({ checks: [] }) });
  const note = h + '已按批准方案执行并自验通过。';
  // 前端按最后一个 \n---\n 切，头部整段保留，后面的自由文字才截断
  const sep = note.indexOf('\n---\n');
  assert.ok(sep > 0);
  assert.strictEqual(note.slice(sep + 5), '已按批准方案执行并自验通过。');
});

/* ---------- prompt 契约 ---------- */
section('prompt 契约');
t('apply 的 prompt 把四个新字段都要出来了', () => {
  const p = A.buildPrompt({
    task: { id: 61, title: '整页重写', detail: '' },
    plan: '## 1. 变更目标与现状',
    planFile: '/tmp/change-plan-task-61.md',
    workspace: '/tmp/ws',
    platform: null,
    credPath: '/tmp/ws/notes/webforger_credentials.md',
  });
  ['affected_urls', 'touched_files', 'before_archive', 'checks', 'deferred', 'X-WF-Changeset'].forEach((k) => {
    assert.ok(p.indexOf(k) > -1, 'prompt 里应当出现 ' + k);
  });
  assert.ok(p.indexOf('verification_passed') > -1, '老字段仍要写，兼容期不撤');
  assert.ok(p.indexOf('deferred 项不计入成败') > -1);
});
t('prepare 的 prompt 要 target_urls，且允许方案末尾带 json 块', () => {
  const p = E.buildPreparePrompt({
    task: { id: 61, title: '整页重写', detail: '' },
    brief: '（简报）',
    workspace: '/tmp/ws',
    platform: 'webforger',
    ops: [],
    credPath: '/tmp/ws/notes/webforger_credentials.md',
    planFile: '/tmp/change-plan-task-61.md',
  });
  assert.ok(p.indexOf('target_urls') > -1);
  assert.ok(p.indexOf('到末尾那个 json 块结束') > -1, '收尾约束要与新增的 json 块一致');
  assert.ok(p.indexOf('## 0. 放行卡') > -1 && p.indexOf(String(E.RELEASE_CARD_MAX_CHARS)) > -1, '放行卡与上限要进 prompt');
});

/* ---------- prepare 的目标页面一行 ---------- */
section('prepare 的目标页面');
t('readTargetUrls 从方案末尾 json 块取地址并过滤', () => {
  const plan = '# 方案\n\n摘要\n\n```json\n' +
    JSON.stringify({ target_urls: ['https://a.co/x/', 'https://a.co/x/', '/rel', 'https://b.co/y/'] }) +
    '\n```';
  assert.deepStrictEqual(E.readTargetUrls(plan), ['https://a.co/x/', 'https://b.co/y/']);
});
t('readTargetUrls 解析不出来给空数组，不打回方案', () => {
  assert.deepStrictEqual(E.readTargetUrls('# 方案\n没有 json 块'), []);
  assert.deepStrictEqual(E.readTargetUrls('```json\n{不是合法 json}\n```'), []);
  assert.deepStrictEqual(E.readTargetUrls('```json\n{"target_urls":"https://a.co/x/"}\n```'), ['https://a.co/x/']);
});
/* ---------- 前提冲突自愈（2026-10-05 ticket #16） ---------- */
section('前提冲突自愈 premise_revision');
t('readPremiseRevision 取全字段并裁剪', () => {
  const plan = '# 方案\n\n核验证据\n\n```json\n' +
    JSON.stringify({ items: [], premise_revision: {
      revised: '接受最终网址扩展漂移，新素材组照建',
      reason: 'final URL expansion 是 campaign 级开关，无法按 asset group 排除（本次 GAQL 实测）',
      fact_key: 'platform.googleads.final_url_expansion_scope',
      fact_value: 'campaign 级开关，不能按 asset group 关闭',
    } }) + '\n```';
  const pr = E.readPremiseRevision(plan);
  assert.ok(pr, '该解析出来');
  assert.strictEqual(pr.revised, '接受最终网址扩展漂移，新素材组照建');
  assert.strictEqual(pr.factKey, 'platform.googleads.final_url_expansion_scope');
});
t('readPremiseRevision 字段缺失、超长或类型不对一律 null（自愈是捷径不是义务）', () => {
  assert.strictEqual(E.readPremiseRevision('# 方案\n```json\n{"items":[]}\n```'), null, '没有字段');
  assert.strictEqual(E.readPremiseRevision('```json\n{"premise_revision":"选B"}\n```'), null, '不是对象');
  assert.strictEqual(E.readPremiseRevision('```json\n{"premise_revision":{"revised":"只有修订没有理由"}}\n```'), null, '缺 reason');
  const long = '```json\n' + JSON.stringify({ premise_revision: { revised: 'x'.repeat(401), reason: 'y' } }) + '\n```';
  assert.strictEqual(E.readPremiseRevision(long), null, '超长拒收');
  assert.strictEqual(E.readPremiseRevision('```json\n{"premise_revision":[{"revised":"a","reason":"b"}]}\n```'), null, '数组不收');
});
t('prepare prompt 带前提自愈契约与一单一次的闸', () => {
  const p = E.buildPreparePrompt({
    task: { id: 61, title: 't', detail: 'd', ops: 'final-url-change' },
    brief: 'brief',
    workspace: '/tmp/ws',
    platform: 'googleads',
    ops: ['final-url-change'],
    credPath: '/tmp/none.md',
    planFile: '/tmp/change-plan-task-61.md',
  });
  assert.ok(p.indexOf('premise_revision') > -1, '契约要进 prompt');
  assert.ok(p.indexOf('[前提修订]') > -1, '一单一次的闸要写明');
});

t('buildTargetHeader 一行加分隔符，与 apply 头部同款', () => {
  assert.strictEqual(
    E.buildTargetHeader(['https://a.co/x/', 'https://b.co/y/']),
    '目标页面: https://a.co/x/ , https://b.co/y/\n---\n'
  );
  assert.strictEqual(E.buildTargetHeader([]), '目标页面: 未提供\n---\n');
  assert.strictEqual(E.buildTargetHeader(null), '目标页面: 未提供\n---\n');
});

/* ---------- 存档上传通道 ---------- */
section('存档上传通道');
t('publishFile 带子目录，远端路径与对外链接都落在 qa/ 下（mock 掉 ssh 与 scp）', () => {
  const cp = require('node:child_process');
  const real = cp.execFile;
  const calls = [];
  cp.execFile = function (bin, args, opts, cb) {
    calls.push(bin + ' ' + args.join(' '));
    cb(null, '', '');
  };
  const cfg = {
    reportSsh: 'blogpreview',
    reportRemoteRoot: '/www/wwwroot/blogpreview.horntech-dev.com/reports',
    reportUrlBase: 'https://agencyreport.horntech-dev.com/reports',
  };
  let res = null;
  return P.publishFile(cfg, 'benscurtains', A.ARCHIVE_SUBDIR, 'task-61-before.html', '/tmp/x.html', null)
    .then((r) => {
      res = r;
    })
    .then(() => {
      cp.execFile = real;
      assert.strictEqual(calls.length, 3);
      assert.ok(calls[0].indexOf('mkdir -p /www/wwwroot/blogpreview.horntech-dev.com/reports/benscurtains/qa') > -1);
      assert.strictEqual(
        res.url,
        'https://agencyreport.horntech-dev.com/reports/benscurtains/qa/task-61-before.html'
      );
      assert.strictEqual(
        res.remotePath,
        '/www/wwwroot/blogpreview.horntech-dev.com/reports/benscurtains/qa/task-61-before.html'
      );
    })
    .catch((e) => {
      cp.execFile = real;
      throw e;
    });
});
t('publishFile 的子目录也过白名单', () => {
  const cfg = { reportRemoteRoot: '/r', reportUrlBase: 'https://x/r' };
  return P.publishFile(cfg, 'demo', '../etc', 'a.html', '/tmp/a.html', null).then(
    () => {
      throw new Error('越界的子目录应当被拒');
    },
    (e) => {
      assert.ok(/不安全/.test(e.message));
    }
  );
});


console.log('changeset 与方案 lint');
t('compareFiles：多出的文件算 extra，少的算 missing，一致时 text 为空', () => {
  const r = A.compareFiles(['pages/index.html', 'config.json'], ['/pages/index.html', 'config.json']);
  assert.deepStrictEqual(r.extra, []); assert.deepStrictEqual(r.missing, []); assert.strictEqual(r.text, '');
  const r2 = A.compareFiles(['pages/index.html'], ['pages/index.html', 'posts/x.md']);
  assert.deepStrictEqual(r2.extra, ['posts/x.md']); assert.ok(r2.text.indexOf('多出') > -1);
  const r3 = A.compareFiles(['pages/a.html', 'pages/b.html'], ['pages/a.html']);
  assert.deepStrictEqual(r3.missing, ['pages/b.html']);
  const r4 = A.compareFiles(['posts/x.json'], [{ path: 'posts/x.json', preEtag: 'a', postEtag: 'b' }, { path: 'posts-index.json', preEtag: 'e', postEtag: 'e' }, { path: 'config.json', preEtag: 'q', postEtag: 'q' }, { path: 'history/2026-x.json' }]);
  assert.deepStrictEqual(r4.extra, []); assert.deepStrictEqual(r4.side, ['posts-index.json', 'config.json', 'history/2026-x.json']);
  const r5 = A.compareFiles(['posts/x.json'], [{ path: 'config.json', preEtag: 'q', postEtag: 'r' }]);
  assert.deepStrictEqual(r5.extra, ['config.json']);
});
t('planFilesOf 从方案末尾 json 取 files', () => {
  assert.deepStrictEqual(A.planFilesOf('# 方案\n...\n```json\n{"target_urls":[],"files":["pages/index.html"," config.json "]}\n```'), ['pages/index.html', 'config.json']);
  assert.deepStrictEqual(A.planFilesOf('没有 json'), []);
});
t('buildNoteHeader 带 changeset 行与文件核对行', () => {
  const h = A.buildNoteHeader({ affectedUrls: [], judge: A.judgeChecks(null), changesetId: 'cs_1', changesetFiles: ['pages/index.html'], fileMismatch: '方案声明但未碰到 config.json' });
  const lines = h.split('\n');
  assert.ok(lines.some((l) => l === 'changeset: cs_1（1 文件: pages/index.html）'), lines.join(' | '));
  assert.ok(lines.some((l) => l.indexOf('文件核对: 方案声明但未碰到') === 0));
});
t('compareFiles：声明里的 * 通配匹配平台生成的文件名，且不跨目录', () => {
  const r = A.compareFiles(['assets/*-og-home-sea-view.jpg', 'config.json'], ['assets/1787989752406-d3bg92-og-home-sea-view.jpg', 'config.json']);
  assert.deepStrictEqual(r.extra, []);
  assert.deepStrictEqual(r.missing, []);
  const r2 = A.compareFiles(['assets/*.jpg'], ['assets/sub/x.jpg', 'pages/a.html']);
  assert.deepStrictEqual(r2.extra.sort(), ['assets/sub/x.jpg', 'pages/a.html']);
  assert.deepStrictEqual(r2.missing, ['assets/*.jpg']);
});
t('lintPlan：快照前置、PUT redirects、禁区路径、字段断言、缺文件清单各打回一次', () => {
  const ok = '## 2. API 调用序列\n步骤 1 PATCH /api/content/x/edit\n- 预期响应：200\n- 回读核对：GET elements 比对\n涉及文件：pages/index.html\n本方案不含 `POST /snapshots`，不碰 `/api/domains/*`、`/api/admin/*`。\n## 3. 变更预览\n附：v1 的 POST /api/content/x/snapshots 已删除';
  assert.deepStrictEqual(E.lintPlan(ok), []);
  assert.ok(E.lintPlan('## 2. API 调用序列\n步骤 1 POST /api/content/x/snapshots\n涉及文件：a').some((x) => x.indexOf('snapshots') > -1));
  assert.ok(E.lintPlan('## 2. API 调用序列\nPUT /api/content/x/redirects\n涉及文件：a').some((x) => x.indexOf('PUT') > -1));
  assert.ok(E.lintPlan('## 2. API 调用序列\nGET /api/admin/users\n涉及文件：a').some((x) => x.indexOf('/api/admin') > -1));
  assert.deepStrictEqual(E.lintPlan('## 2. API 调用序列\n不碰 /api/admin，本方案无 API 调用\n涉及文件：无'), []);
  assert.deepStrictEqual(E.lintPlan('## 2. API 调用序列\n- 任何位置都不得调用 \`POST /api/content/x/snapshots\`。\n- 本方案不使用全站快照，不出现 POST /snapshots。\n涉及文件：a'), []);
  assert.ok(E.lintPlan('- 预期响应：200，回读体里 seo.title 逐字相等\n涉及文件：a').some((x) => x.indexOf('字段断言') > -1));
  assert.ok(E.lintPlan('- 预期响应：200\n- 回读核对：GET').some((x) => x.indexOf('涉及文件') > -1));
  assert.deepStrictEqual(E.planFiles('x\n```json\n{"files":["pages/a.html"]}\n```'), ['pages/a.html']);
});
t('lintPlan：选择题打回，但「需要人定：无」是 prompt 要求的空章节写法不打回（2026-09-08 job549 误伤）', () => {
  const base = '## 2. API 调用序列\n- 预期响应：200\n涉及文件：a\n';
  assert.ok(E.lintPlan(base + '- 需要人定：追加的三条暂停广告是否一并对齐').some((x) => x.indexOf('选择题') > -1));
  assert.deepStrictEqual(E.lintPlan(base + '- 需要人定：无。'), []);
  assert.deepStrictEqual(E.lintPlan(base + '需要人定：暂无'), []);
  assert.deepStrictEqual(E.lintPlan(base + '- 需要人定：等客户：确认促销词是否保留'), []);
  assert.deepStrictEqual(E.lintPlan(base + '- 需要人定：无。两处拦截按既定口径只登记，48 小时后回客户。'), [], '无 后带补充说明不算选择题(job561)');
  assert.ok(E.lintPlan(base + '- 需要人定：无法确定预算归属，请人工判断').some((x) => x.indexOf('选择题') > -1), '无法开头不吃豁免');
  assert.deepStrictEqual(E.lintPlan(base + '**需要人定**：无。'), [], 'markdown 粗体装饰不卡豁免(job635)');
  assert.deepStrictEqual(E.lintPlan(base + '- `需要人定`：暂无'), [], '反引号装饰不卡豁免');
});
t('放行卡：提取、超长打回、夹带 curl 或接口路径打回', () => {
  const card = '- 改什么：/childcare/ 面包屑，旧标题 → 新标题\n- 为什么：页面已改版\n- 风险与回滚：改回原值\n- 需要人定：无';
  const plan = '# 标题\n\n## 0. 放行卡\n\n' + card + '\n\n## 1. 变更目标与现状\n\n取证\n## 2. API 调用序列\n涉及文件：a';
  assert.strictEqual(E.planReleaseCard(plan), card);
  assert.strictEqual(E.planReleaseCard('## 1. 变更目标与现状\nx'), '');
  assert.deepStrictEqual(E.lintReleaseCard(plan), []);
  assert.ok(E.lintPlan(plan.replace(card, '啊'.repeat(E.RELEASE_CARD_MAX_CHARS + 1))).some((x) => x.indexOf('上限') > -1));
  assert.ok(E.lintReleaseCard(plan.replace('改回原值', '反向 PATCH /api/pages/x')).some((x) => x.indexOf('夹带') > -1));
  assert.ok(E.lintReleaseCard(plan.replace('改回原值', '跑 curl 回读')).some((x) => x.indexOf('夹带') > -1));
});

t('OPS_CHECK 声明解析：readonly / needs / capability-gap / 缺失 / 花名', () => {
  assert.deepStrictEqual(E.parseOpsCheck('报告正文\nOPS_CHECK: readonly'), { kind: 'readonly' });
  assert.deepStrictEqual(E.parseOpsCheck('x\nOPS_CHECK: needs collection-meta-update, redirect-add\n'), {
    kind: 'needs', ops: ['collection-meta-update', 'redirect-add'],
  });
  const gap = E.parseOpsCheck('x\nOPS_CHECK: capability-gap 导航菜单没有机器通路');
  assert.strictEqual(gap.kind, 'gap');
  assert.ok(gap.note.indexOf('导航菜单') > -1);
  assert.strictEqual(E.parseOpsCheck('全文没有声明'), null, '不声明返回 null，维持从严');
  assert.strictEqual(E.parseOpsCheck('OPS_CHECK: readonly\n后文\nOPS_CHECK: capability-gap 后者算数').kind, 'gap', '取最后一次出现');
  assert.strictEqual(E.parseOpsCheck('OPS_CHECK: 随便写点什么').kind, 'gap', '不识别的格式按 gap 从严');
  assert.strictEqual(E.parseOpsCheck('OPS_CHECK: needs ').kind, 'gap', 'needs 空列表按 gap');
});

t('planItems：显式空数组是无变更声明，不走 ops 兜底（批二 B，Merii #1171）', () => {
  const task = { ops: 'campaign-create,ad-create' };
  const noChange = '方案正文\n```json\n{"target_urls":[],"files":[],"items":[]}\n```';
  assert.deepStrictEqual(E.planItems(noChange, task), [], '空数组必须原样保留，伪造条目会抹掉零写入信号');
  assert.strictEqual(E.planDeclaresNoChange(noChange), true);
  const noJson = '方案正文没有末尾 json';
  const fb = E.planItems(noJson, task);
  assert.strictEqual(fb.length, 2, 'json 缺失仍走 ops 兜底，账本可以粗不许空');
  assert.ok(fb[0].entity.indexOf('方案未拆条') > -1);
  assert.strictEqual(E.planDeclaresNoChange(noJson), false, '忘了记账不等于没有变更');
  const withItems = '正文\n```json\n{"items":[{"op":"ad-create","entity":"ad 123","target":"x"}]}\n```';
  assert.strictEqual(E.planItems(withItems, task).length, 1);
  assert.strictEqual(E.planDeclaresNoChange(withItems), false);
  const malformed = '正文\n```json\n{"items":[{"op":"ad-create"}]}\n```';
  assert.strictEqual(E.planItems(malformed, task).length, 2, '条目全部缺 entity 按忘了记账走兜底');
  assert.strictEqual(E.planDeclaresNoChange(malformed), false, '有条目但全坏不算无变更声明');
});

Promise.all(pending).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});

console.log('行为闸：方案结构类调用探测（#76 教训）');
t('POST 建页命中，rebuild/branding 子段不误报，DELETE 页与 PUT nav 命中', () => {
  const A = require(path.join(__dirname, '..', 'seo-worker', 'runners', 'apply_task'));
  const plan = [
    '- 调用 POST /api/pages/{siteId}，body {"title":"Fees","placeholder":true}',
    '- 调用 POST /api/pages/{siteId}/{slug}/rebuild 重建正文',
    '- 调用 POST /api/pages/{siteId}/branding 换 favicon',
    '- `DELETE /api/pages/{siteId}/old-page`',
    '- PUT /api/nav/{siteId} 更新菜单',
  ].join('\n');
  const got = A.planStructuralCalls(plan).sort();
  assert.deepStrictEqual(got, ['nav-edit', 'page-create', 'page-delete', 'page-rebuild'].sort());
  assert.deepStrictEqual(A.planStructuralCalls('PATCH /api/content/{siteId}/edit 改 5 处文案'), []);
});

console.log('行为闸 Shopify 版：未申报 shopseo 命令探测');
t('publish/create/redirect/set-handle 命中，已申报的不报，meta 小改不管', () => {
  const A = require(path.join(__dirname, '..', 'seo-worker', 'runners', 'apply_task'));
  const plan = [
    'shopseo --shop sungait article publish best-sunglasses',
    'shopseo --shop sungait collection create --title "Rimless" --handle rimless',
    'shopseo --shop sungait redirect add /old /new',
    'shopseo --shop sungait article set-meta foo --title "Bar"',
  ].join('\n');
  assert.deepStrictEqual(A.shopseoUndeclaredOps(plan, ['article-meta-update']).sort(),
    ['article-publish', 'collection-create', 'redirect-add']);
  assert.deepStrictEqual(A.shopseoUndeclaredOps(plan, ['article-publish', 'collection-create', 'redirect-add']), []);
  assert.deepStrictEqual(A.shopseoUndeclaredOps('shopseo --shop x theme copy a b', ['theme-template-create']), []);
  assert.deepStrictEqual(A.shopseoUndeclaredOps('shopseo --shop x theme set-text k --jq .a --value v', []), ['theme-text-edit']);
});

console.log('无方案续接：chain=execute 必须真的到达服务端（#814 教训，留言必须出现在收件人输入里）');
t('方案文件缺失：postTaskResult 收到 chain=execute 且 note 说明零改动，随后抛错', async () => {
  const A2 = require(path.join(__dirname, '..', 'seo-worker', 'runners', 'apply_task'));
  const fs2 = require('fs');
  const os = require('os');
  const ws = fs2.mkdtempSync(path.join(os.tmpdir(), 'applytest-'));
  fs2.mkdirSync(path.join(ws, 'seo-agent-output'), { recursive: true });
  const posted = [];
  const ctx = {
    api: { postTaskResult: async (id, body) => { posted.push({ id, body }); return { ok: true }; } },
    log: () => {},
  };
  let threw = null;
  try { await A2.loadChangePlanOrChain(ctx, ws, 777); } catch (e) { threw = e; }
  assert.ok(threw, '缺方案必须抛错让 job fail 留痕');
  assert.ok(/execute chained/.test(threw.message), '报错要说明已续排: ' + threw.message);
  assert.strictEqual(posted.length, 1, '必须恰好上报一次');
  assert.strictEqual(posted[0].id, 777);
  assert.strictEqual(posted[0].body.chain, 'execute', 'chain 字段必须是 execute');
  assert.ok(/零改动/.test(posted[0].body.note), 'note 要写明零改动');
});
t('方案文件为空：照旧抛错，不上报 chain（空文件是 execute 产出坏，续排只会复读）', async () => {
  const A2 = require(path.join(__dirname, '..', 'seo-worker', 'runners', 'apply_task'));
  const fs2 = require('fs');
  const os = require('os');
  const ws = fs2.mkdtempSync(path.join(os.tmpdir(), 'applytest-'));
  fs2.mkdirSync(path.join(ws, 'seo-agent-output'), { recursive: true });
  fs2.writeFileSync(path.join(ws, 'seo-agent-output', 'change-plan-task-778.md'), '   \n');
  const posted = [];
  const ctx = { api: { postTaskResult: async (id, body) => { posted.push(body); } }, log: () => {} };
  let threw = null;
  try { await A2.loadChangePlanOrChain(ctx, ws, 778); } catch (e) { threw = e; }
  assert.ok(threw && /empty/.test(threw.message));
  assert.strictEqual(posted.length, 0);
});
t('方案文件存在：原样返回，不碰 API', async () => {
  const A2 = require(path.join(__dirname, '..', 'seo-worker', 'runners', 'apply_task'));
  const fs2 = require('fs');
  const os = require('os');
  const ws = fs2.mkdtempSync(path.join(os.tmpdir(), 'applytest-'));
  fs2.mkdirSync(path.join(ws, 'seo-agent-output'), { recursive: true });
  fs2.writeFileSync(path.join(ws, 'seo-agent-output', 'change-plan-task-779.md'), '# plan body');
  const ctx = { api: { postTaskResult: async () => { throw new Error('不该被调'); } }, log: () => {} };
  const plan = await A2.loadChangePlanOrChain(ctx, ws, 779);
  assert.strictEqual(plan, '# plan body');
});

console.log('行为闸 WordPress 版：未申报 wfagent 命令与插件端点探测');
t('CLI 与裸 REST 两种形态都命中,已申报不报,博客产线近邻豁免', () => {
  const A3 = require(path.join(__dirname, '..', 'seo-worker', 'runners', 'apply_task'));
  const plan = [
    'wfagent content create kiaorakids --type post --title "Guide"',
    'wfagent content set kiaorakids 15672 --status publish',
    'wfagent seo set kiaorakids term 12 --title "Category"',
    'wfagent redirect add kiaorakids /old /new',
  ].join('\n');
  // 全裸奔:五个 op 全报(publish 行同时命中 content-edit,零申报时从严)
  assert.deepStrictEqual(A3.wfagentUndeclaredOps(plan, []).sort(),
    ['blog-publish', 'wp-content-edit', 'wp-draft-create', 'wp-redirect-add', 'wp-term-seo-update'].sort());
  // 全申报:零报
  assert.deepStrictEqual(A3.wfagentUndeclaredOps(plan, ['wp-draft-create', 'blog-publish', 'wp-term-seo-update', 'wp-redirect-add']), []);
  // 博客产线:建稿+发布已申报时,正文与 SEO 字段写入是份内事不报
  const blogPlan = [
    'wfagent content create sdalu --type post --title "Bollards"',
    'wfagent content set sdalu 991 --content-file body.html',
    'wfagent seo set sdalu post 991 --title "Bollards NZ" --desc "..."',
  ].join('\n');
  assert.deepStrictEqual(A3.wfagentUndeclaredOps(blogPlan, ['wp-draft-create', 'blog-publish']), []);
  // 但发布翻转没申报照样报
  assert.deepStrictEqual(A3.wfagentUndeclaredOps('wfagent content set sdalu 991 --status publish', ['wp-content-edit']), ['blog-publish']);
  // 裸 REST 形态
  assert.deepStrictEqual(A3.wfagentUndeclaredOps('POST https://sdalu.co.nz/wp-json/wf-agent/v1/rankmath/redirections body {...}', []), ['wp-redirect-add']);
  assert.deepStrictEqual(A3.wfagentUndeclaredOps('PATCH /wp-json/wf-agent/v1/content/15672 body {"status":"publish"}', ['wp-content-edit']).sort(), ['blog-publish']);
  assert.deepStrictEqual(A3.wfagentUndeclaredOps('PATCH /wp-json/wf-agent/v1/seo/14935 {"title":"x"}', ['wp-seo-meta-update']), []);
  // 只读不报
  assert.deepStrictEqual(A3.wfagentUndeclaredOps('wfagent status sdalu\nwfagent content get sdalu 991\nGET /wp-json/wf-agent/v1/seo/14935', []), []);
});

t('sitemap flush 随发布豁免,未申报发布时照报', () => {
  const A4 = require(path.join(__dirname, '..', 'seo-worker', 'runners', 'apply_task'));
  const plan = 'wfagent content set kiaorakids 15672 --status publish\nwfagent sitemap flush kiaorakids';
  assert.deepStrictEqual(A4.wfagentUndeclaredOps(plan, ['wp-draft-create', 'blog-publish']), []);
  // 改已发布页后 flush 同样豁免(任何已申报写 op 都算)
  assert.deepStrictEqual(A4.wfagentUndeclaredOps('wfagent content set kiaorakids 14935 --content-file b.html\nwfagent sitemap flush kiaorakids', ['wp-content-edit', 'wp-seo-meta-update']), []);
  assert.deepStrictEqual(A4.wfagentUndeclaredOps('wfagent sitemap flush kiaorakids', []), ['wp-sitemap-flush']);
});
