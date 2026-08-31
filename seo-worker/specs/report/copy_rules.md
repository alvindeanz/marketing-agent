# 客户面报告文案规矩清单

来源缩写：

- `LINT` = `/data/aira/clients/report/scripts/report_lint.py`
- `RCLAUDE` = `/data/aira/clients/report/CLAUDE.md`
- `M:xxx` = `/root/.claude/projects/-data-aira/memory/_global/xxx.md`
- `BENS` = `/root/.claude/projects/-data-aira/memory/benscurtains/project_benscurtains_au_monthly_report.md`

`已 lint` 标记表示 `report_lint.py --check` 已能自动拦截，无需人工复查。

---

## A. 硬禁止（可机器 lint / 可 grep 判定）

| # | 规则 | 来源 | 已 lint |
|---|---|---|---|
| A1 | 正文不得出现 em-dash `—` 或 en-dash `–`，改用「至」或「·」 | LINT, M:feedback_no_dashes, RCLAUDE, BENS | 已 lint |
| A2 | 正文不得出现 ` - `（前后带空格的连字符作分隔），改用「至」或「·」。连接复合词的连字符不受限（dual-frequency、180-day） | LINT, M:feedback_no_dashes | 已 lint |
| A3 | 正文不得出现工具名：Semrush、DataForSEO、Ahrefs、Keyword Planner。统称「keyword research」 | LINT, RCLAUDE, M:reference_monthly_report_cadence | 已 lint |
| A4 | `.callout` 内联强调必须用 `<b style="color:#16a34a">`，不得用 `<strong>`（`.callout strong{display:block}` 会把行内强调撑成块，把段落断成一行行） | LINT, RCLAUDE, M:reference_monthly_report_cadence | 已 lint |
| A5 | CSS 里 `.callout strong{display:block}` 必须收窄成 `.callout>strong:first-child{...}` + `.callout strong{font-weight:700}`，用 `report_lint.py --fix-css` 改，不手改 | LINT, RCLAUDE | 已 lint（--fix-css） |
| A6 | `.callout` 内不得嵌多条目 / 带项目符号的列表；多条目要用独立 class 的列表组件（`.analysis` + `.arow` + `.adot`），不寄生在单段落 box 上 | M:feedback_report_no_list_inside_callout | 否 |
| A7 | 封面数字块琥珀色一律 `class="v amb"`，禁用 `class="v warn"`（会撞上提示框 `.warn` 的 background+border，数字凭空多个米色框） | M:feedback_report_cstat_warn_class_collision | 否 |
| A8 | 排名变好一律写「提升」「前进」，禁用「收紧」「收窄」「压缩」，无例外。历史模板里这词散在 hero 注脚 / KPI 卡 `.kn` / callout / 时间线四处 | M:feedback_ranking_wording_improve_not_tighten, RCLAUDE | 否（grep `收紧\|收窄`） |
| A9 | 不得出现「AI 分析」「AI 辅助」「AI-generated」「AI-assisted」或任何暴露 AI 工具使用的措辞 | M:feedback_no_ai_mention, RCLAUDE | 否 |
| A10 | 不得出现绝对化断言：没人 / 从不 / 永远 / 唯一 / 只有 / never / always / the only。要限定范围（「在我们比对的几家同行里」） | M:feedback_no_absolute_claims | 否 |
| A11 | 不得出现后台操作步骤与 CMS 名（「在 Shopify 哪里改」「WordPress 里加 schema」），这是给执行看的 | M:feedback_client_report_strip_internal, M:feedback_client_hint_language | 否 |
| A12 | 不得出现内部黑话：钱页、on-page（中文正文里）、SERP、重爬、看窄了、硬塞、裸名、零新品、口径、冷启动、蓄水、复盘、死件、僵尸标签、打架。行业通行词可留（归因、基线月、学习期） | M:feedback_client_report_strip_internal | 否 |
| A13 | 不得出现内部框架术语与 W-ID（W28、W34 这类周编号） | RCLAUDE | 否 |
| A14 | 不得出现版本号痕迹：title / badge 里的「深度优化 #1」「v2 修正版」 | M:feedback_client_report_strip_internal | 否 |
| A15 | 不得整块保留内部复盘：版本修正说明、「初版误判·重爬确认」、内部排期自省、我方竞品调研过程表 | M:feedback_client_report_strip_internal | 否 |
| A16 | 交付物里不出现 emoji | BENS | 否 |
| A17 | 报告里的每一个数字必须来自本轮实际拉数命令的输出，禁止凭记忆写、禁止跨客户或跨市场（NZ↔AU）复用。相似实体是红灯不是绿灯 | M:feedback_numbers_must_be_freshly_measured | 否 |
| A18 | 拉不到的数据（GSC Page Indexing、CWV、Backlinks、DR/RD）一律标「待更新」，**不估算填写** | RCLAUDE | 否 |
| A19 | 报告内的内链 URL 交付前 curl 实测，200 才用；交出去的 URL 必须零跳转 | RCLAUDE, M:feedback_verify_internal_links_live | 否 |
| A20 | 交叉引用「详见 Section N」的编号必须与实际 section 顺序一致，不留悬空指向 | RCLAUDE | 否 |
| A21 | 不承诺具体排名或数值结果；建议必须是我方可执行且属实的（doable + true） | M:feedback_recommendations_doable_and_true, BENS | 否 |
| A22 | 不得责备客户或用对话口气（「不要照搬不存在的尺码」「一句话回答你的疑问」），一律改陈述句 | M:feedback_client_report_strip_internal | 否 |
| A23 | 章节标题一律中性陈述，不用问句、不用「怀疑 / 到底 / 真的吗」，不得引述客户质疑原话 | M:feedback_client_analysis_not_a_defence | 否 |
| A24 | 不得因被质疑就更换考核指标；要加维度就说「两个都继续报，一个都不减」 | M:feedback_client_analysis_not_a_defence | 否 |
| A25 | 不得写「我们没有 X 权限所以查不了」这类死结；改写成「这项由我们做，只需你们开通后台权限，拿到后一周内出结论」 | M:feedback_client_analysis_not_a_defence | 否 |
| A26 | 月报周期必须是整月日历天（7 月 = 7/1 至 7/31，不是 7/30）。月中出报必须全文标注「截至 N 日，本月尚未结束」并只做同窗环比，不与整月比、不列 YoY | BENS, M:reference_monthly_report_cadence | 否 |
| A27 | 金额显示恒两位小数（`f"{n:,.2f}"`；`:,` 会把 3054.50 砍成 3054.5） | BENS | 否 |
| A28 | 同一个数（如询盘数）在 hero KPI / KPI 卡 / 漏斗底 / 表格合计四处必须完全一致 | BENS | 否 |
| A29 | 账户配置、出价机制、Primary/Secondary 设置这类后台细节不写进客户报告 | BENS | 否 |
| A30 | 不出现 dash 分隔的同时，也不出现 `.callout` 之外的样式类混用（数字块 / 提示框两套 class 不交叉） | RCLAUDE, M:feedback_report_cstat_warn_class_collision | 否 |
| A31 | 中文报告里，客户账户语料（keywords、search terms、campaign 名、网站）出现的产品与行业名词一律用英文原词，首次出现可括注中文说明（如「louvre roof（百叶顶）类搜索」），禁止自造中文翻译（百叶顶、百叶花架这类）。Google 机制词保持中文人话（如 Performance Max 写「自动投放广告」）。边界由客户语料定义 | M:feedback_zh_report_trade_terms_english, sales 2026-09-01 Louvresky 卡反馈, Alvin 确认全客户生效 | 方向卡渲染器强制（名称槽全中文即拒绝）；月报 reportlint 待加（COLLAB 交 Aiden） |

---

## B. 写作要求（进 prompt，靠模型执行）

| # | 规则 | 来源 |
|---|---|---|
| B1 | 每写一句问一次「这是给客户看的，还是给我们自己看的」，后者一律删或改 | M:feedback_client_report_strip_internal |
| B2 | 开头先给生意结果，不给辩解。口径修正作副标题 | M:feedback_client_analysis_not_a_defence |
| B3 | 我方的口径或执行失误单独成节，明写「这一点我们本应更早识别」，紧跟已完成的修正动作。认领一次胜过通篇论证外因 | M:feedback_client_analysis_not_a_defence |
| B4 | 外部因素（算法、AI 摘要、其他搜索引擎、客户追踪配置）只能作为「我们据此调整了哪些工作」的依据出现，不能作为结论落点。写完每段自问：这段是在解释我们要做什么，还是在解释为什么不怪我们 | M:feedback_client_analysis_not_a_defence |
| B5 | 待客户采用的建议不写成催促，改成「我们整理成可直接复制粘贴的清单发给你们并协助确认改动位置」，把操作成本挪走 | M:feedback_client_analysis_not_a_defence |
| B6 | 行动清单每条标注责任方（我方已完成 / 我方在做 / 需要一起推进），让客户看到大部分是我们在扛 | M:feedback_client_analysis_not_a_defence |
| B7 | 描述分析工作直接写结果不写工具：「完成关键词与页面表现分析」「数据分析与归因更新」 | M:feedback_no_ai_mention |
| B8 | note / insight / 总结块里的同比环比增长数字用绿色加粗；KPI 卡片 / 表格 / 漏斗保持原配色 | RCLAUDE |
| B9 | hero KPI 优先选正向指标；本月哪些指标好就上哪四个 | RCLAUDE |
| B10 | 工作内容按 On-Page / 内容 / 外链 / Technical 分组，报告类任务单列「报告」组 | RCLAUDE |
| B11 | 反向指标不藏、不淡化，但必须配一条下月可执行的抓手，不留一个光秃秃的坏消息 | M:feedback_client_analysis_not_a_defence, M:feedback_recommendations_doable_and_true |
| B12 | 数字带出处（「10 个（注册表）」这种在内部沟通用；对客报告里改为在 sdesc 里交代数据来源与口径），让口径可追溯 | M:feedback_numbers_must_be_freshly_measured |
| B13 | 大片异常数据（如目标词表「本月无曝光」）必须在 sdesc 里给出解释，说明不代表站点该品类无流量 | RCLAUDE, goodie feedback_goodie_keyword_table_headterm |
| B14 | 不自作主张给月报加视觉元素或策略元素（highlight、加预算建议、新增卡片）。要动先做最小、单点、可一键撤回的改动并先确认 | BENS |
| B15 | 语法过一遍再交付 | RCLAUDE, M:feedback_grammar_correctness |
| B16 | 交付前把封面与关键 section 渲染截图肉眼看一遍。callout 排版渗透与数字块套框这两类问题在 HTML 源码里完全看不出来，只有渲染才现形 | M:feedback_report_no_list_inside_callout, M:feedback_report_cstat_warn_class_collision |
| B17 | 转 PDF 交付走 `python3 /data/aira/scripts/html2pdf.py <in.html> <out.pdf> --footer "..."`；验收用 `pdfinfo` 看页数 + `pdftoppm` 抽页自看 | M:reference_html_to_pdf_script |

---

## C. 客户 / 节奏例外（渲染前先查）

| 客户 | 例外 | 来源 |
|---|---|---|
| powerdekorfloors | 半年报（H1 / H2）不是月报，文件名 `seo_monthly_2026-H1.html`；须剔除赌博注入污染流量后单独呈现真实业务数据 | M:reference_monthly_report_cadence, RCLAUDE |
| luxelink / badger / sunseeker | 双月报，工作内容拉 2 个月 ops 任务；文件名用月末那月，标题与 footer 周期写「2026年5月至6月」 | M:reference_monthly_report_cadence |
| oakfurniture | 第三部分需含「AI 渠道引荐流量」模块（中性命名，属合法渠道分析，不违反 A9）；月报只用 NZ 地区口径 | M:reference_monthly_report_cadence, oakfurniture 记忆 |
| apolloenergy | GEO 报告（`geo_report` 前缀），结构偏 AI / GEO 可见性，「AI sessions / AI Overview」是正当渠道引用，不违反 A9 | M:reference_monthly_report_cadence |
| citymed | 中英双版（`_en.html` 全英文），要发邮件 | M:reference_monthly_report_cadence |
| dareu | GA4-only H1 报告，中国 / 海外流量分拆，单独管线 | M:reference_monthly_report_cadence |
| chcnav | 五站合并特殊管线，跳过标准模板 | RCLAUDE |
| benscurtains | 广告月报，共享铁律：不写 thermal 角度、不写工厂位置、不写 shutters 自产、无在跑活动不写 discount | BENS |
| 文件名前缀 | midea=`seo_report`、oakfurniture=`monthly_report`、dareu=`ga4_report`、apolloenergy=`geo_report`、chcnav=`monthly_report`，其余=`seo_monthly` | RCLAUDE |

---

## D. 部署前检查序列（建议直接编码进模块）

```
1. python3 /data/aira/clients/report/scripts/report_lint.py --check  <file>   # A1 至 A5
2. grep -n "收紧\|收窄\|压缩"                                      <file>   # A8
3. grep -niE "AI 分析|AI 辅助|AI-generated|AI-assisted"            <file>   # A9
4. grep -n "钱页\|重爬\|硬塞\|裸名\|口径\|冷启动\|蓄水\|复盘"        <file>   # A12
5. grep -nE "W[0-9]{1,2}\b|v[0-9] 修正版|#[0-9]"                    <file>   # A13 A14
6. grep -nP "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]"               <file>   # A16
7. 渲染截图人工过目                                                          # B16
8. exit 0 才 scp
```
