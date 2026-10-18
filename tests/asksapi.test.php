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
if(!preg_match("#function asks_integration_tokens\(\)\{return (\[[\s\S]*?\n\]);\}#",$src,$tm)){fwrite(STDERR,"找不到 asks_integration_tokens\n");exit(1);}
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
    /* 2026-10-18 Marketing Inbox 扩绑：狗粮三站，原两条 scope 不动只追加 */
    eq($TOKENS[0]['client_ids'],[55,52,53],'webforger 这枚绑狗粮三站 55/52/53');
    eq($TOKENS[0]['scopes'],['asks:read','answers:write','messages:write','replies:read'],'scopes');
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

section('选项码放开（2026-10-17 缺口 A）');

t('自定义码：登记过、入账成行、折成 effective_answer、必答项齐即 answered',function()use($REG){
    $x=$REG;
    $x['items']=[
        ['item_id'=>'brand','type'=>'single','options'=>['keep_brand','pause_brand','other']],
        ['item_id'=>'note','type'=>'text','options'=>[],'required'=>false],
    ];
    list($ask,$e)=asks_norm_register($x);
    eq($e,null,'自定义码登记不该报错');
    list($rows,$errs)=asks_validate_answers($ask['items'],[['item_id'=>'brand','choice'=>'pause_brand']]);
    eq($errs,[],'自定义码入账不该报错');
    eq($rows[0],['item'=>'brand','choice'=>'pause_brand','fb'=>''],'行原样落码');
    $ledger=[['id'=>501,'item'=>'brand','choice'=>'pause_brand','fb'=>'','created_at'=>'2026-10-17 10:00:00','actor'=>'webforger:client:wfu_ab12','channel'=>'webforger','answered_at'=>'2026-10-16 21:00:00','ask_rev'=>2]];
    $f=asks_fold_effective($ledger);
    eq($f['brand']['stance']['choice'],'pause_brand','自定义码算表态');
    $p=asks_project($ask+['state'=>'open'],$f,'en','2026-10-17 00:00:00',46800,null);
    eq($p['items'][0]['effective_answer']['choice'],'pause_brand','effective_answer');
    eq($p['items'][0]['effective_answer']['text'],null,'非 flag 不拆 values');
    eq($p['state'],'answered','自定义码必答项有表态即 answered');
});
t('flag 是 multi 保留码：single/approve 登记带 flag 拒，旧 Ask 的 single 答 flag 也拒',function()use($REG){
    $x=$REG;$x['items'][1]['options']=['agree','flag','other'];
    eq(asks_norm_register($x)[1],'item d2 option code flag is reserved for multi','single 登记 flag');
    $x=$REG;$x['kind']='plan_approval';$x['source_ref']['plan_id']=65;
    $x['items']=[['item_id'=>'approve','type'=>'approve','options'=>['approve','reject','flag'],'requires_text_when'=>['reject']]];
    eq(asks_norm_register($x)[1],'item approve option code flag is reserved for multi','approve 登记 flag');
    $legacy=[['item_id'=>'d9','type'=>'single','options'=>['agree','flag'],'required'=>true,'requires_text_when'=>[],'default_value'=>null]];
    list($rows,$errs)=asks_validate_answers($legacy,[['item_id'=>'d9','choice'=>'flag']]);
    eq($rows,null,'整单不给行');eq($errs,['item d9 choice flag is reserved for multi'],'答 flag 拒');
});
t('列宽：single/approve 码限 16 字符，multi 词条码不受限',function()use($REG){
    $x=$REG;$x['items'][1]['options']=['agree',str_repeat('a',17)];
    eq(asks_norm_register($x)[1],'item d2 option code over 16 chars','17 字符拒');
    $x=$REG;$x['items'][1]['options']=['agree',str_repeat('a',16)];
    eq(asks_norm_register($x)[1],null,'16 字符过');
    $x=$REG;$x['items'][2]['options']=['kw_'.str_repeat('9',100)];
    eq(asks_norm_register($x)[1],null,'multi 长码过');
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
    $ask=$ASK+['state'=>'open','created_at'=>'2026-10-14 21:30:00'];$ask['lang_pack']=$ASK['lang_pack'];
    $p=asks_project($ask,asks_fold_effective($FX['rows']),'en','2026-10-16 03:00:00',46800,'2026-10-15 08:12:05');
    eq(array_keys($p),['ask_id','kind','audience','service','rev','state','deadline','default_policy','lang','text','blocks','items','created_at','updated_at'],'顶层键（2026-10-19 加 blocks）');
    eq(array_keys($p['items'][0]),['item_id','type','required','requires_text_when','prompt','situation','recommendation','hint','options','block_refs','effective_answer','last_note'],'item 键（2026-10-19 加 block_refs）');
    $js=json_encode($p,JSON_UNESCAPED_UNICODE);
    foreach(['source_ref','task_id','plan_id','1413','sha256:','card_token','output_url','内部中文','关键词方向','actor','idempotency','wfu_'] as $bad)
        is_true(strpos($js,$bad)===false,"投影泄露了 $bad");
    eq($p['lang'],'en','lang');eq($p['text']['title'],'Keyword direction','primary 文本');
    eq($p['items'][0]['options'][0],['code'=>'agree','label'=>'Agree'],'选项码加标签');
    eq($p['deadline'],'2026-10-30T00:00:00Z','deadline ISO');
    eq($p['updated_at'],'2026-10-15T08:12:05Z','updated_at ISO');
    eq($p['created_at'],'2026-10-14T21:30:00Z','created_at ISO');
    is_true(preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/',$p['created_at'])===1,'created_at 是 ISO8601 UTC');
    $p0=asks_project($ASK+['state'=>'open'],[],'en','2026-10-16 03:00:00',46800,null);
    is_true(array_key_exists('created_at',$p0)&&$p0['created_at']===null,'缺 created_at 兜底 null');
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

section('车道字段 service（2026-10-17 SEO 与 SEM 分开反馈分开批准）');

t('登记带 service：seo、sem 照收；缺省、null、空串都落 NULL（通用卡）',function()use($REG){
    list($r,$e)=asks_norm_register($REG);eq($e,null,'缺省不报错');eq($r['service'],null,'缺省 NULL');
    foreach(['seo','sem'] as $v){$x=$REG;$x['service']=$v;list($r,$e)=asks_norm_register($x);eq($e,null,"$v 该过");eq($r['service'],$v,"$v 落库值");}
    $x=$REG;$x['service']=null;eq(asks_norm_register($x)[0]['service'],null,'显式 null');
    $x=$REG;$x['service']='';eq(asks_norm_register($x)[0]['service'],null,'空串视同缺省');
});
t('非法 service 登记拒（asks_register_one 据此回 422）：大小写、paid、both、非字符串都不认',function()use($REG){
    foreach(['SEO','paid','both','seo,sem',1,['seo']] as $v){
        $x=$REG;$x['service']=$v;list($r,$e)=asks_norm_register($x);
        eq($r,null,'非法值不该给行 '.var_export($v,true));eq($e,'bad service','错误文案 '.var_export($v,true));
    }
});
t('GET 车道过滤 asks_service_ok：不传出全部，seo/sem 只出本车道，通用卡不进车道结果',function(){
    eq(asks_service_ok(null,''),true,'不过滤时通用卡出');
    eq(asks_service_ok('sem',''),true,'不过滤时 sem 卡出');
    eq(asks_service_ok('seo','seo'),true,'seo 卡进 seo');
    eq(asks_service_ok('sem','seo'),false,'sem 卡不进 seo');
    eq(asks_service_ok(null,'sem'),false,'通用卡不进 sem');
    eq(asks_service_ok('','seo'),false,'空串按通用');
});
t('投影带 service：有值原样出，库里 NULL 或空串出 null',function()use($REG,$FX){
    $x=$REG;$x['service']='sem';list($a,)=asks_norm_register($x);$a['state']='open';
    $p=asks_project($a,asks_fold_effective([]),'en','2026-10-16 03:00:00',46800,null);
    eq($p['service'],'sem','sem 原样');
    $a['service']=null;eq(asks_project($a,[],'en','2026-10-16 03:00:00',46800,null)['service'],null,'NULL 出 null');
    $a['service']='';eq(asks_project($a,[],'en','2026-10-16 03:00:00',46800,null)['service'],null,'空串出 null');
    unset($a['service']);eq(asks_project($a,[],'en','2026-10-16 03:00:00',46800,null)['service'],null,'老行无列出 null');
});

section('plan_approval 登记约束（2026-10-17 缺口 B）');

$PREG=$REG;$PREG['kind']='plan_approval';$PREG['source_ref']=['plan_id'=>65];
$PREG['items']=[
    ['item_id'=>'approve','type'=>'approve','options'=>['approve','reject'],'requires_text_when'=>['reject']],
    ['item_id'=>'note','type'=>'text','options'=>[],'required'=>false],
];
t('缺 plan_id、default_policy 非 none、approve 题不是恰好一个、reject 不必填文本都拒',function()use($PREG){
    list($r,$e)=asks_norm_register($PREG);eq($e,null,'好登记体该过');eq($r['default_policy'],'none','默认 none');
    $x=$PREG;unset($x['source_ref']);eq(asks_norm_register($x)[1],'plan_approval requires source_ref.plan_id','缺 source_ref');
    $x=$PREG;$x['source_ref']=['plan_id'=>0];eq(asks_norm_register($x)[1],'plan_approval requires source_ref.plan_id','plan_id 0');
    $x=$PREG;$x['default_policy']='no_reply_follow_recommendation';eq(asks_norm_register($x)[1],'plan_approval default_policy must be none','默认策略');
    $x=$PREG;$x['items'][0]['requires_text_when']=[];eq(asks_norm_register($x)[1],'item approve must require text when reject','reject 不必填');
    $x=$PREG;$x['items'][]=['item_id'=>'approve2','type'=>'approve','options'=>['approve','reject'],'requires_text_when'=>['reject']];
    eq(asks_norm_register($x)[1],'plan_approval needs exactly one approve item','两个 approve 题');
    $x=$PREG;$x['items']=[$PREG['items'][1]];eq(asks_norm_register($x)[1],'plan_approval needs exactly one approve item','没有 approve 题');
});
t('approved_by 压缩：放得下原样，超 50 存 wf: 前缀截断',function(){
    eq(asks_approved_by('webforger:client:wfu_ab12'),'webforger:client:wfu_ab12','短的原样');
    $long='webforger:agency:'.str_repeat('x',60);
    $c=asks_approved_by($long);
    is_true(strlen($c)<=50,'超列宽');eq(substr($c,0,10),'wf:agency:','前缀');
});

section('plan_approval 审批生效（假 PDO 跑 ASKS-TXN 与 PLAN-CORE 两块）');

foreach(['ASKS-TXN','PLAN-CORE'] as $mk){
    if(!preg_match('#/\* '.$mk.'-START([\s\S]*?)/\* '.$mk.'-END \*/#',$src,$bm)){fwrite(STDERR,"找不到 $mk 标记\n");exit(1);}
    eval(preg_replace('#^[\s\S]*?\*/#','',$bm[1],1));
}
class FakePDOEx extends PDOException{function __construct($msg,$code){parent::__construct($msg);$this->code=$code;}}
/* 内存假库：只认两块代码里出现的 SQL，认不出的直接抛，SQL 漂移会当场暴露。事务按快照回滚。 */
class FakeDB{
    public $t=['plans'=>[],'tasks'=>[],'asks'=>[],'fb'=>[],'inbox'=>[]];
    public $snap=null;public $last=0;public $failInsert=null;public $log=[];
    function beginTransaction(){if($this->snap!==null)throw new Exception('nested tx');$this->snap=$this->t;return true;}
    function commit(){if($this->snap===null)throw new Exception('no tx');$this->snap=null;return true;}
    function rollBack(){if($this->snap===null)throw new Exception('no tx');$this->t=$this->snap;$this->snap=null;return true;}
    function inTransaction(){return $this->snap!==null;}
    function lastInsertId(){return (string)$this->last;}
    function prepare($sql){return new FakeStmt($this,preg_replace('/\s+/',' ',trim($sql)));}
}
class FakeStmt{
    public $db;public $sql;public $rows=[];public $n=0;
    function __construct($db,$sql){$this->db=$db;$this->sql=$sql;}
    function fetch(){return $this->rows?array_shift($this->rows):false;}
    function fetchAll(){$r=$this->rows;$this->rows=[];return $r;}
    function rowCount(){return $this->n;}
    function execute($a=[]){
        $d=$this->db;$q=$this->sql;$T=&$d->t;$d->log[]=$q;
        if($q==="SELECT id,client_id,status FROM seo_plans WHERE id=? FOR UPDATE"){
            $p=$T['plans'][$a[0]]??null;$this->rows=$p?[['id'=>$p['id'],'client_id'=>$p['client_id'],'status'=>$p['status']]]:[];return true;}
        if($q==="SELECT COUNT(*) AS n FROM seo_tasks WHERE plan_id=? AND status='proposed'"){
            $n=0;foreach($T['tasks'] as $x)if($x['plan_id']==$a[0]&&$x['status']==='proposed')$n++;$this->rows=[['n'=>$n]];return true;}
        if($q==="SELECT id FROM seo_plans WHERE client_id=? AND status='active' AND id<>?"){
            foreach($T['plans'] as $x)if($x['client_id']==$a[0]&&$x['status']==='active'&&$x['id']!=$a[1])$this->rows[]=['id'=>$x['id']];return true;}
        if($q==="UPDATE seo_plans SET status='superseded' WHERE client_id=? AND status='active' AND id<>?"){
            foreach($T['plans'] as &$x)if($x['client_id']==$a[0]&&$x['status']==='active'&&$x['id']!=$a[1])$x['status']='superseded';return true;}
        if($q==="UPDATE seo_plans SET status='active',approved_by=?,reject_reason=NULL WHERE id=?"){
            $T['plans'][$a[1]]['status']='active';$T['plans'][$a[1]]['approved_by']=$a[0];$T['plans'][$a[1]]['reject_reason']=null;return true;}
        if(strpos($q,"UPDATE seo_tasks SET status='approved' WHERE plan_id=? AND status='proposed'")===0){
            $ex=array_slice($a,1);
            foreach($T['tasks'] as &$x)if($x['plan_id']==$a[0]&&$x['status']==='proposed'&&!in_array($x['id'],$ex)){$x['status']='approved';$this->n++;}return true;}
        if($q==="UPDATE seo_plans SET status='rejected',reject_reason=?,approved_by=? WHERE id=?"){
            $T['plans'][$a[2]]['status']='rejected';$T['plans'][$a[2]]['reject_reason']=$a[0];$T['plans'][$a[2]]['approved_by']=$a[1];return true;}
        if($q==="SELECT id FROM seo_tasks WHERE plan_id=? AND status='proposed'"){
            foreach($T['tasks'] as $x)if($x['plan_id']==$a[0]&&$x['status']==='proposed')$this->rows[]=['id'=>$x['id']];return true;}
        if($q==="SELECT id FROM seo_tasks WHERE plan_id=? AND status IN('proposed','approved','blocked')"){
            foreach($T['tasks'] as $x)if($x['plan_id']==$a[0]&&in_array($x['status'],['proposed','approved','blocked']))$this->rows[]=['id'=>$x['id']];return true;}
        if(strpos($q,"UPDATE seo_inbox SET status='resolved' WHERE client_id=? AND kind='digest' AND status='open' AND body LIKE ?")===0){
            $T['inbox'][]=[$a[0],$a[1]];return true;}
        if($q==="SELECT state FROM seo_asks WHERE ask_id=? FOR UPDATE"){
            $x=$T['asks'][$a[0]]??null;$this->rows=$x?[['state'=>$x['state']]]:[];return true;}
        if(strpos($q,"INSERT INTO seo_card_feedback(")===0){
            if($d->failInsert)throw new FakePDOEx('boom',$d->failInsert);
            $d->last=count($T['fb'])+900;$T['fb'][]=['id'=>$d->last,'item'=>$a[1],'choice'=>$a[2],'fb'=>$a[3],'actor'=>$a[5],'ask_id'=>$a[6]];return true;}
        if($q==="UPDATE seo_asks SET state='closed',closed_at=?,updated_at=? WHERE ask_id=?"){
            $T['asks'][$a[2]]['state']='closed';$T['asks'][$a[2]]['closed_at']=$a[0];return true;}
        throw new Exception('假库认不出的 SQL：'.$q);
    }
}
$FDB=null;
function db(){global $FDB;return $FDB;}
/* task_close 替身：真函数在 seo-api.php 主体（改 status=done、追 note、排叙述），这里只记结束类型。 */
function task_close($tid,$kind,$reason='',$by=''){
    global $FDB;$t=&$FDB->t['tasks'][$tid];
    if($t['status']==='done')return '任务已经结束';
    $t['status']='done';$t['close']=$kind;$t['by']=$by;return null;
}
function fx_db(){
    global $FDB;$FDB=new FakeDB();
    $FDB->t['plans']=[
        60=>['id'=>60,'client_id'=>55,'status'=>'active','approved_by'=>'alvin','reject_reason'=>null],
        65=>['id'=>65,'client_id'=>55,'status'=>'draft','approved_by'=>'','reject_reason'=>null],
        66=>['id'=>66,'client_id'=>56,'status'=>'draft','approved_by'=>'','reject_reason'=>null],
        64=>['id'=>64,'client_id'=>55,'status'=>'superseded','approved_by'=>'','reject_reason'=>null],
    ];
    $FDB->t['tasks']=[
        1=>['id'=>1,'plan_id'=>65,'status'=>'proposed'],2=>['id'=>2,'plan_id'=>65,'status'=>'proposed'],
        3=>['id'=>3,'plan_id'=>65,'status'=>'in_progress'],
        4=>['id'=>4,'plan_id'=>60,'status'=>'approved'],5=>['id'=>5,'plan_id'=>60,'status'=>'in_progress'],
        6=>['id'=>6,'plan_id'=>64,'status'=>'proposed'],
    ];
    $FDB->t['asks']['ask_plan65']=['state'=>'open'];
    return $FDB;
}
list($PASK,)=asks_norm_register(array_merge($PREG,['ask_id'=>'ask_plan65']));
$PASK['source_ref']=json_encode($PASK['source_ref']);$PASK['state']='open';
$CTX=['cid'=>55,'actor'=>'webforger:client:wfu_ab12','key'=>'wf:k1','rev'=>2,'ans_at'=>'2026-10-17 01:00:00','ip'=>'1.2.3.4','now'=>'2026-10-17 01:00:01'];

t('答 approve：方案转 active、旧现役 superseded、proposed 转 approved、Ask closed、账本有行；再答 409',function()use($PASK,$CTX){
    $d=fx_db();
    list($c,$o)=asks_answers_commit($d,$PASK,[['item'=>'approve','choice'=>'approve','fb'=>'']],$CTX);
    eq($c,200,'应 200');
    eq($d->t['plans'][65]['status'],'active','方案转 active');
    eq($d->t['plans'][65]['approved_by'],'webforger:client:wfu_ab12','approved_by 记 actor');
    eq($d->t['plans'][60]['status'],'superseded','旧现役降级');
    eq([$d->t['tasks'][1]['status'],$d->t['tasks'][2]['status'],$d->t['tasks'][3]['status']],['approved','approved','in_progress'],'任务晋级');
    eq($d->t['asks']['ask_plan65']['state'],'closed','Ask closed');
    eq($d->t['asks']['ask_plan65']['closed_at'],'2026-10-17 01:00:01','closed_at');
    eq(count($d->t['fb']),1,'账本一行');eq($d->inTransaction(),false,'事务已提交');
    eq($o['plan']['decision'],'approve','决定');eq($o['plan']['superseded'],[60],'被取代方案交给收尾');
    eq(plan_approve_finish(65,55,$o['plan']['superseded'],$o['by']),[4],'收尾收掉旧现役未开工任务');
    eq($d->t['tasks'][5]['status'],'in_progress','做到一半的留着');
    list($c2,$o2)=asks_answers_commit($d,$PASK,[['item'=>'approve','choice'=>'reject','fb'=>'changed mind']],array_merge($CTX,['key'=>'wf:k2']));
    eq($c2,409,'closed 后再答 409');eq($o2['ask_state'],'closed','回 ask_state');
    eq(count($d->t['fb']),1,'409 不落账本行');eq($d->t['plans'][65]['status'],'active','方案不动');
    eq(asks_state('closed',null,'2026-10-17 02:00:00',$PASK['items'],[]),'closed','路由层读时状态同样 closed，前置 409 覆盖');
});
t('答 reject：方案 rejected 记理由、proposed 任务 killed、Ask closed；无理由用固定一句兜底',function()use($PASK,$CTX){
    $d=fx_db();
    list($c,$o)=asks_answers_commit($d,$PASK,[['item'=>'approve','choice'=>'reject','fb'=>'too aggressive on paid']],$CTX);
    eq($c,200,'应 200');
    eq($d->t['plans'][65]['status'],'rejected','方案 rejected');
    eq($d->t['plans'][65]['reject_reason'],'too aggressive on paid','理由');
    eq([$d->t['tasks'][1]['close']??null,$d->t['tasks'][2]['close']??null],['killed','killed'],'proposed 任务 killed');
    eq($d->t['tasks'][3]['status'],'in_progress','非 proposed 不动');
    eq($o['plan']['killed'],[1,2],'killed 清单');
    eq($d->t['plans'][60]['status'],'active','驳回不碰现役');
    eq($d->t['asks']['ask_plan65']['state'],'closed','Ask closed');
    $d=fx_db();
    list($c,)=asks_answers_commit($d,$PASK,[['item'=>'approve','choice'=>'reject','fb'=>'']],$CTX);
    eq($c,200,'兜底也 200');eq($d->t['plans'][65]['reject_reason'],ASK_PLAN_REJECT_FALLBACK,'兜底理由');
});
t('业务终态失败整体回滚：非 draft 409、方案不属本 client 422、方案不存在 422、Ask 缺 plan_id 422',function()use($PASK,$CTX){
    $d=fx_db();$d->t['plans'][65]['status']='superseded';
    list($c,$o)=asks_answers_commit($d,$PASK,[['item'=>'approve','choice'=>'approve','fb'=>'']],$CTX);
    eq($c,409,'非 draft 409');eq($o['plan_error'],'not_draft','错误码');
    eq(count($d->t['fb']),0,'账本行回滚');eq($d->t['asks']['ask_plan65']['state'],'open','Ask 不关');
    eq($d->t['plans'][60]['status'],'active','现役不动');eq($d->inTransaction(),false,'无悬空事务');
    $d=fx_db();$x=$PASK;$x['source_ref']=json_encode(['plan_id'=>66]);
    eq(asks_answers_commit($d,$x,[['item'=>'approve','choice'=>'approve','fb'=>'']],$CTX)[0],422,'别家方案 422');
    eq($d->t['plans'][66]['status'],'draft','别家方案不动');
    $d=fx_db();$x=$PASK;$x['source_ref']=json_encode(['plan_id'=>999]);
    eq(asks_answers_commit($d,$x,[['item'=>'approve','choice'=>'reject','fb'=>'x']],$CTX)[0],422,'不存在 422');
    $d=fx_db();$x=$PASK;$x['source_ref']='{}';
    eq(asks_answers_commit($d,$x,[['item'=>'approve','choice'=>'approve','fb'=>'']],$CTX)[0],422,'缺 plan_id 422');
    eq($d->log,[],'缺 plan_id 不碰库');
});
t('只交旁注不动方案也不关 Ask；DB 临时故障 502 回滚、撞唯一键交路由重放',function()use($PASK,$CTX){
    $d=fx_db();
    list($c,$o)=asks_answers_commit($d,$PASK,[['item'=>'note','choice'=>'other','fb'=>'reading it now']],$CTX);
    eq($c,200,'旁注 200');eq($o['plan'],null,'无方案决定');
    eq($d->t['asks']['ask_plan65']['state'],'open','Ask 仍 open');eq($d->t['plans'][65]['status'],'draft','方案不动');
    $d=fx_db();$d->failInsert='HY000';
    eq(asks_answers_commit($d,$PASK,[['item'=>'approve','choice'=>'approve','fb'=>'']],$CTX)[0],502,'临时故障 502');
    eq($d->t['plans'][65]['status'],'draft','回滚');eq($d->inTransaction(),false,'无悬空事务');
    $d=fx_db();$d->failInsert='23000';
    eq(asks_answers_commit($d,$PASK,[['item'=>'approve','choice'=>'approve','fb'=>'']],$CTX)[0],'replay','撞键走重放');
    $d=fx_db();$d->failInsert='HY000';$x=$PASK;$x['kind']='direction';
    eq(asks_answers_commit($d,$x,[['item'=>'note','choice'=>'other','fb'=>'x']],$CTX)[0],500,'非方案 Ask 维持原 500');
});
t('admin 口径不变：不传 require_draft 时非 draft 也能批/驳，exclude 的任务留在 proposed',function(){
    $d=fx_db();$d->beginTransaction();
    $r=plan_approve_core($d,64,'alvin',['exclude_task_ids'=>[6]]);
    $d->commit();
    eq($r['ok']??null,true,'superseded 方案 admin 照批');eq([$r['approved'],$r['total']],[0,1],'计数');
    eq($d->t['tasks'][6]['status'],'proposed','exclude 留 proposed');
    eq($d->t['plans'][64]['approved_by'],'alvin','approved_by');
    eq(plan_approve_core($d,999,'alvin')['err'],'not_found','不存在');
    $d=fx_db();
    $r=plan_reject_core($d,60,'alvin','stale');
    eq($r['ok']??null,true,'admin 驳回不开事务不查状态');eq($d->t['plans'][60]['status'],'rejected','现役也能驳');
    eq($d->inTransaction(),false,'核心不自己开事务');
});

section('card_data v1 桥侧（2026-10-19）：内容块、block_refs、解码表、卡类注册表');

$BLK=[
    ['id'=>'b_groups','type'=>'table','title'=>'目标词分组','columns'=>['词','承接页'],'rows'=>[['shopify alternative','/shopify-alternative/'],['wix vs wordpress','/wix-vs-wordpress/']]],
    ['id'=>'b_note','type'=>'para','text'=>'首页保品牌，见 https://agencyreport.horntech-dev.com/x.html'],
    ['id'=>'b_list','type'=>'list','items'=>['一','二']],
    ['id'=>'b_kv','type'=>'kv','entries'=>[['k'=>'窗口','v'=>'近四周']]],
];
t('四种块全过且逐字段重建（多余键丢弃）',function()use($BLK){
    $in=$BLK;$in[0]['html']='<b>x</b>';$in[1]['extra']=1;
    list($b,$e)=asks_blocks_norm($in);
    eq($e,null,'不该报错');eq(count($b),4,'块数');
    eq(array_keys($b[0]),['id','type','title','columns','rows'],'table 键白名单');
    eq(array_keys($b[1]),['id','type','text'],'para 键白名单');
    eq(asks_blocks_norm(null),[[],null],'null 即空');
});
t('坏块整段拒：HTML 标签、行宽不等、超列、未知类型、重复 id、坏 id',function()use($BLK){
    $x=$BLK;$x[1]['text']='<script>alert(1)</script>';is_true(asks_blocks_norm($x)[1]!==null,'HTML 标签');
    $x=$BLK;$x[0]['rows'][]=['只有一格'];is_true(strpos(asks_blocks_norm($x)[1],'row width')!==false,'行宽');
    $x=$BLK;$x[0]['columns']=array_fill(0,9,'c');is_true(asks_blocks_norm($x)[1]!==null,'超 8 列');
    $x=$BLK;$x[2]['type']='chart';is_true(strpos(asks_blocks_norm($x)[1],'bad type')!==false,'未知类型');
    $x=$BLK;$x[3]['id']='b_groups';is_true(strpos(asks_blocks_norm($x)[1],'duplicate')!==false,'重复 id');
    $x=$BLK;$x[3]['id']='groups';is_true(strpos(asks_blocks_norm($x)[1],'bad id')!==false,'坏 id');
});
t('登记：block_refs 落 items，块进 lang_pack 规整，引用不存在的块整包拒',function()use($REG,$BLK){
    $x=$REG;$x['items'][0]['block_refs']=['b_groups'];$x['lang_pack']['texts']['en']['blocks']=$BLK;
    list($r,$e)=asks_norm_register($x);
    eq($e,null,'不该报错');eq($r['items'][0]['block_refs'],['b_groups'],'block_refs');eq($r['items'][1]['block_refs'],[],'缺省空');
    eq(count($r['lang_pack']['texts']['en']['blocks']),4,'块已规整入包');
    $y=$x;$y['items'][1]['block_refs']=['b_missing'];
    is_true(strpos(asks_norm_register($y)[1],'b_missing')!==false,'悬空引用');
    $y=$x;$y['items'][1]['block_refs']=['Bad'];eq(asks_norm_register($y)[1],'item d2 bad block_ref','坏引用');
    $y=$x;$y['lang_pack']['texts']['en']['blocks'][1]['text']='<i>x</i>';
    is_true(strpos(asks_norm_register($y)[1],'lang_pack.texts.en.blocks')!==false,'块坏整包拒');
});
t('投影：blocks 按对外语言出，item 带 block_refs；存量行无块回空数组',function()use($REG,$BLK,$ASK){
    $x=$REG;$x['items'][0]['block_refs']=['b_groups'];$x['lang_pack']['texts']['en']['blocks']=$BLK;
    list($r,)=asks_norm_register($x);
    $ask=$r+['state'=>'open'];
    $p=asks_project($ask,[],'en','2026-10-16 03:00:00',46800,null);
    eq(count($p['blocks']),4,'块数');eq($p['blocks'][0]['rows'][0][0],'shopify alternative','表格内容');
    eq($p['items'][0]['block_refs'],['b_groups'],'item 引用');
    $p0=asks_project($ASK+['state'=>'open'],[],'en','2026-10-16 03:00:00',46800,null);
    eq($p0['blocks'],[],'存量无块');eq($p0['items'][0]['block_refs'],[],'存量无引用');
    $bad=$ask;$bad['lang_pack']['texts']['en']['blocks'][0]['type']='chart';
    eq(asks_project($bad,[],'en','2026-10-16 03:00:00',46800,null)['blocks'],[],'库里坏块整段不出');
});
t('解码表：item => code => label，按对外语言取，缺 label 回 null',function()use($REG){
    $x=$REG;$x['lang_pack']['texts']['en']['items']['negatives']=['options'=>['kw_12'=>'free website builder','kw_31'=>'wordpress hosting']];
    $d=asks_decode_table($x,'en');
    eq($d['d1'],['agree'=>'Agree','hold'=>'Hold','other'=>'Other'],'single');
    eq($d['negatives'],['kw_12'=>'free website builder','kw_31'=>'wordpress hosting','kw_40'=>null],'multi');
    eq($d['global_note'],[],'text 无码');
});
t('作答时刻：answered_at 优先，否则库钟换 UTC',function(){
    eq(asks_row_at_utc(['answered_at'=>'2026-10-18 09:42:10','created_at'=>'2026-10-18 22:42:10'],46800),'2026-10-18 09:42:10','WF 行');
    eq(asks_row_at_utc(['answered_at'=>null,'created_at'=>'2026-10-18 22:42:10'],46800),'2026-10-18 09:42:10','卡页行');
});
t('卡类注册表：仓库里的 card_kinds.json 解出的 op 映射与内置兜底逐字一致，命中规则同旧',function(){
    $reg=json_decode(file_get_contents(__DIR__.'/../seo-worker/specs/card_kinds.json'),true);
    $m=asks_card_kind_op_map_from($reg);
    is_true(is_array($m),'注册表应可解');
    ksort($m);$f=asks_card_kind_fallback();ksort($f);
    eq($m,$f,'注册表与兜底表');
    eq(asks_card_kind_pick('page-meta-update, keyword-confirmation,mapping-confirmation',$m),'keyword_confirmation','首个命中');
    eq(asks_card_kind_pick('blog-draft',$m),null,'博客与落地页卡不由 ops 推导');
    eq(asks_card_kind_op_map_from(['kinds'=>['a_kind'=>['ops'=>['x']],'b_kind'=>['ops'=>['x']]]]),null,'一个 op 两种卡判坏');
    eq(asks_card_kind_op_map_from(null),null,'缺表');
});

t('跨端契约：askreg 为 1464 出的 rev 2 登记体（tests/fixtures/ask_t1464_rev2.json）服务端整包接受',function(){
    $in=json_decode(file_get_contents(__DIR__.'/fixtures/ask_t1464_rev2.json'),true);
    list($r,$e)=asks_norm_register($in);
    eq($e,null,'不该报错');
    eq($r['rev'],2,'rev');eq($r['service'],'seo','车道');eq($r['default_policy'],'none','不默认同意');
    eq(array_column($r['items'],'item_id'),['group_first','group_next','group_hold','mapping_overall','global_note'],'题与 HTML 卡同批');
    eq($r['items'][1]['block_refs'],['b_next_rank','b_next_lowcomp','b_next_new'],'块引用');
    $p=asks_project($r+['state'=>'open'],[],'zh','2026-10-20 00:00:00',46800,null);
    eq(count($p['blocks']),8,'八个内容块出投影');
    eq(asks_decode_table($r,'zh')['mapping_overall']['agree'],'同意，按这份分工执行','解码表');
});

echo "\n$pass passed, $fail failed\n";
exit($fail?1:0);
