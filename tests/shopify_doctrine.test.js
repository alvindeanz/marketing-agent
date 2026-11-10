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
console.log('\n' + pass + ' passed');
