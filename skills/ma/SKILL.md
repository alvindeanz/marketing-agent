---
name: ma
description: "MA (Always Agent) 看板接入：任何 agent 线程要查客户台账、任务状态、90 天方案、worker 队列，或把一线观察回流进 facts 管线时用。触发词：看板, MA, always agent, 台账, facts, 客户任务, sprint, 方案状态, 放行, 队列。"
version: 1
---

# ma skill — 看板是唯一事实源，别再各线程口口相传

维护人 aira（改动走本仓 commit + COLLAB 登记）。工具：`skills/ma/ma.sh`（工作区挂载于 `/data/aira/skills/ma/`）。

## 第一性原理（为什么有这个 skill）

三四十个客户，Alvin 的注意力是瓶颈。每个 agent 线程各自记客户状态，等于几十份互相漂移的台账，漂移最后都变成 Alvin 要亲手裁的矛盾。所以：**客户事实、任务状态、方案，只认看板；线程里的新观察，只往看板回流**。这个 skill 是那条读写通道。

## 用法（先跑 `ma.sh` 看全部动词）

```
bash /data/aira/skills/ma/ma.sh context <客户>       # 动笔前拉：档案+facts+开放任务
bash /data/aira/skills/ma/ma.sh task <客户> <id>     # 单任务全文（含 fable 判决与方案摘要）
bash /data/aira/skills/ma/ma.sh items <客户> <id>    # 变更条目账本：哪处落了哪处没落（追执行状态用这个，别考古 result_note）
bash /data/aira/skills/ma/ma.sh plan <客户>          # 活跃 90 天方案
bash /data/aira/skills/ma/ma.sh facts <客户> [词]    # 事实台账
bash /data/aira/skills/ma/ma.sh chat <客户> <问题>   # 问 MA（触发一次看板会话）
bash /data/aira/skills/ma/ma.sh task-feedback <客户> <任务id> <正文>  # 观察回流
```

认证：`MA_TOKEN` 环境变量，或 `/data/aira/.secrets/ma_skill.jwt`（agent 线程共用账号 agent-bot，admin 角色，Alvin 2026-09-07 定；token 由 aira 维护轮换，当前期到 2027-03-06）。

## 规矩（违反任何一条都是事故）

1. **只用本文档列出的动词**。token 是 admin（Alvin 定，图省事不设多级账号），意味着服务端不会拦你调批准/放行/改判/建任务——所以这条纪律靠你自己：**那些动作是人的闸，agent 线程一律不碰，绕过等于替 Alvin 花钱拍板，属于事故**。要推动这些，把诉求写进 `chat` 或 `task-feedback`，由看板流程走人。审计日志按 agent-bot 记账，谁越权一查一个准。
2. **一次只碰一个客户**。查 A 客户的数据不写进 B 客户的产出；回流观察前确认 client 和任务号对得上（跨客户串写出过真实事故）。
3. **facts 分等级用**：`confirmed` 可直接引用；`unconfirmed` 只能当线索，不进任何对客交付物。客户产品事实（价格、规格、门店、交期、质保）缺了就占位标待提供，不猜。
4. **回流写事实不写结论**。task-feedback 写你观察到的（测了什么、看到什么数字、客户原话），抽取管线会落成 unconfirmed facts 等人确认；不要替看板下判断。
5. **chat 有成本**（触发一次 opus 会话）。能用 context/facts/task 直接查到的不要 chat；chat 留给需要跨台账推理的问题。一个会话一轮一问，等回复再追问。
6. token 不进任何输出、日志、交付物。

## 常见场景到动词

| 场景 | 动作 |
|---|---|
| 给某客户写内容/报告前 | `context` 拉台账，铁律与口径以 facts + 客户 CLAUDE.md 为准 |
| 客户在别的渠道说了新信息 | `task-feedback` 回流（有相关任务挂任务，没有就 `chat` 说明） |
| 想知道某件事看板推进到哪了 | `tasks` / `task` 看 human_state（wait_me=等人，等的是谁写在 wait_reason） |
| 队列卡不卡 | `queue` |
| 不确定该不该做某个动作 | `chat` 问，别自行动手 |

## 维护

- 本文件与 ma.sh 以本仓为唯一事实源，`/data/aira/skills/ma/` 是挂载壳。
- seo-api 端点变更（见 COLLAB）由 aira 同步进 ma.sh；用坏了在 COLLAB 报一条或直接找 aira。
- 版本号在 frontmatter，行为变更必须递增并在下面记一行。

变更记录：
- v1 2026-09-07 首版：读五件套（clients/context/tasks/facts/plan/queue）+ chat + task-feedback。
- v1.1 2026-09-07 账号定稿：共用账号 agent-bot 为 admin 角色（Alvin 定），权限边界改为动词纪律 + 审计，规矩第 1 条相应改写。
- v1.2 2026-09-11 W15/W16：新增 items（变更条目账本）；tasks/task 输出带 closed_kind（done(killed) 不再伪装成正常完成）；任务线程已下线，任务相关的问题走客户频道。
