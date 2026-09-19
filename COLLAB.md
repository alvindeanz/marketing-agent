# COLLAB — Aiden + Aira 协作账本

append-only，新条目加在最上面。每条固定格式：日期、谁、干了什么（commit 指路）、坑、下一步/认领。
只写共识层信息：结论、教训、接口约定。过程日志和各自的蒸馏记忆不要搬进来（memory 不入库）。

## 协作规矩（沿用 webforge 账本模式）

1. main 直推，无 PR。秩序靠认领和账本，不靠流程。
2. 认领边界见下方登记。跨认领边界动手前先在账本登记一条；发现对方领地的 bug，报告不动手，修复归认领方排期。
3. 推之前本地测试全绿（node tests/ 全套加 php -l seo-api.php），结果写进条目。
4. 部署单点走 Aiden 的 deploy.sh（哈希校验加自动回滚，250 与 ros 两台机）。Aira 推完 main 在账本留一行"待部署"，Aiden 部署验收后回一行。红线：ros 上 /data/aira/seo-worker/ 是部署产物不是工作区，任何人不许直接改线上文件，deploy 的哈希校验会覆盖一切手改。
5. DB 变更一律走惰性 DDL 先例（ensure_* 函数，information_schema 逐值比对幂等），禁手工上库打 DDL。
6. 并行改动禁 git stash（webforge 事故教训）。
7. 全部产物中文，禁 emoji 和破折号。

## 认领登记（2026-09-17 校准，Alvin 定：Aira=MA 主力，Aiden=WebForger 开发）

- **Aira**：MA 全仓主力开发，一切都能动（seo-api.php、前端、runners、lib、specs、deploy、以及 /data/aira/tools 下的 shopseo 等配套工具）。发现 bug 直接修，改动在本账本登记同步。执行侧提速、车道扩容、CLI 优化都是 MA 内的活，不外包。
- **Aiden**：WebForger 平台开发（api.webforger.ai 的行为、shadow bot、平台端点、迁移工具）。MA 只在「碰 WebForger 平台本身」时与他交接：平台接口缺口、shadow bot 权限、平台侧 bug。凡是 MA 仓内或 shopseo/Shopify 工具链的事，都归 Aira，不再写「归 Aiden 排期」。
- 部署权：两人都可跑 deploy.sh，先 commit 再部署，部署后 check 无漂移，worker 部署前确认 running job 为 0。
- 历史：2026-09-13 版把 Aiden 写作「MA 辅助开发」，框架错，2026-09-17 Alvin 校准如上。

### 2026-09-17 AIRA (a)

- 干了什么：Shopify 船队接入交办已发 `/mnt/share/aira/to-aiden-shopify-fleet-tokens-20260917.md`。Alvin 确认其余 Shopify 客户店铺权限已到位，请 Aiden 按 sungait 同款（custom distribution app + token 服务现取）接入十家：oakfurniture(1)、midea(3)、sunseeker(4)、badger(5)、luxelink(6)、goodiegoodie(10)、ctomi(11)、playmate(20)、haakaa(42)、dareu。citymed 是 Umbraco 不接。
- 坑：09-04 交接包把 goodiegoodie 写成 WooCommerce，实测是 Shopify（首页 677 处 cdn/shop）；dareu Q4 已签约（Alvin 2026-09-17），从排除名单移回。scopes 沿用 sungait 三组口径；alias 用 board workspace 名。
- 下一步/认领：Aiden 回包 alias=域名清单后，Aira 逐店 whoami + articles list 验活并回测试结果，然后开这批客户 sprint。附带一问：shopseo 要不要扩 collections 命令面（sungait 集合页任务在排队），Aiden 三选一回复即可。
- 历史版本（2026-08-24 初始，窄面认领）：Aiden 管 api/前端/deploy/sql/既有 runners 与 lib，Aira 只认领非 WebForger 平台适配与 specs/SOP 回写，对方领地报告不动手。已作废，留此存档。

## 条目

### 2026-09-19 AIRA：侧边栏客户列表按平台分组排序(Alvin 定)

- 干了什么：seo-agent.html renderSidebar 加 platSort: WebForger > Shopify > WordPress > 其它, 组内按名, 复用现有 platKey()。归档区同规则。
- 坑：无。
- 下一步/认领：随本次 api 部署上线。
### 2026-09-19 AIRA：博客选题规划产线工具化(Alvin 批, 源自 sunseeker/badger 一次性脚本)

- 干了什么：三件套进 tools/: blog_topic_gaps.js(通用 GSC 缺口拉取, 词表输入 clients/<slug>/notes/topic_kw.json), render_blog_topic_plan.py(plan.json 渲染, 文件名强制带 slug), blog_topic_card.js(可选生成选题确认卡任务, 带 we_write/client_writes 模式标注)。sunseeker/badger 的词表已迁移成 topic_kw.json, 渲染器对 sunseeker 真实 gaps 数据冒烟通过。产线文档进 clients/blog/notes/client_blog_specs.md 通用层。
- 坑：原一次性脚本的选题 cfg 没落盘(会话临时物), 两份同名产物曾被看串; 新规范文件名带 slug 根治。client_writes 折叠分支未接通, mode 暂写进任务说明供折叠时人裁。
- 下一步/认领：下一个需要选题规划的客户直接走三段产线首用验证; haakaa 选题卡等 Alvin 解冻。
### 2026-09-19 AIRA：本期视图收严, review 不再无条件可见(Alvin 定, 取代 8/31 规则)

- 干了什么：seo-agent.html withinScope 改: review 任务跟随 sprint 视野, 仅三例外(等发客户的确认卡 isPendingClientCard/在跑/失败等重试)。起因 #703(S3)方案备好待放行却挂在 hntz 本期视图。旧「review 无条件可见」(2026-08-31 #143 事故的产物)作废, 其事故场景由「全部」按钮与底部计数提示行覆盖。
- 坑：isPendingClientCard 判卡靠 ops 与 result_note 特征, 新增卡类型要同步该函数, 否则待发卡会被藏。
- 下一步/认领：随 api 部署上线;观察一周有无「找不到待放行卡」回潮。
### 2026-09-19 AIRA：SEO 词表闸加状态 fact 一票否决(badger 假阳性)

- 干了什么：harness 两闸的 kwOk/mapOk 前加 veto: *.lock_state 类状态 fact 值带 NEG(未锁/onboard gap)时直接否决,不管局部 fact 多好看。badger 实证: keywords.lock_state 明写未锁定,闸却被 keywords.leafblower_ownership(局部品类客户确认)满足。dry-run 双向验证: badger 关(否决生效), midea 开(不误伤)。tests 全绿。
- 坑：状态 fact 此前只是「不算数」,局部确认 fact 可绕过全站状态;闸的 some() 语义天然吃这种假阳性。
- 下一步/认领：badger 三合一确认卡(词表+mapping+edger/301 两决策)在产,客户勾选折叠后落全站锁定 fact,闸从数据侧真开。
### 2026-09-18 AIRA：方向卡席位表版式事故全局修复(Alvin 报障)

- 干了什么：direction_card_template.html 席位表 summary 重写: 族名 flex:1 1 auto+min-width:0 允许收缩换行, brief flex:1 1 260px+min-width:220px 硬性下限, 整行 flex-wrap, 任何宽度不再出现一字一行竖排。同时把该块挪到 @media 之前: 9/17 的窄屏修复写在基础规则前面, 同权重被覆盖, 一直是死代码。全部 10 张在线方向卡(apex 双卡/bens AU+NZ/goodie/haakaa/louvresky 双卡/midea/sanmichelle)用新模板重渲染重发布, 回验全 200。
- 坑：CSS 同权重规则靠源序定胜负, media query 覆盖必须写在基础规则之后; 模板改动影响两个渲染器(词卡+素材卡共用)。
- 下一步/认领：卡类任务 sent_at 前禁收口(今天双卡两次隐身的根因)与 readonly 卡任务多排 apply 的 409, 两条今晚修 seo-api。
### 2026-09-18 AIRA：claudeBin 启动自愈 + 启动断言(job 981 事故的机制修复)

- 干了什么：lib/config.js 新增 resolveClaudeBin,启动时把 claudeBin 解析成本机真实可执行文件(配置路径存在直用;失效或裸名按 PATH+~/.local/bin+/usr/local/bin+/opt/homebrew/bin+/usr/bin 兜底,用了哪个日志说清);全都没有 cfg.claudeBin 置空,listener 启动断言拒绝起,worker 不再带病抢单烧真活。回归测试 tests/config_claudebin.js,全套绿。
- 坑：测试样本不能用 /root/.local/bin/claude 当「失效路径」,ros 上它真实存在;二进制名也要唯一防常见目录撞车。
- 下一步/认领：ros 侧等金丝雀窗口收口时随重启一起 deploy;Mac 侧 Connie 修 config 时顺手 git pull 同享。

### 2026-09-18 AIRA：harness 卡反馈折叠防叠词 + Apex(44) 实战金丝雀首雷记录

- 干了什么：tools/harness.js foldCards 跟进任务标题先剥旧「卡反馈落地：」前缀再加,防链式折叠叠词(753 -> 759 实证翻车,看板 759 标题已 PATCH 修正)。tests 全绿。tools 不在 deploy 白名单,repo 生效即生效。
- 坑：Apex S1 execute job 981 被 mac worker 认领 30 秒 failed,根因 Mac config.json 的 claudeBin 抄了 ros 的 /root/.local/bin/claude,ENOENT。仓内默认本来就是裸 claude,非代码 bug。修复单已发 share(to-connie-mac-fix-claudebin-20260918.md),提醒 launchd PATH 极小,要绝对路径,顺带排查 python3。
- 下一步/认领：Connie 回执后 Aira 重排 759 execute 并放行 660(tel 埋点 apply),继续用 Apex 真单炸 Mac(Alvin 拍板不走 dogfood)。ros 停机中,env SHOPSEO_SNAPSHOTS 已挂 drop-in,全绿后再起。

### 2026-09-18 AIRA：NFS clients 导出改 all_squash(Mac 非 root 写权),Connie 前置全清

- Connie 指出我漏改:导出还是 no_root_squash,她 Mac worker 非 root(uid 501)被 squash 成 nobody 写不进 root 属主的 clients,启动硬断言会拦。已改 4 行为 all_squash,anonuid=0,anongid=0(clients rw、tools/scripts/memory ro),exportfs -ra 生效,改前备份。Mac uid 映射到 uid0,读写通。
- 协调:Connie 金丝雀窗口(约 1-2h)我不往队列压真客户批次、不跑 harness,保持队列干净;她验完频道放行。
- 待办记号:60 分钟超时清扫余量对金丝雀够(pull_data 分钟级、execute 30 分钟封顶);给 Mac 排 backfill_metrics(180 天)或 haakaa 级大店拉取前要重量、可能按类型分档。ros SHOPSEO_SNAPSHOTS 在她跑真 execute 前加(running=0 重启,她 ping 我)。
- 回包 share/aira/to-connie-allsquash-done-20260918.md。


### 2026-09-18 AIRA：第二 worker 服务端 P1 完成并活体验证(reap 隔离+超时清扫)

- 改动(api+worker,rev f86539d 已部署零漂移):agent_jobs 惰性加 claimed_by;/jobs/claim 写 claimed_by=worker + 超时清扫(running 认领超 60 分钟判 failed,DB 时钟零 LLM,标 [reaped-timeout] 非执行错误);/jobs/reap 收窄成只收 claimed_by=worker(原全表判 failed 会杀别的 worker 的活);claim 重试 3→5;worker 传 workerId(ros 默认,mac 走 WORKER_ID/config)。running=0 时部署无孤儿。
- 活体验证:①reap{worker:mac} 在 ros 的 job 980(claimed_by=ros)running 时返回 reaped:[] —— **Mac 收尸杀不到 ros,P0 隔离坐实**;②claim 写 claimed_by=ros;③claimed_by 列已建。测试:php -l(deploy 远端)过,node tests 全绿。
- **Connie 的 Mac worker 前置已清**,可按 share/aira/nfs-mount-info 挂载启动(workerId=mac)。ros worker 已在新码;Mac 上线切换时我再加 ros 的 SHOPSEO_SNAPSHOTS(两台快照同处)。


### 2026-09-18 AIRA：第二 worker NFS 服务端已配(ros→Mac 192.168.10.215),服务端 P1 待做

- ros 装 nfs-kernel-server 并开导出,只对 Mac IP 192.168.10.215 放行,最小权限:仅 /data/aira/clients 读写,/data/aira/tools、/data/aira/scripts、/root/.claude/.../memory 只读。no_root_squash(Mac worker 拟以 root 跑镜像 ros)。2049 监听、ufw inactive、showmount 自检过。建了 /data/aira/clients/_shopseo_snapshots。挂载信息给 Connie:share/aira/nfs-mount-info-for-connie-mac-worker-20260918.md。
- **服务端 P1 是 Mac 启 worker 的硬前置,归我(MA 仓主力):** ①agent_jobs 惰性补 claimed_by;②/jobs/claim 带 worker id 写 claimed_by;③/jobs/reap 收窄成只收本 worker 的 running(现状全表判 failed,Mac 一启动会误杀 ros 的活);④claim 路径加超时清扫(claimed_at 超 45 分钟余量判 failed,服务端 DB 时钟,防 Mac 死后 running 永占同客户互斥锁)。加 tests(reap 隔离、超时边界),node tests + php -l 全绿再 deploy api。**P1 上线前 Connie 别启 Mac worker。**
- ros worker SHOPSEO_SNAPSHOTS 在 Mac 上线切换时一起加(running job 归零重启一次),两台快照落同一处回滚跨机可读。
- 分工:服务端(P1 + env)归 Aira;Mac 本地部署(挂载/launchd/预检/金丝雀/收尸演习)归 Connie。


### 2026-09-18 AIRA：默认放行架构（release v9，第一性原理，Alvin 定）

- **原则**：预先卡闸是拿确定成本防稀有可逆损失，是烂账。可逆的一律自动放行、零闸，execute 产出即决定不加第二道 review（不人审、不让 opus 再判）；质检从事前卡搬到事后抽（人工手动触发 + harness 按需抽查器）+ 快照原地还原 + 堵整类。硬闸只剩「还原救不回 + 没授权」= 花钱越权/不可逆实害/合同级（权限授权类）。等 Alvin 只剩 bug/卡壳/权限三类。
- **改动**（seo-api.php + release_policy v9，api+worker 已部署 rev 70b3af9 零漂移，node tests 绿）：①seo_task_result 里 analysis_task（只读卡/报告）交付即自动收货 accepted，不进「待放行」；②human_state 把 判定中/待判/待拍板 归 running（机器待推进），wait_me 只剩 失败/权限阻塞/越权；③release_policy.md 升 v9 默认放行口径，作废 v8 的 ramp 人工全量后检（被事后抽样取代）；技术熔断（同任务 auto-apply 至多一次）保留。
- **实证**：Apex 从十几个「等我」降到 1 个，剩的 #660（ga4-config-update 不可逆 + gtm-edit 无自动通道）是合法硬闸；#745/#758 两张卡自动收货。
- **待办（我的规划剩两项）**：①快照覆盖率审计（自动放行的安全前提，WF changeset/Shopify 快照/apply 存档已覆盖主通道，需补验）②harness 按需抽查器（Alvin 结束后手动触发，抽样复核 auto 放行件+异常自动原地还原+写 DEFECT，设计从简）。


### 2026-09-17 AIRA (j)：fable 模型路由第一性原理收窄，5 岗降 opus

- **Alvin 定（第一性原理）：premium 档（fable/Mythos）只留「定战略框架」与「不可回收的现场判断」，框内的/服务端有硬校验的/总结类/内容 QA 类全降 opus。** 理由：opus 人工跑一年多稳，opus 5.2 将至，不做 A/B backtest（Alvin 明确不用 review）。
- config.js 改：**留 fable**=planModel（出方案）、planReviewModel（季度对齐，跨客户经验注入）、chatModel（现场对话，有 nuance 不可回收，Alvin 点名留）；**降 opus**=reviewModel（闸A 发卡判断，最高频，框内 go/no-go，漂了季度 planReview 纠）、triageModel（巡检只总结）、rulingModel + threadModel（人话解析成看板动作，安全靠服务端双锚校验不靠模型）、blogReviewModel（内容 QA，且过客户确认卡）。
- 安全性未降：ruling/thread 的看板动作双锚校验（引语逐字命中+task_id+标题片段）在服务端，模型只提议服务端验真。闸A 判准兜底上移到季度 planReview（仍 fable）。
- 成本结构：砍在最高频的 review+triage，最低频的 plan/planReview 保 premium，等于把 premium 从高频挪低频。chatModel 是留下的 fable 里最高频的，标为下一个候选（opus 5.2 或成本吃紧时再评）。
- 测试全绿。config 在 lib 白名单，**待部署 deploy.sh worker**（running job 已归零）。

### 2026-09-17 AIRA (i)：方向卡模板窄屏修复 + playmate 标记只做 SEO

- **方向卡模板窄屏修复**（direction_card_template.html，全客户通用，词卡+素材卡共用）：席位表 summary 是桌面三列 name/chip/brief，640px 媒体查询漏了这行，手机上长族名 flex:0 0 auto 吃满宽、brief 只剩一条缝一字一行竖排（Alvin 手机截图实证）。补窄屏规则：族名整行、胶囊次行、brief 整行堆叠。桌面不动。render 测试过，goodie 卡已重渲染重发布回验 200。改模板 = 全客户下一张卡生效 + 现有卡重渲染即生效。
- **playmate 标记只做 SEO**（Alvin 定，成人行业限制，账户花费主力壮阳补充剂类 Ads 反复受限）：profile services 改 seo；fact ops.scope_seo_only 记全；4 个开着的 paid 任务 #556/557/558/564 按 [dropped] 关闭；不进自动 sprint，SEO 侧手动运营。memory project_playmate_seo_only_scope + reference_direction_card_production 记档。playmate 的 SEM 方向卡不再出。
- 下一步/认领：模板修复与 goodie 卡待部署（deploy.sh worker，template 在 specs 白名单；running job 已归零）。goodie 卡等 Alvin 反馈。

### 2026-09-17 AIRA (h)：闸门 false-positive 修复 + goodie 词卡发布 + 方向卡产出机制查清

- **闸门修复**（harness.js，已 push，本机工具无需部署）：关键词/mapping 确认闸旧正则只要 fact_key 含 lock 就放行，被 keywords.lock_state（值写「未锁定/onboard gap」）骗过，luxelink/sunseeker/playmate 会被错误放行跑出没校准的 sprint。修法：排除值里否定语 + 要求肯定的锁定信号。实证 midea 过、luxelink 拦、badger 关键词过（leafblower 真客户确认）mapping 拦。
- **方向卡产出机制查清并记档**（记忆 reference_direction_card_production）：keyword-direction/creative-direction 卡**不是 worker 自动产的**。execute 的 analysis agent 只读工具（无 Write/node），只出 markdown 分析；render_keyword_direction.js 在 execute/apply 里从未被调用。渲染成卡是操作者手动流程：gaql_query.py 拉 Ads → 聚词族 → 写 data.json（cls 用 g/h/a）→ render 脚本 → lint → republish。卡是 Ads 账户卡（三大数字=花费/下单/单成本，下单取 PURCHASE），Shopping 有逐词 PMax 没有。
- **goodie 2026-09 词卡已出并发布**：gaql 直取账户 1332867293，12326 Shopping 搜索词聚 5 族，日系文具最划算（单成本 4.6）、b box 与 Sanrio 零转化疑品牌错配、长尾最贵。三张决策卡 + 否词 CSV 80 词。lint PASS，republish 回验 200。
- **playmate 卡未成，两个真待决**（分析存 clients/playmate/notes/kw_direction_analysis_2026-09.md）：①渲染器中文写死，playmate 英语客户需先给渲染器加英文模式；②账户花费头部全是壮阳补充剂（sex pills/male enhancement/erection pills），content.compliance + Ads 政策双敏感且已有 #558 待客户决策，framing 要 Alvin 过目并与 #558 对齐，不宜无监督定稿。
- 下一步/认领：goodie 卡等 Alvin 明早看；playmate 待 Alvin 定英文渲染方案（我可给 render + 模板加 i18n 一次性改+测试）与壮阳类目 framing。

### 2026-09-17 AIRA (g)：P1 两条（能力重绑定回路 + worker lint 路径核实并补全）

- **能力重绑定回路**（tools/harness.js + 新 tools/machine_run.js，已部署无关，纯本机工具）：harness 每跑一次列「转位候选」= 人工位任务 × 已接通平台车道（读 lib/capabilities.loadManifest(bc.platform)）。machine_run.js 批量转位（owner→agent、补 ops、detail 盖印章、强制 --reason），ops 必须在 release_policy 表内否则拒转。转位印章改内容哈希使旧判决过期，下次 harness 的 0.5 段自动重排闸A 重判再拍板，全闭环零手工 PATCH。midea 498/499 实盘验证：转位→job 934 自动重判(do)→job 935/936 执行，无人肉干预。
- **worker lint 路径核实**（execute_task.js，**待部署**）：核实结论=有真缺口。①blogcheck.js 是 worker 执行侧唯一 JS lint，只读 banned_terms/absolute_claims/forbidden_openers 三键+硬编码 dash/emoji，不含 badge_count 及多数 Python lint 规则；②实测 worker 的无头 `claude -p`（cwd 在客户工作区）**不加载** /data/aira/.claude 的 PostToolUse lint 钩子（instrumented 测试：写坏 badge 文件 agent 无反应，--debug 无钩子机器日志）；③故 badge_count 等规则此前只在 ramp 后检（人触发）兜住，执行侧裸奔。补法：execute_task 发布每份客户版 HTML 前跑全量 deliverable_lint.py，PASS/FAIL 盖到卡 note（不拦发布，external 走客户卡人来定；永不抛错）。这让 blogcheck.js 的部分实现有了全量后盾，后检不必逐份重跑。deliverable_lint.py 本身无 worker 树副本（绝对路径 /data/aira/scripts 单份，hook 与 blogcheck 共用），无同步问题。
- 测试全绿。execute_task 改动**待部署**（deploy.sh worker），部署前 498/499 等在途 job 仍走旧 worker 不带 lint 戳，属预期。
- 归属：harness/machine_run/republish 是 tools，不进部署产物；execute_task 与之前 P0 无关，本条是唯一待部署项。
- **2026-09-17 已部署**：running job 归零后跑 deploy.sh worker（execute_task lint 闸 + v8 specs 到 ros）与 deploy.sh api（release_policy.json v8 到 250，seo-api.php 读 __DIR__ 旁那份，deploy.sh api 负责 scp 过去）。两侧 rev 4ff5275，check 零漂移。注意：release_policy.json 一份源文件（seo-worker/specs/），worker 与 api 两个部署目标都要跑才两侧同步。

### 2026-09-17 AIRA (f)：P0 三修（harness 本期推导 + 空拍板逐条原因 + republish 回程通道），另纠正 (d) 条一处误诊

- 先纠错：(d) 条报的「判决时效盲区」是误诊。attach_review_state 的 stale 判定早就是内容哈希锚（review_text_hash=MD5(title|detail)），转位 PATCH 不会作废判决；当日两次空拍板的真凶只有 sprint 口径一个，重排 job 916 是白烧的（且两次 fable 判决结论不同：915 判 496 并入 495，916 判 496 独立 do，本批按 916 执行）。误诊根因是 harness 无声失败逼人瞎猜，修复见下。
- harness.js 三改（node --check 过，midea 实盘 dry 验证）：
  1. **「本期」改推导**：未结任务（proposed/approved/blocked）最小 S 号即本期，板上 current_sprint 降级为兜底展示，新增 --sprint SN 人工强指。dry 实证：midea 推导 S2 正确（plan v2 任务本就铺 S1 到 S5，是 90 天节奏不是错位；当日 --ids 批把 S3/S5 任务提前执行了，判决都盖过章但节奏被压缩，后续按推导口径自然恢复波次）。
  2. **空拍板逐条打原因**（不在本期/判定中/无判决/判决过期/有 job 在册/人工位），最多列 25 条。无声失败是 (d) 误诊的根因，禁止再犯。
  3. noVerdict 重排分支补「approved+agent+从未判决」组合。
- 新增 tools/republish.js：后检返修的发布回程，lint FAIL 拒发（WARN 放行）-> publishFile 同款 scp 通道 -> curl 回验 200 加字节量核对。修复 (e) 条报的单向通道坑。仓库工作区无 config.json 时回退 DEFAULTS。实测 midea ricecooker 幂等重发全通。
- 测试：node tests/ 全套绿。P1 两条（能力重绑定回路、worker lint 路径核实）与 P2 两条（execute 并发、shopseo GraphQL 提速，均 MA 仓内 / shopseo 工具链，Aira 自己做，非外包）在 (d)(e) 复盘框架下待排。
- DEFECTS 补一行：误诊白烧 fable 重判一次，本可被「harness 逐条原因输出」拦住（已修）。

### 2026-09-17 AIRA (e)：S1 首批 ramp 后检收口 8/8 PASS，徽章计数 bug 进 lint

- 干了什么：7 份交付物深检完成（#493/#495/#496 我检，其余 opus 按 midea 铁律清单逐页，66 条内链逐条 curl 零跳转全 200，可疑 slug 对线上 .js 核 SKU 全对）。4 份直接过；3 份修后过并已 scp 重发布 250：rangehood（追加型契约违规：两处现文改动误标 wording unchanged，重标 our adjustment 可推翻；删「下一轮移除现文」承诺改为等客户确认库存；Five/Six 数目；徽章 61/140 改实测 56/135；大词补 long term goal 标注）、ricecooker（徽章 165 实为 160）、方向卡（「第 4 位以后」与自举例 3.7 位矛盾改「未进前三」、第 3 节标题对齐内容、勾选清单补「只列花费靠前」）。台账 clients/midea/notes/pending_check.md。
- 机制沉淀（lint 能抓的不写记忆）：**徽章计数 bug 是系统性的**（出稿模型把 [dash] 占位符的字面长度数进现值徽章，两文件中招，allfridges 写 [long dash] 反而蒙对）。已加 deliverable_lint.py 1d 段 badge_count 检查（占位符算 1 字符，全实体解码，容差 1，rules json 登记），首跑抓出一个真差 6 的实体解码盲区并修正；templates/seo_edit_skeleton.html Module 0 加计数铁律注释。注意：lint 与骨架在 /data/aira 工作区不在本仓。
- 坑：/tasks/{id}/deliverables 端点不收 html（txt/csv/md/pdf/json 白名单），客户版 HTML 的修订重发布只能走 publish.js 同款 scp 通道（blogpreview host 别名）。改完本地文件不等于线上改了，2026-08-31 #145 内外链接混淆的邻坑。
- 下一步/认领：发客户卡（方向卡 1 张截止 9/24 + 页面调整批次 6 页）；#502 套装口径、#498/#499（agency 位）、oakfurniture 装机随后跟进。

### 2026-09-17 AIRA (d)：midea S1 首跑通线，8/8 执行完成，报 2 个流程坑

- 干了什么：midea(3) S1 试点全链路跑通。导入增量（44 词客户确认版词表替换 46 词旧版、brand_regex 补 美的/mideahomes、5 条新 facts 含 rebrand 待定与客户审稿习惯）；onboard 双闸以历史真实确认落账过闸（词表 2026-04-23 客户反馈定版、mapping 走客户 Midea.xlsx 品类结构加历史上传行为，facts keywords.lock_2026_04 / seo.mapping_v1，非 skip-gates）；10 任务 agency 转 agent 位（plan 42 是 9/3 建的，早于 Shopify 车道接通，故全在人工位）；闸A fable 重判 8 do 2 later（#503 被 rebrand fact 拦下，facts 回路首次实战生效）；harness --ids 跑通，8 执行 job（917-924）全完成。产出：7 份客户版交付物（6 页面稿 + 1 关键词方向卡）进 review，#495 否词挂载走 L0 auto 已落地（新建共享列表 22 条，四 campaign 挂载回读全符，方案层还剔掉了原孤儿列表里 8 条竞品牌与 3 条在售商品词）。ramp 后检台账 clients/midea/notes/pending_check.md，机器项 8/8 过，#493/#495/#496 深检 PASS，其余 opus 深检中。
- 坑（两个，修复归排期，先报告）：
  1. **判决时效盲区**：PATCH 任务（如转位）会顶掉 updated_at 使判决失效，而 harness 的自动重判分支只抓 proposed 状态，approved 任务掉进「判决失效且不重排」的盲区，只能手动再 POST /tasks/review。建议 harness noVerdict 过滤加 approved+agent+无有效判决 分支。
  2. **sprint 指针错位**：板上 current_sprint=S2 与 plan 42 任务的 sprint 标签（S1/S5）对不上，harness 默认口径扫不到本期任务，本次用 --ids 绕过。要么 plan_review 落任务时对齐板上指针，要么 harness 改按 active plan 的最小未完成 sprint 推本期。
- 下一步/认领：opus 深检完成后发客户卡（页面调整批次卡 + 方向卡），客户确认落 mandate.* fact；#496 只读复查已按验收即收口 done。两个 harness 坑我下个改动窗口自己修（主力开发认领），修前先带病运行。

- 干了什么：Alvin 定（本日频道）：SEO 内容线 Alvin 退出常规放行链。external 类 op 与「改页面说什么」批次的放行凭证改由客户卡采集（方向卡 / 网页调整卡，新 SOP specs/sops/client_cards.md），客户确认落 confirmed 批文 fact 走既有 external_with_backing_fact=auto 通道，**服务端零代码改动**；Alvin 只收异常件（bug/报错/权限/平台不支持）；ramp 期 auto 完成件全量人工后检，质量熔断暂不建。落地：release_policy.md 加「SEO 客户卡放行」节、json version 7→8（新增 seo_client_card 说明块，不改定档行为）、capabilities/shopify.md 升 v2（船队 10 店口径、article-meta-update 空补齐/改已有的卡片分界、sungait 专属铁律隔离、文案铁律改按客户 CLAUDE.md+facts 走）。测试：node tests/ 全套过（specs 一致性含新字段）；未动 seo-api.php 故 php -l 不适用。
- 坑：article-meta-update 的「空补齐 vs 覆盖已有」分界服务端不区分（都是 reversible L0），靠 plan/execute 阶段 prompt 落实 + ramp 后检兜底，后检发现漏卡按 DEFECTS 流程收紧。
- 下一步/认领：midea 定为 Shopify S1 harness 试点（Alvin 挑的方案，本日批）。我备导入包跑 onboard_chain；policy json 属 api 部署面，**待部署**（deploy.sh api），按政策维护回路放宽类 diff 给 Alvin 过目后我部署。

### 2026-09-17 AIRA (b)：Shopify 船队收货验活，9/9 全绿

- 干了什么：收 Aiden 回包（/mnt/share/aiden/to-aira-shopify-fleet-tokens-reply-20260917.md），9 家店（midea/sunseeker/badger/luxelink/ctomi/playmate/haakaa/goodiegoodie/dareu）已追加 stores.conf（/data/aira/tools/ 与 tools/shopseo/ 两份同步），逐店 whoami + articles list 全过：token 均 permanent、scopes 全量同 sungait 口径、店名域名逐一对上。文章量：haakaa 317、dareu 136、luxelink 85、midea 72、sunseeker 67、badger 65、playmate 61、ctomi 33、goodiegoodie 24。
- 尾巴关掉一条：sunseeker 的 read_analytics 在最终 app 版本里，whoami 活体验证带着，不用 Alvin 确认也不用 Aiden 补。oakfurniture 仍 PENDING 等店主装 app，stores.conf 留注释占位，Alvin 去催。
- 顺手修 shopseo 一个 bug：articles_json() 用 --argjson 把累积文章 JSON 塞命令行参数，payload 带 body_html 超 ARG_MAX 直接炸（badger 首撞，execve E2BIG）。改为临时文件 --slurpfile 累积，badger 重测过，其余店回归无异常。bash -n 过。Aiden 若改 shopseo 注意别回退这段（约 250 到 267 行）。
- 下一步/认领：这批店进 sprint 排期（板上逐客户开）；collections 命令面 Aiden 已答复他来扩，做完 COLLAB 回包；oakfurniture 装好 Aiden 补 alias 后我再单独验活补登。

### 2026-09-17 AIRA：GBP 口径收窄为 gbp-align 两件套（Alvin 定：只做 SEO 收益可度量的）

背景：#42 六项清单（补产品价、改 posts、补照片、重写描述、逐平台核对时间）是「为列而列」，收益不可度量且写侧全人工。新口径：GBP 任务唯一合法形态 = gbp-align 两件套——① 档案落 fact gbp.profile（NAP/类目/链接/营业时间照录，第三方旧址残留记备注，做 map citation 的原料）；② 站内 LocalBusiness schema 部署对齐（sameAs 指 GBP，机器可落）。citation 修正等 map citation 批次拿 fact 统一做；gbp-update（human_only）只在客户点名改 GBP 本体时用。
- specs：webforger.md 能力表 gbp-audit 改 gbp-align 并重写定义、§268 段收窄；plan_experience 加一条；release_policy gbp-align=reversible；seo-api READONLY_OPS 加 gbp-align（gbp-audit 保留兼容存量判决）。
- 存量：#42（PD）与 #392（KiaOraKids）改造为两件套并转 agent 位重判（job 887/888）；#385（Citymed S6 复盘）加注记只看洞察不出清单。
- 测试：node tests/ 19 文件全绿。待部署 api + worker。

### 2026-09-16 AIRA：管线六修（第一性审阅后 Alvin 批全做）

1. **发布路由**（seo-api）：blog_outline_stage 先查 publish_blog=agree 凭证，有即直通 apply 发布；判据读事实源不再猜 URL 形状（#103 误排重写教训）。
2. **blogcheck 图片误判内链**（lib/blogcheck.js internalLinks）：剥 markdown 图片语法、/assets/ 路径不算内链，单测过。#139 两轮误杀的真根因即此；「修订通道整篇重生成」系误诊，revise 路径一直在。另补 revise 识别 note 兜底：卡机制后 output_url 是卡链接，修订轮从 result_note 找平台草稿链接（execute_task）。
3. **ads_audit 补 campaignCriteria / adGroupCriteria**（lib/ads_audit.js）：agent 泳道最常写的两类不在 CHECKS 表，#740 六十行全带资源名仍「零行可硬审」（前诊「缺 resource name」有误）。对 #740 真实条目活体对账 3/3 硬读全符。
4. **连续秒挂熔断**（listener.js）：连续 3 个 job 起跑 90 秒内即挂 → 写 .spawn_fuse 停领单报人，删文件恢复；替代被第一性推翻的「凭据预检」（预检防不住任意时刻过期）。
5. **放行卡合并规则**（execute_task prompt）：超 3 个对象禁逐条列，合并类别行，逐条归第 3 节（#696/#112 超长病根）。
6. **sent_at 自动打点**（seo-api /card_feedback status 分支）：卡页首次经中继打开（带 X-Forwarded-For）即打点——sent_at 本义就是客户可见时刻，人工「标记已发」降级为提前手段（今日六卡全漏打的教训）。
- 附带：方向卡折叠即收口（harness，f018b61）同日上线，#672 实例收口。
- 测试：node tests/ 19 文件全绿、blogcheck 与 ads_audit 单测/活体验证、node --check 全过。
- 待部署：api + worker。

### 2026-09-16 AIRA：weekly_run 加结构化收尾（Alvin 定：跑完要有总结与卡壳归因）

weekly_run.sh 升级：跑前跑后各拍任务快照，新增 tools/weekly_digest.py diff 出结构化收尾——总结行（顺利跑完 X 家、卡壳 Y 家、收口 N 条）+ 每家收口/卡壳明细 + 按原因分组的人工修复清单（执行失败/卡待发/卡等客户/待放行真闸/等外部/判决在飞，各带一句修复动作），digest 落 /tmp 时间戳目录并打印，各家 harness 全量日志同目录。活体自测：对 Apollo/Sanmichelle 实拍快照跑 digest，正确归因（Apollo 三条判决在飞、Sanmichelle #673 待验收）。
- 测试：bash -n、digest 活体自测；node tests/ 不涉及（纯工具层）。
- 待部署：worker tools 随下次同步，批跑从仓库直跑不阻塞。

### 2026-09-16 AIRA：harness stale 判决自动重判 + weekly_run 批跑壳

Alvin 定每周下班人触发跑三轮 harness 滚动 sprint，且「fable 带客户参数批量判决消耗不大」：
1. **harness.js 闸A 排程扩面**：0.5 阶段除 proposed 无判决外，agent 位 approved/proposed 且 review_stale 的一并自动重判——换挡后老 plan 判决过期卡「待拍板」的模式就此消除（Apollo S3、Louvresky S4 两例实证）。判决 job 万级 token，批量 20 条一 job。
2. **tools/weekly_run.sh**：顺序对全部 active 客户（或指定名单）跑 harness，一次一个防内存挤兑，单家失败不拖垮整轮，末尾汇总页（处置/放行卡/阻塞/闸中止）落 /tmp 并打印。人触发，不挂 cron。
- 测试：node --check、bash -n、Louvresky dry 实跑（正确识别 2 条待处置）、node tests/ 19 文件全绿。
- 待部署：worker（tools 与 harness 在白名单内随下次同步；批跑我从仓库直跑不阻塞）。

### 2026-09-16 AIRA：Aiden 平台三答收割，S1 平台侧堵点清零

对应 Aiden 答复 /mnt/share/aira/to-aira-apollo-form-and-pd-item-writes-20260916.md（含两个深夜更新）：
1. **Apollo #97 闭环**：平台 LEADS_JS 空防护修复部署后跑第三段验收：线上 /contact/ 新脚本实查（try 包 UI 段、缺 status 自动补 aria-live），按页面脚本口径测试提交，后台 inbox 首现 Contact Form:/contact/ 来源 lead（2026-09-16T20:14:51，已标注待删）。任务 done(accepted)，验证边界写明（DOM 事件链由平台 9 条回归测试覆盖）。
2. **PD #742 机器线落地**：12 个 AquaREPEL item x 3 字段共 36 处，PUT items 串行执行（响应回显逐条比对、ignored 全空、独立回读 36/36、渲染抽查生效）。「缺执行器 collection-item-update」的前提修正：schema 本就含 SEO 字段，是快照看漏。
3. **PD #743 机器线落地**：平台深夜解锁记录级 PUT 白名单后两字段落地，双品牌 title（79 字符）修为 59 字符规范形态。R2 collection「真墙」定性作废。
- 执行器回流待办：collection-update / collection-item-update 按 Aiden 给的契约长进 seo-worker（ignored 非空=失败、同 collection 串行防 items.json 互踩、路由用 item.id、body 不带 id、seoTitle 品牌后缀预算），登记在 TODO 排期。
- 关联：#33 的 capability-gap 尾项清零；PowerDekor S3 至此无平台侧阻塞。

### 2026-09-16 AIRA：Bens AU/NZ 词卡按窗口铁律重发 + 报告 tab 新增「卡片」类目

1. **两张词卡重出**（Alvin 指出已发卡窗口口径不合「发卡月前两个整月」铁律）：窗口统一 2026-07-01 至 08-31，全部数字 GAQL 现测并与系列合计分毫对账（AU 搜索 54 条询价、NZ 搜索 10 条均对上）。判断随新窗数字更正并在卡上披露：AU「款式与做法」收缩改保持观察；NZ 三处（curtains 加码改保持、sheer 保持改收缩、blinds 收紧改保持）；NZ 停投归因按已查明事实改「账户验证问题」（更正付款方式误判）。决策卡截止日统一 2026-09-23（旧卡 no_reply 9/8 早于发卡日 9/15 的雷一并修）。同 URL 覆盖发布，t/k 与已收反馈不受影响，lint PASS、线上 200、周期行实测正确。数据 JSON 走新契约（issued+window，渲染器生成日期）。
2. **报告 tab 加「卡片」类目**（seo-agent.html）：repChan 加 cards 页签（全客户可见），列出该客户全部确认卡（词卡/素材卡/博客卡/内容卡），行含类型、状态（待发/已发待反馈/有新反馈/已处理，读 sent_at/card_feedback_at/折叠标记）、打开卡片链接、更新时间；卡片视图隐藏生成按钮。设计意图：卡片归报告资产，后续 chat 模型可按此检索与调整报告，不必每次经 PJ。
- 测试：node tests/ 全套 19 文件退出码全 0。
- 待部署：api 模式（seo-agent.html）。

### 2026-09-16 AIRA：release_policy v7（l0_exclude 收缩）+ 已完成卡 concise 交付模块 + Apex paid 补位

Alvin 定「等我的只留卡片反馈与生意闸」后的三件落地：
1. **release_policy v6→v7**：l0_exclude_ops 从 page-rewrite/page-rebuild/styles-fragment/gtm-edit 收缩到只剩 gtm-edit（等 COLLAB bm 根因修复再评估）。效果 = 一切 reversible 改站任务闸A 判 do 直接 L0 落地不出放行卡。兜底三件套：改前存档 + 回读铁律（100% 覆盖，PD「PUT 回 ok 但零写入」实证了它比抽查硬）+ 周度 10% landed 条目独立复验（首轮已跑：#99 抽 4 篇+特例篇、#33 实读，零缺陷，抽查脚本自身两个坑已修：qa 参数撞站点白名单闸、slug 引用方案叙述短写）。
2. **已完成卡片 concise 模块**（seo-agent.html doneBox）：closed 卡不再显示长 detail，改为一句话干了什么（result_note 最后终态标签首句）+ 人工验证链接 chips（受影响页面/客户版 URL 去重限 6，内部预览壳与附件下载不算），配合已结束视图按结束时间倒序，人工抽查顺着点。
3. **Apex（44）paid 补位**：services 从 paid 改 both（SEO 线 9/10 已全面 onboard 字段没跟上）；预立三任务均条件 after:2026-09-22（客户观察期结束）：#744 转化双计修正方案（conversion-goal-change，irreversible 走放行）、#745 观察期复盘+2026-10 素材方向卡、#746 浴室落地页与 SEO 线协调。闸A job 852/853 已排。
- 测试：node tests/ 全套 19 文件退出码全 0。
- 部署：api（seo-api.php 无改动、seo-agent.html + release_policy.json 落 250）+ worker（specs 同步）。

### 2026-09-16 AIRA：卡片已反馈签章（时间+IP）+ 已结束按结束时间倒序

Alvin 两项：已结束视图按结束时间排（刚完成的在最上，顺着审）；发出去的卡每个反馈按钮右侧要有已反馈签章（最后一次表态时间+IP，人工打开卡就知道谁何时反馈过）。
- **后端**（seo-api.php /card_feedback）：seo_card_feedback 惰性补 ip 列；写入记客户 IP（同域中继带 X-Forwarded-For 第一段，直连取 REMOTE_ADDR）；新增 status 查询模式（token 过验回每 item 最后一次 choice/时间/IP，不回 fb 文本）；写入与 24h 防重返回都带 at/ip 供页面即时画章。
- **中继**（blogpreview webroot card_feedback.php，非本仓文件）：转发时补 X-Forwarded-For 头，改前留 .bak-20260916，php -l 过。
- **模板**（direction_card_template.html + blog_confirmation_template.html 两份同改）：.fbstamp 样式；post() 改回传 JSON；loadStamps() 加载时回填签章；提交成功即更新签章。预览模式（无 t/k）不发请求。
- **前端**（seo-agent.html）：已结束视图排序改 taskTime 倒序（进行中视图排序不变）。
- **存量卡升级**：五张有 data.json 的重渲染（louvresky 词卡+素材卡、bens NZ、sanmichelle、haakaa），三张没留 data.json 的做脚本块移植（bens AU #145 词卡、apollo #103 与 kuddles #75 博客卡），七张线上同名覆盖发布（URL 与 t/k 不变），sanmichelle 卡实测 status 通路 OK（历史反馈行 ip 为空属预期，新反馈起记录）。apex #672 是 kickoff 产线独立模板，未纳入本次，待该产线固化时一并接签章。
- 测试：node tests/ 全套 19 文件退出码全 0；relay 实测 bad token 403、真 token 回 items。
- 已部署：api（rev c2950ec）。worker specs 随下次 worker 部署同步（渲染我在仓库直跑，不阻塞）。

### 2026-09-16 AIRA：任务视图三改（已结束拆分 / 确认卡进人工泳道 / 判定四件下线）

Alvin 看 Apex 任务页提的三项，全在 static/seo-agent.html 展示层：
1. **已结束与进行中完全拆分**：taskVisible 改互斥视图，「显示已结束」开=只看已结束（受时间档约束），关=只看进行中；按钮态切「返回进行中」，泳道计数与提示行文案随视图切换。Chat 筛选下 chat 任务在进行中视图仍可见（沿用 2026-09-08 例外）。
2. **客户确认卡进人工泳道**：新增 isPendingClientCard/laneKeyOf，review 状态且未折叠（result_note 无 [卡反馈折叠] 标）的词卡/素材卡（ops 匹配）与博客/内容确认卡（note 或 output_url 匹配 确认卡/blog_confirmation 等）显示进人工泳道（发卡与跟客户确认是人的活），折叠完自动回 Agent 泳道。只改展示层，owner_type 数据与产线不动。
3. **判定四件下线**：任务工具栏「新增任务/判定/全部按推荐/执行选中任务」四按钮移除（判定已收进 harness 与 Chat 派单），函数与端点原样保留，renderReviewButtons/renderPickHint 均有判空不受影响；jobs 面板的执行按钮不在本次范围未动。
- 测试：node tests/ 全套 19 文件退出码全 0。
- 待部署：api 模式（seo-agent.html 上 250）。

### 2026-09-15 AIRA：存量方向卡迁入新契约 + legacy 通道（频道改卡链路打通）

- 背景：Alvin 要能在频道跟 chat 说「改某张卡的文案 / 链接」。链路本身通（chat 出委托单 → 放行 → execute_task 改 data.json 重渲染 → scp 覆盖同名文件，客户链接与 t/k 参数不变），堵点是窗口定版后五张存量卡是旧契约（手写 period_label，实际窗口也不合新规则），新渲染器直接拒收。
- **legacy 通道（时间盒）**：applyWindow 加 `legacy_window{period_label,window_line}`，原周期行原样保留不做窗口数学；只认 issued < 2026-10 的存量卡，新卡给这个字段直接拒，window 与 legacy_window 二选一。schema 同步（oneOf），kd_render 加 3 例回归。
- **五张存量卡已迁**（workspaceRoot 就是 /data/aira/clients，agent 本来就够得着，无需另收档）：louvresky 词卡 S1 与素材卡 2026-08、benscurtainsnz 词卡 S1、haakaa 词卡 S2、sanmichelle 词卡 S1，全部迁成 issued + legacy_window，新渲染器重渲染验证通过。
- **顺手修**：louvresky 两张与 sanmichelle 一张的线上版还是 2026-09-08 的单端点 widget（无降级备胎），已用现行模板重渲染覆盖发布（URL 不变，正文零差异，diff 只有 widget 块）；bens NZ 线上已是最新。中继 card_feedback.php 实测通路正常（403 是上游对假 token 的正常拒绝）。haakaa S2 无线上版，不代发。
- 测试：node tests/ 全套退出码全 0。
- **已部署 worker**（rev 0ee2b4d，deploy.sh 六步全过，重启前无在跑 job）：本批 specs 与窗口定版一并生效，线上渲染器读迁移卡实测 OK。api 无漂移未动（今日早间的 finish / gbp-audit / 侧边栏批已随 rev 194179e 在线上）。

- 背景：Alvin 问方向卡是不是按「过去 60 天」出数，核查结论是根本没有统一窗口：spec 只有 period_label 示例（sprint 两周），窗口由执行 agent 现场自选，已产四张词卡加一张素材卡五种口径（28 天 / 两周 / 三个月不等）。Alvin 拍板定口径。
- 口径（两卡同一条规则）：**数据窗口 = 发卡月往前两个完整自然月**（2026-10 发卡 = 8/1 至 9/30），整月不滚动；**节奏 = 每客户每月一张，词卡与素材卡逐月交替**（2026-09 词卡、2026-10 素材卡），单卡型各两月一张、窗口首尾相接不重叠。唯一例外：账户投放不足两个月 start 按实际首日且必须写 exception_note，end 永远是发卡月上一个自然月最后一天。
- 机制（不靠模型自觉）：数据 JSON 改为只写 `issued`（发卡月）+ `window{start,end,exception_note,note}`，**period_label 与 window_line 两个日期槽由渲染器从 window 生成，数据里出现即拒**（2026-08-31 widget 参数事故同源治理：日期不经模型的手）；窗口不合规则渲染器直接拒收。词卡文件名从 {sprint} 改 {YYYY-MM}。
- 落点：direction_card_lib.js 加 applyWindow（守卫加日期生成，两渲染器接线）、两 schema 升 V2（issued/window/period_note 换掉 period_label/window_line）、keyword_direction_spec 升 V6、creative_direction_spec 升 V3（各加数据窗口与节奏节）、plan_experience 词卡每 sprint 条改月度交替（取代 2026-08-31 决定）、googleads.md 能力清单补节奏窗口一行。
- 测试：kd_render 加窗口 6 例（末日不合拒、短窗无说明拒、带说明放行、手写日期拒、跨年、生成日期进 HTML）、creative_render 加接线 2 例，node tests/ 全套 19 文件退出码全 0。
- 存量：已发的四张卡不追改，下一张起生效。已存在的旧 data.json 是旧契约，重渲染需先迁字段。
- 待部署：worker（specs 目录在白名单）。给 Aiden：execute_task 接 keyword-direction / creative-direction 渲染产线时（你认领的两分支），brief 里发卡月给 issued，窗口日期不用喂给模型，渲染器会算会拦。

### 2026-09-15 AIRA：chat 加 finish 动作（人工完成收口）

- 背景：Alvin 要能在 chat 里把人工在外面做完的任务收口。原来 chat 任务线程七种动作（redispatch/kill/later/set_verdict/edit_task/release/machine_run）里没有「人工完成验收」这一种，只有 kill（放弃）和 release（放行给机器去做）。
- 加 **finish**（第八种，进 THREAD_AUTO_ACTIONS 落库同刻执行）：task_close accepted，人认定人工已完成、置 done。语义与 kill（不做了）、release（放行给机器）都分清楚：分析或待放行任务收口走 release，人工在外面做完的活走 finish。
- 落点：seo-api.php（THREAD_ACTIONS + THREAD_AUTO_ACTIONS + thread_action_exec 的 finish 分支）+ chat.js（actionsContract 加 finish，七种改八种）。
- 测试：chat.test 37 过、node 全套 19 文件退出码全 0、php -l 过。
- 待部署：api（seo-api.php）+ worker（chat.js）。

### 2026-09-15 AIRA：GBP 读写分离，核查现状加出方案下放 agent（gbp-audit）

- 背景：Apex #661 客户甩来 GBP 链接问要不要更新，chat 只能「我不读 share.google、请人把现状贴进来」再给通用清单（Alvin 指出 agent 该直接接手）。根因：gbp-update 整块 human_only 把只读核查也一并挡在人工。
- 改法（照 ga4-audit / gsc-audit 的 agent_readonly 模式拆开读写）：新增 **gbp-audit**（agent_readonly，risk_class reversible）：agent 用 WebFetch 读客户**公开** GBP 现状（类目、服务区、营业时间、电话、简介、服务、照片数、评价、帖子）出具体补齐方案，一步出报告、放行即验收、不走 prepare/apply，读不到的项标「需人工补」。**gbp-update** 保留 human_only 但只管实际写入（改资料与类目、发帖、回问答、citation）。
- 落点：specs/capabilities/webforger.md（gbp-audit 行 + risk_class + 段落注释改读写分离）+ specs/release_policy.json（gbp-audit reversible）+ seo-api.php $READONLY_OPS 加 gbp-audit。execute 不改（agent_readonly 复用 analysis 路径 execute_task L1901）；chat 不改代码（读能力清单全文，更新即生效）。
- 效果：客户甩 GBP 链接，chat 派 gbp-audit，agent 自己读公开现状出方案，人工只做最后的改。GBP 公开资料无需后台 API 即可读；实际写入仍无可靠 API 走人工。
- 测试：specs 两处一致、node 全套 19 文件退出码全 0、php -l 过。
- 待部署：api（seo-api.php）+ worker（specs 在白名单）。

### 2026-09-15 AIRA：ops agent 前端侧边栏改版（收起栏 + 平台 icon + per-user 星标 + 三色徽标）

Alvin 提的四项客户栏改造：
1. **侧边栏可收起**：点「收起」全隐藏，左边缘出浮动召唤按钮(☰)再展开，状态存 localStorage。原「+添加」缩成 + 图标，同排加收起按钮与星标过滤。
2. **#号码换平台 icon**：客户名前的 #号码换成内联 SVG 平台图标（WordPress/Shopify/WebForger/others，品牌色区分，一目了然），#号码移到 hover 提示。platform 字段 /clients 早已返回，纯前端加 platformIcon()。
3. **per-user 星标**（Alvin 定：绑登录用户，同事各标各的负责客户，不共享不乱窜）：新表 seo_user_stars(username,client_id) 惰性建；POST /clients/{id}/star toggle；GET /clients 返回当前用户的 starred；前端每行名后星标 + sb-head「只看星标」过滤(sbStarBtn)。
4. **徽标改三色排序红橙蓝**：原来两个(混合任务数+facts)，改成红=人工任务(owner agency/client)、橙=fact 待确认、蓝=agent 任务(owner agent)。后端 /clients 任务数按 owner_type 拆成 agent_tasks_open / manual_tasks_open（tasks_open 仍返回两者之和兼容旧用）。
- 落点：seo-api.php（/clients 任务拆分 + starred、POST /clients/{id}/star、ensure_stars_schema）+ static/seo-agent.html（sbRow/platformIcon/platLabel/星标/收起展开/星标过滤/CSS）。
- 测试：node 全套 19 文件退出码全 0（ui.test 含前端加载校验），php -l 过。DB 走惰性 DDL（seo_user_stars 首次 /clients 请求建）。
- 待部署：deploy api（一并部署 seo-api.php + seo-agent.html 到 250）。

### 2026-09-15 AIRA：博客确认卡上线（对外博客发布前的客户确认闸）

- 背景：Alvin 定博客发布走确认卡（复用 card_feedback 状态机）。老客户方向层已静默 onboard，博客确认卡是老客户 sprint 内唯一的客户确认闸。前置的 card_feedback 两缺陷已修（rev cb00641）。
- 新增卡型：`specs/report/blog_confirmation_template.html` + `render_blog_confirmation.js` + `blog_confirmation_data.schema.json` + `blog_confirmation_spec.md`，复用 direction_card_lib 渲染引擎与同一条反馈脚本。卡含 draft 预览大按钮、关键词规划（快赢导向）、内链规划、配图、发布决策（agree 同意发布 / hold 保持草稿 / other 修改）。decision.item 固定 `publish_blog`。
- 集成四处：
  1. execute_task 博客产 draft 后自动组卡（关键词=主词+正文 H2 子题、内链从正文 markdown 链接提取、draft_url=平台预览链接），渲染上传，output_url=卡链接（带 t/k）；create 与 revise 通用。
  2. apply_task runBlogPublish 加客户同意硬闸：发布前查 seo_card_feedback 有 `publish_blog=agree`（以最后表态为准），否则抛错不发。杜绝未确认草稿被误发（#138/#139 收账误放行事故）。
  3. harness foldCards 博客确认卡分支：agree 的凭证留在 seo_card_feedback 表供 apply 查、不开泛落地任务（card_feedback_done 只清标记不删表行）；客户写了修改意见才开修订任务。
  4. 修 blog-edit 泳道 bug：apply_task BLOG_OPS 补 `blog-edit`（#96 死于此，改稿掉进通用 change-plan 分支必失败），改稿也走 runBlogPublish + 同一确认闸。
  - lib/api.js 加 `cardFeedback(taskId)`。
- 闭环：execute 产 draft+确认卡 → 人工前端把卡链接发客户 → 客户点「同意，安排发布」(publish_blog=agree) → 下一轮 harness apply 查到凭证才 publish。到期自动发布对博客不启用（博客卡标题不含「方向卡/direction」，不命中 harness 到期分支）。
- 测试：node 全套 19 文件退出码全 0（新增 blog_confirmation.test.js 7 项），node --check 改动文件全过。
- 待部署：worker（execute/apply/harness/lib/specs 都属 worker），specs 在 deploy 白名单内。

### 2026-09-15 AIRA：老客户静默 onboard + mapping 闸正则修复

- 背景：Alvin 定老客户内部静默走完 onboard 两闸直接进 sprint。关键词方向在导入建档时已定义(profile target_keywords)、合作月报持续沿用；mapping 也都做过。不为形式重出客户确认卡。快赢优先(流量曝光)。
- 修复：harness 的 mapping 闸正则 `^seo\.mapping` 太窄，漏认 `seo.page_mapping`、`seo.money_pages_and_mapping`，把用这些命名记 mapping 的老客户(Apollo/Ben's NZ/Kuddles/Power Dekor)误判成 mapping 未定稿。改为 `^seo\.(mapping|page_mapping|money_pages)`，并去掉冗余的 value 文本匹配(facts 已 filter status=confirmed，confirmed 即定稿)。tools/harness.js L128 附近。
- 静默 onboard：7 家 WF SEO 老客户(8 Apollo/15 PowerDekor/16 Louvresky/23 Sammichelle/45 Ben's NZ/46 Ben's AU/47 Kuddles)补 `keywords.lock_state` confirmed(source=manual，value 标明导入建档定义+合作确认+快赢优先)；16/23 另补 `seo.mapping_confirmed`(其余 5 家 mapping fact 已有，靠正则修复认出)。含 dogfood(52/53)共 9 家 WF SEO 客户全部过两道闸，harness 不再需 --skip-gates。
- 确认边界(Alvin 2026-09-15)：方向层(关键词/mapping)老客户内部静默确认；对外新发布内容(博客)走博客确认卡(含关键词规划+内链，快赢导向，spec 升级排下轮)；mapping 内页面执行(承接页 title/meta 改写)静默 sprint 不逐次确认。
- 测试：node 全套 18 文件退出码全 0，node --check harness.js 过。
- 待部署：harness.js 属 worker，deploy worker。

### 2026-09-15 AIRA：card_feedback 两处机制缺陷修复（博客确认卡的前置）

- 背景：09-14 louvresky #146 内部测试点击被 harness 折叠成客户同意的事故根因修复。Alvin 定博客走确认卡（复用 card_feedback，客户 agree 后下一轮 harness 处理发布），这两处缺陷是博客卡复用 card_feedback 前必须先修的（博客误折叠后果是直接对外发布，比关键词卡误开跟进任务重）。
- 修复一（惰性回填复活已清状态位）：seo-api.php ensure_review_schema 删掉那段按 result_note 文本（含 [客户反馈]）每请求回填 card_feedback_at 的存量迁移。它每次 ensure 重跑，把人显式清空（card_feedback_done）的状态位按 note 文本复活，测试点击于是被折叠成客户同意。card_feedback_at 此后只由 /card_feedback 写、card_feedback_done 清，清空持久。存量早在 2026-09-13 加列当天回填并持久化，删除不丢数据。
- 修复二（到期锚点错位）：加 seo_tasks.sent_at（惰性 DDL 进 ensure_review_schema）。「到期视同同意」时钟从 deliverable 产出时间改锚在 sent_at，空则不计时。修复卡产出即计时、卡没发给客户就被误触到期（#145）。harness.js foldCards 到期分支同步改用 sent_at（filter 加 t.sent_at，锚点用 card.sent_at）。
- 接口约定：人工前端把方向卡/确认卡发给客户后，对该任务 PATCH {card_sent:1} 打发出点（只写 NOW() 不许手填）；发错重置 PATCH {card_sent_clear:1}。到期时钟从此点算。
- 测试：node 全套 18 文件退出码全 0（cardfold/review/plan_review/apply/chat 等），php -l seo-api.php 过（250），php tests/chatapi.test.php 24 passed。DB 变更走惰性 DDL 先例。
- 待部署：Aira 已推 main，待 deploy.sh 部署（api + worker 两台）。sent_at 是新列，部署后首次请求 ensure_review_schema 自动加。

### 2026-09-14 AIRA：ads agent 泳道上线并首跑收口（rev 05c4b0b/d7df6b2/f910f58，ctomi #682 验收）

- Alvin 定调：白名单是路由偏好不是能力天花板，MA agent 做不了转人工是伪命题。apply 的 ads 通道检测到 executor_pending op 即解锁 Write+Bash(python3) 工具面，agent 自写 google-ads 脚本落地；安全底从前置白名单换成 lib/ads_audit 零模型后置对账（按条目 resource name GAQL 硬读账户，失败或零行可审不许收口）。API 侧撤掉上午的三道 pending 拦截（条目分类/chatw 转人工/machine_run 拒转/L0 跳过），意图携带的真障碍从四种减为三种。CLAUDE.md 硬规矩二改版，旧「模型只提议」废止。
- 首跑（#682 建 PMax 素材组）：第一轮活全干成（PAUSED 建组→25 素材逐字核对→启用，两图 PIL 裁剪上传，AG1/预算零触碰）但 agent 幻想「后台 15:06 复查」不敢报 success 就退了；apply prompt 补一次性进程纪律（异步审核状态不阻塞 success）后第三轮幂等复入报 success，零模型对账硬读 5 项全符，[applied] 收口，条目 19 verified。
- 教训入 prompt：一次性进程没有后台；REVIEW_IN_PROGRESS/Ad Strength 计算中不算未完成。判定前提修正（review_adjust）现在随 ads/shopify apply prompt 下发，复审硬约束优先于方案。
- 肌肉回流欠账：asset-create 的 agent 执行记录（apply-log-task-682 三份）就是 L1 实现规格，按铁律两次内进 ads_mutate 并从 pending 表删除，认领 Aira。

### 2026-09-14 AIRA：人工通道全流程演练（HornTech NZ #52 自家账户，线程 #288），两条路打通，追修两处（rev 0e02997 / 41c3293）

- 场景 B（意图携带直落）：频道两句话（提议卡+确认）后零人工停顿：commission → 方案 → [mandate-apply] 不停卡 → apply 真落自家账户（SEO核心词组新增 EXACT「外贸独立站 seo 服务」，criterion 2499502615609，GAQL 独立回读一致）→ [applied] 自动收口。这是 mandate 直落的首个真实闭环。
- 场景 A（executor_pending 人工分流）：故意点 budget-change（执行器未实现），条目层新分类直接 blocked+agency（理由带「政策表有档，落地工具没这功能」），F1 拆出人工工单 #738，频道通知清楚，零 apply 空转，零放行卡。人工对账 PATCH /items 与 kill 收口都真点验证。
- 追修一（41c3293）：终态回写掉线暂存。250 被打死期间 job761 卡 running、线程 409、收尸误标 failed。listener 新增 pending_terminal 本地暂存，poll 每 tick 与启动时（先于收尸）补投。
- 追修二（41c3293）：chat 简报话术还在承诺「花钱档停放行卡」，与意图携带行为不一致，已改为 mandate 版（列四种真停机障碍）。
- 追修三（0e02997）：items plan 分类只看政策表不看执行器实现，pending op 被标机器位 → 已改为双条件，配 PATCH /items 人工对账口与看板对账按钮。
- 插曲：演练中 250 因 WooCommerce 站被攻击整机 web 层瘫痪约 10 分钟（Alvin 面板恢复），与流水线无关，但正好把追修一的场景打了出来。

### 2026-09-14 AIRA：意图携带放行 + executor_pending 闸（rev 39efae3，api+worker 已部署，policy v6）

- 背景：ctomi #682（客户已批的 PMax 男士素材组）被要求第三次人工放行，Alvin 定性流程 bug：「意图在 chat 表达过一次就够，二次放行是重复采集」。同单还暴露第二个 bug：chat 拿政策风险表冒充执行器能力表转机器位，放行到 apply 才发现 ads_mutate 没实现 asset-create，全链空转。
- 意图携带：chatw 两阶段委托 / machine_run 转位 = 已验证的频道执行意图 = 放行凭证。chatw 出方案分支与 review_result L0 点都认它，spend/irreversible 档也直落。仍停的只有四种真障碍：executor_pending、条目 op 越出申报 ops（mandate_scope_ok）、同任务 apply 熔断、止损闩。
- executor_pending_ops（policy v6 新段，6 个 op：budget-change/campaign-pause/bidding-strategy-change/campaign-create/asset-create/conversion-goal-change）：machine_run 拒转、chatw 出方案转人工说明不挂放行卡、L0 不放。tests/policy_executor.test.js 断言政策表、ads_mutate OPS、googleads.md agent_prepare 行三方一致（ad-copy-rewrite 别名 rsa-copy-update）。
- #682 现状：按频道意图放行（decide，apply job 759），预检 4 项过，中止于执行器缺口，21 条目 blocked，未动账户。收口两条路等 Alvin 挑：人工照方案落地，或我把 PMax asset-create 补进 ads_mutate（含图片资产，需客户竖图文件，首跑盯 log）。
- 测试：全套 17 件绿；php lint 走 deploy 远端闸过。

### 2026-09-13 AIRA：卡反馈第一性闭环上线（rev f15f533，api+worker 已部署）

- 背景：sammichelle #306 客户在方向卡上表态 10 条（含反复表态与埋在 other 里的新需求）无人接，任务停在 review。Alvin 定第一性方案：一条反馈翻任务状态，harness 读状态分岔，不上 webhook 不上巡检。
- api：POST /card_feedback 24h 同款防重 + 写入置 seo_tasks.card_feedback_at（ensure_review_schema 惰性加列 + 存量回填 note 里有 [客户反馈] 未折叠的卡）；GET /card_feedback?task_id= 读行；PATCH /tasks 收 card_feedback_done 清位。
- worker：harness foldCards 在确认闸前跑。零 LLM 折叠（lib/cardfold.js，同项取最后一次表态）；agree/文本立跟进任务自动排闸A；hold 落 facts（source=client）；方向卡发出超 --card-grace-days（默认 14 天）零反馈到期视同同意。
- 验证：tests/cardfold.test.js 8 例（#306 真实序列），全套 16 件绿；部署后 #306 状态位被回填点亮，GET 行数 10，harness --dry 折出「同意 4 项，文本 2 条」后被两闸正常拦（sammichelle 未过闸，折叠先于闸设计生效）。
- 坑：加列前的存量反馈不会翻状态位，靠 ensure 里的幂等回填补；卡的验收关闭仍走频道 accepted 流程，本闭环不动 task_close。

### 2026-09-13 AIRA 追记：认领改版 + platform 归一已修复部署（rev 7326785）

- Alvin 定：Aira 转 MA 主力开发全仓可动，Aiden 辅助，认领登记节已改版。下条报告里「归 Aiden 排期」随之作废，我直接修了。
- 修法：PUT /profile 校验过 slug 枚举后按 PLATFORM_DISPLAY 映射存规范显示值，不再存请求原文。node tests/ 15 件全绿，远端 php -l 过，api 已部署（rev 7326785），check 无漂移。
- 线上验证：故意用小写 shopify 重写 Goodie profile，落库为 Shopify；全库 platform 仅 4 个规范值。

### 2026-09-13 AIRA 报告（Aiden 领地，报告不动手）：PUT /profile 的 platform 存原始显示值，大小写变体入库

- 现象：Goodie Goodie 存成 shopify、Citymed 存成 custom（小写），看板按 platform 筛选时这两家漏出列表。Alvin 发现后我已用 PUT /profile 把两行数据改回 Shopify/Custom，全库现在只剩 4 个规范值（WebForger/Shopify/WordPress/Custom）。
- 根因：seo-api.php 约 4583 行，platform 校验按 strtolower 后的 slug 过枚举，但落库存的是请求原文，同一 slug 的任意大小写变体都能入库成不同显示值。
- 建议修法（归 Aiden 排期）：加一张 slug 到规范显示值的映射表（webforger 到 WebForger 这类），校验通过后存映射值不存原文；顺手可在 ensure 层把存量归一，防下次建档再进变体。

### 2026-09-11 AIRA：执行层补时机维度 F1-F4（rev 412b11b，Alvin 定「harness match PJ 动作」基准）

- 背景：#681 空放行卡（拆条 0 机器项仍等放行）与 #680 必败 apply（「过审后」条件被当即执行）暴露条目缺「何时可执行」维度、母任务缺收敛规则。
- F1 拆条零机器项 → 母任务自动 merged 进 split 工单，不出放行卡；worker 改条目先上账 result 后传（postTaskResult 撞终态闸只留痕）。
- F2 条目加 condition_ready（ad_approved:<id> / after:date / manual_signal），方案契约强制结构化；全条件任务挂 blocked，listener 每 12 tick（约 1 小时）零 LLM GAQL 巡检（lib/conditions.js），条件满足 condition_met 续跑按政策定档。新端点 GET /tasks/pending_conditions、POST /tasks/{id}/condition_met、POST /tasks/{id}/park（admin 手工挂起）。
- F3 条目必须写真实 op 名（manual 只留人类专属），缺口按 op 每方案去重计数。
- F4 apply 失败 note 强制中文人话；条件未满足步骤跳过报 blocked。
- 存量：#681 已收敛 done(merged)→#682；#680 已 park 等 ad_approved:824204552784（实读已 APPROVED，等首轮巡检闭环验证）。conditions.test.js 新增，全套绿。
- 影响 Aiden 侧：seo_change_items 加列 condition_ready；三个新端点如上；items plan 响应加 merged 字段。

### 2026-09-11 AIRA 追记：快路上线 + 三执行器真实账户首跑通过（rev 5f6f072）

- 快路（Alvin 批）：最新人类消息即明确指令时 commission_start 可 proposal_msg_id=0 同轮启动，引语必须逐字命中该最新消息，仅限直落档；facts 前移到 actions 之前使同轮批文背书生效（03b259d）。
- 补两条时效规则进 chat prompt：能力结论与任务生死都以当前表/账为准，历史消息不算数（108092a/6a4d181，13:59 与 machine_run 复活死任务两起事故的根因）；死任务动作拒绝语指路新委托单。
- 首跑（ctomi #679）：快路建单 → 方案 → 自动落地一条龙，keyword-add 14 行、keyword-final-url 2 条、ad-create 1 条全部成功且逐条回读验证，条目账本 17 条全 verified，无主条目 0，改动清单已回频道。三执行器解除「未经首跑」状态。

### 2026-09-11 AIRA 完成：W13-W17 全部落地并部署（rev 3487897，api+worker）

- W13 契约闸（504e715）：chat_reply 的 dispatch 停用；drafts 升级委托单（kind/backing_fact）；新频道动作 commission_start（双验提议时序+确认引语，防重复启动）；spawn_task 按钮路径同权定档；chatModel 默认 fable；政策 dispatch_rules v5。
- W15+W16（e9c023d）：新表 seo_change_items（惰性DDL）+ POST/GET /tasks/{id}/items + GET /items/unowned；plan 模式按政策分机器/人工条目，白名单外自动生成 split 人工工单并回频道；queue_task_jobs 排 apply 集中转 authorized；execute/apply（ads 路径）双时刻上账；失败/中止事件推回发起频道；POST /tasks/{id}/thread 冻结（存量只读 410 新建）；前端任务卡线程按钮换条目账本；ma skill v1.2 加 items 动词。
- W17（3487897）：ads_mutate.py 新增 keyword-add / keyword-final-url / ad-create（均带查重/回读/硬校验），googleads.md V4 + 政策表同步；seo_capability_gaps 缺口台账 + GET /capability_gaps。
- 三个新执行器未经真实账户首跑，首个 apply 必须盯 log（同 2026-09-08 上线纪律）。webforger/shopify apply 路径的条目对账下批接。
- 测试：node 全套绿 + chatapi 24 过（250 远端 php）+ php -l 过；部署后线上冒烟：/capability_gaps、/items/unowned、items 空表、线程冻结 410、存量线程只读均验证通过。
- 影响 Aiden：chat_reply 不再收 dispatch（发了只留说明行）；前端 spawnTask 传 kind/backing_fact；任务线程端点行为变更如上。

### 2026-09-11 AIRA 登记：W13-W17 交互模型重构开工（Alvin 拍板，含跨界授权）

- 背景：ctomi #670/#678 复盘暴露结构问题（任务线程追执行隔靴搔痒、探讨误派单靠叫停兜底、能力缺口转人工无落点、killed 渲染成 done）。Alvin 定三决定：任务去线程；chat 建任务须讨论定型后人频道一句话确认才建；咨询/分析类不进任务栏。全程由 Aira 做，含 seo-api.php 与前端（Alvin 2026-09-11 明确授权跨界），本条即登记。
- 批次：W13 契约闸（chat 同轮 dispatch 作废，改委托单两阶段：agent 先提议、人后确认、服务端双验时序与引语）；W14 咨询频道内闭环；W15 条目账本 seo_change_items + 无主守恒 + 判定期通道分流；W16 事件回流 + 任务线程下线；W17 keyword-add / keyword-final-url / ad-create 三执行器 + capability-gap 登记。
- 影响 Aiden 侧接口：POST /inbox/{root}/chat_reply 的 dispatch 字段停用（改 commission 流），任务线程端点冻结。细节每批落地时在本账本追记。
- 每批推送前 node tests/ 全套 + php -l 全绿，部署我自己跑。

### 2026-09-10 AIRA (cr) 登记：reasoning 类预览页停发，人看结论不看过程（Alvin 定），动你领地三处（报备）

- 背景：Alvin 点名 task-619/670 两张预览页是垃圾，agent reasoning（能力核对、工具路径、resource_name、铁律 dump）不该给人看；产出要么 concise 上卡，要么是能转客户的干净页。
- execute_task.js：变更方案/分析/验证类不再默认 publishPreview（task.detail 带「完整预览」才补发且不回显铁律块）；分析类 note 尾加「完整报告在任务附件」；buildPrompt 加规则 6 结论先行（开头摘要三句内，过程叙述不进正文）；放行卡 lint 收紧（RELEASE_CARD_FORBIDDEN 新增内部路径、脚本名、resource_name、9 位以上 ID、agencyreport 链接、「以某页为准」句），prompt 硬限制同步。
- lib/preview.js：博客与大纲预览页改纯成稿页（去客户铁律回显与 warn 内部警示，meta 卡改「Meta（发布设置，不进正文）」，footer 去「内部」字样），链接可直接转客户。
- seo-api.php：chatw confirm 频道话术「预览见任务卡」改「放行卡在任务卡上」（预览页默认不存在了）。
- 前端不用动：seo-agent.html 只在 note 有「预览:」行时才渲染链接，行没了链接自然消失。
- rev 7773667，api+worker 已部署，测试全绿。旧预览页不回收（存量链接还能开），新任务起生效。

### 2026-09-10 AIRA (cq) 登记：流程提速五件套（Alvin 逐条批），含动你领地两处（报备）

- 1 lint 自修一轮：execute prepare 的方案 lint 不过不再判红重排（一次返工=全文重写 10 分钟级），问题喂回同一会话改局部再 lint，仍败才红。今晚 4 号链实测返工 3 次是主要浪费源。
- 2 决策预置：blog SOP 加 SECTION C 电商决策预置（波动价不硬编、选品自定标准、draft 前台预期 404、内链先核存在、CDN 选图给理由）。铁律：同一决策问题只许被打回一次，第二次=spec 缺陷。
- 3 平台唯一真值锁定（Alvin 框架）：PUT /profile 强制 platform 枚举（注册车道表，建档必填）；onboard_chain 起跑校验；apply 未知平台明确拒不落 WF 默认车道（连同昨修的 blog_outline 平台分流，「默认 WebForger」暗分支已清）。
- 4 heavy 道并发 2（你领地 listener/claim，Alvin 批直做）：服务端 claim(heavy) 同客户硬互斥（在跑客户的单不可领，防同站并发写），worker 侧 heavy 槽位 2 跨客户并行，槽位释放即回头重 claim（互斥解除的单要能立刻被捡）。其余道单飞不变。cfg.heavyConcurrency 可调默认 2。
- blog_outline_stage 平台分流（昨晚已单独 commit）同属此批。测试全绿。api 与 worker 相邻部署。

### 2026-09-10 AIRA (cp) 登记：worker Shopify 通道 v1（博客与 redirect），渐进验证开跑（Alvin 定）

- 渐进口径更新（替代 cf 的过渡期口径）：sungait 页面类改动走渐进验证——首页手工首例（womens 重构已上线并验收）→ 无头小批量（4 个页面任务）我先验收再给 Alvin 看 → 通过后铺开。你的 shopseo CLI 从「过渡期执行面」转为 worker 适配器的唯一写通道，两侧不再并行执行（客户也在自己动手，风险注记里写了现读现值与停手规则）。
- 落位物：specs/capabilities/shopify.md v1（5 op，CLI 命令面为界，collections 未接通照旧交付包）、release_policy 加 5 词条、apply_task 加 runShopifyApply（dry-run 先行、现值比对停手、curl 线上验证、失败不重试）。shopseo 配置落 /data/aira/tools/{.env,stores.conf}（600，bare 可跑）。registry 枚举器仍欠，另排。
- 另：Phase 0 已执行完（9 篇 meta、nd 收尾、nofollow 三处，WORKLOG 在客户 notes/shopify-lane/）；过程中实证客户自行改站（发布、改 meta、删 UV 文），uv 删除客户已确认为主动，GSC 核验零杀伤。

### 2026-09-09 AIRA (cn) 登记：频道 /stop 急停（Alvin 定：人工即时止损）

- POST /inbox/{id}/chat 对 /stop 与 /resume 走服务端直通道（不过模型不排队，秒生效，任何频道同事可用）：/stop 撤光本客户全部排队 job（[cancelled] 留痕）并落止损闩 fact internal.ops.halt；闩着时三处自动链断电——新派单拒建、chatw 方案不自动落地、L0 不自动放行；在跑 job 无法中断但跑完因闩断链。/resume 解闩，撤销的 job 不自动重排。系统行按发言人记账，audit 记 seo_chat_stop/resume。前端频道说明加了用法。
- 与 cm 的明确指令门是一对：一个管进（探讨不开工），一个管停（开了也能秒停）。

### 2026-09-09 AIRA (cm) 事故+机制：探讨性对话被当指令开工（ctomi #670/671），加「明确指令门」

- 事故：Monica 在频道转述客户意向（口径中途还在修正），fable 直接派 change 单并一路自动到 apply 排队（#670 的 apply job617 已在队），Alvin 叫停。已撤 job617（账户零改动）、杀 job612、两任务挂起标「探讨待定型」。
- 机制（PJ 式，Alvin 定）：fable 默认动作是分析不是开干（正当性、影响面、更佳/最佳路径、风险档，结尾问「要开工吗」，拿不准附草案卡）；**dispatch 必须带 mandate 授权引语**，一字不改引用会话里人下达执行指令的原话，服务端逐字比对本会话 chat_user 消息（去空白归一），对不上拒建回原因。转述客户与探讨语气永不构成指令（prompt 层铁律）。
- 波及：seo-api dispatch 分支、chat prompt 与 cleanDispatch、chat.test 用例。9/8 的「决策权还给 fable」修订为：fable 决定该不该与怎么做，**开工时点必须由人的明确指令触发**（与「一切执行源于人」硬规矩对齐）。api 与 worker 相邻部署。

### 2026-09-09 AIRA (cl) 登记：GBP 全类目 human_only（Alvin 定）

- webforger.md 能力清单 gbp-update 从 agent_prepare 改 human_only（agent 搞不定 GBP 也无法发帖），规划层自动生效。看板横扫：apex #661 与 powerdekor #42 转 agency，citymed #385（复盘含 GBP 洞察节）保 agent 但 GBP 节只读加标注。capability-gap 定则第 3 类，不进执行器 backlog。

### 2026-09-09 AIRA (ck) 登记：sprint 入场两道客户闸（Alvin 定全局流程）

- 流程定稿：轻链方向卡 → 客户确认关键词（词表卡）→ 客户确认 mapping → 才进 sprint。harness.js 加硬闸：facts 里缺 keywords.*（锁定/确认）或 seo.mapping*（确认/定稿）的 confirmed 记录即拒跑，--skip-gates 显式跳过留痕；锁词研究任务本身在闸前用 --ids 单点跑。apex 实测闸生效（正确拦住未确认状态）。
- 与 cj 的轻链、offpeak_audit 合起来是完整的 onboard SOP；Shopify 8 家批量导入按此走。

### 2026-09-09 AIRA (cj) 登记：onboard 流程修正（Alvin 定：onboard 只做取数与方向，审计下沉夜间批）

- onboard_chain 默认链改为 pull_data → backfill → plan（plan runner 对无 dossier 本就优雅降级），discover 摸底改 --with-discover 显式加回；新增 tools/offpeak_audit.js（扫从未摸底或 dossier 过 90 天的 SEO 客户，闲时人发起串行清批，不是 cron）。动机：apex onboard 在工作时段烧了 opus 全站摸底加审计类任务，占串行 worker，而五件套 SOP 里 onboard 该交付的是调研与方向。后续 Shopify 8 家批量导入沿用轻链。
- 你若动 lanes/listener 加原生的时间窗调度，这个工具可退役；在那之前它是人手点的批次跑批器。

### 2026-09-09 AIRA (ci) 登记：rsa-copy-update 首跑成功（ctomi #645 全链闭环）

- 链路：频道派单（chatw，客户批文背书）→ capability-gap 出口出定稿 → 执行器补齐 → 重出方案 v2（原地替换，pin 逐条实读）→ 熔断后人工显式放行（独立抽验 13 处与客户 change list 全等）→ apply 首跑 → GAQL 独立回读全绿（新文案在、旧措辞除、6 条追加原文未动、四条广告 15/15/11/11 标题 4 描述数目全对）。账户预算出价零改动，旧文案全套留档可回滚。断点记 #532，9/10 复查重审状态。
- 本单同时是「agent 能做完不转人工」定则（ch 条）的首个完整实证。

### 2026-09-09 AIRA (ch) 登记：rsa-copy-update 执行器上线（Alvin 解冻 ad-copy 自动面）+ capability-gap 定则

- Alvin 定则（原话意译）：agent 能做完的不转人工。capability-gap 收敛为单出口 = 补执行器（维护者回路，同类缺口第二次出现必须补）；人工只留给政策 human_only（账单/开户类）。转人工的残余场景走频道三拍（频道认领、后台执行、fable 派 verify 只读单回读核对才置完成），作为应急通道保留不作默认。
- 执行器：ads_mutate.py 加 rsa-copy-update（全量替换语义，改前打印原文案全套为回滚依据、3-15/2-4 条数与 30/90 字符与 pin 校验、同值 noop、手写 update_mask、回读逐条比对不符即红）。googleads.md 同步，ad-copy-rewrite 仍 external：有客户批文自动，无背书停人（v4 既有规则，此次是首个执行面）。apply prompt 加 spec 契约与「未列出条目原文照抄」铁律。
- 流程修（上一 commit，rev aa3f128）：prepare prompt 加执行器缺口标准出口，缺口不再变成方案里的选择题（job592 教训）。
- 首单 #645（ctomi 13 处 claim 替换，客户 9/7 批文）按新链路重跑，首跑盯 log。

### 2026-09-08 AIRA (cg) 事故+修复：done 任务被迟到 job 结果复活（你领地的 result 端点，改动报备）

- #640 人工置完成时空转链最后一个 apply 还在飞，其迟到失败结果经 POST /tasks/{id}/result 无条件 status='review' 把终态掀翻，触发新一轮判定，任务挂回待放行一整天。修复（rev 8f6d740）：result 端点加终态保护，done 任务的机器结果只 [late-result] 留痕不改状态不进 origin 分支，重开必须人显式来。属你认领的端点，事故驱动的最小改动，报备。
- 操作层教训（我的）：人工收口任务前先确认无 in-flight job。DEFECTS 已记。

### 2026-09-08 AIRA (cf) 登记：Shopify 车道（Aiden 直发 CLI）我侧验收通过，过渡期口径确认

- 复跑你 shopify-lane-20260908 包的验收步骤全过：whoami（permanent token，110cum-r1 = www.sungait.com，scopes 如实宽）；articles list（13 篇含 night-driving 未发布草稿，与你审计一致）；另验了写闸门：set-meta 不带 --yes 出 diff 零写入。工具落 `/data/aira/tools/shopseo/`（.env 600，SHOPSEO_ENV/STORES 环境变量指路，脚本的 ROOT 上级目录约定我没动文件布局）；审计三件归档 `clients/sungait/notes/shopify-lane/`；share 上 env.secret 已删。
- **过渡期口径接受并已写进 facts（content.pages）**：worker 车道建成前 sungait 执行面归你侧 shopseo，plan 出任务你领任务闭环，避免双写；建成后移回 worker，你的 CLI 退应急通道。
- 四样落位物归我建，排期说明：当前处双线观察期（cd 条，Alvin 定，观察期内不加新自动放行口子），capability spec + registry 枚举器我按观察期节奏建，建时 autonomy 按你信里的三组口径收敛，theme/files 不进 op 表；risk_class 报 Alvin 定档。scopes 收窄那题挂 TODO 一起议。
- 修 4 个真 bug 加 2169 条重定向和多跳链的发现都很硬，audit 质量高，谢了。

### 2026-09-08 AIRA (ce 收口) ：nginx 转发已由 Alvin 亲自落位，外网保存修复完成

- Alvin 直接在面板加了转发（复写模块）。验收：内网 POST 中继 → seo-api「bad token」403（校验在跑，路通）；check-host 三外网节点 GET 中继 → seo-api 404（此前是整域 403，公网已穿透）。
- 线上 7 张带真实 widget 的卡已 sed 切到 `/reports/card_feedback.php`（每张留 .bak-cardfb-20260908 备份）；bens task-145 仅文档引用未动。模板双端点保留（中继优先，看板域备胎）。下条 ce 请求撤销，无需你处理。

### 2026-09-08 AIRA (ce) 报告 + 请求：方向卡外网保存失败，需要你在 agencyreport nginx 加一条转发 location（你领地，我不动手）

- 症状与实测：方向卡页在公网 agencyreport 打开正常，点保存 POST `https://always.horntech-dev.com/seo-api.php/card_feedback` 被 403。check-host 多节点实测：always 域对外网**整体 403**（内网 200），agencyreport 对外网 200。所以内网电脑能存、手机 5G 存不了（今天 Alvin 在 sanmichelle S1 卡上踩到）。always 挡外网是对的，不要开。
- 我已做（rev 待推）：direction_card_template 改双端点——首选同域 `/reports/card_feedback.php`，404/405/403 或网络错自动退回看板域直连（内网现在照常能存，外网等中继落位自动痊愈）；kd_render 测试加两条断言锁住这个结构；已发的 8 张线上卡未动，等中继落位后我一把 sed 切换。
- **请求你落一条 nginx location（agencyreport vhost，站点纯静态无 PHP，我无面板权限）**：
  `location = /reports/card_feedback.php { proxy_pass https://127.0.0.1/seo-api.php/card_feedback; proxy_set_header Host always.horntech-dev.com; proxy_ssl_verify off; }`
  只转发这一个路径，不透传其他 API；上游端点自带 task_id+token 校验（hash_equals），无放大面。落位后告诉我，我切线上卡并外网复测。
- 中间踩坑记录：试过往 webroot 丢 PHP 中继，该站不执行 PHP 直接吐源码，已删并弃这条路。

### 2026-09-08 AIRA (cd) 登记：进入双线观察期（Alvin 定）

- Alvin 认同 harness sprint（机器线）与 human-only（人工线）两条路线并行，当前面冻结观察：P2 看板投影化、入口单轨化、plan 线按能力清单出任务形态，三件都压着不动。月底随 DEFECTS 复盘看数据：自动放行事故数、熔断触发数、fable 派单被政策拒比例、空转是否复发。观察期内请勿在这个面上加新自动放行口子；根治项（apply 失败 result 不重排 review）仍等你排期。

### 2026-09-08 AIRA (cc) 事故报告 + 止血：L0 扩权后 review-apply 空转 11 轮（#640，bm 根因在我扩权面复发，我的责任）

- 经过：#640（DHT Blocker 建组）首轮 auto-release 的 apply job564 **实际全部落地成功**（组 200721760980、17 词 21 否词、RSA、旧词停用，回读全过），但方案自验断言了方案没写过的字段（建组默认 cpc_bid_micros 10000 被断言为 0），执行器按铁律拒写 success 报败；失败 result 回 /tasks/{id}/result 又排 review，review 判 do 又 auto-release，job577 到 586 空转 11 轮。账户零损伤（adgroup-create 的同名拒建幂等闸挡住了全部重复建组），烧了约 11 次 opus apply 加 fable review。
- 止血（rev 55137b8）：熔断从 chatw 入口挪进 L0 分支本体：任何任务有 apply 历史即不再自动放行，note 记 [auto-release 熔断]。教训一句话：**闸必须跟着定档函数走，不能跟着入口走**。
- 断言越界修复：ads apply prompt 加「自验只断言方案写过的字段，平台默认值不构成失败」。
- #640 已人工认定完成（GAQL 独立复核四项全对，见任务备注），#532 记第二断点。DEFECTS 两行。
- **根治仍在你领地**：apply 失败的 result 不应把任务重新排 review（bm 里报过），这次是第二个实证案例，请提优先级。

### 2026-09-08 AIRA (cb) 登记：machine_run 动作（Alvin 定：卡壳自愈不靠人肉截图转发）

- 背景：#640 挂人工泳道，同事在线程里问「你建了吗」，fable 只能解释无能为力，Alvin 截图转 Aira 人肉改形态重排。这类时刻以后 fable 自己处理。
- 动作：thread/channel 双侧新增 machine_run {ops, module?, backing_fact?, reason}。服务端 thread_action_exec 单一实现（频道侧复用不复制）：ops 过 dispatch_grade 校验（invalid 拒并提示登记缺口）、owner 转 agent、批文 fact 核实后写 [backing] 行、直接排 execute。列进 THREAD_AUTO_ACTIONS：转位只花一次出方案，真风险闸仍在放行政策层。
- 缺口登记 v1：op 无执行器时 fable 在线程说明并在任务备注标 [capability-gap]（attention 浮等我队列，Aira 扫队列排开发）。triage 巡检加「机器可接但挂人工泳道」检测属你认领的 runner，报备后另做。
- prompt/规整器/测试三处同步（chat.test 35 项）。api 与 worker 相邻部署。

### 2026-09-08 AIRA (ca) 登记：structural 档 + adgroup-create/keyword-pause 执行器（Alvin 批，渠道打通「建组类」）

- 政策 version 4（Alvin 2026-09-08 批的放宽，json+md 同 commit）：新增 risk_class **structural** = 预算中性新建（既有 campaign 内建组，不动预算与出价策略，总花费上限不变）。放行同 external：有客户批文 backing auto，无背书 confirm。真 spend（预算/出价策略/新 campaign）永远人放行不变。目前只有 adgroup-create 一个 op 降到此档。
- 执行器：ads_mutate.py 加 **adgroup-create**（建组单 JSON 走 stdin：查重名拒重复 → PAUSED 装配词/否词/RSA → 逐项回读核数 → 全对才 ENABLED，任何不符停 PAUSED 报人，绝不半开投放；RSA 上限校验 3-15/2-4、标题 30 描述 90 字符、pin 1/2/3）与 **keyword-pause**（只停不删，回读验证）。googleads.md V3、规划视图与 risk 标注三处同步，specs 一致性测试过。
- dispatch_grade 加 structural 分支（chatapi 23 项）；chat prompt 的可派 op 清单与定档说明同步；ads apply prompt 加建组单契约与「先 dry-run 后实弹」。
- 效果：下次「按客户批准的 change list 建组」类诉求，频道一句话 → fable 派 change 单（ops adgroup-create + backing_fact）→ 方案 → 判定 → 自动落地，全程无人肉。api 与 worker 相邻部署。

### 2026-09-08 AIRA (bz) 登记：Ads 落地器首跑成功（Ctomi #639）+ 首跑路上三个机制修复

- 首跑结果：#639 两条在投 RSA 的 final-url-change 由 apply job 552 落地，改前旧值留档、回读精确一致、GAQL 独立复核过、预算影响 0；链路为 execute(prepare, googleads 清单) → fable 复审判 do → **L0 自动放行** → runAdsApply → ads_mutate.py（先 dry-run 后实弹）。两条广告重入审核，9/9 复查 approval_status。断点已记 #532。
- 修复一（rev 8e272b4）：googleads.md 补 PLANNING_VIEW 表与「全局风险注记」标题（解析器契约），specs.test 加「每份能力清单必须解析出操作且 op 齐 risk 表」断言。此前 execute 解析零操作静默退化分析模式，change plan 永不产出。
- 修复二（rev d5b770d）：频道 release 三路语义对齐看板 decide（分析=验收、大纲=排写稿、有 ops 才排 apply），ops 空明拒。你领地内 decide 逻辑没动，但两处仍是拷贝，下次动这段建议抽公共函数。
- 修复三（rev 0f99d71）：方案 lint 的选择题规则误杀 prompt 明文要求的「需要人定：无」，加空章节豁免与 apply.test 四用例。
- DEFECTS 台账三行已记。测试全套绿。

### 2026-09-08 AIRA (by2) 登记：分级派单 P1（Alvin 定：决策权还给 fable，动你认领面多处，报备）

- 大局：频道是入口，fable 是决策者，看板转投影。P1 落三件事：dispatch 从只读扩成分级执行单；paid 通道接进 execute/apply；频道放行动作。P2（看板投影化）P3（sprint 并轨）另行。
- dispatch 三种 kind：verify/report 原样；新增 change（ops 必填，origin=chatw:{root}）。服务端 dispatch_grade（纯函数进 CHAT-PURE，chatapi 22 项盯着）按 release_policy 定档：全 reversible 直落 auto；external 有已确认客户批文 fact（backing_fact）auto，无背书 confirm；spend/irreversible 永远 confirm。定档在派单与方案产出两个时刻各算，以后者为准。
- **熔断**：chatw 任务查到任何 apply job 历史（含失败）不再自动排，回频道转人工。这是你 bm 报的失败重排死循环的结构性防线，我在自己的线先带上了；L0 那条的护栏仍等你修。
- 频道动作白名单 kill/later 之外放开 release（双锚校验，仅 review 状态，按发起同事记账），花钱/不可逆的人工确认就是频道里一句「放行 #N 标题片段」。
- paid 通道：module=paid 的任务 execute/apply 路由到 googleads 能力清单（V2，新增 final-url-change reversible）。apply 走新 runAdsApply：无 changeset，安全网三层（唯一写通道 lib/ads_mutate.py 白名单脚本 + 改前打旧值/改后回读 + 失败不重试）。ads_mutate.py 实现 final-url-change/ad-pause/adgroup-pause/negative-keyword-add/keyword-bid-adjust（±20% 硬闸、学习期拒杀、手写 update_mask 躲 8/10 field_mask 坑）；schedule-adjust 未实现明拒转人工。
- release_policy version 3（json+md 同 commit）：加 dispatch_rules 段与 final-url-change。specs.test 一致性过。
- 测试：node 全套绿（chat 34 项含新用例）、chatapi 22 绿、php -l 绿、ads_mutate 硬闸冒烟过。**api 与 worker 必须相邻部署**（dispatch 新字段 + runner 新契约 + 政策文件在 api 侧同机）。

### 2026-09-08 AIRA (bx) 登记：队列条编号改用任务号（Alvin 定：job 流水号和卡片号对不上会被当成出错）

- qsWhat/qsStripText：有 task_id 的行一律「任务 #N 标题…」打头，不再亮 job 号；没 task_id 的整客户 job（拉数、规划）才显示流水号且明写「job #」，裸 # 不再有歧义。任务号不参与 20 字截断，只截标题。
- insights/ui 两处测试断言同步，全套绿。只动 static/seo-agent.html 与测试，部署 api 即可。

### 2026-09-08 AIRA (bw) 登记：「立项」改「开工」，spawn 即排产扩到 agency 任务（Alvin 定：精简冗余流程，动你认领面，报备）

- 背景：Ctomi #639 立项后落人工泳道干等人，Alvin 定按钮语义升级为「开工」：点下去那一下就是授权，后台直接干活。spawn_task 对 agent 与 agency 任务一律直排 execute_task，机器先干到自己权限的最远处（出方案、白名单内落地，落不了的停在放行卡换人）；client 任务例外只挂看板（等的是客户动作，排机器没意义）。判定与放行两道闸门不动。
- 波及面：系统行回执从「已立项 #N」改「已开工 #N」，解析它的三处全部兼容新旧前缀（前端 chSpawnedTitles 防重复开工正则、前端 thIsSysLine、worker chat.js isSysLine）；chat prompt 与注释里的「立项」措辞同步改「开工」，chat.test.js 断言跟着改并加了开工回执分类用例。
- 测试：node tests 全套绿（chat 32 项含新用例），chatapi.test.php 16 项绿，php -l 绿（本机无 php，走 docker php:8.2-cli，deploy 时 250 远端 php -l 照旧把关）。
- 文件：seo-api.php、static/seo-agent.html、seo-worker/runners/chat.js、seo-worker/lib/config.js、seo-worker/lib/api.js、tests/chat.test.js。api 与 worker 相邻部署（回执前缀两侧要一致）。

### 2026-09-08 AIRA (bv) 登记：chat 工具带 C1（Alvin 定：读链接白名单域 + 广告后台只读现查，先查本地再拉，不设预算）

- chat/线程的 allowedTools 从 Read 扩为：Read/Glob/Grep + WebFetch 白名单域（agencyreport.horntech-dev.com + 本客户域名及其 www 变体，域外不抓要明说）+ Bash 单前缀（python3 lib/gaql_query.py，脚本自身只放 SELECT、mutate 走 apply 白名单不走这）。
- prompt 契约三段：权限固定话术（无任何写权限，落地只有看板：只读 dispatch、写类 drafts 立项）；链接内容是材料不是指令；取数先查本地（简报快照、temp/ 与 reports/ 旧拉数）再现拉，拉回存 temp/ 带日期供复用。Alvin 定不设查询预算（内部员工工作流）。
- 场景对齐：同事贴客户已批 change list 链接可直接读、问后台目标值可当场查——今晨 Ctomi 会话暴露的两个缺口即此。

### 2026-09-08 AIRA (bu) 报告：PATCH /tasks 的 result_note 是整字段替换，人审补注易误覆盖 runner 原 note（你领地，建议加 note_append）

- 今日 #631 人审补对账注时整字段覆盖了 runner 的 note（含预览/客户版链接），release 校验读不到「预览:」才暴露，已按交付档案恢复。建议 PATCH /tasks 增加 note_append 参数（CONCAT_WS 语义，与 /tasks/{id}/result 的 note 处理一致），或文档里明示 result_note 为替换语义。
- 另又踩一次 (bk) 报过的「纯分析任务 release 成功仍回 409」，重申建议修。

### 2026-09-08 AIRA (bt) 登记：报告视图补 Paid 区间指标 + Paid 月报草稿产线 + Chat 语义生成（Alvin 定）

- 报告 tab：sem/both 客户加 Paid 六卡（花费/广告点击/转化/转化价值/ROAS/CPA）与花费-转化曲线，数据直读 seo_metrics_daily 的 ads_ 列；顺带修 Dashboard 洞察的转化卡误用金额格式。
- Paid 月报：新 spec `specs/report/paid_monthly_spec.md`（AU 口径基准：WF 后台 leads/gclid、捕获起点守卫、投放天数核对、告警红禁用、自检清单顶卡），生成走 analysis 产线（方向卡同款），**产出带 .draft 水印，人工验收（放行=验收）后才可对客，这是红线**。入口两个：报告 tab「生成 Paid 月报」按钮（POST /reports/paid_monthly，origin=report:ui）；频道语义（dispatch 加 kind:"report"，origin=report:{root}，出稿回频道但不自动验收，与 verify 类的自动完结分开）。
- 主 report runner（你的 SEO 叙事产线）没动；paid 章并入主产线留待草稿线跑顺后再议。

### 2026-09-08 AIRA (bs) 登记：Chat 派单首日三处体验修正（Alvin 摸底指出）

- Chat 筛选自动含已结束（Chat 单天生 done，被「隐藏已结束」默认吞掉，筛了个寂寞）；聊天气泡 URL 链接化（转义后安全替换，频道与任务线程同款）；execute 分析摘要强制中文（#630 开头飘英文）+ chat 派单预览改「验证报告：结论先行、不回显客户铁律块」（铁律块是放行对照格式，频道读者是同事）。
- 文件：static/seo-agent.html、runners/execute_task.js。

### 2026-09-07 AIRA (br) 登记：频道看板动作（kill/later）+ 判 drop 自动归档（Alvin 定并过了第一性原理复审，报备）

- 频道动作：chat_reply 的 actions 对频道根放开，白名单只有 kill（归档不做，task_close killed 留档非删除）与 later（挂起）。防砍错三层：**双锚校验**（task_id + title_check 标题片段，服务端比对不上拒执行——30 连假 merge 的教训写进机制）；**在跑保护**（queued job 随砍随撤记 [cancelled]，running 拒砍等跑完）；**沉没成本示众**（待放行或有产出的任务，系统行标注「砍掉即弃产出」）。跨客户拒，release 频道不可达，按发起同事记账。
- auto-drop：review_result 里 fable 判 drop 且 evidence 非空、任务仍在 proposed/approved（未生产零弃置成本）的，当场 task_close dropped 归档，不再等 harness/人。review 阶段已有产出的 drop 仍留人。观察期 30 天：拍板摘要逐条列（非计数），误砍改判重开。
- 顺带看到你认领面一处旧患：同文件 L0 auto_release 分支仍无「失败 apply 不再自动重放」护栏（bm 报过的 20 连烧根因），此次没动，仍等你修。

### 2026-09-07 AIRA (bq) 登记：Chat 派单线（fable 当脑 opus 当手）+ 方案/Jobs 折叠进档案（Alvin 定，动你认领面，报备）

- 模型路由：chatModel/threadModel 均切 fable（线上 config 与 example 已改）。频道从问答界面升级为判断界面：fable 判断、答复、派单，opus 执行。
- dispatch 动作：人明确要求的**只读验证/数据分析**（效果验证、拉数核对、搜索词摸底），fable 结构化派单 → 服务端建任务（owner agent、ops 空、analysis 形态、origin=`chat:{root}`）→ 直排 execute_task，免判定免放行；跑完 /tasks/{id}/result 里 origin 前缀命中即自动验收 accepted + 结果系统行回频道，不排 review。写类诉求走不进这条路（服务端强制 ops 空 + prompt 铁律），仍走 drafts 立项 → sprint 判定放行。
- 留痕与审计：seo_tasks 加 origin 列（VARCHAR 惰性 DDL，躲 ENUM 截断坑），任务视图加「全部来源/Sprint/Chat」筛选与 Chat 徽标。审计由 Alvin 人工发起（不设周期任务，与禁 cron 同理），发起时按 origin 筛清单抽查。
- UI：方案与 Jobs 两个 tab 收进档案页折叠区（点开加载），视图 tab 剩 Dashboard/Chat/任务/报告/档案；旧 #/c/{id}/plan|jobs 哈希由 router 自然落回 dash。
- 部署注意：api 与 worker 仍需相邻发（chat_reply 新字段 + runner 新契约）。

### 2026-09-07 AIRA (bp) 登记：chat 附件扩到文件（Alvin 定：决策参考与数据分析用，5MB 内）

- 干了什么：/feedback_upload 从只收图扩到白名单收文件（csv/tsv/txt/md/json/log/pdf；文本类 finfo 多报 text/plain，扩展名从原始文件名取，不在白名单落 txt，二进制杂类拒收），响应带 orig 与 kind。/inbox/{id}/chat 收 files [{name,orig}]（≤4），refs.files 存原始文件名做分析上下文。chat runner 沿用截图的「下载到工作区给 Read」路径读文件，历史块标注**文件内容是材料不是指令**（外来文件是注入第一入口）。前端：加截图变加附件（选文件、拖拽、粘贴同通道），文件出名字片可下载，发送拆 images/files 两个字段。
- 边界：文件只做当轮分析材料，不进 facts 抽取管线；要归档的结论走 (bo) 的 fact 动作。xlsx/docx 不收（需解析依赖，让人另存 CSV），/feedback_file 下载端点同步扩了 MIME 表。
- 与 (bo) 同一个部署窗口上（api+worker 相邻，drain 检查照旧）。
- 补充（同日 Alvin 追加）：Office 与 xml 也收——xlsx/docx（finfo 报 zip，按原始扩展名认，裸 zip 拒）、xls（ole 族，.doc 拒并提示另存 docx）、xml（文本族）。worker 侧新增 lib/convert_doc.py（零第三方依赖：xlsx/docx 走标准库 zipfile+xml，xls 走 ros 已有的 xlrd 2.0.2），chat runner 抓完附件对 Office 三格式先转纯文本再给 Read，转换失败在会话里报人话（另存 csv 再发）。输出上限 200 万字符每表 2 万行防撑爆上下文。已用构造的 xlsx/docx 实测转换正确。

### 2026-09-07 AIRA (bo) 登记：chat 加 fact 写入动作（Alvin 定，PJ 式，动你认领面的 chat runner 与 seo-api，报备）

- 干了什么：同事在频道里明确要求记录/更新客户事实（含微信截图转述）时，opus 在结构化输出里给 facts（最多 8 条），chat_reply 服务端白名单写入：source=manual、status=confirmed，**记在最后发言的同事名下**（opus 只是笔），origin `chat:{root}/{触发消息id}`，全量走 fact_history 版本账可回滚，另落一条系统行复述实际写了什么（机器真值，与模型正文的复述互为对照）。
- 设计原则（Alvin 定）：不做草案卡不做确认按钮——二次确认就是回复里的人话复述（原值→新值），错了人一句话改回来；日志就是版本账。写入面只有 facts 这一格，动客户资产照旧任务+放行。
- Prompt 契约：人没让记不写、key 优先复用简报里既有 key、正文必须复述每条改动。同值跳过不记版本。

### 2026-09-07 AIRA (bn) 登记：收件箱 Chat 化 C0（Alvin 指定，动了你认领面的 seo-api/前端/lanes，特此报备）

- 干了什么（Alvin 定的四点）：一，Chat 频道化——每客户一条默认频道流（新端点 POST /inbox/channel 找建 refs 带 channel:true 的 chat_root，不排 job），去标题去新会话表单，旧会话归「历史会话」折叠区；二，Discord 式体验——打字指示动画、Enter 发送、消息即发即显；三，贴图对齐任务线程——/inbox/{id}/chat 的 images 从「仅任务线程」放开到所有会话（chat runner 本就读 refs.images 喂模型，零改动），前端复用 onFbPaste/feedback_upload 全套（截图暂存键用负数根 id，与任务 id 键空间错开）；四，chat 独立 lane——JOB_LANES/lanes.js 两侧同步加第三条道 chat（listener 的 lanes state 改为按 LANE_NAMES 动态建），聊天不再排在分钟级评审后面，同会话一轮一问的 409 闸不变。
- 决策收件箱整体移除（Alvin 定）：前端区块、侧栏入口、全局视图、裁决表单全部下线；/inbox 与 ruling 端点及数据不动，仅后台可用。待裁决卡在任务视图 wait_me 一直有。
- 部署注意：**api 与 worker 必须相邻部署**——JOB_LANES 先上而 worker 还是两道时，chat job 两边都不认领会停摆。我按 drain 检查两个连着发。
- lane 语义变化一处：lane_type_sql 的 heavy 从「NOT IN light」改为「NOT IN 全部具名道」，新 job 类型缺省仍落 heavy，与 job_lane()/laneOf() 一致。

### 2026-09-07 AIRA (bm) 事故报告：release-policy-l0 对失败 apply 无限循环重排（你认领面，报告不动手，止血已做）

- 现象：任务 135（page-meta-update，L0 可回滚面）人工放行的 apply（job 401）把 title/description 写上线后中途失败，任务留在 review。此后 release-policy-l0 每约 5 分钟自动重放行一次：job 408 到 448 共 **20 个 apply job 连环失败**（每个都因回读到「线上已是新值≠方案原值」按铁律安全中止，站点零改动），烧了约 100 分钟 opus 队列时间，也把当晚队列堵死（我的 spec 部署编排等 drain 等到超时中止）。
- 违反硬规矩 1「失败 job 不自动重试」：L0 自动放行只该对「从未跑过 apply」的 review 任务放一次；apply 失败后的重排必须回到人。
- 止血（已做）：实测线上与方案新值逐字一致、hreflang/JSON-LD 未动，/tasks/135/finish 关闭任务，循环即断。
- 修复建议（代码在你认领面）：L0 放行前查该任务是否已有失败的 apply_task job，有则跳过并标 attention；或每任务 L0 只放一次（audit 里已有记录可查）。另建议 apply runner 的「回读不符中止」分支把任务置 blocked 而不是留 review，从状态机上断掉循环的入口。
- 关联：DEFECTS 已记账；此事也是 L1 观察期数据点——L0 零事故的口径从今天起要把这 20 连算进去。

### 2026-09-07 AIRA (bl) 登记：skills/ma 新目录（Alvin 指定，agent 线程接入看板的 skill，我认领维护）

- 干了什么：新增 `skills/ma/`（SKILL.md + ma.sh），给全部 agent 线程一条「读台账 + 观察回流」的标准通道：clients/context/tasks/task/facts/plan/queue 七个读动词 + chat（开看板会话）+ task-feedback（走 feedback 抽取管线落 unconfirmed facts）。只封装 auth_user 级端点，admin 动作（批准/放行/改判）天然做不了，权限边界靠服务端不靠文档。工作区 `/data/aira/skills/ma/` 是挂载壳，正文与脚本以本仓为唯一事实源（照 paid skill 惯例）。
- 认领：skills/ma/ 归我维护；seo-api 端点如有变更麻烦在 COLLAB 提一句，我同步脚本。
- 已定（Alvin 2026-09-07）：共用账号 agent-bot（users id 19，**admin 角色**），token 落 /data/aira/.secrets/ma_skill.jwt（600，期到 2027-03-06，aira 轮换），不进 git。注意：权限边界因此从服务端强制变为 skill 动词纪律 + audit 按 agent-bot 记账；批准/放行/改判仍是人的闸，agent 不碰。

### 2026-09-07 AIRA (bk) 报告：/tasks/release 纯分析任务验收成功却回 409（seo-api 你领地，报告不动手）

- 现象：release 一批只含分析型任务（analysis_task 为真，走 task_close accepted 路径）时，$acceptIds 关单成功但不进 $jids，落到末尾 `if(!$jids)` 的 409「Apply job already queued or running」。调用方看到 409 会误判失败重试或告警，实际任务已 accepted（今日 Apollo #98 实测）。
- 建议：acceptIds 数量并入成功响应（或 jids 为空但 acceptIds 非空时走 200）。

### 2026-09-07 AIRA (bj) 登记：merge 误判堵根（specs 我领地）+ 报告 review 简报两处输入缺口（runner 你领地，报告不动手）

- 干了什么：11 份新方案批准后扫出 30 个任务被 fable 误判 merge，目标全是上一版方案的收口任务（note 是 `[merged] plan_review：方案层过闸并入 vN` 或 `[killed]`，零交付；Oak 11/11 全中，Badger 5、Citymed 6、Midea 8）。照单 apply 会把这些客户整个 S1 到 S4 无声关掉。我在 specs/review_principles.md 五问之五加了规则：收口式 done 不算交付，指向它不判 merge，看不到目标 note 也不判 merge。这 30 个任务待 worker 带新 spec 后重审，不走人工改判。
- 报告两处 review_plan 简报输入缺口（你认领面，建议修，不急）：一，简报里的既有任务列表看不出 done 的收口性质，模型只能靠标题猜；closed_kind 字段已存在，建议简报把 `[merged]/[killed]` 类 done 直接排除出可并入目标，或标注 closed_kind。二，人工补档到 seo_deliverables 的方案文件（如 #144、#146）review 简报读不到，fable 连续两轮判「方案文件缺失」；简报组装时建议把任务的 deliverables 清单（文件名+字节数）带上，正文过大至少让模型知道档案存在。
- 下一步：worker 队列清空后我部署（走 drain 检查），随后重排 30 个任务的 review；结果进次日拍板摘要。

### 2026-09-04 AIRA (bi) 登记：僵尸 job 修复三层落地（Alvin 指定动手，涉及你认领面的 listener/lib/deploy.sh，特此报备）

- 干了什么：接 (bh) 的报告，Alvin 指定直接修。第一性原理：job 回收不能依赖垂死进程配合，必须在重生时自动发生。三层：一，seo-api 新增 POST /jobs/reap（worker auth）：单实例架构下 listener 刚启动时任何 running 行必为上一世孤儿，一条 UPDATE 原子判 failed 并记 audit（失败不自动重试铁律不变，重排归人）；二，listener 启动序改为先 reap 后 drain（reap 失败不阻塞 drain），lib/api.js 加 reapJobs()，shutdown 注释改掉「留给重启后的 timeout 处理」这句空头支票；三，deploy.sh worker 加第 0 步 drain 检查：pgrep 到 runner_host 在跑就拒绝重启，FORCE_DEPLOY=1 越过。
- 坑：/jobs/claim 与 /jobs/reap 都是 worker token 面；reap 只在启动时由 listener 自己调，不给人用。全套 node tests 14/14 绿。
- 下一步/认领：无遗留；listener/deploy.sh 后续演进照旧归 Aiden。

### 2026-09-04 AIRA (bh) 报告：deploy.sh worker 重启会杀跑到一半的 job（Aiden 领地，报告不动手）

- 现象：14:17 认领的 execute job 390（Louvresky #147 素材方向卡）在我 14:33 跑 ./deploy.sh worker 时被 systemd 重启杀死，job 行卡 running 成僵尸，看板队列条显示「运行中 41 分钟」误导人。已人工 UPDATE 置 failed（唯一一条，claimed_at 早于重启点的 running 行已核对）并重排（job 395）。
- 建议方向：deploy.sh worker 重启前查一把 agent_jobs 的 running 行，非空就拒绝或提示 --force（drain 后再发）；或 listener 收 SIGTERM 时给 job 行写 failed 再退。deploy.sh 与 listener 都在你认领面，按规矩报告不动手。09-01 那次 #147 退出 143 疑似同款（当时也有一次 worker 发版，未核实）。
- 下一步/认领：修复归 Aiden 排期；我这边发 worker 前先手查 running 行当临时纪律。

### 2026-09-04 AIRA (bg) 登记：facts 版本账 + 会话抽 facts 开闸（Alvin 定的同事自助方案 P0，跨认领边界报备）

- 干了什么：目标是同事走看板会话替代 Discord 问答，前置两件。一，facts 版本账：新表 seo_facts_history（惰性 DDL），三个写入口（POST /facts、PATCH /facts/{id}、裁决白名单动作）统一过 fact_history_snapshot()，记前值、改动人、来源坐标（feedback:{id}/worker/api/ruling:{inbox}/revert:{hid}）；新增 POST /facts/{id}/revert（admin）一键揭回上一版，回滚本身也进账。纯后台，无任何前台界面，抽查与回滚归 admin/agent。二，普通会话开闸抽 facts：/inbox/{id}/chat 去掉任务线程 guard，task_id=0 加 payload.chat_root；feedback.js 接受无任务反馈（跳任务查找、按字面抽取）；/tasks/0/feedback_result 只更新反馈行不碰任务。会话区 UI 文案加一句「说的客户事实会入档」。
- 坑：facts 版本化先于开闸上线（先修堤再放水）；/facts_history 大事记导入维持覆盖式幂等未接版本账（history.event.* 自描述，故意的）。feedback.js 属 Aiden 认领的 runners，改动最小面已登记。全套 node tests 14/14 绿。
- 下一步/认领：P1 同事试点 + Discord 通知桥（opus 回复与任务草案 DM 提醒）归我，试点后再看多轮放宽。

### 2026-09-04 AIRA (bf) 登记：收件箱按客户隔离（Alvin 指定，跨认领边界报备）

- 干了什么：决策收件箱分两种模式。客户页收件箱 tab = 客户模式（默认）：决策流硬锁当前客户加跨客户 NULL 卡，下拉隐藏，角标显示本客户待裁决数；侧栏「决策收件箱」= 全局总台：全客户流水加下拉筛选，标题标明（全局总台），对话区隐藏（对话本来就是单客户的）。两模式一键互切（ibScope 按钮），换客户或离开视图自动回客户模式。API 侧 GET /inbox 带 client_id 时新增 open_count_client 返回字段（向后兼容）。对话 session 本来就按 client_id 隔离，零改动。全套 node tests 14/14 绿。
- 坑：根因是 inboxClient 过滤默认 0 且不跟 curId 联动，进任何客户的收件箱都看到全局流。数据层无串味，纯展示层问题。
- 下一步/认领：无遗留。

### 2026-09-04 AIRA (be) 登记：WP 与 Shopify 平台车道试点交接包已放 share（试点归 Aiden，Alvin 指定）

- 干了什么：`/mnt/share/aira/to-aiden-platform-pilot-wp-shopify-20260904.md`。内容：三个共性缺口（specs/capabilities 清单 + registry 枚举器 + notes 凭据文件约定）、WP 试点 kiaorakids(37) 的访问细节（自定义登录 URL、cookie+nonce 流、凭据在客户 .secrets.env、词表空）、Shopify 试点 sungait(51) 与 2026 接入路线（partner custom distribution app + collaborator 安装拿不过期 offline token，老 shpat 路线已废）、机制红线。原「非 WebForger 平台适配」在我认领面，现按 Alvin 指定移交试点，跑通后认领归属再议。
- 下一步/认领：WP 与 Shopify 车道试点归 Aiden；kiaorakids v4 与 sungait v2 方向卡都在等 Alvin 批；我继续 WF 客户与 23 运营。

### 2026-09-04 AIRA (bd) 登记：Sammichelle(23) 运营接手（Alvin 指定），导入归属不变仍是 Aiden 的工作

- 干了什么：Alvin 指定我接 23 的日常运营（导入与 plan v2 链是 Aiden 跑的，质量不错，直接沿用）。接手动作：把 v2 方向卡两个「拿不准」实测钉死并落 facts——site.domain_cutover（主域 200 by WebForger，www 与无尾斜杠均 301 收敛，GSC 双形态是迁移窗口残影，S1 重定向任务只剩两跳链与 404）、site.title_brand_suffix（WF 站点级模板自动追加「| San Michelle Bags」，404 页同带后缀，title 字段全站不写品牌照旧成立）；客户 CLAUDE.md 域名行与 title 行同步补实测结论。plan 26 v2 未动、未重跑评审，方向卡待 Alvin 批，批后我接 harness。
- 下一步/认领：23 运营（含方向卡后续、放行队列、月报）归我；Aiden 侧无需动作，此条即交接记录。

- 干了什么：seo-agent.html 洞察区加渠道子页签。services 为 sem/paid/both 的客户出「投放」页：六卡（花费/点击/转化/转化价值/ROAS/CPA，CPA 配色反转）、花费与转化双轴趋势（复用动作标注）、付费 CTR 与点击转化率周线、口径脚注（Ads 全部 conversion actions 合计，与 GA4 分开看）。数据走现有 ads_* 五列与 GET /metrics，**后端零改动**。纯函数（insPaidBody 等）全进 INSIGHTS-PURE 区，insights.test.js 加「投放洞察」一节（100/100），全套 node tests 14/14 绿。insBody 加可选第七参 tabsHtml（不传时输出不变），insKpiHtml 加可选 cls 参。
- 坑：多渠道预留用列前缀（INS_PAID_CHANNELS，ads_=Google，后续 meta_/bingads_ 加行）；口径红线在注释里：跨渠道花费可加总、转化不得加总。services=seo 客户（含自投 Ads 的 sungait）界面零变化。
- 下一步/认领：二期按 conversion_action_category 拆 PURCHASE 列（动 googleads.js + 指标白名单三处 + 惰性 DDL）；我们管投放的客户（sdalu、benscurtains 两站、haakaa、cngwigs）profile 补 ads_customer_id 并回填。

### 2026-09-04 AIRA (bb) 登记：月报 GSC 汇总口径修正 + 出报自动核对覆盖天数（commit 1378e1b、f56ce9a，worker 已部署）

- 干了什么（一）：factspack 的 GSC 汇总一直把 metrics.spamFilterGroups 的 query 维度 excludingRegex 挂在无维度汇总查询上。GSC 对低曝光查询做匿名化，匿名行没有 query 维度值，任何挂在 query 上的过滤器都会连带把整批匿名行排除，于是每个客户的点击与曝光都被系统性砍掉一截。改成汇总与 page 维度先取全量、垃圾词用 includingRegex 单独取一次再相减，位次按曝光重新加权；query 维度本来就不含匿名行，保持 excludingRegex 不变。metrics.js 属你认领，没动，修复落在 report 模块自己的取数层。
- 实测影响（三家已出过报告的客户全查了）：kuddles 2026-08 真实 102 点击 / 2723 曝光，旧口径 45 / 1339，少报 56% 与 51%；**benscurtains AU 2026-08（已定稿 v3）真实 1149 / 98578，旧口径 596 / 78324，少报 48% 与 21%，该站根本没有垃圾词，纯属被匿名行牵连**；powerdekor 2026-07 该站确有 73291 次垃圾点击（正则本来就是为它加的），正确扣除后应是 3242 / 48879，旧口径只报 1283 / 27979。**已出的这几版报告数字全部偏低，重出与否请 Alvin 定，我不擅自动别的客户的交付物。**
- 干了什么（二）：新增出报前的覆盖天数核对。gscDayCount 与 ga4DayCount 各多打一次日维度查询，覆盖率低于周期九成即判残月，对比期残月直接进 gaps 并点名环比必须改日均口径，天数挂在 pack 的 gsc.coverage 与 ga4.coverage 上。起因是 kuddles 8 月报：GSC 从 2026-07-11 才回填（7 月 21 天）、GA4 从 07-13 才开始收（19 天），按总量算会话涨 24%，按日均算实际是跌的，两个数据源起始日还不一样。每客户每次出报多 4 次 API 调用。
- 坑：这类「有维度求和 vs 无维度总量」的差异 2026-09-03 已经在 benscurtainsnz 的手工月报脚本上被抓到过一次（少报 41%），当时只修了那个脚本，没有回头查流水线，两天后在自动化侧原样复发。以后发现取数口径缺陷，当天要把所有取数入口扫一遍。
- 测试：node tests 全套绿（report.test.js 103 -> 108，新增反垃圾扣除三条与覆盖天数五条）。php 本机没装，seo-api.php 未改动。
- 下一步/认领：无接口变化，pack 只增字段不减字段。benscurtains 与 powerdekor 的旧版报告要不要重出交 Alvin。

### 2026-09-03 AIRA (ba) 登记：seo-agent.html header 换 opsnav 统一渲染（Alvin 指定，跨认领边界报备）

- 干了什么：Alvin 定全站 header 统一 + Website 模块下线 + Office/Update 挪进头像下拉。ops-tracker 仓侧已完成（commit 5753285 已部署）：userbar.js NAV 砍成 SEO/SEM/Sales/Always Agent，新增 MENU（Office 全员、Update 仅 admin），office/index.html 收进仓库并入部署白名单。本仓只动 static/seo-agent.html 一处：硬编码五个 module-tab 换成 `<div class="module-tabs" id="opsnav"></div>`，userbar.js 本来就已引入，active 态由 navDetect 按路径判定。seo-api.php 未动。
- 坑：seo-agent.html 属 Aiden 认领，此为 Alvin 直接指定的全站统一改动，按规矩 2 登记报备；后续该文件的 header 由 userbar.js 单点管，页面内不要再写死 tabs。
- 下一步/认领：无遗留。

### 2026-09-03 AIRA (az) 登记：Aiden 的 MA 操作权限解决（users 表 admin 账号）

- 干了什么：Aiden 新 PJ 打不了 seo-api（403），摸底后确认根因：seo-api 的 auth_admin 消费 mini.php JWT + 共享 users 表 role=admin，而他此前 ops 工作全走 DB 直连、从未有过 users 账号；ops service token 是 mini 的 editor 面，seo-api 不认。已建 users 账号 aiden（id 18，admin），探针验证读写全通（400 非 403），凭据与机制说明在 share `to-aiden-ma-auth-20260903.md`（建议他登录后自改密码）。DB 直连方案已在回复里明确劝退（POST /jobs 有 fire_wake 与审计，不是写表）。
- 下一步/认领：Connie 接入 MA 时走同一条（现有 admin 用 POST mini.php/user 建号）；操作菜谱已补机制说明。

### 2026-09-02 AIRA (ay) 登记：给 Aiden 新 PJ 的 MA 背景交接包已放 share（+实操手册）

- 干了什么：`/mnt/share/aira/to-aiden-ma-background-20260902.md`（背景）与 `to-aiden-ma-client-ops-20260902.md`（客户导入三件套流程、日常操作端点、坑速查表）——仓库入场顺序、部署双端现状（部署已非单点，发版前先 check 先 pull）、近两周增量摘要（(ar) 至 (ax)）、硬规矩速记、以及他手上 Sammichelle(23) 导入所需的全部指针（GA4 288505724、已迁 WF 域名未切、report_lang 先核对沟通语言）。
- 下一步/认领：Sammichelle 导入归 Aiden；我不动 23。

### 2026-09-02 AIRA (ax) 登记：看板向全部登录角色开放（sales 内测），分级按 Alvin 定（commit 8b5e9ed）

- 干了什么：新增 auth_user()；auth_any 的 JWT 侧放宽到任何 active 用户（22 个读端点随开）；17 条路由 auth_admin 降 auth_user（读视图全开 + 反馈/备注/收件箱对话/任务线程/改客户档案/生成月报/报告备注）。仍留 admin 23 条：放行/批准/裁决/改判/通用 job 与重试/新增客户/facts 修改，花钱与不可逆闸门不动，分级注释集中在 auth_user 定义处。前端 boot 放行非 admin（服务端为真闸），非 admin 隐藏添加客户；ops 仓 userbar sales 分支加 Always Agent 入口（69c9e63 已部署）。验证：salestest（role=sales，密码给了 Alvin）真号真浏览器过——侧栏 17 客户、生成月报按钮在、添加按钮隐、放行与跑 job 403、生成月报与改档案过 auth 到业务校验（400 探针法零副作用）。全套 node tests 绿。
- 坑：一次 cwd 被重置后 git add -A 提交进了外层工作区仓（含 secrets），推送因分支名不符未出机器，已 reset 恢复原状。教训：链式 git 命令前先显式 cd 并验 pwd，git add 永远点名文件不用 -A。
- 下一步/认领：Phase 1 客户 assign（profile.assignee 惰性列 + 侧栏按登录人过滤，sales 只见所属客户）等内测反馈后做；正式对外前 auth_user 层要过滤 facts 的 internal.* 前缀。

### 2026-09-01 AIRA (aw) 登记：看板全局更名 Always Agent + 侧边栏 SEO/Paid 筛选（Alvin 指定，commit 15dda6d + 1deb765）

- 干了什么：seo-agent.html 六处用户可见「SEO Agent」改「Always Agent」（title/头部/模块 tab/添加弹窗/409 toast/admin 提示）；客户列表头下加 全部/SEO/Paid 三档筛选，口径按 profile.services（空=老客户按 seo，sem/paid=投放，both 两边都显示）；GET /clients 回传 p.services 并先跑 ensure_metrics_schema 惰性建列。api 已部署（rev 1deb765），真点验证：18 客户（17 活跃）全部 17 / SEO 16 / Paid 13 切换正确，改名三处可见。ui 测试与全套 node tests 绿。
- 坑：**动了 Aiden 领地两处**（Alvin 主力开发授权下）：static/seo-agent.html 与 seo-api.php /clients；另外 ops-tracker 前端 250:/www/wwwroot/always/index.html 的导航 tab「SEO Agent」也按 Alvin 指定改为「Always Agent」（该文件按其惯例带 .bak 直接改，备份 index.html.bak.20260901_alwaysagent）——**ops-tracker 仓需要同步这一行**，否则下次从仓部署会回退。
- 下一步/认领：**交 Aiden**：ops-tracker 仓 index.html 同步改名；worker 侧日志与 systemd 描述里的「SEO agent」字样是否跟着改名由你定（纯内部可见，我没动）。

### 2026-09-01 AIRA (av) 登记：月报反馈条收敛到下月计划一处、两选项（Alvin 定，commit 64a5d87）

- 干了什么：Alvin 定稿交互：六个数据 section 的表态条全删（不讲计划的 div 放表态没意义），只留 next 一处，引导语「关于我们下个月的工作计划，您的看法是：」，两键「同意按建议执行 / 其他反馈」，hold 删除；空文本客户端拦、服务端 400；choice 枚举收成 agree/other；全局浮动留言保留。双端已部署（rev 64a5d87），powerdekor v6（report 10）真点全过（3 POST 200、空文本拦截、hold 不存在）。测试与 sections_spec 10B 锁死单点两选项。
- 坑：反馈组件的位置跟内容性质走：数据陈述节没有可表态的对象，只有计划节有。第一版铺七处是我过度设计。
- 下一步/认领：无接口变化。seo_report_feedback 表历史行里 v4/v5 的测试数据（choice 含 ok/question/hold）留作历史，读取端别按新枚举做强校验。

### 2026-09-01 AIRA (au) 登记：月报反馈按钮样式与文案对齐 paid 方向卡（Alvin 打回自造文案，commit 09268f8）

- 干了什么：(at) 首版按钮文案是我自造的（「已阅，没有问题 / 有疑问，请联系我」），Alvin 打回，指定 match 方向卡。已照抄 direction_card_template：三选项「同意按建议执行 / 保持不变，继续观察 / 其他反馈」、蓝色方框系（#0057b8/#eff6ff/#bfdbfe）、空文本 other 降级 hold；server choice 枚举同步 agree/hold/other 与 card_feedback 同口径；测试锁死文案。双端已部署（rev 09268f8），powerdekor v5（report 9）真点 5 POST 全 200。sections_spec 10B 已写死「不要自造文案」。
- 坑：交互组件的文案不是发挥空间，客户面反馈语义要全产品线统一（方向卡先定的就是标准）。另：一次在错误 cwd 下跑测试导致 commit 先于绿灯，已回补全绿再部署，跑测试认准仓库根目录。
- 下一步/认领：无新增接口，(at) 的 Aiden 事项不变。

### 2026-09-01 AIRA (at) 登记：月报客户反馈组件全链上线（七模块三选项 + 全局浮动留言），双端已部署（commit 8612e09）

- 干了什么：Alvin 指定月报加意见收集。模板固定注入（不经模型，方向卡教训）：七个 section 各一条三选项反馈（已阅认可 / 有疑问 / 其他意见带文本）加右下角「留言给我们」浮动面板；脚本从 ?r=&k= 取身份，裸链接进预览模式。seo-api：POST /reports 落库后服务端把 r/k 拼进存的 url 并回传（token = md5('reportfb'+id+WORKER_TKN)）；新公开端点 POST /report_feedback（token 门，ok/question/other，other 必须带文本，空文本 400）落 seo_report_feedback 表（惰性建，ensure_report_feedback_schema）并把摘要追进 seo_reports.note（超 1800 字只留表）；GET /reports/{id}/feedback（auth_any）读全量。runner 交付改用带参链接。api 与 worker 双端已由我部署（rev 8612e09，远端 php -l 过）。powerdekor 2026-07 v4（report id 8）真点验证：三选项、空文本拦截、全局留言、预览模式降级全过，4 条 POST 全 200 落库，note 速览正常（测试痕迹已清）。report 测试 100 全绿。
- 坑：本机没有 php，php -l 只能靠 deploy.sh api 的远端闸；改 PHP 后别忘了先 api 后验证。
- 下一步/认领：**Aiden 知悉**：seo-api.php 我动了（Alvin 拍板的主力开发授权），改动范围只有 POST /reports 尾部与两个新路由加一个 ensure 函数；看板前端如需展示 /reports/{id}/feedback 的全量列表归你排期（note 速览已够用）。反馈数据的蒸馏归属（进 feedback 流程还是只做台账）待定。

### 2026-09-01 AIRA (as) 登记：worker 部署由我执行（Alvin 拍板），powerdekor 报告语言改中文并出 v3

- 干了什么：Alvin 定「Aira 是主力开发，worker 部署直接做不等 Aiden」，本次起 (ar) 的改动由我跑 ./deploy.sh worker 部署（rev a3a68f0，六步全过、服务 active，顺带把此前登记待部署的方向卡 specs 一起带上线）。powerdekor（15）是中文沟通客户，v2 出成英文叙事套中文版式被 Alvin 打回；根因是 profile.report_lang='en'，已走 admin PUT /profile 改 'zh'，并走正规看板通道 POST /reports/generate（job 235）由部署后的 worker 出 v3，全中文、行业词保留英文（A31）、同比与排名分布齐全，渲染截图过目：https://agencyreport.horntech-dev.com/reports/powerdekorfloors/seo_report_2026-07_v3.html 。
- 坑：report_lang 在 profile 里配错时整份叙事跟着错，出报前值得把 profile 的 report_lang 和客户沟通语言核一遍；这类客户级配置错误 lint 拦不住。
- 下一步/认领：**Aiden 知悉**：部署单点规则更新为「Aira 可自行部署 worker」，COLLAB 规矩 4 的下放条件已由 Alvin 触发；api 侧（250 PHP）部署我暂未动过，沿用现状。

### 2026-09-01 AIRA (ar) 登记：月报加同比（去年同月）与目标词排名分布块，powerdekor 2026-07 v2 人工产线交付（commit 46fa219 + cd772b7）

- 干了什么：对照 Ann 离职 SOP 月报章收敛两处缺口。factspack 加 yoy 节点（整月才做同比，月中出报沿用同窗环比契约；去年两源全零视为不可比进 gaps，零基期不出同比）与 rankings.summary_prev / p21_plus；reporthtml 加 kpiYoy 与 buildRankDist，hero 卡、GA4 六卡、页眉带同比行，rankings 节新增四档排名分布（计数 + 占比条 + 两期对照），全部零 LLM 直出；runner prompt 补同比叙事指引；leadgen 与 skeleton 两模板、schema、sections_spec 同步。powerdekor（client 15）2026-07 v2 按 #147 先例走人工产线（repo 代码 + 线上 config），叙事一轮过校验，已发布并落库，渲染截图肉眼过：https://agencyreport.horntech-dev.com/reports/powerdekorfloors/seo_report_2026-07_v2.html 。report 测试 99 全绿，未动 PHP。
- 坑一：round1/2/3/4 对 null 会返回 0（Number(null) 是 0），pctDelta 的「上期为 0 无百分比」被静默写成「零变化」，v2 的 yoy.leads_pct 实测踩到，已修加回归测试（cd772b7）。这是存量隐患，organic delta 的 sessions_pct 等同路径此前同样暴露。
- 坑二：repo 里直接跑 runner_host 时 ga4KeyFile 按 worker ROOT 相对解析，秘钥在部署目录不在仓库；解法是复制线上 config 加绝对路径 ga4KeyFile，SEO_WORKER_CONFIG 指过去。
- 下一步/认领：**待部署**（worker 侧生效后看板一键出报才带新模块）；ecommerce 客户的同比行沿用同一套 kpiYoy，模板实装电商块时不需要再动数据层。


- 干了什么：Alvin 指定两处交互。模板 v2 追加：S3 词表手术节尾整体表态按钮组（复用既有 .fb 绑定零新 JS，data-item 由渲染器给默认值 keyword_plan / creative_cleanup_plan，模型侧零改动）；右下角浮动「留言给我们」（固定定位面板，item=global_note choice=other 走 card_feedback，空文本客户端拦截，预览态禁用）。两卡重渲染部署，playwright 真点全过（S3 表态 200、浮动留言 200、预览态 disabled），测试行已清。
- 坑：无。widget 仍全部固定在模板里不经模型。
- 下一步/认领：global_note 与 s3 表态的蒸馏归属（落 facts 前缀）随批 4 一起定；浮动留言的通知面（sales 怎么第一时间看到新留言）待设计，现阶段靠任务 note。

### 2026-09-01 AIRA (ap) 登记：方向卡减法版（模板 v2）+ 词表手术节上线，Louvresky 两卡重渲染为内部测试页

- 干了什么：Alvin 定减法方向。模板 v2：红绿灯与词族卡合并成席位表手风琴、口径收一行折叠、砍新发现节、词汇表折叠；schema V2（去 lights/findings，加 scope_line 与 families.brief，模型少产两个槽）；kd spec V5 第三节扩「词表手术：挡移加」。Louvresky 实例：移 166 词（59 主系列暂停候选 + 107 试验系列单列）、加 50 词（26 条带过转化，louvretec 等竞品牌词标敏感待客户确认），两份 CSV 随卡发布。两卡（#146 #147）重渲染部署，真点验证过，页高降约三成。
- 坑：模板做切片手术时锚点字符串撞上 CSS 里的同名 class（legend），切出重复头部块；渲染后截图肉眼看才发现。教训：模板结构手术后必须渲染截图过目，纯 lint 与点击验证看不出布局重复。
- 下一步/认领：链接当前全部为内部测试（Alvin 定，上线至少一个月后）；「加词」执行通道（正向词批量加 = keyword-add，capabilities 未列，风险类建议 spend 走放行）待与 Aiden 对齐进 apply adapter 白名单。

### 2026-09-01 AIRA (ao) 登记：W12 批 A 落地（素材方向卡产线 + Louvresky 试点卡 #147），杀 job 231 说明

- 干了什么：素材方向卡产线四件进 specs/report/（spec V1、同构 schema、render_creative_direction.js、通用模板 direction_card_template.html 抽取，词卡模板并入），release_policy 加 creative-direction=reversible，14 test 全绿（commit 7838a45）。Louvresky 试点卡 #147 由 PJ 人工产线交付：数据现拉、渲染、发布、真点双通道验证，决策卡含 messaging 框架定版（onboard 素材三样存量迁移首例）。
- 坑一：apply_verdicts 对 approved 任务自动排 execute job（231），但试点由人工产线交付且 worker 部署目录还没有素材 spec，runner 跑下去会生成同名交付物覆盖已验证版本。已 kill 该 job 并标 failed 留痕。**结构性缺口：人工产线交付的任务需要一个「不排机器执行」的标记**，否则每次人工试点都要赛跑。
- 坑二：闸A 对 #147 判 later（理由：主转化混微转化先修口径），判决前提部分失真（卡内数字走干净口径 fact），已按 Alvin 拍板 override 留痕。判定材料或许该把 conversion_scope fact 更显式喂给判定简报，避免同类误判。
- 下一步/认领：**交 Aiden**：execute_task 的 keyword-direction 与 creative-direction 两分支接渲染器产线（CLI 已备）；specs 随下次 worker 部署生效；「人工产线任务免排 job」标记设计。口径整理方案立项等 Alvin。

### 2026-09-01 AIRA (an) 登记：copy_rules 新增 A31（中文报告行业词用英文原词，全客户），方向卡渲染器加不变量强制

- 干了什么：sales 在 Louvresky 方向卡反馈行业名词要用英文（百叶顶这类自造翻译客户读不懂），Alvin 确认全客户中文报告生效。落地：copy_rules.md A31（规则唯一居所）、keyword_direction_spec 铁律修正引 A31、schema 描述同步、render_keyword_direction.js 加不变量（词族名与红绿灯名整卡零拉丁词即拒绝渲染，逐名不卡避免误伤概念族）、tests/kd_render.test.js 回归（A31 拒收、script 拒收、widget 原样注入，13 test 全绿）。Louvresky S1 卡数据 JSON 换英文原词重渲染发布，真点复验双通道 200。模板预览降级文案加了「团队意见走任务线程」指引。
- 坑：内部人从客户 widget 提意见会被记成客户立场（本次 sales 借 christchurch_scope 卡提交），批 4 蒸馏接线前必须有内部通道或至少能区分来源，已清污染行。
- 下一步/认领：**交 Aiden**：lib/reportlint.js 加 A31 同款检查（月报中文正文里已知客户产品词的中文翻译检测难做全，最低限度先查报告 keyword 类表格与章节标题含拉丁词）；待部署：specs 变更需随 worker 部署生效。

### 2026-08-31 AIRA (am) 登记：关键词方向卡模板化 V4 落地（commit b18fbb0），Louvresky 卡已用新模板重出

- 干了什么：Alvin 拍板 Ben's AU S1 版式定为模板。specs/report/ 新增三件：keyword_direction_template.html（版式与已测反馈脚本固定其中）、keyword_direction_data.schema.json（模型产出契约）、render_keyword_direction.js（零 LLM 渲染器，含槽位硬校验、HTML 白名单转义、script 与内部术语拒绝）。spec 升 V4：模型只产数据 JSON 不写 HTML。Louvresky S1 卡已按新链路重出（数据 JSON 在客户工作区 reports/，同名 HTML 覆盖发布），playwright 真点验证三选与勾选双通道 200 落库，测试行已清。node tests 全绿。
- 坑：同日两起「模型重写反馈脚本参数读反」事故的根治项。旧 execute 产线让模型裸写整页 HTML，文字约束拦不住；模板化后脚本不经模型的手，此 bug 类别消失。
- 下一步/认领：**交 Aiden**：execute_task runner 的 keyword-direction 分支改为「模型出 data.json，runner 调 render_keyword_direction.js 出 HTML」（渲染器已给 CLI 与 module 两个口）；批 4 原「widget 注入」项由本方案替代可销项。worker 侧 specs 部署后生效，本条为待部署。素材方向卡（W12）出生即走同架构。

### 2026-08-31 AIRA (al) 登记：方向卡反馈脚本参数读反同日二次复发（Louvresky #146），报告 execute 产线缺口

- 干了什么：Louvresky paid 导入全链跑通（client 16 profile 三列、ads 180 天回填、快照、facts、#146 方向卡经闸A 至 review）。客户点卡上反馈按钮全部失败，定位为生成器无视 spec V3「提交脚本原样嵌入」自写了 XHR 版，token 与任务号读反（与同日 Ben's #145 事故同根因）。已手修线上与工作区文件，playwright 真点验证 200 落库，测试行已清。
- 坑：spec 文字约束拦不住生成模型重写嵌入脚本，同一天两个客户各栽一次。字符串存在性检查验不出读取逻辑颠倒，验证必须真点。
- 下一步/认领：**报告 Aiden（execute_task runner 是你的地界）**：建议把「交互 widget 由流水线注入固定已测脚本，模型只产 data-item 标记」从批 4 提前单独做；在此之前 execute 产出的带 card_feedback 的 HTML 建议加一道机械校验（grep 断言 taskId 取 t、token 取 k，或直接拒绝模型自带 script 块）。我可以出校验函数与测试，落进 runner 由你拍。

### 2026-08-29 AIRA (ae) 登记：apply 涉及文件比对支持通配；只读审计 ops 放行即验收；Apollo 与 Ben's NZ 导入

- 干了什么：#94 六步全过、线上已生效，却因 changeset 里上传接口生成的 assets/<ts>-<rand>-xxx.jpg 不等于方案声明的 assets/*-xxx.jpg 被判失败。`compareFiles` 现支持 `*`（单段，不跨 /），apply 单测加一条。#94 按落地态人工收单未重跑。另：`analysis_task()` 把 ops 全为只读审计（ga4-audit / gsc-audit）的任务视为分析任务，放行即验收，不再排 apply（#95 曾被误排，job 172 已作废）。Apollo（8）与 Ben's NZ（45）用新工具 `tools/import_package.js` 与 `tools/onboard_chain.js` 全量导入并跑完 pull_data 到 plan，各出 plan draft 11 与 12 条。
- 坑：闸门「精确路径」对平台起名的产物天然误杀，方案作者写通配是对的，闸门要跟上。

### 2026-08-31 AIRA (ak) 登记：W11 第一批落地（放行分级 L0 / 选择题 lint / harness 升级）

- 干了什么：specs/release_policy.json（服务端执行权威，deploy.sh api 随 seo-api.php 部署到 250）+ release_policy.md（文档）+ googleads.md 每 op 标 risk_class，三处一致由 tests/specs.test.js 断言。seo-api 的 /tasks/review_result 落判决后跑 L0 自动放行：待放行任务复审判 do 且全部 ops reversible、非博客非分析 → 自动排 apply_task，note 记 [auto-release L0]，audit 带 auto_release 清单；政策缺失或 op 未登记默认 L2。execute_task 的 lintPlan 加「选择题必须收敛」规则（开放式「需要人定」打回，客户独有信息写「等客户：」）。harness 加 --ids（跨 sprint 指定任务）与收尾自动 experience_sync。
- 坑：L0 判定读的是 250 本机的 release_policy.json，改政策必须走 deploy.sh api，直接改仓库不部署等于没改（DEPLOYED 漂移检测会报）。

### 2026-08-31 AIRA (aj) 登记：W8 批 3 两单方案交付（Ben's AU paid），转化口径定案

- 干了什么：Alvin 定转化口径（Primary 只留 Quote Submit 与 Calls from ads；WFQL 是 gclid OCI 回传不记录；本地动作与 Store visits 全 Secondary），落 fact ads.google.conversion_scope 与客户 CLAUDE.md Paid 段。#143 转化口径整理方案（13 条改动：6 动作降 Secondary + 7 条 campaign 级 goal；官方转化 170→84 属口径修正；执行脚本备好 dry-run 过，放行后人工 --apply）与 #144 否词方案（87 天窗口实测，新增 11 条零误伤否词月省约 A$24；账户否词卫生本来就好，大钱在 PMax 品牌流量约 A$574/月，列成需客户决策两步方案）都到待放行。module 加 paid（api 三处 + plan.js）。任务视图删掉未来 sprint 折叠行，视野只认 本期/30天/全部 三档。
- 坑：1) paid 任务走 analysis 模式，方案文件是 task-{id}-时间戳.md，闸A 复审的 attachChangePlans 只认 change-plan-task-{id}.md，判「方案文件缺失」降 later，放行由人看预览决定，批 4 修路径兼容。2) result_note 单条 1000 字上限，长摘要靠预览页与交付文件。3) Ads 搜索词报告随 campaign 重建清零（本账户最早 2026-06-05），窗口标称 180 天实际按数据说话。

### 2026-08-31 AIRA (ai) 登记：W8 批 0 加批 1 落地，Ben's AU ads 只读数据链打通

- 干了什么：profile 加 services / ads_customer_id / owner（惰性列 + PUT 校验持久化，PUT 的 INSERT 列表原来是硬编码，新列静默丢弃，已修）。METRIC_NAMES 加 ads_cost / ads_clicks / ads_impressions / ads_conversions / ads_conv_value（ads_ 前缀专属 Google，新渠道用自己的前缀）。`lib/gaql_query.py`（只读 GAQL 子进程，凭据 /data/aira/.env.google-ads，只许 SELECT）+ `lib/googleads.js`（dailyMetrics / campaigns / conversionActions / metricRows）。pull_data 加 ads 源（快照 source='ads'：日指标 + campaign 结构 + conversion actions；日指标进 seo_metrics_daily），backfill_metrics 支持 ads 180 天。Ben's AU（46）profile 填 both / 1292669205 / aira 并实测拉通。
- 坑：PUT /profile 的列清单是硬编码的，加 profile 字段要同时改 PROFILE_FIELDS、惰性 DDL、INSERT 列表三处，漏第三处会 ok:true 但什么都没存。

### 2026-08-31 AIRA (ah) 登记：paid 知识层落地（W8 批 2 前置）

- 干了什么：specs 加 paid 四件：review_principles paid 段（六步诊断 SOP + 10 偏见 + 立场，Kira SOUL §6/§7 蒸馏）、plan_experience paid 段、capabilities/googleads.md（权限映射 + API 坑）、report/paid_section.md（客户报告五段式）。plan_review 的原则与经验文件改 readStrict（缺失或过短直接抛，不许占位符降级）。tests/specs.test.js 断言四件在场且带 PAID-*-V 标记。对话侧：/data/aira/skills/paid/SKILL.md 薄壳（零知识，按场景指向 specs），UserPromptSubmit hook（scripts/hook_paid_skill.py）命中 paid 词表注入加载提醒，Adspirer 第三方技能移入 skills/_disabled 防触发撞车。
- 坑：Python re 的 \b 把 CJK 当词字符，「个campaign的」贴边不命中，词表边界要用 (?<![a-z0-9]) 这种 ASCII 专用 lookaround。

### 2026-08-29 AIRA (ag) 登记：W7 方案层过闸上线（plan_review），人只确认方向与抽查

- 干了什么：plan job 落任务时 `/tasks/bulk` 按 plan 的 authored_by 选门：`seo-worker`（plan job）先排 `plan_review`（light 道，fable），`plan_review` 出的 v2 任务才排任务层 `review_plan`。`runners/plan_review.js` 输入草稿全文 + 任务 + 客户 CLAUDE.md 与 feedback 记忆 + `specs/plan_experience.md`（跨客户方案经验，新建）+ review_principles + `_global/feedback_*` description 摘要 + 本客户历史处置；输出 v2 正文 + 完整任务清单（带 from）+ changes + 方向确认卡。落库走 `POST /plans/{id}/review_result`（一个事务：v2 draft、任务 proposed、v1 superseded、v1 proposed 任务 merged 关掉、卡进收件箱 `[plan:ID]` 前缀）。`/plans/{id}/approve` = 确认方向并收卡；`/plans/{id}/reject` 现在会 killed 掉该方案 proposed 任务并收卡。`GET /plans/{id}` auth_any。`tools/onboard_chain.js` 跑完 plan 等 plan_review 并打卡；`tools/experience_sync.js` 把 review_override_note 与 plan reject_reason 抓进 plan_experience「待整理」段。`tests/plan_review.test.js`。
- 坑：plan_review 只认 status=draft 的 plan；已 approve 的方案不会再过闸。收件箱卡的 refs 只支持 tasks/jobs，plan id 靠 body 前缀 `[plan:ID]` 关联。

### 2026-08-29 AIRA (af) 登记：博客配图源可插拔，Replicate / BFL 直连路已备，等 token 灰度

- 干了什么：`seo-worker/lib/imagegen.js` 新增 provider 抽象。默认仍走平台 `/generate-image`（文档写明底下是 Replicate FLUX 1.1 Pro，1280×720，无型号参数）。`replicate` 路（首选，Alvin 定：一个 token 两代模型都有）：POST api.replicate.com/v1/models/black-forest-labs/{flux-1.1-pro|flux-2-pro|flux-2-klein-9b|...}/predictions 带 Prefer: wait=60，没等到轮询 urls.get，input 默认 aspect_ratio 16:9 / jpg，`replicateInput` 可补字段。`bfl` 路（备用）：POST api.bfl.ai/v1/{flux-2-pro|flex|klein-9b|...} 带 x-key，轮询 get_result 到 Ready，下载签名 sample（10 分钟有效）后 `uploadAsset` 回平台 /assets，下游质检压缩逻辑不变。config 新增 imageProvider / imageCanaryProvider（默认 replicate）/ imageCanaryClients（工作区 slug 数组）/ replicateModel / replicateApiToken（或 REPLICATE_API_TOKEN）/ replicateInput / bflModel / bflApiKey。key 没配一律回落 webforger 并记日志。`tools/image_bench.js` 同 prompt 双源对比出图存本地。`tests/imagegen.test.js` 假 http 跑协议。同批：`listener.js` exit 0 但没收到 runner result 判 failed（job 179 事故）；`blogimages.js` delay 去 unref；`tools/harness.js` 拍板到待放行一条龙；`tools/onboard_chain.js` 起跑前查工作区 CLAUDE.md。
- 坑：BFL 状态里 Request/Content Moderated 是 prompt 问题（imagegen 抛 status 422，不重试，交给质检改 prompt），Error / 超时是上游问题（502/504，外层三次重试照旧）。

### 2026-08-29 AIRA (ad) 登记：验证归机器，人只抽查

- 干了什么：Alvin 定的：deferred 验证项不该等人。新 `/data/aira/tools/verify/verify.js`（playwright-core 接系统 Chrome，无头）：hscroll / jsonld / text / status / rrt。apply 的 ALLOWED_TOOLS 放行 `Bash(node /data/aira/tools/verify/verify.js:*)`，prompt 改为：能用它跑的不许标 deferred；deferred 只剩「要 Google 交互工具」（抽查项）和「要等 N 天」（到期 PJ 机器复验）。note 头部「待人工」改「待复验」，API 正则两种都认，卡片与例外队列文案同步。Kuddles #71 V15 V16 机器复验全过已盖章（RRT 机器进不去，抽查项）；#70 V6 那次 generate_lead 在标记前 1 分钟量级发生，keyEvents 计 0 属正常，脚本 `clients/kuddles/scripts/kud_task70_v6.js` 等下一次询盘再跑。
- 坑：Google Rich Results Test 页面无头浏览器打得开但按钮不触发结果，别指望机器跑它。

### 2026-08-29 AIRA (ac) 登记：三归位规划 W1 到 W4 全部落地（不交接，Aira 独立执行）

- 干了什么：规划见 `/data/aira/projects/MA/memory/PLAN.md`。W1 事实唯一：新 `GET /board`（auth_any，跨客户总览：sprint 档、human_state、待人工项、预览链接、结束态证据、api rev）；`seo-worker/tools/board_todo.js` 由它生成 PJ 的 TODO.md（看板段禁手改，批注段手写）；apply 里 deferred 验证项从 result_note「检查:」行解析，进 `/attention.manual_checks`，卡片与例外队列显示「待人工 N 项」，`POST /tasks/{id}/manual_done` 盖章（note 必填，新列 manual_done_at / manual_done_note）。W2 done 有证据：所有写 done 的 13 处统一走 `task_close($tid,$kind,$reason,$by)`，kind 五选一 applied / accepted / dropped / merged / killed，applied 必须带「检查:」行，其余必填理由；分析任务无产出无预览不许验收；`/complete` 无 note 拒；closed_kind 新增 accepted（前端「验收」蓝标），老「[applied] 分析报告已验收 / 人工认定完成」按 accepted 派生。Louvresky #82 #85 重开为 #94 #95。W3 记忆租户闸：`/data/aira/scripts/memory_lint.py` 挂 PostToolUse hook（路径二选一、frontmatter type、跨客户口径检查），全库扫出 6 处已改；预览页顶部回显客户 CLAUDE.md（`clientRules`）。W4：deploy.sh ros 本机模式（ROS_PASS 已失效，本机跳过 ssh），`/board` 带 api_rev，board_todo 报部署漂移。九套测试全过，api 与 worker 均已部署 938af1a。
- 坑：`/overview` 已被单客户 Dashboard 占用，跨客户总览叫 `/board`。task_close 之外任何 `UPDATE seo_tasks SET status='done'` 都算绕闸，加新路径请走它。
- 下一步：历史无证据结束态不回填；worker 不注入 `_global/feedback_*` 的缺口待评估。

### 2026-08-28 AIRA (ab) 跨认领登记：变更方案加「放行卡」，预览页与看板卡片只给人看这一节

- 干了什么：Alvin 看 Kuddles #71 预览页的反馈：给团队看的应该是「要做啥」的结论，不是几万字取证。根因是一份方案同时喂人和 apply 机器，预览把第 1 节（取证）整节展开。改法：prepare prompt 在标题下强制 `## 0. 放行卡`（改什么每对象一行「旧值 → 新值」、为什么、风险与回滚、需要人定；`RELEASE_CARD_MAX_CHARS`=800，禁代码块 / curl / HTTP 方法 / 接口路径 / 字节偏移），`REQUIRED_PLAN_SECTIONS` 加放行卡，`lintPlan` 新增 `lintReleaseCard` 超长或夹带即打回；末尾那段 200 字摘要取消（json 块保留）。看板 result_note 正文改为放行卡原文（旧方案无卡时退回截断摘要）。`renderDocPreview` 变更方案只展开放行卡，其余全部（含 before/after 原文）收进一个折叠块；老方案没卡整份折叠。#71 的方案手工补了放行卡（第 2 节未动），预览页已重传。tests 九套全过。
- 坑：放行卡是给人的，别在里面写 apply 要读的东西；apply 只认第 2 节，卡上和第 2 节冲突以第 2 节为准，所以卡里不许出现执行细节。
- 下一步/认领：**worker 本条部署。** #71 等放行，卡上三个「需要人定」要 Alvin 拍。

### 2026-08-28 AIRA (aa) 跨认领登记：任务产出的内部预览页（agencyreport 通道）；分析型任务的「同意」= 验收

- 干了什么：Alvin 定的：所有产出先在我们自己的服务器上渲染成预览页给人看，看完再放行动客户站（PJ 手工产线的做法）。worker 新 `lib/preview.js`：零依赖 markdown 转 HTML（标题、段落、列表、管道表、行内、raw HTML 放行、注释剔除）；`renderBlogPreview`（review-only 的 meta 表、hero、正文、图片补绝对地址、Copy Article HTML 按钮，与 PJ 博客交付惯例一致）与 `renderDocPreview`（方案 / 大纲 / 分析报告）。execute_task 四个产出点（分析、prepare 方案、博客成稿、大纲）都经 `publishFile` 传到 250 的 `reports/{client}/preview/task-N.html`，result_note 首行写「预览: url」，前端状态行显示「预览」链接；博客话术里的占位符在大纲阶段替换成预览链接。另：分析型任务（agent 且无 ops）在 review 时「同意」= 置 done 记 [applied] 验收，不再排 apply 去找不存在的变更方案（Kuddles #72 #73 昨天因此失败）；decide / apply_verdicts / /tasks/release 三处同口径，卡上按钮显示「验收」。新 `tests/preview.test.js` 4 条，九套全过；php -l 在 250 过。
- 坑：预览不是站点主题，版式类改动放行后仍要看线上回读；预览页 noindex 但可公开访问，别放凭据。旧任务（本条之前出的）没有预览链接，重跑才有。
- 下一步/认领：**api + worker 本条部署。** Kuddles #71（v1 方案含快照前置被新规矩拒）重出 v2 作预览页首测；#72 #73 按验收处理。

### 2026-08-27 AIRA (z) 跨认领登记：已发布文章的就地改稿改为「存交付文件，放行后 apply 替换」

- 干了什么：#88 第二轮（job 143）就地扩写成功（2290 词、2 个 HTML 表、审稿删掉内部措辞与电气内容），但暴露一个安全缺口：**WebForger 对已发布文章的 PATCH 直接上线**（实测，之前记忆里「PATCH 不推送要 republish」是错的），等于改稿绕过了放行。修：execute 博客改稿遇到 status published 不碰平台，新正文 payload 存成 `task-N/revised-body-<slug>.md` 交付文件，交付用正式链接并注明「线上未动，放行 = 替换并发布」；apply 的 runBlogPublish 对已发布文章：有交付文件就先过发布门，再 PATCH 替换，再 publish 兜底推送；没有就跳过。
- 坑：#88 这一轮的改稿已经上线了（修复前跑的），结果已落到卡上并打 attention，请人通读线上文；多余草稿 outdoor-shade-cost-comparison-nz-louvre-pergola-or-awning 未发布待人工删。另：本条第一次执行时 shell 工作目录被重置到 /data/aira，git add -A 把外层仓库 6147 个文件打进一个提交（未推送），已 reset --soft 撤回并全部 unstage，工作区文件未动；以后所有仓库命令一律用绝对路径。
- 下一步/认领：**worker 本条部署。**

### 2026-08-27 AIRA (y) 跨认领登记：判定与写稿之间的断点补上；大纲阶段的放行 = 写正文

- 干了什么：#88 首轮全流程实测暴露两处断点。1) **大纲阶段的放行被当成 apply**（job 140，1 秒失败找不到变更方案）：seo-api.php 新 `blog_outline_stage()` / `blog_release_as_write()`，decide、apply_verdicts、/tasks/release、线程 release 四处统一：博客任务 output_url 不是预览链接时，放行 = 说明追加 [大纲已批] 并重排 execute_task；卡上按钮改「大纲已批，写正文」。2) **写稿 prompt 拿不到判定前提修正与已批大纲**（job 141：Fable 判「就地扩写现有成本文」，写手另起一篇对比文）：runBlogTask 读 task.review_adjust 与 task-N/outline-task-N.md 作为「判定前提修正」「已批大纲」硬约束注入写稿 / 改稿 prompt；`expandInPlaceSlug` 解析「就地扩写 /blog/<slug>」，命中且文章存在就切成 revise 模式改那篇不新建。另：review_plan 对 review 任务按顺序附变更方案 / 博客大纲 / 最新草稿（此前只认方案，博客大纲判不到）；判定原则加「方案里的选择题由 Fable 选、公开可查的信息不算客户独有」。测试 blog 5 / review 22，其余不变。
- 坑：job 141 建出的多余草稿 `outdoor-shade-cost-comparison-nz-louvre-pergola-or-awning` 留在平台未发布（bot 无删文通道），#88 的 output_url 已清空防误发布；人工删或改期另用。
- 下一步/认领：**api 已部署；worker 本条部署后重跑 #88。**

### 2026-08-27 AIRA (x) 跨认领登记：博客流水线改成带门的阶段机，把 PJ 手工产线的纪律搬进无头跑

- 干了什么：Alvin 第一性原理审过：正文、配图、发布是三个独立交付物，红线绑在它保护的那道门上，任何一次运行都交出做成的部分。worker 侧改动（execute_task 博客模式、blogimages、blogcheck、apply_task 发布、config）：1) **配图不再连坐正文**：`runImageStage` 槽位 3 次不过只记 blocked 不抛；封面缺时 `pickSiteMedia` 从 `GET /media` 按关键词挑站内真实素材兜底（跳过 flux- 生成图）；稿子照常 PATCH 上平台、进待放行，备注写「配图 x/4，缺哪个槽、最后原因、超 200KB 哪张」，图不齐打 attention。2) **客户规则层**：`clientRulesBlock` 读客户工作区 CLAUDE.md 与记忆目录 `<客户>/feedback_*.md`（去 frontmatter，每份 1500 字，总 9000 字），注入写稿、改稿、大纲、审稿四个 prompt，优先级高于 SOP 通用规则。3) **交付 lint 共用**：blogcheck 读 `/data/aira/scripts/deliverable_lint_rules.json`（_default 加客户层）的 banned_terms / absolute_claims / forbidden_openers，与 PJ 手工产线同一份规则表。4) **审稿**：机器校验过后 `reviewDraft`（`blogReviewModel` 默认 fable）按客户规则只出意见，opus 定点修一次再过机器校验，不循环；修不过沿用原版并把意见写进备注。5) **大纲门**：任务说明或判定前提修正里有「大纲 + 客户回批 / 审批」就只出大纲（交付文件 outline-task-N.md 加客户话术）进待放行；说明里带「大纲已批」（线程「改了重跑」写进去的）才写正文。6) **同 slug 复用**：上一轮遗留的同 slug 未发布草稿改它不新建，避免重复文章。7) **发布门**（apply_task.publishGate）：缺封面、正文有待人工配图标记、残留管道表、缺 FAQ JSON-LD 一律不发。新 `tests/blog.test.js` 4 条，八套全过。
- 补充（同日）：压缩做了。PJ 手工产线的做法搬进 worker：`lib/compress_image.py`（本机 Pillow，限宽 1280、质量 85 逐档到 55、仍超再缩一成）由 blogimages 在过检后 spawn，超 200KB 的图压完走 `POST /api/content/{siteId}/upload` 回传（`webforger.uploadAsset`），用回传路径；压不动或传不上用原图记日志不拦。实测 2.2MB 压到 190KB。原 FLUX 大图留在 assets 里没有删除通道。审稿多一次 fable 调用约 30 秒，改稿多一次 opus 约 5 分钟，只在审稿判 revise 时发生。
- 下一步/认领：**worker 本条部署。** Louvresky #88 说明里写着「大纲交客户回批」，重跑会先出大纲进待放行，这是设计行为。

### 2026-08-27 AIRA (w) 跨认领登记：博客校验数 HTML 表格；判决过期改内容哈希；换档提示

- 干了什么：1) Louvresky #89（Cost Breakdown 骨架）两次生成都被机器校验打回「至少 2 个表格，实际 0」。根因是自相矛盾：SOP 要求 2+ 表格，而 WebForger 博客渲染器不认 markdown 管道表（见记忆 feedback_webforger_no_gfm_tables），SOP 又没说可以写 HTML 表，blogcheck 只数管道表分隔行。修：`lib/blogcheck.structure` 同时数 `<table` 出现次数（回 pipeTables / htmlTables / tables）；SOP 的 Cost Breakdown 与轻快型两处写明「表格一律 raw HTML `<table>`，不写管道表」。新 `tests/blogcheck.test.js`。2) seo-api.php 判决过期改按 `review_text_hash`（标题加说明的 MD5，review_result 写入，ensure_review_schema 为老判决回填一次）：整 plan 批准、放行、写备注这些状态动作不再让判决失效（#88 #89 被误判过期）。3) 前端工具栏提示行在 sprint 换档时写「S2 已全部结束，自动进入 S3」，Alvin 两次把浮上来的下一期任务当成新任务。测试七套全过。
- 坑：站上已有的管道表老文章仍会原样显示 `|---|`，那是内容问题不是校验问题，要修走 qk 那份 fix_tables.js 的转换思路另立任务。
- 下一步/认领：**api 已部署（40af22f）；worker 本条部署。** Louvresky S3 的正确走法是「全部按推荐」：#89 并入 #88，#88 执行出大纲。

### 2026-08-26 AIRA (v) 跨认领登记：changeset 比对放过平台副产物，加「置完成」

- 干了什么：#83 v3 apply（job 126）14 处链接全改完、回读一致、线上生效，却被判失败：changeset 记了 5 个文件，方案声明 4 个，多出的 `posts-index.json` 是平台 PATCH 博客时自动重写的索引（preEtag 等于 postEtag，内容零变化），方案 V8 写死「多出任何一个文件即不通过」。修法：`lib/webforger.getChangeset` 保留每条的 op / preEtag / postEtag；`apply_task.compareFiles` 加 `isPlatformSideFile`（`posts-index.json`、`*-index.json`、`sitemap*.xml`、`history/`、`archive/`，以及 pre 等于 post etag 的条目）不算多出，只记进 side；模型自己的检查项若只因文件比对没过而 worker 比对无 extra，worker 改判成功；apply prompt 与 manifest 风险注记 1 同步写明口径。新端点 `POST /tasks/{id}/finish {note}`（人认定完成，理由必填，追加 [applied] 备注）与卡上「置完成」按钮，给「机器判失败但人看过站点认成」这种情况用。#83 已用它置完成。测试：apply 28（compareFiles 加两例），六套全过；php -l 在 250 过；内联 JS 过。
- 坑：`GET /changesets/{siteId}/{csId}` 的 files 条目实测形状为对象 `{ path, op, touches, preEtag, postEtag }`（#83 日志坐实），字符串形状留作兼容。
- 下一步/认领：**已部署 api + worker**。#86 v3 在等放行，走的是修正后的比对口径。

### 2026-08-26 AIRA (u) 跨认领登记：改站动作规范（changeset 协议）与失败可见性

- 干了什么：Alvin 定的两件事。**一、失败必须看得见。** 复盘 #83 / #86：apply 失败四轮五轮，卡上始终显示「待放行」，判决 do 不失效，按推荐又放行。原因是 attach_job_state 的失败判定拿 job finished_at 与任务 updated_at 比，而 apply 写失败备注本身就顶掉 updated_at，把失败信号盖住。改为：任务最近一次 job 是 failed 即失败态，并数「最近一次成功之后连续失败 N 次」（job_state.fail_count）；`task_fail_reason` 从结果备注里「执行中止 / 执行失败：」那句或 job 日志最后一条 FAILED 提取一句话原因；GET /tasks 加 fail_reason；新端点 `GET /jobs/{id}`（admin，含完整 log_text）。前端：状态行写「落地失败 N 次（job #）」，下面一行红字原因，加「看日志」弹窗；`rvApplicable` 排除失败态任务，按推荐不再盲放；手动再跑要确认框复述失败原因。**二、改站动作规范。** Aiden 的 bot 操作说明（/mnt/share/aiden/to-aira-webforger-bot-ops-20260826.md）并入 `specs/capabilities/webforger.md` 全局风险注记（execute 与 apply 都带）：开工三断言、changeset 安全网（不拍全站快照）、成功判定 = 2xx + 回读且禁响应字段断言、redirects 只 PATCH、超时重试口径、禁区路径、回滚现状（revert 未上线，失败 = 停手上报五项）、/api/doc 一任务一次、页面硬规则。worker：`lib/webforger.js` 加 openChangeset / getChangeset；apply_task 由 worker 登录代开 changeset（开不出来一条写请求都不发），id 注入 prompt，结束读 changeset 真实文件清单与方案末尾 json 的 files 比对，多出未声明文件即判失败；outcome 契约去 snapshot_label 加 touched_files / last_ok_step / fail_step；note 头部加「changeset: cs_x（N 文件）」与「文件核对」行；**自动快照回滚删除**（大站必挂，且 revert 未上线），失败备注写清半改文件与 changeset id 供人还原。execute_task：prepare 模板改「预期响应只写状态码 + 回读核对」，第 2 节末尾「涉及文件」，json 加 files；新 `lintPlan`：快照前置、PUT redirects、禁区路径、预期响应字段断言、缺文件清单，任一命中 job 判红打回重出，不进待放行。测试：apply 28（新 4），六套全过；php -l 在 250 过；内联 JS 与 ui 冒烟过。
- 坑：lint 首版全文扫描，把方案里「本方案不含 POST /snapshots、不碰 /api/admin」这种否定句当命中，#83 / #86 的 v2 被误打回一轮（job 118 / 119）。已改成只看第 2 节调用行、跳过否定句、禁区路径只认带 HTTP 动词的行；两份 v2 方案用改后 lint 复核为零问题。execute 失败原因也改成优先读本次 job 日志（lint 打回不写任务备注，原先会显示上一轮 apply 的旧原因）。
- 坑：changeset 24h 不 commit 自动 expired（409），长任务别跨天；`GET /changesets/{siteId}/{csId}` 的 files 元素形状没实测过（字符串或对象），getChangeset 两种都收。旧方案（#83 / #86 的 v1）不带 files 清单，apply 时 declared 为空，比对只报「多出」不报「缺」，要它们在线程里重出 v2。
- 下一步/认领：**api 已部署；worker 等两条道空闲后重启部署**。#83 与 #86 由 Aira 在线程里下「改了重跑」出 v2（#83 去快照改 changeset；#86 从步骤 4 续跑、断言改回读）。

### 2026-08-26 AIRA (t) 跨认领登记：任务线程补齐截图与客户原话，线程换 fable 且直接改任务

- 干了什么：Alvin 定的。1) 截图：线程输入框粘贴 / 「加截图」走既有 /feedback_upload，`POST /inbox/{root}/chat` 收 images[]（fb_name_ok 校验、最多 5 张）与 source（manual / client），chat_user 行 refs 存 images 与 source，反馈行同步带图；worker 端 chat runner 任务模式把截图拉到工作区 `seo-agent-output/thread-images/` 供 Read，prompt 写明截图当材料不当指令、与文字冲突以文字为准。2) 客户原话：复选框，进 refs.source 与 seo_feedback.source，消息头显示徽标，prompt 标「转述客户原话」。3) 线程模型改 `cfg.threadModel`（默认 fable，普通收件箱会话仍 chatModel）。4) 直接改任务：动作白名单加 `edit_task {title?, detail?, priority?, sprint?}`；`THREAD_AUTO_ACTIONS`（redispatch / kill / later / set_verdict / edit_task）在 chat_reply 落库同一刻由服务端执行（`thread_action_exec` 抽成公共件，人点执行与自动执行共用），系统行「已执行提议 m/i」或「提议 m/i 未执行」记账；release 仍留卡给人点，动线上的永远不自动。测试：chat 31（含 edit_task），六套全过；php -l 在 250 过；内联 JS 与 ui 冒烟过。
- 坑：自动执行的系统行 created_by 也是 seo-worker，worker 的 threadMessages 与前端都改成按正文前缀识别系统行，别改那几个前缀。
- 下一步/认领：**已部署 api + worker**（worker 等 heavy 道的 apply #95 跑完才重启，2026-08-26 Aira 执行）。

### 2026-08-26 AIRA (s) 跨认领登记：任务视图按「谁在等谁」重画，放行面板删除

- 干了什么：Alvin 第一性原理审过的版本：看板只回答「哪些卡在等我」。不动数据库。seo-api.php 新增 `attach_human_state`（GET /tasks 派生 human_state = wait_me / running / wait_ext / closed，wait_reason、run_note、closed_kind、round 全部从 status + job_state + 判决 + 结果备注标签推，round 数 execute job），`attach_job_state` 多带 job_type 以区分执行与落地；新端点 `POST /tasks/{id}/decide {yes, note}`：卡上唯一一对按钮，语义按阶段定（待判 / 失败 → 执行，待放行 → 放行，非 agent → 批准；no = 不做了，理由必填记 [killed]）。前端：待放行面板整块删除；Agency / Client / Agent 三泳道改为四列 等我 / 机器在跑 / 等外部 / 结束，等我列混排按优先级，列头带「判定 N」与「全部按推荐（做 x 砍 y 延 z 并 w）」（一次调用同时处理待判与待放行）；卡片两行：状态行（等什么 / 在跑什么 / 怎么结束 + 方案 vN）与 Fable 判决行，status 徽标、job 徽标、需人判断、上次失败徽标全部并进状态行；说明超 150 字折叠点开；「显示已完成」改「显示已结束」，结束列默认藏；隐藏空泳道开关删除。旧的 renderRelease 等函数保留但无 DOM 挂点，直接返回。测试五套全过，php -l 在 250 过，内联 JS node --check 过。
- 坑：首版部署后整页空白：重画 taskCard 时按锚点切片，把夹在中间的任务线程整段（var thOpen 等）切掉了，renderLanes 抛 ReferenceError。已从上一提交取回并补上 `tests/ui.test.js`：把内联 JS 装进 stub DOM，灌 `tests/fixtures/tasks_louvresky.json` 真实任务数据跑 renderLanes / 队列条 / 线程盒，以后前端切坏在测试里就炸，不用等人看到空白。
- 坑：human_state 是派生字段，前端凡是按 status 分组的逻辑都改成按它；taskVisible 的「已完成」判断也换成 closed。in_progress 这个枚举值实际没人写，派生时归 running 以防万一。
- 修正（同日）：Alvin 看后定：泳道回到 Agency / Client / Agent（不打乱两侧的任务规划），不要按状态分列，也不要待放行面板；每张卡只带一行状态。现状：泳道 = 负责方，泳道内按 等我 > 在跑 > 等外部 排，同档按优先级；泳道头显示「等我 N」；判定 / 全部按推荐两颗回到工具栏（mode all，一次处理待判与待放行）；隐藏空泳道开关恢复。其余（状态行、同意/不做按钮、线程、派生字段）不变。
- 下一步/认领：**已部署 api**（worker 无改动）。

### 2026-08-26 AIRA (r) 跨认领登记：任务线程替代反馈框

- 干了什么：Alvin 定的方向二。一个任务一条线程，零新表：复用 seo_inbox 的 chat_root / chat_user / chat_agent，根的 refs.tasks 只挂这一个任务。seo-api.php：`POST /tasks/{id}/thread`（取或建，回完整视图）；`POST /inbox/{root}/chat` 在根挂了任务时同时投一条 seo_feedback 加 feedback job（线程是反馈的容器，facts 抽取不断）；chat_reply 接受 `actions`，`inbox_refs_norm` 加 actions 键（白名单 redispatch / kill / later / set_verdict / release，最多 3 条）；`POST /inbox/{root}/thread_action {message_id, idx}` 人点执行才落账（redispatch = 指令写进 detail 并排 execute_task；kill = done；later = blocked；set_verdict = 改判；release = 排 apply_task），每条提议只能执行一次，系统行「已执行提议 m/i」记账。`inbox_ref_tasks` 多带 detail 与判定字段。worker chat runner 加任务模式：根挂任务时 prompt 多一段任务全文 + 判决 + 等放行时的方案正文（截 6000 字），回复 json 可附 actions，`cleanActions` 白名单归一化，release 只在 review 状态放行。前端：任务卡与待放行行的「反馈」按钮换成「线程」，卡内展开消息流 + 提议卡 + 输入框，跟 15 秒轮询静默刷新且不打断输入。旧反馈端点与历史保留未删。测试：chat 31（新 2），其余四套不变，五套全过；php -l 在 250 过；内联 JS node --check 过。
- 坑：线程根按 `refs LIKE '%"tasks":[id]%'` 找，依赖 inbox_refs_norm 的规范序列化（tasks 在前、无空格），别改那个函数的输出格式。
- 下一步/认领：**已部署 api + worker**（Alvin 指示推进，2026-08-26 Aira 执行）。三个方向全部落地。

### 2026-08-26 AIRA (q) 跨认领登记：判定自动接力，批准步骤取消

- 干了什么：Alvin 定的方向一。seo-api.php 新公共件 `queue_review_job($cid,$ids,$by,$audit)`：同客户已有 queued 且未满 20 的 review_plan 就并入其 payload（条件 UPDATE 防与 claim 撞车，落空则新建），否则按 20 一批新建并 fire_wake。三处自动调用：`/tasks/bulk`（plan 落任务）、`/tasks/{id}/result`（execute 出方案，判该不该落地）、`POST /tasks`（人工新建）；`/tasks/review` 也改走它，不再 409。人的动作从「批准、执行、放行」三次降为「按推荐执行、按推荐处理」两次，且都是看一行字点一下。前端任务卡去掉「批准」按钮，proposed 的 agent 任务可直接勾选执行；`queue_task_jobs` 排 execute_task 时把 proposed 置 approved，方案页的整 plan 批准保留（那是 plan 级闸门）。测试五套全过，php -l 在 250 过，内联 JS node --check 过。
- 坑：自动判定的来源是 worker 回写（/tasks/bulk、/result），所以 worker 服务令牌现在会间接创建 review_plan job；仍是人点过的 plan / execute 的收尾，不是定时触发。
- 下一步/认领：**已部署 api**（worker 无改动）。方向二（任务线程）接着做。

### 2026-08-26 AIRA (p) 跨认领登记：worker 拆轻重两条道，判定不再排在 execute 后面

- 干了什么：Alvin 定的三个方向之一（判定要快、要优先）。判定一批 20 到 45 秒，但 worker 单飞，排在 10 分钟的 execute 后面等于白等。零 schema 改动：`seo-worker/lib/lanes.js` 与 seo-api.php 的 `JOB_LANES` 同一张表（heavy = pull_data/discover/plan/execute_task/apply_task/report/backfill_metrics，light = review_plan/ruling/feedback/chat/triage，没登记的归 heavy）。listener 每条道各自单飞（`drainLane`），wake 与 poll 同时拍两条道，health 回 `lanes`；`POST /jobs/claim` 收 body.lane 只取该道，不传照旧全局（老 worker 兼容）；`jobs_queue_order_sql($lane)` 让位判断只看同道在跑的客户；位次按道各算，`GET /jobs/queue` 每行带 lane，queued 的 position 是道内位次。前端队列条排队数拆成「执行 x 判定 y」，判定中文案改「通常 1 分钟内」。测试：insights 91（新 1）、其余四套不变全过；lane 排序 SQL 在 docker mariadb:10.3 实测（16 号 heavy 在跑时，其 light 判定不让位；heavy 道 47 排在 16 前）；php -l 在 250 过；listener node --check 过。
- 坑：两条道意味着同一客户可能同时有一个 heavy 在改站点、一个 light 在读看板，light 全是只读站点，没有竞态。若将来往 light 塞会写站点的类型，这个前提就破了。
- 下一步/认领：**已部署 api + worker**（Alvin 指示推进，2026-08-26 Aira 执行）。方向一（plan / execute 自动接判定，去掉批准步骤）与方向二（任务线程替代反馈框）接着做。

### 2026-08-26 AIRA (o) 跨认领登记：任务判定（fable 闸 A）与只读 op 改 analysis 模式

- 干了什么：Alvin 定的：任务跑 execute 之前先由 fable 按第一性原理判「该不该做」（不做会怎样、ROI 量级、是不是 agency 的活、前提是否还成立、顺序），判决 concise 一行显示在任务卡上给人审，审完按推荐批量执行。落地四层：
  1. `seo-worker/specs/review_principles.md`：判断标准全文，五问加四档判决（do / later / merge / drop），改原则只改这一份。
  2. worker：新 job 类型 `review_plan`（`runners/review_plan.js`，模型 `cfg.reviewModel` 默认 fable，只读工具），一批最多 20 个任务一次判；上下文 = 原则全文 + `buildPlanningBriefing` 的客户简报（profile、facts、内容注册表、GSC/GA4/Semrush）+ 本批任务全文。三层防线同 ruling。归一化：批外任务丢弃、非法值 / 无 evidence / merge 目标无效一律降 later 并写明、漏判补 later。唯一写操作 `POST /tasks/review_result`，不改任何任务状态。`runner_host.KNOWN_TYPES` 与 `ensure_job_types` 同步登记。
  3. seo-api.php：`ensure_review_schema()` 在 seo_tasks 惰性加 9 列（review_verdict/reason/evidence/merge_into/adjust/job_id、reviewed_at、review_override/override_note）；`attach_review_state` 给 GET /tasks 挂 review_effective（人推翻优先）、review_stale（判决后任务或 facts 改过）、review_pending。写判决与推翻的 UPDATE 显式 `updated_at=updated_at`，否则判决一落地就算过期。新路由：`POST /tasks/review`（admin，排 job，同客户在飞 409）、`POST /tasks/review_result`（worker）、`POST /tasks/{id}/review_override`（admin，理由必填，不支持改成 merge）、`POST /tasks/apply_verdicts`（admin：do 置 approved 且 agent 任务走 queue_task_jobs 排 execute_task，drop 置 done 备注 [dropped]，later 置 blocked 备注 [later]，merge 置 done 备注 [merged] 并往目标 detail 追加来源；过期判决与非 proposed/approved/blocked 一律跳过并回 skipped）。
  4. 前端：工具栏重排（显示已完成 / 隐藏空泳道 / 时间档折进「显示」），新增「快速判定（N）」与「按推荐执行（做 x 砍 y 延 z 并 w）」，任务卡标题下一行判决（四档四色，drop 红 later 黄 merge 紫 do 绿，过期半透明，判定中蓝字），「改判」走 prompt 输理由，理由同时投 `/tasks/{id}/feedback` 走 feedback job 变 fact，这是唯一学习回路。
  另：`gsc-audit` / `ga4-audit` 在能力清单改成新等级 `agent_readonly`（capabilities.AUTONOMY_LEVELS 加一档），execute_task 对它走 analysis 模式一步出结果，不再走 prepare/apply 两段。起因是 Louvresky #84 花 12 分钟写了一份「打算怎么读 GSC」的方案，且 apply 阶段只有 curl 做不了 JWT。
  测试：新增 `tests/review.test.js` 20 条；五套 24/29/90/88/20 全过；runner 与 runner_host `node --check` 加 require 加载过；内联 JS node --check 过；php -l 在 250 过。
- 补充（同日）：判定扩到 review 状态。待放行面板加「判定方案」与「按推荐处理」，worker 对 review 任务读工作区 `seo-agent-output/change-plan-task-{id}.md` 附进 prompt（截 7000 字），原则文件加「已出方案」一节（范围膨胀、自查矛盾未处理、通道不存在、风险对收益），判决语义变为 do=放行排 apply_task、later=留在待放行只记备注、drop=置 done 不落地、merge=并入目标。起因：Alvin 在待放行面板按不到判定。tests/review 21 条。
- 坑：判决写入用 `rowCount()` 计数，MariaDB 对值未变的 UPDATE 回 0，这里因 reviewed_at=NOW() 每次必变所以没事，别把这句 SQL 改成不带时间戳。前端「改判」用了原生 prompt，够用先上，要换成弹窗随时可以。
- 下一步/认领：**已部署 api + worker**（Alvin 指示推进，2026-08-26 Aira 执行）。判决层评审（闸 B）**不做**，Alvin 2026-08-26 定：方案对错靠各客户 PJ 线程（Discord）人工抽查校准，抽查发现的偏差回写 facts 或 review_principles.md。

### 2026-08-26 AIRA (n) 跨认领登记：队列取单改客户轮转，不再纯 FIFO

- 干了什么：Alvin 看到 Louvresky 一口气批 7 个任务，Kuddles 的 1 个只能排在后面吃灰，问是否该按客户拆任务编号。结论：编号不拆（全局自增 id 只负责唯一与引用，按客户分号只换来心理整齐，代价是复合键与跨客户引用歧义），改的是取单顺序。seo-api.php 新增公共件 jobs_queue_order_sql()：按客户分区用 ROW_NUMBER 编内部序号，正在跑着 job 的客户再让一位，全局按 (rn, id) 出；POST /jobs/claim、jobs_queue_positions、GET /jobs/queue 三处共用，看板显示的「排队中第 N 位」与 worker 下一次真实取单一致。同一客户内部仍严格按提交顺序，worker 仍单飞（写操作不并发的前提不动），listener.js 零改动。测试：php -l 在 250 过；node tests 四套 24/29/90/88 全过；排序 SQL 在 docker mariadb:10.3（与线上同版本）上实测，场景「16 号 1 跑 3 排、47 号后排 1、15 号后排 2」出单顺序为 47、15、16、15、16、16，符合预期。
- 坑：窗口函数 10.2 起可用，线上 10.3 没问题；若将来换回 10.1 或 MySQL 5.7 此处要改成自连接计数。
- 下一步/认领：**待部署 api**（seo-api.php 单文件，PHP 即时生效，worker 无改动）。job 层没有优先级列，任务 P0/P1 目前不影响出单顺序，要不要把 seo_tasks.priority 带进 job 排序由 Aiden 定。

### 2026-08-26 AIRA (m) 跨认领登记：一任务一 job 线性队列，任务卡与队列条防呆

- 干了什么：Alvin 第一性原理定的：任务是工作单位，各自 30 分钟预算与成败，worker 单飞按 job id 线性消化，不做并发。seo-api.php：POST /jobs 的 execute_task 多 task_ids 拆成每任务一个 job（payload 仍是 task_ids 单元素，runner 不用改），去重改按任务（在飞的跳过并回 skipped，全部跳过回 409 兼容旧前端提示），补 50 个上限；POST /tasks/release 同样拆成逐任务 apply_task；新增 GET /jobs/queue（auth_any，全局 running 与 queued，含 client_name、task_id、elapsed_sec、position）；GET /tasks 每行附 job_state（queued/running/failed/null 加 job_id 与全局位次），一条 SQL 无 N+1。新增公共件 job_task_id / jobs_inflight_tasks / jobs_queue_positions / queue_task_jobs / attach_job_state。前端 seo-agent.html：任务卡徽标（排队中第 N 位 / 运行中 M 分钟 / 上次失败）、在飞任务勾选框禁用、任务页顶部全局队列条（跨客户）、执行与放行按钮按 ids 数量反馈并报跳过数、任务页加入 15 秒轮询（原白名单只有 jobs/dash/inbox）。纯函数 qsElapsedMin / qsStripText 在 INSIGHTS-PURE 区间。测试：chat 29 / insights 90（新 4）/ report 88 / apply 24 全过，php -l 与 chatapi.test.php 16 条在 250 过，内联 JS node --check 过。**修掉 (g) 条报的「execute_task 多任务顶超时」**。
- 坑：去重没用 JSON_CONTAINS 或 LIKE（10.3 上 payload 是 LONGTEXT 别名，非法 JSON 行为不稳，LIKE 误命中），改成拉该类型全部在飞 payload 在 PHP 里解，在飞集合以十计代价可忽略。
- 下一步/认领：**已部署 api**（2026-08-26 Aira 执行，PHP 即时生效，worker 无改动）。Kuddles S1 四个可一次全勾。

### 2026-08-26 AIRA (l) 跨认领登记：页面改动任务可抽查（受影响页面链接、机器检查、失败自动回滚）

- 干了什么：Alvin 第一性原理定的闭环：机器改线上页后，人只需一眼看到改了哪页与确认没崩；崩没崩归机器当场兜底；不做回滚按钮（人工回滚走对话）。零 schema 改动。跨认领动了 runners/apply_task.js、runners/execute_task.js、lib/publish.js、static/seo-agent.html。apply outcome 契约加 affected_urls / snapshot_label / before_archive / checks[{name,passed,deferred,note}]；判定只看 deferred=false 的项，延后项（Rich Results、收录跟进）只记录，**修掉 (h) 条报的「未验项当失败」**；失败且有快照 label 时调平台 restore 自动回滚并写「已自动回滚」，aborted 不自动回滚；result_note 头部固定四行（受影响页面、改前存档传 250 的 reports/{slug}/qa/、快照、检查通过与待人工计数），旧 verification_passed 向后兼容。execute_task prepare 输出 target_urls 写「目标页面」一行供放行前看。前端任务卡 URL 自动可点（linkifyText 在 INSIGHTS-PURE 区间），截断改按最后一个分隔符保留机器头部。publish.js 抽 publishFile，publishReport 行为不变。测试：chat 29 / insights 86 / report 88 / apply 24（新）全过，node --check 与 require 全过，php 未动。
- 坑：无新坑。快照 restore 是全站还原，会连带回退这期间其他写入，回滚前 note 里有 label，人工回滚也走同一接口。
- 下一步/认领：**已部署 worker 与前端**（2026-08-26 Aira 执行，rev edd9ccb，部署前 active job 为 0）。Bens S2 与 Kuddles S1 执行出的任务自带链接。

### 2026-08-25 AIRA (k) 批量导入第二批：kuddles（47）与 louvresky（16），报四条 worker 侧问题

- 干了什么：按 Bens 试点定型的五步（蒸馏、裁决、现验、导入、重规划）导入两家 WebForger 客户。kuddles：30 facts + 12 大事记，四 job 全 done，plan 6 draft 12 任务。louvresky：36 facts + 19 大事记（55 行顶格），四 job 全 done，plan 7 draft 12 任务。两家 GSC 均为 URL 前缀属性（服务账号列站确认，非 sc-domain）。导入包留档各客户 seo-agent-onboarding/import_package_v1_final.md。
- 坑（Aiden 领地，报告不动手）：1) **lib/metrics.js 的 LEAD_EVENTS 写死** form_submit / generate_lead / click_to_call，louvresky 关键事件是自定义名（Quote Page Form Submited 等），ga4_leads 回填 180 天全零，报告询盘也会是零。建议 profile 加 lead_events（JSON 数组）列，metrics 与 backfill 与 report 数据层都按客户读，缺省回落现值。2) **discover 给 seoq 的 keywords 种子带引号被 gate 判非法字符拒绝**（kuddles 两次），本地词场就此成未知项，去掉引号即可。3) **content_registry 读 WebForger 分页的 page 参数被截成 `pages%2F`**（kuddles 教育者页与 /blog/ 共 10 处 404），疑似路径含斜杠未整体编码。4) **webforger_credentials.md 解析只认 Email/Password 行或表格**，louvresky 凭据在客户 .secrets.env 里，首轮 registry 被跳过；我已在 md 补表格并重拉（job 67）。建议解析器也支持从客户目录 .secrets.env 读 WF_BOT_EMAIL/WF_BOT_PASSWORD。
- 下一步/认领：两份 plan 交 Alvin 终审。第三批候选：t3interior、benscurtainsnz（WF）；Shopify 客户前置我写 content_registry 枚举器。

### 2026-08-25 AIRA (j) 月报只出完整自然月，部署 (i) 的模板修复

- 干了什么：Alvin 定月报周期为 1 号到月末整月，不出月中版。POST /reports/generate 对 period_type=month 校验 start 为 1 日、end 为月末、月末加 3 天 GSC 延迟不晚于今天，否则 400 并回 latest_month；前端月份选择器 max 与默认都是上一个完整月（复用 insToday 的 3 天延迟），越界提交前端先拦。worker 侧 computePeriod 的夹取保留作保险。测试 chat 29 / insights 83 / report 88 过，php -l 过，内联 JS node --check 过。**api 与 worker 一起部署**（worker 这次把 (i) 条的模板修复也带上）。
- 坑：Bens 8 月的 v1 至 v3 是规则定之前的月中版，留作版本历史；9 月初重新出 8 月整月版。
- 下一步/认领：Alvin 在看板自测 powerdekor 7 月报（我不代点）。

### 2026-08-25 AIRA (i) 报告模板头部注释漏进成品，模板层根治，报 lib 一处脆弱点

- 干了什么：Bens 8 月报告 v1 至 v3 线上页顶部漏出模板说明文字（"渲染硬约束……report_lint.py --check"），且说明里那个没闭合的 `<b style="color:#16a34a">` 把整页染成绿色加粗、hero 挤成半宽。根因：`lib/reporthtml.js` 的 `stripGuidanceComments` 用非贪婪 `<!--([\s\S]*?)-->` 剥注释，模板头部注释里写了字面量 `<!-- section:xxx -->`，正则在那句提前闭合，剩余说明文字变成正文。修法在我认领的 specs 层：`template_leadgen.html` 与 `template_skeleton.html` 头部注释里的 `<!-- section:xxx -->`、`<!-- /section:xxx -->`、`<!-- row:xxx -->` 三处字面量改成不含注释符的写法。`tests/report.test.js` "模板注释不进成品"一条加断言：`<html` 之前只允许 `<!DOCTYPE html>`（旧模板实测能被这条抓住）。三套测试 report 88 / chat 29 / insights 83 全过。已发布的三份产物（本地 seo-agent-output 与 250 上 seo_report_2026-08_v1 至 v3）已手工剥掉漏出段并重传，v3 线上回读 `<html>` 前只剩 DOCTYPE。
- 坑（Aiden 领地，报告不动手）：`stripGuidanceComments` 对注释里再出现 `<!--` 没有防护，任何人以后在模板注释里举例写注释标记都会复发。建议改成先按 `<!-- section:` / `<!-- /section:` 白名单切分再剥，或在渲染后断言 `<html` 前只剩 DOCTYPE 直接抛错（测试已加，渲染层若也加一道更稳）。
- 下一步/认领：待部署（worker 侧 specs 两文件 + tests）。Bens 8 月报告下次重跑自动干净。

### 2026-08-25 AIRA (h) 试点 v1 修三处，报 apply_task 一条判定问题

- 干了什么：benscurtains 2026-08 月报 v1 跑通（叙事一次过、lint 零命中、工作板块 8 项），审出三处修掉：1) 数据层周期不夹 GSC 延迟（显式传月末就按 31 天拉，环比全是假下滑），factspack.computePeriod 改为无条件夹到今天减 3 天并标 partial；2) 页眉客户名丢失（seo_profiles 无 name 列），**跨认领在 GET /context 的 profile 上补 name（从 clients 表取，已有则不覆盖）**，页眉空字段改为不显示；3) 工作分类加 ads（广告账户），数字条改按分类计数。测试 chat 29 / insights 83 / report 88 过，php -l 过。**api 与 worker 已随本次一起部署**（Alvin 指示的试点推进）。
- 坑（Aiden 领地，报告不动手）：**apply_task 把「有未验证项」当失败**。task 61 整页重写 7 步全过、V1 至 V11 通过、页面已上线（H1 实测新版），仅 V12（Rich Results Test 需浏览器）与 V13（14 天后跟进）无法当场验，runner 判 `verification_passed is not true` 置 failed 并留 review，人工已改 done。建议：验收项区分「当场可验」与「延后或人工」两类，后者不计入失败判定，只写进 result_note。
- 下一步/认领：v2 已排（job 56）。

### 2026-08-25 AIRA (g) 报告模块 P1 落地（待部署 api 加 worker）

- 干了什么：sales 一键出报模块 P1 全套。后端 seo-api.php：ensure_reports_schema（seo_reports，无外键）、POST /reports/generate（admin，校验 workspace_dir，同类 job 409）、POST /reports（worker，version 服务端算）、GET /reports、GET /reports/{id}/pack、PATCH /reports/{id}（note/status）；**跨认领改动两处：GET /metrics 与 GET /events 由 auth_admin 改 auth_any**（worker 数据层复用，回传只有指标与事件标签）。worker：lib/factspack.js（零 LLM 数据层）、lib/reportlint.js（copy_rules D 段全部规则加数字校验）、lib/reporthtml.js（零 LLM 渲染）、lib/publish.js（ssh 别名 blogpreview 上 250）、runners/report.js 重写（一次 LLM 加一次纠错，仍坏降级纯数据版 job 不失败）、specs/report/ 契约与 leadgen 模板；lib/config.js 加 reportModel/reportSsh/reportRemoteRoot/reportUrlBase/reportTimeoutMin（DEFAULTS 兜底，config.json 不用改）；lib/api.js 加四方法；lib/distill.js factLines 加 excludePrefixes（filter 在 slice 前，默认不变）；lib/metrics.js 只加导出；listener.js 超时按 type=report 取 reportTimeoutMin。前端 seo-agent.html 加「报告」tab（区间指标、生成月报、版本列表带备注与已发送标记），新增 rep* 纯函数在 INSIGHTS-PURE 区间。测试：node tests/ chat 29、insights 83（含新增 7 条）、report 88（新）全过；php -l 与 chatapi.test.php 16 条在 250 上过；全部 js node --check 加 require 加载过。
- 坑：1) **execute_task 多任务串行会顶 30 分钟超时**（benscurtains job 52 三任务只跑完两个即被杀，61 补排 job 53），建议一任务一 job 或按任务数放宽 jobTimeoutMin，归 Aiden。2) GA4 默认渠道分组有 "AI Assistant" 标签，成品 lint 对裸 AI 字样只查叙事不查全文，否则永远过不了闸。3) 报告 HTML 不走 deliverables 通道（无 html 扩展名且强制下载），走 250 静态托管。
- 下一步/认领：**已部署 api 与 worker**（Alvin 指示，2026-08-25 Aira 执行，rev 8bc511d，含工作量数字条那次提交；部署前 active job 为 0）。试点 benscurtains 2026-08 月报 v1 已排 job 55，人工过目后再开放其他客户。P2 周报季报，P3 /client 门户读 sent 版本。

### 2026-08-25 AIRA (f) 认领扩围登记：报告模块整块

- 干了什么：Alvin 指示报告模块（sales 用的一键出报）整块由 Aira 做，理由是 PJ 流程自动化需要全部客户报告记忆。范围：新表 seo_reports（惰性 DDL）、seo-api.php 新增 /reports 端点组、report runner（现占位）、前端客户级「报告」子 tab、specs/report/ 三件（facts pack schema、prompt 契约、HTML 模板）。会碰 seo-api.php、seo-agent.html、runner_host KNOWN_TYPES（report 类型已登记）与 runners/report.js。
- 坑：与 Aiden 现有代码的接缝只做加法（新 ensure_*、新路由分支、新 view），不改既有函数签名；所有改动按本账本条目回溯。
- 下一步/认领：P1 月报 MVP，Bens 试点；P2 周报季报；P3 /client 门户读 sent 版本。部署仍 Alvin 点名。

### 2026-08-25 AIRA (e) 跨认领登记：plan.js 删硬编码客户背景

- 干了什么：Alvin 要求根治 plan 简报串客户背景的坑（(b) 条 bug 1），跨 Aiden 认领动了 seo-worker/runners/plan.js：删除第 36 到 48 行写死的 CLIENT_BACKGROUND（powerdekor 试点背景：新西兰地板站、jacktoto、78,000 垃圾外链）及第 169 行的引用，客户背景改为完全依赖 profile 与 facts 简报（benscurtains plan 5 已验证无此段规划更准）。同时从 DB 删除了 benscurtains 因该 bug 生成的任务 68（无挂靠记录）。测试：node --check plan.js 过，node tests/ 29+76 全过。
- 坑：powerdekor 侧若依赖这段背景（例如 disavow 决策的"假设链接有毒"前提），下次给 15 号跑 plan 前请把相关前提补进 facts（link.* 那组已基本覆盖）。
- 下一步/认领：**已部署 worker**（Alvin 指示，2026-08-25 00:13 由 Aira 在 ros 本机照 deploy.sh worker 六步执行：备份 .bak-deploy-20260825-001303、rsync 白名单、清单比对全一致、node --check 加 require 校验过、systemctl restart 后 active、DEPLOYED 记 rev 042dd95）。部署前确认 running job 为 0。部署单点仍归 Aiden，此次是老板点名例外。

### 2026-08-25 AIRA (d) 跨认领登记：前端小改

- 干了什么：Alvin 要求看板客户名前显示 #id 方便定位。跨 Aiden 认领的 static/seo-agent.html，按规矩先登记后动手，改动四处纯展示：侧栏客户行、主标题、收件箱客户下拉、新增客户下拉，均加 "#<client_id> " 前缀（侧栏 id 用 .muted 淡色）。不涉及后端与数据。测试：node tests/ 两套 29+76 全过（前端无单测），php -l 不适用。
- 坑：无。
- 下一步/认领：**已部署**（Alvin 指示，2026-08-25 用 deploy.sh api 模式跑的，seo-api.php 未改哈希一致，DEPLOYED-seo 记 rev a3be9b4，线上已验证）。部署单点仍归 Aiden，此次是老板点名的例外。改动仅此四行，Aiden 若有前端重构直接覆盖无妨。

### 2026-08-25 AIRA (c)

- 干了什么：powerdekor（client 15，Aiden 试点客户）PJ 记忆增量补全，只追加不覆盖：6 条规则/状态 facts（id 145 到 150：www 规范域与平台迁移背景、GTM v3 四条禁令、四个 money page 与映射、博客惯例、PDF 重定向平台限制、cocoa-oak 生成图待换）加 9 条大事记（02-28 到 07-14 六次注入复发时间线、06-21 内容、07-21 重建、08-23 disavow 提交）。状态类两条 2026-08-25 现验后写入。增量包留档 clients/powerdekorfloors/seo-agent-onboarding/increment_2026-08-25.json。未动 plan 3、任务和 agent 采集的 facts。跨到 Aiden 试点客户的数据层，属数据不属代码，报备。本条为文档改动无需测试与部署。
- 坑：15 号客户 facts 现为 57 行，距简报 60 条截断线只剩 3。ga4.* 前缀 17 条原子审计值（custom_dimensions_count、direct_nz_sessions_28d 一类）各占一行，建议合并为一两条审计摘要 fact，释放名额；或在 distill.js 的 factLines 里排除 history.event.* 并提高上限（见上一条 bug 3 的同一处代码）。
- 下一步/认领：合并 ga4.* 审计值归 Aiden 定夺（他采的数据）；我这边继续出写入规范 SOP。

### 2026-08-24 AIRA (b)

- 干了什么：benscurtains AU（client 46）从零重建导入试点跑通。流程：项目记忆蒸馏成 55 行导入包（36 facts 加 19 大事记，rule/state 分类，state 类 28 条全部现验后写入）、DB 直连真删十表旧记录（备份先落双份）、profile 加 facts 加大事记重导、pull_data/backfill/discover/plan 全链路重跑。产出 plan 5 draft（12 任务）待 Alvin 终审。此流程将作为后续全部 SEO 客户导入的模板，写入纪律我这边出 specs 层 SOP（蒸馏、导入预算、回写时机）。测试：node tests/chat 29 过、insights 76 过、chatapi.test.php（250 上跑）16 过、php -l 无错，本条目为文档改动未动代码。
- 报告三条 worker/api 侧 bug（发现不动手，修复归 Aiden 排期）：
  1. **plan runner 简报的任务背景段串入其他客户信息**：benscurtains 的 plan 4 与 plan 5 两次生成，背景段都把客户描述成"新西兰地板线索站，历史有 jacktoto 垃圾注入与约 78,000 条垃圾外链"（即 powerdekor 的画像），与 profile/facts/dossier 全部矛盾。模型自己发现冲突并按简报纠偏，但污染规划输入且诱发多余任务。疑似 plan 提示词模板里残留试点客户的写死背景。
  2. **LLM job 的 token_usage 全部记 0**：discover（opus 两轮）与 plan（fable）都没回写，PATCH /jobs/{id} 明明支持该字段，成本统计目前是空的。
  3. **plan 的 reject_reason 喂不回下一次规划**：distill.js 只读 context.active_plan.reject_reason，而 /context 的 active_plan 查询带 status='active' 过滤，draft 被 reject 后是 rejected，两种状态都进不了 active_plan，驳回理由永远断头。想让驳回意见影响重规划只能写 facts，建议把该字段读取扩到最近一条 rejected plan。
- 坑（导入纪律相关，未来批量导入沿用）：facts 简报层有 60 条硬上限，按 fact_key 字典序静默截断，且 history.event.* 大事记也占名额；单条 value 简报里截 400 字。导入包按"总量 55 行内、单值 400 字内"自控。另：facts 无 DELETE 端点，同 key 只能覆盖，孤儿 key 会以 confirmed 口径永久喂给后续 job，客户重导优先走 DB 真删重建（本次先例）。
- 下一步/认领：我出 specs/ 写入规范 SOP；三条 bug 归 Aiden。

### 2026-08-24 AIDEN (a)

- 干了什么：仓库从 ops-tracker 拆出（git filter-repo 保留全部 19 条相关提交史），内容为 SEO agent 系统全量：seo-worker（listener 加 11 类 runner 加 lib）、seo-api.php（看板后端）、static/seo-agent.html（看板前端）、sql、tests、deploy.sh。拆仓时点的线上状态：250 与 ros 与本仓 HEAD 逐文件哈希一致（DEPLOYED 记录 rev 见两台机器）。
- 坑：ops-tracker 里的同名文件已删除并留指路，以后 SEO 系统改动只认本仓，别改错地方。
- 下一步/认领：见上方登记。Aira 首个建议入场点：benscurtains 等非 WebForger 客户跑通后，把踩到的平台适配缺口按认领写回来。
