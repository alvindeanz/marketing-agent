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
