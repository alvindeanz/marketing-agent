#!/usr/bin/env node
/* specs 完整性：paid 四件套在场且带版本标记。跑法：node tests/specs.test.js
   防的是「指针掉线」：runner 与 skill 都指向这些文件，文件丢了或段落被误删要在测试就红。 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const S = path.join(__dirname, '..', 'seo-worker', 'specs');
const WANT = [
  ['review_principles.md', 'PAID-PRINCIPLES-V'],
  ['plan_experience.md', 'PAID-EXPERIENCE-V'],
  [path.join('capabilities', 'googleads.md'), 'PAID-CAP-GOOGLEADS-V'],
  [path.join('report', 'paid_section.md'), 'PAID-REPORT-V'],
];

let fail = 0;
for (const [file, marker] of WANT) {
  const p = path.join(S, file);
  try {
    const text = fs.readFileSync(p, 'utf8');
    assert.ok(text.includes(marker), 'missing marker ' + marker);
    assert.ok(text.length > 500, 'suspiciously short: ' + text.length + ' chars');
    console.log('  ok   ' + file);
  } catch (e) {
    fail += 1;
    console.log('  FAIL ' + file + ' :: ' + e.message);
  }
}
// review_principles 的 SEO 部分还在（append 不许覆盖）
const rp = fs.readFileSync(path.join(S, 'review_principles.md'), 'utf8');
if (!rp.includes('五问')) { fail += 1; console.log('  FAIL review_principles 丢了原有五问段'); } else console.log('  ok   review_principles 原段完整');

console.log(fail ? '\n' + fail + ' failed' : '\nall ok');
process.exit(fail ? 1 : 0);
