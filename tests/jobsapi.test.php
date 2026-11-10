<?php
/* seo-api.php 终态回写纯函数的单测（2026-11-02 job 11718 事故）。零数据库，零 HTTP。
   跑法：php tests/jobsapi.test.php
   原理同 tests/chatapi.test.php：按 JOBS-PURE-START / JOBS-PURE-END 标记把纯函数块抠出来 eval。
   测两件事：
     job_log_has_tail      终态补投判重（库里日志已以本次 log_append 收尾就跳过拼接）；
     job_is_lock_retryable 死锁 / 锁等待超时才原地重试一次，别的 PDO 错不重试。 */

$src=file_get_contents(__DIR__.'/../seo-api.php');
if(!preg_match('#/\* JOBS-PURE-START([\s\S]*?)/\* JOBS-PURE-END \*/#',$src,$m)){
    fwrite(STDERR,"找不到 JOBS-PURE-START / END 标记，检查 seo-api.php\n");
    exit(1);
}
$code=preg_replace('#^[\s\S]*?\*/#','',$m[1],1);
eval($code);

$pass=0;$fail=0;
function t($name,$fn){
    global $pass,$fail;
    try{$fn();$pass++;echo "  ok   $name\n";}
    catch(Throwable $e){$fail++;echo "  FAIL $name\n       ".$e->getMessage()."\n";}
}
function eq($a,$b,$msg){if($a!==$b)throw new Exception($msg.'：期望 '.var_export($b,true).' 实得 '.var_export($a,true));}
function pdoe($state,$drv,$msg){
    $e=new PDOException($msg);
    $e->errorInfo=[$state,$drv,$msg];
    return $e;
}

/* 11718 现场的尾段形态：finalize 的最后一笔 log_append */
$TAIL="[2026-11-01T23:13:10Z] finished ok\n[2026-11-01T23:13:10Z] job completed ok";

t('首投已落库后补投：日志以本次 chunk 收尾，判重跳过',function()use($TAIL){
    $log="[..] claimed\n[..] step 1\n".$TAIL;
    eq(job_log_has_tail($log,$TAIL),true,'应判为已在库');
});

t('首投没落库（被清扫先收了的迟到尾段）：不判重，照录',function()use($TAIL){
    $log="[..] claimed\n[..] step 1\n[2026-11-01 23:13:10Z] [reaped-timeout] 认领超过 60 分钟未完成";
    eq(job_log_has_tail($log,$TAIL),false,'清扫标记在尾，尾段没进库');
});

t('日志为空或 null：不判重',function()use($TAIL){
    eq(job_log_has_tail(null,$TAIL),false,'null');
    eq(job_log_has_tail('',$TAIL),false,'空串');
});

t('chunk 为空：视为无需追加',function(){
    eq(job_log_has_tail('abc',''),true,'空 chunk');
});

t('只是前缀相同或包含在中间：不判重（必须严格收尾）',function()use($TAIL){
    eq(job_log_has_tail($TAIL."\n[..] later line",$TAIL),false,'中间出现不算');
    eq(job_log_has_tail(substr($TAIL,0,-3),$TAIL),false,'截短不算');
});

t('多字节内容按字节严格比对',function(){
    $c="[..] 终态已写\n[..] 收口";
    eq(job_log_has_tail("前文\n".$c,$c),true,'中文尾段');
    eq(job_log_has_tail("前文\n".$c.' ',$c),false,'多一个空格不算');
});

t('锁冲突可重试：40001 / 1213 死锁 / 1205 锁等待超时',function(){
    eq(job_is_lock_retryable(pdoe('40001',1213,'SQLSTATE[40001]: Serialization failure: 1213 Deadlock found')),true,'1213');
    eq(job_is_lock_retryable(pdoe('HY000',1205,'SQLSTATE[HY000]: General error: 1205 Lock wait timeout exceeded')),true,'1205');
    eq(job_is_lock_retryable(pdoe('40001',0,'x')),true,'40001 无驱动码');
});

t('无 errorInfo 时按消息兜底识别',function(){
    eq(job_is_lock_retryable(new PDOException('SQLSTATE[HY000]: General error: 1205 Lock wait timeout exceeded; try restarting transaction')),true,'1205 文本');
    eq(job_is_lock_retryable(new PDOException('SQLSTATE[40001]: 1213 Deadlock found when trying to get lock')),true,'1213 文本');
});

t('其他错误不重试',function(){
    eq(job_is_lock_retryable(pdoe('42S22',1054,"Unknown column 'x'")),false,'1054');
    eq(job_is_lock_retryable(pdoe('HY000',2006,'MySQL server has gone away')),false,'2006');
    eq(job_is_lock_retryable(new RuntimeException('1205 Lock wait timeout exceeded')),false,'非 PDOException');
});

t('客户版已发布判定：只认行首「客户版: URL」（ticket #60 审阅件通知减法）',function(){
    eq(note_has_client_version("客户版: https://agencyreport.horntech-dev.com/reports/midea/x.html?t=1989&k=abc\n预览: https://a/b"),true,'首行');
    eq(note_has_client_version("摘要\n客户版: https://a.example/x.html\n其余"),true,'中间行');
    eq(note_has_client_version("预览: https://agencyreport.horntech-dev.com/reports/midea/preview/task-1992.html"),false,'只有预览');
    eq(note_has_client_version("客户版发布失败，卡上会缺客户版: 行"),false,'行内提及不算');
    eq(note_has_client_version(''),false,'空');
});

echo "\n$pass passed, $fail failed\n";
exit($fail?1:0);
