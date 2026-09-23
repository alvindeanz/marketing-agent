'use strict';
const assert = require('assert');
const sl = require('../seo-worker/lib/shopifylink');

let pass = 0;
let fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('ok  ' + name); } catch (e) { fail++; console.log('FAIL ' + name + ' :: ' + e.message); }
}

const PROFILE = { domain: 'https://www.sungait.com/', workspace_dir: 'sungait', platform: 'Shopify' };
const STORES = 'sungait=110cum-r1.myshopify.com\n# comment\nmidea=mydearnorthshore.myshopify.com\n';
const PUB = { id: 566285074599, blog: 'news', handle: 'best-polarized-sunglasses-for-men-6-picks-compared', published: true, published_at: '2026-09-21T20:16:05-07:00' };
const DRAFT = { id: 566285074600, blog: 'news', handle: 'draft-post', published: false, published_at: null };

(async () => {
  await t('店铺别名按 workspace_dir 匹配', async () => {
    assert.deepStrictEqual(sl.storeFor(PROFILE, STORES), { alias: 'sungait', myshopify: '110cum-r1.myshopify.com' });
    assert.strictEqual(sl.storeFor({ workspace_dir: 'nope' }, STORES), null);
  });

  await t('已发布给正式链接，草稿给 admin 预览链接', async () => {
    assert.strictEqual(sl.linkFor(PUB, PROFILE, '110cum-r1.myshopify.com'), 'https://www.sungait.com/blogs/news/best-polarized-sunglasses-for-men-6-picks-compared');
    assert.strictEqual(sl.linkFor(DRAFT, PROFILE, '110cum-r1.myshopify.com'), 'https://110cum-r1.myshopify.com/admin/articles/566285074600');
    assert.strictEqual(sl.linkFor({ id: 1, blog_handle: 'news', handle: 'x', published_at: '2026-01-01' }, { domain: 'sungait.com' }, 's.myshopify.com'), 'https://sungait.com/blogs/news/x');
  });

  await t('从 #619 式 result_note 认出文章（id 与 handle）', async () => {
    const ref = sl.articleRefOf({ output_url: '', result_note: '[applied] 受影响: blogs/news/best-polarized-sunglasses-for-men-6-picks-compared (article id 566285074599, DRAFT)' });
    assert.strictEqual(ref.id, '566285074599');
    assert.strictEqual(ref.handle, 'best-polarized-sunglasses-for-men-6-picks-compared');
    assert.strictEqual(sl.articleRefOf({ output_url: 'https://110cum-r1.myshopify.com/admin/articles/42' }).id, '42');
    assert.strictEqual(sl.articleRefOf({ result_note: '没有文章' }), null);
  });

  await t('同步：空链接回填、草稿发布后换正式链接、确认卡链接不覆盖、值相同不写', async () => {
    const writes = [];
    const api = { setTaskOutputUrl: async (id, u) => writes.push([id, u]) };
    const tasks = { tasks: [
      { id: 619, ops: 'blog-draft', output_url: '', result_note: 'blogs/news/best-polarized-sunglasses-for-men-6-picks-compared (article id 566285074599)' },
      { id: 700, ops: 'blog-draft', output_url: 'https://110cum-r1.myshopify.com/admin/articles/566285074599' },
      { id: 701, ops: 'blog-draft', output_url: 'https://agencyreport.horntech-dev.com/card?t=701&k=abc123' },
      { id: 702, ops: 'blog-draft', output_url: 'https://110cum-r1.myshopify.com/admin/articles/566285074600' },
      { id: 703, ops: 'meta-update', output_url: '', result_note: 'blogs/news/draft-post' },
    ] };
    const r = await sl.syncClientLinks(api, 51, Object.assign({}, PROFILE, { workspace_dir: 'sungait' }), null, { tasks, articles: [PUB, DRAFT] });
    const want = 'https://www.sungait.com/blogs/news/best-polarized-sunglasses-for-men-6-picks-compared';
    assert.deepStrictEqual(writes, [[619, want], [700, want]]);
    assert.strictEqual(r.changed, 2);
  });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
