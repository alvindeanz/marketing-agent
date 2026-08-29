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

### 2026-08-29 AIRA (ad) 登记：验证归机器，人只抽查

- 干了什么：Alvin 定的：deferred 验证项不该等人。新 `/data/aira/tools/verify/verify.js`（playwright-core 接系统 Chrome，无头）：hscroll / jsonld / text / status / rrt。apply 的 ALLOWED_TOOLS 放行 `Bash(node /data/aira/tools/verify/verify.js:*)`，prompt 改为：能用它跑的不许标 deferred；deferred 只剩「要 Google 交互工具」（抽查项）和「要等 N 天」（到期 PJ 机器复验）。note 头部「待人工」改「待复验」，API 正则两种都认，卡片与例外队列文案同步。Kuddles #71 V15 V16 机器复验全过已盖章（RRT 机器进不去，抽查项）；#70 V6 那次 generate_lead 在标记前 1 分钟量级发生，keyEvents 计 0 属正常，脚本 `clients/kuddles/scripts/kud_task70_v6.js` 等下一次询盘再跑。
- 坑：Google Rich Results Test 页面无头浏览器打得开但按钮不触发结果，别指望机器跑它。

### 2026-08-29 AIRA (ac) 登记：三归位规划 W1 到 W4 全部落地（不交接，Aira 独立执行）

- 干了什么：规划见 `/data/aira/projects/MA/memory/PLAN.md`。W1 事实唯一：新 `GET /board`（auth_any，跨客户总览：sprint 档、human_state、待人工项、预览链接、结束态证据、api rev）；`seo-worker/tools/board_todo.js` 由它生成 PJ 的 TODO.md（看板段禁手改，批注段手写）；apply 里 deferred 验证项从 result_note「检查:」行解析，进 `/attention.manual_checks`，卡片与例外队列显示「待人工 N 项」，`POST /tasks/{id}/manual_done` 盖章（note 必填，新列 manual_done_at / manual_done_note）。W2 done 有证据：所有写 done 的 13 处统一走 `task_close($tid,$kind,$reason,$by)`，kind 五选一 applied / accepted / dropped / merged / killed，applied 必须带「检查:」行，其余必填理由；分析任务无产出无预览不许验收；`/complete` 无 note 拒；closed_kind 新增 accepted（前端「验收」蓝标），老「[applied] 分析报告已验收 / 人工认定完成」按 accepted 派生。Louvresky #82 #85 重开为 #94 #95。W3 记忆租户闸：`/data/aira/scripts/memory_lint.py` 挂 PostToolUse hook（路径二选一、frontmatter type、跨客户口径检查），全库扫出 6 处已改；预览页顶部回显客户 CLAUDE.md（`clientRules`）。W4：deploy.sh ros 本机模式（ROS_PASS 已失效，本机跳过 ssh），`/board` 带 api_rev，board_todo 报部署漂移。九套测试全过，api 与 worker 均已部署 938af1a。
- 坑：`/overview` 已被单客户 Dashboard 占用，跨客户总览叫 `/board`。task_close 之外任何 `UPDATE seo_tasks SET status='done'` 都算绕闸，加新路径请走它。
- 下一步：历史无证据结束态不回填；worker 不注入 `_global/feedback_*` 的缺口待评估。

### 2026-08-28 AIRA (ab) 跨认领登记：变更方案加「放行卡」，预览页与看板卡片只给人看这一节

- 干了什么：Alvin 看 Kuddles #71 预览页的反馈：给团队看的应该是「要做啥」的结论，不是几万字取证。根因是一份方案同时喂人和 apply 机器，预览把第 1 节（取证）整节展开。改法：prepare prompt 在标题下强制 `## 0. 放行卡`（改什么每对象一行「旧值 → 新值」、为什么、风险与回滚、需要人定；`RELEASE_CARD_MAX_CHARS`=800，禁代码块 / curl / HTTP 方法 / 接口路径 / 字节偏移），`REQUIRED_PLAN_SECTIONS` 加放行卡，`lintPlan` 新增 `lintReleaseCard` 超长或夹带即打回；末尾那段 200 字摘要取消（json 块保留）。看板 result_note 正文改为放行卡原文（旧方案无卡时退回截断摘要）。`renderDocPreview` 变更方案只展开放行卡，其余全部（含 before/after 原文）收进一个折叠块；老方案没卡整份折叠。#71 的方案手工补了放行卡（第 2 节未动），预览页已重传。tests 九套全过。
- 坑：放行卡是给人的，别在里面写 apply 要读的东西；apply 只认第 2 节，卡上和第 2 节冲突以第 2 节为准，所以卡里不许出现执行细节。
- 下一步/认领：**worker 本条部署。** #71 等放行，卡上三个「需要人定」要 Alvin 拍。

### 2026-08-28 AIRA (aa) 跨认领登记：任务产出的内部预览页（agencyreport 通道）；分析型任务的「同意」= 验收

- 干了什么：Alvin 定的：所有产出先在我们自己的服务器上渲染成预览页给人看，看完再放行动客户站（PJ 手工产线的做法）。worker 新 `lib/preview.js`：零依赖 markdown 转 HTML（标题、段落、列表、管道表、行内、raw HTML 放行、注释剔除）；`renderBlogPreview`（review-only 的 meta 表、hero、正文、图片补绝对地址、Copy Article HTML 按钮，与 PJ 博客交付惯例一致）与 `renderDocPreview`（方案 / 大纲 / 分析报告）。execute_task 四个产出点（分析、prepare 方案、博客成稿、大纲）都经 `publishFile` 传到 250 的 `reports/{client}/preview/task-N.html`，result_note 首行写「预览: url」，前端状态行显示「预览」链接；博客话术里的占位符在大纲阶段替换成预览链接。另：分析型任务（agent 且无 ops）在 review 时「同意」= 置 done 记 [applied] 验收，不再排 apply 去找不存在的变更方案（Kuddles #72 #73 昨天因此失败）；decide / apply_verdicts / /tasks/release 三处同口径，卡上按钮显示「验收」。新 `tests/preview.test.js` 4 条，九套全过；php -l 在 250 过。
- 坑：预览不是站点主题，版式类改动放行后仍要看线上回读；预览页 noindex 但可公开访问，别放凭据。旧任务（本条之前出的）没有预览链接，重跑才有。
- 下一步/认领：**api + worker 本条部署。** Kuddles #71（v1 方案含快照前置被新规矩拒）重出 v2 作预览页首测；#72 #73 按验收处理。

### 2026-08-27 AIRA (z) 跨认领登记：已发布文章的就地改稿改为「存交付文件，放行后 apply 替换」

- 干了什么：#88 第二轮（job 143）就地扩写成功（2290 词、2 个 HTML 表、审稿删掉内部措辞与电气内容），但暴露一个安全缺口：**WebForger 对已发布文章的 PATCH 直接上线**（实测，之前记忆里「PATCH 不推送要 republish」是错的），等于改稿绕过了放行。修：execute 博客改稿遇到 status published 不碰平台，新正文 payload 存成 `task-N/revised-body-<slug>.md` 交付文件，交付用正式链接并注明「线上未动，放行 = 替换并发布」；apply 的 runBlogPublish 对已发布文章：有交付文件就先过发布门，再 PATCH 替换，再 publish 兜底推送；没有就跳过。
- 坑：#88 这一轮的改稿已经上线了（修复前跑的），结果已落到卡上并打 attention，请人通读线上文；多余草稿 outdoor-shade-cost-comparison-nz-louvre-pergola-or-awning 未发布待人工删。另：本条第一次执行时 shell 工作目录被重置到 /data/aira，git add -A 把外层仓库 6147 个文件打进一个提交（未推送），已 reset --soft 撤回并全部 unstage，工作区文件未动；以后所有仓库命令一律用绝对路径。
- 下一步/认领：**worker 本条部署。**

### 2026-08-27 AIRA (y) 跨认领登记：判定与写稿之间的断点补上；大纲阶段的放行 = 写正文

- 干了什么：#88 首轮全流程实测暴露两处断点。1) **大纲阶段的放行被当成 apply**（job 140，1 秒失败找不到变更方案）：seo-api.php 新 `blog_outline_stage()` / `blog_release_as_write()`，decide、apply_verdicts、/tasks/release、线程 release 四处统一：博客任务 output_url 不是预览链接时，放行 = 说明追加 [大纲已批] 并重排 execute_task；卡上按钮改「大纲已批，写正文」。2) **写稿 prompt 拿不到判定前提修正与已批大纲**（job 141：Fable 判「就地扩写现有成本文」，写手另起一篇对比文）：runBlogTask 读 task.review_adjust 与 task-N/outline-task-N.md 作为「判定前提修正」「已批大纲」硬约束注入写稿 / 改稿 prompt；`expandInPlaceSlug` 解析「就地扩写 /blog/<slug>」，命中且文章存在就切成 revise 模式改那篇不新建。另：review_plan 对 review 任务按顺序附变更方案 / 博客大纲 / 最新草稿（此前只认方案，博客大纲判不到）；判定原则加「方案里的选择题由 Fable 选、公开可查的信息不算客户独有」。测试 blog 5 / review 22，其余不变。
- 坑：job 141 建出的多余草稿 `outdoor-shade-cost-comparison-nz-louvre-pergola-or-awning` 留在平台未发布（bot 无删文通道），#88 的 output_url 已清空防误发布；人工删或改期另用。
- 下一步/认领：**api 已部署；worker 本条部署后重跑 #88。**

### 2026-08-27 AIRA (x) 跨认领登记：博客流水线改成带门的阶段机，把 PJ 手工产线的纪律搬进无头跑

- 干了什么：Alvin 第一性原理审过：正文、配图、发布是三个独立交付物，红线绑在它保护的那道门上，任何一次运行都交出做成的部分。worker 侧改动（execute_task 博客模式、blogimages、blogcheck、apply_task 发布、config）：1) **配图不再连坐正文**：`runImageStage` 槽位 3 次不过只记 blocked 不抛；封面缺时 `pickSiteMedia` 从 `GET /media` 按关键词挑站内真实素材兜底（跳过 flux- 生成图）；稿子照常 PATCH 上平台、进待放行，备注写「配图 x/4，缺哪个槽、最后原因、超 200KB 哪张」，图不齐打 attention。2) **客户规则层**：`clientRulesBlock` 读客户工作区 CLAUDE.md 与记忆目录 `<客户>/feedback_*.md`（去 frontmatter，每份 1500 字，总 9000 字），注入写稿、改稿、大纲、审稿四个 prompt，优先级高于 SOP 通用规则。3) **交付 lint 共用**：blogcheck 读 `/data/aira/scripts/deliverable_lint_rules.json`（_default 加客户层）的 banned_terms / absolute_claims / forbidden_openers，与 PJ 手工产线同一份规则表。4) **审稿**：机器校验过后 `reviewDraft`（`blogReviewModel` 默认 fable）按客户规则只出意见，opus 定点修一次再过机器校验，不循环；修不过沿用原版并把意见写进备注。5) **大纲门**：任务说明或判定前提修正里有「大纲 + 客户回批 / 审批」就只出大纲（交付文件 outline-task-N.md 加客户话术）进待放行；说明里带「大纲已批」（线程「改了重跑」写进去的）才写正文。6) **同 slug 复用**：上一轮遗留的同 slug 未发布草稿改它不新建，避免重复文章。7) **发布门**（apply_task.publishGate）：缺封面、正文有待人工配图标记、残留管道表、缺 FAQ JSON-LD 一律不发。新 `tests/blog.test.js` 4 条，八套全过。
- 补充（同日）：压缩做了。PJ 手工产线的做法搬进 worker：`lib/compress_image.py`（本机 Pillow，限宽 1280、质量 85 逐档到 55、仍超再缩一成）由 blogimages 在过检后 spawn，超 200KB 的图压完走 `POST /api/content/{siteId}/upload` 回传（`webforger.uploadAsset`），用回传路径；压不动或传不上用原图记日志不拦。实测 2.2MB 压到 190KB。原 FLUX 大图留在 assets 里没有删除通道。审稿多一次 fable 调用约 30 秒，改稿多一次 opus 约 5 分钟，只在审稿判 revise 时发生。
- 下一步/认领：**worker 本条部署。** Louvresky #88 说明里写着「大纲交客户回批」，重跑会先出大纲进待放行，这是设计行为。

### 2026-08-27 AIRA (w) 跨认领登记：博客校验数 HTML 表格；判决过期改内容哈希；换档提示

- 干了什么：1) Louvresky #89（Cost Breakdown 骨架）两次生成都被机器校验打回「至少 2 个表格，实际 0」。根因是自相矛盾：SOP 要求 2+ 表格，而 WebForger 博客渲染器不认 markdown 管道表（见记忆 feedback_webforger_no_gfm_tables），SOP 又没说可以写 HTML 表，blogcheck 只数管道表分隔行。修：`lib/blogcheck.structure` 同时数 `<table` 出现次数（回 pipeTables / htmlTables / tables）；SOP 的 Cost Breakdown 与轻快型两处写明「表格一律 raw HTML `<table>`，不写管道表」。新 `tests/blogcheck.test.js`。2) seo-api.php 判决过期改按 `review_text_hash`（标题加说明的 MD5，review_result 写入，ensure_review_schema 为老判决回填一次）：整 plan 批准、放行、写备注这些状态动作不再让判决失效（#88 #89 被误判过期）。3) 前端工具栏提示行在 sprint 换档时写「S2 已全部结束，自动进入 S3」，Alvin 两次把浮上来的下一期任务当成新任务。测试七套全过。
- 坑：站上已有的管道表老文章仍会原样显示 `|---|`，那是内容问题不是校验问题，要修走 qk 那份 fix_tables.js 的转换思路另立任务。
- 下一步/认领：**api 已部署（40af22f）；worker 本条部署。** Louvresky S3 的正确走法是「全部按推荐」：#89 并入 #88，#88 执行出大纲。

### 2026-08-26 AIRA (v) 跨认领登记：changeset 比对放过平台副产物，加「置完成」

- 干了什么：#83 v3 apply（job 126）14 处链接全改完、回读一致、线上生效，却被判失败：changeset 记了 5 个文件，方案声明 4 个，多出的 `posts-index.json` 是平台 PATCH 博客时自动重写的索引（preEtag 等于 postEtag，内容零变化），方案 V8 写死「多出任何一个文件即不通过」。修法：`lib/webforger.getChangeset` 保留每条的 op / preEtag / postEtag；`apply_task.compareFiles` 加 `isPlatformSideFile`（`posts-index.json`、`*-index.json`、`sitemap*.xml`、`history/`、`archive/`，以及 pre 等于 post etag 的条目）不算多出，只记进 side；模型自己的检查项若只因文件比对没过而 worker 比对无 extra，worker 改判成功；apply prompt 与 manifest 风险注记 1 同步写明口径。新端点 `POST /tasks/{id}/finish {note}`（人认定完成，理由必填，追加 [applied] 备注）与卡上「置完成」按钮，给「机器判失败但人看过站点认成」这种情况用。#83 已用它置完成。测试：apply 28（compareFiles 加两例），六套全过；php -l 在 250 过；内联 JS 过。
- 坑：`GET /changesets/{siteId}/{csId}` 的 files 条目实测形状为对象 `{ path, op, touches, preEtag, postEtag }`（#83 日志坐实），字符串形状留作兼容。
- 下一步/认领：**已部署 api + worker**。#86 v3 在等放行，走的是修正后的比对口径。

### 2026-08-26 AIRA (u) 跨认领登记：改站动作规范（changeset 协议）与失败可见性

- 干了什么：Alvin 定的两件事。**一、失败必须看得见。** 复盘 #83 / #86：apply 失败四轮五轮，卡上始终显示「待放行」，判决 do 不失效，按推荐又放行。原因是 attach_job_state 的失败判定拿 job finished_at 与任务 updated_at 比，而 apply 写失败备注本身就顶掉 updated_at，把失败信号盖住。改为：任务最近一次 job 是 failed 即失败态，并数「最近一次成功之后连续失败 N 次」（job_state.fail_count）；`task_fail_reason` 从结果备注里「执行中止 / 执行失败：」那句或 job 日志最后一条 FAILED 提取一句话原因；GET /tasks 加 fail_reason；新端点 `GET /jobs/{id}`（admin，含完整 log_text）。前端：状态行写「落地失败 N 次（job #）」，下面一行红字原因，加「看日志」弹窗；`rvApplicable` 排除失败态任务，按推荐不再盲放；手动再跑要确认框复述失败原因。**二、改站动作规范。** Aiden 的 bot 操作说明（/mnt/share/aiden/to-aira-webforger-bot-ops-20260826.md）并入 `specs/capabilities/webforger.md` 全局风险注记（execute 与 apply 都带）：开工三断言、changeset 安全网（不拍全站快照）、成功判定 = 2xx + 回读且禁响应字段断言、redirects 只 PATCH、超时重试口径、禁区路径、回滚现状（revert 未上线，失败 = 停手上报五项）、/api/doc 一任务一次、页面硬规则。worker：`lib/webforger.js` 加 openChangeset / getChangeset；apply_task 由 worker 登录代开 changeset（开不出来一条写请求都不发），id 注入 prompt，结束读 changeset 真实文件清单与方案末尾 json 的 files 比对，多出未声明文件即判失败；outcome 契约去 snapshot_label 加 touched_files / last_ok_step / fail_step；note 头部加「changeset: cs_x（N 文件）」与「文件核对」行；**自动快照回滚删除**（大站必挂，且 revert 未上线），失败备注写清半改文件与 changeset id 供人还原。execute_task：prepare 模板改「预期响应只写状态码 + 回读核对」，第 2 节末尾「涉及文件」，json 加 files；新 `lintPlan`：快照前置、PUT redirects、禁区路径、预期响应字段断言、缺文件清单，任一命中 job 判红打回重出，不进待放行。测试：apply 28（新 4），六套全过；php -l 在 250 过；内联 JS 与 ui 冒烟过。
- 坑：lint 首版全文扫描，把方案里「本方案不含 POST /snapshots、不碰 /api/admin」这种否定句当命中，#83 / #86 的 v2 被误打回一轮（job 118 / 119）。已改成只看第 2 节调用行、跳过否定句、禁区路径只认带 HTTP 动词的行；两份 v2 方案用改后 lint 复核为零问题。execute 失败原因也改成优先读本次 job 日志（lint 打回不写任务备注，原先会显示上一轮 apply 的旧原因）。
- 坑：changeset 24h 不 commit 自动 expired（409），长任务别跨天；`GET /changesets/{siteId}/{csId}` 的 files 元素形状没实测过（字符串或对象），getChangeset 两种都收。旧方案（#83 / #86 的 v1）不带 files 清单，apply 时 declared 为空，比对只报「多出」不报「缺」，要它们在线程里重出 v2。
- 下一步/认领：**api 已部署；worker 等两条道空闲后重启部署**。#83 与 #86 由 Aira 在线程里下「改了重跑」出 v2（#83 去快照改 changeset；#86 从步骤 4 续跑、断言改回读）。

### 2026-08-26 AIRA (t) 跨认领登记：任务线程补齐截图与客户原话，线程换 fable 且直接改任务

- 干了什么：Alvin 定的。1) 截图：线程输入框粘贴 / 「加截图」走既有 /feedback_upload，`POST /inbox/{root}/chat` 收 images[]（fb_name_ok 校验、最多 5 张）与 source（manual / client），chat_user 行 refs 存 images 与 source，反馈行同步带图；worker 端 chat runner 任务模式把截图拉到工作区 `seo-agent-output/thread-images/` 供 Read，prompt 写明截图当材料不当指令、与文字冲突以文字为准。2) 客户原话：复选框，进 refs.source 与 seo_feedback.source，消息头显示徽标，prompt 标「转述客户原话」。3) 线程模型改 `cfg.threadModel`（默认 fable，普通收件箱会话仍 chatModel）。4) 直接改任务：动作白名单加 `edit_task {title?, detail?, priority?, sprint?}`；`THREAD_AUTO_ACTIONS`（redispatch / kill / later / set_verdict / edit_task）在 chat_reply 落库同一刻由服务端执行（`thread_action_exec` 抽成公共件，人点执行与自动执行共用），系统行「已执行提议 m/i」或「提议 m/i 未执行」记账；release 仍留卡给人点，动线上的永远不自动。测试：chat 31（含 edit_task），六套全过；php -l 在 250 过；内联 JS 与 ui 冒烟过。
- 坑：自动执行的系统行 created_by 也是 seo-worker，worker 的 threadMessages 与前端都改成按正文前缀识别系统行，别改那几个前缀。
- 下一步/认领：**已部署 api + worker**（worker 等 heavy 道的 apply #95 跑完才重启，2026-08-26 Aira 执行）。

### 2026-08-26 AIRA (s) 跨认领登记：任务视图按「谁在等谁」重画，放行面板删除

- 干了什么：Alvin 第一性原理审过的版本：看板只回答「哪些卡在等我」。不动数据库。seo-api.php 新增 `attach_human_state`（GET /tasks 派生 human_state = wait_me / running / wait_ext / closed，wait_reason、run_note、closed_kind、round 全部从 status + job_state + 判决 + 结果备注标签推，round 数 execute job），`attach_job_state` 多带 job_type 以区分执行与落地；新端点 `POST /tasks/{id}/decide {yes, note}`：卡上唯一一对按钮，语义按阶段定（待判 / 失败 → 执行，待放行 → 放行，非 agent → 批准；no = 不做了，理由必填记 [killed]）。前端：待放行面板整块删除；Agency / Client / Agent 三泳道改为四列 等我 / 机器在跑 / 等外部 / 结束，等我列混排按优先级，列头带「判定 N」与「全部按推荐（做 x 砍 y 延 z 并 w）」（一次调用同时处理待判与待放行）；卡片两行：状态行（等什么 / 在跑什么 / 怎么结束 + 方案 vN）与 Fable 判决行，status 徽标、job 徽标、需人判断、上次失败徽标全部并进状态行；说明超 150 字折叠点开；「显示已完成」改「显示已结束」，结束列默认藏；隐藏空泳道开关删除。旧的 renderRelease 等函数保留但无 DOM 挂点，直接返回。测试五套全过，php -l 在 250 过，内联 JS node --check 过。
- 坑：首版部署后整页空白：重画 taskCard 时按锚点切片，把夹在中间的任务线程整段（var thOpen 等）切掉了，renderLanes 抛 ReferenceError。已从上一提交取回并补上 `tests/ui.test.js`：把内联 JS 装进 stub DOM，灌 `tests/fixtures/tasks_louvresky.json` 真实任务数据跑 renderLanes / 队列条 / 线程盒，以后前端切坏在测试里就炸，不用等人看到空白。
- 坑：human_state 是派生字段，前端凡是按 status 分组的逻辑都改成按它；taskVisible 的「已完成」判断也换成 closed。in_progress 这个枚举值实际没人写，派生时归 running 以防万一。
- 修正（同日）：Alvin 看后定：泳道回到 Agency / Client / Agent（不打乱两侧的任务规划），不要按状态分列，也不要待放行面板；每张卡只带一行状态。现状：泳道 = 负责方，泳道内按 等我 > 在跑 > 等外部 排，同档按优先级；泳道头显示「等我 N」；判定 / 全部按推荐两颗回到工具栏（mode all，一次处理待判与待放行）；隐藏空泳道开关恢复。其余（状态行、同意/不做按钮、线程、派生字段）不变。
- 下一步/认领：**已部署 api**（worker 无改动）。

### 2026-08-26 AIRA (r) 跨认领登记：任务线程替代反馈框

- 干了什么：Alvin 定的方向二。一个任务一条线程，零新表：复用 seo_inbox 的 chat_root / chat_user / chat_agent，根的 refs.tasks 只挂这一个任务。seo-api.php：`POST /tasks/{id}/thread`（取或建，回完整视图）；`POST /inbox/{root}/chat` 在根挂了任务时同时投一条 seo_feedback 加 feedback job（线程是反馈的容器，facts 抽取不断）；chat_reply 接受 `actions`，`inbox_refs_norm` 加 actions 键（白名单 redispatch / kill / later / set_verdict / release，最多 3 条）；`POST /inbox/{root}/thread_action {message_id, idx}` 人点执行才落账（redispatch = 指令写进 detail 并排 execute_task；kill = done；later = blocked；set_verdict = 改判；release = 排 apply_task），每条提议只能执行一次，系统行「已执行提议 m/i」记账。`inbox_ref_tasks` 多带 detail 与判定字段。worker chat runner 加任务模式：根挂任务时 prompt 多一段任务全文 + 判决 + 等放行时的方案正文（截 6000 字），回复 json 可附 actions，`cleanActions` 白名单归一化，release 只在 review 状态放行。前端：任务卡与待放行行的「反馈」按钮换成「线程」，卡内展开消息流 + 提议卡 + 输入框，跟 15 秒轮询静默刷新且不打断输入。旧反馈端点与历史保留未删。测试：chat 31（新 2），其余四套不变，五套全过；php -l 在 250 过；内联 JS node --check 过。
- 坑：线程根按 `refs LIKE '%"tasks":[id]%'` 找，依赖 inbox_refs_norm 的规范序列化（tasks 在前、无空格），别改那个函数的输出格式。
- 下一步/认领：**已部署 api + worker**（Alvin 指示推进，2026-08-26 Aira 执行）。三个方向全部落地。

### 2026-08-26 AIRA (q) 跨认领登记：判定自动接力，批准步骤取消

- 干了什么：Alvin 定的方向一。seo-api.php 新公共件 `queue_review_job($cid,$ids,$by,$audit)`：同客户已有 queued 且未满 20 的 review_plan 就并入其 payload（条件 UPDATE 防与 claim 撞车，落空则新建），否则按 20 一批新建并 fire_wake。三处自动调用：`/tasks/bulk`（plan 落任务）、`/tasks/{id}/result`（execute 出方案，判该不该落地）、`POST /tasks`（人工新建）；`/tasks/review` 也改走它，不再 409。人的动作从「批准、执行、放行」三次降为「按推荐执行、按推荐处理」两次，且都是看一行字点一下。前端任务卡去掉「批准」按钮，proposed 的 agent 任务可直接勾选执行；`queue_task_jobs` 排 execute_task 时把 proposed 置 approved，方案页的整 plan 批准保留（那是 plan 级闸门）。测试五套全过，php -l 在 250 过，内联 JS node --check 过。
- 坑：自动判定的来源是 worker 回写（/tasks/bulk、/result），所以 worker 服务令牌现在会间接创建 review_plan job；仍是人点过的 plan / execute 的收尾，不是定时触发。
- 下一步/认领：**已部署 api**（worker 无改动）。方向二（任务线程）接着做。

### 2026-08-26 AIRA (p) 跨认领登记：worker 拆轻重两条道，判定不再排在 execute 后面

- 干了什么：Alvin 定的三个方向之一（判定要快、要优先）。判定一批 20 到 45 秒，但 worker 单飞，排在 10 分钟的 execute 后面等于白等。零 schema 改动：`seo-worker/lib/lanes.js` 与 seo-api.php 的 `JOB_LANES` 同一张表（heavy = pull_data/discover/plan/execute_task/apply_task/report/backfill_metrics，light = review_plan/ruling/feedback/chat/triage，没登记的归 heavy）。listener 每条道各自单飞（`drainLane`），wake 与 poll 同时拍两条道，health 回 `lanes`；`POST /jobs/claim` 收 body.lane 只取该道，不传照旧全局（老 worker 兼容）；`jobs_queue_order_sql($lane)` 让位判断只看同道在跑的客户；位次按道各算，`GET /jobs/queue` 每行带 lane，queued 的 position 是道内位次。前端队列条排队数拆成「执行 x 判定 y」，判定中文案改「通常 1 分钟内」。测试：insights 91（新 1）、其余四套不变全过；lane 排序 SQL 在 docker mariadb:10.3 实测（16 号 heavy 在跑时，其 light 判定不让位；heavy 道 47 排在 16 前）；php -l 在 250 过；listener node --check 过。
- 坑：两条道意味着同一客户可能同时有一个 heavy 在改站点、一个 light 在读看板，light 全是只读站点，没有竞态。若将来往 light 塞会写站点的类型，这个前提就破了。
- 下一步/认领：**已部署 api + worker**（Alvin 指示推进，2026-08-26 Aira 执行）。方向一（plan / execute 自动接判定，去掉批准步骤）与方向二（任务线程替代反馈框）接着做。

### 2026-08-26 AIRA (o) 跨认领登记：任务判定（fable 闸 A）与只读 op 改 analysis 模式

- 干了什么：Alvin 定的：任务跑 execute 之前先由 fable 按第一性原理判「该不该做」（不做会怎样、ROI 量级、是不是 agency 的活、前提是否还成立、顺序），判决 concise 一行显示在任务卡上给人审，审完按推荐批量执行。落地四层：
  1. `seo-worker/specs/review_principles.md`：判断标准全文，五问加四档判决（do / later / merge / drop），改原则只改这一份。
  2. worker：新 job 类型 `review_plan`（`runners/review_plan.js`，模型 `cfg.reviewModel` 默认 fable，只读工具），一批最多 20 个任务一次判；上下文 = 原则全文 + `buildPlanningBriefing` 的客户简报（profile、facts、内容注册表、GSC/GA4/Semrush）+ 本批任务全文。三层防线同 ruling。归一化：批外任务丢弃、非法值 / 无 evidence / merge 目标无效一律降 later 并写明、漏判补 later。唯一写操作 `POST /tasks/review_result`，不改任何任务状态。`runner_host.KNOWN_TYPES` 与 `ensure_job_types` 同步登记。
  3. seo-api.php：`ensure_review_schema()` 在 seo_tasks 惰性加 9 列（review_verdict/reason/evidence/merge_into/adjust/job_id、reviewed_at、review_override/override_note）；`attach_review_state` 给 GET /tasks 挂 review_effective（人推翻优先）、review_stale（判决后任务或 facts 改过）、review_pending。写判决与推翻的 UPDATE 显式 `updated_at=updated_at`，否则判决一落地就算过期。新路由：`POST /tasks/review`（admin，排 job，同客户在飞 409）、`POST /tasks/review_result`（worker）、`POST /tasks/{id}/review_override`（admin，理由必填，不支持改成 merge）、`POST /tasks/apply_verdicts`（admin：do 置 approved 且 agent 任务走 queue_task_jobs 排 execute_task，drop 置 done 备注 [dropped]，later 置 blocked 备注 [later]，merge 置 done 备注 [merged] 并往目标 detail 追加来源；过期判决与非 proposed/approved/blocked 一律跳过并回 skipped）。
  4. 前端：工具栏重排（显示已完成 / 隐藏空泳道 / 时间档折进「显示」），新增「快速判定（N）」与「按推荐执行（做 x 砍 y 延 z 并 w）」，任务卡标题下一行判决（四档四色，drop 红 later 黄 merge 紫 do 绿，过期半透明，判定中蓝字），「改判」走 prompt 输理由，理由同时投 `/tasks/{id}/feedback` 走 feedback job 变 fact，这是唯一学习回路。
  另：`gsc-audit` / `ga4-audit` 在能力清单改成新等级 `agent_readonly`（capabilities.AUTONOMY_LEVELS 加一档），execute_task 对它走 analysis 模式一步出结果，不再走 prepare/apply 两段。起因是 Louvresky #84 花 12 分钟写了一份「打算怎么读 GSC」的方案，且 apply 阶段只有 curl 做不了 JWT。
  测试：新增 `tests/review.test.js` 20 条；五套 24/29/90/88/20 全过；runner 与 runner_host `node --check` 加 require 加载过；内联 JS node --check 过；php -l 在 250 过。
- 补充（同日）：判定扩到 review 状态。待放行面板加「判定方案」与「按推荐处理」，worker 对 review 任务读工作区 `seo-agent-output/change-plan-task-{id}.md` 附进 prompt（截 7000 字），原则文件加「已出方案」一节（范围膨胀、自查矛盾未处理、通道不存在、风险对收益），判决语义变为 do=放行排 apply_task、later=留在待放行只记备注、drop=置 done 不落地、merge=并入目标。起因：Alvin 在待放行面板按不到判定。tests/review 21 条。
- 坑：判决写入用 `rowCount()` 计数，MariaDB 对值未变的 UPDATE 回 0，这里因 reviewed_at=NOW() 每次必变所以没事，别把这句 SQL 改成不带时间戳。前端「改判」用了原生 prompt，够用先上，要换成弹窗随时可以。
- 下一步/认领：**已部署 api + worker**（Alvin 指示推进，2026-08-26 Aira 执行）。判决层评审（闸 B）**不做**，Alvin 2026-08-26 定：方案对错靠各客户 PJ 线程（Discord）人工抽查校准，抽查发现的偏差回写 facts 或 review_principles.md。

### 2026-08-26 AIRA (n) 跨认领登记：队列取单改客户轮转，不再纯 FIFO

- 干了什么：Alvin 看到 Louvresky 一口气批 7 个任务，Kuddles 的 1 个只能排在后面吃灰，问是否该按客户拆任务编号。结论：编号不拆（全局自增 id 只负责唯一与引用，按客户分号只换来心理整齐，代价是复合键与跨客户引用歧义），改的是取单顺序。seo-api.php 新增公共件 jobs_queue_order_sql()：按客户分区用 ROW_NUMBER 编内部序号，正在跑着 job 的客户再让一位，全局按 (rn, id) 出；POST /jobs/claim、jobs_queue_positions、GET /jobs/queue 三处共用，看板显示的「排队中第 N 位」与 worker 下一次真实取单一致。同一客户内部仍严格按提交顺序，worker 仍单飞（写操作不并发的前提不动），listener.js 零改动。测试：php -l 在 250 过；node tests 四套 24/29/90/88 全过；排序 SQL 在 docker mariadb:10.3（与线上同版本）上实测，场景「16 号 1 跑 3 排、47 号后排 1、15 号后排 2」出单顺序为 47、15、16、15、16、16，符合预期。
- 坑：窗口函数 10.2 起可用，线上 10.3 没问题；若将来换回 10.1 或 MySQL 5.7 此处要改成自连接计数。
- 下一步/认领：**待部署 api**（seo-api.php 单文件，PHP 即时生效，worker 无改动）。job 层没有优先级列，任务 P0/P1 目前不影响出单顺序，要不要把 seo_tasks.priority 带进 job 排序由 Aiden 定。

### 2026-08-26 AIRA (m) 跨认领登记：一任务一 job 线性队列，任务卡与队列条防呆

- 干了什么：Alvin 第一性原理定的：任务是工作单位，各自 30 分钟预算与成败，worker 单飞按 job id 线性消化，不做并发。seo-api.php：POST /jobs 的 execute_task 多 task_ids 拆成每任务一个 job（payload 仍是 task_ids 单元素，runner 不用改），去重改按任务（在飞的跳过并回 skipped，全部跳过回 409 兼容旧前端提示），补 50 个上限；POST /tasks/release 同样拆成逐任务 apply_task；新增 GET /jobs/queue（auth_any，全局 running 与 queued，含 client_name、task_id、elapsed_sec、position）；GET /tasks 每行附 job_state（queued/running/failed/null 加 job_id 与全局位次），一条 SQL 无 N+1。新增公共件 job_task_id / jobs_inflight_tasks / jobs_queue_positions / queue_task_jobs / attach_job_state。前端 seo-agent.html：任务卡徽标（排队中第 N 位 / 运行中 M 分钟 / 上次失败）、在飞任务勾选框禁用、任务页顶部全局队列条（跨客户）、执行与放行按钮按 ids 数量反馈并报跳过数、任务页加入 15 秒轮询（原白名单只有 jobs/dash/inbox）。纯函数 qsElapsedMin / qsStripText 在 INSIGHTS-PURE 区间。测试：chat 29 / insights 90（新 4）/ report 88 / apply 24 全过，php -l 与 chatapi.test.php 16 条在 250 过，内联 JS node --check 过。**修掉 (g) 条报的「execute_task 多任务顶超时」**。
- 坑：去重没用 JSON_CONTAINS 或 LIKE（10.3 上 payload 是 LONGTEXT 别名，非法 JSON 行为不稳，LIKE 误命中），改成拉该类型全部在飞 payload 在 PHP 里解，在飞集合以十计代价可忽略。
- 下一步/认领：**已部署 api**（2026-08-26 Aira 执行，PHP 即时生效，worker 无改动）。Kuddles S1 四个可一次全勾。

### 2026-08-26 AIRA (l) 跨认领登记：页面改动任务可抽查（受影响页面链接、机器检查、失败自动回滚）

- 干了什么：Alvin 第一性原理定的闭环：机器改线上页后，人只需一眼看到改了哪页与确认没崩；崩没崩归机器当场兜底；不做回滚按钮（人工回滚走对话）。零 schema 改动。跨认领动了 runners/apply_task.js、runners/execute_task.js、lib/publish.js、static/seo-agent.html。apply outcome 契约加 affected_urls / snapshot_label / before_archive / checks[{name,passed,deferred,note}]；判定只看 deferred=false 的项，延后项（Rich Results、收录跟进）只记录，**修掉 (h) 条报的「未验项当失败」**；失败且有快照 label 时调平台 restore 自动回滚并写「已自动回滚」，aborted 不自动回滚；result_note 头部固定四行（受影响页面、改前存档传 250 的 reports/{slug}/qa/、快照、检查通过与待人工计数），旧 verification_passed 向后兼容。execute_task prepare 输出 target_urls 写「目标页面」一行供放行前看。前端任务卡 URL 自动可点（linkifyText 在 INSIGHTS-PURE 区间），截断改按最后一个分隔符保留机器头部。publish.js 抽 publishFile，publishReport 行为不变。测试：chat 29 / insights 86 / report 88 / apply 24（新）全过，node --check 与 require 全过，php 未动。
- 坑：无新坑。快照 restore 是全站还原，会连带回退这期间其他写入，回滚前 note 里有 label，人工回滚也走同一接口。
- 下一步/认领：**已部署 worker 与前端**（2026-08-26 Aira 执行，rev edd9ccb，部署前 active job 为 0）。Bens S2 与 Kuddles S1 执行出的任务自带链接。

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
