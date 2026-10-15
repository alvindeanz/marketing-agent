# Shopify 能力清单（博客、redirect 与 collections 车道 v3）

<!-- SHOPIFY-CAP-V3（2026-09-24 collections 扩面，Alvin 拍板 B1，Aira 扩 CLI）：执行通道是 shopseo CLI
     （/data/aira/tools/shopseo/shopseo，token 服务现取不落盘，写命令默认 dry-run，--yes 实弹且写前自动快照）。
     店铺清单见 /data/aira/tools/stores.conf（alias 与 profile.workspace_dir 同名，apply_task 靠它定位店铺）；
     2026-09-17 起共 10 店（sungait + 9 家新入列，oakfurniture 待装 app）。
     v7（2026-10-15 深夜，Dareu #1348 与 Sunseeker #1285 收编）：article-template-assign（shopseo 1.8.0 article set-template）
     与 collection-metafield-update（collection set-metafield，#1285 契约带 --expect-sha256 只改不建）入列。
     v6（2026-10-15 晚，ticket #38/#39）：collection-item-update 落 CLI（shopseo 1.7.0 add/remove-products，#1291 规格）
     并补进本清单（此前只在政策表，单向一致性测试没拦住）；collection-content-edit 补登记（CLI 1.4.0 就有）。
     同批加「CLI 写命令必须在本清单有登记」的双向测试，这类登记债从此测试红。
     v5（2026-10-15，ticket #35）加 product 面三 op：改商品名 rename、自定义 metafield 写入带 --clear、tags 追加移除（shopseo 1.6.0，Badger #1287/#1288 十二处落地卡点实证）；
     v4（2026-09-24 同日）加 product 面三 op 与 collection 改名、封面 alt（Alvin 三问定则：CLI 没写不等于做不到）；v3 新增 collections 命令面（collections list / collection get / set-meta / create / publish / unpublish，
     scope 走 write_products 全船队已授，零 app 改动）；products/pages 未接通，相关任务保持交付包模式；
     导航菜单需 write_online_store_navigation scope（全船队未授，补授要客户重装 app），保持人工。
     放行口径（2026-09-17 Alvin 定，midea S1 试点）：客户卡替代人工放行，见 ../release_policy.md「SEO 客户卡放行」。
     v2（2026-09-17）船队扩容；v1.1（2026-09-10）加 blog-draft；v1 试点客户 sungait。 -->

## 规划视图

<!-- PLANNING_VIEW_START -->
| operation | autonomy | note |
|---|---|---|
| article-meta-update | agent_apply | 改博客文章 title_tag / description_tag，纯 metafield 不动正文；另含文章 tags 与列表简介 excerpt（summary_html）写入（shopseo 1.5.0 article set-tags-excerpt / batch-tags-excerpt）；双闸授权域内免卡直落（见操作集说明），无双闸客户覆盖已有值走网页调整卡 |
| article-content-edit | agent_prepare | 改博客正文（压缩、内链、H2 调整、扩写），方案先行；双闸授权域内免卡直落，无双闸客户走网页调整卡 |
| article-publish | agent_prepare | 发布未发布文章，对外可见，凭证走客户卡批文 fact |
| article-unpublish | agent_apply | 下线文章，可逆（再发布即回） |
| redirect-add | agent_apply | 加 301 redirect；加前必查目标零跳转防叠链 |
| blog-draft | agent_prepare | 按 seo-blog-sop 写完整成稿，apply 仅建 DRAFT（published:false）绝不发布 |
| collection-meta-update | agent_apply | 改集合页 title_tag / description_tag，纯 metafield 不动正文；双闸授权域内免卡直落，无双闸客户覆盖已有值走网页调整卡 |
| collection-create | agent_prepare | 新建 custom collection（UNPUBLISHED），含描述文案与选品清单；mapping 表列明新建的承接页属授权域免卡，mapping 外新方向走卡；发布是另一个 op |
| collection-publish | agent_prepare | 发布或下线集合页，发布对外可见，凭证走客户卡批文 fact；下线即回滚手段 |
| collection-title-update | agent_apply | 改集合 title（即店面 H1），handle 与 URL 不变；双闸授权域内免卡 |
| collection-content-edit | agent_prepare | 改集合页正文描述（body_html 整替或追加），shopseo collection update --body-file [--append]；方案逐处点名，mapping 授权域内免卡 |
| collection-item-update | agent_apply | 往已有 custom collection 加/减商品（shopseo 1.7.0 collection add-products / remove-products），只动 collects 成员不碰集合本体字段；smart collection 拒绝手改；不写 position |
| product-meta-update | agent_apply | 改 PDP title_tag / description_tag，纯 metafield；双闸授权域规则同 collection-meta-update |
| product-content-edit | agent_prepare | 改 PDP 正文（body_html 整替，读改写），方案逐处点名；双闸授权域内免卡 |
| product-title-update | agent_apply | 改店面商品名（product title，即 PDP H1），handle 与 URL 不变，SEO title_tag 是另一字段不受影响；双闸授权域内免卡（shopseo 1.6.0 product rename） |
| product-metafield-update | agent_apply | 写任意自定义 metafield（卖点标题/卖点正文/图片说明类店面内容块），支持 --clear 真删（liquid 判空隐藏整块）；方案逐字段点名；双闸授权域内免卡（shopseo 1.6.0 product set-metafield / restore-metafield） |
| product-tags-update | agent_apply | 商品 tags 追加或移除，大小写去重保留现有顺序；tags 变更会改变 smart collection 成员归属，dry-run 必须核对影响面（shopseo 1.6.0 product set-tags） |
| theme-text-edit | agent_apply | 改主题模板 JSON 里既有字符串字段（H1 块/副文案块），shopseo theme set-text：只动 main 主题、只许 string 字段、写前快照、写前写后 jq 校验 |
| theme-template-create | agent_prepare | 复制现有集合模板为新模板（theme copy，拒绝覆盖已存在的），配合 collection-template-assign 使用 |
| collection-template-assign | agent_apply | 指派集合 template_suffix，模板不存在则拒绝（防店面 500） |
| article-template-assign | agent_apply | 指派文章 template_suffix，模板不存在则拒绝（防店面 500）（shopseo 1.8.0 article set-template） |
| collection-metafield-update | agent_apply | 写集合自定义 metafield；--expect-sha256 只改不建、现值哈希不符零写入；--clear 真删（shopseo 1.8.0 collection set-metafield / restore-metafield） |
<!-- PLANNING_VIEW_END -->

## 操作集说明

- article-meta-update [risk_class: reversible]：shopseo article set-meta。60/160 字符规矩、品牌后缀式样按客户约定（如 sungait 的「| SUNGAIT」）。**双闸授权域（2026-09-24 Alvin 拍板，取代 ramp 期逐次卡）：客户词表与 mapping 双闸 confirmed 后，锁定词表内、mapping 已确认页面的站内优化（title/meta/H1/正文调整、mapping 表列明新建的承接页）即已授权执行域，可逆+快照，L0 直落免卡，改动月报汇总告知客户；仍走卡的只剩：mapping 外新方向、结构性动作（删页/301/导航）、客户亲笔内容、承诺与价格类主张；客户级 fact content.review_before_write=1 可切回逐次确认模式；写前现值与方案不符（客户自改）停手报告，此条永远保留**。
- article-content-edit [risk_class: reversible]：shopseo article update --body-file。方案必须逐处列出改动（改哪段、改成什么、为什么），未点名的客户原文一字不动；改动遵守客户工作区 KEYWORD-MAP / 词归属表（改 title/H2 前必查，没有词表的客户先做 mapping 再动正文）。凭证走网页调整卡。
- article-publish [risk_class: external]：shopseo article publish。对外发布，凭证走客户卡批文 fact（external_with_backing_fact=auto），无批文停在 review。
- article-unpublish [risk_class: reversible]：shopseo article unpublish。下线即回滚手段之一。
- redirect-add [risk_class: reversible]：shopseo redirect add。新 301 前先 curl 目标确认 200 零跳转（该店存量 2169 条 redirect 且有多跳链，禁止叠链）。
- collection-meta-update [risk_class: reversible]：shopseo collection set-meta。60/160 字符规矩与品牌后缀式样同 article-meta-update；**授权域同 article-meta-update 条**。custom 与 smart collection 都支持。
- collection-create [risk_class: reversible]：shopseo collection create（--title/--handle/--body-file/--products/--meta-title/--meta-desc）。**published:false 硬编码，本 op 永不发布**；--products 收 handle 或数字 id，给定顺序即页面顺序（sort manual），命令会先逐个解析产品并在 dry-run 里列出，缺一个整单拒绝。mapping 表列明新建的承接页属双闸授权域免卡（如 sungait oversized/rimless 页，客户在 #641 卡 empty_collections/rimless_plan 双双 agree 且催加速）；mapping 外的新方向仍走卡。
- collection-publish [risk_class: external]：shopseo collection publish 与 collection unpublish。发布对外可见走客户卡批文 fact（external_with_backing_fact=auto），无批文停 review；unpublish 可逆，是 create 后的回滚手段。
- collection-title-update [risk_class: reversible]：shopseo collection rename。改的是店面 H1，URL 不动；快照回滚。
- collection-content-edit [risk_class: reversible]：shopseo collection update --body-file（1.4.0 起即有，2026-10-15 补登记：ticket #39 LuxeLink #1229 因清单缺此 op 停人，工具债只欠登记面）。读现值改点名处整替（--append 为追加），未点名的原文一字不动；写前快照。
- collection-item-update [risk_class: reversible]：shopseo collection add-products 与 collection remove-products（1.7.0 起，MA #1291 规格，sungait #1279 实证缺口）。只许 custom collection（smart 成员由规则驱动，拒绝手改）；按 handle 或数字 id 解析，缺一个整单拒绝；已在/不在集合的跳过并列明；只调 collects 接口，集合 title/body_html/SEO/published_at/template_suffix/sort_order 一概不写且写后逐字核对；写前快照含成员 id 清单；**不写 position**（排序属超委托项，需要时另行授权）；回滚 = remove-products 加回去的款（失败输出里直接给命令）。
- product-meta-update [risk_class: reversible]：shopseo product set-meta。60/160 与品牌后缀规矩同族；双闸授权域免卡。
- product-content-edit [risk_class: reversible]：shopseo product update --body-file。读现值改点名处整替，未点名的客户原文一字不动；写前快照。
- product-title-update [risk_class: reversible]：shopseo product rename（1.6.0 起，ticket #35 Badger #1287/#1288 实证缺口）。改的是店面商品名（PDP H1 与全站引用处），handle 与 URL 不变，SEO title_tag 不动；载荷白名单只含 id/title，写后回读核对且守护 handle/body_html 不变；回滚 = 用快照里的旧名再 rename 一次（失败输出里直接给命令）。
- product-metafield-update [risk_class: reversible]：shopseo product set-metafield（1.6.0 起）。写任意 namespace.key 自定义 metafield；更新保留现有 type（--type 只在新建时生效，默认 single_line_text_field）；--clear 真删 metafield（店面 liquid 判空才会隐藏整块，写空串不等于清）；写前快照、写后回读逐字核对；方案必须逐字段点名（namespace.key、现值、新值、为什么）。回滚 shopseo product restore-metafield <快照> --namespace --key（快照里没有该字段 = 恢复为删除）。
- collection-metafield-update [risk_class: reversible]：shopseo collection set-metafield（1.8.0 起，Sunseeker #1285 契约）。写集合任意 namespace.key 自定义 metafield；--value-file 收文件输入（rich_text_field 大值）；--expect-sha256 为只改不建模式：metafield 不存在拒绝新建，现值 sha256 与给定值不符零写入（防方案与线上脱节盲写）；更新保留现有 type；--clear 真删；写前快照、写后回读逐字核对。回滚 shopseo collection restore-metafield <快照> --namespace --key。
- product-tags-update [risk_class: reversible]：shopseo product set-tags --add/--remove（1.6.0 起）。追加去重（大小写不敏感比对，保留现有顺序与写法）；**tags 决定 smart collection 成员归属，加减 tag 等于把商品挪进挪出集合页，dry-run 阶段必须说明预期的归属变化**；载荷白名单只含 id/tags，写后回读核对且守护 title/handle/body_html 不变；回滚 = --remove 加回来的 tag（失败输出里直接给命令），整体恢复用快照。
- article-template-assign [risk_class: reversible]：shopseo article set-template（1.8.0 起，Dareu #1348 收编）。指派文章 template_suffix，模板（templates/article.<suffix>.json 或 .liquid）必须已存在于 main theme，否则拒绝（防店面 500）；写前快照，回滚 = 用快照旧值再 set-template。
- 文章封面 alt：shopseo article set-cover-alt，语义归 article-meta-update，不另立 op（2026-09-24 三问教训：这行曾被当 capability-gap 排了人工单 #861）。
- 文章封面图更换：shopseo article set-cover（1.3.1 起，--src https 图址，可带 --alt），语义同归 article-meta-update，不另立 op（2026-09-30 Sunseeker #932 实证：agent 曾以 article-set-cover-image 报 capability-gap 停手，缺的是 CLI 不是能力）。
- 文章 slug：shopseo article set-handle（1.3.2 起，仅 DRAFT，已发布拒绝：Shopify 不自动 301，动在售 slug 走人工评估加 redirect）；article create 也收 --handle 直接建成短 slug。语义归 article-meta-update，不另立 op（2026-09-30 Badger #884 发布前阻断项实证）。
- 文章标签与列表简介：shopseo article set-tags-excerpt（单篇，--tags "A, B" / --excerpt 或 --excerpt-file / --clear-tags / --clear-excerpt）与 article batch-tags-excerpt --file <json>（批量，行格式 {"handle","tags","excerpt"}，只认这三个键），1.5.0 起。语义归 article-meta-update，不另立 op，属双闸授权域：锁定词表与 mapping 双闸 confirmed 的客户免卡直落，无双闸客户覆盖已有值走网页调整卡。护栏内建：PUT 载荷白名单只含 id/tags/summary_html；现值非空且不同默认拒写（客户自改停手），覆盖须 --overwrite 且方案点名；写前快照；写后按 id 回读，tags 与 excerpt 逐字核对，body_html/title/handle/published_at/template_suffix/image/author 与两条 SEO metafield 对快照逐字比对，任一不符非零退出；批量逐篇写、首个失败即停。回滚 shopseo article restore-tags-excerpt <快照> --yes。excerpt 按给定字符串原样写入，不自动包 <p>（2026-10-13 #1263，#1258 实证缺口）。
- theme-text-edit / theme-template-create / collection-template-assign [risk_class: reversible]：shopseo 1.3.0 theme 族（theme set-text、theme copy、collection set-template，2026-09-25 Alvin「发挥到极致」）。三道护栏内建：只动 main 主题、set-text 只许改既有 string 字段（类型不符拒绝）、写前快照且写前写后 jq 解析。首战 sungait round H1/首屏、oversized 与 rimless 两张专用模板全链落地线上验证。导航菜单仍无通路（缺 write_online_store_navigation scope），是 shopify 面最后一个真人工位。
- blog-draft [risk_class: reversible]（2026-10-02 Alvin 去官僚化降档，草稿永不对外）：prepare 阶段按 /data/aira/seo-worker/specs/sops/seo-blog-sop.md 产出完整成稿
  （Style Roll 文件头注释、骨架轮换、指纹查重、13 条红线自检、封面图必配且只用客户站 CDN 已有图、
  内链按 KEYWORD-MAP、锁定词表内选题）；apply 阶段 shopseo article create（--title/--body-file/--meta-title/
  --meta-desc/--image-url），该命令 published:false 硬编码，**永不发布**；发布是另一个 op 另一次放行。

## 全局风险注记（执行侧必须遵守）

- 唯一写通道是 shopseo CLI，不发裸 Shopify API 写请求。每条写命令先 --dry-run 核对 diff 再 --yes。
- 快照即回滚依据：CLI 写前自动存 snapshots/<日期>/<handle>.json，失败或要回滚按快照原文写回。
- 客户会自行改站（2026-09-09 sungait 实证：边点确认卡边动手；Shopify 店主普遍如此）。写前必须现读线上当前值，不得基于旧快照或方案假设直接覆盖；发现与方案预期不符（客户又改过）即停手报告，不要「纠正」客户的改动。
- **文案铁律按客户走**：每家店的禁用主张、拼写口径、品牌规矩以该客户工作区 CLAUDE.md 与 facts 为准，execute/apply 前必读；facts 里没有铁律条目的客户，方案里不得使用任何未经当页核实的公开主张。sungait 专属铁律（其他店不适用）：美式拼写；可用公开主张仅 UV400 protection、free shipping、lifetime warranty（引用前核当页）；全线级 polarized 主张禁写，含非偏光款的页面 H1 与描述不写 polarized；集合归类按款式不按镜片。
- 我方新增文案零破折号零 emoji；客户原文里的既有风格不改不学。
- 正文改动后 curl 线上页面验证 200 且关键改动点可见。
