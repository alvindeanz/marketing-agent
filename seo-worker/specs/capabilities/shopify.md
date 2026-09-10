# Shopify 能力清单（博客与 redirect 车道 v1）

<!-- SHOPIFY-CAP-V1（2026-09-10）：执行通道是 Aiden 的 shopseo CLI（/data/aira/tools/shopseo/shopseo，
     token 服务现取不落盘，写命令默认 dry-run，--yes 实弹且写前自动快照）。
     本 v1 只覆盖 CLI 已有命令面：博客文章 meta/正文/发布状态与 URL redirect。
     collections/products 操作未接通（CLI 无命令），相关任务保持交付包模式或等 CLI 扩展。
     试点客户 sungait；渐进验证口径（Alvin 2026-09-10）：页面正文类首批由无头跑小批量，人验收后铺开。 -->

## 规划视图

<!-- PLANNING_VIEW_START -->
| operation | autonomy | note |
|---|---|---|
| article-meta-update | agent_apply | 改博客文章 title_tag / description_tag，纯 metafield 不动正文 |
| article-content-edit | agent_prepare | 改博客正文（压缩、内链、H2 调整、扩写），方案先行人放行 |
| article-publish | agent_prepare | 发布未发布文章，对外可见走放行 |
| article-unpublish | agent_apply | 下线文章，可逆（再发布即回） |
| redirect-add | agent_apply | 加 301 redirect；加前必查目标零跳转防叠链 |
<!-- PLANNING_VIEW_END -->

## 操作集说明

- article-meta-update [risk_class: reversible]：shopseo article set-meta。60/160 字符规矩、品牌后缀「| SUNGAIT」式样按客户约定。
- article-content-edit [risk_class: reversible]：shopseo article update --body-file。方案必须逐处列出改动（改哪段、改成什么、为什么），未点名的客户原文一字不动；改动遵守 KEYWORD-MAP 词归属（改 title/H2 前必查）。
- article-publish [risk_class: external]：对外发布，走放行或客户批文背书。
- article-unpublish [risk_class: reversible]：下线即回滚手段之一。
- redirect-add [risk_class: reversible]：新 301 前先 curl 目标确认 200 零跳转（该店存量 2169 条 redirect 且有多跳链，禁止叠链）。

## 全局风险注记（执行侧必须遵守）

- 唯一写通道是 shopseo CLI，不发裸 Shopify API 写请求。每条写命令先 --dry-run 核对 diff 再 --yes。
- 快照即回滚依据：CLI 写前自动存 snapshots/<日期>/<handle>.json，失败或要回滚按快照原文写回。
- 客户会自行改站（2026-09-09 实证：边点确认卡边动手）。写前必须现读线上当前值，不得基于旧快照或方案假设直接覆盖；发现与方案预期不符（客户又改过）即停手报告，不要「纠正」客户的改动。
- 文案铁律：美式拼写；可用公开主张仅 UV400 protection、free shipping、lifetime warranty（引用前核当页）；全线级 polarized 主张禁写，含非偏光款的页面 H1 与描述不写 polarized；集合归类按款式不按镜片。
- 我方新增文案零破折号零 emoji；客户原文里的既有风格不改不学。
- 正文改动后 curl 线上页面验证 200 且关键改动点可见。
