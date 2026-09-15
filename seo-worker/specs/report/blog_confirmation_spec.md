# 博客确认卡规格（blog-confirmation：博客发布前的客户确认卡）

## 用途与定位

老客户 sprint 内产出的博客，发布前出这一张卡给客户确认。方向层（关键词/mapping）老客户已内部静默确认，所以这是老客户 sprint 内**唯一的客户确认闸**（Alvin 2026-09-15 定）。客户点「同意，安排发布」即 agree，harness 下一轮折叠时排发布任务；不发布不经这一步。

## 形态（模型只产数据，不写 HTML）

模型只产一个 JSON（`blog_confirmation_data.schema.json`），`render_blog_confirmation.js` 渲染成客户版 HTML，版式与反馈通路复用方向卡那套（`blog_confirmation_template.html` + `direction_card_lib.js`）。`draft_url` / `draft_hint` / `window_line` / `attach_line` 由 execute 组装填入（模型不写链接）。

## 重点：快赢优先，不是学术级关键词规划

卡的目的是让客户看懂「这篇为什么值得发、能带什么流量」，然后放心点同意，不是给客户看一份严谨的关键词研究报告（Alvin 2026-09-15：形式不重要，流量和曝光快赢优先）。所以：

- `keywords` 按快赢排序：高购买意向、站内还没有页面覆盖、排名容易赢的词排前面。挑 2 至 5 个说清楚就够，不堆词。
- `oneline` 和 `decision.recommendation` 都讲人话的价值：这篇接住哪类搜索、把访客引到哪个成交页，别写技术指标。
- `intent` 写搜这个词的人想干什么（买前顾虑 / 找方案 / 比价），不写搜索量数字堆砌。

## 语言铁律（每句都过）

- 全中文人话，客户能懂；禁内部术语（SEO、CPC、CTR、CVR、PMax、ROAS、anchor 这类）。
- 禁破折号（—）。
- 关键词（term）用英文原词，不翻译成中文（copy_rules A31，渲染器会拦整列翻译）。
- 不编造事实与数据；配图数量、内链页面都要与实际草稿一致。

## 结构（模板固定，模型填槽）

1. 头部：标题 + 一句话（这篇写什么、接什么搜索）+ 预览大按钮（execute 填链接）。
2. 第一节「这篇文章针对的搜索」：`keywords`，每条 term + intent（+ 可选 note）。
3. 第二节「内链怎么连」：`links_out`（连去哪些页）+ `links_in`（从哪连来，可选）。博客有内链才有 SEO 价值，尽量给 links_out。
4. 第三节「配图」：`images_line`，与草稿实际配图一致。
5. 第四节「需要您确认」：一张决策卡，`decision.item` 固定 `publish_blog`。三个按钮：同意安排发布(agree) / 先不发保持草稿(hold) / 需要修改(other，带文本框)。

## 闭环规则

- agree（item=publish_blog）：harness 下一轮 foldCards 认出，排「发布这篇博客」的任务，走正常放行执行。
- hold：保持草稿，不发布。
- other（带文本）：客户要改，开修订跟进任务。
- 到期视同同意：博客确认卡默认**不启用**到期自动发布（对外发布风险高，宁可等真回复；由 harness 到期分支只对方向卡生效来保证，博客卡标题不含「方向卡/direction」不会命中到期分支）。
