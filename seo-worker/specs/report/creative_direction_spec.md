# 素材方向卡规格（creative-direction 任务的唯一产出契约）

<!-- CREATIVE-DIRECTION-SPEC-V1：2026-09-01（Alvin 拍板 W12 批 A）。词卡的姊妹卡：
     广告素材（文案与资产）的客户版决策文档。读者优先级：客户老板 > sales > 我们自己。
     与词卡同构：模板 direction_card_template.html、widget、A31 全部继承，出生即模板化，
     模型只产数据 JSON 不写 HTML。 -->

## 形态（模板 + 数据，模型不写 HTML）

产出分两层。**模型只产数据 JSON**，契约见同目录 `creative_direction_data.schema.json`（与词卡槽位同构，语义换成广告与素材），文件名 `creative_direction_{client}_{YYYY-MM}.data.json`。**HTML 由零 LLM 渲染器生成**：`node specs/report/render_creative_direction.js <data.json> > creative_direction_{client}_{YYYY-MM}.html`。周期用年月不用 S 号：素材卡每月一张（词卡每 sprint），素材判断要更长数据窗。单页 HTML，手机可读，一月一版只增不改。

## 五条立场（写死，渲染器强制其中两条）

1. **判断主轴是广告级询价与花费**。素材级指标因共同归因（一次转化给广告内每条素材记全额）只作方向信号，禁止加总素材转化、禁止算素材级单条询价成本（渲染器拒绝）。
2. **Ad Strength 类评级不进客户报告**（Adalysis 百万广告样本与 CTR/转化率零相关；Optmyzr 两万账户 Excellent 的单条成本反而差 2.3 倍），只做内部建卡检查（渲染器拒绝出现）。
3. **测试评判用询价总数不用转化率**（低量账户立场；Google 按点击率分配组合展示，转化导向必须人工点名优胜组合）。
4. **一 ad group 最多 3 条广告；测特定消息用固定位置（pin）控制组合；一次测一个变量**。中低量 ad group 每条广告 300 至 1000 次展示才够判。
5. **换素材性能触发优先于日历**：零曝光素材 2 到 4 周清理（唯一无争议的自动规则），常青文案季度刷新只是兜底。RSA 的 Low/Good/Best 标签 2025-06 已废，一切「换 Low」类操作作废。

## 语言铁律（与词卡共用）

词卡 spec 的语言铁律整段适用：禁内部术语缩写、每个数字跟半句「这意味着什么」、copy_rules A31 产品词英文原词、通用报告规则（无 emoji 无破折号零内部信息）。广告文案本身是英文资产，原文展示不翻译，说明文字用中文。

## 结构（槽位同词卡，语义如下）

- **第一屏**：一句话素材方向；三个大数字卡：本期广告花费 / 最能带询价的那条广告换来几条（s 行放该广告标题原文）/ 平均一条询价多少钱；红绿灯条按 ad group（g 换新文案或加投、h 保持、a 收缩清理）。
- **第二屏 需要您决定**（最多 5 张，三类）：
  1. **新文案措辞确认**：一张卡一个 ad group 批次（plan_experience：素材与 copy 类任务一任务一个 ad group）。situation 放现行文案与成绩，recommendation 放**新文案全文逐条**（文案是品牌声音，客户点头才上线）；若客户已确认 messaging 框架（fact `ads.creative.framework`），框架内变体写明「按已确认框架，默认执行」，出框新主张才要显式同意。
  2. **零曝光素材清理**：picks 勾选名单，每条带素材原文与零曝光时长，默认清（立场 5）。
  3. **测试方案**：测什么消息、控制哪个变量、多久看结果（立场 3、4）。
- **第三屏 每条广告的成绩单**：一条在投广告一张小卡，三行定式：花了多少 / 换来什么（询价按 fact `ads.google.conversion_scope` 口径）/ 接下来怎么做；依据折叠（窗口、展示点击、素材级方向信号带共同归因说明）。
- **尾部**：素材清理人话总结；新发现最多 3 条；上期确认记录（首版写「首版，无上期结论」）；名词解释五行内。

## 数据与口径

- 数据只来自 ads 快照与 GAQL 只读拉数：广告级 `ad_group_ad`（含转化按 conversion_action 分拆到口径内动作）、素材级 `ad_group_ad_asset_view`（方向信号）、PMax 到 `asset_group` 级（素材级评级字段 API 已无）。
- 转化口径按 fact `ads.google.conversion_scope`；Ad Strength 仅内部参考。
- 每个数字可追溯（窗口、来源），追溯进折叠层。

## 闭环规则（与词卡同）

- 反馈走卡上 widget（模板固定，token 从 URL t/k 读）落 `seo_card_feedback` 加任务 note；蒸馏落 facts 前缀 `ads.creative_direction.`，确认结论 `ads.creative_direction.confirmed_{YYYY-MM}`。
- 客户 agree 新文案 → ad-copy-rewrite prepare 任务（risk_class external 走放行）→ apply 改户回读；零曝光清理同路。
- 下一期素材卡、月报 paid 章引用上期确认结论。

## Onboard 素材确认（新客户首次接入 paid）

批 0 六样外加三样，收法是「我们起草、客户确认」，用同一套卡 widget 发出：
7. Messaging 框架：可说与禁说主张、必须出现的卖点、口吻、合规红线 → fact `ads.creative.framework`
8. 品牌写法与素材授权：品牌名精确写法、tagline、logo 图库来源与授权边界、禁提竞对 → facts `ads.creative.brand_style` / `ads.creative.asset_sources`
9. 促销现状与日历：在跑活动、折扣措辞授权条件、活动清理责任 → fact `ads.creative.promo_state`
素材卡生成器、ad-copy-rewrite、闸A 同源读这四个 fact 键。框架内变体 L0 自动放行，出框上决策卡，onboard 时向客户写明此规则。存量客户不补课，随下一张素材卡迁移。
