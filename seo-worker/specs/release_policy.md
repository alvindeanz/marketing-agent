# 放行分级政策（release policy，类目无关：SEO 与 paid 同一份）

<!-- RELEASE-POLICY-V2：Alvin 拥有本政策，改档位改这里（及同名 json，json 是执行权威）；Aira 起草与维护文档。 -->

机器可读的执行版是同目录 `release_policy.json`，服务端按它做 L0 自动放行；本文档解释规则。risk_class 标在各能力清单里跟着操作走（googleads.md 行内标注，webforger.md 的 RISK_CLASS 块），specs 测试断言清单与 json 一致。

## 档位

| 档 | 谁放行 | 覆盖 |
|---|---|---|
| L0 自动放行 | 闸A 复审判 do 即自动排 apply，人月度抽查放行记录（搜 note `[auto-release L0]`） | 全部 ops 均 reversible，且不在 L0 排除表，且非博客、非分析 |
| L2 人点 | Alvin（或授权的人） | 其他一切：spend、irreversible、external、分析验收、无 ops 任务、L0 排除表内的 |
| L1 冷静期 | 未启用 | 触发条件：L2 连续两周超 3 张再建（48 小时不否决自动放） |

## risk_class 四个值

- `reversible`：改前有存档、可还原（meta、元素级正文、内链、否词、暂停单组、±20% 出价、时段、配图）
- `spend`：直接动钱或建花钱的东西（预算、bidding、新建 campaign/adgroup/asset）
- `irreversible`：难以完整还原（转化配置、GA4 配置）
- `external`：对外可见的承诺或内容（博客发布、GBP、ad copy）

## L0 排除表（class 是 reversible 但首版仍人点）

page-rewrite / page-rebuild（整页覆盖，影响面大）、styles-fragment（全站样式）、gtm-edit（追踪链路）。
理由：WebForger 的 changeset 只存原件，revert 端点未上线，回滚要人工照 pre/ 还原；这几个 op 出错的还原成本高。观察一个月无事故后逐个降 L0。

## 当前实际的 L0 名单（由上面规则推出，写在这里方便人扫一眼）

SEO：page-meta-update、content-edit、image-generate、redirect-batch（本身 agent_apply 不出卡）
paid：negative-keyword-add、ad-pause、adgroup-pause、keyword-bid-adjust、schedule-adjust

## 纪律

- 服务端只认 json：不在表里的 op 一律 L2（默认从严）；政策文件缺失时 L0 整体停用。
- 自动放行的任务 note 记 `[auto-release L0]`，audit 带 auto_release 清单，月度抽查看这批。
- 能力清单的执行侧风险注记（学习期保护、changeset 纪律）与本政策叠加生效。
