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
  assert.strictEqual(lines[3], '检查: 通过 2 项，待人工 2 项（V12 Rich Results Test、V13 收录跟进）');
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
  assert.ok(h.indexOf('检查: 通过 1 项，未通过 1 项（V3 禁区词清零），待人工 1 项（V13 收录跟进）') > -1);
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
  assert.ok(p.indexOf('到摘要后面那个 json 块结束') > -1, '收尾约束要与新增的 json 块一致');
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
t('lintPlan：快照前置、PUT redirects、禁区路径、字段断言、缺文件清单各打回一次', () => {
  const ok = '## 2. API 调用序列\n步骤 1 PATCH /api/content/x/edit\n- 预期响应：200\n- 回读核对：GET elements 比对\n涉及文件：pages/index.html';
  assert.deepStrictEqual(E.lintPlan(ok), []);
  assert.ok(E.lintPlan('步骤 1 POST /api/content/x/snapshots\n涉及文件：a').some((x) => x.indexOf('snapshots') > -1));
  assert.ok(E.lintPlan('PUT /api/content/x/redirects\n涉及文件：a').some((x) => x.indexOf('PUT') > -1));
  assert.ok(E.lintPlan('GET /api/admin/users\n涉及文件：a').some((x) => x.indexOf('/api/admin') > -1));
  assert.ok(E.lintPlan('- 预期响应：200，回读体里 seo.title 逐字相等\n涉及文件：a').some((x) => x.indexOf('字段断言') > -1));
  assert.ok(E.lintPlan('- 预期响应：200\n- 回读核对：GET').some((x) => x.indexOf('涉及文件') > -1));
  assert.deepStrictEqual(E.planFiles('x\n```json\n{"files":["pages/a.html"]}\n```'), ['pages/a.html']);
});

Promise.all(pending).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
});
