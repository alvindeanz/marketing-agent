<?php
/* 发布同意判定纯函数块的单测（2026-11-18 ticket #64 与 #2151）。零数据库，零 HTTP。
   跑法：php tests/consent_verdict.test.php
   从 seo-api.php 按 CONSENT-PURE-START / CONSENT-PURE-END 标记抠出来 eval，同 chatapi.test.php 的路子。 */
$src=file_get_contents(__DIR__.'/../seo-api.php');
if(!preg_match('#/\* CONSENT-PURE-START([\s\S]*?)/\* CONSENT-PURE-END \*/#',$src,$m)){
    fwrite(STDERR,"找不到 CONSENT-PURE-START / END 标记\n");exit(1);
}
$code=preg_replace('#^[\s\S]*?\*/#','',$m[1],1);
eval($code);
$pass=0;$fail=0;
function t($name,$fn){
    global $pass,$fail;
    try{$fn();$pass++;echo "  ok   $name\n";}
    catch(Throwable $e){$fail++;echo "  FAIL $name\n       ".$e->getMessage()."\n";}
}
function eq($a,$b,$msg=''){if($a!==$b)throw new Exception($msg.' 期望 '.var_export($b,true).' 实得 '.var_export($a,true));}
$NOW=strtotime('2026-11-18 12:00:00 Pacific/Auckland');
$base=['delegated'=>false,'cands'=>[],'issued'=>'','now'=>$NOW,'backing'=>null,'card_issued'=>''];

/* 线上真实任务正文（节选，2026-11-18） */
$T2174=['id'=>2174,'detail'=>"目标草稿 /blog/retractable-awning-vs-retractable-louvre-roof/，状态从草稿改为已发布。发布凭证是批文 content.rangi_vs_tepo_blog_pub，处理方式同 #1737，不另外生成客户确认卡。发布前核对草稿与预览一致，自 #2114 以来没有被改过\n\n[委托单] 频道 #10033 消息 #11421/0 提议，summer 确认启动\n[授权引语] 开工\n[backing] content.rangi_vs_tepo_blog_pub",'result_note'=>"预览: https://agencyreport.horntech-dev.com/reports/louvresky/preview/task-2174.html\n目标页面: https://louvresky.co.nz/blog/retractable-awning-vs-retractable-louvre-roof/"];
$F3860='客户 Simmon 2026-11-17 微信回复「先发这篇吧」（11:44 收到预览后先回「好的」），批准 /blog/retractable-awning-vs-retractable-louvre-roof/ 按当前草稿预览原样发布；依据 SEO 频道 2026-11-17 操作员贴出的微信截图';
$T2151=['id'=>2151,'detail'=>"目标文章站内路径 /blog/how-to-choose-sheer-curtains-nz/。第一步先看线上状态。四，和 /blog/sheer-curtains-for-living-room-nz/ 分开角度。客户已在 #832 确认卡上点了同意\n[backing] cards.t831.outcome",'result_note'=>''];

t('[target] 行优先于扫正文：两个网址的任务书也能定位（#2151）',function()use($T2151){
    eq(task_blog_slug($T2151),'');
    $with=$T2151;$with['detail'].="\n[target] /blog/how-to-choose-sheer-curtains-nz/";
    eq(task_target_of($with['detail']),'/blog/how-to-choose-sheer-curtains-nz/');
    eq(task_blog_slug($with),'how-to-choose-sheer-curtains-nz');
});
t('[target] 只认独占一行的标记，句子里提到不算',function(){
    eq(task_target_of('说明：加了 [target] /blog/a/ 这种写法'),'');
    eq(task_target_of("x\n[target] https://a.co.nz/blog/b-post/\ny"),'https://a.co.nz/blog/b-post/');
    eq(task_blog_slug(['detail'=>"x\n[target] https://a.co.nz/blog/b-post/",'result_note'=>'']),'b-post');
});
/* 线上真实任务正文（2026-11-27 ticket #71 #72，SD Aluminium，WordPress 文章挂根路径） */
$T2808=['id'=>2808,'ops'=>'blog-publish,wp-media-upload,wp-seo-meta-update,wp-sitemap-flush','detail'=>"按客户已审预览 https://agencyreport.horntech-dev.com/reports/sdalu/preview/task-2724.html 原样发布，不改正文。网址 /security-screen-door-vs-fly-screen-nz/，分类 Blogs；SEO title「Security Screen Door vs Fly Screen NZ: Which Mesh Door?」、审定 meta、焦点词 security screen door；上传 1 张封面，两张正文图沿用站内原图；发布后刷新 sitemap。替代 #2724（启动时归档），批文见 backing_fact。\n\n[委托单] 频道 #7160 消息 #12833/1 提议，summer 确认启动\n[授权引语] 开工吧\n[backing] content.blog_publish_approved_security_screen_door",'result_note'=>"[split-guard] chat 单实时交付不拆单\n预览: https://agencyreport.horntech-dev.com/reports/sdalu/preview/task-2808.html\n目标页面: https://sdalu.co.nz/security-screen-door-vs-fly-screen-nz/\n---\n变更方案已生成，待人工放行后由 apply_task 执行。\n  - 新文章：不存在 → 公开发布，分类 Blogs，网址 /security-screen-door-vs-fly-screen-nz/\n[wait-publish-consent] 发布凭证未到"];
t('#2808 回放：文章挂根路径的站，发布单按「目标页面」行取到 slug',function()use($T2808){
    eq(blog_slug_of($T2808['detail']."\n".$T2808['result_note']),'','旧取法是空，这就是病根');
    eq(task_blog_slug($T2808),'security-screen-door-vs-fly-screen-nz');
    eq(backing_publish_fact_ok('客户 Evengod 群内批准 security-screen-door-vs-fly-screen-nz 按预览发布',task_blog_slug($T2808)),true);
    eq(backing_publish_fact_ok('客户批准 aluminium-fence-panels-nz-sizes-ordering-guide 按预览发布',task_blog_slug($T2808)),false,'别篇的批文不串');
});
t('「目标页面」兜底只给发布单用，且只认恰好一个网址',function()use($T2808){
    $onpage=['ops'=>'wp-term-seo-update','detail'=>'改类目页','result_note'=>"目标页面: https://sdalu.co.nz/product-category/doors/\n---"];
    eq(task_blog_slug($onpage),'','非发布单的目标页面不是文章');
    $two=$T2808;$two['result_note']="目标页面: https://sdalu.co.nz/a-post/ , https://sdalu.co.nz/b-post/\n---";
    eq(task_blog_slug($two),'','两个网址不猜');
    $none=$T2808;$none['result_note']="目标页面: 未提供\n---";
    eq(task_blog_slug($none),'');
    $noNote=$T2808;$noNote['result_note']='';
    eq(task_blog_slug($noNote),'','方案还没出，任务书的句子不拿来猜');
});
t('[target] 行不带 /blog/ 也认，取最后一段；/blog/ 的站口径不变',function(){
    eq(task_blog_slug(['detail'=>"发布\n[target] /security-screen-door-vs-fly-screen-nz/",'result_note'=>'']),'security-screen-door-vs-fly-screen-nz');
    eq(task_blog_slug(['detail'=>"发布\n[target] https://x.com/blogs/news/spring-sale?utm=1",'result_note'=>'']),'spring-sale');
    eq(task_blog_slug(['detail'=>"发布\n[target] /blog/a-b/",'result_note'=>'目标页面: https://x.co.nz/blog/c-d/']),'a-b');
    eq(path_last_slug('https://x.co.nz/'),'');
    eq(path_last_slug('/files/cover.png'),'','带点号的是文件不是文章');
    eq(path_last_slug('security-screen-door'),'','不是路径不认');
});
t('随手写的「同 #1737」「自 #2114 以来」不是凭证引用（#2174 派单闸误放行）',function()use($T2174){
    eq(consent_ref_ids($T2174),[]);
});
t('「卡 #837」「确认卡 #832」「blog_confirmation_task-N」算显式引用，自己不算',function()use($T2151){
    eq(consent_ref_ids($T2151),[832]);
    eq(consent_ref_ids(['id'=>9,'detail'=>'凭证：卡 #837 的同意','result_note'=>'卡: x/blog_confirmation_task-9.html 旧卡 blog_confirmation_task-7.html']),[837,7]);
});
t('ticket #47 三条旧用例照过：括号里的卡号、确认卡#N、自己的号不算',function(){
    eq(consent_ref_ids(['id'=>1599,'detail'=>'对象：草稿 /blog/patio-cover-nz-checklist-before-quote/（卡 #837，预览 ?preview=42cb）。','result_note'=>'']),[837]);
    $ids=consent_ref_ids(['id'=>9,'detail'=>'见确认卡 #123','result_note'=>'卡页 blog_confirmation_task-55.html']);sort($ids);
    eq($ids,[55,123]);
    eq(consent_ref_ids(['id'=>837,'detail'=>'出卡 #837 后等客户','result_note'=>'']),[]);
    /* 2026-11-24 ticket #70 / Sungait #2791：改稿重出的卡沿用原文件名，表态记在链接 ?t= 那张任务上 */
    eq(consent_ref_ids(['id'=>2791,'detail'=>'按 #2783 客户确认页定稿（https://x/reports/sungait/blog_confirmation_task-2712.html?t=2783&k=53bb）在 Shopify blog news 建文章并发布','result_note'=>'']),[2783,2712]);
    eq(consent_ref_ids(['id'=>2783,'detail'=>'','result_note'=>'客户版: https://x/blog_confirmation_task-2712.html?t=2783&k=5']),[2712]);
});
t('批文写明本篇发布才算数；范围类批文和别篇批文不算',function()use($F3860){
    eq(backing_publish_fact_ok($F3860,'retractable-awning-vs-retractable-louvre-roof'),true);
    eq(backing_publish_fact_ok($F3860,'retractable-awning'),false,'slug 前缀不算');
    eq(backing_publish_fact_ok('zip-blinds-cost-nz-pergola-blinds-budget 一文不要遮阳篷费用，这篇讲帘子就只说帘子','zip-blinds-cost-nz-pergola-blinds-budget'),false,'范围批文');
    eq(backing_publish_fact_ok($F3860,''),false);
    eq(backing_publish_fact_ok('客户微信回复嗯可以，同意发布 zip-blinds-cost-nz-pergola-blinds-budget','zip-blinds-cost-nz-pergola-blinds-budget'),true);
});
t('#2174 回放：无卡无表态，批文写明本篇发布 → 放行，来源 backing',function()use($base,$T2174,$F3860){
    $in=$base;$in['cands']=[[2174,null]];
    $in['backing']=['key'=>'content.rangi_vs_tepo_blog_pub','ok'=>backing_publish_fact_ok($F3860,task_blog_slug($T2174)),'date'=>'2026-11-17'];
    $v=blog_consent_decide($in);
    eq($v['ok'],true);eq($v['via'],'backing');eq($v['key'],'content.rangi_vs_tepo_blog_pub');
});
t('什么都没有 → 不放行',function()use($base){
    $v=blog_consent_decide(['cands'=>[[5,null],[6,null]]]+$base);
    eq($v['ok'],false);eq($v['via'],'none');
});
t('委托客户直接放行',function()use($base){
    eq(blog_consent_decide(['delegated'=>true]+$base)['via'],'delegated');
});
t('卡上表态优先于批文：客户在卡上提了修改，旧批文不能放行',function()use($base){
    $in=$base;$in['cands']=[[10,null],[8,'other']];
    $in['backing']=['key'=>'k','ok'=>true,'date'=>'2026-11-17'];
    $v=blog_consent_decide($in);
    eq($v['ok'],false);eq($v['via'],'card');eq($v['last'],'other');eq($v['card'],8);
});
t('按序取第一张有表态的卡：本任务同意即过，不看后面',function()use($base){
    $v=blog_consent_decide(['cands'=>[[10,'agree'],[8,'hold']]]+$base);
    eq($v['ok'],true);eq($v['card'],10);
});
t('卡签发满 7 天零表态视同同意；不满不算；有表态不走到期',function()use($base){
    eq(blog_consent_decide(['cands'=>[[1,null]],'issued'=>'2026-11-11']+$base)['via'],'expiry');
    eq(blog_consent_decide(['cands'=>[[1,null]],'issued'=>'2026-11-12']+$base)['ok'],false);
    eq(blog_consent_decide(['cands'=>[[1,'hold']],'issued'=>'2026-11-01']+$base)['ok'],false);
});
t('旧批文不替新一版放行：批文早于最新卡的签发日不算',function()use($base){
    $in=$base;$in['cands']=[[1,null]];$in['backing']=['key'=>'k','ok'=>true,'date'=>'2026-11-10'];
    $in['card_issued']='2026-11-15';
    eq(blog_consent_decide($in)['ok'],false);
    $in['card_issued']='2026-11-10';
    eq(blog_consent_decide($in)['ok'],true);
});
t('到点续排只碰一次：续过之后 apply 失败不再重排，重新挂起后可以再续',function(){
    eq(consent_sweep_due('x [wait-publish-consent] 发布凭证未到'),true);
    eq(consent_sweep_due('x [wait-card] 确认卡已出'),true);
    eq(consent_sweep_due('x [wait-card] 等 | [consent-met] 已续排 | 落地失败'),false);
    eq(consent_sweep_due('[wait-card] | [consent-met] | 改稿后 [wait-card] 又出卡'),true);
    eq(consent_sweep_due('没有等待标记'),false);
    eq(consent_sweep_due(''),false);
});
t('源码闸：等客户判断、到点巡检、派单出口都问同一个判定',function()use($src){
    $a=strpos($src,'function blog_card_waiting(');$b=strpos($src,'function blog_slug_of(');
    $body=substr($src,$a,$b-$a);
    if(strpos($body,'blog_publish_consent_verdict(')===false)throw new Exception('blog_card_waiting 没问 verdict，第三份判断又回来了');
    if(strpos($src,"\$ROUTE==='/tasks/consent_sweep'")===false)throw new Exception('到点续排端点没了');
    if(strpos($src,"GET_LOCK('seo_consent_sweep',0)")===false)throw new Exception('巡检没有库级锁，两台 worker 会同时扫');
    if(strpos($src,'if(!consent_sweep_due($wt[\'result_note\']))continue;')===false)throw new Exception('巡检没过只碰一次的闸');
    if(strpos($src,"'chat-dispatch-consent'")===false)throw new Exception('派单出口的同意已在手直排没了');
});
t('源码闸：判定只此一份，派单闸与读接口都调 verdict',function()use($src){
    eq(substr_count($src,'function blog_publish_consent_verdict('),1);
    if(strpos($src,"blog_publish_consent_verdict((int)\$bt['client_id']")===false)throw new Exception('GET /blog_consent 没调 verdict');
    if(preg_match('/#\(\\\\d\{1,7\}\)\\\\b/',$src))throw new Exception('宽松的 #数字 候选扫描还在');
});
/* 大纲段判定（2026-11-26，Apex #667/#668：到期视同同意的成稿被当大纲重排写稿，转两圈停人十天） */
$OUTLINE="预览: https://x/preview/task-9.html\n大纲已出（交付文件 outline-task-9.md），等客户回批。\n回批通过后，在线程里说「大纲已批，写正文」，会带着这句重跑出正文。";
$CARD="[[块:blog_card]]\n博客确认卡（发给客户，客户点同意才发布；[卡签发 2026-11-15] 满 7 天无表态视同同意自动发布）: https://r/reports/a/blog_confirmation_task-667.html?t=667&k=x\n平台预览链接：https://a.co.nz/blog/b/?preview=1\n[[/块:blog_card]]";
t('大纲段只认正证据：刚出大纲、output_url 为空才算',function()use($OUTLINE){
    eq(blog_stage_is_outline('blog-draft,image-generate','',$OUTLINE),true);
});
t('成稿带确认卡不是大纲段，不管卡上有没有表态、到没到期（#667 回放）',function()use($CARD){
    $u='https://r/reports/a/blog_confirmation_task-667.html?t=667&k=x';
    eq(blog_stage_is_outline('blog-draft,image-generate,blog-publish',$u,$CARD."\n[auto-release L2-opus 2026-11-14 22:14] 可发"),false);
    eq(blog_stage_is_outline('blog-draft','',$CARD),false);
});
t('先出大纲后出成稿：以最近一次交付为准',function()use($OUTLINE,$CARD){
    eq(blog_stage_is_outline('blog-draft','',$OUTLINE."\n".$CARD),false);
    eq(blog_stage_is_outline('blog-draft','',$CARD."\n".$OUTLINE),true);
});
t('没出过大纲的单不是大纲段：空产出、本地稿、非博客单都不许被当大纲重写',function(){
    eq(blog_stage_is_outline('blog-draft','',''),false);
    eq(blog_stage_is_outline('blog-draft','https://r/reports/a/preview/task-5.html','HTML 稿 lint 通过，预览已发'),false);
    eq(blog_stage_is_outline('content-edit','','大纲已出'),false);
});
t('源码闸：大纲段不再按 output_url 的形状反推',function()use($src){
    if(strpos($src,"strpos(\$u,'/blog/')===false")!==false)throw new Exception('按网址形状猜大纲的旧判据还在');
    eq(substr_count($src,'function blog_stage_is_outline('),1);
});
/* 发布闸两个不自动发的开关（2026-11-26，HornTech NZ #3088 与 Kuddles 人工审批口径） */
t('[hold-publish] 只认独占一行，句子里提到不算',function(){
    eq(task_publish_hold("改稿。\n[hold-publish] 先迁到中文栏目再发\n[target] /blog/a/"),true);
    eq(task_publish_hold("  [hold-publish]"),true);
    eq(task_publish_hold('说明里提到 [hold-publish] 这种写法'),false);
    eq(task_publish_hold('修订完成前不发布'),false);
});
t('暂缓标记压过一切凭证：委托、卡上同意、到期都不放行（#3088 回放）',function()use($base,$NOW){
    eq(blog_consent_decide(['hold'=>true,'delegated'=>true]+$base)['via'],'hold');
    eq(blog_consent_decide(['hold'=>true,'cands'=>[[9,'agree']]]+$base)['ok'],false);
    eq(blog_consent_decide(['hold'=>true,'issued'=>'2026-11-01']+$base)['ok'],false);
});
t('人工审批口径的客户：到期不算同意，卡上点了同意照常放行（Kuddles）',function()use($base){
    $v=blog_consent_decide(['human'=>true,'issued'=>'2026-11-01']+$base);
    eq($v['ok'],false);eq($v['via'],'none');
    eq(blog_consent_decide(['human'=>true,'issued'=>'2026-11-01','cands'=>[[9,'agree']]]+$base)['ok'],true);
    eq(blog_consent_decide(['issued'=>'2026-11-01']+$base)['via'],'expiry');
});
t('客户发布口径只认开头那个词：agent、human，其余按默认',function(){
    eq(blog_publish_policy('agent（2026-10-15 Alvin 定，降人工介入）'),'agent');
    eq(blog_publish_policy('human（2026-11-26 Alvin 定：须人工审批，发布权不委托 agent）'),'human');
    eq(blog_publish_policy('2026-10-15 Alvin 定：发布权托管 agent'),'');
    eq(blog_publish_policy(''),'');
});
t('源码闸：发布口径 fact 全库只读一处，等客户判定与同意判定同源',function()use($src){
    eq(substr_count($src,"fact_key='policy.blog_publish_executor'"),1);
    if(strpos($src,"\$pol=blog_publish_policy_of((int)(\$t['client_id']??0));")===false)throw new Exception('blog_card_waiting 没走统一口径');
});
echo "\n$pass passed, $fail failed\n";
exit($fail?1:0);
