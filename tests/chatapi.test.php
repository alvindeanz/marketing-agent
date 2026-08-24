<?php
/* seo-api.php 里对话相关纯函数的单测。零数据库，零 HTTP。
   跑法：php tests/chatapi.test.php
   原理：从 seo-api.php 里按 CHAT-PURE-START / CHAT-PURE-END 标记把纯函数块抠出来 eval，
   同 tests/insights.test.js 的路子。改标记文字要同步改这里的正则。
   测的是两件事：
     task_fields_clean  立项和人工建任务共用的字段校验，草案绝不能靠它绕过约束；
     inbox_drafts_norm  模型给的草案存进 refs 之前的规整，宽进严出。 */

$src=file_get_contents(__DIR__.'/../seo-api.php');
if(!preg_match('#/\* CHAT-PURE-START([\s\S]*?)/\* CHAT-PURE-END \*/#',$src,$m)){
    fwrite(STDERR,"找不到 CHAT-PURE-START / END 标记，检查 seo-api.php\n");
    exit(1);
}
/* 被测块之外它只依赖这一个常量，和 seo-api.php 顶上的 define 保持同值。 */
define('CHAT_MAX_DRAFTS',5);
$code=$m[1];
/* 抠出来的片段是从 START 注释中间断开的，把注释尾巴补回去再 eval */
$code=preg_replace('#^[\s\S]*?\*/#','',$code,1);
eval($code);

$pass=0;$fail=0;
function t($name,$fn){
    global $pass,$fail;
    try{
        $fn();
        $pass++;echo "  ok   $name\n";
    }catch(Throwable $e){
        $fail++;echo "  FAIL $name\n       ".$e->getMessage()."\n";
    }
}
function is_true($c,$msg){if(!$c)throw new Exception($msg);}
function eq($a,$b,$msg){if($a!==$b)throw new Exception($msg.'（拿到 '.var_export($a,true).'，期望 '.var_export($b,true).'）');}
function section($s){echo "\n$s\n";}

$GOOD=[
    'title'=>'给 laminate flooring 落地页补 FAQ 区块',
    'detail'=>'按 GSC 里那三个长尾问题写 5 条 FAQ，上 schema。',
    'module'=>'onpage','owner_type'=>'agency','priority'=>'P1','sprint'=>'W36','ops'=>'改完跑一次结构化数据校验',
];

section('task_fields_clean：立项和人工建任务共用的字段校验');

t('好字段全过，键就是 seo_tasks 的列名',function()use($GOOD){
    list($c,$e)=task_fields_clean($GOOD);
    eq($e,null,'不该报错');
    eq($c['module'],'onpage','module 没带过来');
    eq($c['priority'],'P1','priority 没带过来');
    eq($c['status'],'proposed','默认状态该是 proposed');
    eq($c['attention'],0,'attention 默认 0');
});

t('title 必填',function(){
    list($c,$e)=task_fields_clean(['title'=>'   ','module'=>'content']);
    eq($c,null,'不该给出 clean');
    eq($e,'title required','错误说明不对');
});

t('title 超过 255 字符直接拒，不截断',function(){
    list($c,$e)=task_fields_clean(['title'=>str_repeat('あ',256),'module'=>'content']);
    eq($e,'title over 255 chars','应该按字符数拒绝');
});

t('module 只认五个值，草案里编一个新的会被拒',function(){
    list($c,$e)=task_fields_clean(['title'=>'x','module'=>'blog']);
    eq($e,'bad module','module 白名单漏了');
    foreach(['technical','onpage','content','local','offpage'] as $mod){
        list($c2,$e2)=task_fields_clean(['title'=>'x','module'=>$mod]);
        eq($e2,null,"module $mod 应该合法");
    }
});

t('owner_type 只认三个值',function(){
    list($c,$e)=task_fields_clean(['title'=>'x','module'=>'content','owner_type'=>'robot']);
    eq($e,'bad owner_type','owner_type 白名单漏了');
});

t('priority 只认 P0 到 P3，空字符串回落 P2',function(){
    list($c,$e)=task_fields_clean(['title'=>'x','module'=>'content','priority'=>'P9']);
    eq($e,'bad priority','priority 白名单漏了');
    list($c2,$e2)=task_fields_clean(['title'=>'x','module'=>'content','priority'=>'']);
    eq($e2,null,'空 priority 不该报错');
    eq($c2['priority'],'P2','空 priority 应该回落 P2');
});

t('status 白名单，且 status_force 能盖掉入参',function(){
    list($c,$e)=task_fields_clean(['title'=>'x','module'=>'content','status'=>'shipped']);
    eq($e,'bad status','status 白名单漏了');
    list($c2,$e2)=task_fields_clean(['title'=>'x','module'=>'content','status'=>'proposed'],['status_force'=>'approved']);
    eq($e2,null,'不该报错');
    eq($c2['status'],'approved','立项必须强制 approved，入参说了不算');
});

t('ops 和 sprint 的长度上限',function(){
    list($c,$e)=task_fields_clean(['title'=>'x','module'=>'content','ops'=>str_repeat('a',256)]);
    eq($e,'ops over 255 chars','ops 上限漏了');
    list($c2,$e2)=task_fields_clean(['title'=>'x','module'=>'content','sprint'=>'W36-W37-W38']);
    eq($e2,'sprint over 10 chars','sprint 上限漏了');
});

t('body 不是对象直接拒',function(){
    list($c,$e)=task_fields_clean('立项吧');
    eq($c,null,'不该给出 clean');
    is_true($e!==null,'应该报错');
});

section('inbox_drafts_norm：模型草案存进 refs 之前的规整');

t('好草案原样留下，字段齐全',function()use($GOOD){
    $out=inbox_drafts_norm([$GOOD]);
    eq(count($out),1,'应该留下一条');
    eq($out[0]['module'],'onpage','module 丢了');
    eq($out[0]['owner_type'],'agency','owner_type 丢了');
    is_true(!isset($out[0]['status']),'草案不该带状态，它不是任务');
});

t('坏草案整条丢掉，好的那条还在，绝不半条落进去',function()use($GOOD){
    $bad=$GOOD;$bad['module']='blog';
    $out=inbox_drafts_norm([$bad,$GOOD]);
    eq(count($out),1,'坏的那条应该被丢掉');
    eq($out[0]['title'],$GOOD['title'],'留下的应该是好的那条');
});

t('没有标题的丢掉',function()use($GOOD){
    $bad=$GOOD;$bad['title']='  ';
    eq(count(inbox_drafts_norm([$bad])),0,'没标题的草案不该留下');
});

t('超过上限只留前 N 条',function()use($GOOD){
    $many=[];
    for($i=0;$i<CHAT_MAX_DRAFTS+4;$i++){$d=$GOOD;$d['title']='t'.$i;$many[]=$d;}
    eq(count(inbox_drafts_norm($many)),CHAT_MAX_DRAFTS,'上限没生效');
});

t('detail 超长截到 4000 字符，不整条丢',function()use($GOOD){
    $d=$GOOD;$d['detail']=str_repeat('文',5000);
    $out=inbox_drafts_norm([$d]);
    eq(count($out),1,'超长 detail 不该整条丢');
    eq(mb_strlen($out[0]['detail'],'UTF-8'),4000,'detail 没截到 4000');
});

t('不是数组的输入返回空数组，不炸',function(){
    eq(inbox_drafts_norm(null),[],'null 应该是空数组');
    eq(inbox_drafts_norm('随便一句话'),[],'字符串应该是空数组');
    eq(inbox_drafts_norm([['not'=>'a draft']]),[],'没有标题的对象应该被丢掉');
});

t('json 字符串形态也认，refs 从库里读出来就是字符串',function()use($GOOD){
    $out=inbox_drafts_norm(json_encode([$GOOD],JSON_UNESCAPED_UNICODE));
    eq(count($out),1,'json 字符串没解出来');
});

echo "\n$pass passed, $fail failed\n";
exit($fail?1:0);
