# 确认卡规格（keyword_confirmation / mapping_confirmation 及一次过合卡）

版本标记：CONFIRMATION-CARD-V1（2026-10-19）。数据契约：card_data_v1.schema.json（细则 card_data_v1.md）。渲染：render_confirmation.js + confirmation_card_template.html（零 LLM）。

## 用途与定位

onboard 两闸（词表确认、mapping 确认）的客户卡。客户在卡上逐项表态，harness 折叠后落 `keywords.lock_*` 与 `seo.mapping_*` confirmed facts，两闸开，S1 任务放行。老客户标准形态是**一次过合卡**：词表加 mapping 合成一张，客户勾一次两闸同开（2026-09-19 定）；合卡的 card_kind 取 keyword_confirmation（card_kind_of 首个命中 op 的既有行为）。

本规格取代「agent 手写确认卡 HTML」：agent 只产 data.json，HTML 由渲染器出，题只能出自 items[]。此前那套手写卡的 4 项约定（group_first 等）在仓库里没有规格没有渲染器，是 agent 照旧卡抄出来的事实标准，本文件把它收编成规格。

## item 约定（与存量账本对齐，别另起名）

一次过合卡的标准题组，按序：

| item_id | 型 | 问什么 |
|---|---|---|
| `group_first` | single | 第一批主攻词组（快赢组）这样定行不行 |
| `group_next` | single | 第二梯队词组的排期与取舍 |
| `group_hold` | single | 暂不做的词组（现阶段赢不了或不值得）的搁置决定 |
| `mapping_overall` | single | 词到页的承接方案整体（含要建的新页、要调的旧页） |
| `new_terms` | multi | 建议新增/待客户筛选的词（可选题，有增量词才出） |
| `global_note` | text | 整卡自由留言（浮动控件，必配） |

纯词表卡用前三题加 new_terms；纯 mapping 卡用 mapping_overall（可按页组拆成多个 mapping_* single 题，item_id 自定但必须进 items[]）。single 一律三态 agree/hold/other；multi 的码按 card_data_v1.md 选项码规则（词条原文进 label）。

## 内容要求（通用模式，2026-09-19 定）

- 快赢分组导向：词组按可赢性排序（零曝光词换同义高曝光词、SERP 已给流量但站内零覆盖的词优先补位），不按搜索量堆表。
- mapping 给意见不给作业：每组词写清承接页是谁、要建什么、要改什么，客户点头即可，不让客户做题。
- 不出现承诺、考核、保证排名类语言；内部分层（优先级打分一类）只留内部，不进卡。
- 卡的目的是校对期望、收集客户独有信息、提升互动，不是走流程：老客户出「刷新版」要带信息增量（最新 GSC 重排、重点词进展、建议新增小节）。
- blocks 用法：词表分组进 table 块（列建议：词、归属页、当前位次），mapping 现状进 para/kv 块，题引用对应块（block_refs），让客户在题边上就能看到依据。

## 语言铁律（每句都过，渲染器拦一部分）

- 全中文人话；关键词词条用英文原词不翻译（copy_rules A31，词条在 label/表格里）。
- 禁内部术语（SEO、CPC、CTR、CVR、PMax、ROAS、anchor、mapping 这类机房话；「mapping」对客写「词和页面的分工」）。
- 禁破折号。不编造数据，位次、曝光全部现测。
- 到期文案不许手写，渲染器按 default_policy 生成（词表/mapping 卡 default_policy 一律 `none`：到期未回不视为同意）。

## 产线接口

1. execute（闸材料任务，ops=keyword-confirmation,mapping-confirmation）产出 `<card_kind>_<客户>_<YYYY-MM>.data.json` 落 reports/，不再产手写 HTML。
2. 渲染：`node specs/report/render_confirmation.js <data.json> > <同名>.html`，lint 与发布走现有通路。
3. 登记：askreg 读同一份 data.json 建 Ask（桥侧，冻结解除后接）。登记失败不挡出卡，幂等补登，既有行为不变。
4. harness 建单 detail 指向本规格（tools/harness.js 闸材料任务那行），随 execute 接线一起改。

## 闭环规则

- 全部 single 为 agree（multi 已保存即算答过）：harness 折叠落 facts，两闸开。
- 任何 hold / other：卡任务打 attention 留人跟进，不自动收口。
- default_policy=none：到期未回复不视同同意，harness 到期分支不碰确认卡（只对方向卡生效的既有行为保持）。
