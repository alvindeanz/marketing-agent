# WebForger 能力清单 v1.1

<!-- v1.1 (2026-08-18)：新增 Google 资产操作段（GA4/GSC/GTM/GBP），此前这类活被错派给 agency。v1 (2026-08-13)：首版 12 操作。 -->

平台：WebForger（`https://api.webforger.ai`）
适用：托管在 WebForger 上的客户站，worker 用 shadow bot 账号操作，siteId 取登录响应的 `user.shadowOf`。WebForger 客户的 Google 资产（GA4、GSC、GTM、GBP）由 agency 账号托管并已授权 agent，相关核查与配置工作派 agent，不派 agency。

autonomy 三级的判定标准只有一条：出错以后能不能低成本还原，以及错误在还原前是否已经被客户或搜索引擎看见。

- `agent_apply`：可逆，且平台写前自动归档。agent 可以直接执行。
- `agent_prepare`：对外可见的内容变更。agent 只准备到可执行方案，人放行后由 apply_task 执行。
- `human_only`：不可逆、影响全站或涉及账务域名。agent 一律不碰，只能写建议。

<!-- PLANNING_VIEW_START -->
## 规划视图

| operation | autonomy | 说明 |
|---|---|---|
| redirect-batch | agent_apply | 批量增删 301 重定向，写前平台自动归档 config.json |
| page-rebuild | agent_apply | 按当前主题和业务信息重新生成某页正文 |
| page-meta-update | agent_prepare | 改页面注册表字段：标题、导航显隐、父级、落地页标记 |
| page-rewrite | agent_prepare | 整页正文覆盖重写，用于 SEO 改版 |
| content-edit | agent_prepare | 元素级改文案、图片、按钮，一次最多 50 处 |
| blog-draft | agent_apply | 建与修订未发布博客草稿，公众看不到，改稿不换预览链接 |
| blog-publish | agent_prepare | 发布已审草稿并验证线上，人放行后由 apply 执行 |
| image-generate | agent_prepare | FLUX 生成配图并入库 |
| styles-fragment | agent_prepare | 站点级 CSS 与共享页头页脚片段 |
| domain-ops | human_only | 域名绑定、切换、解绑 |
| page-delete | human_only | 删除页面 |
| theme-global | human_only | 全站主题色、字体、圆角 |
| commerce-bulk | human_only | 电商目录批量改价改库存 |
| ga4-audit | agent_readonly | 只读审计 GA4 事件与转化配置、数据质量，产出核查报告与修复清单，一步出结果不走 prepare/apply |
| gsc-audit | agent_readonly | 只读审计 GSC 索引覆盖、手动操作、安全问题、站点地图状态，一步出结果不走 prepare/apply |
| ga4-config-update | agent_prepare | GA4 配置变更：key event 标记、事件建改、数据流设置 |
| gtm-edit | agent_prepare | GTM 容器变更：标签、触发器、变量，发布留人放行 |
| gbp-update | agent_prepare | GBP 资料修改、类目、发帖、问答维护 |
<!-- PLANNING_VIEW_END -->

<!-- RISK_CLASS_START：放行分级输入（见 ../release_policy.md），与 release_policy.json 一致由 specs 测试断言 -->
## risk_class（放行分级）

- page-meta-update: reversible
- content-edit: reversible
- page-rewrite: reversible（L0 排除：整页覆盖影响面大）
- page-rebuild: reversible（L0 排除）
- redirect-batch: reversible
- blog-draft: external
- blog-publish: external
- image-generate: reversible
- styles-fragment: reversible（L0 排除：全站样式）
- gtm-edit: reversible（L0 排除：追踪链路）
- ga4-config-update: irreversible
- gbp-update: external
- gsc-audit: reversible
- ga4-audit: reversible
<!-- RISK_CLASS_END -->


规划阶段只读上面这张表。下面的细节只给 execute 和 apply 阶段。

## 全局风险注记，写死不可绕过

execute 与 apply 两个阶段的 prompt 都原样带上这一节。这里的规矩来自 Aiden 2026-08-26 的
bot 账号操作说明（/mnt/share/aiden/to-aira-webforger-bot-ops-20260826.md）加当天两次落地失败的复盘。
细节以 `https://api.webforger.ai/api/doc` 为准，本节与在线文档冲突时听在线文档的。

0. **开工三断言。** `POST /api/auth/login` 后断言 `user.isShadow === true` 且 `user.shadowOf` 等于任务书的 siteId；再 `GET /api/content/{siteId}/meta` 看站点状态。三条任一不符，停下报人。
1. **写操作安全网是 changeset，不是全站快照。** apply 阶段由 worker 代开 changeset 并把 id 写进 prompt；**每一个写请求（POST / PATCH / PUT / DELETE）都必须带 header `X-WF-Changeset: <id>`**，服务端会在首次碰到每个文件时存原件。方案里**禁止**把 `POST /api/content/{siteId}/snapshots` 写成前置步骤：250 文件以上的站 restore 必挂，对 SEO 改动也是错的粒度（2026-08-26 Louvresky #83 四轮全死在快照接口 120 秒无响应）。方案第 2 节末尾必须列「涉及文件」清单（例如 `pages/index.html`、`posts/slug.md`、`config.json`），apply 结束 worker 用 `GET /api/changesets/{siteId}/{csId}` 的 `files` 与它比对，多出来的文件就是失败。**平台副产物不算多出**：博客 PATCH 会自动重写 `posts-index.json`，`history/` `archive/` 是归档，`preEtag` 等于 `postEtag` 的条目内容零变化；方案里的文件比对验证项要按这个口径写，别写「多出任何一个文件即不通过」（2026-08-26 #83 因此被误判失败）。
2. **成功判定 = HTTP 2xx + 回读比对。禁止对响应 body 的字段形状做硬断言。** 平台响应结构不是对外契约，会随版本变（`PATCH /edit` 实际回 `{ ok, updated, version }`，2026-08-26 #86 因方案写死 `page` 加 `applied` 而中止在半改状态）。方案里每一步的「预期响应」只准写状态码，成功与否靠下一行「回读核对」：回读哪个只读端点、比对什么内容。
3. **redirects 只准 PATCH，严禁 PUT。** `PUT /redirects` 是全量替换，会把清单里没列出的历史重定向整片清空。任何时候都用 `PATCH` 带 `set` 和 `delete`。
4. **`isExistingPage: true` 的 404 严禁做 301。** 这类 404 是 bug 信号，代表 slug 写错、文件缺失或语言路由坏了。给它加重定向等于把 bug 盖住。挂进任务备注交给人排查。
5. **`rewrite-page` 之前必须先 GET 原页留档。** 该操作整页覆盖，方案文档里要附原正文的存档位置。
6. **只操作自己的 siteId。** 跨站读到 200 说明安全边界破了，立刻停下报人。看到 403 不要换 payload 重试，停下报人。
7. **超时与重试写死。** 每条 curl 必带 `--max-time 120`。401 停（密码轮换，重试无意义）；403 停；409 停（多半是 changeset 过期或冲突）；接口挂起超过 120 秒停。只有明确的 5xx 与 429 允许重试，带退避（429 按 `retryAfter`，没有就 60 秒），最多 2 次。
8. **禁区。** 不碰 `/api/domains/*`、`/api/admin/*`、`/api/partner/*`、`/api/migrate/*`、`/api/payments/*`、改密码改邮箱的接口，不碰 KV / R2，不部署 worker，不发邮件，不改 site meta 的 `published` / `delivered`，不动页面注册表增删、导航结构、默认语种、indexing 开关（任务书逐条明确写了的除外）。方案里出现这些路径，prepare 阶段直接打回。
9. **回滚现状。** changeset 的 revert 端点尚未上线，全站快照 restore 大站必挂。所以失败处置只有一种：**停手，不再尝试写，上报五项**：job id、changeset id、siteId、碰过的文件清单、最后一个成功完成的步骤加失败步骤的 HTTP 状态码与 `error` 文本，并点名哪些文件停在半改状态。人按 changeset `pre/` 里的原件还原。不要因为「反正能回滚」放胆改，现在没有回滚按钮。
10. **在线文档一个任务只拉一次。** `curl -s https://api.webforger.ai/api/doc -o /tmp/wf-agent-api.md` 落到本地再 grep，别反复 curl 进上下文；`/api/doc.json` 只回目录，随便拉。本清单没写的端点先查它，不许猜。
11. **页面硬规则（写任何页面 HTML 或博客正文之前）。** body-only fragment：不写 `<html>` `<head>` `<body>` `<style>` `<script>` `<nav>` `<footer>`；每个可编辑文本和图片必须带 `data-content-id="unique-id"`；内链一律带 trailing slash；禁 inline `style="grid-template-columns:..."`，用 `.grid-2col` / `.grid-3col` / `.grid-4col` / `.wf-*` / `.services-grid`；图片只用 `POST /generate-image` 生成的或 `GET /media` 里现成的，路径 `/assets/{filename}`，禁 placeholder 与外链 stock 图；shortcode 永远走 `PATCH /edit` 的 `type:"shortcode"`，禁手写 `<!--WF_*-->`；blog category 只取 `config.blogCategories[].slug` 已有值，要新的先 `POST /api/blog/{siteId}/categories`；category slug 必须英文 ASCII；改完 390px 宽不能横向滚动。

## 登录

```
POST /api/auth/login  {"email":"...","password":"..."}
→ { ok, token, user: { isShadow, shadowOf } }
```

`user.shadowOf` 就是后续所有路径里的 `{siteId}`。凭据在客户工作区的 `notes/webforger_credentials.md`，读它取值，任何情况下都不要把凭据内容写进产出文档、日志或任务备注。

## 只读端点，任何阶段都可用

| 用途 | 端点 |
|---|---|
| 站点状态与域名 | `GET /api/content/{siteId}/meta` |
| 业务信息 | `GET /api/content/{siteId}/discovery` |
| 页面注册表 | `GET /api/pages/{siteId}` |
| 页面可编辑元素 | `GET /api/content/{siteId}/elements?page=index.html` |
| 索引开关 | `GET /api/pages/{siteId}/indexing` |
| 博客列表与单篇 | `GET /api/blog/{siteId}`、`GET /api/blog/{siteId}/{slug}` |
| 现有重定向 | `GET /api/content/{siteId}/redirects` |
| 404 候选 | `GET /api/content/{siteId}/redirects/candidates?days=7&limit=50` |
| 重定向目标建议 | `POST /api/content/{siteId}/redirects/suggest {path,limit}` |
| 快照列表 | `GET /api/content/{siteId}/snapshots` |

`POST /redirects/suggest` 虽然是 POST，但只做计算不写数据，prepare 阶段可以调用。

---

# agent_apply 操作

## redirect-batch

- 端点：`PATCH /api/content/{siteId}/redirects`，body `{ set?: {"/old":"/new"}, delete?: ["/old"] }`
- 响应：`{ ok, count, archivedTo }`，`archivedTo` 就是回滚用的归档位置。
- 平台在每次写入前把 `config.json` 归档到 `sites/{siteId}/archive/{iso-ts}-redirects/`，所以这个操作是可逆的，归 agent_apply。

巡检 SOP，照做不要自创：

1. `GET /redirects/candidates?days=7&limit=50` 取 CF Analytics 的 404 清单。
2. 逐条筛：`count >= 2`、`isExistingPage` 为 false、`alreadyRedirected` 为 false 的才是候选。
3. 对每个候选 `POST /redirects/suggest {path}`，top 建议 `score >= 0.3` 就采用；低于 0.3 不要猜，回到业务信息里找对应页面，实在没有就跳过并记下来。
4. 一批 `PATCH` 提交，单批不超过 20 条。
5. 24 小时后重新 `GET /candidates`，已处理的路径应该掉到 0，没掉说明目标页自己也在 404。

校验规则（不满足直接 400）：必须以 `/` 开头，长度不超过 256，不能自己重定向到自己，不能成链（某个 value 等于任何一个 key）。

## page-rebuild

- 端点：`POST /api/pages/{siteId}/{slug}/rebuild`
- 按当前主题和业务信息重新生成正文。语言前缀 slug 要把 `/` 编码成 `%2F`。
- 平台自动归档旧正文，可逆，归 agent_apply。但它会覆盖手工调过的正文，所以只在页面正文本身就是模板生成、没有人工定制内容时用。

## blog-draft

建稿与改稿，产出是**未发布草稿**。草稿不进博客列表页、不进分类页、不进 sitemap、不进首页区块，公众拿不到，唯一入口是带 token 的预览链接。错了改回去就行，没有对外可见的后果，所以归 agent_apply。

- 建稿：`POST /api/blog/{siteId}`，body `{ title, keyword, category, body, excerpt, slug, meta: { description } }`，响应 `{ post, previewUrl }`。
- 改稿：`PATCH /api/blog/{siteId}/{slug}`，同样的字段。
- 回读：`GET /api/blog/{siteId}/{slug}` 也返回 `previewUrl`。
- 非默认语言全部加 `?lang=xx`；默认语言 slug 只能是 ASCII 小写加连字符。

**previewUrl 契约，整条产线就靠它成立：**

1. 每篇草稿带一个 128 位 hex 的 `previewToken`，预览地址是 `https://{host}/blog/{slug}/?preview={token}`，页面带 noindex 和 no-store，右上角有 Preview draft 横幅。
2. **`PATCH` 不换 token。** 客户手里的链接在改稿之后照样能开，这是"发一次链接、改 N 轮"的前提。任何时候都不要为了改稿去删了重建，重建等于换链接，等于让客户手里的链接失效。
3. **`publish` 会删掉 token**，同一个 URL 从此直接渲染正式文章，客户手里的旧链接不会死，只是从预览变成了正式页。
4. `unpublish` 会重新生成一个新 token，所以下架之后旧的预览链接一律失效。

**客户审阅闭环（平台组件，`config.blogReview.enabled` 按站点开启）：**

预览页上客户有两个按钮，按完平台不会通知我们，靠 worker 的巡检发现：

- **Approve → 平台立即 publish**，preview token 当场吊销，同一个 URL 变成正式文章。这一步是客户自己做的既成事实，我们没有中间环节。worker 每 5 分钟的巡检看到文章变成 `published` 就把任务直接办结，备注写正式 URL，**不需要再走待放行面板**。
- **Request changes → 只记账，不动稿**。平台在 post 上写 `review: { status, rounds: [...] }`，`rounds` 最多 20 条，每条带 `action`、`choices`、`comment`（上限 2000 字符，已脱 HTML）、`at`。`choices` 枚举：`title, opening, tone, depth, facts, images, length, seo, other`。巡检把新增轮次写进任务备注（`[客户审阅 第N轮 时间] 方向：...；意见：...`），然后自动排一个 execute_task 改稿 job，改稿走 `PATCH`，预览链接不变，客户不用换链接。

读取位置：`GET /api/blog/{siteId}` 列表行带 `reviewStatus` 摘要，`GET /api/blog/{siteId}/{slug}` 带完整 `review` 对象。

写作规范走 worker 自带的 `specs/sops/seo-blog-sop.md`，不是这份清单的事。清单只管平台契约。

- **禁止调 `POST /api/blog/{siteId}/generate`。** 那个端点会触发平台侧的 Claude 出全文，算平台的钱，而且绕过我们自己的 SOP 和机器校验。正文永远自己写好了走建稿或改稿。
- 配图是另一道工序（image-generate），建稿这一轮不插图，正文里不许出现编造的图片路径。

---

# agent_prepare 操作

以下操作的产出都是变更方案文档，不是变更本身。方案要写清楚调用序列、每步的预期响应、变更前后的 diff、回滚方式。

## page-meta-update

- 端点：`PATCH /api/pages/{siteId}/{slug}`
- 可写字段仅限注册表：`title`、`inNav`、`type`、`parent`、`collectionLayout`、`landingPage`。正文改不了，正文走 content-edit 或 page-rewrite。
- 语言前缀 slug 用 `%2F` 编码。
- 回滚：记下原值，反向 PATCH 回去。

## page-rewrite

- 端点：`POST /api/content/{siteId}/rewrite-page`，body `{ page, html, reason, editability }`
- **整页正文覆盖。方案里必须先有 `GET` 原页正文的留档步骤，写明存档路径。**
- `html` 必须是 body 片段：不能有 `<html>`、`<head>`、`<body>`、`<style>`、`<script>`、`<nav>`、`<footer>`，也不能手写 `<!--WF_*-->` 短代码标记。
- `editability`：`auto` 跟随原页；`preserve` 要求保留 `data-content-id` 结构；`none` 给老页面。
- 平台会写 `history/` 和 `archive/` 两份备份再替换。校验会硬拒不安全 HTML 和重复的 `data-content-id`，缺 H2、缺 CTA、缺表单只是 warning。
- 一次改多页也不拍全站快照，安全网是 apply 阶段 worker 代开的 changeset（见风险注记 1）。

## content-edit

- 端点：`PATCH /api/content/{siteId}/edit`，body `{ page, edits: [...] }`
- 单批最多 50 处。edit 的 `type` ∈ `text` | `image` | `button` | `link` | `logo` | `shortcode`，靠 `contentId` 定位。
- 先 `GET /elements?page=` 拿到真实的 `contentId`，方案里不许出现凭想象写的 id。
- 改共享页头页脚在 edit 上加 `shared: true`。
- 短代码只能用 `type: "shortcode"` 让服务端生成标记，手写标记一律不行。
- 平台写前落 `history/{ts}-pages-{slug}.html`，回滚就是反向再 PATCH 一次原值，所以方案里要带原值。

## blog-publish

把一篇草稿推上线。内容此刻变成对外可见且可被索引，所以必须人放行，由 apply 阶段执行。

**先看客户是不是已经自己发了。** 站点开了客户审阅组件的话，客户在预览页点 Approve 平台就直接 publish 了，worker 巡检会把任务自动办结，这条路径根本走不到 apply。这里的 blog-publish 是另外两种情况：站点没开审阅组件，或者客户在别的渠道（微信、邮件、电话）点的头，由我们代为发布。两种情况都要人先放行。

- 端点：`POST /api/blog/{siteId}/{slug}/publish`，非默认语言加 `?lang=xx`。
- 前置条件：任务的 `output_url` 是这篇草稿的预览链接，平台上该 slug 存在且状态是 `draft`。状态不是 draft 就停下报人，不要猜。
- 正式地址 = 预览链接去掉 `?preview=` 查询串。

**发布后必须验证，三条全过才算完成：**

1. `GET /api/blog/{siteId}/{slug}` 回读，`status` 等于 `published`。
2. 正式地址 HTTP 200。
3. 正式页面上没有 noindex：响应头 `X-Robots-Tag` 不含 noindex，页面 `<meta name="robots">` 不含 noindex，页面上也不该再有 Preview draft 横幅。

任何一条不过：**不许重试，不许改参数再发一次**。任务留在 review，把实际观测值写进备注交给人。已经 published 的重复执行不要再 publish 一次，直接验证就行。

- 回滚：`POST /api/blog/{siteId}/{slug}/unpublish`。注意 unpublish 会换掉 preview token，客户手里的旧预览链接会失效，回滚之后要重新发链接给客户。
- 这个操作只碰这一篇文章，不许顺手改站点其他任何东西。

## image-generate

- 端点：`POST /api/content/{siteId}/generate-image`，body `{ prompt, style }`，FLUX 1.1 Pro，1280x720，落 `assets/{ts}-flux-{slug}.jpg`，最长轮询 60 秒。
- prompt 要写场景、光线、构图、风格，不要写一两个词。
- 图片进站是对外可见变更，所以归 prepare：方案里写清楚这张图要用在哪一页哪个元素，配套的 content-edit 一起给。
- 已上传的图不能删，回滚是把元素的 `src` 改回原图。

## styles-fragment

- 端点：`PATCH /api/content/{siteId}/styles`、`PATCH /api/content/{siteId}/shared/header`、`.../shared/footer`，多语言站加 `-{lang}` 后缀。body `{ html, reason }`。
- 提交的是整份新片段，不是 diff。
- styles 校验：必须含至少一个 `<style>` 块和至少一条 `{...}` 规则；不超过 500KB；不许出现 `<html>`、`<head>`、`<body>`、`<nav>`、`<footer>`、`<main>`、`<article>`、`<section>`；不许 `<script>` 和内联 `on*=`。
- header/footer 校验：不超过 200KB，不许 `<html>`、`<head>`、`<body>`，不许内联事件。
- **共享 CSS 改坏是全站坏。** 安全网是 apply 阶段 worker 代开的 changeset（原件在 `pre/`），方案回滚方式写成「按 changeset 原件由人还原」并附改前 CSS 的留档路径；不拍全站快照。
- 单页样式不要走这里，单页 CSS 放该页正文里的内联 `<style>`，走 page-rewrite。

---

# human_only 操作

agent 不执行这些，只能在方案或任务备注里写清楚要人做什么、为什么。

## domain-ops

`/api/domain/*` 全套：`connect`、`retry`、`set-primary`、`remove`。这些端点用 `user.username` 而不是 siteId，shadow 账号根本管不了域名，且域名操作会直接影响线上可访问性。域名的事一律交客户或管理员。

## page-delete

`DELETE /api/pages/{siteId}/{slug}`。虽然会把 HTML 扔进 KV 回收站，但注册表条目和站内链接关系一起没了，SEO 影响不可控。要下线页面，先提 noindex 加去导航的方案，删除交人决定。

## theme-global

`PATCH /api/pages/{siteId}/theme`。改的是全站色板、字体、圆角，一次影响每个页面的观感，属于品牌判断，不是 SEO 判断。

## commerce-bulk

`PATCH /commerce/admin/products/bulk` 和 `.../variants/bulk`，base 是 `https://apps.webforger.ai/commerce`，需要 `?site={siteId}`。直接改价格库存，错一行就是线上错价。只有人能按。

---

# Google 资产操作

WebForger 客户的 GA4、GSC、GTM、GBP 由 agency 账号托管，agent 已获授权。凭据指路：worker 的 `secrets/ga4_sa.json` 是 service account key，对客户的 GA4 属性和 GSC 站点有读取权限（pull_data 就在用它），GA4 属性 id 和 GSC 站点 URL 在客户 profile 与 facts 里取。凭据内容任何情况下不写进产出文档、日志或任务备注。

## ga4-audit（agent_readonly）

只读操作：GA4 Data API 跑报告、Admin API 读事件与 key event 配置。工作区 `data/ga4/` 下有 pull_data 的缓存快照可先读。产出是核查报告加修复清单，修复清单里的每一项按本清单的分级标注归属（配置改动走 ga4-config-update 或 gtm-edit 的 prepare 流程）。

## gsc-audit（agent_readonly）

只读操作：Search Console API 读索引覆盖、sitemap 状态、安全与手动操作。工作区 `data/gsc/` 有缓存快照。

## ga4-config-update / gtm-edit / gbp-update（agent_prepare）

产出变更方案文档：改什么、改成什么、为什么、怎么验证、怎么回滚。**注意：这三类的 apply 自动化通道尚未接通（worker 侧没有 GTM/GBP 写入工具链），人放行后由人照方案执行，方案要写到人能直接照做的粒度。** 通道接通前不要在方案里假设 apply_task 会自动执行。GTM 发布（publish container version）永远留人确认。

- 重定向：改完 `GET /redirects` 回读，确认 key 在、value 对；有条件的话 `curl -sI https://{域名}{旧路径}` 看到 301 且 Location 正确。
- 页面正文与元数据：`GET /api/pages/{siteId}` 或 `GET /api/content/{siteId}/elements?page=` 回读比对预期值。
- 博客：`GET /api/blog/{siteId}/{slug}` 确认状态与正文，已发布的再 `curl -sI` 线上 URL 看 200。
- 样式与共享片段：响应里的 `validation` 无 error，`backup.archiveKey` 记进方案的回滚步骤。
- 任何一步的响应与方案里写的预期不一致，立刻停，不要顺手改参数重试。
