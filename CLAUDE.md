# marketing-agent — 多客户 SEO 自动化流水线

看板（admin）+ headless worker，服务 HornTech agency 的 SEO 客户运营。协作规矩和认领见 COLLAB.md，先读它再动手。

## 架构一图

- **250（宝塔 192.168.10.250，站点 always.horntech-dev.com）**：`seo-api.php`（看板后端，惰性 DDL，MariaDB 10.3 无 SKIP LOCKED）+ `static/seo-agent.html`（单页前端，部署为 /www/wwwroot/always/seo-agent.html）。登录复用 mini.php 的 users 表（mini.php 属 ops-tracker 仓，不在本仓）。
- **ros（192.168.10.205）**：`seo-worker/` 部署到 /data/aira/seo-worker/，systemd 服务 seo-worker 以 root 跑，wake webhook 端口 8377 加 5 分钟兜底轮询。红线：线上目录是部署产物，改代码只走本仓。
- **数据表**（全部惰性建）：seo_profiles / seo_plans / seo_tasks / agent_jobs / seo_snapshots / seo_facts / seo_feedback / seo_inbox / seo_deliverables / seo_metrics_daily。

## Job 类型

pull_data（零 LLM 四源：GSC/GA4/Semrush/content_registry，顺带 upsert 时序指标）、discover（opus 摸底）、plan（fable 90 天规划）、execute_task（opus，blog-draft ops 走博客产线含蚕食撞车拦截与配图）、apply_task（opus 照方案落地）、feedback（sonnet 解析人话成 facts）、triage（fable 巡检出 digest）、ruling（fable 解析收件箱裁决成白名单动作）、chat（opus 收件箱对话，只读加任务草案）、backfill_metrics（零 LLM 回填 180 天）、report（占位）。

## 硬规矩

1. 禁 cron 自动触发 LLM，一切执行源于人（按钮、收件箱、人放行的批次收尾）。失败 job 不自动重试。
2. 风险闸门（2026-09-14 Alvin 改版）：放行凭证先于一切写操作，凭证 = 频道委托确认（服务端双验引语）/ 客户批文 fact / 人工放行，凭证即放行，不二次采集（意图携带，policy mandate_doc）。执行分两级：有 L1 确定性实现的 op 走白名单执行器（ads_mutate 等，零模型且幂等）；白名单外的 op 由 apply 的无头 agent 泳道直接执行，收口必须过零模型后置对账（lib/ads_audit 账户硬读全符）。白名单是路由偏好不是能力天花板。生意闸永远停人：超委托范围的花钱/不可逆、合同外、客户关系动作。旧表述「模型只提议，服务端白名单执行」自本日废止。
3. facts 三分法：平台可读即 confirmed 可刷新；分析推断进报告带置信度；只有人类独有信息进待确认队列。
4. 结构化输出走三层防线模板（prompt 自检、同 job 报错喂回自修一次、仍败安全落地例外队列）。
5. 模型选择走 config（lib/config.js 的 *Model 键，权威在那），禁散落硬编码。路由原则（2026-09-17 Alvin 定）：fable/premium 只留定战略框架与不可回收现场判断（现为 planModel/planReviewModel/chatModel）；框内 go/no-go、服务端有硬校验的动作、总结、内容 QA 一律 opus（review/triage/ruling/thread/blogReview）。具体值以 config.js 为准，别在文档里复刻会腐烂的枚举。
6. 客户内容与话术不编造事实，缺的信息占位标注待提供。
7. 测试先行于推送：node tests/ 全套加 php -l 全绿才 push，见 COLLAB.md。
8. **可扩充 workers 是设计地基（2026-09-18 Alvin 定）**：一切新机制默认要经得起「N 个 worker 任意来去（重启/断网/被杀）系统照常」。三条硬约束：①无单实例假设（如 reap 早期「库里 running 必是上一世孤儿」那种，一律按 worker 身份收窄或超时清扫）；②共享状态要么 DB 原子（claim 走 CAS `UPDATE WHERE status=queued`+rowCount，同客户互斥走服务端 running 排除）、要么按 worker 隔离（fuse/logs/pending_terminal 各 worker 本地，注意 FUSE_FILE 默认是绝对 NFS 路径不自动隔离）；③绝对路径依赖走 NFS 单一事实源不做双份。写任何新代码前先问「两个 worker 同时跑这段会怎样」。宿主机形态：ros 是 systemd 服务；Mac worker 是 tmux 常驻非 launchd（macOS TCC 按二进制对网络卷授权，launchd 归因下 bash/coreutils 写全被拦，tmux 继承终端授权，2026-09-18 Connie 实测矩阵），重启机器后人工跑 /data/aira/start-seo-worker.sh。

## 部署

`./deploy.sh check|api|worker`，凭据在 .deploy-env（gitignored，含 ROS_PASS/BT_PASS）。先 commit 再部署。api 先传 /tmp 远端 php -l 过了才落位；worker 备份、rsync 校验和白名单同步、双端哈希清单比对、node --check 加 require 加载校验、重启 systemd、失败自动回滚，DEPLOYED 文件记 rev。runner_host.js 顶层直接跑 main，不可 require；新 job 类型必须同时登记 runner_host 的 KNOWN_TYPES、seo-api 的 ensure_job_types、两边的 lanes 表；并且任何往惰性 ENUM 列写新值的入口都要先调对应的 ensure（agent_jobs.type 是 `ensure_job_types()`，seo_tasks.module 是 `ensure_task_module()`）：ENUM 没扩就插，MariaDB 非严格模式会静默截成空串（2026-08-29 plan_review job 195；2026-08-31 任务 module=paid 丢失）。加任何 ENUM 新值 = 改 PHP 校验 + ensure 函数 + 本条清单，三处。

## 历史出处

2026-08-24 由 ops-tracker 仓拆出，此前提交史已随 filter-repo 保留。设计决策的完整脉络在 powerdekorfloors 试点客户的项目记忆里（Aiden 侧），共识层结论以本仓 COLLAB.md 为准。
