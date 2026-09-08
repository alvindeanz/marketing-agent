# Google Ads 能力清单（channel=google，paid 类目第一个 adapter 模板）

<!-- PAID-CAP-GOOGLEADS-V3：权限映射来自 Alvin 批准的 SEM 执行边界（Aira SOUL / Kira SOUL §2），
     服务端白名单与 apply adapter 以本文件为准。凭据：/data/aira/.env.google-ads，
     login-customer-id 恒为 MCC 152-489-2513，customer-id 走 profile.ads_customer_id。
     V2（2026-09-08）：新增 final-url-change（reversible），mutate 通道 lib/ads_mutate.py 白名单执行。
     V3（2026-09-08，Alvin 批）：adgroup-create 从 spend 改 structural（预算中性新建，不动 campaign 预算
     与出价策略，装配全对才启用），执行器上线；新增 keyword-pause（reversible）。 -->

## 规划视图

<!-- PLANNING_VIEW_START -->
| operation | autonomy | note |
|---|---|---|
| negative-keyword-add | agent_apply | 加否词，关键词级或共享否词表，否词不放竞品牌名 |
| ad-pause | agent_apply | 暂停单条 ad，学习期拒杀 |
| adgroup-pause | agent_apply | 暂停单个 ad group，学习期拒杀 |
| keyword-bid-adjust | agent_apply | 单关键词出价调整，脚本硬闸 ±20% |
| final-url-change | agent_apply | 只改既有 ad 的 final URL，改前记旧值，回读加 curl 200 零跳转 |
| keyword-pause | agent_apply | 暂停单个关键词，只停不删 |
| schedule-adjust | agent_prepare | 投放时段调整，mutate 执行器未实现，方案出来转人工落地 |
| budget-change | agent_prepare | 预算变动超当前日预算 20%，spend 永远人放行 |
| campaign-pause | agent_prepare | 暂停整个 enabled campaign |
| bidding-strategy-change | agent_prepare | 改出价策略 |
| campaign-create | agent_prepare | 新建 campaign |
| adgroup-create | agent_prepare | 既有 campaign 内建组（词/否词/RSA 打包，PAUSED 装配回读全对才启用），预算中性 structural |
| asset-create | agent_prepare | 新建 asset |
| ad-copy-rewrite | agent_prepare | 改 ad copy，对外资产，有批文才自动；执行器 rsa-copy-update 全量替换加回读比对 |
| conversion-goal-change | agent_prepare | 转化目标与权重调整，不可逆类 |
| keyword-direction | agent_readonly | 关键词方向卡，一步出报告 |
| creative-direction | agent_readonly | 素材方向卡，一步出报告 |
<!-- PLANNING_VIEW_END -->

## 操作集与自主权限

risk_class 是放行分级的输入（见 ../release_policy.md）：reversible 的 prepare 任务闸A 复审过即自动放行，其余人点。

### agent_apply（机器可直接执行，apply 阶段落地并回读）
- negative-keyword-add [risk_class: reversible]：加否词（关键词级 / 共享否词表）。否词不放竞品牌名，除非客户点名。
- ad-pause / adgroup-pause [risk_class: reversible]：暂停单条 ad 或单个 ad group。
- keyword-pause [risk_class: reversible]：暂停单个关键词，只停不删，回读验证。
- keyword-bid-adjust [risk_class: reversible]：单关键词出价调整，幅度 ±20% 以内。
- schedule-adjust [risk_class: reversible]：投放时段调整。（mutate 执行器未实现，当前落地时转人工）
- final-url-change [risk_class: reversible]：改既有 ad / ad group 内广告的 final URL。只改既有结构不新建；改前记录旧 URL（回滚依据）；新 URL 必须 curl 200 且零跳转后才提交；提交后回读验证。不花钱、旧值可一键改回，故 reversible。

### agent_prepare（只出方案，放行卡确认后执行）
- budget-change [risk_class: spend]：预算变动超当前日预算 20%。
- campaign-pause [risk_class: spend]：暂停整个 enabled campaign。
- bidding-strategy-change [risk_class: spend]：改出价策略。
- campaign-create / asset-create [risk_class: spend]：新建 campaign 或 asset。
- adgroup-create [risk_class: structural]：既有 campaign 内新建 ad group（含词、否词、RSA 打包）。
  预算中性：不动 campaign 预算与出价策略，总花费上限不变，风险实质是流量再分配而非新增支出
  （2026-09-08 Alvin 批，从 spend 降档）。执行器铁律：同名组拒建；PAUSED 装配，逐项回读核数
  全对才 ENABLED，任何一步不符停在 PAUSED 报人，绝不半开着投放。
- ad-copy-rewrite [risk_class: external]：改 ad copy（文案是对外资产，有客户批文背书才自动，否则停人）。
  执行器 rsa-copy-update（2026-09-09 上线，Alvin 解冻）：全量替换语义（spec 给改后完整集合），
  改前打印原文案全套（回滚依据），条数/字符/pin 校验，回读逐条比对。铁律：文案更新触发广告重审，
  同一任务不重复改同一条；只改方案明确列出的条目，未列出的原文一字不动。
- conversion-goal-change [risk_class: irreversible]：转化目标与权重调整。

### analysis（一步出报告，不走 prepare/apply）
- keyword-direction [risk_class: reversible]：关键词方向卡。四块：主打词族加保持降、否词与排除方向、搜索词新发现、待客户确认项（每条带默认立场）。规格见 ../report/keyword_direction_spec.md，验收人是 sales。
- creative-direction [risk_class: reversible]：素材方向卡（月度）。广告级成绩单、新文案确认、零曝光清理名单、测试方案。规格见 ../report/creative_direction_spec.md，验收人是 sales。客户 agree 后接 ad-copy-rewrite（external，走放行）。

### human_only
- 账单与 payments profile、账户级设置、账户开通与关停。

## 全局风险注记（执行侧必须遵守）

- 学习期保护：目标 campaign 处于学习期时，暂停与降预算动作一律拒绝执行，回「学习期内不下杀」。
- 每个 apply 动作的 result_note 必须带「预算影响:」行（金额或 0）。
- 写后必回读：mutate 完成后 re-query 验证落库，字段更新为默认值时必须手写 field_mask（protobuf_helpers.field_mask 会漏默认值字段，2026-08-10 kobehibachi 事故）。
- GOOGLE_HOSTED 类转化不能通过 API mutate。
- Ads Script 必须在客户账户下运行，不能在 MCC。
- 评估转化追踪必须查 campaign 级 conversion_goal 的 biddable 设置，不能只看账户级 Primary（2026-03 Louvresky 误判）。
- Keyword Planner 拉量用 API 精确词（UI 显示的是扩展后总和）；脚本 gads_keyword_planner.py。
- _ht 后缀区分自建转化与 GA4 默认事件。
- 建号可走 API（CreateCustomerClient），但 email_address 字段禁用（未白名单会整单拒），邀请走 CustomerUserAccessInvitationService；币种时区建号后不可改；账单只能 UI 设。
