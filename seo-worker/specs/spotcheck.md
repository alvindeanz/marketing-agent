# spotcheck 事后抽查器（2026-10-21 Alvin 批，改造序①）

<!-- 第一性：默认放行政策（release_policy v9 起）的另一半。事前闸拆了，换来的承诺是
     「事后抽、异常处置、逮一次堵一类」。本文件是闸四件套登记（硬规矩 9）。 -->

工具：`seo-worker/tools/spotcheck.js`，零模型零写入现实，从仓库直跑不部署。
用法：`SEO_AGENT_TOKEN=... node seo-worker/tools/spotcheck.js [--client N] [--task N] [--days 7] [--rate 0.1] [--max 12] [--apply]`
人触发（硬规矩 1）：Alvin 或 Aira 手动跑，建议每轮 harness 顺带一次。默认 dry-run，--apply 才把 FAIL 写回看板。

## 四件套

- **管什么动作**：近 N 天（默认 7）自动放行/自动落地（note 含 [auto-release]/[auto-apply]/[applied]）
  的写类 done 单。核验四项：C1 产出 URL 可达（客户域 200 零跳转，预览 200）；C2 客户可见页面
  源码无内部标记（Style Roll / card-autotoken / DRAFT NOTE / Editor note / PENDING 占位，黑名单
  在工具 LEAK_MARKS）；C3 无任务书外的 noindex；C4 note 有快照/回滚证据字样。
- **豁免面**：只读分析类 op（release_policy readonly_ops）不抽；任务书自带 noindex/草稿意图的
  C3 豁免；客户站自己的 HTML 注释不拦（黑名单只收我们自产标记）。
- **误杀出口**：FAIL 不自动还原不自动改现实，只亮 attention + note，人工定性。定性为抽查器误杀
  的，改工具规则（LEAK_MARKS 条目、豁免判定），不留带病规则。
- **命中台账**：每轮运行写 /data/aira/projects/MA/memory/spotcheck/run_*.md（立功与误杀都记）；
  定性为现实错的记 /data/aira/DEFECTS.md 一行，必须带上游修复点（堵整类，不是修一张）。

## 抽样口径

- watch 名单 100% 抽：新上线或刚降软覆盖的 op，当前 = geo-target-set、theme-code-update、
  wp-term-description-set、content-edit、page-rewrite、theme-text-edit（工具 WATCH_OPS，与本文件同步改）。
  维护：op 满 30 天零异常随闸年检移出。
- 其余按 --rate（默认 10%，下限 3 张），单轮总量封顶 --max（默认 12）。

## v2 预留（按台账证据再开，不预做）

- 异常自动原地还原（政策原文有此项；v1 先零写入攒台账，还原路径按平台分别接：WF changeset
  revert、shopseo restore、ads before 快照重放）。
- 申报字段深核：按 op 读 apply 账本逐字段对账（geo-target-set 可直接复用执行器 dry-run noop 判据）。
- 模型质量抽检：文案达标类判断，零模型核不了的那层，单独预算单独批。
