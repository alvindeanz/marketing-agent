'use strict';
/* Shopify 读站纪律的适用判据（2026-11-11）：看本客户是不是 Shopify 站，不看任务走哪张能力清单。
   Midea #1992 是 paid 任务（清单路由到 googleads），旧判据不给纪律，agent 对店面 429 退避 26 分钟。 */
const assert = require('node:assert');
const { isShopifySite, SHOPIFY_READ_DOCTRINE } = require('../seo-worker/runners/execute_task');

const STORES = '# alias\nmidea=aw-nz.myshopify.com   https://mideahomes.co.nz\nhaakaa=haakaa-nz.myshopify.com\n# oakfurniture: PENDING\n';
let pass = 0;
function t(name, fn) { fn(); pass++; console.log('  ok   ' + name); }

t('paid 任务路由到 googleads 清单，站是 Shopify 照给纪律', () => {
  assert.strictEqual(isShopifySite('googleads', { platform: 'Shopify', workspace_dir: 'midea' }, STORES), true);
  assert.strictEqual(isShopifySite('googleads', { platform: '', workspace_dir: 'midea' }, STORES), true);
});
t('平台档 shopify 直接命中', () => {
  assert.strictEqual(isShopifySite('shopify', {}, STORES), true);
});
t('没有店铺别名的 Custom 档与 WF 客户不给（Oak 走客户铁律）', () => {
  assert.strictEqual(isShopifySite('custom', { platform: 'Custom', workspace_dir: 'oakfurniture' }, STORES), false);
  assert.strictEqual(isShopifySite('webforger', { platform: 'WebForger', workspace_dir: 'kuddles' }, STORES), false);
  assert.strictEqual(isShopifySite('googleads', { platform: 'WebForger', workspace_dir: 'merii' }, STORES), false);
  assert.strictEqual(isShopifySite('googleads', { platform: 'WebForger', workspace_dir: 'ctomiau' }, 'ctomi=ctomi-nz.myshopify.com\n'), false);
  assert.strictEqual(isShopifySite('googleads', { platform: 'Shopify', workspace_dir: 'ctomi' }, 'ctomi=ctomi-nz.myshopify.com\n'), true);
});
t('纪律正文覆盖链接核验与禁退避', () => {
  assert.ok(/核验链接存不存在/.test(SHOPIFY_READ_DOCTRINE));
  assert.ok(/不许写退避等待循环/.test(SHOPIFY_READ_DOCTRINE));
  assert.ok(/products\.json/.test(SHOPIFY_READ_DOCTRINE));
});

/* chat 工具带的 Shopify 只读面（2026-11-11）：别名钉死本客户，非 Shopify 客户不给。 */
const chat = require('../seo-worker/runners/chat');
const link = require('../seo-worker/lib/shopifylink');
t('exactAlias 整名相等才给：ctomiau 不吃 ctomi', () => {
  assert.strictEqual(link.exactAlias({ workspace_dir: 'midea' }, STORES), 'midea');
  assert.strictEqual(link.exactAlias({ workspace_dir: 'ctomiau' }, 'ctomi=ctomi-nz.myshopify.com\n'), '');
  assert.strictEqual(link.exactAlias({ workspace_dir: 'oakfurniture' }, STORES), '');
  assert.strictEqual(link.exactAlias({ workspace_dir: null }, STORES, 'midea'), 'midea', '档案没填 workspace_dir 用已解析目录名');
  assert.strictEqual(link.exactAlias({}, STORES, 'ctomiau'), '');
});
t('chat 工具带：有别名才出 shopseo-ro，且前缀钉死 --shop 本客户', () => {
  const withShop = chat.chatTools('https://mideahomes.co.nz/', 'midea');
  assert.ok(withShop.split(',').includes('Bash(/data/aira/tools/shopseo/shopseo-ro --shop midea:*)'));
  assert.ok(!/shopseo/.test(chat.chatTools('https://kuddles.co.nz/', '')));
  assert.ok(!/shopseo/.test(chat.chatTools('https://x.co.nz/', 'a b; rm')), '别名带怪字符不授');
  assert.ok(!/shopseo\/shopseo[ :]/.test(withShop), '只授只读包装器不授写 CLI');
});
t('chat prompt：Shopify 客户才出只读查询说明', () => {
  const base = { clientName: 'L', title: 't', briefing: 'B', messages: [] };
  const p = chat.buildPrompt(Object.assign({ shopAlias: 'midea' }, base));
  assert.ok(p.includes('shopseo-ro --shop midea'));
  assert.ok(p.includes('429'));
  assert.ok(!chat.buildPrompt(base).includes('shopseo-ro'));
});
console.log('\n' + pass + ' passed');
