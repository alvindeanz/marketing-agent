# 客户报告模板蒸馏规格（V1，2026-10-13，蓝本 LuxeLink 2026-09，Alvin 定）

<!-- TEMPLATE-DISTILL-V1：execute 的 analysis 任务读本 spec 执行。输入是客户的旧报告
     （PJ 时期手工月报或客户自带格式），产出是 MA 报告产线能直接吃的客户资产三件套。
     价值分层铁律：分析板块 > 数据口径 > 皮肤。只搬皮肤不搬板块和口径会被打回（实证）。 -->

## 输入

- 旧报告，优先形式是链接（agencyreport.horntech-dev.com 或客户自己域名，带签名参数原样用），
  其次是任务附件（已落在工作区 `temp/attachments/`，detail 里有引用行）。
- 任务 detail 里人工点名的保留模块与口径要求，优先级高于本 spec 的默认推断。

## 产出（全部写进客户工作区 `reports/`，这是 NFS 单一事实源，两台 worker 都读它）

1. `report_template_seo.html`：SEO 月报模板。**从通用骨架 `specs/report/template_leadgen.html`
   复制起手**，替换为旧报告的视觉 token（:root 色板、页眉渐变、accent 色），不手搓整页。
   通用骨架与 PJ 报告是同一套 CSS 架构（变量名与布局类全同），正常情况下只需要换 token；
   结构性差异（旧报告有而骨架没有的模块）不要在模板里硬造，记进汇报让人决定进不进产线。
   渲染器注入的内联色（漏斗三色等）需要统一时用 `!important` 覆盖。
2. `report_sections_seo.json`：品牌/品类板块定义（旧报告有分组分析板块才产出）。每组：
   `key`（小写英文）、`label`（照旧报告）、`accent`（照旧报告该组主色）、`query_regex` 与
   `exclude_regex`（GSC RE2）、`market_keywords`（10 个市场目标词）。
   **正则必须用 GSC API 实测校准**：对旧报告同周期逐组数词，先试「组间允许重叠、不加排除」
   再按偏差微调（LuxeLink 实证 PJ 口径即如此，仅个别组有排除）。校准不追求零误差，
   单组偏差 10% 以内收工，超过 10% 的组在汇报里标黄说明差在哪类词。
3. `market_volume_ledger.json`（旧报告有市场量趋势图才产出）：从图中反解历史序列回填。
   内联 SVG 的比例尺从轴标签与锚点标注推（LuxeLink：y=92 为 0、y=22 为轴顶值），
   反解值必须对图上的标注锚点逐一验证（去年同期点、最新点），对不上就不要写台账，
   在汇报里说明无法反解。`_meta` 写清来源、比例尺、月份数组。
4. 口径核对：旧报告的订单/询盘主口径与 GA4 默认口径不一致的（如首次触点归因），
   **不要自己改 profile**，在汇报里点名差异并给出 `orders_attribution` 建议值，等人工确认后
   由人（或下一张单）去改档案。口径是对客资产，蒸馏单无权单方面切换。

## 硬验收（全过才许交，任何一条不过就停在 review 说明原因）

- 用本仓测试渲染冒烟：`node tests/brandsections.test.js` 全绿，且拿产物模板渲一份
  假 pack 验证零 `{{` 残留（渲染器断言会兜底，但要在交付前自己跑出来，不是等产线炸）。
- `python3 /data/aira/scripts/deliverable_lint.py` 对渲染样张全过。
- 分组词数校准表写进任务 result_note：每组「蒸馏正则词数 vs 旧报告词数 vs 偏差%」，
  这张表是人在 review 放行时的主要依据。
- 产物落盘后任务停 review，**人放行前不生效**（报告产线读文件，文件在 review 期间
  不要用正式文件名——先落 `*.pending.html` / `*.pending.json`，放行后由 apply 或人改正式名）。

## 边界

- SEO 与 SEM 模板分开：本 spec 只管 `report_template_seo.html` 三件套；SEM 月报模板是
  `report_template_paid.html`，走 paid_monthly_spec.md 的规则，别混。
- 不动 GA4 / GSC / Ads 任何线上配置，不动 profile，不动既有正式模板文件。
- 模板是客户多年磨合资产：蒸馏是复原不是再设计，不许「顺手优化」旧版式和旧口径。
