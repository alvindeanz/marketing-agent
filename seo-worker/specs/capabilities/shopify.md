# Shopify 能力清单（博客与 redirect 车道 v2）

<!-- SHOPIFY-CAP-V2（2026-09-17 船队扩容）：执行通道是 shopseo CLI（/data/aira/tools/shopseo/shopseo，
     token 服务现取不落盘，写命令默认 dry-run，--yes 实弹且写前自动快照）。
     店铺清单见 /data/aira/tools/stores.conf（alias 与 profile.workspace_dir 同名，apply_task 靠它定位店铺）；
     2026-09-17 起共 10 店（sungait + 9 家新入列，oakfurniture 待装 app）。
     本版仍只覆盖 CLI 已有命令面：博客文章 meta/正文/发布状态与 URL redirect。
     collections 命令面 Aiden 扩建中（2026-09-17 COLLAB 答复），接通后另起 op；products/pages 未接通，相关任务保持交付包模式。
     放行口径（2026-09-17 Alvin 定，midea S1 试点）：客户卡替代人工放行，见 ../release_policy.md「SEO 客户卡放行」。
     v1.1（2026-09-10）加 blog-draft；v1 试点客户 sungait。 -->

## 规划视图

<!-- PLANNING_VIEW_START -->
| operation | autonomy | note |
|---|---|---|
| article-meta-update | agent_apply | 改博客文章 title_tag / description_tag，纯 metafield 不动正文；空补齐免卡，改已有值的批次先过网页调整卡 |
| article-content-edit | agent_prepare | 改博客正文（压缩、内链、H2 调整、扩写），方案先行，凭证走网页调整卡 |
| article-publish | agent_prepare | 发布未发布文章，对外可见，凭证走客户卡批文 fact |
| article-unpublish | agent_apply | 下线文章，可逆（再发布即回） |
| redirect-add | agent_apply | 加 301 redirect；加前必查目标零跳转防叠链 |
| blog-draft | agent_prepare | 按 seo-blog-sop 写完整成稿，apply 仅建 DRAFT（published:false）绝不发布 |
<!-- PLANNING_VIEW_END -->

## 操作集说明

- article-meta-update [risk_class: reversible]：shopseo article set-meta。60/160 字符规矩、品牌后缀式样按客户约定（如 sungait 的「| SUNGAIT」）。**卡片分界**：目标字段为空（no title_tag / no desc_tag）的补齐批次免卡直接 L0；覆盖已有值的批次属「改页面说什么」，需网页调整卡确认后执行。分界由 plan/execute 阶段落实，ramp 期后检核对。
- article-content-edit [risk_class: reversible]：shopseo article update --body-file。方案必须逐处列出改动（改哪段、改成什么、为什么），未点名的客户原文一字不动；改动遵守客户工作区 KEYWORD-MAP / 词归属表（改 title/H2 前必查，没有词表的客户先做 mapping 再动正文）。凭证走网页调整卡。
- article-publish [risk_class: external]：对外发布，凭证走客户卡批文 fact（external_with_backing_fact=auto），无批文停在 review。
- article-unpublish [risk_class: reversible]：下线即回滚手段之一。
- redirect-add [risk_class: reversible]：新 301 前先 curl 目标确认 200 零跳转（该店存量 2169 条 redirect 且有多跳链，禁止叠链）。
- blog-draft [risk_class: external]：prepare 阶段按 /data/aira/seo-worker/specs/sops/seo-blog-sop.md 产出完整成稿
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
