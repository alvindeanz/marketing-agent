<?php
/* 条目前置条件挂起判定的单测（2026-11-28，SD Aluminium #2984）。零数据库，零 HTTP。
   跑法：php tests/wait_condition.test.php */
$src=file_get_contents(__DIR__.'/../seo-api.php');
if(!preg_match('#/\* COND-PURE-START([\s\S]*?)/\* COND-PURE-END \*/#',$src,$m)){
    fwrite(STDERR,"找不到 COND-PURE-START / END 标记\n");exit(1);
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

/* #2984 真实方案条目的条件列（方案末尾 json，见 tests/fixtures/plan_items_task-2984.txt） */
$fx=file_get_contents(__DIR__.'/fixtures/plan_items_task-2984.txt');
$j=json_decode(trim(preg_replace('#^```json\s*|```\s*$#','',trim($fx))),true);
$C2984=array_map(function($it){return (string)($it['condition']??'');},$j['items']);

t('#2984 回放：11-26 自动放行时两期日期都没到，应挂起不排落地',function()use($C2984){
    eq(count($C2984),3);
    list($unmet,$due)=conditions_wait_verdict($C2984,'2026-11-25');
    eq($unmet,['after:2026-11-27','after:2026-12-11']);
    eq($due,[]);
});
t('#2984 回放：第一期到了第二期没到，仍挂（整单一个落地时点，分期靠方案拆）',function()use($C2984){
    list($unmet,$due)=conditions_wait_verdict($C2984,'2026-11-28');
    eq($unmet,['after:2026-12-11']);
    eq($due,[0,1]);
});
t('日期当天即到（含当天），全到就不挂并交回要消费的下标',function(){
    list($unmet,$due)=conditions_wait_verdict(['after:2026-11-27','after:2026-11-27'],'2026-11-27');
    eq($unmet,[]);eq($due,[0,1]);
});
t('有任一条目不带条件就不挂：落地 agent 自己跳过未到的条目',function(){
    eq(conditions_wait_verdict(['after:2099-01-01',''],'2026-11-28'),[[],[]]);
});
t('没有待落条目不挂；广告过审与等人信号服务端判不了，一律当未到',function(){
    eq(conditions_wait_verdict([],'2026-11-28'),[[],[]]);
    list($unmet,)=conditions_wait_verdict(['ad_approved:123','manual_signal:等客户图','ad_approved:123'],'2026-11-28');
    eq($unmet,['ad_approved:123','manual_signal:等客户图']);
});
t('三个自动放行入口都接了同一个判定',function()use($src){
    eq(substr_count($src,'task_park_if_waiting($tid)'),4,'定义 1 处加调用 3 处');
});
echo "\n$pass passed, $fail failed\n";
exit($fail?1:0);
