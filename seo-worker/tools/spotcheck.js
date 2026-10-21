#!/usr/bin/env node
'use strict';
/* 事后抽查器 spotcheck v1（2026-10-21 Alvin 批，改造序①，降软政的配套地基）。
   第一性：默认放行拿掉了事前闸，换来的承诺是「事后抽、异常还原、逮一次堵一类」。
   抽查不是复核那一张单子，是在验证整条自动放行流水线的「申报=现实」契约还成立。
   错是系统性的（fact 过期、spec 歧义、平台过滤器），逮到一个异常的产出必须是
   DEFECTS 一行 + 上游修复点，不是修一张单。

   v1 边界（零模型、零写入现实）：
   - 只读核验：对自动放行/自动落地的 done 任务，独立重读现实（前台 URL、页面源码），
     与申报比对。不做任何平台写入；还原（phase 2）前先人工看 FAIL 台账。
   - 看板写回仅两样且须 --apply：FAIL 任务 attention=1 + note 追加 [spotcheck FAIL]；
     运行台账落 /data/aira/projects/MA/memory/spotcheck/run_<ts>.md（立功与误杀都记）。
   - 人触发（硬规矩 1），不进 cron。

   核验项（generic，四件套登记见 specs/spotcheck.md）：
   C1 可达性：任务产出的客户域 URL 200 且零跳转；预览/卡链接 200。
   C2 内部标记泄漏：客户可见页面源码不得含 Style Roll / card-autotoken / DRAFT NOTE 等内部标记。
   C3 意外 noindex：客户域页面不得带 robots noindex（任务书本身要求 noindex 的豁免）。
   C4 快照证据：写类任务的 note 必须能找到快照/changeset/存档/回滚字样（可逆性的凭证）。

   抽样：watch 名单（新 op / 刚降软覆盖的 op）100% 抽；其余按 --rate（默认 0.1，下限 3 张）。

   用法：SEO_AGENT_TOKEN=... node tools/spotcheck.js [--client <id>] [--task <id>] [--days 7]
         [--rate 0.1] [--max 12] [--apply]
   默认 dry-run：核验照跑（全只读），但 FAIL 不写看板。--apply 才写 attention+note。 */

const fs = require('fs');
const path = require('path');

const API = process.env.SEO_API_BASE || 'https://always.horntech-dev.com/seo-api.php';
const TOKEN = process.env.SEO_AGENT_TOKEN || '';
const argv = process.argv.slice(2);
function argVal(name, dflt) { const i = argv.indexOf(name); return i === -1 ? dflt : argv[i + 1]; }
const ONLY_CLIENT = parseInt(argVal('--client', '0'), 10) || 0;
const ONLY_TASK = parseInt(argVal('--task', '0'), 10) || 0;
const DAYS = parseInt(argVal('--days', '7'), 10) || 7;
const RATE = parseFloat(argVal('--rate', '0.1')) || 0.1;
const MAX = parseInt(argVal('--max', '12'), 10) || 12;
const APPLY = argv.includes('--apply');
if (!TOKEN) { console.error('用法：SEO_AGENT_TOKEN=... node tools/spotcheck.js [--client N] [--task N] [--days 7] [--rate 0.1] [--max 12] [--apply]'); process.exit(2); }

/* watch 名单：新上线或刚降软覆盖的 op，100% 抽。维护口径：op 上线满 30 天零异常后移出
   （随闸年检一起看），名单改这里并在 specs/spotcheck.md 同步。 */
const WATCH_OPS = ['geo-target-set', 'theme-code-update', 'wp-term-description-set', 'content-edit', 'page-rewrite', 'theme-text-edit'];

/* 自动放行/自动落地的标记（抽样域 = 没有人眼看过就落地的单）。 */
const AUTO_RE = /\[auto-release|\[auto-apply|\[applied\]/;

/* 内部标记黑名单：出现在客户可见页面源码里即 FAIL。只放我们自产的标记，
   不拦客户站自己的注释（误杀出口：条目精确、可在本表移除）。 */
const LEAK_MARKS = [
  { name: 'Style Roll 注释', re: /<!--\s*Style Roll/i },
  { name: '卡片自动令牌脚本', re: /data-card-autotoken/i },
  { name: 'DRAFT NOTE 内部备注', re: /<!--[^>]{0,120}DRAFT NOTE/i },
  { name: 'Editor note 内部备注', re: /<!--[^>]{0,120}Editor note/i },
  { name: '待客户确认占位', re: /PENDING CLIENT CONFIRMATION/i },
];

/* 只读分析类 op 不抽（没有现实写入可核）。与 release_policy.json readonly_ops 同步。 */
let READONLY_OPS = [];
try { READONLY_OPS = require(path.join(__dirname, '..', 'specs', 'release_policy.json')).readonly_ops.ops || []; } catch (e) { READONLY_OPS = []; }

async function call(method, p, body) {
  const r = await fetch(API + p, {
    method,
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = {}; }
  if (!r.ok) throw new Error(method + ' ' + p + ' -> ' + r.status + ' ' + t.slice(0, 120));
  return j;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
async function fetchPage(url) {
  try {
    const r = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    const loc = r.headers.get('location') || '';
    const body = r.status === 200 ? await r.text() : '';
    return { status: r.status, location: loc, body };
  } catch (e) {
    return { status: 0, location: '', body: '', error: e.message };
  }
}

/* 从任务产出里收 URL，分两类：客户域（全套检查）与预览/卡链接（只查 200）。 */
function gatherUrls(task, domainHost) {
  const blob = String(task.output_url || '') + '\n' + String(task.result_note || '');
  const all = Array.from(new Set(blob.match(/https?:\/\/[^\s)\]>，。"'<]+/g) || []));
  const client = [], preview = [];
  for (const u of all) {
    let host = '';
    try { host = new URL(u).hostname; } catch (e) { continue; }
    if (domainHost && (host === domainHost || host === 'www.' + domainHost || 'www.' + host === domainHost)) {
      if (!/\?preview=/.test(u)) client.push(u.replace(/[.,;]+$/, ''));
      else preview.push(u);
    } else if (/agencyreport\.horntech-dev\.com/.test(host)) {
      preview.push(u);
    }
  }
  return { client: client.slice(0, 6), preview: preview.slice(0, 4) };
}

function taskMentionsNoindex(task) {
  return /noindex|不收录|未发布|草稿/i.test(String(task.title || '') + String(task.detail || ''));
}

/* 单任务核验，返回 { verdict: 'ok'|'warn'|'fail', findings: [] }。 */
async function checkTask(task, client) {
  const findings = [];
  const domainHost = String(client.domain || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const urls = gatherUrls(task, domainHost);

  for (const u of urls.client) {
    const p = await fetchPage(u);
    if (p.status !== 200) {
      findings.push({ sev: 'fail', check: 'C1', msg: '客户域 URL 非 200（' + (p.status || p.error) + (p.location ? ' -> ' + p.location : '') + '）：' + u });
      continue;
    }
    for (const m of LEAK_MARKS) {
      if (m.re.test(p.body)) findings.push({ sev: 'fail', check: 'C2', msg: '页面源码含内部标记「' + m.name + '」：' + u });
    }
    if (/<meta[^>]+robots[^>]+noindex/i.test(p.body) && !taskMentionsNoindex(task)) {
      findings.push({ sev: 'fail', check: 'C3', msg: '页面带 noindex 且任务书未要求：' + u });
    }
  }
  for (const u of urls.preview) {
    const p = await fetchPage(u);
    if (p.status !== 200 && p.status !== 301 && p.status !== 302) {
      findings.push({ sev: 'warn', check: 'C1', msg: '预览/卡链接不可达（' + (p.status || p.error) + '）：' + u });
    }
  }

  const note = String(task.result_note || '');
  if (!/changeset|快照|snapshot|存档|回滚|apply-log|revert/i.test(note)) {
    findings.push({ sev: 'warn', check: 'C4', msg: '写类任务 note 找不到快照/回滚证据字样（可逆性凭证缺失，人工看一眼附件）' });
  }
  if (!urls.client.length && !urls.preview.length) {
    findings.push({ sev: 'info', check: 'C0', msg: '任务产出无可核 URL（账户侧/站内配置类），本轮仅证据检查' });
  }

  const verdict = findings.some((f) => f.sev === 'fail') ? 'fail' : findings.some((f) => f.sev === 'warn') ? 'warn' : 'ok';
  return { verdict, findings, urlCount: urls.client.length + urls.preview.length };
}

function isWriteAuto(t) {
  const ops = String(t.ops || '').split(/[,\s]+/).filter(Boolean);
  if (!ops.length) return false;
  if (ops.every((o) => READONLY_OPS.includes(o))) return false;
  return AUTO_RE.test(String(t.result_note || ''));
}

function withinDays(t, days) {
  const ts = Date.parse(String(t.updated_at || t.created_at || '').replace(' ', 'T') + 'Z');
  return !isNaN(ts) && Date.now() - ts < days * 86400 * 1000;
}

(async () => {
  const clients = (await call('GET', '/clients')).clients.filter((c) => c.status === 'active' && (!ONLY_CLIENT || c.client_id === ONLY_CLIENT));
  const pool = [];
  for (const c of clients) {
    const ts = (await call('GET', '/tasks?client_id=' + c.client_id + '&include_archived=1')).tasks || [];
    for (const t of ts) {
      if (ONLY_TASK && t.id !== ONLY_TASK) continue;
      if (!ONLY_TASK) {
        if (t.status !== 'done') continue;
        if (!withinDays(t, DAYS)) continue;
        if (!isWriteAuto(t)) continue;
      }
      pool.push({ t, c });
    }
  }
  if (!pool.length) { console.log('抽样域为空（近 ' + DAYS + ' 天无自动放行的写类 done 单）'); return; }

  // watch 优先但也洗牌（否则 watch 命中超封顶时全偏给客户遍历序靠前的），
  // 且至多占 70% 额度，给随机池留位，保证老 op 永远有被抽到的概率。
  const watch = pool.filter((x) => String(x.t.ops || '').split(/[,\s]+/).some((o) => WATCH_OPS.includes(o)));
  const rest = pool.filter((x) => !watch.includes(x));
  const shuffle = (a) => a.slice().sort(() => Math.random() - 0.5);
  const nWatch = Math.min(watch.length, Math.max(1, Math.ceil(MAX * 0.7)));
  const nRandom = Math.min(rest.length, Math.max(3, Math.round(rest.length * RATE)));
  const picked = shuffle(watch).slice(0, nWatch).concat(shuffle(rest).slice(0, nRandom)).slice(0, MAX);

  console.log('抽样域 ' + pool.length + ' 张（watch ' + watch.length + '），本轮抽 ' + picked.length + ' 张' + (APPLY ? '' : '（dry-run，FAIL 不写看板）'));
  const lines = [];
  let ok = 0, warn = 0, fail = 0;
  for (const { t, c } of picked) {
    const r = await checkTask(t, c);
    const head = '#' + t.id + ' ' + c.name + '「' + String(t.title || '').slice(0, 40) + '」ops=' + (t.ops || '-') + ' urls=' + r.urlCount;
    console.log('[' + r.verdict.toUpperCase() + '] ' + head);
    for (const f of r.findings) console.log('   ' + f.sev + ' ' + f.check + ' ' + f.msg);
    lines.push('- [' + r.verdict + '] ' + head + (r.findings.length ? '\n' + r.findings.map((f) => '  - ' + f.sev + ' ' + f.check + ' ' + f.msg).join('\n') : ''));
    if (r.verdict === 'ok') ok++; else if (r.verdict === 'warn') warn++; else fail++;
    if (r.verdict === 'fail' && APPLY) {
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const note = String(t.result_note || '') + '\n\n[spotcheck FAIL ' + stamp + '] ' + r.findings.filter((f) => f.sev === 'fail').map((f) => f.check + ' ' + f.msg).join('；') + '。抽查器只读不还原，处置见台账与 DEFECTS。';
      await call('PATCH', '/tasks/' + t.id, { attention: 1, result_note: note });
      console.log('   已写回：attention=1 + note');
    }
  }

  const dir = '/data/aira/projects/MA/memory/spotcheck';
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'run_' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.md');
  fs.writeFileSync(file, [
    '# spotcheck 台账 ' + new Date().toISOString(),
    '参数：days=' + DAYS + ' rate=' + RATE + ' max=' + MAX + ' apply=' + APPLY + (ONLY_CLIENT ? ' client=' + ONLY_CLIENT : '') + (ONLY_TASK ? ' task=' + ONLY_TASK : ''),
    '抽样域 ' + pool.length + '，抽 ' + picked.length + '：ok ' + ok + '，warn ' + warn + '，fail ' + fail,
    '',
    lines.join('\n'),
    '',
    '处置规矩：fail 先人工定性（现实错 or 抽查器误杀），现实错记 DEFECTS 一行并修上游堵整类；误杀改本工具的规则（LEAK_MARKS/豁免条目）。',
  ].join('\n'), 'utf8');
  console.log('\n汇总：ok ' + ok + '，warn ' + warn + '，fail ' + fail + '。台账 ' + file);
  if (fail) process.exitCode = 1;
})().catch((e) => { console.error('spotcheck 异常退出：' + e.message); process.exit(2); });
