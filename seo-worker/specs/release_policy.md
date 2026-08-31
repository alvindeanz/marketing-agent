# 放行分级政策（release policy）

<!-- PAID-RELEASE-POLICY-V1：Alvin 拥有本政策，改档位改这里（及同名 json）；Aira 起草与维护文档。 -->

机器可读的执行版是同目录 `release_policy.json`，服务端按它做 L0 自动放行；本文档解释规则。两份由 specs 测试断言一致，改一份必改另一份（json 是执行权威）。

## 档位

| 档 | 谁放行 | 覆盖 |
|---|---|---|
| L0 自动放行 | 闸A 复审判 do 即自动排 apply，人月度抽查放行记录 | 任务全部 ops 的 risk_class 均为 reversible，且非博客、非分析任务 |
| L2 人点 | Alvin（或授权的人）在卡上点 | 其他一切：花钱（spend）、不可逆（irreversible）、对外发布（external）、分析验收、博客发布、无 ops 的任务 |
| L1 冷静期 | 未启用 | 触发条件：L2 连续两周超 3 张再建（48 小时不否决自动放） |

## risk_class 四个值（定义在各渠道能力清单里，跟着操作走）

- `reversible`：改前有存档、可机器回滚（meta、正文、内链、否词、暂停单组、±20% 出价、时段）
- `spend`：直接动钱或建花钱的东西（预算、bidding、新建 campaign/adgroup/asset）
- `irreversible`：难以完整还原（301 批量、转化配置）
- `external`：对外可见的承诺或内容（博客发布、GBP、ad copy）

## 纪律

- 服务端白名单是唯一执行闸，不在 json 里的 op 一律按 L2 处理（默认从严）。
- 自动放行的任务 note 记 `[auto-release L0]`，月度抽查看这批。
- 学习期保护等执行侧风险注记在能力清单，与本政策叠加生效（都过才放）。
