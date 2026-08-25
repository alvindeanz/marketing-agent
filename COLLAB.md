# COLLAB — Aiden + Aira 协作账本

append-only，新条目加在最上面。每条固定格式：日期、谁、干了什么（commit 指路）、坑、下一步/认领。
只写共识层信息：结论、教训、接口约定。过程日志和各自的蒸馏记忆不要搬进来（memory 不入库）。

## 协作规矩（沿用 webforge 账本模式）

1. main 直推，无 PR。秩序靠认领和账本，不靠流程。
2. 认领边界见下方登记。跨认领边界动手前先在账本登记一条；发现对方领地的 bug，报告不动手，修复归认领方排期。
3. 推之前本地测试全绿（node tests/ 全套加 php -l seo-api.php），结果写进条目。
4. 部署单点走 Aiden 的 deploy.sh（哈希校验加自动回滚，250 与 ros 两台机）。Aira 推完 main 在账本留一行"待部署"，Aiden 部署验收后回一行。红线：ros 上 /data/aira/seo-worker/ 是部署产物不是工作区，任何人不许直接改线上文件，deploy 的哈希校验会覆盖一切手改。
5. DB 变更一律走惰性 DDL 先例（ensure_* 函数，information_schema 逐值比对幂等），禁手工上库打 DDL。
6. 并行改动禁 git stash（webforge 事故教训）。
7. 全部产物中文，禁 emoji 和破折号。

## 认领登记（2026-08-24 初始）

- **Aiden**：seo-api.php、static/seo-agent.html、deploy.sh、sql/、seo-worker 既有 runners 与 lib（listener/runner_host/pull_data/discover/plan/execute_task/apply_task/feedback/triage/ruling/chat/blogimages/registry/deliverables/metrics 等）。
- **Aira**：非 WebForger 平台适配（content_registry 的平台枚举器、能力清单 specs/capabilities/ 下新平台段）、specs/SOP 层的执行经验回写。入口窄面起步，贡献稳定后按数据扩认领。
- 部署权：Aiden 单点，待 Aira 贡献量稳定后下放 worker 侧本地部署脚本。

## 条目

### 2026-08-25 AIRA (k) 批量导入第二批：kuddles（47）与 louvresky（16），报四条 worker 侧问题

- 干了什么：按 Bens 试点定型的五步（蒸馏、裁决、现验、导入、重规划）导入两家 WebForger 客户。kuddles：30 facts + 12 大事记，四 job 全 done，plan 6 draft 12 任务。louvresky：36 facts + 19 大事记（55 行顶格），四 job 全 done，plan 7 draft 12 任务。两家 GSC 均为 URL 前缀属性（服务账号列站确认，非 sc-domain）。导入包留档各客户 seo-agent-onboarding/import_package_v1_final.md。
- 坑（Aiden 领地，报告不动手）：1) **lib/metrics.js 的 LEAD_EVENTS 写死** form_submit / generate_lead / click_to_call，louvresky 关键事件是自定义名（Quote Page Form Submited 等），ga4_leads 回填 180 天全零，报告询盘也会是零。建议 profile 加 lead_events（JSON 数组）列，metrics 与 backfill 与 report 数据层都按客户读，缺省回落现值。2) **discover 给 seoq 的 keywords 种子带引号被 gate 判非法字符拒绝**（kuddles 两次），本地词场就此成未知项，去掉引号即可。3) **content_registry 读 WebForger 分页的 page 参数被截成 `pages%2F`**（kuddles 教育者页与 /blog/ 共 10 处 404），疑似路径含斜杠未整体编码。4) **webforger_credentials.md 解析只认 Email/Password 行或表格**，louvresky 凭据在客户 .secrets.env 里，首轮 registry 被跳过；我已在 md 补表格并重拉（job 67）。建议解析器也支持从客户目录 .secrets.env 读 WF_BOT_EMAIL/WF_BOT_PASSWORD。
- 下一步/认领：两份 plan 交 Alvin 终审。第三批候选：t3interior、benscurtainsnz（WF）；Shopify 客户前置我写 content_registry 枚举器。

### 2026-08-25 AIRA (j) 月报只出完整自然月，部署 (i) 的模板修复

- 干了什么：Alvin 定月报周期为 1 号到月末整月，不出月中版。POST /reports/generate 对 period_type=month 校验 start 为 1 日、end 为月末、月末加 3 天 GSC 延迟不晚于今天，否则 400 并回 latest_month；前端月份选择器 max 与默认都是上一个完整月（复用 insToday 的 3 天延迟），越界提交前端先拦。worker 侧 computePeriod 的夹取保留作保险。测试 chat 29 / insights 83 / report 88 过，php -l 过，内联 JS node --check 过。**api 与 worker 一起部署**（worker 这次把 (i) 条的模板修复也带上）。
- 坑：Bens 8 月的 v1 至 v3 是规则定之前的月中版，留作版本历史；9 月初重新出 8 月整月版。
- 下一步/认领：Alvin 在看板自测 powerdekor 7 月报（我不代点）。

### 2026-08-25 AIRA (i) 报告模板头部注释漏进成品，模板层根治，报 lib 一处脆弱点

- 干了什么：Bens 8 月报告 v1 至 v3 线上页顶部漏出模板说明文字（"渲染硬约束……report_lint.py --check"），且说明里那个没闭合的 `<b style="color:#16a34a">` 把整页染成绿色加粗、hero 挤成半宽。根因：`lib/reporthtml.js` 的 `stripGuidanceComments` 用非贪婪 `<!--([\s\S]*?)-->` 剥注释，模板头部注释里写了字面量 `<!-- section:xxx -->`，正则在那句提前闭合，剩余说明文字变成正文。修法在我认领的 specs 层：`template_leadgen.html` 与 `template_skeleton.html` 头部注释里的 `<!-- section:xxx -->`、`<!-- /section:xxx -->`、`<!-- row:xxx -->` 三处字面量改成不含注释符的写法。`tests/report.test.js` "模板注释不进成品"一条加断言：`<html` 之前只允许 `<!DOCTYPE html>`（旧模板实测能被这条抓住）。三套测试 report 88 / chat 29 / insights 83 全过。已发布的三份产物（本地 seo-agent-output 与 250 上 seo_report_2026-08_v1 至 v3）已手工剥掉漏出段并重传，v3 线上回读 `<html>` 前只剩 DOCTYPE。
- 坑（Aiden 领地，报告不动手）：`stripGuidanceComments` 对注释里再出现 `<!--` 没有防护，任何人以后在模板注释里举例写注释标记都会复发。建议改成先按 `<!-- section:` / `<!-- /section:` 白名单切分再剥，或在渲染后断言 `<html` 前只剩 DOCTYPE 直接抛错（测试已加，渲染层若也加一道更稳）。
- 下一步/认领：待部署（worker 侧 specs 两文件 + tests）。Bens 8 月报告下次重跑自动干净。

### 2026-08-25 AIRA (h) 试点 v1 修三处，报 apply_task 一条判定问题

- 干了什么：benscurtains 2026-08 月报 v1 跑通（叙事一次过、lint 零命中、工作板块 8 项），审出三处修掉：1) 数据层周期不夹 GSC 延迟（显式传月末就按 31 天拉，环比全是假下滑），factspack.computePeriod 改为无条件夹到今天减 3 天并标 partial；2) 页眉客户名丢失（seo_profiles 无 name 列），**跨认领在 GET /context 的 profile 上补 name（从 clients 表取，已有则不覆盖）**，页眉空字段改为不显示；3) 工作分类加 ads（广告账户），数字条改按分类计数。测试 chat 29 / insights 83 / report 88 过，php -l 过。**api 与 worker 已随本次一起部署**（Alvin 指示的试点推进）。
- 坑（Aiden 领地，报告不动手）：**apply_task 把「有未验证项」当失败**。task 61 整页重写 7 步全过、V1 至 V11 通过、页面已上线（H1 实测新版），仅 V12（Rich Results Test 需浏览器）与 V13（14 天后跟进）无法当场验，runner 判 `verification_passed is not true` 置 failed 并留 review，人工已改 done。建议：验收项区分「当场可验」与「延后或人工」两类，后者不计入失败判定，只写进 result_note。
- 下一步/认领：v2 已排（job 56）。

### 2026-08-25 AIRA (g) 报告模块 P1 落地（待部署 api 加 worker）

- 干了什么：sales 一键出报模块 P1 全套。后端 seo-api.php：ensure_reports_schema（seo_reports，无外键）、POST /reports/generate（admin，校验 workspace_dir，同类 job 409）、POST /reports（worker，version 服务端算）、GET /reports、GET /reports/{id}/pack、PATCH /reports/{id}（note/status）；**跨认领改动两处：GET /metrics 与 GET /events 由 auth_admin 改 auth_any**（worker 数据层复用，回传只有指标与事件标签）。worker：lib/factspack.js（零 LLM 数据层）、lib/reportlint.js（copy_rules D 段全部规则加数字校验）、lib/reporthtml.js（零 LLM 渲染）、lib/publish.js（ssh 别名 blogpreview 上 250）、runners/report.js 重写（一次 LLM 加一次纠错，仍坏降级纯数据版 job 不失败）、specs/report/ 契约与 leadgen 模板；lib/config.js 加 reportModel/reportSsh/reportRemoteRoot/reportUrlBase/reportTimeoutMin（DEFAULTS 兜底，config.json 不用改）；lib/api.js 加四方法；lib/distill.js factLines 加 excludePrefixes（filter 在 slice 前，默认不变）；lib/metrics.js 只加导出；listener.js 超时按 type=report 取 reportTimeoutMin。前端 seo-agent.html 加「报告」tab（区间指标、生成月报、版本列表带备注与已发送标记），新增 rep* 纯函数在 INSIGHTS-PURE 区间。测试：node tests/ chat 29、insights 83（含新增 7 条）、report 88（新）全过；php -l 与 chatapi.test.php 16 条在 250 上过；全部 js node --check 加 require 加载过。
- 坑：1) **execute_task 多任务串行会顶 30 分钟超时**（benscurtains job 52 三任务只跑完两个即被杀，61 补排 job 53），建议一任务一 job 或按任务数放宽 jobTimeoutMin，归 Aiden。2) GA4 默认渠道分组有 "AI Assistant" 标签，成品 lint 对裸 AI 字样只查叙事不查全文，否则永远过不了闸。3) 报告 HTML 不走 deliverables 通道（无 html 扩展名且强制下载），走 250 静态托管。
- 下一步/认领：**已部署 api 与 worker**（Alvin 指示，2026-08-25 Aira 执行，rev 8bc511d，含工作量数字条那次提交；部署前 active job 为 0）。试点 benscurtains 2026-08 月报 v1 已排 job 55，人工过目后再开放其他客户。P2 周报季报，P3 /client 门户读 sent 版本。

### 2026-08-25 AIRA (f) 认领扩围登记：报告模块整块

- 干了什么：Alvin 指示报告模块（sales 用的一键出报）整块由 Aira 做，理由是 PJ 流程自动化需要全部客户报告记忆。范围：新表 seo_reports（惰性 DDL）、seo-api.php 新增 /reports 端点组、report runner（现占位）、前端客户级「报告」子 tab、specs/report/ 三件（facts pack schema、prompt 契约、HTML 模板）。会碰 seo-api.php、seo-agent.html、runner_host KNOWN_TYPES（report 类型已登记）与 runners/report.js。
- 坑：与 Aiden 现有代码的接缝只做加法（新 ensure_*、新路由分支、新 view），不改既有函数签名；所有改动按本账本条目回溯。
- 下一步/认领：P1 月报 MVP，Bens 试点；P2 周报季报；P3 /client 门户读 sent 版本。部署仍 Alvin 点名。

### 2026-08-25 AIRA (e) 跨认领登记：plan.js 删硬编码客户背景

- 干了什么：Alvin 要求根治 plan 简报串客户背景的坑（(b) 条 bug 1），跨 Aiden 认领动了 seo-worker/runners/plan.js：删除第 36 到 48 行写死的 CLIENT_BACKGROUND（powerdekor 试点背景：新西兰地板站、jacktoto、78,000 垃圾外链）及第 169 行的引用，客户背景改为完全依赖 profile 与 facts 简报（benscurtains plan 5 已验证无此段规划更准）。同时从 DB 删除了 benscurtains 因该 bug 生成的任务 68（无挂靠记录）。测试：node --check plan.js 过，node tests/ 29+76 全过。
- 坑：powerdekor 侧若依赖这段背景（例如 disavow 决策的"假设链接有毒"前提），下次给 15 号跑 plan 前请把相关前提补进 facts（link.* 那组已基本覆盖）。
- 下一步/认领：**已部署 worker**（Alvin 指示，2026-08-25 00:13 由 Aira 在 ros 本机照 deploy.sh worker 六步执行：备份 .bak-deploy-20260825-001303、rsync 白名单、清单比对全一致、node --check 加 require 校验过、systemctl restart 后 active、DEPLOYED 记 rev 042dd95）。部署前确认 running job 为 0。部署单点仍归 Aiden，此次是老板点名例外。

### 2026-08-25 AIRA (d) 跨认领登记：前端小改

- 干了什么：Alvin 要求看板客户名前显示 #id 方便定位。跨 Aiden 认领的 static/seo-agent.html，按规矩先登记后动手，改动四处纯展示：侧栏客户行、主标题、收件箱客户下拉、新增客户下拉，均加 "#<client_id> " 前缀（侧栏 id 用 .muted 淡色）。不涉及后端与数据。测试：node tests/ 两套 29+76 全过（前端无单测），php -l 不适用。
- 坑：无。
- 下一步/认领：**已部署**（Alvin 指示，2026-08-25 用 deploy.sh api 模式跑的，seo-api.php 未改哈希一致，DEPLOYED-seo 记 rev a3be9b4，线上已验证）。部署单点仍归 Aiden，此次是老板点名的例外。改动仅此四行，Aiden 若有前端重构直接覆盖无妨。

### 2026-08-25 AIRA (c)

- 干了什么：powerdekor（client 15，Aiden 试点客户）PJ 记忆增量补全，只追加不覆盖：6 条规则/状态 facts（id 145 到 150：www 规范域与平台迁移背景、GTM v3 四条禁令、四个 money page 与映射、博客惯例、PDF 重定向平台限制、cocoa-oak 生成图待换）加 9 条大事记（02-28 到 07-14 六次注入复发时间线、06-21 内容、07-21 重建、08-23 disavow 提交）。状态类两条 2026-08-25 现验后写入。增量包留档 clients/powerdekorfloors/seo-agent-onboarding/increment_2026-08-25.json。未动 plan 3、任务和 agent 采集的 facts。跨到 Aiden 试点客户的数据层，属数据不属代码，报备。本条为文档改动无需测试与部署。
- 坑：15 号客户 facts 现为 57 行，距简报 60 条截断线只剩 3。ga4.* 前缀 17 条原子审计值（custom_dimensions_count、direct_nz_sessions_28d 一类）各占一行，建议合并为一两条审计摘要 fact，释放名额；或在 distill.js 的 factLines 里排除 history.event.* 并提高上限（见上一条 bug 3 的同一处代码）。
- 下一步/认领：合并 ga4.* 审计值归 Aiden 定夺（他采的数据）；我这边继续出写入规范 SOP。

### 2026-08-24 AIRA (b)

- 干了什么：benscurtains AU（client 46）从零重建导入试点跑通。流程：项目记忆蒸馏成 55 行导入包（36 facts 加 19 大事记，rule/state 分类，state 类 28 条全部现验后写入）、DB 直连真删十表旧记录（备份先落双份）、profile 加 facts 加大事记重导、pull_data/backfill/discover/plan 全链路重跑。产出 plan 5 draft（12 任务）待 Alvin 终审。此流程将作为后续全部 SEO 客户导入的模板，写入纪律我这边出 specs 层 SOP（蒸馏、导入预算、回写时机）。测试：node tests/chat 29 过、insights 76 过、chatapi.test.php（250 上跑）16 过、php -l 无错，本条目为文档改动未动代码。
- 报告三条 worker/api 侧 bug（发现不动手，修复归 Aiden 排期）：
  1. **plan runner 简报的任务背景段串入其他客户信息**：benscurtains 的 plan 4 与 plan 5 两次生成，背景段都把客户描述成"新西兰地板线索站，历史有 jacktoto 垃圾注入与约 78,000 条垃圾外链"（即 powerdekor 的画像），与 profile/facts/dossier 全部矛盾。模型自己发现冲突并按简报纠偏，但污染规划输入且诱发多余任务。疑似 plan 提示词模板里残留试点客户的写死背景。
  2. **LLM job 的 token_usage 全部记 0**：discover（opus 两轮）与 plan（fable）都没回写，PATCH /jobs/{id} 明明支持该字段，成本统计目前是空的。
  3. **plan 的 reject_reason 喂不回下一次规划**：distill.js 只读 context.active_plan.reject_reason，而 /context 的 active_plan 查询带 status='active' 过滤，draft 被 reject 后是 rejected，两种状态都进不了 active_plan，驳回理由永远断头。想让驳回意见影响重规划只能写 facts，建议把该字段读取扩到最近一条 rejected plan。
- 坑（导入纪律相关，未来批量导入沿用）：facts 简报层有 60 条硬上限，按 fact_key 字典序静默截断，且 history.event.* 大事记也占名额；单条 value 简报里截 400 字。导入包按"总量 55 行内、单值 400 字内"自控。另：facts 无 DELETE 端点，同 key 只能覆盖，孤儿 key 会以 confirmed 口径永久喂给后续 job，客户重导优先走 DB 真删重建（本次先例）。
- 下一步/认领：我出 specs/ 写入规范 SOP；三条 bug 归 Aiden。

### 2026-08-24 AIDEN (a)

- 干了什么：仓库从 ops-tracker 拆出（git filter-repo 保留全部 19 条相关提交史），内容为 SEO agent 系统全量：seo-worker（listener 加 11 类 runner 加 lib）、seo-api.php（看板后端）、static/seo-agent.html（看板前端）、sql、tests、deploy.sh。拆仓时点的线上状态：250 与 ros 与本仓 HEAD 逐文件哈希一致（DEPLOYED 记录 rev 见两台机器）。
- 坑：ops-tracker 里的同名文件已删除并留指路，以后 SEO 系统改动只认本仓，别改错地方。
- 下一步/认领：见上方登记。Aira 首个建议入场点：benscurtains 等非 WebForger 客户跑通后，把踩到的平台适配缺口按认领写回来。
