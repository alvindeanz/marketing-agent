# Paid 月报草稿规格（V1，2026-09-08，基准口径 Ben's Curtains AU，Alvin 定）

<!-- PAID-MONTHLY-V1：本 spec 给 analysis 任务用（execute runner 读它出草稿）。
     产出是【内部草稿】，对客发送必须过人审，这是红线；月报口径的坑见 DEFECTS（leads 口径、
     投放天数、告警红），机器负责拉数与排版，口径核对留给人，跑满观察期再谈降级。 -->

## 产出物

- `reports/{client_slug}_paid_monthly_{YYYY-MM}.draft.html`：完整月报草稿，文件名带 `.draft`，
  页首固定一行内部水印「内部草稿，未经人审不得发客户」。
- 草稿顶部第一屏是【自检清单】卡（见下），后面才是正文；人审通过后由人去掉水印与自检卡再发。
- 结果摘要里写：每个关键数字的取数来源一行一个，方便人审对账。

## 结构（五块，语气与措辞规则见同目录 paid_section.md，全部适用）

1. 本期亮点（至少 2 条真的，数据化，不注水）
2. 数据总览：花费、点击、转化/询盘、CPA 或 ROAS，环比；渠道拆分表（单渠道不出表）
3. 优化动作：本期已结 paid 任务投影成人话（读看板任务清单，不编）
4. 下阶段计划：下一 sprint 的 paid 任务拉 3 到 5 条；末尾引用最新关键词方向卡链接与上期确认结论
5. 专业建议：1 到 2 条，doable 且真

## 取数与口径（AU 基准，逐条可被客户 facts 覆盖）

| 数字 | 默认来源 | 口径要点 |
|---|---|---|
| 各系列花费/曝光/点击/CTR/CPC | Google Ads API `FROM campaign`，CID 取 facts `ads.google.customer_id` 或 profile | 整月；**先核投放天数 = 自然月天数**，缺天必须在统计说明里写明（Ben's NZ 8 月断投 5 天的教训） |
| 广告询盘（对客数字） | 看 facts `paid.report_lead_source`：`wf_backend` 则取 WebForger 后台 lead 的 meta 带 gclid/gbraid/wbraid 条数；未设或 `ads` 则用账户计数转化 | WF 口径注意**捕获起点**（facts `paid.gclid_capture_since`，之前的月份不可比不得重算）；AU 站要筛 `meta.state` 有值 |
| 系列间询盘分配 | `segments.conversion_action_name` 过滤到计数转化 | 只用于分配，不当总数；PMax 小数用最大余数法取整 |
| 全站询盘合计 | WebForger `GET /api/leads/list` 按 createdAt 的 UTC 月份 | 各渠道行加总可略小于合计，表下注明 |
| GA4 会话/渠道 | facts/profile 的 GA4 property，**必须加 hostName 过滤**防姊妹站串码 | 渠道表合计与概览 sessions 两数并存时用渠道表合计 |

- 转化一律按 facts `ads.google.conversion_scope` 的干净口径，官方 Conversions 列的注水部分不参与判断。
- 环比只在两期口径一致时给；口径变更月（如捕获起点当月）该卡不标环比，改在统计说明里给可比口径。
- 数字全部现拉现算，禁止沿用上月报告里的数或简报快照当本月数。

## 自检清单（草稿顶卡，逐项打勾，答不了写「待人核」）

1. 投放天数 = 自然月天数？缺投日期列出。
2. 询盘口径用的哪个（写明来源与筛选条件），与客户后台界面能对上吗？
3. 转化口径是否 facts 的 conversion_scope，有没有混入注水动作？
4. 环比两期口径一致吗？不一致的卡去掉环比了吗？
5. 花费合计与账户级 `FROM customer` 对得上吗（差值 < 0.5%）？
6. 有没有告警红（客户报告禁警示红，坏消息用琥珀）？行业词是否保留英文原词？

## 硬性动作

- 产出后自跑 `python3 /data/aira/scripts/deliverable_lint.py <草稿绝对路径>`，结果写进摘要；FAIL 必须修到 PASS。
- 全文中文（站点语言内容除外），遵守 paid_section.md 的全部语气规则与 report 铁律（不出现工具名/AI/内部黑话，排名变好写「提升」）。
- WebForger API 登录必须带 `User-Agent: curl/8.5.0`（默认 python UA 被 WAF 403）；凭据在客户 notes/webforger_credentials.md。
- 拉不到的数据写「本期未统计」并入自检清单，不编数、不用旧数顶。
