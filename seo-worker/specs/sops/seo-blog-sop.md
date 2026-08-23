---
name: seo-blog-sop
description: "写 SEO 博客文章/landing page 前必读。包含 Style Roll（6 维度风格组合）、5 种骨架硬约束、去重指纹检查、配图 SOP、质量红线 13 条。覆盖两类语境：(1) 本地服务行业（NZ/AU 服务商，Cost Breakdown / 本地化）；(2) 全球 SaaS（WebForger 类，Alternative Landing / Programmatic Comparison）。任何博客/cornerstone/alternatives 落地页/cluster post 写作前必须 invoke 本 skill。不读 SOP 直接写 = 违反 SOP = 不发布。"
---

# SEO Blog SOP — 通用 SEO 博客工作流程

> 这是 HornTech 账号级博客 SOP。NZ 服务行业和全球 SaaS 都用这一份，差异部分见末尾两个 SECTION。
>
> 核心原则：写博客前必须先 Roll 风格、查重、确认骨架；标骨架不执行 = 违反 SOP。

---

## 〇、写作前启动 checklist（每篇必做）

invoke 本 skill 后，立刻按下面顺序执行，不能跳：

1. **确认语境**：是 SECTION A（NZ/AU 服务行业）还是 SECTION B（全球 SaaS / WebForger 类）？两者风格库、骨架、内链、本地化要求不同。
2. **拉序号**：本站已发博客数 N，本篇序号 = N+1（用于骨架轮换）。
3. **Roll 风格组合**（见〇.一）：6 个维度全 roll 完，写文件头注释。
4. **查站内最近 3 篇同类博客**：跑结构指纹对比（〇.三），匹配度 > 60% 必须改写。
5. **确认 intent 唯一**：同 intent 已有文章 → 合并/扩写，不新开。
6. **确定内链目标**：1 主（服务页 / alternatives 主页 / pricing）+ 1 次（相关博客）。
7. **写完后跑 13 条质量红线**（见〇.四），任一触发 = 不发布。

---

## 〇.一、Style Roll（每篇必须先 Roll）

每篇文章写之前，先确定本篇的风格组合。**禁止连续两篇用同一骨架。**

### 维度 A：文章骨架（按序号轮换，5 篇一周期）

按 `(序号 % 5) + 1` 确定骨架编号。如果与关键词 intent 严重不匹配，可以跳到下一个，但必须在文件头注释说明原因。

- **1 — Cost Breakdown / Pricing Math**：价格表开头，逐项比较（"xxx cost" / "TCO comparison"）
- **2 — Checklist / Step-by-Step**：编号步骤，行动导向（"how to xxx"）
- **3 — Comparison / Versus**：正反对比，帮读者选（"A vs B" / "alternatives to X"）
- **4 — Story Lead / Case Study**：用真实场景开头，再展开（情感/痛点 / customer journey）
- **5 — Q&A 驱动 / People-Also-Ask**：整篇围绕问题展开，不用传统 H2 结构（信息类长尾）

### 维度 B：语气（权重随机）
- Friendly 50%：像朋友给建议，口语化，偶尔用问句
- Expert 30%：权威行业老手，用数据和经验说话
- Direct 20%：干巴巴只说数据和结论，零废话

### 维度 C：开头方式（权重随机）
- 数据炸弹 30%：`"$15,000–$40,000. That's what Auckland homeowners paid..."`
- 痛点场景 30%：`"Your bathroom tiles are cracking, the grout is mouldy..."`
- 反常识 20%：`"Most homeowners overpay by 30% on their roof replacement..."`
- 直接回答 20%：`"A full bathroom renovation in NZ costs $20,000–$45,000 in 2026."`

### 维度 D：CTA 风格（权重随机）
- 紧迫型 30%："Get your free quote before winter hits"
- 价值型 40%："See how much you could save, free assessment"
- 软着陆 30%："Have questions? We're here to help"

### 维度 E：标题风格（权重随机）
- 利益导向 40%："Save Thousands on Your Roof Replacement (2026 NZ Guide)"
- 问题导向 30%："How Much Does a Bathroom Renovation Cost in NZ?"
- 结果导向 30%："Bathroom Renovation Cost NZ 2026: Real Prices from $15K–$45K"

### 维度 F：段落密度（权重随机）
- 轻快型 50%：短段（2-3 句）+ 多列表/表格，扫读友好
- 中等型 50%：中段（4-5 句）+ 少列表，阅读感更强

### 冲突排除表（Roll 到了必须重新选）
- Q&A 驱动 + Direct → 会变客服单句问答，太干
- Story Lead + Direct → 故事需要语气，Direct 会割裂叙事

### Roll 流程
1. 查文章序号 → 确定骨架（轮换）
2. 用 `echo $((RANDOM % 100))` 或心理随机 roll 其他 5 个维度
3. 检查冲突排除表
4. 在文件头注释记录本篇组合：

```html
<!-- Style Roll: 骨架=Cost Breakdown | 语气=Friendly | 开头=痛点场景 | CTA=价值型 | 标题=问题导向 | 密度=轻快 -->
```

---

## 〇.二、骨架执行规范（硬性约束，Roll 了就必须做到）

**标注骨架但不执行 = 违反 SOP = 不发布。**

### 1 — Cost Breakdown / Pricing Math
- 必须有 2+ 表格（价格对比 / TCO 对比）
- UL 列表不超过 3 个
- 第一个 H2 后 200 字内必须出现价格数据
- H2 标题偏功能性（"What It Costs" / "Price Comparison" / "5-year TCO"）
- 禁止叙事开头超过 100 字

### 2 — Checklist / Step-by-Step
- H2 必须带编号（"Step 1:" / "1."）或全部用 ordered list
- 禁止表格（数据放进步骤描述里）
- 每个步骤必须有明确的 action item
- 至少 5 个步骤
- H2 标题必须是动词开头或编号开头

### 3 — Comparison / Versus
- 必须有至少 1 个正反对比结构（双列表、对比表、或 pros/cons）
- H2 标题必须体现对比（"A vs B" / "Option A" then "Option B"）
- 禁止单方面推销，必须给出两面信息
- 结尾必须有明确的 "哪种适合你" 决策框架

### 4 — Story Lead / Case Study
- **前 300 字必须是纯叙事**：有人物、有冲突、有转折，不能出现价格/数字/列表
- 禁止表格（数据通过叙事段落传递）
- UL 列表不超过 2 个（全篇）
- 至少 1 个 blockquote 做重点强调
- H2 标题偏叙事性（"The Cafe That..." / "Why It Failed" / "What Happened Next"）
- 信息通过故事推导，不是直接罗列

### 5 — Q&A 驱动 / PAA
- 所有 H2 必须是问句
- 禁止传统的 "Overview" / "Summary" 类 H2
- 每个 H2（问题）下面直接回答，不要再分 H3 子结构
- 问题顺序按用户搜索旅程排列（认知 → 对比 → 决策 → 行动）
- 可以用表格和列表，但必须嵌在回答逻辑里

---

## 〇.三、去重检查（发布前必须执行）

每篇文章发布前，对比站内最近 3 篇同类博客。

### 结构指纹对比
检查以下指标，如果与最近 3 篇中任意一篇有 3+ 项相同，必须调整：
- 视觉元素组合（table+UL / blockquote+narrative / numbered steps / pros-cons）
- 开头模式（场景代入 / 数据开头 / 问题开头 / 直接回答）
- H2 数量和命名风格（功能性 vs 叙事性 vs 问句）
- 段落密度（短段+列表密集 vs 长段叙事）
- CTA 位置和措辞

### 自动检查（手动跑）
```
1. 当前文章的 table 数 / UL 数 / blockquote 数 / img 数
2. 最近 3 篇的相同指标
3. 如果 pattern 匹配度 > 60%，标红要求改写
```

### 开头 50 字去重
把当前文章和最近 3 篇的开头 50 字放在一起读。如果读起来像同一个人用同一个模板写的，重写开头。

---

## 〇.四、质量红线（任何一条触发 = 不发布）

1. 关键词蚕食已有文章
2. 没有 CTA
3. 没有内链
4. 低于 1200 字（SaaS landing 拉到 2500+）
5. 没有配图（正文 ≥ 3 张 + Featured Image 单独设置）
6. FAQ 没有 FAQPage schema markup（JSON-LD，直接 `<script type="application/ld+json">…</script>` 嵌在 body 末尾即可，单行多行都可）
7. 没有 Article schema（每篇必须 Article + FAQPage 两个 schema；Article schema 由 WebForger site-worker 自动注入 BlogPosting，不用手写）
8. 标题不含目标关键词
9. 没有 Style Roll 注释
10. 连续两篇骨架相同
11. 触发冲突排除表的组合
12. **骨架标注与实际内容不匹配**（标 Story Lead 但没叙事开头）
13. **与最近 3 篇结构指纹匹配度 > 60%**

---

## 一、写作硬规则（通用，两个 SECTION 都适用）

- 至少 1500 字（SaaS landing 2500+），上限 3000 字（cornerstone 5000）
- 有具体数据：价格 / 时间线 / Lighthouse 分数 / 转化率
- 不要 AI 废话：删 "In this article" / "Let's dive in" / "In conclusion"
- 每 300-400 字插一个 H2 或 H3
- CTA 至少 2 个（顶部 + 底部），指向主转化页
- 内链：最多 2 主 + 1 次
- FAQ 3-5 个问题，每个回答 2-3 句
- 外链 1 个权威来源（gov / industry body / 主流媒体）
- 每个 H2 结尾带 3 条 bullet takeaway（**仅限 Cost Breakdown 和 Checklist 骨架**）
- H2 顺序按漏斗逻辑：定义 → 为什么重要 → 怎么做/选 → 行动 CTA
- Case study 必须具体：客户类型、行业、起始数据、结果数字
- 开篇结构：先价值/痛点，再展开
- **严格执行骨架规范**，标了什么骨架就必须写成什么样

### 禁止事项
- 不要写 meta 信息在正文里
- 不要一篇文章打多个主 intent
- 不要用 "click here" 做 anchor text
- 不要写空泛内容
- 不要重复已有文章的 intent
- 不要连续两篇用同一骨架
- 不要忽略冲突排除表
- **博客正文和 SEO report 里不允许出现 emoji 和 em/en dash**
- **不要标注骨架后写成另一种骨架**

---

## 二、配图 SOP（FLUX AI 生成）

每篇需要：
- 封面图（Hero）1 张
- 正文辅助图至少 3 张

**Featured Image 规则**：首图必须设置为 Featured Image，设置后从正文移除避免重复显示。**生成正文图前必须记下 Hero 文件名，PATCH body 前 grep 确认正文 `<img src>` 不含 Hero 文件名**，防止文件复用。

### Prompt 必须对应具体 H2 / 段落主题

每张正文图都要绑定一个具体的 H2 或段落主题，prompt 描述该主题对应的具体场景或物件。**禁止**抽象隐喻 / "representing X" / "conceptual" 类 stock-photo 套路（如用 price tags 代表成本、用 doors 代表选择、用 paper airplane 代表轻量）。

写 prompt 前先列出本篇 H2 → 对应图主题的映射表，prompt 描述场景里实际能看到的东西，不是它"象征"什么。

### Prompt 模板
```
Professional photograph of [对应 H2 主题的具体场景 / 物件 / 动作],
[SECTION-specific context],
natural daylight, clean composition, editorial style,
no text overlay, no watermark, realistic, high quality
```
（SECTION A 加 "in a modern New Zealand home"；SECTION B 不加额外限定，按主题选实际场景）

### 图片规范
- 重命名为语义化文件名（含主题关键词，便于 hero 去重 grep）
- Alt text 必须包含关键词变体 + 描述图里实际内容（不是它代表什么）
- 压缩到 200KB 以下
- 不要带文字/水印的图、明显 AI 感的图、风格不一致的图、抽象隐喻图

---

## 三、发布流程

1. 完成自审 checklist（intent / 蚕食检查 / 内链 / CTA / 内容质量 / 技术 SEO / Style Roll / 骨架执行检查 / 去重检查）
2. 生成配图（封面 + 至少 3 张正文图）
3. 构建并部署
4. 发布后：GSC 提交索引 → 从 pillar page 补内链 → 更新 draft_log → 频道发汇总

### WebForger 渲染管线注意（2026-05-06 更新）

WebForger 把 blog body 当 markdown 渲染。raw HTML（含 `<script>/<style>/<pre>`）**现在可以放心多行嵌**，框架已在渲染前用占位符屏蔽这些块、过完 markdown 正则再还原 + 剥掉外层 `<p>`。早先版本曾把多行 `<script>` JSON-LD 按行包 `<p>` 导致 schema 失效，已修复。

实操要点：
- FAQPage JSON-LD 直接 `<script type="application/ld+json">{...}</script>` 写在 body 末尾即可，pretty/minified 都行
- Article (BlogPosting) + BreadcrumbList schema 由 site-worker 自动注入 `<head>`，不用在 body 写
- 部署后用 `curl + python3 json.loads` 抽 `<script type="application/ld+json">` 全部能 parse 即过

---

## SECTION A — NZ/AU 服务行业（QK / Apollo / 装修建筑类）

适用站点：服务型企业，本地市场，目标用户在 AU/NZ。

### 数据要求
- 价格用本地货币（NZD/AUD），范围而非单值
- 时间线用周/月数（"4-6 weeks"）
- 引用 NZ Building Code / BRANZ / Master Builders / NZGBC 等本地权威

### 本地化要求
- 至少 1 处提具体城市（Auckland / Wellington / Christchurch 或 Sydney / Melbourne / Brisbane）
- 提本地材料品牌或法规（Resene / Colorsteel / NZ Standards）
- 鼓励博客之间在不同段落带其他城市，做地理覆盖

### 内链结构
- 主：1 个服务页（/services/bathroom-renovation/ 类）
- 次：1 个相关博客
- CTA 指向：/contact/ 或 /quote/

### 案例数据
- 客户类型：Auckland family of 4 / Wellington couple / Christchurch retiree
- 行业起始数据：original quote / pain point
- 结果数字：实际成本 / 工期 / ROI

### 骨架推荐分布
- Cost Breakdown 多用（"xxx cost nz" 长尾词丰富）
- Story Lead 间隔出现（避免疲劳）
- Q&A 用于 PAA 信息词

---

## SECTION B — 全球 SaaS / WebForger 类

适用站点：webforger.ai 自营落地页 + 博客；其他 SaaS 客户。

### 数据要求
- 价格用 USD primary，括号注本地货币（NZD/AUD/GBP/EUR）
- 性能用 Lighthouse 分数 / Core Web Vitals / TTFB ms
- 引用 Wix / Squarespace / WordPress / Shopify 公开数据 + Google CrUX / BuiltWith 趋势

### 全球化要求
- **不做城市本地化**（与 SECTION A 相反），地理粒度按"region"（EN/EU/APAC）
- 案例可以是 NZ/AU 真实站（apollo / bym / horntech-nz）作 proof，但叙事框架要"我们在全球部署的 N 个站之一"
- noindex AU/NZ regional pages（不抢全球 SEO）

### 骨架追加（SECTION B 专用）
- **6 — Alternative Landing**：`/alternatives/{competitor}/` 主页面，3000 字 + 对照表 + case study + FAQ schema + apply form。攻击点：TCO / 性能 / 不锁站 / AI 全栈
- **7 — Programmatic Comparison**：`{tool-A}-vs-{tool-B}` 系列，按 cluster 批量产，结构高度模板化，覆盖长尾比较词
- **8 — Pillar + Cluster**：1 篇 cornerstone（5000 字）+ 5-10 篇 cluster post 互链，攻头部宽词

### 内链结构
- 主：/alternatives/ 主页 / /pricing/ / /features/
- 次：相关博客 / case study
- CTA 指向：apply form（/apply/ 或主页 hero CTA），Wizard，free signup

### 案例数据
- 客户类型：solar installer / media company / renovation contractor / e-commerce SMB
- 起始数据：旧站 Lighthouse 分 / 月成本 / 维护小时
- 结果数字：新站 Lighthouse / TTFB / 月成本节省 / 流量提升

### 攻击线（WebForger 专属）
- AI 建站（60K+ head 词）
- Wix 替代（8K，转化最快，资源 70% 投入）
- WordPress 替代（22K，慢热客单高，资源 30%）
- 不做城市 landing，地理流量 < 一篇全球 comparison

### 定价叙事
- 对标 Wix Business $36：Pro $39 同价档，"换 AI 全栈 + Lighthouse 100 + 不锁站"
- Founding offer forever lock（首 50 Pro + 首 5 Master）
- 不要在博客里直接写"我们便宜"，要写"为什么这个价格能做到"

### Schema 要求
- Article + FAQPage 必备
- Alternative landing 加 SoftwareApplication schema
- Comparison 加 ItemList schema
- Cornerstone 加 Organization + BreadcrumbList

---

## 四、跨 agent 移植说明（给 Galileo / 其他 agent 复用）

本 skill 完全自包含，不依赖 webforge 项目结构。复制到任意 `~/.claude/skills/seo-blog-sop/` 或 `<project>/.claude/skills/seo-blog-sop/` 即可启用。

agent 在以下场景自动 invoke：
- 用户说"写博客 / write a blog post / cornerstone / cluster post / alternatives 页面"
- 用户给关键词要求生成 SEO 内容
- 用户要求改写已有博客提升质量
- 用户要求做 SEO 内容审计（用本 SOP 的 13 条红线作 checklist）

invoke 后立即按"〇、写作前启动 checklist"7 步执行，不能跳。
