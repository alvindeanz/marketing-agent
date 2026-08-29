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
2. 风险闸门：不可逆写、花钱、对外发布永远人放行。模型只提议，服务端白名单执行。
3. facts 三分法：平台可读即 confirmed 可刷新；分析推断进报告带置信度；只有人类独有信息进待确认队列。
4. 结构化输出走三层防线模板（prompt 自检、同 job 报错喂回自修一次、仍败安全落地例外队列）。
5. 模型选择走 config（feedbackModel=sonnet、rulingModel=fable、chatModel=opus 等），禁散落硬编码。
6. 客户内容与话术不编造事实，缺的信息占位标注待提供。
7. 测试先行于推送：node tests/ 全套加 php -l 全绿才 push，见 COLLAB.md。

## 部署

`./deploy.sh check|api|worker`，凭据在 .deploy-env（gitignored，含 ROS_PASS/BT_PASS）。先 commit 再部署。api 先传 /tmp 远端 php -l 过了才落位；worker 备份、rsync 校验和白名单同步、双端哈希清单比对、node --check 加 require 加载校验、重启 systemd、失败自动回滚，DEPLOYED 文件记 rev。runner_host.js 顶层直接跑 main，不可 require；新 job 类型必须同时登记 runner_host 的 KNOWN_TYPES、seo-api 的 ensure_job_types、两边的 lanes 表；并且任何 INSERT agent_jobs 的新入口都要先调 `ensure_job_types()`，type 列是惰性扩的 ENUM，没扩就插会被截成空串（2026-08-29 plan_review job 195）。

## 历史出处

2026-08-24 由 ops-tracker 仓拆出，此前提交史已随 filter-repo 保留。设计决策的完整脉络在 powerdekorfloors 试点客户的项目记忆里（Aiden 侧），共识层结论以本仓 COLLAB.md 为准。
