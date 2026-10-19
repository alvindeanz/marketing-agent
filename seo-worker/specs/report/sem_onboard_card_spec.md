# SEM 入场确认卡规格（sem_onboard）

版本标记：SEM-ONBOARD-CARD-V1（2026-10-19）。数据契约：card_data_v1.schema.json（细则 card_data_v1.md）。渲染：render_confirmation.js + confirmation_card_template.html（零 LLM，service=sem 自动出「搜索广告 · 需要您确认」徽章）。

## 用途与定位

SEM（搜索广告）开投前的一次性入场收集卡，是 SEM plan 的前置闸材料：没有这张卡落的 confirmed facts，付费方案不该出也不许批。设计原则（PLAN.md 批 0 九样，2026-09-01 Alvin 定）：**我们先起草建议值，客户点头或改，不让客户填空白表**。九样信息里 CID 与账户接入在产线侧核实（进 blocks 展示，不设题）；其余八样进题。

SEO 的 plan 八成输入可自采，所以 plan 先出词表卡后把关；SEM 的核心输入（预算、目标、口径、铁律）自采率为零，所以顺序倒过来：先卡后 plan。

## 前置：账户考古（起草的依据，不许跳）

出卡前先读工作区 notes/ 下的账户考古材料（harness 任务 detail 会指路，通常是 ads_account_archaeology 类文件）。材料应覆盖近 180 天：campaign 结构与各自花费转化、top search terms 与否词史、曾达标与后来衰退的词、出价策略变更史、billing 状态。

- 有历史的账户：建议值从账户自己的基线来（历史预算对询盘量、历史获客成本、烧过没效果的方向直接列入「暂不投入」）。
- 空白账户：按行业数据冷启动起草，situation 里写明依据来源（关键词竞价行情、同行可见投放）。
- 考古材料缺失：不编。该题 situation 写「账户历史未核」，recommendation 保守起步档，并在正文点名材料缺口。

## 追踪红线（硬规矩，先于一切预算建议）

转化口径题的 situation 必须是 GA4 与 Ads 转化事件的**实测现状**（哪些事件在收数、最近有没有记录），不是转述配置。追踪不可用时卡照出，但该题的 recommendation 必须是「先修好统计再开投」，正文写明要修什么；此时预算题的建议值照常给，但注明以追踪修复为前提。

## item 约定（按序；fold 落的 fact 键写在括号里，折叠端按 card_kinds.json 的 fold_facts 零模型直落，不经跟进任务）

| item_id | 型 | 问什么（fact 键） |
|---|---|---|
| `budget_monthly` | single | 每月广告预算建议档这样定行不行（ads.budget_monthly） |
| `target_goal` | single | 投放目标与每个询盘的期望获客成本（ads.target_goal） |
| `conversion_basis` | single | 拿什么算一次有效询盘，统计现状实测（ads.conversion_basis） |
| `landing_scope` | single | 先投哪些页面、哪些市场区域（ads.landing_scope） |
| `hard_rules` | multi | 广告里不能说与不能投的（我们起草候选，客户勾选适用项）（ads.rules） |
| `creative_framework` | single | 广告措辞框架初稿：必说卖点、口吻、合规边界（ads.creative.framework） |
| `brand_style` | single | 品牌名写法、标语、可用图文素材与授权边界（ads.creative.brand_style 与 ads.creative.asset_sources） |
| `promo_state` | single | 当前促销活动现状与季节排期（ads.creative.promo_state） |
| `global_note` | text | 整卡自由留言（浮动控件，必配） |

single 一律三态 agree/hold/other（other 必附文字，渲染器缺省已含）；hard_rules 的 multi 选项码按 card_data_v1.md 规则，每条铁律一个码，铁律原文进 label，**且固定以 `none` 码收尾（label「以上都不适用，我们没有这类限制」）**：这题必答且空勾选两端都拒收，没有 none 码时客户若觉得起草铁律无一适用将无法作答，整卡卡死到过期（2026-10-19 Aiden 指出）。勾了 none 又勾其他码按其他码算，fold 落账时 none 单独出现落 ads.rules = 无客户限制。可按客户情况省题：没有促销的客户 promo_state 可并入 global_note 提示，但 budget_monthly、target_goal、conversion_basis 三题是最小集，不许省，SEM plan 闸只认这三样的 confirmed facts。

## 内容要求

- 每题 situation 写现状与依据（考古数据、实测追踪、行业行情），recommendation 写我们的建议值与理由。依据不足就说依据不足，不编数字。
- blocks 用法：账户考古摘要进 table 或 kv 块（近 180 天花费、询盘、获客成本一览，空户写冷启动依据），措辞框架初稿进 para/list 块，题引用对应块（block_refs）。
- 不出现承诺、保证排名、保证询盘量类语言。内部评分与毛利测算不进卡。

## 语言铁律（对客词汇表，渲染器拦一部分）

- 全中文人话。禁内部术语：不写 SEM、CPA、ROAS、CPC、CTR、PMax、bidding、campaign 这类机房话。对客写法：SEM 写「搜索广告」，CPA 写「每个询盘的获客成本」，campaign 写「广告系列」，conversion 写「有效询盘」或按客户业务写「订单」。
- 禁破折号。到期文案不许手写，渲染器按 default_policy 生成。
- default_policy 一律 `none`：收集客户独有信息的卡，到期未回不视为同意，更不许按建议执行。

## 产线接口

与 confirmation_card_spec.md 产线接口一致：任务 ops 含 sem-onboard-confirmation（specs/card_kinds.json 识别），agent 回复输出 ```card_data 围栏块（本规格与 schema 由产线注入 prompt），execute 落盘渲染发布，askreg 登记 Ask（service=sem）。本卡类没有静默补 fact 路径：入场信息是客户独有的，必须客户亲答，不许静默代答；考古再充分也只能当建议值。

## 闭环规则

- 全部 single 为 agree（multi 已保存即算答过）：折叠处按上表直落 fact 键（零模型，harness foldCards 经 specFactsFromFold），SEM plan 闸即开；不建跟进任务（2026-10-19 改：原「跟进任务落账」路径被 agent 做成实施越界，废止）。有 other 文本才建跟进任务，且只处置文本不做实施。
- 任何 hold / other：卡任务打 attention 留人跟进，不自动收口。
- 存量 paid 客户不补课（PLAN.md 批 0 原则）：已有在投历史的客户不被本闸拦，铁律仍以客户 CLAUDE.md 为准，迁移成 fact 键随下一张素材卡顺带做。
