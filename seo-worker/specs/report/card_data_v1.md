# card_data v1：卡产线统一数据契约

版本标记：CARD-DATA-V1（2026-10-19 定稿，Aira 产线侧；桥侧对口文件 /mnt/share/aiden/to-aira-confirmation-architecture-20261019.md 及其回条）

## 主轴（一句话）

卡产线输出一份规范化 card data（data.json），它同时是 Ask 的登记源和两种渲染（agencyreport HTML 卡页、WF 原生 AsksPanel）的唯一输入；两路答案落同一本账（seo_card_feedback），折叠只认归一后的口径。

四条推论，违反任何一条都是走回头路：

1. 题（item_id、题型、选项码）只在 data.json 里定义一次。HTML 卡的 data-item 和 Ask 的 item_id 必须出自同一个字段，agent 不写 HTML 就不可能在 HTML 里另起题（render_confirmation.js 是这条的结构性保证）。
2. 内容（situation、recommendation、表格、词表）也只在 data.json 里定义一次。HTML 把它铺开排版，WF 把它收进可折叠块，两边看的是同一段字，所以 blocks 与 items 全部纯文本，不收 HTML 标签。
3. 答案账本不动结构。要收的是码的口径（见选项码一节）和 item 的对齐（同源后天然对齐）。
4. 退役 HTML 的代价 = 删一个渲染器加改一处送达链接。任何题、任何客户作答要依据的事实不得只放在 html_extra，这条守住代价才是常数。

## 文件名与落位

`<card_kind>_<客户 slug>_<YYYY-MM>.data.json`，落工作区 `reports/`，渲染产物同名 `.html`。askreg 现有的 6 小时新鲜度扫描不变。YYYY-MM 必须等于 `issued`。

## 字段口径（machine 契约在 card_data_v1.schema.json，这里是裁决记录）

- `service`：seo | sem | null，产线必填。映射兜底表（askreg 侧，产线缺写时用）：keyword_direction、creative_direction 为 sem；keyword_confirmation、mapping_confirmation、blog_confirmation、onsite_confirm 为 seo；混合方案卡 null。新 card_kind 不用改桥，产线写对 service 即可，但 PHP 侧 card_kind_of 的 ops 映射要同步登记，否则任务层 card_kind 为 NULL 根本走不到出卡登记（blog_confirmation 的教训）。
- `kind`：direction | confirmation。决定 WF 标签与 default_policy 的兜底值。
- `cycle`：onboard | monthly | adhoc。只做标注和审计，桥不按它分支，触发逻辑（谁出卡、何时出卡）永远不进本文件。
- `default_policy`：**产线必填，按卡类写，schema 缺省即拒**（v1 修订 2，2026-10-19）。不写成「confirmation 一律 none」是因为 2026-10-15 闸第一性改版把 page-create 族降成了 14 天视同同意的软闸，一刀切会把它退回去。基线：词表卡、mapping 卡、博客卡 none（博客发布凭证必须是客户点的 publish_blog=agree，runBlogPublish 硬闸不变）；onsite / page-create 族软闸卡 no_reply_follow_recommendation。kind 兜底只存在于 askreg 对旧数据的适配层（confirmation 兜 none，direction 兜 no_reply_follow_recommendation）。题面「到期未回复」那句由渲染层按本字段生成，数据与模型都不写到期文案。
- `items[].type`：single | multi | text，与 Ask 题型一一对应。卡类不再使用 approve 题型，approve 只留给 plan_approval（它不经 cardfold）。v1 的 text 题只允许 global_note。
- `blocks`：para | list | table | kv 四种，纯文本；表格上限 8 列 60 行。被 items[].block_refs 引用的块挂题下渲染，未被引用的是卡级块。登记时进 lang_pack.texts.<lang>.blocks，受 256KB 上限约束，产出侧整包压 192KB 留余量（渲染器强制）。
- `html_extra`：只给 HTML 渲染层的版式性内容。v1 只开 scope_line 与 fineprint 两个键（渲染器对未知键直接拒，扩键先改本文件），fineprint 允许 <b>/<i>。

## 选项码（v1 修订 1，2026-10-19，这条不落实 v1 等于白定）

服务端两道既有护栏决定了码的形状：`asks_code_ok` 是 `^[A-Za-z0-9_.:-]{1,120}$`（不收空格、不收中文），single/approve 的码另受 `seo_card_feedback.choice VARCHAR(16)` 列宽限制。词条原文（几乎全带空格，中文客户全中文）当选项码在登记侧必 422。所以：

- **options 一律 `{code, label}` 结构**。code 是机器短码，统一压 `[a-z0-9_.:-]{1,16}`（single 与 multi 一个规矩，不分题型记两套）；label 是展示文案，词条原文放 label。
- **两个通道落账的都是 code**：HTML 勾选控件的 checkbox 带 code，保存时 POST 的 text 是逗号拼接的 code 串；WF 答题经 asks_validate_answers 校验的也是 code。data.json 是 code 到 label 的唯一解码表，折叠层和下游引用上期结论时拿 data.json 还原词面。
- single 的码固定按序 agree / hold / other（与现网 HTML 约定和 cardfold 一致），label 可按卡语境改（博客卡的「同意，安排发布」就是 agree 的 label）。
- multi 的码起名优先可读 slug（如 t1 不如 gutter_clean，放不下再用 t1/t2 位置码），审计看账本行时尽量不用翻解码表。

## 与账本、折叠的关系

写入处不归一：账本存客户实际点的码，审计要原样。折叠处的防御性映射（approve 视同 agree、reject 视同 hold 且理由进 texts、未识别码进 texts 打 attention、「hasAny 但无表态」不许静默收口）只落桥侧 cardfold.js（决策层），归 Aiden。PHP asks_fold_effective 是 WF 展示与 Ask 状态层，不做码映射（plan_approval 的面板必须原样显示 approve/reject），两边同步的是排序口径（作答时刻优先，同刻按入账 id），不是码映射。（2026-10-19 与 Aiden 对齐，取代本句旧版「两处同步落映射」。）

## 兼容与迁移

- 方向卡（keyword_direction / creative_direction）现有 `decisions[] / negatives` 形态不强改，askreg 加适配函数转成 items[]。迁移定落日不长期双轨：2026-11 的卡照旧出现形态，2026-12 的卡起方向卡产线出 v1，适配函数保留到 2027-01 兜底后删。
- blog_confirmation 与 onsite_confirm 的 cardData 已是代码内拼的结构化对象，是最便宜的迁入对象，排确认卡之后第一批：产出改挂 v1 信封（items 定义照旧语义，publish_blog 等 item_id 不变），card_kind_of 补 ops 映射。
- 确认卡（keyword_confirmation / mapping_confirmation 及一次过合卡）自本版起只产 data.json，产线规格见 confirmation_card_spec.md。
