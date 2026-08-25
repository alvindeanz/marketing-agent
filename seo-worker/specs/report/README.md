# 报告模块（sales 一键出报）设计契约

状态：P1 月报 MVP。认领：Aira（COLLAB 2026-08-25 AIRA (f)）。

## 用户与场景

用户是 agency 内部 sales，不是客户。在看板客户页「报告」tab：
1. 选日期区间看本地指标（seo_metrics_daily 时序 + 动作标注）
2. 点「生成月报」，默认上一个完整自然月，几分钟后卡片出链接
3. 同一个月多次生成叠 v1、v2、v3，旧版本链接永久保留；每版可加一句备注、可标记「已发送」

报告内容是客户面口径（sales 直接转发客户），文案规矩见 copy_rules.md，一条不减。

## 三层生成（数字与文字分离，核心约束）

1. 数据层（零 LLM）`lib/factspack.js`：按自然月拉数、算环比、算目标词位次、汇总工作量，输出 facts pack JSON（schema 见 facts_pack.schema.md）。**所有数字只在这层产生。**
2. 叙事层（LLM 一次 + 至多一次纠错）`runners/report.js`：只拿 pack 和客户面 facts，输出固定 section 的叙事 JSON（契约见 prompt_contract.md）。**不得出现 pack 里没有的数字。**
3. 渲染层（零 LLM）`lib/reporthtml.js`：确定性模板把 pack 和叙事拼成自包含 HTML，跑内置 lint，通过才发布。

第三层防线：叙事 JSON 两次都坏，降级为纯数据 HTML（sdesc 用固定句、callout 省略），status 留 draft，note 写明「叙事生成失败，纯数据版」，job 不算 failed。

## 数据流与存储

```
看板 POST /reports/generate {client_id, period_type:'month', period_start, period_end, instructions?}
  -> agent_jobs type=report payload 同上（同客户同类型排队中则 409）
worker report runner
  -> factspack -> LLM -> reporthtml -> lint
  -> lib/publish.js scp 到 250：/www/wwwroot/blogpreview.horntech-dev.com/reports/{slug}/seo_report_{YYYY-MM}_v{n}.html
  -> POST /reports {client_id, period_type, period_start, period_end, url, html_path, facts_pack, narrative_status}
     服务端取 version = MAX(version)+1（同 client + period_type + period_start）
  -> 成品与 pack 副本同时写客户工作区 seo-agent-output/report-{YYYY-MM}-v{n}.html / .pack.json
看板 GET /reports?client_id= 列版本；PATCH /reports/{id} {note?, status?: draft|sent}
```

slug 用 `clientDirName(profile, cfg)`，与工作区目录同源。对外 URL `https://agencyreport.horntech-dev.com/reports/{slug}/{file}`，页面带 `<meta name="robots" content="noindex, nofollow">`。

## API 契约（seo-api.php）

| 端点 | 认证 | 说明 |
|---|---|---|
| POST /reports/generate | admin | 校验 period_start/period_end 为 YYYY-MM-DD 且 start<=end，校验 profile.workspace_dir 非空（缺则 400 提示补档案），排 report job，fire_wake |
| POST /reports | worker | 落 seo_reports 行，返回 {ok, id, version} |
| GET /reports?client_id= | any | 按 period_start 降序、version 降序返回全部版本（facts_pack 不回传，只回 has_pack） |
| GET /reports/{id}/pack | any | 单独取 facts_pack |
| PATCH /reports/{id} | admin | note、status（draft/sent）|
| GET /metrics、GET /events | 改为 any | 原 admin，改动理由：worker 数据层复用，回传只有指标数字与事件标签 |

seo_reports 表（惰性 DDL，无外键）：id, client_id, period_type ENUM(month,quarter,week,custom), period_start DATE, period_end DATE, version INT, url VARCHAR(500), html_path VARCHAR(500), facts_pack MEDIUMTEXT, narrative_status ENUM(ok,fallback) DEFAULT ok, created_by VARCHAR(64), note TEXT, status ENUM(draft,sent) DEFAULT draft, created_at TIMESTAMP。唯一键 (client_id, period_type, period_start, version)。

## worker 配置键（写进 lib/config.js DEFAULTS，config.json 不同步）

| 键 | 默认 | 用途 |
|---|---|---|
| reportModel | opus | 叙事层模型 |
| reportSsh | blogpreview | ssh Host 别名（root 的 ~/.ssh/config 已配） |
| reportRemoteRoot | /www/wwwroot/blogpreview.horntech-dev.com/reports | 250 物理根 |
| reportUrlBase | https://agencyreport.horntech-dev.com/reports | 对外 URL 根 |
| reportTimeoutMin | 45 | listener 对 type=report 的单独超时 |

## 周期规则

- period_type=month：period_start 为月初，period_end 为月末或「今天减 3 天」取较早者（GSC 延迟）。若 period_end 早于月末，pack.partial=true，全文标注「截至 N 日，本月尚未结束」，环比用上月同窗（上月 1 日至同一 day），不做同比。
- 对比期：完整月对上一个完整月；partial 对上月同窗。
- 趋势图：向前 13 个月的 gsc_clicks 与 ga4_sessions_organic（来自 GET /metrics），最后一根若 partial 用浅色并加说明。

## 客户类型

pack.biz_type 由 facts 推断：存在 `biz.model` 且含「不是电商 / lead」写 leadgen；GA4 有 purchase 事件计数则 ecommerce；否则 leadgen。leadgen 的漏斗是 Sessions → form_start → 询盘（LEAD_EVENTS 之和），ecommerce 是 Sessions → Add to Cart → Checkout → Purchase。P1 只完整实现 leadgen（Bens 试点），ecommerce 分支保留字段与渲染条件，允许为空。

## 询盘真值源

pack 生成前读 facts：若存在 `ga4.lead_event` 或 `ops.report_number_discipline` 指明后台实收为准，pack.leads_source 记录来源名并在 sdesc 交代；P1 数字仍取 GA4 LEAD_EVENTS（系统内唯一可自动取的源），后台实收作为可选人工覆盖（POST /reports/generate 的 instructions 里写「询盘总数按后台实收 N」时，pack.leads_override=N 并在统计说明标注）。

## 测试与验收

- tests/report.test.js：pack 纯函数（环比、同窗、目标词加权位次、分类归组）、lint 规则、模板替换无残留占位符
- 渲染后跑 lint 序列（copy_rules.md D 段）exit 0 才发布
- 试点：benscurtains（46）2026-08 月报 v1，人工过目后再开放其他客户
