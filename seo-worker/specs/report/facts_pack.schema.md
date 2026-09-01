# facts pack 结构（数据层唯一产物，所有数字的来源）

JSON 对象，全部字段由 lib/factspack.js 计算，模型只读。数值一律 number，缺失用 null 并在 `gaps[]` 说明，不估算。

```jsonc
{
  "meta": {
    "client_id": 46, "client_name": "Ben's Curtains AU", "domain": "benscurtains.com.au",
    "slug": "benscurtains", "report_lang": "zh", "biz_type": "leadgen",       // leadgen | ecommerce
    "market": "AU", "platform": "WebForger",
    "period": {"type":"month","start":"2026-08-01","end":"2026-08-31","label":"2026年8月（全月）","partial":false,"through_day":null},
    "compare": {"start":"2026-07-01","end":"2026-07-31","label":"vs 7月（全月）"},
    "generated_at": "2026-09-03T02:10:00Z", "version_hint": 1,
    "leads_source": "GA4 关键事件 form_submit、generate_lead、click_to_call 之和",
    "leads_override": null                                                    // 人工覆盖的询盘总数
  },
  "gsc": {                                                                     // 本期与对比期，query 与 page 维度现拉
    "cur": {"clicks":0,"impressions":0,"ctr":0.0,"position":0.0},
    "prev": {"clicks":0,"impressions":0,"ctr":0.0,"position":0.0},
    "delta": {"clicks":0,"impressions":0,"ctr_pp":0.0,"position":0.0},          // position 负数 = 提升
    "brand": {"cur_clicks":0,"prev_clicks":0,"share_cur":0.0},                  // 按 profile.brand_regex
    "top_queries": [{"query":"","clicks":0,"impressions":0,"position":0.0,"prev_position":null}],   // 前 20
    "zero_exposure_pages": ["/locations/toorak/"]                              // sitemap 有、本期零曝光
  },
  "ga4": {
    "organic": {"cur":{"sessions":0,"new_users":0,"leads":0},"prev":{...},"delta":{...}},
    "channels": [{"channel":"Organic Search","sessions":0,"prev_sessions":0,"leads":0,"prev_leads":0,"revenue":null,"prev_revenue":null,"is_organic":true}],
    "channels_total": {"sessions":0,"prev_sessions":0,"leads":0,"prev_leads":0,"revenue":null},
    "funnel": {                                                                 // leadgen 三步 / ecommerce 四步
      "steps": [{"key":"sessions","label":"自然搜索访问","cur":0,"prev":0},{"key":"form_start","label":"开始填写表单","cur":0,"prev":0},{"key":"leads","label":"询盘","cur":0,"prev":0}],
      "rates": [{"from":"sessions","to":"leads","cur":0.0,"prev":0.0}]
    },
    "landing_pages": [{"path":"/","sessions":0,"prev_sessions":null,"delta":null}]   // 自然搜索前 10
  },
  "yoy": {                                                                     // 去年同月对照。月中出报（partial）不做同比、去年两源全零、取数失败时整块为 null，缘由进 gaps
    "period": {"start":"2025-08-01","end":"2025-08-31","label":"2025年8月（全月）","short":"去年8月"},
    "gsc": {"clicks":0,"impressions":0,"ctr":0.0,"position":0.0},               // 去年同月全零时为 null
    "ga4_organic": {"sessions":0,"new_users":0,"leads":0},                      // 去年同月 sessions 为零时为 null
    "delta": {"clicks_pct":0.0,"impressions_pct":0.0,"position":0.0,"sessions_pct":0.0,"new_users_pct":0.0,"leads_pct":0.0}   // 本期 vs 去年同月，position 负数 = 提升
  },
  "rankings": {                                                                // profile.target_keywords 逐词
    "method": "按查询簇曝光加权的 GSC 平均位次，簇 = 归一化后包含该词全部 token 的查询",
    "rows": [{"keyword":"sheer curtains","pos":0.0,"prev_pos":null,"delta":null,"impressions":0,"clicks":0,"is_brand":false,"band":"top10"}],   // band: top10 | p11_20 | p21_plus | none
    "summary": {"total":40,"top10":0,"p11_20":0,"p21_plus":0,"improved":0,"declined":0,"no_exposure":0},
    "summary_prev": {"top10":0,"p11_20":0,"p21_plus":0,"no_exposure":0},        // 同一批词按 prev_pos 分档，排名分布图的对照列
    "near_page1": [{"keyword":"","pos":0.0}],                                  // pos 10 至 15
    "declined_with_volume": [{"keyword":"","pos":0.0,"prev_pos":0.0,"impressions":0}]
  },
  "trend": {"months":["2025-08","..."],"gsc_clicks":[0],"ga4_sessions_organic":[0],"last_partial":false},   // 13 个月，来自 GET /metrics
  "work": {                                                                    // 本期工作量，来自 done 任务 + 大事记 + 交付物
    "items": [{"date":"2026-08-12","kind":"apply","category":"onpage","title_raw":"made-to-measure 页精校","detail_raw":"...","source":"task:61"}],
    "counts": {"onpage":0,"content":0,"tech":0,"link":0,"report":0},
    "blogs_published": 0, "pages_optimised": 0
  },
  "next": {                                                                    // 下期计划输入
    "plan_sprint": "S2", "tasks": [{"id":63,"title":"","module":"onpage","detail":""}],
    "open_from_period": [{"id":0,"title":""}]
  },
  "facts_for_prompt": ["biz.model: ...", "content.no_thermal: ..."],           // 已过滤 internal.*，值截 400 字
  "gaps": ["GSC 页面收录状态未拉，pages 表只含有曝光页"],                       // 拉不到的数据，报告里标待更新
  "narrative_inputs": {                                                        // 渲染层给模型的结构化三元组，模型不自己从表里挑
    "kpi_sentence_parts": [{"name":"自然搜索点击","cur":0,"prev":0,"delta_pct":0.0}],
    "ranking_highlights": [{"keyword":"","prev_pos":0.0,"pos":0.0,"delta":0.0,"impressions":0}],
    "ranking_declines": [{"keyword":"","prev_pos":0.0,"pos":0.0,"delta":0.0,"impressions":0}],
    "page_risers": [{"path":"","prev":0,"cur":0}], "page_fallers": [{"path":"","prev":0,"cur":0}]
  }
}
```

## 计算规则

- 环比 delta_pct = (cur - prev) / prev，prev 为 0 时 null；位次 delta = cur - prev（负数是提升，渲染层写「提升 N 位」）。
- 同比（yoy）只对整月报告计算，窗口 = 去年同一个自然月的完整月；月中出报沿用「只同窗环比、不做同比」的既有契约，yoy 为 null。去年同期 GSC 点击曝光全零且 GA4 sessions 为零视为不可比（站点或数据源当时未接入），yoy 置 null 并写进 gaps，绝不拿零基期算出千百个百分点吓客户。
- 目标词位次：查询归一化（小写、去标点、连字符与空格归一），簇 = 包含目标词全部 token 的查询；位次 = Σ(position × impressions) / Σ(impressions)；簇零曝光则 pos=null、band=none，渲染写「本月无曝光」，不写 0。
- 品牌判定用 profile.brand_regex。
- 工作量分类关键词：onpage（title、meta、内链、页面优化、精校、重写、page）、content（博客、文章、选题、blog）、tech（301、sitemap、schema、收录、审计、redirect、索引）、link（外链、backlink、disavow）、report（报告、分析、数据、清单）。done 任务取 result_note 带 [applied] 或 ops 含 publish/apply 类的；大事记取 kind 为 apply/publish/config 的；同分类同主题合并留给模型（pack 保留原始条目）。
- 渠道表：GA4 sessionDefaultChannelGroup，按 sessions 降序；Social、Email、Referral、Unassigned、Display 若各自 sessions 占比低于 5% 合并成「其他」。总数用渠道合计不用 GA4 overall。
- 金额两位小数，ecommerce 才有。
- pack 落盘同时存 `pack_inputs` 摘要（拉数窗口、行数、API 调用次数）方便追溯。
