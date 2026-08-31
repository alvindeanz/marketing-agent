# Google Ads 能力清单（channel=google，paid 类目第一个 adapter 模板）

<!-- PAID-CAP-GOOGLEADS-V1：权限映射来自 Alvin 批准的 SEM 执行边界（Aira SOUL / Kira SOUL §2），
     服务端白名单与 apply adapter 以本文件为准。凭据：/data/aira/.env.google-ads，
     login-customer-id 恒为 MCC 152-489-2513，customer-id 走 profile.ads_customer_id。 -->

## 操作集与自主权限

risk_class 是放行分级的输入（见 ../release_policy.md）：reversible 的 prepare 任务闸A 复审过即自动放行，其余人点。

### agent_apply（机器可直接执行，apply 阶段落地并回读）
- negative-keyword-add [risk_class: reversible]：加否词（关键词级 / 共享否词表）。否词不放竞品牌名，除非客户点名。
- ad-pause / adgroup-pause [risk_class: reversible]：暂停单条 ad 或单个 ad group。
- keyword-bid-adjust [risk_class: reversible]：单关键词出价调整，幅度 ±20% 以内。
- schedule-adjust [risk_class: reversible]：投放时段调整。

### agent_prepare（只出方案，放行卡确认后执行）
- budget-change [risk_class: spend]：预算变动超当前日预算 20%。
- campaign-pause [risk_class: spend]：暂停整个 enabled campaign。
- bidding-strategy-change [risk_class: spend]：改出价策略。
- campaign-create / adgroup-create / asset-create [risk_class: spend]：新建任何东西。
- ad-copy-rewrite [risk_class: external]：改 ad copy（文案是对外资产，走放行）。
- conversion-goal-change [risk_class: irreversible]：转化目标与权重调整。

### human_only
- 账单与 payments profile、账户级设置、账户开通与关停。

## 风险注记（执行侧必须遵守）

- 学习期保护：目标 campaign 处于学习期时，暂停与降预算动作一律拒绝执行，回「学习期内不下杀」。
- 每个 apply 动作的 result_note 必须带「预算影响:」行（金额或 0）。
- 写后必回读：mutate 完成后 re-query 验证落库，字段更新为默认值时必须手写 field_mask（protobuf_helpers.field_mask 会漏默认值字段，2026-08-10 kobehibachi 事故）。
- GOOGLE_HOSTED 类转化不能通过 API mutate。
- Ads Script 必须在客户账户下运行，不能在 MCC。
- 评估转化追踪必须查 campaign 级 conversion_goal 的 biddable 设置，不能只看账户级 Primary（2026-03 Louvresky 误判）。
- Keyword Planner 拉量用 API 精确词（UI 显示的是扩展后总和）；脚本 gads_keyword_planner.py。
- _ht 后缀区分自建转化与 GA4 默认事件。
- 建号可走 API（CreateCustomerClient），但 email_address 字段禁用（未白名单会整单拒），邀请走 CustomerUserAccessInvitationService；币种时区建号后不可改；账单只能 UI 设。
