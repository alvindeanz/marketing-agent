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
t('源码闸：判定只此一份，派单闸与读接口都调 verdict',function()use($src){
    eq(substr_count($src,'function blog_publish_consent_verdict('),1);
    if(strpos($src,"blog_publish_consent_verdict((int)\$bt['client_id']")===false)throw new Exception('GET /blog_consent 没调 verdict');
    if(preg_match('/#\(\\\\d\{1,7\}\)\\\\b/',$src))throw new Exception('宽松的 #数字 候选扫描还在');
});
echo "\n$pass passed, $fail failed\n";
exit($fail?1:0);
