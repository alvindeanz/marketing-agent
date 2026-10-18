'use strict';
// 确认卡产线批三接线回归：任务识别（card_kinds.json 同源）、card_data 块抽取、
// 落盘与渲染（文件名月份 == issued 由构造保证）、契约注入内容。
// 跨端夹具 tests/fixtures/card_data_t1464.json 同时是 askreg 与本产线的契约钉子。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const X = require(path.join(__dirname, '..', 'seo-worker', 'runners', 'execute_task.js'));

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'card_data_t1464.json'), 'utf8'));

// 1) 任务识别：ops 首个命中；显式 card_kind 要在注册表且 ops 非空；博客卡不走这里
assert.strictEqual(X.confirmationCardKind({ ops: 'keyword-confirmation,mapping-confirmation' }), 'keyword_confirmation', '合卡取首个命中（card_kind_of 同行为）');
assert.strictEqual(X.confirmationCardKind({ ops: 'mapping-confirmation' }), 'mapping_confirmation');
assert.strictEqual(X.confirmationCardKind({ card_kind: 'keyword_confirmation', ops: '' }), 'keyword_confirmation', '显式 card_kind 直接认');
assert.strictEqual(X.confirmationCardKind({ card_kind: 'blog_confirmation', ops: '' }), '', '博客卡 ops 空，有自己的产线');
assert.strictEqual(X.confirmationCardKind({ ops: 'blog-draft' }), '', '非卡任务不误判');
assert.strictEqual(X.confirmationCardKind({ ops: 'keyword-direction' }), '', '方向卡不走确认卡产线');

// 2) card_data 块抽取：无块 null（静默路径合法）、好块回对象、坏 JSON 抛错
assert.strictEqual(X.extractCardData('纯报告，没有块。\nOPS_CHECK: readonly'), null);
const goodOut = '摘要一段。\n\n```card_data\n' + JSON.stringify(fixture) + '\n```\nOPS_CHECK: readonly';
assert.strictEqual(X.extractCardData(goodOut).card_kind, 'keyword_confirmation');
assert.throws(() => X.extractCardData('```card_data\n{oops\n```'), /合法 JSON/);

// 3) 落盘与渲染：夹具整卡过产线，data.json 与 HTML 同名落 reports/，HTML 的题出自 items
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'confwire-'));
fs.mkdirSync(path.join(ws, 'reports'));
const made = X.materialiseConfirmationCard(fixture, 'keyword_confirmation', ws, null);
assert.strictEqual(path.basename(made.dataFile), 'keyword_confirmation_' + path.basename(ws) + '_' + fixture.issued + '.data.json', '文件名月份 == issued 由构造保证');
assert.strictEqual(made.html, path.basename(made.htmlFile));
const html = fs.readFileSync(made.htmlFile, 'utf8');
for (const it of fixture.items) {
  if (it.type === 'text') continue;
  assert(html.includes('data-item="' + it.item_id + '"'), '缺题 ' + it.item_id);
}
assert(JSON.stringify(JSON.parse(fs.readFileSync(made.dataFile, 'utf8'))) === JSON.stringify(fixture), '落盘的 data.json 与模型产出字节级同义');

// 4) card_kind 不符与校验不过都原样抛（错误是自修输入）
assert.throws(() => X.materialiseConfirmationCard(fixture, 'mapping_confirmation', ws, null), /本任务要求 mapping_confirmation/);
const bad = JSON.parse(JSON.stringify(fixture));
delete bad.default_policy;
assert.throws(() => X.materialiseConfirmationCard(bad, 'keyword_confirmation', ws, null), /default_policy 产线必填/);

// 5) 契约注入：带围栏指引、规格标记、schema 常量、任务 card_kind 与本月 issued
const contract = X.cardDataContract('keyword_confirmation');
assert(contract.includes('```card_data'), '围栏指引在');
assert(contract.includes('CONFIRMATION-CARD-V1'), '规格全文注入');
assert(contract.includes('card_data/v1'), 'schema 注入');
assert(contract.includes('card_kind 写 "keyword_confirmation"'));
assert(contract.includes('issued 写 "' + new Date().toISOString().slice(0, 7) + '"'));
assert(contract.includes('静默补 fact 路径时不要输出'), '静默路径的豁免写明');

fs.rmSync(ws, { recursive: true, force: true });
console.log('execute_confirmation_wiring: all ok');
