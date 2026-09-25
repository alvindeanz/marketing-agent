# WordPress 能力清单 v2

<!-- WP-CAP-V1（2026-09-21）：首版。执行通道是 wf-agent 插件 1.3.0 的 REST 命名空间（v2 2026-09-25：content 模块上线，正文编辑与 draft 建稿转机器道；插件与 CLI 现由 Aira 全权共维，wp-tools 仓）
     `<domain>/wp-json/wf-agent/v1`，token 鉴权（header `X-WF-Agent-Token`），Aiden 维护。
     接入包与回执见 /mnt/share/aiden/to-aira-wp-sites-access-20260920-1847.md（阅后即删的交接文件，
     长期真相源是各客户工作区 CLAUDE.md 与 notes/wordpress_credentials.md）。 -->

平台：WordPress（现役两站：sdalu.co.nz、kiaorakids.co.nz，均 Rank Math，自家 cPanel 托管）
适用：装了 wf-agent 插件的 WP 客户站。**唯一写通道是插件 REST**（Alvin 2026-09-01 定：不直接改主题与后台，不直连数据库，不绕插件拼临时调用）。每个写操作插件自动留写前快照，`POST /snapshots/<id>/rollback` 可回滚。token 在客户工作区 `.secrets.env`（键 `WF_AGENT_TOKEN`，chmod 600，gitignored），**任何方案、执行记录、日志、stdout 里都不得出现 token**。

autonomy 三级判定标准与 webforger.md 同一条：出错以后能不能低成本还原，以及错误在还原前是否已被客户或搜索引擎看见。

- `agent_apply`：可逆，插件写前自动快照。agent 可以直接执行。
- `agent_prepare`：对外可见的内容变更。agent 只准备到可执行方案，人放行后由 apply_task 执行。
- `human_only`：插件无端点或不可逆。agent 一律不碰，只能写建议；能力缺口按规矩登记回 Aiden 走正式发布链加端点，不许绕。

<!-- PLANNING_VIEW_START -->
## 规划视图

| operation | autonomy | 说明 |
|---|---|---|
| wp-seo-meta-update | agent_apply | post/page/product 的 title、description、focus、canonical，走 `/seo/<post_id>`。**授权域**（对齐 shopify article-meta-update 2026-09-24 版）：双闸 confirmed 客户在锁词/mapping 页面范围内免卡直落；无双闸客户覆盖已有值走网页调整卡 |
| wp-term-seo-update | agent_apply | 分类 term（含 Woo 产品分类）的 SEO 字段，走 `/seo/term/<term_id>`，分界同上 |
| wp-redirect-add | agent_apply | Rank Math 重定向增改，走 `/rankmath/redirections`；source 只收路径不收全 URL；加前必查目标零跳转防叠链 |
| wp-sitemap-flush | agent_apply | 清 Rank Math sitemap 缓存，走 `/rankmath/sitemap/flush`，配合前三个 op 收尾用 |
| ga4-audit | agent_readonly | 只读审计 GA4，口径同 webforger.md |
| gsc-audit | agent_readonly | 只读审计 GSC，口径同 webforger.md |
| wp-content-edit | agent_prepare | 正文/标题/摘要编辑，走插件 1.3.0 `/content/<post_id>`（写前自动快照 post_content 类，可回滚，另有 WP 原生 revisions）。方案逐处点名读改写；双闸授权域内免卡。Elementor 页端点自动拒写（正文在 _elementor_data），撞到即转人工。核心 /wp/v2 被主机封锁的旧说明作废，一切走插件隧道 |
| wp-draft-create | agent_prepare | 新建 draft（post/page），走插件 `/content`，post_status 硬编码 draft 永不直接发布；发布是 status 字段另一次显式写（对外可见，凭证走客户卡批文） |
| wp-structured-data | human_only | FAQ/JSON-LD 走 Rank Math（正文内联 JSON-LD 会被剥），插件暂无端点 |
| wp-woocommerce-write | human_only | Woo 商品数据（价格、库存、描述正文）插件无端点，SEO meta 除外（走 wp-seo-meta-update） |
| wp-plugin-theme-ops | human_only | 插件、主题、核心更新与配置，一律人工 |
<!-- PLANNING_VIEW_END -->

<!-- RISK_CLASS_START：放行分级输入（见 ../release_policy.md），与 release_policy.json 一致由 specs 测试断言 -->
## risk_class（放行分级）

- wp-seo-meta-update: reversible
- wp-term-seo-update: reversible
- wp-redirect-add: reversible
- wp-sitemap-flush: reversible
<!-- RISK_CLASS_END -->

## 风险注记（execute 与 apply 阶段必读）

- **token 纪律**：token 只活在 `.secrets.env` 里。curl 用 `-H "X-WF-Agent-Token: $(sed -n 's/^WF_AGENT_TOKEN=//p' .secrets.env)"` 内联取值；禁止 cat/echo/打印该文件或该变量，禁止把 token 写进方案、执行记录或任何输出。
- **写前现读**：客户会自行改站。写前 GET 当前值与方案「改前值」比对，不符即停手（aborted），差异写进执行记录，不动那一处也不「纠正」客户的改动。
- **快照即回滚方式**：插件每次写自动留快照，方案的回滚章节写「按快照 id 回滚（POST /snapshots/<id>/rollback）」并把写前 GET 到的旧值列全；不许把手动建快照写成前置步骤。
- **sdalu 专属坑**：Wordfence 在线。批量写每条间隔 2 秒以上；大 HTML payload 会撞 WAF 403，改大段内容拆小。页面正文是 WPBakery shortcode（在 post_content），任何正文操作严禁破坏 shortcode 结构（当前正文归 human_only，此条为未来解锁备忘）。
- **kiaorakids 专属坑**：PHP display_errors 开着，REST 响应可能带 PHP warning 的 HTML 前缀，解析 JSON 前先把响应截到第一个 `{` 或 `[`。`team` CPT 关了 show_in_rest。另：Elementor 与 WPBakery 双构建器混用，见 wp-content-edit 行。
- **回读验证**：每个写操作后 GET 同一端点核对新值，并 curl 线上页面（`--max-time 120`）验证 200 与关键改动点可见（meta 类看页面源码的 title/description）。
- **sitemap**：改了 SEO 字段或重定向后按需 flush 一次，不要每条写后都 flush。
