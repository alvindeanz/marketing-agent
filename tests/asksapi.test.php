<?php
/* seo-api.php 里 asks/answers API 纯函数的单测。零数据库，零 HTTP。
   跑法：php tests/asksapi.test.php（本机 ros 无 php，到 250 或有 php 的机器上跑）
   原理同 tests/chatapi.test.php：按 ASKS-PURE-START / ASKS-PURE-END 标记把纯函数块抠出来 eval。
   测五件事：投影与白名单、选项校验、幂等键与 actor、折叠与 node 侧 cardfold 一致（共用夹具）、
   登记体规整（含卡 token 只收指纹）。 */

$src=file_get_contents(__DIR__.'/../seo-api.php');
if(!preg_match('#/\* ASKS-PURE-START([\s\S]*?)/\* ASKS-PURE-END \*/#',$src,$m)){
    fwrite(STDERR,"找不到 ASKS-PURE-START / END 标记，检查 seo-api.php\n");
    exit(1);
}
$code=$m[1];
$code=preg_replace('#^[\s\S]*?\*/#','',$code,1);
eval($code);
if(!preg_match("#define\('INTEGRATION_TOKENS',(\[[\s\S]*?\n\])\);#",$src,$tm)){fwrite(STDERR,"找不到 INTEGRATION_TOKENS\n");exit(1);}
$TOKENS=eval('return '.$tm[1].';');

$pass=0;$fail=0;
function t($name,$fn){
    global $pass,$fail;
    try{$fn();$pass++;echo "  ok   $name\n";}
    catch(Throwable $e){$fail++;echo "  FAIL $name\n       ".$e->getMessage()."\n";}
}
function is_true($c,$msg){if(!$c)throw new Exception($msg);}
function eq($a,$b,$msg){if($a!==$b)throw new Exception($msg.'（拿到 '.var_export($a,true).'，期望 '.var_export($b,true).'）');}
function section($s){echo "\n$s\n";}

$REG=[
    'ask_id'=>'ask_test0001','client_id'=>55,'kind'=>'direction','audience'=>'both','rev'=>2,
    'deadline'=>'2026-10-30T00:00:00Z',
    'items'=>[
        ['item_id'=>'d1','type'=>'single','options'=>['agree','hold','other'],'requires_text_when'=>['other'],'default_value'=>'agree'],
        ['item_id'=>'d2','type'=>'single','options'=>['agree','hold','other']],
        ['item_id'=>'negatives','type'=>'multi','options'=>['kw_12','kw_31','kw_40'],'required'=>false],
        ['item_id'=>'global_note','type'=>'text','options'=>[],'required'=>false],
    ],
    'lang_pack'=>['primary'=>'en','operator'=>'zh','texts'=>[
        'en'=>['title'=>'Keyword direction','intro'=>'Two calls','deadline_note'=>'By 30 Oct','default_note'=>'No reply means we follow the recommendation',
            'items'=>['d1'=>['prompt'=>'Bid on brand terms?','situation'=>'s','recommendation'=>'r','hint'=>'h','options'=>['agree'=>'Agree','hold'=>'Hold','other'=>'Other']]]],
        'zh'=>['title'=>'关键词方向','items'=>['d1'=>['prompt'=>'内部中文']]],
    ]],
    'source_ref'=>['task_id'=>1413,'plan_id'=>65,'card_kind'=>'keyword_direction','card_token_ref'=>'sha256:0123456789abcdef'],
];

section('登记体规整 asks_norm_register');

t('好登记体全过，source_ref 拆出 task_id',function()use($REG){
    list($r,$e)=asks_norm_register($REG);
    eq($e,null,'不该报错');
    eq($r['task_id'],1413,'task_id 没拆出来');
    eq($r['deadline'],'2026-10-30 00:00:00','deadline 要转 UTC 库格式');
    eq($r['items'][0]['required'],true,'required 缺省 true');
    eq($r['items'][2]['required'],false,'显式 false 要保留');
    eq($r['default_policy'],'no_reply_follow_recommendation','direction 默认按建议');
});
t('plan_approval 默认 none，不自动批准',function()use($REG){
    $x=$REG;$x['kind']='plan_approval';
    $x['items']=[['item_id'=>'approve','type'=>'approve','options'=>['approve','reject'],'requires_text_when'=>['reject']]];
    list($r,$e)=asks_norm_register($x);
    eq($e,null,'不该报错');eq($r['default_policy'],'none','plan_approval 默认应为 none');
});
t('卡 token 明文形状（32 位裸 hex）被拒，只收 sha256: 指纹',function()use($REG){
    $x=$REG;$x['source_ref']['card_token_ref']=md5('whatever');
    list($r,$e)=asks_norm_register($x);
    eq($r,null,'明文形状不该过');is_true(strpos($e,'fingerprint')!==false,'错误说明应提指纹');
});
t('kind 不在集合、ask_id 非法、item 重复、选项码含逗号、requires_text_when 越界都拒',function()use($REG){
    $x=$REG;$x['kind']='survey';eq(asks_norm_register($x)[1],'bad kind','kind');
    $x=$REG;$x['ask_id']='a b';eq(asks_norm_register($x)[1],'bad ask_id','ask_id');
    $x=$REG;$x['items'][1]['item_id']='d1';eq(asks_norm_register($x)[1],'duplicate item_id d1','重复 item');
    $x=$REG;$x['items'][0]['options'][]='a,b';eq(asks_norm_register($x)[1],'item d1 bad option code','逗号');
    $x=$REG;$x['items'][1]['requires_text_when']=['reject'];eq(asks_norm_register($x)[1],'item d2 requires_text_when not in options','越界');
});
t('items 与 lang_pack 的 JSON 字符串形态也认',function()use($REG){
    $x=$REG;$x['items']=json_encode($REG['items']);$x['lang_pack']=json_encode($REG['lang_pack']);
    list($r,$e)=asks_norm_register($x);eq($e,null,'JSON 串该认');eq(count($r['items']),4,'items 数');
});

section('集成 token 匹配 asks_integ_match');

t('源码只存 sha256，明文比对命中，错的不命中',function()use($TOKENS){
    $plain='unit-test-plain-token';
    $tk=[['id'=>'x','sha256'=>hash('sha256',$plain),'client_ids'=>[55],'scopes'=>['asks:read']]];
    eq(asks_integ_match($tk,$plain)['id'],'x','明文该命中');
    eq(asks_integ_match($tk,'wrong'),null,'错 token 不该命中');
    eq(asks_integ_match($tk,''),null,'空 token 不该命中');
    foreach($TOKENS as $row){
        is_true(preg_match('/^[0-9a-f]{64}$/',$row['sha256'])===1,'token 表只许存 64 位 sha256');
        is_true(!isset($row['token'])&&!isset($row['plain']),'token 表不许出现明文字段');
        is_true(is_array($row['client_ids'])&&$row['client_ids'],'必须绑定 client_ids');
    }
    eq($TOKENS[0]['client_ids'],[55],'webforger 这枚只绑 55');
    eq($TOKENS[0]['scopes'],['asks:read','answers:write'],'scopes');
});

section('答案校验 asks_validate_answers');
list($ASK,)=asks_norm_register($REG);

t('合法多 item 提交：single、multi 拼 ", " 串、text 落 other',function()use($ASK){
    list($rows,$errs)=asks_validate_answers($ASK['items'],[
        ['item_id'=>'d1','choice'=>'other','text'=>'need brand data first'],
        ['item_id'=>'negatives','values'=>['kw_12','kw_31']],
        ['item_id'=>'global_note','text'=>'thanks'],
    ]);
    eq($errs,[],'不该报错');
    eq($rows[0],['item'=>'d1','choice'=>'other','fb'=>'need brand data first'],'single');
    eq($rows[1],['item'=>'negatives','choice'=>'flag','fb'=>'kw_12, kw_31'],'multi');
    eq($rows[2],['item'=>'global_note','choice'=>'other','fb'=>'thanks'],'text');
});
t('非法选项码 422（整请求不给行）',function()use($ASK){
    list($rows,$errs)=asks_validate_answers($ASK['items'],[['item_id'=>'d2','choice'=>'agree'],['item_id'=>'d1','choice'=>'maybe']]);
    eq($rows,null,'有一项错就整单不给行');eq($errs,['item d1 bad choice'],'错误清单');
});
t('requires_text_when 命中缺文本拒；未声明的空 other 按现行口径转 hold',function()use($ASK){
    list($rows,$errs)=asks_validate_answers($ASK['items'],[['item_id'=>'d1','choice'=>'other','text'=>'  ']]);
    eq($errs,['item d1 text required for other'],'d1 声明了 other 必填文本');
    list($rows,$errs)=asks_validate_answers($ASK['items'],[['item_id'=>'d2','choice'=>'other']]);
    eq($rows[0]['choice'],'hold','d2 空 other 应转 hold');
});
t('多选值不在词条集合、未知 item、重复 item、空 items 都拒',function()use($ASK){
    eq(asks_validate_answers($ASK['items'],[['item_id'=>'negatives','values'=>['kw_99']]])[1],['item negatives values not in option set: kw_99'],'词条');
    eq(asks_validate_answers($ASK['items'],[['item_id'=>'zz','choice'=>'agree']])[1],['unknown item_id zz'],'未知');
    eq(asks_validate_answers($ASK['items'],[['item_id'=>'d2','choice'=>'agree'],['item_id'=>'d2','choice'=>'hold']])[1],['duplicate item_id d2'],'重复');
    eq(asks_validate_answers($ASK['items'],[])[1],['items must be non-empty array'],'空');
    eq(asks_validate_answers($ASK['items'],[['item_id'=>'global_note','text'=>'']])[1],['item global_note text required'],'text 空');
});

section('幂等键与 actor');

t('幂等键 = 渠道键#item_id，一 item 一键',function(){
    eq(asks_idem_key('wf:7d1c-uuid','d1'),'wf:7d1c-uuid#d1','键形');
    is_true(asks_idem_key('k','d1')!==asks_idem_key('k','d2'),'同请求不同 item 键必须不同');
});
t('actor 写成 webforger:<role>:<ref>，role 只认 client/agency，总长不超 80',function(){
    eq(asks_actor(['role'=>'client','ref'=>'wfu_ab12'])[0],'webforger:client:wfu_ab12','actor');
    eq(asks_actor(['role'=>'operator','ref'=>'x'])[1],'bad actor.role','operator 不许经 WF 写');
    eq(asks_actor(['role'=>'client','ref'=>'a b'])[1],'bad actor.ref','ref 字符');
    is_true(strlen(asks_actor(['role'=>'agency','ref'=>str_repeat('a',60)])[0])<=80,'actor 超列宽');
    is_true(asks_audience_ok('both','client')&&asks_audience_ok('client','client')&&!asks_audience_ok('client','agency'),'audience');
});

section('折叠与 cardfold 一致（共用夹具 tests/fixtures/asks_feedback_rows.json）');
$FX=json_decode(file_get_contents(__DIR__.'/fixtures/asks_feedback_rows.json'),true);

t('表态：每项入账序最后一次，other 不覆盖，空白 other 丢弃',function()use($FX){
    $rows=$FX['rows'];shuffle($rows); /* php 侧自己按 id 排，不信输入顺序 */
    $f=asks_fold_effective($rows);
    $got=[];foreach($f as $k=>$v){if($v['stance'])$got[$k]=['choice'=>$v['stance']['choice'],'fb'=>$v['stance']['fb'],'id'=>$v['stance']['id']];}
    ksort($got);$want=$FX['expected']['stance'];ksort($want);
    eq($got,$want,'表态折叠与 cardfold 夹具期望不一致');
});
t('旁注：非空 other 全部按序保留',function()use($FX){
    $f=asks_fold_effective($FX['rows']);
    $got=[];foreach($f as $k=>$v){if($v['notes'])$got[$k]=array_column($v['notes'],'fb');}
    ksort($got);$want=$FX['expected']['notes'];ksort($want);
    eq($got,$want,'旁注与 cardfold 夹具期望不一致');
    is_true(!isset($f['d3']),'只有空白 other 的 item 不该出现');
});

section('投影与白名单 asks_project');

t('只出白名单键，source_ref、task/plan 编号、卡指纹、operator 中文版都不出',function()use($ASK,$FX){
    $ask=$ASK+['state'=>'open'];$ask['lang_pack']=$ASK['lang_pack'];
    $p=asks_project($ask,asks_fold_effective($FX['rows']),'en','2026-10-16 03:00:00',46800,'2026-10-15 08:12:05');
    eq(array_keys($p),['ask_id','kind','audience','rev','state','deadline','default_policy','lang','text','items','updated_at'],'顶层键');
    eq(array_keys($p['items'][0]),['item_id','type','required','requires_text_when','prompt','situation','recommendation','hint','options','effective_answer','last_note'],'item 键');
    $js=json_encode($p,JSON_UNESCAPED_UNICODE);
    foreach(['source_ref','task_id','plan_id','1413','sha256:','card_token','output_url','内部中文','关键词方向','actor','idempotency','wfu_'] as $bad)
        is_true(strpos($js,$bad)===false,"投影泄露了 $bad");
    eq($p['lang'],'en','lang');eq($p['text']['title'],'Keyword direction','primary 文本');
    eq($p['items'][0]['options'][0],['code'=>'agree','label'=>'Agree'],'选项码加标签');
    eq($p['deadline'],'2026-10-30T00:00:00Z','deadline ISO');
    eq($p['updated_at'],'2026-10-15T08:12:05Z','updated_at ISO');
});
t('effective_answer：表态取最后一次，multi 拆 values，存量行按 actor 推渠道，库钟换 UTC',function()use($ASK,$FX){
    $ask=$ASK+['state'=>'open'];
    $p=asks_project($ask,asks_fold_effective($FX['rows']),'en','2026-10-16 03:00:00',46800,null);
    $by=[];foreach($p['items'] as $it)$by[$it['item_id']]=$it;
    eq($by['d1']['effective_answer']['choice'],'hold','d1 生效 hold（other 不覆盖）');
    eq($by['d1']['effective_answer']['channel'],'agencyreport','存量 client 行渠道');
    eq($by['d1']['effective_answer']['answered_at'],'2026-10-09T20:05:00Z','库钟 NZDT 09:05 减 13h');
    eq($by['d1']['last_note']['text'],'second note','旁注取最后一条');
    eq($by['d1']['last_note']['channel'],'webforger','新列渠道');
    eq($by['d1']['last_note']['answered_at'],'2026-10-11T19:00:00Z','answered_at 已是 UTC 原样出');
    eq($by['negatives']['effective_answer']['values'],['kw_12'],'multi values');
    eq($by['negatives']['effective_answer']['ask_rev'],1,'ask_rev');
    eq($by['d2']['effective_answer']['channel'],'ops','agency: 代确认行算 ops');
    eq($by['global_note']['effective_answer'],null,'text 型无表态');
    eq($by['global_note']['last_note']['text'],'overall fine','text 型看旁注');
});
t('状态推导：answered / open / expired / void 照返',function()use($ASK,$FX){
    $f=asks_fold_effective($FX['rows']);
    eq(asks_state('open','2026-10-30 00:00:00','2026-10-16 03:00:00',$ASK['items'],$f),'answered','d1 d2 都有表态即 answered');
    eq(asks_state('open','2026-10-30 00:00:00','2026-10-16 03:00:00',$ASK['items'],[]),'open','无答 open');
    eq(asks_state('open','2026-10-30 00:00:00','2026-10-30 00:00:00',$ASK['items'],[]),'expired','到截止 expired');
    eq(asks_state('void',null,'2026-10-16 03:00:00',$ASK['items'],$f),'void','void 照返');
    eq(asks_state('closed',null,'2026-10-16 03:00:00',$ASK['items'],$f),'closed','closed 照返');
});
t('语言：primary 缺省按 profile，profile 空按 zh；texts 缺该语言退 zh 并如实标',function(){
    eq(asks_pick_lang(['texts'=>['en'=>['title'=>'E'],'zh'=>['title'=>'中']]],'en')[0],'en','profile en');
    eq(asks_pick_lang(['texts'=>['zh'=>['title'=>'中']]],'')[0],'zh','空 profile 按 zh');
    eq(asks_pick_lang(['primary'=>'ja','texts'=>['zh'=>['title'=>'中']]],'en')[0],'zh','缺 ja 退 zh');
    eq(asks_pick_lang(['primary'=>'en','texts'=>['en'=>['title'=>'E']]],'zh')[1]['title'],'E','定版 primary 优先于后改的 profile');
});

echo "\n$pass passed, $fail failed\n";
exit($fail?1:0);
