# SEO 月报 section 规范

配套文件：`template_skeleton.html`（骨架）、`copy_rules.md`（文案硬规矩）。

参照物：`/data/aira/clients/goodiegoodie/reports/seo_monthly_2026-07.html`（最新版式，7 个正文 section）与同目录 `seo_monthly_2026-06.html`（对比出固定骨架）。

## 0. 数据源与字段总表

| 源 | 拉取方式 | 供给字段 |
|---|---|---|
| GA4 | `node /data/aira/scripts/fetch_monthly_seo_data.js <propertyId> <gscSiteUrl> <YYYY-MM> <out.json>`，服务账号 `/data/aira/config/aiden_ga4_api.json` | organic sessions / new users / orders / revenue、全渠道 sessionDefaultChannelGroup 分渠道 sessions+orders+revenue、漏斗事件（view_item / add_to_cart / begin_checkout / purchase）、landing page 维度 sessions |
| GSC | 同一脚本，Search Analytics API。queries rowLimit 25000，pages 1000，countries 50 | 点击、曝光、CTR、平均排名（overall 与 query 维度）、page 维度 |
| 月中出报 | `node /data/aira/clients/report/scripts/fetch_range_seo_data.js <propertyId> <gscSiteUrl> <YYYY-MM> <endDay> <out.json>`，同窗 target/prev | 同上，但 target=本月 1 至 endDay、prev=上月 1 至 endDay |
| 目标词表 | 客户目录下固定词表（goodie 为 40 词），本月排名按查询簇曝光加权 | keyword、prev_pos、pos、delta、impressions |
| ops tracker | `GET https://always.horntech-dev.com/mini.php/tracker?week=W{n}&module=seo`，Header `Authorization: Bearer aira-ops-service-token-2026`。week 必须写 `W34` 不能写 `34` | 已完成任务（done=1）→ 本月工作；未完成任务（done=0）→ 下月计划的补充项 |
| 交付物 | 客户目录 `reports/` 下当月产出（blog_*.html、pageopt_*.html）+ tracker 博客状态 | 博客篇数、page-opt 页数，用于本月工作的量化描述 |
| 大事记 | 客户记忆 `project_*` / `draft_log.md` 中当月条目 | 迁站、改版、追踪配置变更等异常解释，写进 sdesc 或 callout 的注脚 |

**渲染层与叙事层分工**：所有数字块（KPI 卡、表格、漏斗、图表）由数据直出，**模型不参与**；叙事只在 `sdesc`、`callout.body_html`、`work_items.body`、`next_items.body` 四类字段里发生。

---

## 1. header（页眉，非编号 section）

- **用途**：一屏交代客户、周期、四个正向 KPI。
- **字段**：`client_name`、`period_label`（如「2026年7月（全月）」）、`prev_period_label`、`site_domain`、`market`、`platform`、`vertical`、`hero_headline`、`hero_kpis[4]{value,label,note}`。
- **纯数字渲染**：hero_kpis 全部。
- **需要模型写**：仅 `hero_headline`，一句话，**不超过 16 个中文字**，概括本月最强的正向信号（例：自然流量与搜索点击双双走强）。
- **规则**：hero KPI 优先选正向指标；本月哪些指标好就上哪四个，**槽位不固定**（见「两版差异」）。排名类的 note 写「提升 N 位」，绝不写「收紧」。
- **同比（2026-09 加）**：pack 有 `yoy` 节点时，每张 hero 卡在环比 note 下加一行「同比 ±%」，页眉信息条加「同比对比 {去年同月}（全月）」；`yoy` 为 null（月中出报、新站、取数失败）时同比相关块整块不出现，全零基期不做同比（见 facts_pack.schema）。纯数字渲染，模型不参与。

## 2. nav（锚点导航，非编号 section）

- **用途**：粘顶导航条。
- **字段**：`nav_items[]{anchor,label}`，与下面各 section 的 `id` 一一对应。
- **纯数字渲染**：全部。由 section 清单自动生成，不需模型。

## 3. `#ga4` GA4 Organic 流量概览（Section 1）

- **用途**：自然搜索渠道核心指标 + 全周期趋势图。
- **字段**：
  - `ga4_kpis_row1[3]` / `ga4_kpis_row2[3]`，各 `{value,label,prev_value,delta,delta_color,yoy_delta,yoy_delta_color,yoy_prev_value,yoy_short}`。默认六个位置：Organic Sessions、Organic New Users、GSC 平均排名、Organic Orders、GSC 曝光、Organic Revenue。yoy_* 四个字段来自 pack.yoy（去年同月），为 null 时卡片上同比行不出现。
  - `trend_months[]` / `trend_values[]`（见骨架末尾注释）、`trend_range_label`、`trend_subtitle`。
  - `ga4_callouts[]`，1 至 3 条。
- **纯数字渲染**：六张 KPI 卡、趋势图。
- **需要模型写**：
  - `ga4_sdesc`：**80 至 140 字**。固定要素：数据来源（Google Analytics 4 与 Google Search Console）、本报告数据周期、环比对齐口径、站点上线时长、一句本月总体走向。
  - `ga4_callouts`：至少一条 green「本月信号」（**150 至 260 字**），把 sessions / new users / orders / clicks / impressions / CTR / 平均排名七个数串成一句连贯叙述，末尾指向漏斗 section。若有反向指标，追加一条 yellow「需留意」（**100 至 180 字**），只讲一个问题并给出下月抓手。
- **语气**：陈述，不辩解。反向指标不藏、不甩外部因素，写成「需通过 X 把 Y 带起来」。

## 4. `#channels` 全渠道流量与收入（Section 2）

- **用途**：把自然搜索放回全渠道背景，量化 SEO 贡献。
- **字段**：`channel_kpis[3]`、`channel_rows[]{channel,sessions,orders,revenue,revenue_share,prev_revenue,is_organic,is_muted}`、四个合计字段、`channels_callout_title`、`channels_callout_body`。
- **纯数字渲染**：三张 KPI 卡、整张渠道表（含 tfoot 合计）。行序按本月 Revenue 降序，Organic 行高亮紫底，尾部把 Social / Unassigned / Email / Referral 聚合成一行「其他」。
- **需要模型写**：
  - `channels_sdesc`：**40 至 80 字**，说明口径（GA4 默认渠道分组 sessionDefaultChannelGroup）与对比周期。
  - callout（blue，**180 至 300 字**）：全渠道收入与进站的环比、自然搜索在其中的位次与占比、增量来自哪个渠道、自然搜索指标若与全渠道背离要解释原因。
- **坑**：GA4 `overall` 节点偶发虚高（oakfurniture、luxelink），一律回退到 channel 级汇总；渠道表合计与概览总数不一致时，全文统一用渠道表合计。

## 5. `#funnel` 电商转化漏斗（Section 3）

- **用途**：Sessions → Add to Cart → Checkout → Purchase 四步转化。
- **字段**：`funnel_steps[4]{value,label,rate_label,accent_color,prev_value,delta,delta_color}`、`funnel_callouts[2]`、`funnel_compare_rows[5]{metric,prev_value,value,delta,delta_color,note}`、可选 `aov_callout`。
- **纯数字渲染**：漏斗四格、对比表五行。转化率一律以 Organic Sessions 为分母，线性、从 0 起。
- **需要模型写**：
  - `funnel_sdesc`：**50 至 90 字**，一句话说清本月漏斗哪一段变好、哪一段变差。
  - 两条成对 callout：左 green「关键改善」（**120 至 200 字**），右 yellow「需观察」（**120 至 200 字**，必须落到下月一个具体动作）。**两条必须成对**，`g2` 是两列网格，只给一条会留白。
  - `aov_callout`（blue，**80 至 150 字**）：仅当客单价出现明显位移时才生成，否则整块省略。
  - `funnel_compare_rows[].note`：每行 4 至 8 字的短评（持续上行 / 绝对量增长 / 本月最大亮点 / 基本持平，客单价走低）。
- **非电商客户**：本 section 换成询盘漏斗（Sessions → form_start → generate_lead），四格降为三格，其余结构不变。

## 6. `#rankings` 目标关键词排名追踪（Section 4）

- **用途**：固定目标词表的排名连续性追踪。
- **字段**：`keyword_rows[]{keyword,prev_pos,pos,delta_text,delta_color,pos_color,impressions,is_brand}`、`rankings_callouts[2]`、`rank_dist[4]{label,color,bar_color,count,prev_count,delta_text,delta_color,width_pct}` 加 `rank_dist_total`。
- **排名分布（2026-09 加）**：sdesc 与关键词表之间加一块「目标词排名分布」：四档（1 至 10 / 11 至 20 / 21 以后 / 本月无曝光）计数加占比条，每档带 vs 上月的增减。分档配色与关键词表一致；变化的好坏色只对首尾两档表态（进前十变多是绿、无曝光变多是红），中间两档灰。词表为空时整块不渲染。纯数字渲染，由 `buildRankDist` 从 rankings.rows 现算，模型不参与。
- **纯数字渲染**：整张表。分档配色规则：本月排名前 10 用 `#16a34a`，11 至 20 用 `#2563eb`，20 名以后用 `var(--muted)`；变化列变好 `#16a34a`、变差 `#dc2626`、无排名用 `class="pos-same"` 且文案写「本月无曝光」或「新进榜」。
- **需要模型写**：
  - `rankings_sdesc`：**100 至 180 字**。必须交代：目标词数量、排名按查询簇曝光加权的算法、「本月曝光」的定义、三档配色图例、以及裸头词「本月无曝光」的解释（多数是精确匹配掉样本，不是站点无流量）。
  - 两条成对 callout：左 green「排名亮点」（**180 至 320 字**），品牌词先说，再列一批带量中位词的 `旧 → 新（+差值，曝光数）`；右 yellow「需关注」（**150 至 280 字**），列回落词并指明下月第一优先级页面。
- **铁律**：排名数值变小一律写「提升 / 前进」，**绝不写「收紧」「收窄」「压缩」**。克隆上月报告后先 `grep -n "收紧\|收窄"` 扫一遍。
- **坑**：大片「本月无曝光」时先按 stem 聚合验证是否真无量，多数是裸头词精确匹配掉样本，不是 fetch bug。

## 7. `#pages` 重点页面表现（Section 5）

- **用途**：自然搜索落地页 Top 10 的环比。
- **字段**：`page_rows[10]{rank,path,sessions,prev_sessions,delta,delta_color}`、`pages_callouts[2]`。
- **纯数字渲染**：整张表。上月无数据时 `prev_sessions` 写「新增」、`delta` 写「新进榜」。
- **需要模型写**：
  - `pages_sdesc`：**30 至 60 字**，说明数据来自 GA4 自然搜索渠道页面级 Sessions 与对比周期。
  - 两条成对 callout：左 green 领涨页面（**150 至 280 字**），右 yellow 回落页面（**100 至 200 字**）。回落项要与 rankings section 的回落词交叉印证，并指向同一批下月动作。
- **规则**：交叉引用写「详见 Section N」，section 顺序变动时同步更新，不留悬空指向。

## 8. `#work` 本月工作内容（Section 6）—— 自动生成规则

**数据入口**：ops tracker `GET /tracker?week=W{n}&module=seo`，取本报告月覆盖的全部 ISO 周（通常 4 至 5 周），过滤 `client_id` = 本客户且 `done=1` 的任务。双月报客户（luxelink / badger / sunseeker）往前多拉 4 周。

**生成流程**：

1. **取数**：逐周拉取，合并成一个任务列表，字段为 tracker 的 `text`。
2. **归组**：按关键词把任务映射到五个分类，输出 `cat_class` / `cat_label`：
   - `cat-onpage` / On-Page：标题、描述、内链、商品排序、集合页、产品页、页面优化、page-opt
   - `cat-content` / 内容：博客、文章、选题、改写、refresh
   - `cat-link` / 外链：外链、backlink、布点
   - `cat-tech` / Technical：site audit、技术审计、301、sitemap、schema、索引、抓取
   - `cat-report` / 报告：月报、数据、分析、交付
3. **合并同类**：同一分类下多条同主题任务合并成一个 `work_item`，避免一条一格的流水账。goodie 07 月报把整月任务压成 5 条。
4. **写 title**：**12 至 30 字**，说清做了什么对象，例「头部品类簇巩固：pens / gel pen / notebooks / pencils」。
5. **写 body**：**60 至 120 字**，说清动作 + 为什么做 + 预期承接。要能与本月数据 section 呼应（做了哪些页面，就是 rankings/pages 里提到的那些）。
6. **交付物量化**：博客类任务从客户 `reports/` 目录当月 `blog_*.html` 数量与 tracker 博客状态取实数，写「N 篇（已发布）」，篇数**必须现查，不许沿用上月**。
7. **大事记注入**：若当月记忆里有迁站 / 改版 / 追踪重配等条目，追加一条对应分类的 work_item，并在受影响的数据 section 的 sdesc 里加一句口径说明。

**`work_sdesc`**：**30 至 60 字**，固定句式「本月按上月报告中「{{prev_month}} SEO 工作计划」逐项执行，涵盖 X / Y / Z，完成情况如下。」

**硬规矩**：任务原文是内部黑话（钱页 / 重爬 / 硬塞 / 死件），必须改写成中性客户面表达；不出现工具名、CMS 名、后台操作步骤、W-ID、AI 字样。开会、催款、纯内部沟通类任务不入报告。

## 9. `#next` 下月 SEO 工作计划（Section 7）—— 自动生成规则

**固定五槽**，顺序与优先级标签不变：

| 槽 | 优先级 | cat_class | 内容来源 |
|---|---|---|---|
| 1 | P1 | `cat-p0` | **基于本月数据的优化重点**。由 rankings 的回落词 + pages 的回落页 + 逼近首页（排名 10 至 15）的词共同推导，模型写 |
| 2 | P2 | `cat-p1` | 外链建设。围绕本月带量的核心页面，模型套写 |
| 3 | P3 | `cat-p1` | 博客 N 篇。篇数按合同节奏，选题方向取本月数据信号 |
| 4 | P4 | `cat-p1` | Site Audit 站点健康检查。固定文案 |
| 5 | P5 | `cat-link` | 数据监督与报告交付。固定文案 |

**P1 生成算法**（唯一真正需要推理的一槽）：

1. 从 rankings 取 `delta < 0` 且 `impressions` 排前列的词，取前 2 至 3 个作为「要拉回来的」。
2. 从 rankings 取本月 `pos` 落在 10 至 15 区间的词，取 2 至 3 个作为「要推进第一页的」。
3. 把这两组词映射到具体 URL（品类页 + 对应产品页），URL 必须来自 pages section 已出现过的真实路径，**不许臆造**。
4. `title`：**20 至 40 字**，两个目标各一句。
5. `body`：**120 至 220 字**，先摆本月数字作依据，再列具体动作（标题与搜索结果描述、商品排序、双向内链），最后写乘势推进的第二组。

**其余四槽 body**：**50 至 110 字**。

**补充项**：ops tracker 当月 `done=0` 的未完成任务，若与五槽主题重合就并入对应槽的 body，不新增第六条。

**硬规矩**：全部写成「我方要做什么」，不写成对客户的催办；不承诺具体排名或数值结果（doable + true，无绝对化）；不出现工具名与后台路径。

## 10. footer + chart_script

- `footer`：纯字段替换，`client_name` + `period_label`。
- `chart_script`：注入 `trend_months_json` / `trend_values_json` 两个 JSON 数组，其余逻辑（线性回归趋势线、末柱加深）在模板内，不需外部计算。详见骨架末尾注释块。

---

## 10B. 客户反馈组件（2026-09-01 加，Alvin 定）

- 七个 section 各带一个三选项反馈条，右下角全局浮动「留言给我们」。**按钮样式与三选项文案照抄 paid 方向卡**（Alvin 2026-09-01 定）：同意按建议执行 / 保持不变，继续观察 / 其他反馈（带文本），蓝色方框系（#0057b8 / #eff6ff / #bfdbfe），不要自造文案。**组件与提交脚本固定在模板里，不经模型**（方向卡两起脚本被改写事故的同款根治）。
- 身份：报告 URL 带 `?r={report_id}&k={token}`，token = md5('reportfb'+id+WORKER_TKN)，由 POST /reports 落库时服务端拼进存的 url，看板与邮件转发的就是带参链接；裸链接打开进预览模式（按钮禁用加降级文案）。
- 提交：POST /report_feedback（公开端点，token 门），choice 取 agree / hold / other（与 card_feedback 同口径，空文本 other 降级 hold），item 为 section 键或 global_note。落 seo_report_feedback 表（全量真相），摘要追进 seo_reports.note（看板版本列表速览，超 1800 字只留表）。读取：GET /reports/{id}/feedback（auth_any）。
- 内部同事的意见走任务线程，不要点客户按钮：按钮记录一律按客户意见处理。

## 11. 渲染后必做的校验

1. `python3 /data/aira/clients/report/scripts/report_lint.py --check <file.html>`，exit 0 才算通过。
2. `grep -n "收紧\|收窄\|压缩" <file.html>`，命中即改。
3. `grep -niE "semrush|dataforseo|ahrefs|keyword ?planner|shopify 后台|wordpress|AI 分析|AI 辅助" <file.html>`，应为 0 行（平台名出现在 header 的 `platform` 字段属既有惯例，其余正文不得出现）。
4. 交叉引用「详见 Section N」的编号与实际 section 顺序一致。
5. 渲染截图肉眼验一次（callout 排版渗透与数字块套框这两类问题在源码里看不出来）。
6. 部署：`scp <file> clawagent@192.168.10.250:/www/wwwroot/blogpreview.horntech-dev.com/reports/{client}/`，交付回贴 `https://agencyreport.horntech-dev.com/reports/{client}/{reportFile}_{YYYY-MM}.html` 完整 URL。
