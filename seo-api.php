<?php
/* HornTech Ops Tracker - SEO Agent API
   Deployed to /www/wwwroot/always/seo-api.php
   Two auth layers:
     - dashboard endpoints: JWT from mini.php /login, role must be admin
     - worker endpoints: hardcoded service token, mapped to role seo_worker
   mini.php is untouched; DB constants / JWT key / audit are copied verbatim. */

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Headers: Content-Type, Authorization');
header('Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE, OPTIONS');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }

$DB_HOST='localhost'; $DB_USER='always-op'; $DB_PASS='mMewGDczS6hMJsWF'; $DB_NAME='always-op';
$JWT_KEY='horntech-ops-2026-key';
$WORKER_TKN='seo-worker-svc-9f3a71c2e8d4';
$WAKE_URL='http://192.168.10.205:8377/wake';
$WAKE_SECRET='seo-wake-2f8c1b7e';
/* Outside the webroot on purpose, see fb_dir(). Requires the BT panel's
   open_basedir toggle for this site to stay off (turned off 2026-08-22),
   otherwise PHP is fenced into the webroot and /tmp and uploads 500. */
$FEEDBACK_DIR='/www/wwwroot/always-uploads/feedback';
$FEEDBACK_MAX_BYTES=5*1024*1024;
$FEEDBACK_MAX_IMAGES=5;
/* Task deliverables. Same sibling-of-webroot arrangement as the feedback
   screenshots, same open_basedir dependency. These are files a human has to
   hand carry into an external system (a disavow txt into GSC, for example),
   so the worker writes them here and the board hands them back on click. */
$DELIVERABLE_DIR='/www/wwwroot/always-uploads/deliverables';
$DELIVERABLE_MAX_BYTES=5*1024*1024;

/* Every value seo_snapshots.source is allowed to take. One list, used by the
   routes for validation and by ensure_snapshot_sources() for the ENUM widen,
   so the two can never drift apart. Append only, never reorder or remove:
   dropping a value here would make the ALTER truncate existing rows. */
define('SNAPSHOT_SOURCES',['ga4','gsc','semrush','discovery','content_registry','ads']);

/* 日粒度时序表 seo_metrics_daily 允许的指标名，唯一权威清单。
   前端图表、worker 写入、GET /metrics 校验三处共用，永远不要在别处另抄一份。
   只增不改：改名等于把历史行变成孤儿，删名等于让老行读不出来。
   口径：
     gsc_impressions / gsc_clicks          GSC 按日全量（已排除垃圾词正则）
     gsc_impressions_brand / gsc_clicks_brand
                                           GSC 按日 query 维度里命中品牌正则的部分。
                                           GSC 会匿名化长尾 query，匿名行拿不到，
                                           所以品牌值恒 <= 全量值，两者相减得到的
                                           "非品牌" 里混着匿名部分，前端别当精确差值用。
     ga4_sessions_organic                  GA4 按日 Organic Search 渠道会话
     ga4_leads                             GA4 按日 form_submit + generate_lead
                                           + click_to_call 三个事件的 eventCount 之和
     rank_top3 / rank_top10 / rank_top20   Semrush 自然位次分档累计值（含前档，
                                           top10 包含 top3）。只算自然结果，
                                           SERP feature 占位（AI Overview 引用那种）
                                           不计入，这是 2026-08 踩过的坑。
     rank_tracked                          Semrush 自然排名词总数（top100 累计）
     ref_domains                           Semrush 引荐域总数
   排名与引荐域是"拉取当日一个点"，不是按日连续，无历史可回填。 */
define('METRIC_NAMES',[
    /* paid（渠道前缀 ads_ = Google；后续渠道用 bingads_ 这类自己的前缀，别复用 ads_）：
       ads_cost 单位是账户币种的元（worker 从 cost_micros 换算），ads_conv_value 同币种。 */
    'ads_cost','ads_clicks','ads_impressions','ads_conversions','ads_conv_value',
    'gsc_impressions','gsc_clicks','gsc_impressions_brand','gsc_clicks_brand',
    'ga4_sessions_organic','ga4_leads',
    'rank_top3','rank_top10','rank_top20','rank_tracked','ref_domains'
]);

/* Every action a ruling may turn into. Hard coded here, on the server, because
   this list is the whole safety boundary of the decision inbox: the model that
   reads a human ruling proposes actions, it never executes them. Anything not
   on this list is refused and reported back in the ack.
   Deliberately absent: anything irreversible, anything that spends money, and
   anything that publishes to the outside world. Those keep their own gates. */
define('INBOX_ACTIONS',['approve_task','reject_task','set_priority','set_sprint','kill_task','release_tasks','answer_fact','redispatch','noop']);

/* 收件箱对话用的三种消息类型，和原来的 digest/ruling/ack 同住 seo_inbox。
   chat_root  一次会话的根，body 存会话标题，client_id 必填（chat job 要归属客户）
   chat_user  人在会话里说的话，reply_to 指向根
   chat_agent opus 的回复，或者服务端写的系统行（已立项、会话归档），reply_to 指向根
   会话状态就是根行的 status：open 在聊，resolved 已归档。
   铁律：对话是任务编译器不是执行器。这三种消息本身不改看板任何一格，
   唯一的落账口子是 POST /inbox/{root}/spawn_task，那是人点了「立项」才走的。 */
define('CHAT_KINDS',['chat_root','chat_user','chat_agent']);
/* seo_inbox.kind ENUM 的完整取值，只增不改：删一个值等于让老行读不出来。 */
define('INBOX_KINDS',['digest','ruling','ack','chat_root','chat_user','chat_agent']);
/* 一条 chat_agent 回复最多挂几个任务草案，以及每个草案的字段上限。
   草案只是 refs 里的 JSON，不是任务，人点立项才变成任务。 */
define('CHAT_MAX_DRAFTS',5);

function db() {
    global $DB_HOST,$DB_USER,$DB_PASS,$DB_NAME;
    static $p=null;
    if(!$p) $p=new PDO("mysql:host=$DB_HOST;dbname=$DB_NAME;charset=utf8mb4",$DB_USER,$DB_PASS,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION,PDO::ATTR_DEFAULT_FETCH_MODE=>PDO::FETCH_ASSOC]);
    return $p;
}
function b64ue($d){return rtrim(strtr(base64_encode($d),'+/','-_'),'=');}
function jwt_dec($t){global $JWT_KEY;$p=explode('.',$t);if(count($p)!==3)return null;$ex=b64ue(hash_hmac('sha256',"$p[0].$p[1]",$JWT_KEY,true));if(!hash_equals($ex,$p[2]))return null;$d=json_decode(base64_decode(strtr($p[1],'-_','+/')),true);if(!$d||(isset($d['exp'])&&$d['exp']<time()))return null;return $d;}
function res($c,$d){http_response_code($c);echo json_encode($d,JSON_UNESCAPED_UNICODE);exit;}
function input(){return json_decode(file_get_contents('php://input'),true)?:[];}
function audit($user,$action,$target,$detail){db()->prepare("INSERT INTO audit_log(user,action,target,detail)VALUES(?,?,?,?)")->execute([$user,$action,$target,json_encode($detail,JSON_UNESCAPED_UNICODE)]);}
function bearer(){$a=$_SERVER['HTTP_AUTHORIZATION']??($_SERVER['REDIRECT_HTTP_AUTHORIZATION']??'');return trim(str_replace('Bearer ','',$a));}

/* Dashboard layer: valid JWT, live account, role admin. */
function auth_admin(){
    $t=bearer();
    if(!$t)res(401,['error'=>'No auth']);
    $u=jwt_dec($t);
    if(!$u)res(401,['error'=>'Bad token']);
    $s=db()->prepare("SELECT active,role FROM users WHERE username=?");
    $s->execute([$u['username']??'']);
    $r=$s->fetch();
    if($r&&!(int)$r['active'])res(403,['error'=>'Account disabled']);
    $role=$r?($r['role']??''):($u['role']??'');
    if($role!=='admin')res(403,['error'=>'Forbidden']);
    return $u;
}
/* Worker layer: hardcoded service token only, never a JWT. */
function auth_worker(){
    global $WORKER_TKN;
    $t=bearer();
    if(!$t)res(401,['error'=>'No auth']);
    if(!hash_equals($WORKER_TKN,$t))res(403,['error'=>'Forbidden']);
    return ['username'=>'seo-worker','role'=>'seo_worker'];
}
/* Either layer: read-only endpoints the dashboard and the runner both need. */
function auth_any(){
    global $WORKER_TKN;
    $t=bearer();
    if(!$t)res(401,['error'=>'No auth']);
    if(hash_equals($WORKER_TKN,$t))return ['username'=>'seo-worker','role'=>'seo_worker'];
    return auth_admin();
}

/* Nudge the worker on the ros box. Best effort: the worker also polls. */
function fire_wake($job_id){
    global $WAKE_URL,$WAKE_SECRET;
    if(!function_exists('curl_init'))return;
    $ch=curl_init($WAKE_URL);
    curl_setopt_array($ch,[
        CURLOPT_POST=>1,
        CURLOPT_RETURNTRANSFER=>1,
        CURLOPT_TIMEOUT=>2,
        CURLOPT_CONNECTTIMEOUT=>2,
        CURLOPT_HTTPHEADER=>['Content-Type: application/json','X-Seo-Secret: '.$WAKE_SECRET],
        CURLOPT_POSTFIELDS=>json_encode(['job_id'=>(int)$job_id])
    ]);
    @curl_exec($ch);
    @curl_close($ch);
}

function jdec($v){if($v===null||$v==='')return null;$d=json_decode($v,true);return $d===null?$v:$d;}
function need_client(){$c=(int)($_GET['client_id']??0);if(!$c)res(400,['error'=>'client_id required']);return $c;}

/* Feedback schema, created lazily on the first feedback request.
   Three pieces:
     seo_feedback, the raw human note plus the parse result;
     seo_feedback.images, added later for pasted screenshots;
     agent_jobs.type, an ENUM that predates the feedback job, widened once.
   Both ALTERs are guarded by a cheap information_schema read and only ever run
   on a database that has not been migrated yet. MariaDB 10.3 has no
   MODIFY ... IF NOT EXISTS, so the read is what makes this idempotent. */
function ensure_feedback_schema(){
    static $done=false;
    if($done)return;
    $done=true;
    db()->exec("CREATE TABLE IF NOT EXISTS seo_feedback (
        id INT AUTO_INCREMENT PRIMARY KEY,
        client_id INT NOT NULL,
        task_id INT NOT NULL,
        source ENUM('manual','client') NOT NULL DEFAULT 'manual',
        `text` MEDIUMTEXT,
        images TEXT DEFAULT NULL,
        status ENUM('pending','parsed','failed') NOT NULL DEFAULT 'pending',
        parsed_note TEXT DEFAULT NULL,
        job_id INT DEFAULT NULL,
        created_by VARCHAR(64) NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        parsed_at TIMESTAMP NULL DEFAULT NULL,
        KEY idx_seo_feedback_task (task_id, id),
        KEY idx_seo_feedback_client (client_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $ic=db()->prepare("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='seo_feedback' AND COLUMN_NAME='images'");
    $ic->execute();
    $has=$ic->fetch();
    $ic->closeCursor();
    if(!$has){
        db()->exec("ALTER TABLE seo_feedback ADD COLUMN images TEXT DEFAULT NULL AFTER `text`");
    }
    ensure_job_types();
}

/* Deliverables schema, created lazily on the first deliverable request, same
   pattern as seo_feedback. One row per file the worker handed up, one physical
   file per row under $DELIVERABLE_DIR.
   No foreign key to seo_tasks on purpose: the rest of this schema does not use
   them either, and a delivered file outliving a deleted task is a leak we can
   see, not a 500 in the middle of a job. */
function ensure_deliverables_schema(){
    static $done=false;
    if($done)return;
    $done=true;
    db()->exec("CREATE TABLE IF NOT EXISTS seo_deliverables (
        id INT AUTO_INCREMENT PRIMARY KEY,
        task_id INT NOT NULL,
        client_id INT NOT NULL,
        orig_name VARCHAR(200) NOT NULL DEFAULT '',
        stored_name VARCHAR(64) NOT NULL,
        bytes INT NOT NULL DEFAULT 0,
        mime VARCHAR(128) NOT NULL DEFAULT '',
        uploaded_by VARCHAR(64) NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_seo_deliverables_stored (stored_name),
        KEY idx_seo_deliverables_task (task_id, id),
        KEY idx_seo_deliverables_client (client_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    /* uploaded_by arrived later, when humans got the same upload button the
       worker had. Guarded by an information_schema read for the same reason as
       seo_feedback.images: MariaDB 10.3 has no ADD COLUMN IF NOT EXISTS, so the
       read is what makes this idempotent. Rows that predate it read as '', which
       the board shows as the worker, because that is all there was. */
    $ic=db()->prepare("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='seo_deliverables' AND COLUMN_NAME='uploaded_by'");
    $ic->execute();
    $has=$ic->fetch();
    $ic->closeCursor();
    if(!$has){
        db()->exec("ALTER TABLE seo_deliverables ADD COLUMN uploaded_by VARCHAR(64) NOT NULL DEFAULT '' AFTER mime");
    }
}

/* seo_snapshots.source is an ENUM too, and content_registry was added to it
   after the fact. Same shape as ensure_job_types(): value by value so a
   database at any intermediate state heals in one ALTER, guarded by an
   information_schema read because MariaDB 10.3 has no MODIFY ... IF NOT EXISTS.
   The list only ever grows. */
function ensure_snapshot_sources(){
    static $done=false;
    if($done)return;
    $done=true;
    $want=SNAPSHOT_SOURCES;
    $q=db()->prepare("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='seo_snapshots' AND COLUMN_NAME='source'");
    $q->execute();
    $col=$q->fetch();
    $q->closeCursor();
    if(!$col)return;
    $cur=(string)$col['COLUMN_TYPE'];
    $missing=[];
    foreach($want as $w){if(strpos($cur,"'".$w."'")===false)$missing[]=$w;}
    if(!$missing)return;
    $list=implode(',',array_map(function($w){return "'".$w."'";},$want));
    db()->exec("ALTER TABLE seo_snapshots MODIFY source ENUM($list) NOT NULL");
}

/* agent_jobs.type is an ENUM and every new runner has to be added to it.
   Checked value by value rather than against one expected string, so a database
   sitting at any intermediate state (feedback added, triage not yet) heals in
   one ALTER. The list only ever grows, nothing is dropped. */
function ensure_job_types(){
    static $done=false;
    if($done)return;
    $done=true;
    /* backfill_metrics 加在这里的同时必须加进 seo-worker/runner_host.js 的
       KNOWN_TYPES，两边漏一边 worker 领到活直接崩。2026-08 apply_task 就是这么炸的。 */
    $want=['discover','pull_data','plan','execute_task','apply_task','report','feedback','triage','ruling','backfill_metrics','chat','review_plan','plan_review'];
    $q=db()->prepare("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_jobs' AND COLUMN_NAME='type'");
    $q->execute();
    $col=$q->fetch();
    $q->closeCursor();
    if(!$col)return;
    $cur=(string)$col['COLUMN_TYPE'];
    $missing=[];
    foreach($want as $w){if(strpos($cur,"'".$w."'")===false)$missing[]=$w;}
    if(!$missing)return;
    $list=implode(',',array_map(function($w){return "'".$w."'";},$want));
    db()->exec("ALTER TABLE agent_jobs MODIFY type ENUM($list) NOT NULL");
}

/* 日粒度时序表，首次访问 /metrics 系端点时惰性建表，同 seo_feedback 的套路。
   seo_snapshots 存的是 28 天窗口的一大坨 JSON，能看当期总量看不了连续趋势；
   这张表把同样的数据摊成 (client, 日期, 指标名) 三元组，一行一个点，
   Dashboard 的趋势图、逐层转化率曲线、排名分档全部读它。

   UNIQUE KEY (client_id,d,m) 是幂等的全部依据：worker 重跑同一窗口只会覆盖
   同名同日的值，不会堆重复行，所以回填 job 可以随便重跑。
   v 用 DOUBLE 而不是 INT：转化率、平均位次这类将来要加的指标是小数。
   没有外键，和 seo_feedback / seo_deliverables / seo_inbox 一致：这批惰性建的
   表都不挂外键，删客户时留下的孤儿行是看得见的垃圾，不是跑一半的 500。

   顺带惰性补 seo_profiles.brand_regex：品牌词拆分要一条正则区分品牌搜索和
   非品牌搜索，人工填优先，空着由 worker 从客户名/域名确定性推导。
   MariaDB 10.3 没有 ADD COLUMN IF NOT EXISTS，靠 information_schema 读实现幂等。 */
function ensure_metrics_schema(){
    static $done=false;
    if($done)return;
    $done=true;
    db()->exec("CREATE TABLE IF NOT EXISTS seo_metrics_daily (
        id INT AUTO_INCREMENT PRIMARY KEY,
        client_id INT NOT NULL,
        d DATE NOT NULL,
        m VARCHAR(40) NOT NULL,
        v DOUBLE NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_seo_metrics_daily (client_id, d, m),
        KEY idx_seo_metrics_daily_read (client_id, m, d)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $ic=db()->prepare("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='seo_profiles' AND COLUMN_NAME='brand_regex'");
    $ic->execute();
    $has=$ic->fetch();
    $ic->closeCursor();
    if(!$has){
        db()->exec("ALTER TABLE seo_profiles ADD COLUMN brand_regex TEXT DEFAULT NULL AFTER target_keywords");
    }
    foreach(['semrush_db'=>"VARCHAR(16) DEFAULT NULL",'workspace_dir'=>"VARCHAR(64) DEFAULT NULL",
             /* W8 批 0：services=seo/sem/both（sem 兼容别名，语义即 paid），owner=aira/kira 唯一写入方 */
             'services'=>"VARCHAR(16) DEFAULT NULL",'ads_customer_id'=>"VARCHAR(20) DEFAULT NULL",'owner'=>"VARCHAR(32) DEFAULT NULL"] as $col=>$ddl){
        $c=db()->prepare("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='seo_profiles' AND COLUMN_NAME=?");
        $c->execute([$col]);
        $hit=$c->fetch();
        $c->closeCursor();
        if(!$hit)db()->exec("ALTER TABLE seo_profiles ADD COLUMN $col $ddl AFTER semrush_project");
    }
}

/* 报告表，惰性建，同 seo_deliverables 的套路。一行一个版本：同一个客户同一个
   周期反复生成就叠 v1 v2 v3，旧行永不覆盖，旧链接永久有效，
   UNIQUE KEY (client_id,period_type,period_start,version) 就是这条规矩的兜底。

   facts_pack 用 MEDIUMTEXT 存 JSON 字符串而不是 JSON 列：MariaDB 10.3 底下
   JSON 列本来就是 LONGTEXT，用 JSON 列只会换来一层没用的校验，读出来照样 jdec()。
   没有外键，和这批惰性建的表一致，删客户留下的孤儿行是看得见的垃圾，
   不是跑一半的 500。

   内部调 ensure_job_types()，因为报告的入口是排一个 type='report' 的 job，
   表建好了 ENUM 没跟上等于白建，同 ensure_feedback_schema() 的处理。 */
function ensure_reports_schema(){
    static $done=false;
    if($done)return;
    $done=true;
    db()->exec("CREATE TABLE IF NOT EXISTS seo_reports (
        id INT AUTO_INCREMENT PRIMARY KEY,
        client_id INT NOT NULL,
        period_type ENUM('month','quarter','week','custom') NOT NULL DEFAULT 'month',
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        version INT NOT NULL DEFAULT 1,
        url VARCHAR(500) NOT NULL DEFAULT '',
        html_path VARCHAR(500) NOT NULL DEFAULT '',
        facts_pack MEDIUMTEXT DEFAULT NULL,
        narrative_status ENUM('ok','fallback') NOT NULL DEFAULT 'ok',
        created_by VARCHAR(64) NOT NULL DEFAULT '',
        note TEXT DEFAULT NULL,
        status ENUM('draft','sent') NOT NULL DEFAULT 'draft',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_seo_reports_client (client_id, period_start, id),
        UNIQUE KEY uq_seo_reports_ver (client_id, period_type, period_start, version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    /* narrative_status 比表晚落地：叙事层降级成纯数据版这件事是第三层防线，
       表先上线的库里没有这一列。MariaDB 10.3 没有 ADD COLUMN IF NOT EXISTS，
       靠 information_schema 逐值比对实现幂等，同 seo_deliverables.uploaded_by。 */
    $ic=db()->prepare("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='seo_reports' AND COLUMN_NAME='narrative_status'");
    $ic->execute();
    $has=$ic->fetch();
    $ic->closeCursor();
    if(!$has){
        db()->exec("ALTER TABLE seo_reports ADD COLUMN narrative_status ENUM('ok','fallback') NOT NULL DEFAULT 'ok' AFTER facts_pack");
    }
    ensure_job_types();
}

/* 日期入参校验。时序端点全部按 DATE 比较，格式不对直接 400，
   不做"猜一下用户想要哪天"这种事。 */
function ymd_ok($s){return (bool)preg_match('/^\d{4}-\d{2}-\d{2}$/',(string)$s);}

/* POST /metrics 的整批校验与去重，抽成函数是为了能单测：这里一行判错，
   要么整批 400 挡住正常写入，要么把脏数据放进时序表。
   返回 [$rows, null] 或 [null, '错误说明']。全批先校验再写，一行不合格整批拒，
   半批写进去比不写更难查。
   批内出现重复的 (d,m) 时后者胜：MySQL 多行 upsert 碰上批内重复键的行为
   依赖行序，与其赌不如自己收敛，顺便让"同一批发两次"完全等价。 */
function metrics_rows_prepare($cid,$rows){
    $seen=[];
    foreach(array_values($rows) as $n=>$r){
        if(!is_array($r))return [null,"row #$n: not an object"];
        $d=(string)($r['d']??'');
        if(!ymd_ok($d))return [null,"row #$n: bad date \"$d\", want YYYY-MM-DD"];
        $mn=(string)($r['m']??'');
        if(!in_array($mn,METRIC_NAMES,true))return [null,"row #$n: unknown metric \"$mn\""];
        if(!array_key_exists('v',$r)||!is_numeric($r['v']))return [null,"row #$n: v must be numeric"];
        $seen[$d.'|'.$mn]=[$cid,$d,$mn,(float)$r['v']];
    }
    return [array_values($seen),null];
}

/* seo_inbox: the decision inbox behind the console's chat tab.
   Three kinds of row and nothing else:
     digest, a triage summary card written by the worker, open until settled;
     ruling, one human's answer to a digest, in their own words;
     ack,    what the runner actually did about that ruling, in plain Chinese.
   The board stays the single source of truth. This table is a conversation
   record over the board, never a second place where state lives.
   status only means anything on a digest. ruling and ack rows are written
   resolved on arrival so that ?status=open returns exactly the cards that
   still want a human.
   Created lazily on first use, same pattern as seo_feedback. */
function ensure_inbox_schema(){
    static $done=false;
    if($done)return;
    $done=true;
    db()->exec("CREATE TABLE IF NOT EXISTS seo_inbox (
        id INT AUTO_INCREMENT PRIMARY KEY,
        client_id INT DEFAULT NULL,
        kind ENUM('digest','ruling','ack') NOT NULL,
        body TEXT,
        refs TEXT DEFAULT NULL,
        reply_to INT DEFAULT NULL,
        status ENUM('open','resolved') NOT NULL DEFAULT 'open',
        created_by VARCHAR(64) NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_seo_inbox_stream (id),
        KEY idx_seo_inbox_client (client_id, id),
        KEY idx_seo_inbox_open (kind, status, id),
        KEY idx_seo_inbox_reply (reply_to)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    /* kind 后来加了三个对话值。和 ensure_job_types() 一个套路：值对值地查，
       库停在任何中间状态都能一次 ALTER 补齐，MariaDB 10.3 没有
       MODIFY ... IF NOT EXISTS，所以 information_schema 那一读才是幂等的依据。
       ALTER 必须带上原来的 digest/ruling/ack，漏一个老行就废了。 */
    $q=db()->prepare("SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='seo_inbox' AND COLUMN_NAME='kind'");
    $q->execute();
    $col=$q->fetch();
    $q->closeCursor();
    if(!$col)return;
    $cur=(string)$col['COLUMN_TYPE'];
    $missing=[];
    foreach(INBOX_KINDS as $w){if(strpos($cur,"'".$w."'")===false)$missing[]=$w;}
    if(!$missing)return;
    $list=implode(',',array_map(function($w){return "'".$w."'";},INBOX_KINDS));
    db()->exec("ALTER TABLE seo_inbox MODIFY kind ENUM($list) NOT NULL");
}

/* 任务判定（review_plan job）落在 seo_tasks 自己的列上，不开新表：判决是任务的属性，
   一个任务同一时刻只有一条有效判决，重判就覆盖。惰性加列，同 ensure_metrics_schema
   的 information_schema 套路（10.3 没有 ADD COLUMN IF NOT EXISTS）。
   review_verdict / reason / evidence / merge_into / adjust  fable 的判决
   review_job_id / reviewed_at                              哪次判的、什么时候判的
   review_override / review_override_note                   人推翻后的值与理由，理由必填
   状态改动不在这里：判决本身不动 status，人点「按推荐执行」才动。 */
define('REVIEW_VERDICTS',['do','later','merge','drop']);
function ensure_review_schema(){
    static $done=false;
    if($done)return;
    $done=true;
    $cols=[
        'review_verdict'=>"VARCHAR(8) DEFAULT NULL",
        'review_reason'=>"VARCHAR(255) NOT NULL DEFAULT ''",
        'review_evidence'=>"VARCHAR(255) NOT NULL DEFAULT ''",
        'review_merge_into'=>"INT DEFAULT NULL",
        'review_adjust'=>"VARCHAR(400) NOT NULL DEFAULT ''",
        'review_job_id'=>"INT DEFAULT NULL",
        'reviewed_at'=>"DATETIME DEFAULT NULL",
        'review_override'=>"VARCHAR(8) DEFAULT NULL",
        'review_override_note'=>"VARCHAR(400) NOT NULL DEFAULT ''",
        'review_text_hash'=>"CHAR(32) DEFAULT NULL",
        /* 2026-08-29 W1：apply 里 deferred 的验证项（要浏览器、要等收录）人补跑完之后盖章的时间。
           待补跑的清单本身从 result_note 的「检查: … 待人工 N 项（…）」那行解析，不另存。 */
        'manual_done_at'=>"DATETIME DEFAULT NULL",
        'manual_done_note'=>"VARCHAR(400) NOT NULL DEFAULT ''",
    ];
    $in=implode(',',array_fill(0,count($cols),'?'));
    $q=db()->prepare("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='seo_tasks' AND COLUMN_NAME IN ($in)");
    $q->execute(array_keys($cols));
    $have=[];
    foreach($q->fetchAll() as $r)$have[$r['COLUMN_NAME']]=true;
    $q->closeCursor();
    $add=[];
    foreach($cols as $name=>$def){if(!isset($have[$name]))$add[]="ADD COLUMN `$name` $def";}
    if($add)db()->exec("ALTER TABLE seo_tasks ".implode(',',$add));
    /* 2026-08-27 加哈希列前已有的判决没有哈希，用当前内容回填一次（假定内容未变，
       变了也只是少报一次过期，下次重判自然覆盖）。幂等：只补空的。 */
    db()->exec("UPDATE seo_tasks SET review_text_hash=MD5(CONCAT(IFNULL(title,''),'|',IFNULL(detail,''))) WHERE review_verdict IS NOT NULL AND review_text_hash IS NULL");
    ensure_job_types();
}

/* 排一个判定 job（review_plan，light 道，fable 几十秒）。三个自动入口加一个手动入口都走这里：
   plan 落任务（/tasks/bulk）、execute 出方案（/tasks/{id}/result）、人工新建（POST /tasks）、
   看板按钮（/tasks/review）。源头都是人点过的动作，不违反禁 cron。
   同客户已有一个 queued 且没满 20 个的判定 job 就把任务并进它的 payload，别一任务一 job 刷屏；
   running 的不动（payload 已被 worker 读走）。回 [job_id, merged]。 */
function queue_review_job($cid,$ids,$by,$auditAction){
    $ids=array_values(array_unique(array_filter(array_map('intval',(array)$ids))));
    if(!$ids)return [0,false];
    ensure_review_schema();
    $q=db()->prepare("SELECT id,payload FROM agent_jobs WHERE client_id=? AND type='review_plan' AND status='queued' ORDER BY id DESC LIMIT 1");
    $q->execute([$cid]);
    $row=$q->fetch();
    $q->closeCursor();
    if($row){
        $p=jdec($row['payload']);
        $have=(is_array($p)&&isset($p['task_ids'])&&is_array($p['task_ids']))?array_map('intval',$p['task_ids']):[];
        $merged=array_values(array_unique(array_merge($have,$ids)));
        if(count($merged)<=20){
            /* 条件 UPDATE：worker 这一瞬间可能刚 claim 走，status 不再是 queued 就落空，落空则新建。 */
            $up=db()->prepare("UPDATE agent_jobs SET payload=? WHERE id=? AND status='queued'");
            $up->execute([json_encode(['task_ids'=>$merged],JSON_UNESCAPED_UNICODE),(int)$row['id']]);
            if($up->rowCount()>0){
                audit($by,$auditAction,(string)$row['id'],['client_id'=>$cid,'task_ids'=>$ids,'merged_into_queued'=>true]);
                return [(int)$row['id'],true];
            }
        }
    }
    $jids=[];
    foreach(array_chunk($ids,20) as $chunk){
        db()->prepare("INSERT INTO agent_jobs(client_id,type,payload,status,created_by)VALUES(?,'review_plan',?,'queued',?)")
            ->execute([$cid,json_encode(['task_ids'=>$chunk],JSON_UNESCAPED_UNICODE),$by]);
        $jid=(int)db()->lastInsertId();
        $jids[]=$jid;
        audit($by,$auditAction,(string)$jid,['client_id'=>$cid,'task_ids'=>$chunk]);
    }
    fire_wake($jids[0]);
    return [$jids[0],false];
}

/* 方案层过闸（plan_review job，light 道，fable 一次）。plan job 刚落的草稿先过这一道：
   按跨客户经验改成 v2 并出方向确认卡，人确认方向后 v2 的任务才进任务层判定（review_plan）。
   同一 plan 已有 queued/running 的就不重复排。回 job_id。 */
function queue_plan_review_job($cid,$pid,$ids,$by){
    ensure_job_types(); /* type 是 ENUM，先扩列再插，否则 'plan_review' 被截成空串（2026-08-29 job 195） */
    $q=db()->prepare("SELECT id,payload FROM agent_jobs WHERE client_id=? AND type='plan_review' AND status IN('queued','running') ORDER BY id DESC LIMIT 1");
    $q->execute([$cid]);
    $row=$q->fetch();
    $q->closeCursor();
    if($row){
        $p=jdec($row['payload']);
        if(is_array($p)&&(int)($p['plan_id']??0)===(int)$pid)return (int)$row['id'];
    }
    db()->prepare("INSERT INTO agent_jobs(client_id,type,payload,status,created_by)VALUES(?,'plan_review',?,'queued',?)")
        ->execute([$cid,json_encode(['plan_id'=>(int)$pid,'task_ids'=>array_values($ids)],JSON_UNESCAPED_UNICODE),$by]);
    $jid=(int)db()->lastInsertId();
    audit($by,'seo_plan_review_auto',(string)$jid,['client_id'=>$cid,'plan_id'=>$pid,'task_ids'=>$ids]);
    fire_wake($jid);
    return $jid;
}

/* /tasks/bulk 与 /plans/{id}/review_result 共用的任务清洗，返回 [rows, null] 或 [null, 错误]。 */
function tasks_bulk_clean($cid,$pid,$rows){
    if(!is_array($rows)||!$rows)return [null,'tasks required'];
    if(count($rows)>20)return [null,'batch too large, max 20 tasks'];
    $clean=[];
    foreach(array_values($rows) as $n=>$t){
        if(!is_array($t))return [null,"task #$n: not an object"];
        $title=trim((string)($t['title']??''));
        if($title==='')return [null,"task #$n: title required"];
        if(mb_strlen($title,'UTF-8')>255)return [null,"task #$n: title over 255 chars"];
        $mod=(string)($t['module']??'');
        if(!in_array($mod,['technical','onpage','content','local','offpage'],true))return [null,"task #$n: bad module"];
        $own=(string)($t['owner_type']??'');
        if(!in_array($own,['agency','client','agent'],true))return [null,"task #$n: bad owner_type"];
        $sprint=(string)($t['sprint']??'');
        if(mb_strlen($sprint,'UTF-8')>10)return [null,"task #$n: sprint over 10 chars"];
        $pri=(string)($t['priority']??'P2');
        if($pri==='')$pri='P2';
        if(!in_array($pri,['P0','P1','P2','P3'],true))return [null,"task #$n: bad priority"];
        $ops=(string)($t['ops']??'');
        if(mb_strlen($ops,'UTF-8')>255)return [null,"task #$n: ops over 255 chars"];
        $att=empty($t['attention'])?0:1;
        $clean[]=[$cid,$pid,$sprint,$mod,$title,(string)($t['detail']??''),$own,$pri,$att,$ops];
    }
    return [$clean,null];
}
function tasks_bulk_insert($p,$clean){
    $ids=[];
    $ins=$p->prepare("INSERT INTO seo_tasks(client_id,plan_id,sprint,module,title,detail,owner_type,priority,attention,ops,status,created_by)VALUES(?,?,?,?,?,?,?,?,?,?,'proposed','seo-worker')");
    foreach($clean as $row){$ins->execute($row);$ids[]=(int)$p->lastInsertId();}
    return $ids;
}

/* 博客任务的「放行」语义按阶段变：
   大纲阶段（ops 含 blog-draft，output_url 不是博客预览链接）放行 = 写正文，重排 execute_task 并在说明里标 [大纲已批]；
   草稿阶段（output_url 是预览链接）放行 = 发布，排 apply_task。
   2026-08-27 #88 在大纲阶段被当成 apply，去找变更方案文件当然没有。 */
/* 分析型任务（没有 ops 的 agent 任务）产出是报告，进 review 后「同意」= 验收完成，不排 apply。 */
/* 分析型任务：agent 任务且没有写操作。ops 为空，或 ops 全是只读审计类（能力表 agent_readonly：
   worker 走分析模式直接出报告，不产方案），放行等于验收。2026-08-29 #95 教训：ga4-audit 被排进 apply。 */
$READONLY_OPS=['ga4-audit','gsc-audit'];
function analysis_task($t){
    global $READONLY_OPS;
    if(($t['owner_type']??'')!=='agent')return false;
    $ops=array_values(array_filter(array_map('trim',explode(',',(string)($t['ops']??'')))));
    if(!$ops)return true;
    foreach($ops as $op){if(!in_array($op,$READONLY_OPS,true))return false;}
    return true;
}
function blog_outline_stage($t){
    $ops=strtolower((string)($t['ops']??''));
    if(strpos($ops,'blog-draft')===false)return false;
    $u=(string)($t['output_url']??'');
    return ($u===''||strpos($u,'/blog/')===false);
}
function blog_release_as_write($cid,$t,$by){
    $tid=(int)$t['id'];
    if(strpos((string)($t['detail']??''),'[大纲已批]')===false){
        db()->prepare("UPDATE seo_tasks SET detail=CONCAT_WS('\n',NULLIF(detail,''),?),status='approved' WHERE id=?")
            ->execute(['[大纲已批] '.date('Y-m-d').' 人已批大纲，按大纲写正文。',$tid]);
    }else{
        db()->prepare("UPDATE seo_tasks SET status='approved' WHERE id=?")->execute([$tid]);
    }
    return queue_task_jobs($cid,'execute_task',[$tid],$by,'seo_job_create');
}

/* 追加一行结果备注，不覆盖已有内容。收件箱动作里的 $appendNote 闭包是同一句 SQL，
   这里抽成函数给判定执行用。 */
/* 2026-08-29 W2：任务结束只走这一个口。kind 五选一，含义各不相同，看板按它画不同的样子：
     applied   机器落地，证据是 apply 写的「检查:」行（reason 可空，但 note 里必须已有检查行或随 reason 给出）
     accepted  人验收（分析报告、人工认定完成），reason 必填
     dropped / merged / killed   无交付关闭，reason 必填
   返回 null 成功，或一句错误说明。任何地方直接 UPDATE status='done' 都算绕过这个闸。 */
function task_close($tid,$kind,$reason='',$by=''){
    $tid=(int)$tid;
    $kind=(string)$kind;
    if(!in_array($kind,['applied','accepted','dropped','merged','killed'],true))return '结束类型非法：'.$kind;
    $reason=trim((string)$reason);
    $g=db()->prepare("SELECT id,status,result_note,output_url FROM seo_tasks WHERE id=?");
    $g->execute([$tid]);
    $t=$g->fetch();
    if(!$t)return '任务不存在';
    if($t['status']==='done')return '任务已经结束';
    if($kind==='applied'){
        $hasChecks=preg_match('/(^|\n)检查:/u',(string)$t['result_note'])||preg_match('/(^|\n)检查:/u',$reason);
        if(!$hasChecks&&$reason==='')return 'applied 必须带「检查:」行或说明，没有证据不能算落地';
    }elseif($reason===''){
        return $kind.' 必须写理由';
    }
    db()->prepare("UPDATE seo_tasks SET status='done',attention=0 WHERE id=?")->execute([$tid]);
    task_append_note($tid,'['.$kind.'] '.($by!==''?($by.'：'):'').$reason);
    return null;
}
function task_append_note($tid,$note){
    $note=trim((string)$note);
    if($note==='')return;
    db()->prepare("UPDATE seo_tasks SET result_note=CONCAT_WS('\n',NULLIF(result_note,''),?) WHERE id=?")
        ->execute([mb_substr($note,0,1000,'UTF-8'),(int)$tid]);
}

/* 给任务行挂判定状态，GET /tasks 用。
   review_effective  人推翻的优先，其次 fable 的，都没有为 null
   review_stale      判决之后任务被改过，或该客户的 facts 更新过，判决按过期显示，
                     执行时也不认。写判决的 UPDATE 显式保住 updated_at 不动，
                     否则判决一落地任务就「被改过」了。
   review_pending    有 review_plan job 在飞且 payload 点名了这个任务，卡上显示「判定中」。 */
function attach_review_state($tasks,$cid){
    if(!$tasks)return $tasks;
    $fq=db()->prepare("SELECT MAX(updated_at) AS m FROM seo_facts WHERE client_id=?");
    $fq->execute([$cid]);
    $fr=$fq->fetch();
    $fq->closeCursor();
    $factsAt=(string)(($fr&&$fr['m'])?$fr['m']:'');
    $pending=[];
    $jq=db()->prepare("SELECT payload FROM agent_jobs WHERE client_id=? AND type='review_plan' AND status IN('queued','running')");
    $jq->execute([$cid]);
    foreach($jq->fetchAll() as $r){
        $p=jdec($r['payload']);
        if(is_array($p)&&isset($p['task_ids'])&&is_array($p['task_ids'])){
            foreach($p['task_ids'] as $x){$pending[(int)$x]=true;}
        }
    }
    $jq->closeCursor();
    foreach($tasks as &$t){
        $v=isset($t['review_verdict'])?$t['review_verdict']:null;
        $o=isset($t['review_override'])?$t['review_override']:null;
        $eff=$o?:($v?:null);
        $at=(string)($t['reviewed_at']??'');
        /* 过期只认「任务本身在判决之后被改过」。facts 更新单独给个提示位，不算过期：
           改判写反馈就会动 facts，若也算过期，一次改判会把全客户的判决全部作废（2026-08-26 实测）。 */
        $stale=false;$factsNewer=false;
        if($v&&$at!==''){
            $h=(string)($t['review_text_hash']??'');
            if($h!==''){
                if(md5((string)($t['title']??'').'|'.(string)($t['detail']??''))!==$h)$stale=true;
            }elseif(strcmp($at,(string)($t['updated_at']??''))<0){
                /* 老判决没存哈希，退回时间比较 */
                $stale=true;
            }
            if($factsAt!==''&&strcmp($at,$factsAt)<0)$factsNewer=true;
        }
        $t['review_effective']=$eff;
        $t['review_stale']=$stale;
        $t['review_facts_newer']=$factsNewer;
        $t['review_pending']=isset($pending[(int)$t['id']]);
    }
    unset($t);
    return $tasks;
}

/* 待人工补跑的验证项。apply 成功的 result_note 头部有一行
   「检查: 通过 N 项，待人工 M 项（V15 …、V16 …）」，M>0 且没盖 manual_done_at 就是欠着的。
   取最后一次出现的那行（重跑会追加多段 note）。回 ['pending'=>bool,'items'=>[...]]。 */
function manual_checks_of($t){
    $note=(string)($t['result_note']??'');
    $items=[];
    if(preg_match_all('/检查:[^\n]*待(?:人工|复验) (\d+) 项(?:（([^）]*)）)?/u',$note,$all,PREG_SET_ORDER)){
        $last=$all[count($all)-1];
        $n=(int)$last[1];
        if($n>0){
            $raw=isset($last[2])?trim($last[2]):'';
            $items=$raw!==''?array_values(array_filter(array_map('trim',preg_split('/[、,，]/u',$raw)))):array_fill(0,$n,'（未命名检查项）');
        }
    }
    $done=!empty($t['manual_done_at']);
    return ['pending'=>($items&&!$done),'items'=>$items];
}

/* 人类视角的任务状态，GET /tasks 用，纯派生不入库。看板只问一件事：这张卡在等谁。
   human_state  wait_me（等人拍板）/ running（机器在跑）/ wait_ext（等外部）/ closed（结束）
   wait_reason  等我的一句话：待判 / 待放行 / 上次执行失败 / 落地失败已回滚 / 判定中
   run_note     在跑的一句话：排队第 N 位 / 执行中 / 落地中
   closed_kind  done / dropped / merged / killed，从结果备注的标签推
   round        跑过几轮 execute（方案 vN），数 job 不入库
   依赖 attach_job_state 与 attach_review_state 先挂好。 */
function attach_human_state($tasks,$cid){
    if(!$tasks)return $tasks;
    $rounds=[];
    $q=db()->prepare("SELECT type,payload,status FROM agent_jobs WHERE client_id=? AND type='execute_task' AND status IN('done','failed','running') ORDER BY id DESC LIMIT 500");
    $q->execute([$cid]);
    foreach($q->fetchAll() as $r){
        $tid=job_task_id('execute_task',$r['payload']);
        if($tid)$rounds[$tid]=($rounds[$tid]??0)+1;
    }
    foreach($tasks as &$t){
        $tid=(int)$t['id'];
        $st=(string)$t['status'];
        $js=$t['job_state']??['status'=>null];
        $note=(string)($t['result_note']??'');
        $hs='wait_me';$why='';$run='';$closed=null;$failReason='';
        if($st==='done'){
            $hs='closed';
            if(preg_match('/\[(dropped|merged|killed|accepted)\][^\n]*$/s',$note,$mm)||preg_match('/\[(dropped|merged|killed|accepted)\]/',$note,$mm))$closed=$mm[1];
            elseif(preg_match('/\[applied\] (分析报告已验收|人工认定完成)/u',$note))$closed='accepted'; /* 2026-08-29 之前的老写法 */
            else $closed='done';
        }elseif($js['status']==='running'||$js['status']==='queued'){
            $hs='running';
            $isApply=($js['job_type']??'')==='apply_task';
            if($js['status']==='queued')$run=($isApply?'落地':'执行').'排队'.($js['position']?('第 '.$js['position'].' 位'):'');
            else $run=$isApply?'落地中':'执行中';
        }elseif($st==='blocked'){
            $hs='wait_ext';
            if(preg_match('/\[later\][^\n]*/',$note,$mm))$why=trim(preg_replace('/^\[later\]\s*/','',$mm[0]));
            else $why='延后';
        }elseif($st==='in_progress'){
            $hs='running';$run='执行中';
        }else{
            $hs='wait_me';
            if(!empty($t['review_pending']))$why='判定中';
            elseif($js['status']==='failed'){
                $n=(int)($js['fail_count']??1);
                $why=(($js['job_type']??'')==='apply_task'?'落地失败':'执行失败').($n>1?(' '.$n.' 次'):'').'（job #'.$js['job_id'].'）';
                $failReason=task_fail_reason($t,$js['job_id'],(string)($js['job_type']??''));
            }
            elseif($st==='review')$why='待放行';
            else $why=empty($t['review_effective'])?'待判':'待拍板';
        }
        $mc=manual_checks_of($t);
        $t['manual_checks']=$mc['items'];
        $t['manual_pending']=$mc['pending'];
        $t['human_state']=$hs;
        $t['wait_reason']=$why;
        $t['fail_reason']=$failReason??'';
        $t['run_note']=$run;
        $t['closed_kind']=$closed;
        $t['round']=$rounds[$tid]??0;
    }
    unset($t);
    return $tasks;
}

/* CHAT-PURE-START
   纯函数区：不碰 db()，不调 res()，可以被 tests/chatapi.test.php 抠出来单测。
   改这两个标记的文字要同步改测试里的正则。 */

/* 一条任务的字段校验，POST /tasks 和 POST /inbox/{root}/spawn_task 共用。
   抽出来的唯一理由：立项走的必须是和人工建任务一模一样的那套校验，
   两份拷贝迟早会分叉，分叉的那天草案就能绕过看板的字段约束。
   返回 [$clean, null] 或 [null, '错误说明']。$clean 的键就是 seo_tasks 的列名。
   $opts:
     status_default  没给 status 时用哪个（人工建任务是 proposed，立项是 approved）
     status_force    非空则无视入参强制这个状态 */
function task_fields_clean($i,$opts=[]){
    if(!is_array($i))return [null,'body 不是一个对象'];
    $title=trim((string)($i['title']??''));
    if($title==='')return [null,'title required'];
    if(mb_strlen($title,'UTF-8')>255)return [null,'title over 255 chars'];
    $mod=(string)($i['module']??'technical');
    if($mod==='')$mod='technical';
    if(!in_array($mod,['technical','onpage','content','local','offpage'],true))return [null,'bad module'];
    $own=(string)($i['owner_type']??'agency');
    if($own==='')$own='agency';
    if(!in_array($own,['agency','client','agent'],true))return [null,'bad owner_type'];
    $force=(string)($opts['status_force']??'');
    $st=$force!==''?$force:(string)($i['status']??($opts['status_default']??'proposed'));
    if($st==='')$st='proposed';
    if(!in_array($st,['proposed','approved','in_progress','review','done','blocked'],true))return [null,'bad status'];
    $pri=(string)($i['priority']??'P2');
    if($pri==='')$pri='P2';
    if(!in_array($pri,['P0','P1','P2','P3'],true))return [null,'bad priority'];
    $ops=(string)($i['ops']??'');
    if(mb_strlen($ops,'UTF-8')>255)return [null,'ops over 255 chars'];
    $sprint=(string)($i['sprint']??'');
    if(mb_strlen($sprint,'UTF-8')>10)return [null,'sprint over 10 chars'];
    $detail=(string)($i['detail']??'');
    if(mb_strlen($detail,'UTF-8')>20000)return [null,'detail over 20000 chars'];
    return [[
        'title'=>$title,
        'detail'=>$detail,
        'module'=>$mod,
        'owner_type'=>$own,
        'status'=>$st,
        'priority'=>$pri,
        'ops'=>$ops,
        'sprint'=>$sprint,
        'attention'=>empty($i['attention'])?0:1,
        'output_url'=>(string)($i['output_url']??''),
        'plan_id'=>($i['plan_id']??null)?(int)$i['plan_id']:null,
    ],null];
}

/* 模型提的任务草案，存进 chat_agent 行的 refs.drafts。
   宽进严出：字段缺了给默认值，字段坏了整条草案丢掉，绝不半条落进去。
   丢掉一条草案的后果只是人少看见一张卡，写进去一条脏草案的后果是人点了
   立项才发现建不了，那更难查。这里不报错，报错会把整条回复毙掉，
   而正文本身是有价值的。 */
function inbox_drafts_norm($v){
    if(is_string($v)){$d=json_decode($v,true);$v=($d===null)?[]:$d;}
    if(!is_array($v))return [];
    $out=[];
    foreach($v as $d){
        if(count($out)>=CHAT_MAX_DRAFTS)break;
        if(!is_array($d))continue;
        list($clean,$err)=task_fields_clean($d,['status_default'=>'approved']);
        if($err)continue;
        $out[]=[
            'title'=>$clean['title'],
            'detail'=>mb_substr($clean['detail'],0,4000,'UTF-8'),
            'module'=>$clean['module'],
            'owner_type'=>$clean['owner_type'],
            'priority'=>$clean['priority'],
            'ops'=>$clean['ops'],
            'sprint'=>$clean['sprint'],
        ];
    }
    return $out;
}

/* CHAT-PURE-END */

/* 一行任务落库，入参是 task_fields_clean() 出来的干净数组。
   POST /tasks 和 POST /inbox/{root}/spawn_task 共用，写的列必须一致：
   立项出来的任务和人工建的任务在看板上不该有任何区别。 */
function task_insert($cid,$t,$by){
    db()->prepare("INSERT INTO seo_tasks(client_id,plan_id,sprint,module,title,detail,owner_type,priority,attention,ops,status,output_url,created_by)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
        ->execute([
            (int)$cid,$t['plan_id'],$t['sprint'],$t['module'],$t['title'],$t['detail'],
            $t['owner_type'],$t['priority'],$t['attention'],$t['ops'],$t['status'],$t['output_url'],$by
        ]);
    return (int)db()->lastInsertId();
}

/* 这个会话是不是正有一个 chat job 在排队或者在跑。
   payload 形状是 {"inbox_id":N,"message_id":M}，写死在下面的两个入队处，
   所以这个 LIKE 的针是稳定的（同 ruling 的去重）。返回 job id，没有就是 0。 */
function chat_job_inflight($rootId){
    $q=db()->prepare("SELECT id FROM agent_jobs WHERE type='chat' AND status IN('queued','running') AND payload LIKE ? LIMIT 1");
    $q->execute(['%"inbox_id":'.(int)$rootId.',%']);
    $r=$q->fetch();
    $q->closeCursor();
    return $r?(int)$r['id']:0;
}

/* 取一个会话根，顺带把「必须是 chat_root」和「必须还开着」两条前置条件查掉。
   $needOpen 为 true 时归档过的会话不接新消息：归档就是归档，
   要接着聊开一个新会话，别把已经结账的账本重新打开。
   返回根行数组，不合格直接 res() 掉。 */
function chat_root_or_die($id,$needOpen){
    $g=db()->prepare("SELECT * FROM seo_inbox WHERE id=?");
    $g->execute([(int)$id]);
    $r=$g->fetch();
    if(!$r)res(404,['error'=>'会话不存在']);
    if($r['kind']!=='chat_root')res(400,['error'=>'这条消息不是一个会话根']);
    if($needOpen&&$r['status']!=='open')res(400,['error'=>'这个会话已经归档了，开一个新会话继续聊']);
    if(!$r['client_id'])res(400,['error'=>'这个会话没有客户归属，无法继续']);
    return $r;
}

/* 往会话里写一行。人写的是 chat_user，opus 和服务端写的系统行是 chat_agent。
   全部 reply_to 指根，会话就是一层，没有回复的回复。
   status 一律 resolved：会话是否待办看根行，子行的 status 没有意义，
   写成 open 会让收件箱的待办计数虚高。 */
function chat_msg_insert($root,$kind,$body,$by,$refs=null){
    db()->prepare("INSERT INTO seo_inbox(client_id,kind,body,refs,reply_to,status,created_by)VALUES(?,?,?,?,?,'resolved',?)")
        ->execute([
            ($root['client_id']===null)?null:(int)$root['client_id'],
            $kind,$body,
            $refs===null?null:json_encode(inbox_refs_norm($refs),JSON_UNESCAPED_UNICODE),
            (int)$root['id'],$by
        ]);
    return (int)db()->lastInsertId();
}

/* 一条人消息进来以后排一个 chat job。会话的 client_id 就是 job 的 client_id，
   这也是 chat_root 强制要 client_id 的唯一原因：agent_jobs.client_id NOT NULL。 */
function chat_job_queue($root,$messageId,$by){
    $payload=json_encode(['inbox_id'=>(int)$root['id'],'message_id'=>(int)$messageId],JSON_UNESCAPED_UNICODE);
    db()->prepare("INSERT INTO agent_jobs(client_id,type,payload,status,created_by)VALUES(?,'chat',?,'queued',?)")
        ->execute([(int)$root['client_id'],$payload,$by]);
    $jid=(int)db()->lastInsertId();
    fire_wake($jid);
    return $jid;
}

/* refs is stored as a JSON string in a TEXT column, serialised by hand:
   production is MariaDB 10.3 and every other JSON-ish column in this schema is
   handled the same way.
   Canonical shape { "tasks": [int], "jobs": [int], "drafts": [ {...} ] }.
   A bare array is read as a list of task ids, which is what callers usually
   have to hand. drafts only ever appear on a chat_agent row: they are the task
   drafts the model proposed, stored verbatim so the board can draw a card with
   a 立项 button. A draft is not a task and never becomes one on its own. */
function inbox_refs_norm($v){
    $out=['tasks'=>[],'jobs'=>[],'drafts'=>[]];
    if($v===null||$v==='')return $out;
    if(is_string($v)){$d=json_decode($v,true);$v=($d===null)?[]:$d;}
    if(!is_array($v))return $out;
    if($v&&array_keys($v)===range(0,count($v)-1))$v=['tasks'=>$v];
    foreach(['tasks','jobs'] as $k){
        $list=(isset($v[$k])&&is_array($v[$k]))?$v[$k]:[];
        $seen=[];
        foreach($list as $x){
            $n=(int)$x;
            if($n>0&&!isset($seen[$n])){$seen[$n]=true;$out[$k][]=$n;}
        }
        if(count($out[$k])>200)$out[$k]=array_slice($out[$k],0,200);
    }
    $out['drafts']=inbox_drafts_norm($v['drafts']??null);
    $out['actions']=inbox_actions_norm($v['actions']??null);
    /* 任务线程里人发的消息可带截图（走 /feedback_upload 的文件名）与来源标记（manual / client）。 */
    $out['images']=[];
    if(isset($v['images'])&&is_array($v['images'])){
        foreach($v['images'] as $n){$n=(string)$n;if(fb_name_ok($n)&&!in_array($n,$out['images'],true))$out['images'][]=$n;}
        if(count($out['images'])>5)$out['images']=array_slice($out['images'],0,5);
    }
    $out['source']=(isset($v['source'])&&$v['source']==='client')?'client':'';
    return $out;
}

/* 任务线程里模型提议的动作，存在 chat_agent 行的 refs.actions，人点「执行」才落账
   （POST /inbox/{root}/thread_action）。白名单五种，跟 spawn_task 的草案同一个道理：
   提议是卡片，不是账本上的一行。 */
define('THREAD_ACTIONS',['redispatch','kill','later','set_verdict','edit_task','release']);
/* 线程里人话已经明确指向的动作，模型回复落库时服务端立即执行，不等人再点一次：
   这些全是看板层改动，可逆，指令来源是人自己在线程里说的话。
   release 不在里面：放行动线上，永远留人点。 */
define('THREAD_AUTO_ACTIONS',['redispatch','kill','later','set_verdict','edit_task']);
define('THREAD_MAX_ACTIONS',3);
function inbox_actions_norm($v){
    if(is_string($v)){$d=json_decode($v,true);$v=($d===null)?[]:$d;}
    if(!is_array($v))return [];
    $out=[];
    foreach($v as $a){
        if(count($out)>=THREAD_MAX_ACTIONS)break;
        if(!is_array($a))continue;
        $type=(string)($a['type']??'');
        if(!in_array($type,THREAD_ACTIONS,true))continue;
        $row=['type'=>$type,'reason'=>mb_substr(trim((string)($a['reason']??'')),0,500,'UTF-8')];
        if($type==='set_verdict'){
            $vd=(string)($a['verdict']??'');
            if(!in_array($vd,['do','later','drop'],true))continue;
            $row['verdict']=$vd;
        }
        if($type==='edit_task'){
            $f=[];
            if(isset($a['title'])&&trim((string)$a['title'])!=='')$f['title']=mb_substr(trim((string)$a['title']),0,255,'UTF-8');
            if(isset($a['detail'])&&trim((string)$a['detail'])!=='')$f['detail']=mb_substr(trim((string)$a['detail']),0,4000,'UTF-8');
            if(isset($a['priority'])&&in_array((string)$a['priority'],['P0','P1','P2','P3'],true))$f['priority']=(string)$a['priority'];
            if(isset($a['sprint']))$f['sprint']=mb_substr(trim((string)$a['sprint']),0,10,'UTF-8');
            if(!$f)continue;
            $row['fields']=$f;
        }
        if($row['reason']===''&&$type!=='release')continue;
        $out[]=$row;
    }
    return $out;
}

/* 执行一条线程动作。$a 是 inbox_actions_norm 出来的一行，$t 是任务行。
   回 ['ok'=>bool,'what'=>说明,'job_ids'=>[]]，不 res() 不 exit，chat_reply 的自动执行与人点执行共用。 */
function thread_action_exec($root,$t,$a,$by){
    $tid=(int)$t['id'];$cid=(int)$t['client_id'];
    $type=$a['type'];$reason=(string)($a['reason']??'');$jids=[];
    if($type==='redispatch'){
        if(!in_array($t['status'],['proposed','approved','blocked','review'],true))return ['ok'=>false,'what'=>'任务状态是 '.$t['status'].'，不能重派'];
        db()->prepare("UPDATE seo_tasks SET detail=CONCAT_WS('\n',NULLIF(detail,''),?),status='approved' WHERE id=?")
            ->execute(['[线程指令 '.date('Y-m-d').'] '.$reason,$tid]);
        list($jids,$sk)=queue_task_jobs($cid,'execute_task',[$tid],$by,'seo_job_create');
        return ['ok'=>true,'what'=>'已按线程指令重派执行，新指令已写进任务说明'.($jids?('，job #'.$jids[0]):'（任务已在队列，未重复排）'),'job_ids'=>$jids];
    }
    if($type==='kill'){
        $err=task_close($tid,'killed','线程裁决不做：'.$reason);
        if($err)return ['ok'=>false,'what'=>$err];
        return ['ok'=>true,'what'=>'已按不做处理，置 done','job_ids'=>[]];
    }
    if($type==='later'){
        if($t['status']==='done')return ['ok'=>false,'what'=>'任务已经结束'];
        db()->prepare("UPDATE seo_tasks SET status='blocked' WHERE id=?")->execute([$tid]);
        task_append_note($tid,'[later] 线程裁决延后：'.$reason);
        return ['ok'=>true,'what'=>'已延后，置 blocked','job_ids'=>[]];
    }
    if($type==='set_verdict'){
        if(empty($t['review_verdict']))return ['ok'=>false,'what'=>'任务还没有判决，没法改判'];
        db()->prepare("UPDATE seo_tasks SET review_override=?,review_override_note=?,updated_at=updated_at WHERE id=?")
            ->execute([$a['verdict'],mb_substr($reason,0,400,'UTF-8'),$tid]);
        return ['ok'=>true,'what'=>'已改判为 '.$a['verdict'],'job_ids'=>[]];
    }
    if($type==='edit_task'){
        $sets=[];$args=[];$names=[];
        foreach(($a['fields']??[]) as $k=>$v){$sets[]="$k=?";$args[]=$v;$names[]=$k;}
        if(!$sets)return ['ok'=>false,'what'=>'没有要改的字段'];
        $args[]=$tid;
        db()->prepare("UPDATE seo_tasks SET ".implode(',',$sets)." WHERE id=?")->execute($args);
        return ['ok'=>true,'what'=>'已更新任务字段：'.implode('、',$names),'job_ids'=>[]];
    }
    if($type==='release'){
        if($t['status']!=='review')return ['ok'=>false,'what'=>'任务不在待放行状态'];
        if(blog_outline_stage($t)){
            list($jids,$sk)=blog_release_as_write($cid,$t,$by);
            return ['ok'=>true,'what'=>'大纲已批，已排队写正文'.($jids?('，job #'.$jids[0]):'（已在队列）'),'job_ids'=>$jids];
        }
        list($jids,$sk)=queue_task_jobs($cid,'apply_task',[$tid],$by,'seo_tasks_release');
        return ['ok'=>true,'what'=>'已放行'.($jids?('，apply job #'.$jids[0]):'（已在队列，未重复排）'),'job_ids'=>$jids];
    }
    return ['ok'=>false,'what'=>'未知动作'];
}

/* Drop task ids that do not exist, and on a card that belongs to one client,
   ids that belong to somebody else. refs is what later bounds a ruling: an
   action may only touch a task the digest already named, so a junk ref here
   would become a way to reach an unrelated client's board. */
function inbox_refs_filter($refs,$clientId){
    if(!$refs['tasks'])return $refs;
    $in=implode(',',array_fill(0,count($refs['tasks']),'?'));
    $q=db()->prepare("SELECT id,client_id FROM seo_tasks WHERE id IN ($in)");
    $q->execute($refs['tasks']);
    $ok=[];
    foreach($q->fetchAll() as $r){
        if($clientId&&(int)$r['client_id']!==(int)$clientId)continue;
        $ok[(int)$r['id']]=true;
    }
    $refs['tasks']=array_values(array_filter($refs['tasks'],function($x)use($ok){return isset($ok[$x]);}));
    return $refs;
}

function inbox_row_out($r){
    $r['id']=(int)$r['id'];
    $r['client_id']=($r['client_id']===null)?null:(int)$r['client_id'];
    $r['reply_to']=($r['reply_to']===null)?null:(int)$r['reply_to'];
    $r['refs']=inbox_refs_norm($r['refs']);
    return $r;
}

/* One inbox row's task refs, with the fields a ruling actually needs to decide
   anything. Used both by GET /inbox/{id} and by the console. */
function inbox_ref_tasks($refs){
    if(!$refs['tasks'])return [];
    ensure_review_schema();
    $in=implode(',',array_fill(0,count($refs['tasks']),'?'));
    /* detail 与判定字段是任务线程（chat runner 任务模式）要的；裁决那条链路多拿几列无害。 */
    $q=db()->prepare("SELECT id,client_id,title,detail,status,owner_type,priority,module,sprint,attention,ops,output_url,result_note,
            review_verdict,review_reason,review_evidence,review_adjust,review_override,review_override_note
        FROM seo_tasks WHERE id IN ($in) ORDER BY FIELD(priority,'P0','P1','P2','P3'),id");
    $q->execute($refs['tasks']);
    $rows=$q->fetchAll();
    foreach($rows as &$r){
        $r['id']=(int)$r['id'];
        $r['client_id']=(int)$r['client_id'];
        $r['attention']=(int)$r['attention'];
    }
    unset($r);
    return $rows;
}

/* Feedback screenshots.
   These are client chat screenshots, so they never go under the webroot
   (/www/wwwroot/always/). They live one level up in a sibling directory nginx
   does not serve, and only ever reach a browser through GET /feedback_file/{name},
   which is behind auth. Stored names are random hex, the uploaded filename is
   thrown away: it can carry a person's name and it is attacker controlled. */
function fb_dir(){global $FEEDBACK_DIR;return rtrim($FEEDBACK_DIR,'/');}
function fb_dir_ready(){
    $d=fb_dir();
    if(!is_dir($d))@mkdir($d,0750,true);
    return is_dir($d)&&is_writable($d);
}
function fb_name_ok($n){return (bool)preg_match('#^[a-f0-9]{32}\.(png|jpg|jpeg|webp)$#',(string)$n);}
function fb_path($n){return fb_dir().'/'.$n;}
function fb_upload_error($code){
    switch($code){
        case UPLOAD_ERR_INI_SIZE: return 'File larger than the PHP upload_max_filesize limit';
        case UPLOAD_ERR_FORM_SIZE: return 'File larger than the form MAX_FILE_SIZE limit';
        case UPLOAD_ERR_PARTIAL: return 'Upload was interrupted, only part of the file arrived';
        case UPLOAD_ERR_NO_FILE: return 'No file in the request';
        case UPLOAD_ERR_NO_TMP_DIR: return 'PHP has no temp directory to write the upload to';
        case UPLOAD_ERR_CANT_WRITE: return 'PHP could not write the upload to disk';
        case UPLOAD_ERR_EXTENSION: return 'A PHP extension blocked the upload';
    }
    return 'Upload failed with code '.(int)$code;
}

/* Task deliverables.
   Same storage discipline as the screenshots above: outside the webroot,
   random hex on disk, the uploaded name kept only as a label in the database.
   The difference is that these come back out as downloads, not as thumbnails,
   so the original name matters and travels in Content-Disposition. */
define('DELIVERABLE_EXTS',['txt','csv','md','pdf','json']);
function dl_dir(){global $DELIVERABLE_DIR;return rtrim($DELIVERABLE_DIR,'/');}
function dl_dir_ready(){
    $d=dl_dir();
    if(!is_dir($d))@mkdir($d,0750,true);
    return is_dir($d)&&is_writable($d);
}
function dl_name_ok($n){return (bool)preg_match('#^[a-f0-9]{32}\.(txt|csv|md|pdf|json)$#',(string)$n);}
function dl_path($n){return dl_dir().'/'.$n;}

/* The uploaded name, reduced to something safe to store and to echo back in a
   header. Path separators and control characters go, the extension is kept,
   the base is capped so a pathological name can not fill the column. */
function dl_clean_name($n,$fallbackExt){
    $n=basename(str_replace('\\','/',(string)$n));
    $n=preg_replace('#[\x00-\x1f\x7f"\'\\\\/]+#','_',$n);
    $n=trim($n,". \t");
    $ext=strtolower(pathinfo($n,PATHINFO_EXTENSION));
    $base=pathinfo($n,PATHINFO_FILENAME);
    if(!in_array($ext,DELIVERABLE_EXTS,true)){$ext=$fallbackExt;}
    if($base===''||$base===null)$base='deliverable';
    if(mb_strlen($base,'UTF-8')>100)$base=mb_substr($base,0,100,'UTF-8');
    return $base.'.'.$ext;
}

/* finfo is a veto here, not a match.
   A pdf must really be a pdf. For the text formats the sniffed type is only
   used to keep binaries out: finfo happily calls a markdown file with html in
   it text/html and a txt starting with <?php text/x-php, and rejecting those
   would only produce false alarms. Nothing serves these bytes as html anyway,
   the download route forces octet-stream plus nosniff plus attachment. */
function dl_mime_ok($ext,$mime){
    $mime=strtolower((string)$mime);
    if($ext==='pdf')return $mime==='application/pdf';
    if(strpos($mime,'text/')===0)return true;
    return in_array($mime,['application/json','application/csv','application/x-empty','inode/x-empty'],true);
}

/* The veto without fileinfo, which is what actually runs: 250's PHP has no
   fileinfo extension, so finfo_open() is simply not there and the sniff above
   never gets a chance. Judged on the first bytes of the file:
     pdf   must open with the %PDF- magic
     text  must carry no NUL byte, which is what separates a text file from
           every binary format worth worrying about
   Returns the mime to record, or '' when the bytes are refused. */
function dl_bytes_ok($ext,$head){
    $head=(string)$head;
    if($ext==='pdf')return strncmp($head,'%PDF-',5)===0?'application/pdf':'';
    return strpos($head,"\0")===false?'text/plain':'';
}

/* The deliverable rows for a set of task ids, keyed by task id.
   One query for the whole board, so the task list does not fan out per card. */
function deliverables_by_task($ids){
    $ids=array_values(array_unique(array_map('intval',$ids)));
    if(!$ids)return [];
    ensure_deliverables_schema();
    $in=implode(',',array_fill(0,count($ids),'?'));
    $q=db()->prepare("SELECT id,task_id,orig_name,stored_name,bytes,mime,uploaded_by,created_at
        FROM seo_deliverables WHERE task_id IN ($in) ORDER BY task_id,id");
    $q->execute($ids);
    $by=[];
    foreach($q->fetchAll() as $r){
        $tid=(int)$r['task_id'];
        $r['id']=(int)$r['id'];
        $r['task_id']=$tid;
        $r['bytes']=(int)$r['bytes'];
        if(!isset($by[$tid]))$by[$tid]=[];
        $by[$tid][]=$r;
    }
    return $by;
}
/* Hang a deliverables array on every task row, empty array when there are none,
   so the front end never has to test for the key's existence. */
function attach_deliverables($tasks){
    if(!$tasks)return $tasks;
    $ids=[];
    foreach($tasks as $t){$ids[]=(int)$t['id'];}
    $by=deliverables_by_task($ids);
    foreach($tasks as &$t){
        $tid=(int)$t['id'];
        $t['deliverables']=isset($by[$tid])?$by[$tid]:[];
    }
    unset($t);
    return $tasks;
}

/* ---------------- 一任务一 job 的公共件 ----------------
   第一性原理：任务是工作单位，每个任务独享一个 job，各自 30 分钟预算与各自成败，
   worker 单飞按 job id 升序线性消化。POST /jobs、POST /tasks/release、
   GET /jobs/queue、GET /tasks 共用下面这几个解析与去重件。 */

/* payload 里的任务 id。execute_task 与 apply_task 现在一 job 一任务，取 task_ids[0]；
   其他类型没有任务概念，回 null。payload 可能是 JSON 字符串也可能已经是数组，
   历史行里 task_ids 可能有多个，取第一个即可（队列展示与匹配都只认头一个）。 */
function job_task_id($type,$payload){
    if($type!=='execute_task'&&$type!=='apply_task')return null;
    $p=is_array($payload)?$payload:jdec($payload);
    if(!is_array($p)||!isset($p['task_ids'])||!is_array($p['task_ids']))return null;
    foreach($p['task_ids'] as $x){$x=(int)$x;if($x)return $x;}
    return null;
}

/* 在飞任务表：某类型下所有 queued/running 的 job，解成 task_id => job_id。
   同一任务撞上多条时留 id 最小的那条，也就是最早排的。
   在飞集合本来就小（worker 单飞，队列以十计），一次全量取回在 PHP 里解，
   免得跟 MariaDB 10.3 的 JSON 函数较劲，GET /events 那段已经是同一个取舍。 */
function jobs_inflight_tasks($type){
    $q=db()->prepare("SELECT id,payload FROM agent_jobs WHERE type=? AND status IN('queued','running') ORDER BY id");
    $q->execute([$type]);
    $by=[];
    foreach($q->fetchAll() as $r){
        $tid=job_task_id($type,$r['payload']);
        if($tid&&!isset($by[$tid]))$by[$tid]=(int)$r['id'];
    }
    return $by;
}

/* 两条道。worker 每条道各自单飞（seo-worker/lib/lanes.js 同一张表，两边同步改）：
   heavy 写站点、跑几分钟的；light 只读只写看板、跑几十秒的（判定、裁决、反馈、对话、巡检）。
   拆开的理由只有一个：判定不能排在 10 分钟的 execute 后面等。不在表里的类型归 heavy。 */
define('JOB_LANES',[
    'heavy'=>['pull_data','discover','plan','execute_task','apply_task','report','backfill_metrics'],
    'light'=>['review_plan','ruling','feedback','chat','triage','plan_review'],
]);
function job_lane($type){return in_array((string)$type,JOB_LANES['light'],true)?'light':'heavy';}
/* 某条道的类型 IN 列表（SQL 片段，值来自常量不来自输入）。heavy 用「不在 light 里」表达，
   这样没登记的新类型也落 heavy，跟 job_lane() 一致。 */
function lane_type_sql($lane,$alias='j'){
    $light=implode(',',array_map(function($w){return "'".$w."'";},JOB_LANES['light']));
    if($lane==='light')return "$alias.type IN ($light)";
    return "$alias.type NOT IN ($light)";
}

/* 队列取单顺序，claim、位次、GET /jobs/queue 三处共用，改顺序只改这一处。
   $lane 传 'heavy' 或 'light' 时只排该道，正在跑的客户让位也只看同道（客户在 heavy 道跑着
   execute 不该拖累它在 light 道的判定）。不传就是全局，老口径。
   规则：客户轮转，不是纯 FIFO。每个客户排队中的 job 按 id 编内部序号 rn，
   正在跑着 job 的客户再让一位（rn 加 1），全局按 (rn, id) 出。
   效果：A 客户一口气批 7 个，B 客户后来才排 1 个，B 排在 A 的第二个前面，
   谁也饿不死谁；同一客户内部仍严格按提交顺序。
   窗口函数 MariaDB 10.2 起可用，线上 10.3 没问题。 */
function jobs_queue_order_sql($lane=null){
    $laneQ=$lane?(' AND '.lane_type_sql($lane,'j')):'';
    $laneR=$lane?(' AND '.lane_type_sql($lane,'x')):'';
    return "SELECT t.id FROM (
                SELECT j.id,
                       ROW_NUMBER() OVER (PARTITION BY j.client_id ORDER BY j.id)
                         + (CASE WHEN r.client_id IS NULL THEN 0 ELSE 1 END) AS rn
                FROM agent_jobs j
                LEFT JOIN (SELECT DISTINCT x.client_id FROM agent_jobs x WHERE x.status='running'$laneR) r
                  ON r.client_id=j.client_id
                WHERE j.status='queued'$laneQ
            ) t ORDER BY t.rn, t.id";
}

/* 排队位次 job_id => 位次（从 1 起），按道各自计数：位次是该道 worker 下一次 claim 的真实顺序。
   两条道的 job id 不相交，所以合成一张表回。 */
function jobs_queue_positions($limit=500){
    $limit=(int)$limit;
    if($limit<1)$limit=500;
    $pos=[];
    foreach(array_keys(JOB_LANES) as $lane){
        $q=db()->query(jobs_queue_order_sql($lane)." LIMIT $limit");
        $n=0;
        foreach($q->fetchAll() as $r){$n++;$pos[(int)$r['id']]=$n;}
    }
    return $pos;
}

/* 一任务一 job 的批量排队：按传入顺序逐个 INSERT，已在飞的任务跳过并记进 skipped，
   每条都写 audit。fire_wake 只发一次，worker 醒来会连续 claim 到队空。
   回 [新建 job id 数组, skipped 数组]。 */
function queue_task_jobs($cid,$type,$ids,$user,$auditAction){
    $inflight=jobs_inflight_tasks($type);
    $s=db()->prepare("INSERT INTO agent_jobs(client_id,type,payload,status,created_by)VALUES(?,?,?,'queued',?)");
    $jids=[];$skipped=[];
    foreach($ids as $x){
        $tid=(int)$x;
        if(!$tid)continue;
        if(isset($inflight[$tid])){$skipped[]=['task_id'=>$tid,'job_id'=>(int)$inflight[$tid]];continue;}
        $payload=['task_ids'=>[$tid]];
        /* 批准步骤已取消：执行一个 proposed 的任务就等于批准它。 */
        if($type==='execute_task')db()->prepare("UPDATE seo_tasks SET status='approved' WHERE id=? AND status='proposed'")->execute([$tid]);
        $s->execute([$cid,$type,json_encode($payload,JSON_UNESCAPED_UNICODE),$user]);
        $jid=(int)db()->lastInsertId();
        $jids[]=$jid;
        $inflight[$tid]=$jid;
        audit($user,$auditAction,(string)$jid,['client_id'=>$cid,'type'=>$type,'task_id'=>$tid,'payload'=>$payload]);
    }
    if($jids)fire_wake($jids[0]);
    return [$jids,$skipped];
}

/* 给任务卡挂 job_state，让看板不用自己对着 job 列表猜。
   {status:'queued'|'running'|'failed'|null, job_id, position, claimed_at}
   取该任务最新一条 execute_task / apply_task job：queued 与 running 优先（running 先），
   都没有才看最近一条 failed，且只有失败时刻晚于任务 updated_at 才算数
   （人已经把任务改过状态的，旧失败不再挂红）。
   一次 SQL 拉该客户近 200 条相关 job 在 PHP 里匹配，不做每卡一查。 */
function attach_job_state($tasks,$cid){
    if(!$tasks)return $tasks;
    $q=db()->prepare("SELECT id,type,status,payload,claimed_at,finished_at,created_at
        FROM agent_jobs WHERE client_id=? AND type IN('execute_task','apply_task') ORDER BY id DESC LIMIT 200");
    $q->execute([$cid]);
    $run=[];$que=[];$latest=[];$failRun=[];
    foreach($q->fetchAll() as $r){
        $tid=job_task_id($r['type'],$r['payload']);
        if(!$tid)continue;
        $st=(string)$r['status'];
        /* 倒序遍历：running 与 queued 每次覆盖，留下的是 id 最小的那条，也就是最早排的。
           latest 只认第一次见到的，也就是这个任务最近一次 job，不管成败。
           failRun 数「最近一次成功之后连续失败了几次」：人放行五次失败五次，卡上要写 5，
           不是每次都像第一次。2026-08-26 的教训：以前失败判定拿 finished_at 和任务 updated_at 比，
           而 apply 写失败备注本身就会顶掉 updated_at，失败信号被自己盖掉，卡上永远显示「待放行」。 */
        if($st==='running')$run[$tid]=$r;
        elseif($st==='queued')$que[$tid]=$r;
        if(!isset($latest[$tid])&&in_array($st,['done','failed'],true))$latest[$tid]=$r;
        if(!isset($failRun[$tid]))$failRun[$tid]=['n'=>0,'closed'=>false];
        if(!$failRun[$tid]['closed']){
            if($st==='failed')$failRun[$tid]['n']++;
            elseif($st==='done')$failRun[$tid]['closed']=true;
        }
    }
    $pos=($que)?jobs_queue_positions():[];
    foreach($tasks as &$t){
        $tid=(int)$t['id'];
        $state=['status'=>null,'job_id'=>null,'job_type'=>null,'position'=>null,'claimed_at'=>null,'fail_count'=>0];
        if(isset($run[$tid])){
            $state['status']='running';
            $state['job_id']=(int)$run[$tid]['id'];
            $state['job_type']=$run[$tid]['type'];
            $state['claimed_at']=$run[$tid]['claimed_at'];
        }elseif(isset($que[$tid])){
            $jid=(int)$que[$tid]['id'];
            $state['status']='queued';
            $state['job_id']=$jid;
            $state['job_type']=$que[$tid]['type'];
            $state['position']=isset($pos[$jid])?$pos[$jid]:null;
        }elseif(isset($latest[$tid])&&$latest[$tid]['status']==='failed'&&$t['status']!=='done'){
            /* 最近一次 job 失败了才算失败态，且失败之后任务没有被再写过。
               runner 的失败备注在 job 收尾前写入，两者常在同一秒，所以比较用「晚于或同秒」；
               之后人或 worker 再写结果（updated_at 晚一秒以上）就清掉失败徽标。 */
            $r=$latest[$tid];
            $ts=(string)($r['finished_at']!==null&&$r['finished_at']!==''?$r['finished_at']:$r['created_at']);
            $upd=(string)($t['updated_at']??'');
            if($upd===''||strcmp($ts,$upd)>=0){
                $state['status']='failed';
                $state['job_id']=(int)$r['id'];
                $state['job_type']=$r['type'];
                $state['fail_count']=(int)($failRun[$tid]['n']??1);
            }
        }
        $t['job_state']=$state;
    }
    unset($t);
    return $tasks;
}

/* 任务最近一次失败的一句话原因。优先结果备注里 runner 写的「执行中止：/执行失败：」那句
   （那是模型自己说的为什么），没有就取 job 日志最后一条 FAILED 行。人看卡就能知道为什么，
   不用去 Jobs 页翻。 */
function task_fail_reason($t,$jobId,$jobType=''){
    $note=(string)($t['result_note']??'');
    /* execute 失败（含方案 lint 打回）不写任务备注，原因只在 job 日志里；apply 失败才写备注。
       先按 job 类型选来源，否则会把上一轮 apply 的旧原因当成这次的。 */
    if($jobType==='execute_task'&&$jobId){
        $q=db()->prepare("SELECT log_text FROM agent_jobs WHERE id=?");
        $q->execute([(int)$jobId]);
        $r=$q->fetch();
        $q->closeCursor();
        $log=(string)(($r&&$r['log_text'])?$r['log_text']:'');
        if(preg_match_all('/FAILED\s*::\s*(?:Error:\s*)?([^\n]+)/u',$log,$mm)&&$mm[1]){
            $s=end($mm[1]);
            $s=preg_replace('/\s+at\s+\S+\s*\(.*$/u','',$s);
            return mb_substr(trim($s),0,300,'UTF-8');
        }
    }
    if(preg_match_all('/(?:执行中止|执行失败|发布后验证未通过|落地失败)[：:]\s*([^\n]+)/u',$note,$mm)&&$mm[1]){
        $s=end($mm[1]);
        $s=preg_replace('/\s*任务保持 review.*$/u','',$s);
        return mb_substr(trim($s),0,300,'UTF-8');
    }
    if($jobId){
        $q=db()->prepare("SELECT log_text FROM agent_jobs WHERE id=?");
        $q->execute([(int)$jobId]);
        $r=$q->fetch();
        $q->closeCursor();
        $log=(string)(($r&&$r['log_text'])?$r['log_text']:'');
        if(preg_match_all('/FAILED[:：]\s*([^\n]+)/u',$log,$mm)&&$mm[1])return mb_substr(trim(end($mm[1])),0,300,'UTF-8');
    }
    return '';
}

$m=$_SERVER['REQUEST_METHOD'];
$uri=$_SERVER['REQUEST_URI'];
$qp=strpos($uri,'?');
$path=$qp!==false?substr($uri,0,$qp):$uri;
/* $ROUTE = $path minus the /seo-api.php script prefix, same trick as mini.php */
$ROUTE=$path;
$sn=$_SERVER['SCRIPT_NAME']??'';
if($sn&&$sn!=='/'&&strpos($ROUTE,$sn)===0)$ROUTE=substr($ROUTE,strlen($sn));
elseif(($bp=strpos($ROUTE,'.php'))!==false)$ROUTE=substr($ROUTE,$bp+4);
$ROUTE=rtrim($ROUTE,'/');
if($ROUTE==='')$ROUTE='/';

/* brand_regex 排在最后，是后加的列（见 ensure_metrics_schema）。留空表示
   "让 worker 自己从客户名或域名推"，不是"这个客户没有品牌词"。 */
$PROFILE_FIELDS=['platform','domain','ga4_property','gsc_property','semrush_project','semrush_db','workspace_dir','business_goals','conversion_goals','notes','brand_regex','services','ads_customer_id','owner'];

/* =========================================================
   Worker endpoints (service token)
   Declared first so /jobs/claim never falls into /jobs/{id}.
   ========================================================= */

// POST /jobs/claim -> one queued job, flipped to running.
// Optimistic lock, not SELECT ... FOR UPDATE SKIP LOCKED: production runs
// MariaDB 10.3, and SKIP LOCKED only landed in MariaDB 10.6.
// The conditional UPDATE is the whole race guard; single worker today, so
// three retries are plenty.
// Pick order is client round-robin, see jobs_queue_order_sql(). Not plain id.
// body.lane 'heavy' | 'light' restricts the pick to that lane (JOB_LANES); an
// older worker that sends nothing gets any type, as before.
if($m==='POST'&&$ROUTE==='/jobs/claim'){
    auth_worker();
    $i=input();
    $lane=(string)($i['lane']??'');
    if($lane!==''&&!isset(JOB_LANES[$lane]))res(400,['error'=>'bad lane']);
    $jid=0;
    $pick=db()->prepare(jobs_queue_order_sql($lane?:null)." LIMIT 1");
    $take=db()->prepare("UPDATE agent_jobs SET status='running',claimed_at=NOW() WHERE id=? AND status='queued'");
    for($try=0;$try<3;$try++){
        $pick->execute();
        $row=$pick->fetch();
        $pick->closeCursor();
        if(!$row)res(200,['job'=>null]);
        $cand=(int)$row['id'];
        $take->execute([$cand]);
        $won=$take->rowCount();
        $take->closeCursor();
        if($won===1){$jid=$cand;break;}
    }
    if(!$jid)res(200,['job'=>null]);
    $g=db()->prepare("SELECT j.*,c.name AS client_name FROM agent_jobs j LEFT JOIN clients c ON c.id=j.client_id WHERE j.id=?");
    $g->execute([$jid]);
    $job=$g->fetch();
    if($job){$job['payload']=jdec($job['payload']);$job['token_usage']=(int)$job['token_usage'];}
    res(200,['job'=>$job?:null]);
}

/* GET /jobs/queue -> 全局队列一眼看清：现在在跑哪一条、后面排着谁、我排第几。
   固定路径，声明在 /jobs/{id} 那批正则之前，同 /jobs/claim 的道理。
   auth_any：看板要看，worker 侧排查也要看。running 与 queued 合计最多 100 条，
   queued 的顺序与位次走 jobs_queue_order_sql（客户轮转），和 worker 下一次真实取单一致。
   elapsed_sec 走 TIMESTAMPDIFF 交给库算，不在 PHP 里跟时区较劲。 */
if($m==='GET'&&$ROUTE==='/jobs/queue'){
    auth_any();
    $q=db()->query("SELECT j.id,j.client_id,j.type,j.payload,j.status,j.claimed_at,j.created_at,
            TIMESTAMPDIFF(SECOND,j.claimed_at,NOW()) AS elapsed_sec,c.name AS client_name
        FROM agent_jobs j LEFT JOIN clients c ON c.id=j.client_id
        WHERE j.status IN('queued','running') ORDER BY j.id LIMIT 100");
    $rows=$q->fetchAll();
    /* 位次按道各算：每行带 lane，queued 里 position 是该道内的位次，排序 heavy 在前、道内按取单顺序。 */
    $pos=jobs_queue_positions(100);
    $laneIdx=['heavy'=>0,'light'=>1];
    usort($rows,function($a,$b)use($pos,$laneIdx){
        if($a['status']!==$b['status'])return $a['status']==='running'?-1:1;
        $la=$laneIdx[job_lane($a['type'])];$lb=$laneIdx[job_lane($b['type'])];
        if($la!==$lb)return $la<=>$lb;
        $oa=$pos[(int)$a['id']]??PHP_INT_MAX;$ob=$pos[(int)$b['id']]??PHP_INT_MAX;
        return $oa===$ob?((int)$a['id']<=>(int)$b['id']):($oa<=>$ob);
    });
    $running=[];$queued=[];
    foreach($rows as $r){
        $row=[
            'id'=>(int)$r['id'],
            'client_id'=>(int)$r['client_id'],
            'client_name'=>$r['client_name']===null?'':(string)$r['client_name'],
            'type'=>$r['type'],
            'lane'=>job_lane($r['type']),
            'task_id'=>job_task_id($r['type'],$r['payload'])
        ];
        if($r['status']==='running'){
            $row['claimed_at']=$r['claimed_at'];
            $row['elapsed_sec']=$r['elapsed_sec']===null?null:(int)$r['elapsed_sec'];
            $running[]=$row;
        }else{
            $row['created_at']=$r['created_at'];
            $row['position']=$pos[(int)$r['id']]??null;
            $queued[]=$row;
        }
    }
    res(200,['ok'=>true,'running'=>$running,'queued'=>$queued]);
}

// PATCH /jobs/{id} -> worker progress: status / log_append / token_usage
// GET /jobs/{id} -> 一条 job 连同完整日志，任务卡上「看日志」用。admin 层。
if($m==='GET'&&preg_match('#^/jobs/(\d+)$#',$ROUTE,$mm)){
    auth_admin();
    $g=db()->prepare("SELECT j.*,c.name AS client_name FROM agent_jobs j LEFT JOIN clients c ON c.id=j.client_id WHERE j.id=?");
    $g->execute([(int)$mm[1]]);
    $job=$g->fetch();
    if(!$job)res(404,['error'=>'Job not found']);
    $job['payload']=jdec($job['payload']);
    $job['token_usage']=(int)$job['token_usage'];
    res(200,['job'=>$job]);
}

if($m==='PATCH'&&preg_match('#^/jobs/(\d+)$#',$ROUTE,$mm)){
    auth_worker();
    $jid=(int)$mm[1];
    $i=input();
    $chk=db()->prepare("SELECT id FROM agent_jobs WHERE id=?");
    $chk->execute([$jid]);
    if(!$chk->fetch())res(404,['error'=>'Job not found']);
    if(isset($i['log_append'])&&$i['log_append']!==''){
        db()->prepare("UPDATE agent_jobs SET log_text=CONCAT(COALESCE(log_text,''),?) WHERE id=?")
            ->execute([(string)$i['log_append'],$jid]);
    }
    if(isset($i['token_usage'])){
        db()->prepare("UPDATE agent_jobs SET token_usage=? WHERE id=?")->execute([(int)$i['token_usage'],$jid]);
    }
    if(isset($i['status'])){
        $st=(string)$i['status'];
        if(!in_array($st,['queued','running','done','failed'],true))res(400,['error'=>'bad status']);
        if($st==='done'||$st==='failed'){
            db()->prepare("UPDATE agent_jobs SET status=?,finished_at=NOW() WHERE id=?")->execute([$st,$jid]);
        }else{
            db()->prepare("UPDATE agent_jobs SET status=? WHERE id=?")->execute([$st,$jid]);
        }
    }
    res(200,['ok'=>true]);
}

// POST /tasks/{id}/result -> prepare stage done, task waits for a human to release.
// note lands in result_note (the change summary the reviewer reads), not detail.
if($m==='POST'&&preg_match('#^/tasks/(\d+)/result$#',$ROUTE,$mm)){
    auth_worker();
    $tid=(int)$mm[1];
    $i=input();
    $chk=db()->prepare("SELECT id FROM seo_tasks WHERE id=?");
    $chk->execute([$tid]);
    if(!$chk->fetch())res(404,['error'=>'Task not found']);
    db()->prepare("UPDATE seo_tasks SET output_url=?,status='review' WHERE id=?")
        ->execute([(string)($i['output_url']??''),$tid]);
    $note=trim((string)($i['note']??''));
    if($note!==''){
        db()->prepare("UPDATE seo_tasks SET result_note=CONCAT_WS('\n',NULLIF(result_note,''),?) WHERE id=?")
            ->execute([$note,$tid]);
    }
    if(isset($i['ops'])){
        db()->prepare("UPDATE seo_tasks SET ops=? WHERE id=?")->execute([(string)$i['ops'],$tid]);
    }
    if(isset($i['attention'])){
        db()->prepare("UPDATE seo_tasks SET attention=? WHERE id=?")->execute([$i['attention']?1:0,$tid]);
    }
    audit('seo-worker','seo_task_result',(string)$tid,['output_url'=>$i['output_url']??'','attention'=>isset($i['attention'])?($i['attention']?1:0):null]);
    /* 方案一出就自动判「该不该落地」，待放行面板上人看到的是判决不是 30KB 方案。 */
    $cq=db()->prepare("SELECT client_id FROM seo_tasks WHERE id=?");
    $cq->execute([$tid]);
    $cr=$cq->fetch();
    $cq->closeCursor();
    list($rjid,$rmerged)=queue_review_job((int)($cr['client_id']??0),[$tid],'seo-worker','seo_tasks_review_auto');
    res(200,['ok'=>true,'review_job_id'=>$rjid]);
}

// POST /tasks/{id}/complete -> apply stage finished, task is done for real
if($m==='POST'&&preg_match('#^/tasks/(\d+)/complete$#',$ROUTE,$mm)){
    auth_worker();
    $tid=(int)$mm[1];
    $i=input();
    $chk=db()->prepare("SELECT id FROM seo_tasks WHERE id=?");
    $chk->execute([$tid]);
    if(!$chk->fetch())res(404,['error'=>'Task not found']);
    $note=trim((string)($i['note']??''));
    if($note==='')res(400,['error'=>'note required：落地结果要带「检查:」行，没有证据不能算完成']);
    $err=task_close($tid,'applied',$note);
    if($err)res(400,['error'=>$err]);
    audit('seo-worker','seo_task_complete',(string)$tid,['note'=>$note]);
    res(200,['ok'=>true]);
}

// POST /tasks/{id}/feedback_result -> worker files what it made of a human note.
// body { feedback_id, summary, complete }        parse succeeded
// body { feedback_id, failed:true, error }       parse failed, the row says so
// The summary is appended to result_note like any other note. The task status
// is only touched when the human asked for completion at submit time.
if($m==='POST'&&preg_match('#^/tasks/(\d+)/feedback_result$#',$ROUTE,$mm)){
    auth_worker();
    ensure_feedback_schema();
    $tid=(int)$mm[1];
    $i=input();
    $fid=(int)($i['feedback_id']??0);
    if(!$fid)res(400,['error'=>'feedback_id required']);
    $chk=db()->prepare("SELECT id,task_id FROM seo_feedback WHERE id=?");
    $chk->execute([$fid]);
    $fb=$chk->fetch();
    if(!$fb)res(404,['error'=>'Feedback not found']);
    if((int)$fb['task_id']!==$tid)res(400,['error'=>'Feedback belongs to another task']);
    if(!empty($i['failed'])){
        $err=trim((string)($i['error']??''));
        if($err==='')$err='parse failed, no reason reported';
        db()->prepare("UPDATE seo_feedback SET status='failed',parsed_note=?,parsed_at=NOW() WHERE id=?")
            ->execute([$err,$fid]);
        audit('seo-worker','seo_feedback_failed',(string)$tid,['feedback_id'=>$fid,'error'=>$err]);
        res(200,['ok'=>true]);
    }
    $summary=trim((string)($i['summary']??''));
    if($summary==='')res(400,['error'=>'summary required']);
    db()->prepare("UPDATE seo_feedback SET status='parsed',parsed_note=?,parsed_at=NOW() WHERE id=?")
        ->execute([$summary,$fid]);
    db()->prepare("UPDATE seo_tasks SET result_note=CONCAT_WS('\n',NULLIF(result_note,''),?) WHERE id=?")
        ->execute(['[反馈] '.$summary,$tid]);
    $complete=!empty($i['complete']);
    if($complete){
        $err=task_close($tid,'accepted','按反馈认定完成：'.$summary);
        if($err)$complete=false;
    }
    audit('seo-worker','seo_feedback_result',(string)$tid,['feedback_id'=>$fid,'complete'=>$complete?1:0]);
    res(200,['ok'=>true,'complete'=>$complete]);
}

// GET /feedback_file/{name} -> stream one feedback screenshot.
// Both layers: the dashboard renders thumbnails, the runner downloads the file
// before it reads it. The name pattern is the whole path defence, nothing from
// the request is ever concatenated into a path unchecked.
if($m==='GET'&&preg_match('#^/feedback_file/([A-Za-z0-9._-]+)$#',$ROUTE,$mm)){
    auth_any();
    $name=$mm[1];
    if(!fb_name_ok($name))res(400,['error'=>'bad file name']);
    $p=fb_path($name);
    if(!is_file($p))res(404,['error'=>'File not found']);
    $ext=strtolower(pathinfo($name,PATHINFO_EXTENSION));
    $types=['png'=>'image/png','jpg'=>'image/jpeg','jpeg'=>'image/jpeg','webp'=>'image/webp'];
    header('Content-Type: '.($types[$ext]??'application/octet-stream'));
    header('Content-Length: '.filesize($p));
    header('Cache-Control: private, max-age=300');
    header('X-Content-Type-Options: nosniff');
    header('Content-Disposition: inline; filename="'.$name.'"');
    readfile($p);
    exit;
}

// POST /tasks/{id}/deliverables -> one file attached to a task, multipart form
// field "file", optional form field "name" carrying the original filename when
// the multipart filename is not trustworthy.
// Both layers, and the direction runs both ways: the worker files what a job
// produced for a human to carry off (a disavow list for Search Console), and a
// human files what they were handed (a client's spreadsheet, a list somebody
// assembled by hand) for the record and for the next run to read.
// uploaded_by records which of the two it was.
// Idempotent on (task_id, orig_name): re-uploading the same name replaces the
// previous copy instead of stacking another one on the card. Replacement is
// "write the new file under a new random name, then drop the old row", because
// the files belong to the www user and this API can not always unlink them. A
// physical file we failed to remove is reported back and logged, never retried.
if($m==='POST'&&preg_match('#^/tasks/(\d+)/deliverables$#',$ROUTE,$mm)){
    $u=auth_any();
    ensure_deliverables_schema();
    $who=(string)($u['username']??'');
    $tid=(int)$mm[1];
    $tq=db()->prepare("SELECT id,client_id FROM seo_tasks WHERE id=?");
    $tq->execute([$tid]);
    $task=$tq->fetch();
    if(!$task)res(404,['error'=>'Task not found']);
    $cid=(int)$task['client_id'];

    if(!isset($_FILES['file'])){
        /* Same blind spot as /feedback_upload: an oversized POST is thrown away
           before this script runs and leaves $_FILES and $_POST both empty. */
        $clen=(int)($_SERVER['CONTENT_LENGTH']??0);
        if($clen>0&&!$_POST)res(400,['error'=>'Upload rejected before PHP saw it, larger than post_max_size']);
        res(400,['error'=>'file field required']);
    }
    $f=$_FILES['file'];
    if(is_array($f['name']))res(400,['error'=>'one file per request']);
    if((int)$f['error']!==UPLOAD_ERR_OK)res(400,['error'=>fb_upload_error((int)$f['error'])]);
    $size=(int)$f['size'];
    if($size<=0)res(400,['error'=>'empty file']);
    if($size>$DELIVERABLE_MAX_BYTES)res(400,['error'=>'File over 5MB']);
    $tmp=(string)$f['tmp_name'];
    if(!is_uploaded_file($tmp))res(400,['error'=>'not an uploaded file']);

    /* The extension decides the type, and it may only come from a name we
       whitelisted. finfo then vetoes anything whose bytes disagree. */
    $claimed=(string)($_POST['name']??$f['name']);
    $ext=strtolower(pathinfo(basename(str_replace('\\','/',$claimed)),PATHINFO_EXTENSION));
    if(!in_array($ext,DELIVERABLE_EXTS,true)){
        res(400,['error'=>'Only '.implode(', ',DELIVERABLE_EXTS).' files are accepted, got '.($ext!==''?$ext:'no extension')]);
    }
    $orig=dl_clean_name($claimed,$ext);
    $mime='';
    if(function_exists('finfo_open')){
        $fi=finfo_open(FILEINFO_MIME_TYPE);
        $mime=(string)finfo_file($fi,$tmp);
        finfo_close($fi);
    }
    if($mime===''){
        /* 250 的 PHP 没有 fileinfo（feedback 靠 getimagesize 兜底，文本没有对应物）。
           退化成字节级否决：pdf 验魔数，文本类拒绝含 NUL 的二进制。否决精神不变。
           这是线上真正跑的那条路，判定逻辑在 dl_bytes_ok() 里，可单测。 */
        $head=(string)@file_get_contents($tmp,false,null,0,8192);
        $mime=dl_bytes_ok($ext,$head);
        if($mime===''){
            res(400,['error'=>$ext==='pdf'
                ?'File contents do not look like pdf'
                :'File looks binary, refusing for a text extension']);
        }
    }elseif(!dl_mime_ok($ext,$mime)){
        res(400,['error'=>'File contents do not look like '.$ext.', sniffed '.$mime]);
    }
    if(!dl_dir_ready())res(500,['error'=>'Deliverable directory is missing or not writable: '.dl_dir()]);

    $stored=bin2hex(random_bytes(16)).'.'.$ext;
    if(!@move_uploaded_file($tmp,dl_path($stored)))res(500,['error'=>'Could not store the upload in '.dl_dir()]);
    @chmod(dl_path($stored),0640);

    /* New row first, old rows second. A crash between the two shows a duplicate
       on the card, which a human can see and clean up; the other order would
       show nothing at all. */
    db()->prepare("INSERT INTO seo_deliverables(task_id,client_id,orig_name,stored_name,bytes,mime,uploaded_by)VALUES(?,?,?,?,?,?,?)")
        ->execute([$tid,$cid,$orig,$stored,$size,$mime,$who]);
    $did=(int)db()->lastInsertId();

    $old=db()->prepare("SELECT id,stored_name FROM seo_deliverables WHERE task_id=? AND orig_name=? AND id<>?");
    $old->execute([$tid,$orig,$did]);
    $stale=$old->fetchAll();
    $old->closeCursor();
    $orphans=[];
    foreach($stale as $s){
        db()->prepare("DELETE FROM seo_deliverables WHERE id=?")->execute([(int)$s['id']]);
        $sp=dl_path($s['stored_name']);
        if(is_file($sp)&&!@unlink($sp))$orphans[]=$s['stored_name'];
    }
    audit($who,'seo_deliverable_upload',(string)$tid,[
        'client_id'=>$cid,'deliverable_id'=>$did,'orig_name'=>$orig,'stored_name'=>$stored,
        'bytes'=>$size,'mime'=>$mime,'replaced'=>count($stale),'orphan_files'=>$orphans
    ]);
    res(200,[
        'ok'=>true,'id'=>$did,'task_id'=>$tid,'orig_name'=>$orig,'stored_name'=>$stored,
        'bytes'=>$size,'mime'=>$mime,'uploaded_by'=>$who,
        'replaced'=>count($stale),'orphan_files'=>$orphans
    ]);
}

// GET /tasks/{id}/deliverables -> the file list for one task, oldest first.
// Either layer: the card reads it, and a runner may want to know what it
// already handed up before it uploads again.
if($m==='GET'&&preg_match('#^/tasks/(\d+)/deliverables$#',$ROUTE,$mm)){
    auth_any();
    ensure_deliverables_schema();
    $tid=(int)$mm[1];
    $s=db()->prepare("SELECT id,task_id,client_id,orig_name,stored_name,bytes,mime,uploaded_by,created_at
        FROM seo_deliverables WHERE task_id=? ORDER BY id");
    $s->execute([$tid]);
    $rows=$s->fetchAll();
    foreach($rows as &$r){
        $r['id']=(int)$r['id'];
        $r['task_id']=(int)$r['task_id'];
        $r['client_id']=(int)$r['client_id'];
        $r['bytes']=(int)$r['bytes'];
    }
    unset($r);
    res(200,['deliverables'=>$rows]);
}

// GET /deliverable_file/{stored_name} -> the file itself, as a download.
// Same defence as /feedback_file: the name pattern is checked before it ever
// touches a path, and the row has to exist. Always octet-stream and always an
// attachment, so nothing here can be talked into rendering in the browser.
if($m==='GET'&&preg_match('#^/deliverable_file/([A-Za-z0-9._-]+)$#',$ROUTE,$mm)){
    auth_any();
    ensure_deliverables_schema();
    $name=$mm[1];
    if(!dl_name_ok($name))res(400,['error'=>'bad file name']);
    $q=db()->prepare("SELECT orig_name FROM seo_deliverables WHERE stored_name=? LIMIT 1");
    $q->execute([$name]);
    $row=$q->fetch();
    $q->closeCursor();
    if(!$row)res(404,['error'=>'File not found']);
    $p=dl_path($name);
    if(!is_file($p))res(404,['error'=>'File not found on disk']);
    $orig=(string)$row['orig_name'];
    /* Two filenames on purpose: an ascii fallback old clients understand, and
       the RFC 5987 form for anything with non ascii in it. */
    $ascii=preg_replace('#[^A-Za-z0-9._-]+#','_',$orig);
    if($ascii==='')$ascii=$name;
    header('Content-Type: application/octet-stream');
    header('Content-Length: '.filesize($p));
    header('Cache-Control: private, max-age=60');
    header('X-Content-Type-Options: nosniff');
    header('Content-Disposition: attachment; filename="'.$ascii.'"; filename*=UTF-8\'\''.rawurlencode($orig));
    readfile($p);
    exit;
}

// GET /blog_review_watch -> every blog task sitting in review with a preview
// link on it, across all clients. The blog review sweep in the worker needs to
// know which tasks to poll, and the worker token has no cross client read
// anywhere else: /clients and /tasks are both admin only, and /context needs a
// client_id it does not have. This is that enumeration, narrowed to exactly the
// rows the sweep can act on, so widening admin endpoints was not necessary.
if($m==='GET'&&$ROUTE==='/blog_review_watch'){
    auth_any();
    $s=db()->prepare("SELECT id,client_id,ops,output_url,result_note,status FROM seo_tasks
        WHERE status='review' AND output_url<>'' AND ops LIKE '%blog-draft%' ORDER BY client_id,id LIMIT 200");
    $s->execute();
    $rows=$s->fetchAll();
    foreach($rows as &$r){$r['id']=(int)$r['id'];$r['client_id']=(int)$r['client_id'];}
    unset($r);
    res(200,['tasks'=>$rows]);
}

// POST /tasks/{id}/revise -> queue one execute_task job for this task alone.
// Deliberately narrow: the worker may not create arbitrary jobs (POST /jobs is
// admin only and stays that way), it may only ask for a revision pass on a blog
// task a client already sent back. Same client plus type dedup as /tasks/release,
// so a sweep that fires while a run is in flight gets a 409 and tries next tick.
if($m==='POST'&&preg_match('#^/tasks/(\d+)/revise$#',$ROUTE,$mm)){
    auth_worker();
    $tid=(int)$mm[1];
    $i=input();
    $g=db()->prepare("SELECT id,client_id,status,ops FROM seo_tasks WHERE id=?");
    $g->execute([$tid]);
    $task=$g->fetch();
    if(!$task)res(404,['error'=>'Task not found']);
    if($task['status']!=='review')res(400,['error'=>'Task is not in review']);
    if(strpos((string)$task['ops'],'blog-draft')===false)res(400,['error'=>'Task does not carry blog-draft']);
    $cid=(int)$task['client_id'];
    $dup=db()->prepare("SELECT id FROM agent_jobs WHERE client_id=? AND type='execute_task' AND status IN('queued','running') LIMIT 1");
    $dup->execute([$cid]);
    $d=$dup->fetch();
    if($d)res(409,['error'=>'execute_task already queued or running','job_id'=>(int)$d['id']]);
    $reason=trim((string)($i['reason']??''));
    $payload=json_encode(['task_ids'=>[$tid],'reason'=>mb_substr($reason,0,500,'UTF-8')],JSON_UNESCAPED_UNICODE);
    db()->prepare("INSERT INTO agent_jobs(client_id,type,payload,status,created_by)VALUES(?,'execute_task',?,'queued','seo-worker')")
        ->execute([$cid,$payload]);
    $jid=(int)db()->lastInsertId();
    audit('seo-worker','seo_blog_revise',(string)$tid,['client_id'=>$cid,'job_id'=>$jid,'reason'=>$reason]);
    fire_wake($jid);
    res(200,['ok'=>true,'job_id'=>$jid]);
}

// POST /snapshots -> store a raw metrics pull
if($m==='POST'&&$ROUTE==='/snapshots'){
    auth_worker();
    $i=input();
    $cid=(int)($i['client_id']??0);
    $src=(string)($i['source']??'');
    if(!$cid)res(400,['error'=>'client_id required']);
    if(!in_array($src,SNAPSHOT_SOURCES,true))res(400,['error'=>'bad source']);
    /* content_registry postdates the original ENUM, so widen before inserting.
       Cheap: one information_schema read per process, and a no-op after the
       first deploy has migrated the column. */
    ensure_snapshot_sources();
    $data=$i['data']??null;
    $s=db()->prepare("INSERT INTO seo_snapshots(client_id,source,period_start,period_end,data)VALUES(?,?,?,?,?)");
    $s->execute([
        $cid,$src,
        ($i['period_start']??null)?:null,
        ($i['period_end']??null)?:null,
        $data===null?null:(is_string($data)?$data:json_encode($data,JSON_UNESCAPED_UNICODE))
    ]);
    res(200,['ok'=>true,'id'=>(int)db()->lastInsertId()]);
}

// GET /snapshots?client_id=&source=&limit= -> index only, no data blobs.
// Dashboard and runner both read this, so either auth layer passes.
if($m==='GET'&&$ROUTE==='/snapshots'){
    auth_any();
    $cid=need_client();
    $lim=(int)($_GET['limit']??10);
    if($lim<1)$lim=10;
    if($lim>50)$lim=50;
    $args=[$cid];
    $where="client_id=?";
    $src=(string)($_GET['source']??'');
    if($src!==''){
        if(!in_array($src,SNAPSHOT_SOURCES,true))res(400,['error'=>'bad source']);
        $where.=" AND source=?";
        $args[]=$src;
    }
    $s=db()->prepare("SELECT id,source,period_start,period_end,created_at,LENGTH(data) AS bytes FROM seo_snapshots WHERE $where ORDER BY id DESC LIMIT $lim");
    $s->execute($args);
    $rows=$s->fetchAll();
    foreach($rows as &$r){$r['bytes']=(int)$r['bytes'];}
    unset($r);
    res(200,['snapshots'=>$rows]);
}

// GET /snapshots/{id} -> one snapshot with the full data payload
if($m==='GET'&&preg_match('#^/snapshots/(\d+)$#',$ROUTE,$mm)){
    auth_any();
    $s=db()->prepare("SELECT * FROM seo_snapshots WHERE id=?");
    $s->execute([(int)$mm[1]]);
    $r=$s->fetch();
    if(!$r)res(404,['error'=>'Snapshot not found']);
    $r['data']=jdec($r['data']);
    res(200,['snapshot'=>$r]);
}

/* =========================================================
   日粒度时序：seo_metrics_daily 的读写口，加上从现有数据推导的动作事件。
   snapshot 回答"这 28 天怎么样"，这一段回答"每天怎么样、哪天动了什么手"。
   ========================================================= */

// POST /metrics -> worker 批量 upsert 按日指标。幂等：靠 UNIQUE(client_id,d,m)，
// 同一窗口重跑只覆盖不堆行，所以回填 job 随便重跑。
// body { client_id, rows: [{ d:'YYYY-MM-DD', m:'gsc_clicks', v:123 }, ...] }
// 全批先校验再写，一行不合格整批 400：半批写进去比不写更难查。
if($m==='POST'&&$ROUTE==='/metrics'){
    auth_worker();
    ensure_metrics_schema();
    $i=input();
    $cid=(int)($i['client_id']??0);
    if(!$cid)res(400,['error'=>'client_id required']);
    $rows=$i['rows']??null;
    if(!is_array($rows))res(400,['error'=>'rows required']);
    if(!$rows)res(200,['ok'=>true,'rows'=>0]);
    /* 一次 2000 行。回填 180 天 x 6 个指标约 1080 行，一批装得下；
       worker 侧仍然分块发，这个上限只是防呆。 */
    if(count($rows)>2000)res(400,['error'=>'batch too large, max 2000 rows']);
    list($clean,$err)=metrics_rows_prepare($cid,$rows);
    if($err!==null)res(400,['error'=>$err]);
    $p=db();
    $written=0;
    $p->beginTransaction();
    try{
        /* 200 行一条语句：够快，又不会把 max_allowed_packet 或
           prepared statement 的占位符数量顶到天上。 */
        foreach(array_chunk($clean,200) as $chunk){
            $ph=implode(',',array_fill(0,count($chunk),'(?,?,?,?)'));
            $args=[];
            foreach($chunk as $row){foreach($row as $x)$args[]=$x;}
            $p->prepare("INSERT INTO seo_metrics_daily(client_id,d,m,v)VALUES $ph
                         ON DUPLICATE KEY UPDATE v=VALUES(v)")->execute($args);
            $written+=count($chunk);
        }
        $p->commit();
    }catch(Exception $e){
        if($p->inTransaction())$p->rollBack();
        res(500,['error'=>'metrics upsert failed']);
    }
    res(200,['ok'=>true,'rows'=>$written]);
}

// GET /metrics?client_id=&from=&to=&metrics=a,b,c -> 按指标分组的日粒度序列。
// 日期升序，缺的日子不补零：补零会把"那天没数据"画成"那天是 0"，
// 这两件事在趋势图上意思完全不同，交给前端决定怎么显示。
// metrics 省略 = 全部指标；请求过的指标即使一行没有也会回一个空数组，
// 前端拿到的 key 集合永远稳定，不用写 undefined 判断。
/* auth_any 而不是 auth_admin：报告的零 LLM 数据层要按日指标，worker 拿服务令牌
   直接读这里，不在 worker 侧另写一份 SQL。回传只有指标名与数字，没有人名、
   没有客户原话，worker 收窄字段的理由在这里不成立。 */
if($m==='GET'&&$ROUTE==='/metrics'){
    auth_any();
    ensure_metrics_schema();
    $cid=need_client();
    $to=(string)($_GET['to']??'');
    $from=(string)($_GET['from']??'');
    if($to===''){$to=date('Y-m-d');}
    if($from===''){$from=date('Y-m-d',strtotime($to.' -89 day'));}
    if(!ymd_ok($from)||!ymd_ok($to))res(400,['error'=>'from/to 必须是 YYYY-MM-DD']);
    if(strcmp($from,$to)>0)res(400,['error'=>'from 不能晚于 to']);
    /* 跨度上限：一个客户一天最多 11 行，800 天 x 11 约 8800 行，
       够画三年趋势又不至于让一次误请求把整张表拖出来。 */
    if((strtotime($to)-strtotime($from))/86400>800)res(400,['error'=>'区间过长，上限 800 天']);

    $want=METRIC_NAMES;
    $sel=trim((string)($_GET['metrics']??''));
    if($sel!==''){
        $want=[];
        foreach(explode(',',$sel) as $x){
            $x=trim($x);
            if($x==='')continue;
            if(!in_array($x,METRIC_NAMES,true))res(400,['error'=>"unknown metric \"$x\""]);
            if(!in_array($x,$want,true))$want[]=$x;
        }
        if(!$want)res(400,['error'=>'metrics 参数为空']);
    }

    $out=[];
    foreach($want as $x)$out[$x]=[];
    $in=implode(',',array_fill(0,count($want),'?'));
    $args=array_merge([$cid,$from,$to],$want);
    $s=db()->prepare("SELECT d,m,v FROM seo_metrics_daily
                      WHERE client_id=? AND d BETWEEN ? AND ? AND m IN ($in)
                      ORDER BY m,d");
    $s->execute($args);
    foreach($s->fetchAll() as $r){
        $out[$r['m']][]=['d'=>$r['d'],'v'=>(float)$r['v']];
    }
    res(200,['ok'=>true,'from'=>$from,'to'=>$to,'metrics'=>$out]);
}

/* GET /events 用的两个小工具。
   ev_label: 事件标签统一收口，中文一句话，去掉换行，砍到 80 字。
   ev_pick_date: 从一段文本里捞第一个 YYYY-MM-DD，捞不到回 null。 */
function ev_label($prefix,$text){
    $t=trim(preg_replace('/\s+/u',' ',(string)$text));
    if(mb_strlen($t,'UTF-8')>80)$t=mb_substr($t,0,80,'UTF-8').'…';
    return $prefix===''?$t:($prefix.'：'.$t);
}
function ev_pick_date($text){
    if(preg_match('/(\d{4}-\d{2}-\d{2})/',(string)$text,$mm))return $mm[1];
    return null;
}
/* 一条已办结的任务算哪类事件，或者根本不算事件。抽成函数是为了能单测：
   这段规则决定趋势图上画不画那根竖线，判错了比不画更误导人。
     output_url 落在 /blog/ 下，或 ops 里带 blog-publish  -> publish（博文上线）
     ops 指向 GA4/GTM/GSC/GBP 这类配置面                  -> config（配置变更）
     ops 非空的其余情况                                    -> apply（站点变更）
     ops 为空且不是博文                                    -> null（分析或沟通类，
       站点上什么都没变，不该出现在时间轴上）
   注意判定顺序：博文优先于 ops，因为博文任务的 ops 是 blog-draft，
   按 ops 判会被归成 apply。 */
function ev_task_kind($ops,$outputUrl){
    $ops=trim((string)$ops);
    $url=(string)$outputUrl;
    if(strpos($url,'/blog/')!==false||stripos($ops,'blog-publish')!==false)return 'publish';
    if($ops==='')return null;
    if(preg_match('/(^|,)\s*(ga4|gtm|gsc|gbp)[-_]/i',$ops))return 'config';
    return 'apply';
}

// GET /events?client_id=&from=&to= -> 时间轴上的动作标注，画在趋势图上做因果对照。
//
// 不建新表，全部从现有数据确定性推导。规则宁缺勿滥：推不出可靠日期的一律不出，
// 因为一个日期错位的标注比没有标注更能误导人。四类来源：
//   apply   已办结且带 ops 标签的任务，也就是真的动了站点的那些
//   config  同上，但 ops 指向的是 GA4/GTM/GSC 这类配置面，不是站点内容
//   publish 已办结且 output_url 落在 /blog/ 下的任务，博文上线
//   offpage seo_facts 里记录 disavow 提交这类站外动作的条目
// 日期取值优先级：audit_log 里那条把任务置为 done 的记录（唯一真实的完成时刻）
//   > 对应 apply_task job 的 finished_at > seo_tasks.updated_at（会被后续编辑
//   带偏，所以排最后）。
/* 历史大事记批量导入。幂等：fact_key 由日期加标签哈希决定，同一条重复导入
   走 upsert 覆盖不新增。只收大刀，规范见导入手册，垃圾进垃圾出。 */
if($m==='POST'&&$ROUTE==='/facts_history'){
    $u=auth_admin();
    $i=input();
    $cid=(int)($i['client_id']??0);
    if(!$cid)res(400,['error'=>'client_id required']);
    $list=$i['events']??null;
    if(!is_array($list)||!$list)res(400,['error'=>'events 数组必填']);
    if(count($list)>30)res(400,['error'=>'一次最多 30 条，大事记不是流水账']);
    $hkinds=['apply','publish','offpage','config','manual'];
    $ins=db()->prepare("INSERT INTO seo_facts(client_id,fact_key,value,source,status,updated_by)
                        VALUES(?,?,?,'manual','confirmed',?)
                        ON DUPLICATE KEY UPDATE value=VALUES(value),updated_by=VALUES(updated_by)");
    $done=[];
    foreach($list as $n=>$e){
        $d=trim((string)($e['d']??''));
        $kind=trim((string)($e['kind']??'manual'));
        $label=trim((string)($e['label']??''));
        if(!ymd_ok($d))res(400,['error'=>'第 '.($n+1).' 条日期不是 YYYY-MM-DD']);
        if(!in_array($kind,$hkinds,true))res(400,['error'=>'第 '.($n+1).' 条 kind 不在 '.implode('/',$hkinds)]);
        if($label===''||mb_strlen($label,'UTF-8')>200)res(400,['error'=>'第 '.($n+1).' 条说明必填且不超 200 字']);
        $key='history.event.'.str_replace('-','',$d).'.'.substr(md5($label),0,6);
        $ins->execute([$cid,$key,$d.'|'.$kind.'|'.$label,$u['username']]);
        $done[]=$key;
    }
    audit($u['username'],'seo_facts_history_import',(string)$cid,['count'=>count($done)]);
    res(200,['ok'=>true,'imported'=>count($done),'keys'=>$done]);
}

/* 同 GET /metrics 改成 auth_any：报告要在趋势图上标动作，事件是数据层的一部分。
   回传只有日期、一句中文标签和 kind 分类，都是本来就要写给客户看的东西。 */
if($m==='GET'&&$ROUTE==='/events'){
    auth_any();
    $cid=need_client();
    $to=(string)($_GET['to']??'');
    $from=(string)($_GET['from']??'');
    if($to===''){$to=date('Y-m-d');}
    if($from===''){$from=date('Y-m-d',strtotime($to.' -89 day'));}
    if(!ymd_ok($from)||!ymd_ok($to))res(400,['error'=>'from/to 必须是 YYYY-MM-DD']);
    if(strcmp($from,$to)>0)res(400,['error'=>'from 不能晚于 to']);

    $events=[];

    /* ---- 任务类：apply / config / publish ---- */
    $tq=db()->prepare("SELECT id,title,ops,output_url,result_note,updated_at FROM seo_tasks
                       WHERE client_id=? AND status='done' ORDER BY id");
    $tq->execute([$cid]);
    $tasks=$tq->fetchAll();

    if($tasks){
        $ids=[];
        foreach($tasks as $t)$ids[]=(int)$t['id'];

        /* 完成时刻的第一来源：audit_log。worker 办结走 seo_task_complete，
           人手在看板上置完成走 seo_task_update 且 detail 里带 "status":"done"。
           取 MIN 是"第一次被置为完成"，任务被重开再办结时不会把标注挪到后面。
           detail 是 JSON 列，MariaDB 10.3 底下就是 LONGTEXT，LIKE 可以直接用。 */
        $in=implode(',',array_fill(0,count($ids),'?'));
        $aq=db()->prepare("SELECT target,MIN(created_at) AS done_at FROM audit_log
                           WHERE action IN('seo_task_complete','seo_task_update')
                             AND target IN ($in)
                             AND (action='seo_task_complete' OR detail LIKE '%\"status\":\"done\"%')
                           GROUP BY target");
        $aq->execute($ids);
        $doneAt=[];
        foreach($aq->fetchAll() as $r)$doneAt[(string)$r['target']]=$r['done_at'];

        /* 第二来源：apply_task job 的 finished_at。payload 是 {"task_ids":[...]}，
           在 PHP 里解，不用 JSON 函数，省得跟 10.3 的 JSON 支持较劲。
           按 id 升序遍历，后面的 job 覆盖前面的，落到"最后一次真的 apply"。 */
        $jq=db()->prepare("SELECT payload,finished_at FROM agent_jobs
                           WHERE client_id=? AND type='apply_task' AND status='done'
                             AND finished_at IS NOT NULL ORDER BY id");
        $jq->execute([$cid]);
        $appliedAt=[];
        foreach($jq->fetchAll() as $j){
            $pl=json_decode((string)$j['payload'],true);
            if(!is_array($pl)||!isset($pl['task_ids'])||!is_array($pl['task_ids']))continue;
            foreach($pl['task_ids'] as $x)$appliedAt[(string)(int)$x]=$j['finished_at'];
        }

        foreach($tasks as $t){
            $tid=(string)$t['id'];
            $kind=ev_task_kind($t['ops'],$t['output_url']);
            if($kind===null)continue;
            /* apply 类（prepare 模式的站点变更）要有实锤才算事件：要么真跑过
               apply_task（appliedAt 命中），要么巡检/人工在 result_note 里盖了
               [applied] 章。任务被归档置完成（如方案只存档不执行）时两者都没有，
               不产事件，否则曲线上会出现一根从未发生过的"站点变更"标注。 */
            if($kind==='apply'
               && !isset($appliedAt[$tid])
               && strpos((string)$t['result_note'],'[applied]')===false)continue;
            if($kind==='publish'){
                /* 标题多半已经是"博文：xxx"，再加一层前缀就重复了，去掉再拼。 */
                $label=ev_label('博文发布',preg_replace('/^博文[:：]\s*/u','',(string)$t['title']));
            }elseif($kind==='config'){
                $label=ev_label('配置变更',$t['title']);
            }else{
                $label=ev_label('站点变更',$t['title']);
            }
            $when=$doneAt[$tid]??($appliedAt[$tid]??$t['updated_at']);
            if(!$when)continue;
            $d=substr((string)$when,0,10);
            if(!ymd_ok($d))continue;
            $events[]=['d'=>$d,'label'=>$label,'kind'=>$kind];
        }
    }

    /* ---- 站外类：seo_facts 里的 disavow 提交记录 ----
       实际键名带阶段编号（link.disavow_stage1_submitted），所以匹配写成
       "含 disavow 且含 submitted"，literal 的 disavow_submitted 是它的子集。
       日期优先从 value 正文里捞（人写的那条自带提交日），捞不到才退到 updated_at，
       因为 updated_at 是"这行最后被改的时刻"，不是"这件事发生的时刻"。 */
    $fq=db()->prepare("SELECT fact_key,value,updated_at FROM seo_facts
                       WHERE client_id=? AND fact_key LIKE '%disavow%submitted%' ORDER BY fact_key");
    $fq->execute([$cid]);
    foreach($fq->fetchAll() as $f){
        $val=(string)$f['value'];
        if(trim($val)==='')continue;
        $d=ev_pick_date($val);
        if(!$d)$d=substr((string)$f['updated_at'],0,10);
        if(!ymd_ok($d))continue;
        /* 只留第一句：value 常常带着观察窗、后续计划这些跟当天动作无关的尾巴。 */
        $first=preg_split('/[；;。\r\n]/u',$val)[0];
        /* 开头那个日期已经变成 d 了，标签里不用再重复一遍。 */
        $first=preg_replace('/^\s*\d{4}-\d{2}-\d{2}\s*/','',$first);
        $events[]=['d'=>$d,'label'=>ev_label('',$first),'kind'=>'offpage'];
    }

    /* ---- 历史大事记：fact_key history.event.* ----
       客户导入时补录的接手前操作史（迁移、改版、外链活动、被注入等）。
       value 约定格式 "YYYY-MM-DD|kind|说明"，kind 超出白名单一律归 manual；
       不合格式的行退化为 ev_pick_date 捞日期加整段当标签，捞不到日期就丢弃，
       宁缺勿滥，绝不用 updated_at 冒充历史日期。 */
    $hq=db()->prepare("SELECT value FROM seo_facts
                       WHERE client_id=? AND fact_key LIKE 'history.event.%' ORDER BY fact_key");
    $hq->execute([$cid]);
    $hkinds=['apply','publish','offpage','config','manual'];
    foreach($hq->fetchAll() as $h){
        $val=trim((string)$h['value']);
        if($val==='')continue;
        $parts=explode('|',$val,3);
        if(count($parts)===3&&ymd_ok(trim($parts[0]))){
            $kind=in_array(trim($parts[1]),$hkinds,true)?trim($parts[1]):'manual';
            $events[]=['d'=>trim($parts[0]),'label'=>ev_label('',trim($parts[2])),'kind'=>$kind];
        }else{
            $d=ev_pick_date($val);
            if(!$d)continue;
            $lbl=preg_replace('/^\s*\d{4}-\d{2}-\d{2}\s*/','',$val);
            $events[]=['d'=>$d,'label'=>ev_label('',$lbl),'kind'=>'manual'];
        }
    }

    /* 区间过滤 + 去重 + 排序。去重按 (日期, 类型, 标签)：同一件事从两条路径
       推出来时只留一条。排序按日期升序，同日按类型和标签，保证同样的数据
       永远给出同样的顺序，前端不用自己再排。 */
    $seen=[];
    $outEv=[];
    foreach($events as $e){
        if(strcmp($e['d'],$from)<0||strcmp($e['d'],$to)>0)continue;
        $k=$e['d'].'|'.$e['kind'].'|'.$e['label'];
        if(isset($seen[$k]))continue;
        $seen[$k]=true;
        $outEv[]=$e;
    }
    usort($outEv,function($a,$b){
        $c=strcmp($a['d'],$b['d']);
        if($c)return $c;
        $c=strcmp($a['kind'],$b['kind']);
        if($c)return $c;
        return strcmp($a['label'],$b['label']);
    });
    res(200,['ok'=>true,'from'=>$from,'to'=>$to,'events'=>$outEv]);
}

// POST /plans -> agent files a new draft plan (headless runner, job type=plan)
if($m==='POST'&&$ROUTE==='/plans'){
    auth_worker();
    $i=input();
    $cid=(int)($i['client_id']??0);
    $body=(string)($i['body']??'');
    if(!$cid)res(400,['error'=>'client_id required']);
    if(trim($body)==='')res(400,['error'=>'body required']);
    $v=db()->prepare("SELECT COALESCE(MAX(version),0)+1 AS n FROM seo_plans WHERE client_id=?");
    $v->execute([$cid]);
    $ver=(int)$v->fetch()['n'];
    $s=db()->prepare("INSERT INTO seo_plans(client_id,version,body,status,authored_by)VALUES(?,?,?,'draft',?)");
    $s->execute([$cid,$ver,$body,(string)($i['authored_by']??'seo-worker')]);
    $id=(int)db()->lastInsertId();
    audit('seo-worker','seo_plan_draft',(string)$id,['client_id'=>$cid,'version'=>$ver,'bytes'=>strlen($body)]);
    res(200,['ok'=>true,'id'=>$id,'version'=>$ver]);
}

// POST /tasks/bulk -> agent files proposed tasks. All or nothing: validate the
// whole batch first, then insert in one transaction. Never half a batch.
if($m==='POST'&&$ROUTE==='/tasks/bulk'){
    auth_worker();
    $i=input();
    $cid=(int)($i['client_id']??0);
    if(!$cid)res(400,['error'=>'client_id required']);
    $pid=array_key_exists('plan_id',$i)&&$i['plan_id']?(int)$i['plan_id']:null;
    list($clean,$err)=tasks_bulk_clean($cid,$pid,$i['tasks']??null);
    if($err)res(400,['error'=>$err]);
    $p=db();
    $ids=[];
    $p->beginTransaction();
    try{
        $ids=tasks_bulk_insert($p,$clean);
        $p->commit();
    }catch(Exception $e){
        if($p->inTransaction())$p->rollBack();
        res(500,['error'=>'bulk insert failed']);
    }
    audit('seo-worker','seo_tasks_bulk',(string)$cid,['plan_id'=>$pid,'count'=>count($ids),'ids'=>$ids]);
    /* 门的选择：plan job 刚落的草稿（authored_by seo-worker）先过方案层 plan_review；
       plan_review 出的 v2 任务和没有 plan 的散任务直接进任务层 review_plan。 */
    $gate='review_plan';
    if($pid){
        $pq=db()->prepare("SELECT authored_by FROM seo_plans WHERE id=?");
        $pq->execute([$pid]);
        $pr=$pq->fetch();
        if($pr&&(string)$pr['authored_by']==='seo-worker')$gate='plan_review';
    }
    if($gate==='plan_review'){
        $rjid=queue_plan_review_job($cid,$pid,$ids,'seo-worker');
        res(200,['ok'=>true,'ids'=>$ids,'plan_review_job_id'=>$rjid,'gate'=>'plan_review']);
    }
    list($rjid,$rmerged)=queue_review_job($cid,$ids,'seo-worker','seo_tasks_review_auto');
    res(200,['ok'=>true,'ids'=>$ids,'review_job_id'=>$rjid,'gate'=>'review_plan']);
}

// GET /context?client_id= -> single briefing payload for the LLM runner
if($m==='GET'&&$ROUTE==='/context'){
    auth_worker();
    /* worker 的品牌词拆分要读 profile.brand_regex，这里保证列存在再 SELECT *。 */
    ensure_metrics_schema();
    $cid=need_client();
    $pf=db()->prepare("SELECT * FROM seo_profiles WHERE client_id=?");
    $pf->execute([$cid]);
    $profile=$pf->fetch();
    if($profile){
        $profile['target_keywords']=jdec($profile['target_keywords']);
        /* 客户名在 clients 表不在 seo_profiles，报告页眉要用，补进 profile.name（已有则不覆盖） */
        if(empty($profile['name'])){
            $cn=db()->prepare("SELECT name FROM clients WHERE id=?");
            $cn->execute([$cid]);
            $cr=$cn->fetch();
            $cn->closeCursor();
            if($cr&&!empty($cr['name']))$profile['name']=$cr['name'];
        }
    }

    $pl=db()->prepare("SELECT * FROM seo_plans WHERE client_id=? AND status='active' ORDER BY version DESC,id DESC LIMIT 1");
    $pl->execute([$cid]);
    $plan=$pl->fetch();

    $tk=db()->prepare("SELECT * FROM seo_tasks WHERE client_id=? ORDER BY FIELD(owner_type,'agent','agency','client'),FIELD(priority,'P0','P1','P2','P3'),id");
    $tk->execute([$cid]);
    $tasks=$tk->fetchAll();

    $sn=db()->prepare("SELECT s.* FROM seo_snapshots s INNER JOIN (SELECT source,MAX(id) AS mid FROM seo_snapshots WHERE client_id=? GROUP BY source) t ON s.id=t.mid");
    $sn->execute([$cid]);
    $snaps=[];
    foreach($sn->fetchAll() as $r){$r['data']=jdec($r['data']);$snaps[$r['source']]=$r;}

    $fc=db()->prepare("SELECT fact_key,value,source,status FROM seo_facts WHERE client_id=? ORDER BY fact_key");
    $fc->execute([$cid]);
    $confirmed=[];$pending=[];
    foreach($fc->fetchAll() as $f){
        if($f['status']==='confirmed')$confirmed[]=['fact_key'=>$f['fact_key'],'value'=>$f['value']];
        else $pending[]=['fact_key'=>$f['fact_key'],'value'=>$f['value'],'source'=>$f['source']];
    }

    $cl=db()->prepare("SELECT id,name FROM clients WHERE id=?");
    $cl->execute([$cid]);

    res(200,[
        'client'=>$cl->fetch()?:null,
        'profile'=>$profile?:null,
        'active_plan'=>$plan?:null,
        'tasks'=>$tasks,
        'facts'=>['confirmed'=>$confirmed,'pending'=>$pending],
        'latest_snapshots'=>$snaps?$snaps:new stdClass()
    ]);
}

/* =========================================================
   Facts: knowledge base shared by the dashboard and the runner
   ========================================================= */

// GET /facts?client_id= -> either auth layer
if($m==='GET'&&$ROUTE==='/facts'){
    auth_any();
    $cid=need_client();
    $s=db()->prepare("SELECT * FROM seo_facts WHERE client_id=? ORDER BY FIELD(status,'unconfirmed','confirmed'),fact_key");
    $s->execute([$cid]);
    res(200,['facts'=>$s->fetchAll()]);
}

// POST /facts
// worker: source forced to 'agent', status forced to 'unconfirmed', and a
//         fact a human already confirmed is left alone (skipped=true).
// worker + body.feedback_id: the facts came out of a human note, not out of a
//         model guess, so they inherit the feedback row's source (manual or
//         client), land confirmed, and may overwrite a confirmed fact.
// admin:  free choice, defaults to manual + confirmed.
// Accepts one fact, or a batch under body.facts for the discover runner.
if($m==='POST'&&$ROUTE==='/facts'){
    $a=auth_any();
    $isWorker=($a['role']==='seo_worker');
    $i=input();
    $cid=(int)($i['client_id']??0);
    if(!$cid)res(400,['error'=>'client_id required']);
    $fbRow=null;
    $fbId=(int)($i['feedback_id']??0);
    if($isWorker&&$fbId){
        ensure_feedback_schema();
        $fq=db()->prepare("SELECT id,client_id,source FROM seo_feedback WHERE id=?");
        $fq->execute([$fbId]);
        $fbRow=$fq->fetch();
        $fq->closeCursor();
        if(!$fbRow)res(404,['error'=>'Feedback not found']);
        if((int)$fbRow['client_id']!==$cid)res(400,['error'=>'Feedback belongs to another client']);
    }
    $batch=(isset($i['facts'])&&is_array($i['facts']))?array_values($i['facts']):[$i];
    if(!$batch)res(400,['error'=>'facts required']);
    if(count($batch)>50)res(400,['error'=>'batch too large, max 50 facts']);
    /* Validate the whole batch before touching the table. */
    $clean=[];
    foreach($batch as $n=>$f){
        if(!is_array($f))res(400,['error'=>"fact #$n: not an object"]);
        $key=trim((string)($f['fact_key']??''));
        if($key==='')res(400,['error'=>"fact #$n: fact_key required"]);
        if(mb_strlen($key,'UTF-8')>100)res(400,['error'=>"fact #$n: fact_key over 100 chars"]);
        if($isWorker&&$fbRow){$src=$fbRow['source'];$st='confirmed';}
        /* Agent-verified reads are facts, not guesses: the run measured them
           against the platform with delegated access, so a human re-reading
           the same dashboard adds nothing. Stored confirmed on arrival. Only
           human-origin facts (manual/client) are protected from overwrite,
           see the skip below. */
        elseif($isWorker){$src='agent';$st='confirmed';}
        else{
            $src=(string)($f['source']??($i['source']??'manual'));
            if(!in_array($src,['agent','client','manual'],true))res(400,['error'=>"fact #$n: bad source"]);
            $st=(string)($f['status']??($i['status']??'confirmed'));
            if(!in_array($st,['unconfirmed','confirmed'],true))res(400,['error'=>"fact #$n: bad status"]);
        }
        $clean[]=['key'=>$key,'value'=>(string)($f['value']??''),'source'=>$src,'status'=>$st];
    }
    $look=db()->prepare("SELECT id,status,source FROM seo_facts WHERE client_id=? AND fact_key=?");
    $upd=db()->prepare("UPDATE seo_facts SET value=?,source=?,status=?,updated_by=? WHERE id=?");
    $ins=db()->prepare("INSERT INTO seo_facts(client_id,fact_key,value,source,status,updated_by)VALUES(?,?,?,?,?,?)");
    $out=[];
    foreach($clean as $f){
        $look->execute([$cid,$f['key']]);
        $ex=$look->fetch();
        $look->closeCursor();
        /* A human said it, the agent does not get to unsay it. Agent facts
           refresh freely on re-read; manual/client facts only change through
           the feedback pipeline or an admin edit. */
        if($ex&&$isWorker&&!$fbRow&&in_array($ex['source'],['manual','client'],true)){
            $out[]=['fact_key'=>$f['key'],'id'=>(int)$ex['id'],'skipped'=>true];
            continue;
        }
        if($ex){
            $upd->execute([$f['value'],$f['source'],$f['status'],$a['username'],(int)$ex['id']]);
            $out[]=['fact_key'=>$f['key'],'id'=>(int)$ex['id'],'skipped'=>false];
        }else{
            $ins->execute([$cid,$f['key'],$f['value'],$f['source'],$f['status'],$a['username']]);
            $out[]=['fact_key'=>$f['key'],'id'=>(int)db()->lastInsertId(),'skipped'=>false];
        }
    }
    $skipped=count(array_filter($out,function($r){return $r['skipped'];}));
    audit($a['username'],'seo_fact_write',(string)$cid,['count'=>count($out),'skipped'=>$skipped,'feedback_id'=>$fbRow?$fbId:null]);
    if(!isset($i['facts'])){
        res(200,['ok'=>true,'id'=>$out[0]['id'],'skipped'=>$out[0]['skipped']]);
    }
    res(200,['ok'=>true,'results'=>$out,'skipped'=>$skipped]);
}

// PATCH /facts/{id} -> admin edits the value or confirms the fact
if($m==='PATCH'&&preg_match('#^/facts/(\d+)$#',$ROUTE,$mm)){
    $u=auth_admin();
    $fid=(int)$mm[1];
    $i=input();
    $chk=db()->prepare("SELECT id,client_id,fact_key FROM seo_facts WHERE id=?");
    $chk->execute([$fid]);
    $ex=$chk->fetch();
    if(!$ex)res(404,['error'=>'Fact not found']);
    $sets=[];$args=[];
    if(isset($i['value'])){$sets[]='value=?';$args[]=(string)$i['value'];}
    if(isset($i['status'])){
        if(!in_array($i['status'],['unconfirmed','confirmed'],true))res(400,['error'=>'bad status']);
        $sets[]='status=?';$args[]=$i['status'];
    }
    if(isset($i['source'])){
        if(!in_array($i['source'],['agent','client','manual'],true))res(400,['error'=>'bad source']);
        $sets[]='source=?';$args[]=$i['source'];
    }
    if(!$sets)res(400,['error'=>'nothing to update']);
    $sets[]='updated_by=?';$args[]=$u['username'];
    $args[]=$fid;
    db()->prepare("UPDATE seo_facts SET ".implode(',',$sets)." WHERE id=?")->execute($args);
    audit($u['username'],'seo_fact_update',(string)$fid,['client_id'=>(int)$ex['client_id'],'fact_key'=>$ex['fact_key'],'patch'=>$i]);
    res(200,['ok'=>true]);
}

/* =========================================================
   Decision inbox
   The console's chat tab. Exactly three kinds of message go through here:
   a digest the worker writes, a ruling a human writes in their own words, and
   an ack saying what was done about it. Nothing else is a message.
   The board is still the only source of truth; this is the operating surface.
   ========================================================= */

// POST /inbox -> worker writes a digest card or an ack.
// A ruling is never written here: only a person may issue one, through the
// admin endpoint below. body.resolve closes the named digest in the same call,
// which is how a successful ruling run settles the card it answered.
if($m==='POST'&&$ROUTE==='/inbox'){
    auth_worker();
    ensure_inbox_schema();
    $i=input();
    $kind=(string)($i['kind']??'');
    if(!in_array($kind,['digest','ack'],true))res(400,['error'=>'kind must be digest or ack']);
    $body=trim((string)($i['body']??''));
    if($body==='')res(400,['error'=>'body required']);
    if(mb_strlen($body,'UTF-8')>20000)res(400,['error'=>'body over 20000 chars']);
    $cid=(int)($i['client_id']??0);
    if($cid){
        $c=db()->prepare("SELECT id FROM clients WHERE id=?");
        $c->execute([$cid]);
        if(!$c->fetch())res(404,['error'=>'Client not found']);
    }
    $reply=(int)($i['reply_to']??0);
    if($reply){
        $r=db()->prepare("SELECT id FROM seo_inbox WHERE id=?");
        $r->execute([$reply]);
        if(!$r->fetch())res(404,['error'=>'reply_to row not found']);
    }
    $refs=inbox_refs_filter(inbox_refs_norm($i['refs']??null),$cid);
    /* A digest is the only thing that can want a human, so it is the only thing
       that lands open. */
    $status=($kind==='digest')?'open':'resolved';
    db()->prepare("INSERT INTO seo_inbox(client_id,kind,body,refs,reply_to,status,created_by)VALUES(?,?,?,?,?,?,'seo-worker')")
        ->execute([$cid?:null,$kind,$body,json_encode($refs,JSON_UNESCAPED_UNICODE),$reply?:null,$status]);
    $id=(int)db()->lastInsertId();
    $resolved=0;
    if(!empty($i['resolve'])){
        $rid=(int)$i['resolve'];
        $q=db()->prepare("UPDATE seo_inbox SET status='resolved' WHERE id=? AND kind='digest'");
        $q->execute([$rid]);
        $resolved=$q->rowCount();
    }
    audit('seo-worker','seo_inbox_write',(string)$id,[
        'kind'=>$kind,'client_id'=>$cid?:null,'reply_to'=>$reply?:null,
        'tasks'=>count($refs['tasks']),'resolved'=>$resolved
    ]);
    res(200,['ok'=>true,'id'=>$id,'resolved'=>$resolved]);
}

// POST /inbox/{id}/actions -> the ruling runner submits what it read out of one
// human ruling, and the server is what executes it.
// The split is the point. The model never touches a task: it proposes a list,
// and every item is checked here against a fixed whitelist and against the
// digest's own refs, so a ruling can only ever move something the card it
// answers already named. An unknown action type, or an id outside that scope,
// is refused and reported back so the ack can tell the human it was refused.
// One failed action does not abort the batch; each one reports for itself.
if($m==='POST'&&preg_match('#^/inbox/(\d+)/actions$#',$ROUTE,$mm)){
    auth_worker();
    ensure_inbox_schema();
    $did=(int)$mm[1];
    $i=input();
    $g=db()->prepare("SELECT * FROM seo_inbox WHERE id=?");
    $g->execute([$did]);
    $dg=$g->fetch();
    if(!$dg)res(404,['error'=>'Inbox item not found']);
    if($dg['kind']!=='digest')res(400,['error'=>'Not a digest']);
    $rid=(int)($i['ruling_id']??0);
    if(!$rid)res(400,['error'=>'ruling_id required']);
    $rq=db()->prepare("SELECT id,kind,reply_to,created_by FROM seo_inbox WHERE id=?");
    $rq->execute([$rid]);
    $rr=$rq->fetch();
    if(!$rr||$rr['kind']!=='ruling'||(int)$rr['reply_to']!==$did){
        res(400,['error'=>'ruling_id does not belong to this digest']);
    }
    /* Everything below is attributed to whoever wrote the ruling, not to the
       worker that carried it. A fact filed this way came out of a person's
       sentence, and the board should say so. */
    $by=(string)($rr['created_by']?:'seo-worker');
    $acts=$i['actions']??null;
    if(!is_array($acts))res(400,['error'=>'actions required']);
    if(count($acts)>20)res(400,['error'=>'too many actions, max 20']);

    $refs=inbox_refs_norm($dg['refs']);
    $scope=[];
    foreach($refs['tasks'] as $t)$scope[$t]=true;
    $digestClient=($dg['client_id']===null)?0:(int)$dg['client_id'];

    /* Every task an action names has to be inside the digest's refs and has to
       exist. Both checks live here, never in the runner. */
    $pick=function($tid)use($scope){
        $tid=(int)$tid;
        if(!$tid)return ['err'=>'没有给出 task_id'];
        if(!isset($scope[$tid]))return ['err'=>'任务 #'.$tid.' 不在这张卡片涉及的任务范围内，已拒绝'];
        $q=db()->prepare("SELECT * FROM seo_tasks WHERE id=?");
        $q->execute([$tid]);
        $t=$q->fetch();
        if(!$t)return ['err'=>'任务 #'.$tid.' 已经不存在'];
        return ['task'=>$t];
    };
    /* Same for a batch, plus the rule that one batch is one client's work. */
    $pickMany=function($ids)use($pick){
        if(!is_array($ids)||!$ids)return ['err'=>'没有给出 task_ids'];
        if(count($ids)>50)return ['err'=>'一次最多 50 个任务'];
        $tasks=[];$cid=0;
        foreach($ids as $x){
            $r=$pick($x);
            if(isset($r['err']))return ['err'=>$r['err']];
            $t=$r['task'];
            if(!$cid)$cid=(int)$t['client_id'];
            elseif($cid!==(int)$t['client_id'])return ['err'=>'这一批任务不属于同一个客户，已拒绝'];
            $tasks[]=$t;
        }
        return ['tasks'=>$tasks,'client_id'=>$cid];
    };
    $appendNote=function($tid,$note){
        $note=trim((string)$note);
        if($note==='')return;
        db()->prepare("UPDATE seo_tasks SET result_note=CONCAT_WS('\n',NULLIF(result_note,''),?) WHERE id=?")
            ->execute([mb_substr($note,0,1000,'UTF-8'),$tid]);
    };

    $results=[];
    $okCount=0;
    foreach(array_values($acts) as $n=>$a){
        $type=is_array($a)?(string)($a['type']??''):'';
        $out=['n'=>$n+1,'type'=>$type,'ok'=>false,'message'=>''];
        if(!in_array($type,INBOX_ACTIONS,true)){
            $out['message']='不认识的动作类型「'.mb_substr($type===''?'(空)':$type,0,40,'UTF-8').'」，白名单外，未执行';
            $results[]=$out;
            continue;
        }
        if($type==='noop'){
            $note=trim((string)($a['note']??''));
            $out['ok']=true;
            $out['message']='仅知悉，没有改动任何东西'.($note!==''?('：'.mb_substr($note,0,200,'UTF-8')):'');
            $results[]=$out;$okCount++;
            continue;
        }
        if($type==='approve_task'){
            $r=$pick($a['task_id']??0);
            if(isset($r['err'])){$out['message']=$r['err'];$results[]=$out;continue;}
            $t=$r['task'];
            db()->prepare("UPDATE seo_tasks SET status='approved' WHERE id=?")->execute([(int)$t['id']]);
            $out['ok']=true;
            $out['message']='任务 #'.$t['id'].'「'.$t['title'].'」已从 '.$t['status'].' 置为 approved';
            $results[]=$out;$okCount++;
            continue;
        }
        if($type==='reject_task'){
            $r=$pick($a['task_id']??0);
            if(isset($r['err'])){$out['message']=$r['err'];$results[]=$out;continue;}
            $t=$r['task'];
            $mode=(string)($a['mode']??'blocked');
            if(!in_array($mode,['blocked','proposed'],true)){
                $out['message']='reject_task 的 mode 只能是 blocked 或 proposed，收到「'.mb_substr($mode,0,20,'UTF-8').'」，未执行';
                $results[]=$out;continue;
            }
            db()->prepare("UPDATE seo_tasks SET status=? WHERE id=?")->execute([$mode,(int)$t['id']]);
            $note=trim((string)($a['note']??''));
            if($note!=='')$appendNote((int)$t['id'],'[裁决] 打回：'.$note);
            $out['ok']=true;
            $out['message']='任务 #'.$t['id'].'「'.$t['title'].'」已打回为 '.$mode.($note!==''?('，理由已记进结果备注'):'');
            $results[]=$out;$okCount++;
            continue;
        }
        if($type==='set_priority'){
            $r=$pick($a['task_id']??0);
            if(isset($r['err'])){$out['message']=$r['err'];$results[]=$out;continue;}
            $t=$r['task'];
            $pri=(string)($a['priority']??'');
            if(!in_array($pri,['P0','P1','P2','P3'],true)){
                $out['message']='优先级只能是 P0 到 P3，收到「'.mb_substr($pri,0,20,'UTF-8').'」，未执行';
                $results[]=$out;continue;
            }
            db()->prepare("UPDATE seo_tasks SET priority=? WHERE id=?")->execute([$pri,(int)$t['id']]);
            $out['ok']=true;
            $out['message']='任务 #'.$t['id'].' 优先级从 '.$t['priority'].' 改成 '.$pri;
            $results[]=$out;$okCount++;
            continue;
        }
        if($type==='set_sprint'){
            $r=$pick($a['task_id']??0);
            if(isset($r['err'])){$out['message']=$r['err'];$results[]=$out;continue;}
            $t=$r['task'];
            $sp=trim((string)($a['sprint']??''));
            if(mb_strlen($sp,'UTF-8')>10){
                $out['message']='sprint 最多 10 个字符，未执行';
                $results[]=$out;continue;
            }
            db()->prepare("UPDATE seo_tasks SET sprint=? WHERE id=?")->execute([$sp,(int)$t['id']]);
            $out['ok']=true;
            $out['message']='任务 #'.$t['id'].' 的 sprint 从「'.($t['sprint']?:'空').'」改成「'.($sp?:'空').'」';
            $results[]=$out;$okCount++;
            continue;
        }
        if($type==='kill_task'){
            $r=$pick($a['task_id']??0);
            if(isset($r['err'])){$out['message']=$r['err'];$results[]=$out;continue;}
            $t=$r['task'];
            $reason=trim((string)($a['reason']??''));
            if($reason===''){
                $out['message']='kill_task 必须写清为什么不做了，没有理由，未执行';
                $results[]=$out;continue;
            }
            $err=task_close((int)$t['id'],'killed','人工裁决不再做：'.$reason);
            if($err){$out['message']=$err;$results[]=$out;continue;}
            $out['ok']=true;
            $out['message']='任务 #'.$t['id'].'「'.$t['title'].'」已按不做处理，置 done 并在结果备注写明原因';
            $results[]=$out;$okCount++;
            continue;
        }
        if($type==='release_tasks'){
            $r=$pickMany($a['task_ids']??null);
            if(isset($r['err'])){$out['message']=$r['err'];$results[]=$out;continue;}
            $bad=null;
            foreach($r['tasks'] as $t){if($t['status']!=='review'){$bad=$t;break;}}
            if($bad){
                $out['message']='任务 #'.$bad['id'].' 现在是 '.$bad['status'].'，不在 review，整批未放行';
                $results[]=$out;continue;
            }
            $cid=(int)$r['client_id'];
            $dup=db()->prepare("SELECT id FROM agent_jobs WHERE client_id=? AND type='apply_task' AND status IN('queued','running') LIMIT 1");
            $dup->execute([$cid]);
            $d=$dup->fetch();
            if($d){
                $out['message']='该客户已经有一个落地 job（#'.$d['id'].'）在跑，这次没有重复排队，等它跑完再放行';
                $results[]=$out;continue;
            }
            $ids=array_map(function($t){return (int)$t['id'];},$r['tasks']);
            db()->prepare("INSERT INTO agent_jobs(client_id,type,payload,status,created_by)VALUES(?,'apply_task',?,'queued',?)")
                ->execute([$cid,json_encode(['task_ids'=>$ids],JSON_UNESCAPED_UNICODE),$by]);
            $jid=(int)db()->lastInsertId();
            fire_wake($jid);
            $out['ok']=true;
            $out['message']='已放行 '.count($ids).' 个任务（#'.implode('、#',$ids).'），排了落地 job #'.$jid;
            $results[]=$out;$okCount++;
            continue;
        }
        if($type==='redispatch'){
            $r=$pickMany($a['task_ids']??null);
            if(isset($r['err'])){$out['message']=$r['err'];$results[]=$out;continue;}
            $reason=trim((string)($a['reason']??''));
            if($reason===''){
                $out['message']='redispatch 必须带上新指令，没有指令等于重跑一遍，未执行';
                $results[]=$out;continue;
            }
            $cid=(int)$r['client_id'];
            $dup=db()->prepare("SELECT id FROM agent_jobs WHERE client_id=? AND type='execute_task' AND status IN('queued','running') LIMIT 1");
            $dup->execute([$cid]);
            $d=$dup->fetch();
            if($d){
                $out['message']='该客户已经有一个执行 job（#'.$d['id'].'）在跑，这次没有重复排队';
                $results[]=$out;continue;
            }
            $ids=array_map(function($t){return (int)$t['id'];},$r['tasks']);
            $payload=json_encode(['task_ids'=>$ids,'reason'=>mb_substr($reason,0,500,'UTF-8')],JSON_UNESCAPED_UNICODE);
            db()->prepare("INSERT INTO agent_jobs(client_id,type,payload,status,created_by)VALUES(?,'execute_task',?,'queued',?)")
                ->execute([$cid,$payload,$by]);
            $jid=(int)db()->lastInsertId();
            fire_wake($jid);
            $out['ok']=true;
            $out['message']='已带新指令重派 '.count($ids).' 个任务（#'.implode('、#',$ids).'），排了执行 job #'.$jid;
            $results[]=$out;$okCount++;
            continue;
        }
        if($type==='answer_fact'){
            $key=trim((string)($a['fact_key']??''));
            $val=trim((string)($a['value']??''));
            if($key===''||mb_strlen($key,'UTF-8')>100){
                $out['message']='fact_key 为空或超过 100 字符，未执行';
                $results[]=$out;continue;
            }
            if($val===''){
                $out['message']='fact「'.$key.'」没有值，未执行';
                $results[]=$out;continue;
            }
            /* A cross client card has no client of its own, so the fact is
               filed against the client its refs point at, and only when they
               all point at the same one. */
            $cid=$digestClient;
            if(!$cid){
                $tasks=inbox_ref_tasks($refs);
                foreach($tasks as $t){
                    if(!$cid)$cid=(int)$t['client_id'];
                    elseif($cid!==(int)$t['client_id']){$cid=-1;break;}
                }
            }
            if($cid<=0){
                $out['message']='这张卡片跨了多个客户，说不清这条 fact 该记给谁，未执行，请到档案页手工添加';
                $results[]=$out;continue;
            }
            $look=db()->prepare("SELECT id FROM seo_facts WHERE client_id=? AND fact_key=?");
            $look->execute([$cid,$key]);
            $ex=$look->fetch();
            $look->closeCursor();
            if($ex){
                db()->prepare("UPDATE seo_facts SET value=?,source='manual',status='confirmed',updated_by=? WHERE id=?")
                    ->execute([$val,$by,(int)$ex['id']]);
                $out['message']='fact「'.$key.'」已更新为「'.mb_substr($val,0,120,'UTF-8').'」（人工确认）';
            }else{
                db()->prepare("INSERT INTO seo_facts(client_id,fact_key,value,source,status,updated_by)VALUES(?,?,?,'manual','confirmed',?)")
                    ->execute([$cid,$key,$val,$by]);
                $out['message']='fact「'.$key.'」已新建为「'.mb_substr($val,0,120,'UTF-8').'」（人工确认）';
            }
            $out['ok']=true;
            $results[]=$out;$okCount++;
            continue;
        }
    }
    audit('seo-worker','seo_inbox_actions',(string)$did,[
        'ruling_id'=>$rid,'count'=>count($results),'ok'=>$okCount,
        'types'=>array_map(function($r){return $r['type'].($r['ok']?'':'(拒绝)');},$results)
    ]);
    res(200,['ok'=>true,'results'=>$results,'ok_count'=>$okCount]);
}

// GET /inbox/{id} -> one row, its replies, and the task rows its refs point at.
// Either auth layer: the console reads it for a permalink, and the ruling
// runner reads exactly the two rows plus the task states it is allowed to
// reason about, instead of being handed a cross client read.
if($m==='GET'&&preg_match('#^/inbox/(\d+)$#',$ROUTE,$mm)){
    auth_any();
    ensure_inbox_schema();
    $id=(int)$mm[1];
    $s=db()->prepare("SELECT i.*,c.name AS client_name FROM seo_inbox i LEFT JOIN clients c ON c.id=i.client_id WHERE i.id=?");
    $s->execute([$id]);
    $row=$s->fetch();
    if(!$row)res(404,['error'=>'Inbox item not found']);
    $item=inbox_row_out($row);
    /* 线程取两层：挂在 digest 下的 ruling，加挂在这些 ruling 下的 ack。
       对话只有一层（chat_user / chat_agent 全部 reply_to 指根），被这条查询
       的第一层完全覆盖，按 id 升序出来就是聊天记录的原始顺序。 */
    $rp=db()->prepare("SELECT * FROM seo_inbox WHERE reply_to=? OR reply_to IN (SELECT id FROM (SELECT id FROM seo_inbox WHERE reply_to=?) x) ORDER BY id");
    $rp->execute([$id,$id]);
    $replies=[];
    foreach($rp->fetchAll() as $r)$replies[]=inbox_row_out($r);
    $out=['item'=>$item,'replies'=>$replies,'ref_tasks'=>inbox_ref_tasks($item['refs'])];
    /* 会话根多带一个「有没有 chat job 在跑」，前端拿它显示「思考中」，
       省掉一次 /jobs 轮询。 */
    if($item['kind']==='chat_root')$out['chat_pending']=chat_job_inflight($id);
    res(200,$out);
}

// GET /inbox?client_id=&status=&limit= -> the stream, newest first.
// client_id narrows to one client and always keeps the cross client cards:
// a card filed against nobody in particular can still be about this client's
// tasks, and hiding it would hide a decision somebody has to make.
if($m==='GET'&&$ROUTE==='/inbox'){
    auth_admin();
    ensure_inbox_schema();
    $lim=(int)($_GET['limit']??60);
    if($lim<1)$lim=60;
    if($lim>200)$lim=200;
    /* 决策流里不掺对话消息。对话是另一条线（GET /inbox/chats），而且
       chat_user / chat_agent 的父行很容易被 limit 截掉，混进来就是一堆
       挂不上线程的碎片。 */
    $chatIn=implode(',',array_map(function($k){return "'".$k."'";},CHAT_KINDS));
    $where=["i.kind NOT IN ($chatIn)"];$args=[];
    if(isset($_GET['client_id'])&&$_GET['client_id']!==''){
        $cid=(int)$_GET['client_id'];
        if($cid>0){$where[]='(i.client_id=? OR i.client_id IS NULL)';$args[]=$cid;}
    }
    if(isset($_GET['status'])&&$_GET['status']!==''){
        $st=(string)$_GET['status'];
        if(!in_array($st,['open','resolved'],true))res(400,['error'=>'bad status']);
        $where[]='i.status=?';$args[]=$st;
    }
    $sql="SELECT i.*,c.name AS client_name FROM seo_inbox i LEFT JOIN clients c ON c.id=i.client_id"
        .' WHERE '.implode(' AND ',$where)
        ." ORDER BY i.id DESC LIMIT $lim";
    $s=db()->prepare($sql);
    $s->execute($args);
    $items=[];
    foreach($s->fetchAll() as $r)$items[]=inbox_row_out($r);
    $oc=db()->query("SELECT COUNT(*) AS n FROM seo_inbox WHERE kind='digest' AND status='open'")->fetch();
    res(200,['items'=>$items,'open_count'=>(int)$oc['n']]);
}

// POST /inbox/{id}/ruling -> a human answers one digest in their own words.
// The text is stored verbatim and a ruling job is queued to read it. Nothing is
// parsed here: the whole design is that a person writes a sentence and the
// runner is what turns it into board actions, under the whitelist above.
// A ruling on an already settled digest reopens it, so a correction does not
// need a fresh card to land on.
if($m==='POST'&&preg_match('#^/inbox/(\d+)/ruling$#',$ROUTE,$mm)){
    $u=auth_admin();
    ensure_inbox_schema();
    ensure_job_types();
    $did=(int)$mm[1];
    $i=input();
    $g=db()->prepare("SELECT * FROM seo_inbox WHERE id=?");
    $g->execute([$did]);
    $dg=$g->fetch();
    if(!$dg)res(404,['error'=>'Inbox item not found']);
    if($dg['kind']!=='digest')res(400,['error'=>'Only a digest can be ruled on']);
    $text=trim((string)($i['text']??''));
    if($text==='')res(400,['error'=>'text required']);
    if(mb_strlen($text,'UTF-8')>5000)res(400,['error'=>'text over 5000 chars']);
    /* Guard against a double submit landing two runs on one card. Payload shape
       is written right below and never changes, so the needle is stable. */
    $dup=db()->prepare("SELECT id FROM agent_jobs WHERE type='ruling' AND status IN('queued','running') AND payload LIKE ? LIMIT 1");
    $dup->execute(['%"inbox_id":'.$did.',%']);
    $d=$dup->fetch();
    if($d)res(409,['error'=>'这张卡片已经有一条裁决在处理中','job_id'=>(int)$d['id']]);

    $refs=inbox_refs_norm($dg['refs']);
    $cid=($dg['client_id']===null)?0:(int)$dg['client_id'];
    /* agent_jobs.client_id is NOT NULL with a foreign key, so a cross client
       card has to borrow a client to queue under. The refs are the only honest
       source for that, and they have to agree. */
    if(!$cid){
        foreach(inbox_ref_tasks($refs) as $t){
            if(!$cid)$cid=(int)$t['client_id'];
            elseif($cid!==(int)$t['client_id']){$cid=-1;break;}
        }
        if($cid<=0){
            res(400,['error'=>'这张卡片跨了多个客户，裁决 job 没法归属，请直接手动关卡或到对应客户的看板处理']);
        }
    }
    db()->prepare("INSERT INTO seo_inbox(client_id,kind,body,refs,reply_to,status,created_by)VALUES(?,'ruling',?,?,?,'resolved',?)")
        ->execute([($dg['client_id']===null)?null:(int)$dg['client_id'],$text,json_encode($refs,JSON_UNESCAPED_UNICODE),$did,$u['username']]);
    $rid=(int)db()->lastInsertId();
    if($dg['status']!=='open'){
        db()->prepare("UPDATE seo_inbox SET status='open' WHERE id=?")->execute([$did]);
    }
    $payload=json_encode(['inbox_id'=>$did,'ruling_id'=>$rid],JSON_UNESCAPED_UNICODE);
    db()->prepare("INSERT INTO agent_jobs(client_id,type,payload,status,created_by)VALUES(?,'ruling',?,'queued',?)")
        ->execute([$cid,$payload,$u['username']]);
    $jid=(int)db()->lastInsertId();
    audit($u['username'],'seo_inbox_ruling',(string)$did,[
        'ruling_id'=>$rid,'job_id'=>$jid,'client_id'=>$cid,'chars'=>mb_strlen($text,'UTF-8')
    ]);
    fire_wake($jid);
    res(200,['ok'=>true,'ruling_id'=>$rid,'job_id'=>$jid]);
}

// POST /inbox/{id}/resolve -> close a digest by hand, or archive a chat session.
// The fallback for a card nobody needs to act on, or one the runner could not
// make sense of. Writes an ack so the thread still reads in order.
// A chat_root takes the same route: archiving a session is the same act, close
// the thread and leave a line saying who closed it.
if($m==='POST'&&preg_match('#^/inbox/(\d+)/resolve$#',$ROUTE,$mm)){
    $u=auth_admin();
    ensure_inbox_schema();
    $did=(int)$mm[1];
    $i=input();
    $g=db()->prepare("SELECT id,kind,client_id,status FROM seo_inbox WHERE id=?");
    $g->execute([$did]);
    $dg=$g->fetch();
    if(!$dg)res(404,['error'=>'Inbox item not found']);
    if(!in_array($dg['kind'],['digest','chat_root'],true))res(400,['error'=>'Only a digest or a chat session can be resolved']);
    $note=trim((string)($i['note']??''));
    if(mb_strlen($note,'UTF-8')>2000)res(400,['error'=>'note over 2000 chars']);
    if($dg['kind']==='chat_root'){
        db()->prepare("UPDATE seo_inbox SET status='resolved' WHERE id=?")->execute([$did]);
        $body='会话已归档，归档人 '.$u['username'].'。'.($note!==''?('备注：'.$note):'');
        chat_msg_insert($dg,'chat_agent',$body,$u['username']);
        audit($u['username'],'seo_chat_archive',(string)$did,['note'=>$note]);
        res(200,['ok'=>true]);
    }
    db()->prepare("UPDATE seo_inbox SET status='resolved' WHERE id=?")->execute([$did]);
    $body='人工关卡：'.$u['username'].' 直接把这张卡片标记为已处理，没有派任何动作。'.($note!==''?('备注：'.$note):'');
    db()->prepare("INSERT INTO seo_inbox(client_id,kind,body,refs,reply_to,status,created_by)VALUES(?,'ack',?,NULL,?,'resolved',?)")
        ->execute([($dg['client_id']===null)?null:(int)$dg['client_id'],$body,$did,$u['username']]);
    audit($u['username'],'seo_inbox_resolve',(string)$did,['note'=>$note]);
    res(200,['ok'=>true]);
}

/* =========================================================
   收件箱对话
   人在工作台按客户跟 opus 聊：问数据、聊博客规划、讨论素材怎么更新。
   聊天是界面，看板是账本。

   铁律，这一段所有路由都在守它：对话是任务编译器，不是执行器。
   模型在会话里只读加提议，它的输出只有两样东西可以落下来，
   一是 chat_agent 行的正文，二是存在那行 refs.drafts 里的任务草案。
   草案不是任务。唯一把东西写进看板的口子是 POST /inbox/{root}/spawn_task，
   那是人看完草案点了「立项」才会走的一次 admin 请求，字段校验和人工建任务
   完全同一个函数。放行闸门一个都没绕开，也不许绕。
   ========================================================= */

// GET /inbox/chats?client_id=&status=&limit= -> 会话列表，最近的在前。
// 每行是一个会话根，带上消息条数、最后一条消息的时间和摘要，够画列表了。
// 放在 GET /inbox/{id} 前面无所谓，那条是 (\d+)，chats 落不进去，
// 但顺序上摆在一起更好读。
if($m==='GET'&&$ROUTE==='/inbox/chats'){
    auth_admin();
    ensure_inbox_schema();
    $lim=(int)($_GET['limit']??50);
    if($lim<1)$lim=50;
    if($lim>200)$lim=200;
    $where=["i.kind='chat_root'"];$args=[];
    if(isset($_GET['client_id'])&&$_GET['client_id']!==''){
        $cid=(int)$_GET['client_id'];
        if($cid>0){$where[]='i.client_id=?';$args[]=$cid;}
    }
    if(isset($_GET['status'])&&$_GET['status']!==''){
        $st=(string)$_GET['status'];
        if(!in_array($st,['open','resolved'],true))res(400,['error'=>'bad status']);
        $where[]='i.status=?';$args[]=$st;
    }
    $sql="SELECT i.*,c.name AS client_name FROM seo_inbox i LEFT JOIN clients c ON c.id=i.client_id"
        .' WHERE '.implode(' AND ',$where)
        ." ORDER BY i.id DESC LIMIT $lim";
    $s=db()->prepare($sql);
    $s->execute($args);
    $rows=$s->fetchAll();
    $ids=[];
    foreach($rows as $r)$ids[]=(int)$r['id'];
    /* 一次查完所有会话的消息统计，别按会话逐条打点。 */
    $stat=[];
    if($ids){
        $in=implode(',',array_fill(0,count($ids),'?'));
        $q=db()->prepare("SELECT reply_to,COUNT(*) AS n,MAX(created_at) AS t,MAX(id) AS last_id FROM seo_inbox WHERE reply_to IN ($in) GROUP BY reply_to");
        $q->execute($ids);
        foreach($q->fetchAll() as $r)$stat[(int)$r['reply_to']]=$r;
        $lastIds=[];
        foreach($stat as $r)$lastIds[]=(int)$r['last_id'];
        if($lastIds){
            $in2=implode(',',array_fill(0,count($lastIds),'?'));
            $q2=db()->prepare("SELECT id,reply_to,kind,body FROM seo_inbox WHERE id IN ($in2)");
            $q2->execute($lastIds);
            foreach($q2->fetchAll() as $r){
                $rid=(int)$r['reply_to'];
                if(isset($stat[$rid])){
                    $stat[$rid]['last_kind']=$r['kind'];
                    $stat[$rid]['last_body']=mb_substr(trim((string)$r['body']),0,120,'UTF-8');
                }
            }
        }
    }
    $items=[];
    foreach($rows as $r){
        $row=inbox_row_out($r);
        $id=$row['id'];
        $row['msg_count']=isset($stat[$id])?(int)$stat[$id]['n']:0;
        $row['last_at']=isset($stat[$id])?$stat[$id]['t']:$row['created_at'];
        $row['last_kind']=isset($stat[$id]['last_kind'])?$stat[$id]['last_kind']:null;
        $row['last_body']=isset($stat[$id]['last_body'])?$stat[$id]['last_body']:'';
        $items[]=$row;
    }
    res(200,['items'=>$items]);
}

// POST /inbox/chat -> 开一个新会话。
// body { client_id, title?, text }，一次请求做三件事：建根、写第一条人消息、
// 排 chat job。标题不给就从第一句话截一段，人懒得起名是常态。
if($m==='POST'&&$ROUTE==='/inbox/chat'){
    $u=auth_admin();
    ensure_inbox_schema();
    ensure_job_types();
    $i=input();
    $cid=(int)($i['client_id']??0);
    if(!$cid)res(400,['error'=>'client_id required']);
    $c=db()->prepare("SELECT id,name FROM clients WHERE id=?");
    $c->execute([$cid]);
    $client=$c->fetch();
    if(!$client)res(404,['error'=>'Client not found']);
    $text=trim((string)($i['text']??''));
    if($text==='')res(400,['error'=>'text required']);
    if(mb_strlen($text,'UTF-8')>5000)res(400,['error'=>'text over 5000 chars']);
    $title=trim((string)($i['title']??''));
    if($title==='')$title=mb_substr($text,0,60,'UTF-8');
    if(mb_strlen($title,'UTF-8')>200)$title=mb_substr($title,0,200,'UTF-8');
    db()->prepare("INSERT INTO seo_inbox(client_id,kind,body,refs,reply_to,status,created_by)VALUES(?,'chat_root',?,NULL,NULL,'open',?)")
        ->execute([$cid,$title,$u['username']]);
    $rootId=(int)db()->lastInsertId();
    $root=['id'=>$rootId,'client_id'=>$cid];
    $msgId=chat_msg_insert($root,'chat_user',$text,$u['username']);
    $jid=chat_job_queue($root,$msgId,$u['username']);
    audit($u['username'],'seo_chat_open',(string)$rootId,[
        'client_id'=>$cid,'job_id'=>$jid,'message_id'=>$msgId,'chars'=>mb_strlen($text,'UTF-8')
    ]);
    res(200,['ok'=>true,'root_id'=>$rootId,'message_id'=>$msgId,'job_id'=>$jid,'title'=>$title]);
}

// POST /inbox/{root_id}/chat -> 在已有会话里再说一句。
// 同一个会话已经有 job 在跑时直接 409：一次一轮，人等回复再说下一句，
// 两句并发进来模型看到的历史是半截的，回复只会更差。
if($m==='POST'&&preg_match('#^/inbox/(\d+)/chat$#',$ROUTE,$mm)){
    $u=auth_admin();
    ensure_inbox_schema();
    ensure_job_types();
    $rootId=(int)$mm[1];
    $root=chat_root_or_die($rootId,true);
    $i=input();
    $text=trim((string)($i['text']??''));
    if(mb_strlen($text,'UTF-8')>5000)res(400,['error'=>'text over 5000 chars']);
    /* 截图与来源标记只在任务线程里有意义（走反馈那套校验与存储）。 */
    $rootRefs=inbox_refs_norm($root['refs']);
    $imgs=[];
    if($rootRefs['tasks']&&isset($i['images'])&&is_array($i['images'])){
        foreach($i['images'] as $n){
            $n=(string)$n;
            if(!fb_name_ok($n))res(400,['error'=>'bad image name']);
            if(!is_file(fb_path($n)))res(400,['error'=>'Image no longer on disk: '.$n]);
            if(!in_array($n,$imgs,true))$imgs[]=$n;
        }
        if(count($imgs)>$FEEDBACK_MAX_IMAGES)res(400,['error'=>'too many images, max '.$FEEDBACK_MAX_IMAGES]);
    }
    $src=(isset($i['source'])&&$i['source']==='client')?'client':'manual';
    if($text===''&&!$imgs)res(400,['error'=>'text required']);
    $busy=chat_job_inflight($rootId);
    if($busy)res(409,['error'=>'这个会话还在等上一条回复','job_id'=>$busy]);
    $msgRefs=($imgs||$src==='client')?['images'=>$imgs,'source'=>$src]:null;
    $msgId=chat_msg_insert($root,'chat_user',$text===''?'（见截图）':$text,$u['username'],$msgRefs);
    $jid=chat_job_queue($root,$msgId,$u['username']);
    /* 任务线程：人说的每一句同时投一条反馈走 feedback job 抽 facts。线程是反馈的容器，
       学习回路不因为换了界面而断。 */
    $fbId=0;
    if($rootRefs['tasks']){
        ensure_feedback_schema();
        $ftid=(int)$rootRefs['tasks'][0];
        db()->prepare("INSERT INTO seo_feedback(client_id,task_id,source,`text`,images,status,created_by)VALUES(?,?,?,?,?,'pending',?)")
            ->execute([(int)$root['client_id'],$ftid,$src,$text,$imgs?json_encode($imgs):null,$u['username']]);
        $fbId=(int)db()->lastInsertId();
        $fpayload=json_encode(['task_id'=>$ftid,'feedback_id'=>$fbId,'source'=>$src,'text'=>$text,'images'=>$imgs,'complete_on_parse'=>false],JSON_UNESCAPED_UNICODE);
        db()->prepare("INSERT INTO agent_jobs(client_id,type,payload,status,created_by)VALUES(?,'feedback',?,'queued',?)")
            ->execute([(int)$root['client_id'],$fpayload,$u['username']]);
        $fjid=(int)db()->lastInsertId();
        db()->prepare("UPDATE seo_feedback SET job_id=? WHERE id=?")->execute([$fjid,$fbId]);
    }
    audit($u['username'],'seo_chat_say',(string)$rootId,[
        'job_id'=>$jid,'message_id'=>$msgId,'chars'=>mb_strlen($text,'UTF-8'),'feedback_id'=>$fbId
    ]);
    res(200,['ok'=>true,'message_id'=>$msgId,'job_id'=>$jid,'feedback_id'=>$fbId]);
}

// POST /inbox/{root_id}/chat_reply -> chat runner 回写一条 opus 回复。
// worker 层，唯一能写 chat_agent 正文的入口。
// body { body, drafts?[] }。drafts 是任务草案，原样存进这一行的 refs.drafts，
// 服务端只做字段规整，不建任何任务：草案是给人看的卡片，不是账本上的一行。
if($m==='POST'&&preg_match('#^/inbox/(\d+)/chat_reply$#',$ROUTE,$mm)){
    auth_worker();
    ensure_inbox_schema();
    $rootId=(int)$mm[1];
    /* 归档过的会话也允许回写：人可能在 job 跑的时候顺手归档了，
       把已经算完的回复丢掉比留着更糟。 */
    $root=chat_root_or_die($rootId,false);
    $i=input();
    $body=trim((string)($i['body']??''));
    if($body==='')res(400,['error'=>'body required']);
    if(mb_strlen($body,'UTF-8')>20000)res(400,['error'=>'body over 20000 chars']);
    $drafts=inbox_drafts_norm($i['drafts']??null);
    $raw=is_array($i['drafts']??null)?count($i['drafts']):0;
    /* actions 只在任务线程里有意义：根没挂任务的会话，提议的动作没有对象，丢掉。 */
    $rootRefs=inbox_refs_norm($root['refs']);
    $actions=$rootRefs['tasks']?inbox_actions_norm($i['actions']??null):[];
    $msgId=chat_msg_insert($root,'chat_agent',$body,'seo-worker',['drafts'=>$drafts,'actions'=>$actions]);
    /* 任务线程的自动执行：白名单里的看板层动作在回复落库的同一刻执行，系统行记账，
       前端看到的就是「已执行」。release 留卡给人点。指令来源是人在线程里说的话，
       模型只是把它翻译成动作，和裁决 runner 一个道理。 */
    $executed=[];
    if($actions&&$rootRefs['tasks']){
        ensure_review_schema();
        $tq=db()->prepare("SELECT * FROM seo_tasks WHERE id=?");
        $tq->execute([(int)$rootRefs['tasks'][0]]);
        $t=$tq->fetch();
        if($t){
            foreach($actions as $idx=>$a){
                if(!in_array($a['type'],THREAD_AUTO_ACTIONS,true))continue;
                $r=thread_action_exec($root,$t,$a,'seo-worker');
                $line='已执行提议 '.$msgId.'/'.$idx.'：'.$r['what'].'。'.($r['ok']?'':'（未执行）');
                if(!$r['ok'])$line='提议 '.$msgId.'/'.$idx.' 未执行：'.$r['what'].'。';
                chat_msg_insert($root,'chat_agent',$line,'seo-worker',['tasks'=>[(int)$t['id']]]);
                $executed[]=['idx'=>$idx,'type'=>$a['type'],'ok'=>$r['ok'],'what'=>$r['what']];
                /* 同一轮里后面的动作要看到前面改过的状态 */
                $tq->execute([(int)$t['id']]);$t=$tq->fetch();
            }
        }
    }
    audit('seo-worker','seo_chat_reply',(string)$rootId,[
        'message_id'=>$msgId,'chars'=>mb_strlen($body,'UTF-8'),
        'drafts'=>count($drafts),'drafts_dropped'=>max(0,$raw-count($drafts)),'actions'=>count($actions),'executed'=>$executed
    ]);
    res(200,['ok'=>true,'message_id'=>$msgId,'drafts'=>count($drafts),'actions'=>count($actions),'executed'=>$executed]);
}

/* =========================================================
   任务线程：一个任务一条会话，复用 chat_root / chat_user / chat_agent 三种消息，
   根的 refs.tasks 只挂这一个任务。人在卡上说一句，opus 带着任务、方案、判决回一句，
   顺带把能落的动作列成卡（refs.actions），人点「执行」才动看板。
   人说的每一句同时投一条 seo_feedback 走 feedback job 抽 facts，线程就是反馈的容器。
   ========================================================= */

/* 找这个任务的线程根，没有就建。返回根行。 */
function task_thread_root($task,$by){
    $tid=(int)$task['id'];
    $q=db()->prepare("SELECT * FROM seo_inbox WHERE kind='chat_root' AND client_id=? AND refs LIKE ? ORDER BY id DESC LIMIT 1");
    $q->execute([(int)$task['client_id'],'%"tasks":['.$tid.']%']);
    $r=$q->fetch();
    $q->closeCursor();
    if($r)return $r;
    $title='任务 #'.$tid.' '.mb_substr((string)$task['title'],0,120,'UTF-8');
    db()->prepare("INSERT INTO seo_inbox(client_id,kind,body,refs,reply_to,status,created_by)VALUES(?,'chat_root',?,?,NULL,'open',?)")
        ->execute([(int)$task['client_id'],$title,json_encode(inbox_refs_norm(['tasks'=>[$tid]]),JSON_UNESCAPED_UNICODE),$by]);
    $id=(int)db()->lastInsertId();
    audit($by,'seo_task_thread_open',(string)$tid,['root_id'=>$id]);
    $g=db()->prepare("SELECT * FROM seo_inbox WHERE id=?");
    $g->execute([$id]);
    return $g->fetch();
}

/* 一条线程的完整视图，和 GET /inbox/{id} 同一形状，任务卡直接拿来画。 */
function task_thread_view($root){
    $rp=db()->prepare("SELECT * FROM seo_inbox WHERE reply_to=? ORDER BY id");
    $rp->execute([(int)$root['id']]);
    $replies=[];
    foreach($rp->fetchAll() as $r){
        $row=inbox_row_out($r);
        if($row['kind']==='chat_user'||$row['kind']==='chat_agent')$replies[]=$row;
    }
    return ['ok'=>true,'root_id'=>(int)$root['id'],'item'=>inbox_row_out($root),'replies'=>$replies,'chat_pending'=>chat_job_inflight((int)$root['id'])];
}

// POST /tasks/{id}/thread -> 取或建这个任务的线程，回完整视图。
if($m==='POST'&&preg_match('#^/tasks/(\d+)/thread$#',$ROUTE,$mm)){
    $u=auth_admin();
    ensure_inbox_schema();
    $tid=(int)$mm[1];
    $tq=db()->prepare("SELECT id,client_id,title FROM seo_tasks WHERE id=?");
    $tq->execute([$tid]);
    $task=$tq->fetch();
    if(!$task)res(404,['error'=>'Task not found']);
    res(200,task_thread_view(task_thread_root($task,$u['username'])));
}

// POST /inbox/{root_id}/thread_action body { message_id, idx } -> 人点了线程里某条提议的「执行」。
// 白名单五种，对象只能是根上挂的那个任务；每条提议只能执行一次（系统行记账）。
if($m==='POST'&&preg_match('#^/inbox/(\d+)/thread_action$#',$ROUTE,$mm)){
    $u=auth_admin();
    ensure_inbox_schema();
    ensure_review_schema();
    $rootId=(int)$mm[1];
    $root=chat_root_or_die($rootId,false);
    $refs=inbox_refs_norm($root['refs']);
    if(!$refs['tasks'])res(400,['error'=>'这个会话没有挂任务，没有可执行的对象']);
    $tid=(int)$refs['tasks'][0];
    $i=input();
    $msgId=(int)($i['message_id']??0);
    $idx=(int)($i['idx']??-1);
    $mq=db()->prepare("SELECT * FROM seo_inbox WHERE id=? AND reply_to=? AND kind='chat_agent'");
    $mq->execute([$msgId,$rootId]);
    $msg=$mq->fetch();
    if(!$msg)res(404,['error'=>'找不到这条提议']);
    $mrefs=inbox_refs_norm($msg['refs']);
    if($idx<0||!isset($mrefs['actions'][$idx]))res(404,['error'=>'找不到这条提议']);
    $a=$mrefs['actions'][$idx];
    $doneKey='已执行提议 '.$msgId.'/'.$idx;
    $dq=db()->prepare("SELECT id FROM seo_inbox WHERE reply_to=? AND kind='chat_agent' AND body LIKE ? LIMIT 1");
    $dq->execute([$rootId,$doneKey.'%']);
    if($dq->fetch())res(409,['error'=>'这条提议已经执行过了']);
    $tq=db()->prepare("SELECT * FROM seo_tasks WHERE id=?");
    $tq->execute([$tid]);
    $t=$tq->fetch();
    if(!$t)res(404,['error'=>'任务不存在']);
    $r=thread_action_exec($root,$t,$a,$u['username']);
    if(!$r['ok'])res(400,['error'=>$r['what']]);
    $line=$doneKey.'：'.$r['what'].'。';
    $sysId=chat_msg_insert($root,'chat_agent',$line,$u['username'],['tasks'=>[$tid]]);
    audit($u['username'],'seo_task_thread_action',(string)$tid,['root_id'=>$rootId,'message_id'=>$msgId,'idx'=>$idx,'type'=>$a['type'],'job_ids'=>$r['job_ids']]);
    res(200,['ok'=>true,'message'=>$r['what'],'job_ids'=>$r['job_ids'],'system_message_id'=>$sysId]);
}

// POST /inbox/{root_id}/spawn_task -> 人点了「立项」。
// 这是整条对话链路上唯一一次写看板，而且是 admin 手点的一次请求。
// 字段校验用的就是 POST /tasks 的那个函数，一个字都不放宽。
// 客户归属取会话根，不取入参：草案卡片是从这个会话里长出来的，
// 让入参决定 client_id 等于开了一条跨客户建任务的路。
// 任务落 approved：人已经在对话里看过并点了头，再走一遍 proposed 是多余的一道。
if($m==='POST'&&preg_match('#^/inbox/(\d+)/spawn_task$#',$ROUTE,$mm)){
    $u=auth_admin();
    ensure_inbox_schema();
    $rootId=(int)$mm[1];
    $root=chat_root_or_die($rootId,false);
    $i=input();
    list($t,$err)=task_fields_clean($i,['status_force'=>'approved']);
    if($err)res(400,['error'=>$err]);
    /* 来源行钉在 detail 末尾：三个月后看见这条任务，得能一眼查回它是从
       哪次对话里长出来的。 */
    $src='来源：收件箱对话 #'.$rootId;
    $t['detail']=trim($t['detail']);
    $t['detail']=($t['detail']===''?$src:($t['detail']."\n\n".$src));
    $cid=(int)$root['client_id'];
    $tid=task_insert($cid,$t,$u['username']);
    $note='已立项 #'.$tid.'「'.$t['title'].'」，状态 approved，已经在看板上了。';
    $msgId=chat_msg_insert($root,'chat_agent',$note,$u['username'],['tasks'=>[$tid]]);
    audit($u['username'],'seo_chat_spawn_task',(string)$tid,[
        'root_id'=>$rootId,'client_id'=>$cid,'title'=>$t['title'],'module'=>$t['module'],'message_id'=>$msgId
    ]);
    res(200,['ok'=>true,'task_id'=>$tid,'message_id'=>$msgId]);
}

/* =========================================================
   Dashboard endpoints (admin JWT)
   ========================================================= */

// GET /clients -> console sidebar: every onboarded client plus its counters
if($m==='GET'&&$ROUTE==='/clients'){
    auth_admin();
    /* The sidebar carries the decision inbox badge, so the table has to exist
       before the counts below are read. CREATE TABLE IF NOT EXISTS on an
       already migrated database is a no-op. */
    ensure_inbox_schema();
    $s=db()->query("SELECT p.client_id,c.name,p.domain,p.platform,p.status FROM seo_profiles p INNER JOIN clients c ON c.id=p.client_id ORDER BY FIELD(p.status,'active','archived'),c.name");
    $rows=$s->fetchAll();
    $tasks=[];
    foreach(db()->query("SELECT client_id,COUNT(*) AS n FROM seo_tasks WHERE status IN('proposed','in_progress','review') GROUP BY client_id")->fetchAll() as $r)$tasks[$r['client_id']]=(int)$r['n'];
    $facts=[];
    foreach(db()->query("SELECT client_id,COUNT(*) AS n FROM seo_facts WHERE status='unconfirmed' GROUP BY client_id")->fetchAll() as $r)$facts[$r['client_id']]=(int)$r['n'];
    $plans=[];
    foreach(db()->query("SELECT client_id,MAX(version) AS v FROM seo_plans WHERE status='active' GROUP BY client_id")->fetchAll() as $r)$plans[$r['client_id']]=(int)$r['v'];
    $jobs=[];
    foreach(db()->query("SELECT client_id,MAX(created_at) AS t FROM agent_jobs GROUP BY client_id")->fetchAll() as $r)$jobs[$r['client_id']]=$r['t'];
    $inbox=[];
    foreach(db()->query("SELECT client_id,COUNT(*) AS n FROM seo_inbox WHERE kind='digest' AND status='open' AND client_id IS NOT NULL GROUP BY client_id")->fetchAll() as $r)$inbox[$r['client_id']]=(int)$r['n'];
    /* Total, not the sum of the per client counts: a cross client card belongs
       to no row in the list but still wants somebody. */
    $inboxTotal=(int)db()->query("SELECT COUNT(*) AS n FROM seo_inbox WHERE kind='digest' AND status='open'")->fetch()['n'];
    foreach($rows as &$r){
        $id=$r['client_id'];
        $r['client_id']=(int)$id;
        $r['tasks_open']=$tasks[$id]??0;
        $r['facts_pending']=$facts[$id]??0;
        $r['inbox_open']=$inbox[$id]??0;
        $r['active_plan_version']=isset($plans[$id])?$plans[$id]:null;
        $r['last_job_at']=$jobs[$id]??null;
    }
    unset($r);
    res(200,['clients'=>$rows,'inbox_open_total'=>$inboxTotal]);
}

// GET /clients/available -> ops-tracker clients not yet onboarded here
if($m==='GET'&&$ROUTE==='/clients/available'){
    auth_admin();
    $s=db()->query("SELECT c.id,c.name FROM clients c LEFT JOIN seo_profiles p ON p.client_id=c.id WHERE p.id IS NULL ORDER BY c.name");
    res(200,['clients'=>$s->fetchAll()]);
}

// POST /clients -> onboard: attach an existing client, or create one by name
if($m==='POST'&&$ROUTE==='/clients'){
    $u=auth_admin();
    $i=input();
    $cid=(int)($i['client_id']??0);
    $name=trim((string)($i['name']??''));
    if(!$cid&&$name==='')res(400,['error'=>'client_id or name required']);
    if($cid){
        $c=db()->prepare("SELECT id,name FROM clients WHERE id=?");
        $c->execute([$cid]);
        $row=$c->fetch();
        if(!$row)res(404,['error'=>'Client not found']);
        $name=$row['name'];
    }else{
        $c=db()->prepare("SELECT id,name FROM clients WHERE name=?");
        $c->execute([$name]);
        $row=$c->fetch();
        if($row){$cid=(int)$row['id'];$name=$row['name'];}
        else{
            $max=db()->query("SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM clients")->fetch()['n'];
            db()->prepare("INSERT INTO clients(name,sort_order)VALUES(?,?)")->execute([$name,$max]);
            $cid=(int)db()->lastInsertId();
        }
    }
    $ex=db()->prepare("SELECT id FROM seo_profiles WHERE client_id=?");
    $ex->execute([$cid]);
    if($ex->fetch())res(409,['error'=>'Client already onboarded','client_id'=>$cid]);
    db()->prepare("INSERT INTO seo_profiles(client_id,status)VALUES(?,'active')")->execute([$cid]);
    audit($u['username'],'seo_client_onboard',(string)$cid,['name'=>$name]);
    res(200,['ok'=>true,'client_id'=>$cid,'name'=>$name]);
}

// GET /overview?client_id= -> everything the Dashboard view needs, one call
if($m==='GET'&&$ROUTE==='/overview'){
    auth_admin();
    $cid=need_client();
    $cl=db()->prepare("SELECT id,name FROM clients WHERE id=?");
    $cl->execute([$cid]);
    $client=$cl->fetch();
    if(!$client)res(404,['error'=>'Client not found']);

    $pf=db()->prepare("SELECT * FROM seo_profiles WHERE client_id=?");
    $pf->execute([$cid]);
    $profile=$pf->fetch();
    if($profile)$profile['target_keywords']=jdec($profile['target_keywords']);

    $sn=db()->prepare("SELECT s.source,s.created_at,TIMESTAMPDIFF(HOUR,s.created_at,NOW()) AS age_hours,LENGTH(s.data) AS bytes FROM seo_snapshots s INNER JOIN (SELECT source,MAX(id) AS mid FROM seo_snapshots WHERE client_id=? GROUP BY source) t ON s.id=t.mid");
    $sn->execute([$cid]);
    $snaps=[];
    foreach($sn->fetchAll() as $r){
        $r['age_hours']=(int)$r['age_hours'];
        $r['bytes']=(int)$r['bytes'];
        $snaps[]=$r;
    }

    $ap=db()->prepare("SELECT id,version FROM seo_plans WHERE client_id=? AND status='active' ORDER BY version DESC,id DESC LIMIT 1");
    $ap->execute([$cid]);
    $active=$ap->fetch();
    $dp=db()->prepare("SELECT COUNT(*) AS n FROM seo_plans WHERE client_id=? AND status='draft'");
    $dp->execute([$cid]);
    $drafts=(int)$dp->fetch()['n'];

    $owners=['agency','client','agent'];
    $statuses=['proposed','approved','in_progress','review','blocked','done'];
    $matrix=[];
    foreach($owners as $o){foreach($statuses as $st)$matrix[$o][$st]=0;}
    $tm=db()->prepare("SELECT owner_type,status,COUNT(*) AS n FROM seo_tasks WHERE client_id=? GROUP BY owner_type,status");
    $tm->execute([$cid]);
    foreach($tm->fetchAll() as $r){
        if(isset($matrix[$r['owner_type']][$r['status']]))$matrix[$r['owner_type']][$r['status']]=(int)$r['n'];
    }

    $lj=db()->prepare("SELECT id,type,status,created_at,TIMESTAMPDIFF(SECOND,claimed_at,finished_at) AS secs FROM agent_jobs WHERE client_id=? ORDER BY id DESC LIMIT 5");
    $lj->execute([$cid]);
    $lastJobs=[];
    foreach($lj->fetchAll() as $r){
        $r['id']=(int)$r['id'];
        $r['secs']=$r['secs']===null?null:(int)$r['secs'];
        $lastJobs[]=$r;
    }

    $fc=db()->prepare("SELECT status,COUNT(*) AS n FROM seo_facts WHERE client_id=? GROUP BY status");
    $fc->execute([$cid]);
    $facts=['confirmed'=>0,'pending'=>0];
    foreach($fc->fetchAll() as $r){
        if($r['status']==='confirmed')$facts['confirmed']=(int)$r['n'];
        else $facts['pending']=(int)$r['n'];
    }

    res(200,[
        'client'=>['id'=>(int)$client['id'],'name'=>$client['name']],
        'profile'=>$profile?:null,
        'snapshots'=>$snaps,
        'active_plan'=>$active?['id'=>(int)$active['id'],'version'=>(int)$active['version']]:null,
        'draft_plans'=>$drafts,
        'tasks'=>$matrix,
        'last_jobs'=>$lastJobs,
        'facts'=>$facts
    ]);
}

// GET /profile?client_id=
if($m==='GET'&&$ROUTE==='/profile'){
    auth_admin();
    /* brand_regex 是惰性加的列，控制台要能编辑它，所以读之前先保证列存在。 */
    ensure_metrics_schema();
    $cid=need_client();
    $s=db()->prepare("SELECT * FROM seo_profiles WHERE client_id=?");
    $s->execute([$cid]);
    $r=$s->fetch();
    if($r)$r['target_keywords']=jdec($r['target_keywords']);
    $c=db()->prepare("SELECT name FROM clients WHERE id=?");
    $c->execute([$cid]);
    $cr=$c->fetch();
    res(200,['profile'=>$r?:null,'client_name'=>$cr?$cr['name']:'']);
}

// PUT /profile (upsert, merges onto the existing row)
if($m==='PUT'&&$ROUTE==='/profile'){
    $u=auth_admin();
    $i=input();
    $cid=(int)($i['client_id']??0);
    if(!$cid)res(400,['error'=>'client_id required']);
    $cur=db()->prepare("SELECT * FROM seo_profiles WHERE client_id=?");
    $cur->execute([$cid]);
    $row=$cur->fetch()?:[];
    $vals=[];
    foreach($PROFILE_FIELDS as $f){
        $vals[$f]=array_key_exists($f,$i)?(string)$i[$f]:(string)($row[$f]??'');
    }
    if(array_key_exists('target_keywords',$i)){
        $kw=$i['target_keywords'];
        if(is_array($kw))$kwJson=json_encode(array_values($kw),JSON_UNESCAPED_UNICODE);
        elseif(is_string($kw)&&trim($kw)!==''){
            $parts=preg_split('/[\r\n,]+/',$kw);
            $parts=array_values(array_filter(array_map('trim',$parts),function($x){return $x!=='';}));
            $kwJson=$parts?json_encode($parts,JSON_UNESCAPED_UNICODE):null;
        }else $kwJson=null;
    }else $kwJson=$row['target_keywords']??null;

    /* status doubles as the archive switch for the console sidebar */
    if(array_key_exists('status',$i)){
        $st=(string)$i['status'];
        if(!in_array($st,['active','archived'],true))res(400,['error'=>'bad status']);
    }else $st=(string)($row['status']??'active');

    /* report_lang drives which language the runner writes the client report in */
    $lang=array_key_exists('report_lang',$i)?trim((string)$i['report_lang']):(string)($row['report_lang']??'');
    if($lang==='')$lang='en';
    if(mb_strlen($lang,'UTF-8')>8)res(400,['error'=>'bad report_lang']);

    /* brand_regex 是后加的列，写之前先确保它存在（老库上这是一次 ALTER，之后是 no-op）。
       同时做一次校验：坏正则存进去会让 worker 每次拉数据都炸在同一个地方，
       宁可在这里 400 也不要把地雷埋进 profile。 */
    ensure_metrics_schema();
    $br=trim((string)$vals['brand_regex']);
    if($br!==''){
        if(mb_strlen($br,'UTF-8')>500)res(400,['error'=>'brand_regex 过长，上限 500 字符']);
        if(@preg_match('/'.str_replace('/','\\/',$br).'/iu','')===false)res(400,['error'=>'brand_regex 不是合法正则']);
    }
    $vals['brand_regex']=$br;

    /* workspace_dir 是执行机目录名，字符集从严：小写字母数字和 . _ -，防路径注入。 */
    $wd=trim($vals['workspace_dir']);
    if($wd!==''&&!preg_match('/^[a-z0-9._-]{1,64}$/',$wd))res(400,['error'=>'workspace_dir 只允许小写字母数字和 . _ -']);
    $sdb=trim($vals['semrush_db']);
    if($sdb!==''&&!preg_match('/^[a-z]{2,8}$/',$sdb))res(400,['error'=>'semrush_db 应为 nz / au / us 这类小写库代号']);
    /* W8 批 0 的三列。services: seo=只做自然, sem/paid=只做投放, both=都做; 空串=还没定性(老客户默认按 seo 处理)。 */
    $svc=trim($vals['services']);
    if($svc!==''&&!in_array($svc,['seo','sem','paid','both'],true))res(400,['error'=>'services 取 seo / sem / paid / both']);
    $acid=str_replace('-','',trim($vals['ads_customer_id']));
    if($acid!==''&&!preg_match('/^\d{10}$/',$acid))res(400,['error'=>'ads_customer_id 应为 10 位数字（可带横杠）']);
    $own=trim($vals['owner']);
    if($own!==''&&!preg_match('/^[a-z0-9._-]{1,32}$/',$own))res(400,['error'=>'owner 只允许小写字母数字和 . _ -']);
    $sql="INSERT INTO seo_profiles(client_id,platform,domain,ga4_property,gsc_property,semrush_project,semrush_db,workspace_dir,target_keywords,brand_regex,business_goals,conversion_goals,notes,status,report_lang,services,ads_customer_id,owner)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE platform=VALUES(platform),domain=VALUES(domain),ga4_property=VALUES(ga4_property),
            gsc_property=VALUES(gsc_property),semrush_project=VALUES(semrush_project),
            semrush_db=VALUES(semrush_db),workspace_dir=VALUES(workspace_dir),target_keywords=VALUES(target_keywords),
            brand_regex=VALUES(brand_regex),
            business_goals=VALUES(business_goals),conversion_goals=VALUES(conversion_goals),notes=VALUES(notes),
            status=VALUES(status),report_lang=VALUES(report_lang),
            services=VALUES(services),ads_customer_id=VALUES(ads_customer_id),owner=VALUES(owner)";
    db()->prepare($sql)->execute([
        $cid,$vals['platform'],$vals['domain'],$vals['ga4_property'],$vals['gsc_property'],
        $vals['semrush_project'],$sdb,$wd,$kwJson,$vals['brand_regex'],
        $vals['business_goals'],$vals['conversion_goals'],$vals['notes'],$st,$lang,
        $svc,$acid,$own
    ]);
    audit($u['username'],'seo_profile_save',(string)$cid,['domain'=>$vals['domain'],'status'=>$st,'report_lang'=>$lang]);
    res(200,['ok'=>true]);
}

// GET /plans?client_id=
// GET /plans/{id} -> 一条方案（含 body）。worker 的 plan_review 要读草稿全文，所以 auth_any。
if($m==='GET'&&preg_match('#^/plans/(\d+)$#',$ROUTE,$mm)){
    auth_any();
    $g=db()->prepare("SELECT * FROM seo_plans WHERE id=?");
    $g->execute([(int)$mm[1]]);
    $plan=$g->fetch();
    if(!$plan)res(404,['error'=>'Plan not found']);
    $tq=db()->prepare("SELECT * FROM seo_tasks WHERE plan_id=? ORDER BY FIELD(sprint,'S1','S2','S3','S4','S5','S6'),FIELD(priority,'P0','P1','P2','P3'),id");
    $tq->execute([(int)$plan['id']]);
    res(200,['plan'=>$plan,'tasks'=>$tq->fetchAll()]);
}

// POST /plans/{id}/review (admin) -> 手动排一次方案层过闸。草稿才能过闸；用于重跑或给人工建的草稿过闸。
if($m==='POST'&&preg_match('#^/plans/(\d+)/review$#',$ROUTE,$mm)){
    $u=auth_admin();
    $pid=(int)$mm[1];
    $g=db()->prepare("SELECT id,client_id,status FROM seo_plans WHERE id=?");
    $g->execute([$pid]);
    $plan=$g->fetch();
    if(!$plan)res(404,['error'=>'Plan not found']);
    if($plan['status']!=='draft')res(400,['error'=>'plan is '.$plan['status'].', only a draft can be reviewed']);
    $tq=db()->prepare("SELECT id FROM seo_tasks WHERE plan_id=? AND status='proposed'");
    $tq->execute([$pid]);
    $ids=array_map('intval',array_column($tq->fetchAll(),'id'));
    $jid=queue_plan_review_job((int)$plan['client_id'],$pid,$ids,$u['username']);
    res(200,['ok'=>true,'job_id'=>$jid]);
}

// POST /plans/{id}/review_result (worker) body { body, tasks:[...], changes:[...], card:"markdown" }
// 方案层过闸的落库：v1 草稿被 v2 取代（v1 状态 superseded，v1 的 proposed 任务按 merged 收掉），
// v2 任务进任务层判定，方向确认卡进收件箱等人点「批准 v2」。一个事务，不留半截。
if($m==='POST'&&preg_match('#^/plans/(\d+)/review_result$#',$ROUTE,$mm)){
    auth_worker();
    ensure_inbox_schema();
    $pid=(int)$mm[1];
    $i=input();
    $g=db()->prepare("SELECT * FROM seo_plans WHERE id=?");
    $g->execute([$pid]);
    $v1=$g->fetch();
    if(!$v1)res(404,['error'=>'Plan not found']);
    if($v1['status']!=='draft')res(400,['error'=>'plan is '.$v1['status'].', only a draft can be reviewed']);
    $cid=(int)$v1['client_id'];
    $body=trim((string)($i['body']??''));
    if($body==='')res(400,['error'=>'body required']);
    $card=trim((string)($i['card']??''));
    if($card==='')res(400,['error'=>'card required']);
    if(mb_strlen($card,'UTF-8')>20000)res(400,['error'=>'card over 20000 chars']);
    $changes=is_array($i['changes']??null)?array_slice($i['changes'],0,40):[];
    $p=db();
    $p->beginTransaction();
    try{
        $vq=$p->prepare("SELECT COALESCE(MAX(version),0)+1 AS n FROM seo_plans WHERE client_id=?");
        $vq->execute([$cid]);
        $ver=(int)$vq->fetch()['n'];
        $p->prepare("INSERT INTO seo_plans(client_id,version,body,status,authored_by)VALUES(?,?,?,'draft','plan_review')")->execute([$cid,$ver,$body]);
        $v2id=(int)$p->lastInsertId();
        list($clean,$err)=tasks_bulk_clean($cid,$v2id,$i['tasks']??null);
        if($err)throw new Exception($err);
        $ids=tasks_bulk_insert($p,$clean);
        /* v1 收口：草稿改 superseded，proposed 任务按 merged 关掉并指向 v2 */
        $p->prepare("UPDATE seo_plans SET status='superseded',reject_reason=? WHERE id=?")->execute(['被 v'.$ver.' 取代（方案层过闸）',$pid]);
        $oq=$p->prepare("SELECT id FROM seo_tasks WHERE plan_id=? AND status='proposed'");
        $oq->execute([$pid]);
        $old=array_map('intval',array_column($oq->fetchAll(),'id'));
        $p->commit();
    }catch(Exception $e){
        if($p->inTransaction())$p->rollBack();
        res(400,['error'=>'review_result failed: '.$e->getMessage()]);
    }
    foreach($old as $tid)task_close($tid,'merged','方案层过闸并入 v'.$ver.'（plan #'.$v2id.'）','plan_review');
    /* 被取代的草稿如果本身也是过闸产物，它那张确认卡作废 */
    db()->prepare("UPDATE seo_inbox SET status='resolved' WHERE client_id=? AND kind='digest' AND status='open' AND body LIKE ?")->execute([$cid,'[plan:'.$pid.']%']);
    $cardBody='[plan:'.$v2id.'] '.$card;
    db()->prepare("INSERT INTO seo_inbox(client_id,kind,body,refs,reply_to,status,created_by)VALUES(?,'digest',?,?,NULL,'open','seo-worker')")
        ->execute([$cid,$cardBody,json_encode(inbox_refs_norm(['tasks'=>$ids]),JSON_UNESCAPED_UNICODE)]);
    $cardId=(int)db()->lastInsertId();
    list($rjid,$rm)=queue_review_job($cid,$ids,'plan_review','seo_tasks_review_auto');
    audit('seo-worker','seo_plan_review_result',(string)$v2id,['client_id'=>$cid,'from'=>$pid,'tasks'=>$ids,'closed_v1'=>$old,'changes'=>count($changes),'card'=>$cardId]);
    res(200,['ok'=>true,'plan_id'=>$v2id,'version'=>$ver,'ids'=>$ids,'closed'=>$old,'card_id'=>$cardId,'review_job_id'=>$rjid]);
}

if($m==='GET'&&$ROUTE==='/plans'){
    auth_admin();
    $cid=need_client();
    $s=db()->prepare("SELECT * FROM seo_plans WHERE client_id=? ORDER BY version DESC,id DESC");
    $s->execute([$cid]);
    res(200,['plans'=>$s->fetchAll()]);
}

// POST /plans/{id}/approve -> activate, demote the previous active plan, and
// promote the plan's proposed tasks to approved. body.exclude_task_ids keeps
// the named tasks sitting at proposed so a human can revisit them.
if($m==='POST'&&preg_match('#^/plans/(\d+)/approve$#',$ROUTE,$mm)){
    $u=auth_admin();
    $pid=(int)$mm[1];
    $i=input();
    $g=db()->prepare("SELECT id,client_id,status FROM seo_plans WHERE id=?");
    $g->execute([$pid]);
    $plan=$g->fetch();
    if(!$plan)res(404,['error'=>'Plan not found']);
    $excl=[];
    if(isset($i['exclude_task_ids'])&&is_array($i['exclude_task_ids'])){
        foreach($i['exclude_task_ids'] as $x){$x=(int)$x;if($x)$excl[$x]=true;}
        $excl=array_keys($excl);
    }
    $cnt=db()->prepare("SELECT COUNT(*) AS n FROM seo_tasks WHERE plan_id=? AND status='proposed'");
    $cnt->execute([$pid]);
    $total=(int)$cnt->fetch()['n'];
    $approved=0;
    $p=db();
    $p->beginTransaction();
    try{
        /* 被取代的现役方案：它还没开工的任务（proposed / approved / blocked）一起收掉，
           理由指向新方案。已在 review / in_progress 的留着，那是做到一半的活。
           v2 里要保留的内容，plan_review 已经按 from 吸收进新任务了。 */
        $sq=$p->prepare("SELECT id FROM seo_plans WHERE client_id=? AND status='active' AND id<>?");
        $sq->execute([$plan['client_id'],$pid]);
        $supersededIds=array_map('intval',array_column($sq->fetchAll(),'id'));
        $p->prepare("UPDATE seo_plans SET status='superseded' WHERE client_id=? AND status='active' AND id<>?")
          ->execute([$plan['client_id'],$pid]);
        $p->prepare("UPDATE seo_plans SET status='active',approved_by=?,reject_reason=NULL WHERE id=?")
          ->execute([$u['username'],$pid]);
        if($excl){
            $in=implode(',',array_fill(0,count($excl),'?'));
            $st=$p->prepare("UPDATE seo_tasks SET status='approved' WHERE plan_id=? AND status='proposed' AND id NOT IN ($in)");
            $st->execute(array_merge([$pid],$excl));
        }else{
            $st=$p->prepare("UPDATE seo_tasks SET status='approved' WHERE plan_id=? AND status='proposed'");
            $st->execute([$pid]);
        }
        $approved=$st->rowCount();
        $p->commit();
    }catch(Exception $e){
        if($p->inTransaction())$p->rollBack();
        res(500,['error'=>'approve failed']);
    }
    /* 方向确认卡：批准 = 确认方向，收件箱里这张卡关掉 */
    db()->prepare("UPDATE seo_inbox SET status='resolved' WHERE client_id=? AND kind='digest' AND status='open' AND body LIKE ?")->execute([(int)$plan['client_id'],'[plan:'.$pid.']%']);
    $closedOld=[];
    foreach($supersededIds as $spid){
        $oq=db()->prepare("SELECT id FROM seo_tasks WHERE plan_id=? AND status IN('proposed','approved','blocked')");
        $oq->execute([$spid]);
        foreach($oq->fetchAll() as $r){ if(!task_close((int)$r['id'],'merged','方案 #'.$spid.' 被 #'.$pid.' 取代，未开工任务收掉',$u['username']))$closedOld[]=(int)$r['id']; }
    }
    $excluded=$total-$approved;
    if($excluded<0)$excluded=0;
    audit($u['username'],'seo_plan_approve',(string)$pid,['client_id'=>(int)$plan['client_id'],'approved_count'=>$approved,'excluded_count'=>$excluded]);
    res(200,['ok'=>true,'approved_count'=>$approved,'excluded_count'=>$excluded,'closed_superseded'=>$closedOld]);
}

// POST /tasks/release -> hand a batch of reviewed tasks to the worker to apply
if($m==='POST'&&$ROUTE==='/tasks/release'){
    $u=auth_admin();
    $i=input();
    $cid=(int)($i['client_id']??0);
    if(!$cid)res(400,['error'=>'client_id required']);
    $ids=[];
    if(isset($i['task_ids'])&&is_array($i['task_ids'])){
        foreach($i['task_ids'] as $x){$x=(int)$x;if($x)$ids[$x]=true;}
        $ids=array_keys($ids);
    }
    if(!$ids)res(400,['error'=>'task_ids required']);
    if(count($ids)>50)res(400,['error'=>'batch too large, max 50 tasks']);
    $in=implode(',',array_fill(0,count($ids),'?'));
    $chk=db()->prepare("SELECT id,status,client_id FROM seo_tasks WHERE id IN ($in)");
    $chk->execute($ids);
    $found=$chk->fetchAll();
    if(count($found)!==count($ids))res(400,['error'=>'Some tasks do not exist']);
    foreach($found as $t){
        if((int)$t['client_id']!==$cid)res(400,['error'=>'Task '.$t['id'].' belongs to another client']);
        if($t['status']!=='review')res(400,['error'=>'Task '.$t['id'].' is not in review']);
    }
    /* 一任务一 job：放行几个任务就建几个 apply_task job，各自 30 分钟预算与各自成败。
       去重按任务，不再是「这个客户已有 apply 在跑就整批挡回去」。 */
    /* 博客大纲阶段的任务，放行 = 写正文，不进 apply。 */
    $writeIds=[];$applyIds=[];
    $acceptIds=[];
    foreach($found as $t){
        $full=db()->prepare("SELECT * FROM seo_tasks WHERE id=?");$full->execute([(int)$t['id']]);$row=$full->fetch();
        if(analysis_task($row))$acceptIds[]=(int)$t['id'];
        elseif(blog_outline_stage($row))$writeIds[]=(int)$t['id'];else $applyIds[]=(int)$t['id'];
    }
    foreach($acceptIds as $aid){
        $full=db()->prepare("SELECT output_url,result_note FROM seo_tasks WHERE id=?");$full->execute([$aid]);$row=$full->fetch();
        if(trim((string)$row['output_url'])===''&&strpos((string)$row['result_note'],'预览: ')===false)res(400,['error'=>'任务 '.$aid.' 是分析任务但没有产出链接也没有预览，无法验收']);
        $err=task_close($aid,'accepted','分析报告已验收',$u['username']);
        if($err)res(400,['error'=>'任务 '.$aid.'：'.$err]);
    }
    $jids=[];$skipped=[];
    foreach($writeIds as $wid){
        $full=db()->prepare("SELECT * FROM seo_tasks WHERE id=?");$full->execute([$wid]);$row=$full->fetch();
        list($wj,$ws)=blog_release_as_write($cid,$row,$u['username']);$jids=array_merge($jids,$wj);$skipped=array_merge($skipped,$ws);
    }
    if($applyIds){list($aj,$as)=queue_task_jobs($cid,'apply_task',$applyIds,$u['username'],'seo_tasks_release');$jids=array_merge($jids,$aj);$skipped=array_merge($skipped,$as);}
    /* 一条都没新建说明放行的任务全在飞，旧前端认 409 加 job_id 那套提示。 */
    if(!$jids)res(409,['error'=>'Apply job already queued or running','job_id'=>$skipped?$skipped[0]['job_id']:0,'job_ids'=>[],'count'=>0,'skipped'=>$skipped]);
    /* job_id 保留成第一个新建 job，旧前端的「job #」提示不至于变成 undefined。 */
    res(200,['ok'=>true,'job_ids'=>$jids,'job_id'=>$jids[0],'count'=>count($jids),'skipped'=>$skipped]);
}

/* =========================================================
   任务判定：fable 按 specs/review_principles.md 判一批任务该不该做
   POST /tasks/review          admin   排一个 review_plan job，一批最多 20 个
   POST /tasks/review_result   worker  判决落到任务行上，不改状态
   POST /tasks/{id}/review_override  admin  人推翻，理由必填
   POST /tasks/apply_verdicts  admin   按有效判决批量执行：do 排队，drop 关掉，
                                       later 置 blocked，merge 并入目标
   固定路径全在 /tasks/{id} 的正则之前不成问题：那些正则都是 (\d+)，review 匹配不上。
   ========================================================= */

// POST /tasks/review body { client_id, task_ids } -> { ok, job_id, count }
if($m==='POST'&&$ROUTE==='/tasks/review'){
    $u=auth_admin();
    ensure_review_schema();
    $i=input();
    $cid=(int)($i['client_id']??0);
    if(!$cid)res(400,['error'=>'client_id required']);
    $ids=[];
    if(isset($i['task_ids'])&&is_array($i['task_ids'])){
        foreach($i['task_ids'] as $x){$x=(int)$x;if($x)$ids[$x]=true;}
        $ids=array_keys($ids);
    }
    if(!$ids)res(400,['error'=>'task_ids required']);
    if(count($ids)>20)res(400,['error'=>'batch too large, max 20 tasks']);
    $in=implode(',',array_fill(0,count($ids),'?'));
    $chk=db()->prepare("SELECT id,status,client_id FROM seo_tasks WHERE id IN ($in)");
    $chk->execute($ids);
    $found=$chk->fetchAll();
    if(count($found)!==count($ids))res(400,['error'=>'Some tasks do not exist']);
    foreach($found as $t){
        if((int)$t['client_id']!==$cid)res(400,['error'=>'Task '.$t['id'].' belongs to another client']);
        /* 没开工的判「该不该做」，等放行的（review）判「方案该不该落地」，worker 会把方案正文附上。
           在跑的、做完的没什么好判的。 */
        if(!in_array($t['status'],['proposed','approved','blocked','review'],true))res(400,['error'=>'Task '.$t['id'].' is '.$t['status'].', only proposed/approved/blocked/review tasks can be reviewed']);
    }
    /* 不再 409：light 道几十秒一批，重复点就是重判，同客户排队中的判定会被并进去。 */
    list($jid,$merged)=queue_review_job($cid,$ids,$u['username'],'seo_tasks_review');
    res(200,['ok'=>true,'job_id'=>$jid,'count'=>count($ids),'merged'=>$merged]);
}

// POST /tasks/review_result body { client_id, job_id, summary, verdicts:[{task_id,verdict,reason,evidence,merge_into,adjust}] }
// worker only. 写判决不动 status，也显式保住 updated_at（否则判决一落地任务就算「被改过」，
// attach_review_state 会把它当过期）。重判覆盖旧判决，同时清掉人的旧推翻。
if($m==='POST'&&$ROUTE==='/tasks/review_result'){
    auth_worker();
    ensure_review_schema();
    $i=input();
    $cid=(int)($i['client_id']??0);
    $jid=(int)($i['job_id']??0);
    if(!$cid)res(400,['error'=>'client_id required']);
    $rows=$i['verdicts']??null;
    if(!is_array($rows)||!$rows)res(400,['error'=>'verdicts required']);
    if(count($rows)>20)res(400,['error'=>'batch too large, max 20']);
    /* 过期判定改按内容哈希：只有标题或说明真改了才算过期。批准、放行、写备注这些状态动作
       会动 updated_at，但判决依据的内容没变，不该让判决失效（2026-08-27 #88 #89 因整 plan 批准被误判过期）。 */
    $up=db()->prepare("UPDATE seo_tasks SET review_verdict=?,review_reason=?,review_evidence=?,review_merge_into=?,review_adjust=?,review_job_id=?,reviewed_at=NOW(),review_override=NULL,review_override_note='',review_text_hash=MD5(CONCAT(IFNULL(title,''),'|',IFNULL(detail,''))),updated_at=updated_at WHERE id=? AND client_id=?");
    $written=0;$refused=[];
    foreach($rows as $n=>$v){
        if(!is_array($v)){$refused[]="row $n: not an object";continue;}
        $tid=(int)($v['task_id']??0);
        $verdict=(string)($v['verdict']??'');
        if(!$tid||!in_array($verdict,REVIEW_VERDICTS,true)){$refused[]="row $n: bad task_id or verdict";continue;}
        $merge=($verdict==='merge')?((int)($v['merge_into']??0)?:null):null;
        if($verdict==='merge'&&!$merge){$refused[]="row $n: merge without merge_into";continue;}
        $up->execute([
            $verdict,
            mb_substr(trim((string)($v['reason']??'')),0,255,'UTF-8'),
            mb_substr(trim((string)($v['evidence']??'')),0,255,'UTF-8'),
            $merge,
            mb_substr(trim((string)($v['adjust']??'')),0,400,'UTF-8'),
            $jid?:null,
            $tid,$cid
        ]);
        if($up->rowCount()>0)$written++;else $refused[]="row $n: task $tid not found for client";
    }
    audit('seo-worker','seo_tasks_review_result',(string)$jid,['client_id'=>$cid,'written'=>$written,'refused'=>$refused,'summary'=>mb_substr((string)($i['summary']??''),0,300,'UTF-8')]);
    res(200,['ok'=>true,'written'=>$written,'refused'=>$refused]);
}

// POST /tasks/{id}/review_override body { verdict, note } -> 人推翻 fable 的判决，理由必填。
// 前端在这之后再往 /tasks/{id}/feedback 投一条备注，让理由走 feedback job 变成 fact，
// 下次判定 fable 就带着它。这里只记推翻本身。
if($m==='POST'&&preg_match('#^/tasks/(\d+)/review_override$#',$ROUTE,$mm)){
    $u=auth_admin();
    ensure_review_schema();
    $tid=(int)$mm[1];
    $i=input();
    $verdict=(string)($i['verdict']??'');
    $note=trim((string)($i['note']??''));
    $clear=!empty($i['clear']);
    $tq=db()->prepare("SELECT id,client_id,review_verdict FROM seo_tasks WHERE id=?");
    $tq->execute([$tid]);
    $t=$tq->fetch();
    if(!$t)res(404,['error'=>'Task not found']);
    if(!$t['review_verdict'])res(400,['error'=>'Task has no review verdict to override']);
    if($clear){
        db()->prepare("UPDATE seo_tasks SET review_override=NULL,review_override_note='',updated_at=updated_at WHERE id=?")->execute([$tid]);
        audit($u['username'],'seo_task_review_override_clear',(string)$tid,[]);
        res(200,['ok'=>true]);
    }
    if(!in_array($verdict,REVIEW_VERDICTS,true))res(400,['error'=>'bad verdict']);
    if($note==='')res(400,['error'=>'note required: say why you overrule the verdict']);
    if($verdict==='merge')res(400,['error'=>'override to merge is not supported, edit the tasks by hand']);
    db()->prepare("UPDATE seo_tasks SET review_override=?,review_override_note=?,updated_at=updated_at WHERE id=?")
        ->execute([$verdict,mb_substr($note,0,400,'UTF-8'),$tid]);
    audit($u['username'],'seo_task_review_override',(string)$tid,['from'=>$t['review_verdict'],'to'=>$verdict,'note'=>$note]);
    res(200,['ok'=>true]);
}

// POST /tasks/{id}/decide body { yes: bool, note? } -> 卡上唯一的一对按钮。
// 语义随阶段变：待判 / 上次执行失败 → yes 执行（proposed 顺手置 approved）；待放行 → yes 放行；
// no 一律「不做了」置 done 记 [killed]，note 必填。延后和改判走线程，这里不做。
if($m==='POST'&&preg_match('#^/tasks/(\d+)/decide$#',$ROUTE,$mm)){
    $u=auth_admin();
    $tid=(int)$mm[1];
    $i=input();
    $yes=!empty($i['yes']);
    $note=trim((string)($i['note']??''));
    $tq=db()->prepare("SELECT * FROM seo_tasks WHERE id=?");
    $tq->execute([$tid]);
    $t=$tq->fetch();
    if(!$t)res(404,['error'=>'Task not found']);
    $cid=(int)$t['client_id'];
    if(!$yes){
        if($note==='')res(400,['error'=>'note required: say why not']);
        $err=task_close($tid,'killed','人工不做：'.$note,$u['username']);
        if($err)res(400,['error'=>$err]);
        audit($u['username'],'seo_task_decide',(string)$tid,['yes'=>0,'note'=>$note]);
        res(200,['ok'=>true,'did'=>'killed']);
    }
    if($t['status']==='review'){
        if(analysis_task($t)){
            if(trim((string)$t['output_url'])===''&&strpos((string)$t['result_note'],'预览: ')===false)res(400,['error'=>'分析任务没有产出链接也没有预览，无法验收']);
            $err=task_close($tid,'accepted','分析报告已验收',$u['username']);
            if($err)res(400,['error'=>$err]);
            audit($u['username'],'seo_task_decide',(string)$tid,['yes'=>1,'did'=>'accept']);
            res(200,['ok'=>true,'did'=>'accept','job_ids'=>[]]);
        }
        if(blog_outline_stage($t)){
            list($jids,$sk)=blog_release_as_write($cid,$t,$u['username']);
            audit($u['username'],'seo_task_decide',(string)$tid,['yes'=>1,'did'=>'write_draft','job_ids'=>$jids]);
            res(200,['ok'=>true,'did'=>'write_draft','job_ids'=>$jids,'skipped'=>$sk]);
        }
        list($jids,$sk)=queue_task_jobs($cid,'apply_task',[$tid],$u['username'],'seo_tasks_release');
        audit($u['username'],'seo_task_decide',(string)$tid,['yes'=>1,'did'=>'release','job_ids'=>$jids]);
        res(200,['ok'=>true,'did'=>'release','job_ids'=>$jids,'skipped'=>$sk]);
    }
    if(in_array($t['status'],['proposed','approved','blocked'],true)){
        if($t['owner_type']!=='agent'){
            db()->prepare("UPDATE seo_tasks SET status='approved' WHERE id=?")->execute([$tid]);
            audit($u['username'],'seo_task_decide',(string)$tid,['yes'=>1,'did'=>'approve']);
            res(200,['ok'=>true,'did'=>'approve','job_ids'=>[]]);
        }
        if($t['status']==='blocked')db()->prepare("UPDATE seo_tasks SET status='approved' WHERE id=?")->execute([$tid]);
        list($jids,$sk)=queue_task_jobs($cid,'execute_task',[$tid],$u['username'],'seo_job_create');
        audit($u['username'],'seo_task_decide',(string)$tid,['yes'=>1,'did'=>'execute','job_ids'=>$jids]);
        res(200,['ok'=>true,'did'=>'execute','job_ids'=>$jids,'skipped'=>$sk]);
    }
    res(400,['error'=>'Task is '.$t['status'].', nothing to decide']);
}

// POST /tasks/{id}/finish body { note } -> 人认定完成。机器判失败但人看过站点认为成了（例如只因平台副产物没过比对）
// 这种情况用它，note 必填写清为什么人认，追加进结果备注不覆盖。
if($m==='POST'&&preg_match('#^/tasks/(\d+)/finish$#',$ROUTE,$mm)){
    $u=auth_admin();
    $tid=(int)$mm[1];
    $i=input();
    $note=trim((string)($i['note']??''));
    if($note==='')res(400,['error'=>'note required: say why you call it done']);
    $tq=db()->prepare("SELECT id,status FROM seo_tasks WHERE id=?");
    $tq->execute([$tid]);
    $t=$tq->fetch();
    if(!$t)res(404,['error'=>'Task not found']);
    $err=task_close($tid,'accepted','人工认定完成：'.$note,$u['username']);
    if($err)res(400,['error'=>$err]);
    audit($u['username'],'seo_task_finish',(string)$tid,['note'=>$note,'from'=>$t['status']]);
    res(200,['ok'=>true]);
}

// POST /tasks/apply_verdicts body { client_id, task_ids } -> 按有效判决批量执行。
// 有效判决 = 人的推翻优先，其次 fable 的；过期的（判决后任务或 facts 改过）一律跳过，
// 让人重判，不拿旧判决动新前提。
//   do     proposed/blocked 先置 approved，再按一任务一 job 排 execute_task
//   drop   置 done，备注 [dropped]
//   later  置 blocked，备注 [later] 等什么
//   merge  置 done，备注 [merged]，目标任务说明追加一行来源
if($m==='POST'&&$ROUTE==='/tasks/apply_verdicts'){
    $u=auth_admin();
    ensure_review_schema();
    $i=input();
    $cid=(int)($i['client_id']??0);
    if(!$cid)res(400,['error'=>'client_id required']);
    $ids=[];
    if(isset($i['task_ids'])&&is_array($i['task_ids'])){
        foreach($i['task_ids'] as $x){$x=(int)$x;if($x)$ids[$x]=true;}
        $ids=array_keys($ids);
    }
    if(!$ids)res(400,['error'=>'task_ids required']);
    if(count($ids)>50)res(400,['error'=>'batch too large, max 50 tasks']);
    $in=implode(',',array_fill(0,count($ids),'?'));
    $q=db()->prepare("SELECT * FROM seo_tasks WHERE id IN ($in) AND client_id=?");
    $q->execute(array_merge($ids,[$cid]));
    $tasks=attach_review_state($q->fetchAll(),$cid);
    $byId=[];foreach($tasks as $t)$byId[(int)$t['id']]=$t;
    $skipped=[];$doIds=[];$releaseIds=[];$jids=[];$done=['do'=>0,'drop'=>0,'later'=>0,'merge'=>0];
    $merges=[];
    foreach($ids as $tid){
        if(!isset($byId[$tid])){$skipped[]=['task_id'=>$tid,'why'=>'不存在或不属于该客户'];continue;}
        $t=$byId[$tid];
        $eff=$t['review_effective'];
        if(!$eff){$skipped[]=['task_id'=>$tid,'why'=>'没有判决'];continue;}
        if($t['review_stale']){$skipped[]=['task_id'=>$tid,'why'=>'判决已过期，先重判'];continue;}
        if(!in_array($t['status'],['proposed','approved','blocked','review'],true)){$skipped[]=['task_id'=>$tid,'why'=>'状态是 '.$t['status'].'，不动'];continue;}
        $why=(string)($t['review_override']?$t['review_override_note']:$t['review_reason']);
        /* 等放行的任务：do 就是放行（排 apply_task），later 留在待放行只记备注，
           drop 关掉不落地，merge 关掉并把来源写到目标上，目标照常放行。 */
        if($t['status']==='review'){
            if($eff==='do'){
                if(analysis_task($t)){
                    if(trim((string)$t['output_url'])===''&&strpos((string)$t['result_note'],'预览: ')===false){$skipped[]=['task_id'=>$tid,'why'=>'分析任务没有产出也没有预览，不能验收'];continue;}
                    $err=task_close($tid,'accepted','分析报告已验收（按推荐）',$u['username']);
                    if($err){$skipped[]=['task_id'=>$tid,'why'=>$err];continue;}
                    $done['do']++;continue;
                }
                if(blog_outline_stage($t)){list($wj,$ws)=blog_release_as_write($cid,$t,$u['username']);$jids=array_merge($jids??[],$wj);$done['do']++;continue;}
                $releaseIds[]=$tid;$done['do']++;continue;
            }
            if($eff==='later'){task_append_note($tid,'[later] 判定暂不放行：'.$why);$done['later']++;continue;}
            if($eff==='drop'){
                $err=task_close($tid,'dropped','判定不落地：'.$why);
                if($err){$skipped[]=['task_id'=>$tid,'why'=>$err];continue;}
                $done['drop']++;continue;
            }
        }
        if($eff==='do'){
            if($t['status']!=='approved'){
                db()->prepare("UPDATE seo_tasks SET status='approved' WHERE id=?")->execute([$tid]);
            }
            /* 只有 agent 任务有 execute_task 可排；agency / client 的活「做」就是批准，人去干。 */
            if($t['owner_type']==='agent')$doIds[]=$tid;
            $done['do']++;
            continue;
        }
        if($eff==='drop'){
            $err=task_close($tid,'dropped','判定不做：'.$why);
            if($err){$skipped[]=['task_id'=>$tid,'why'=>$err];continue;}
            $done['drop']++;continue;
        }
        if($eff==='later'){
            db()->prepare("UPDATE seo_tasks SET status='blocked' WHERE id=?")->execute([$tid]);
            task_append_note($tid,'[later] 判定延后：'.$why);
            $done['later']++;continue;
        }
        if($eff==='merge'){
            $target=(int)$t['review_merge_into'];
            if(!$target){$skipped[]=['task_id'=>$tid,'why'=>'merge 没有目标'];continue;}
            $merges[]=[$tid,$target,$t['title'],$why];
            continue;
        }
    }
    /* 并入最后做：目标任务的 detail 一改 updated_at 就动，它自己的判决会显示为过期，
       那是真实的（说明变了），但要等它在本批里该做的事先做完。 */
    foreach($merges as $mg){
        list($tid,$target,$title,$why)=$mg;
        $tg=db()->prepare("SELECT id FROM seo_tasks WHERE id=? AND client_id=?");
        $tg->execute([$target,$cid]);
        if(!$tg->fetch()){$skipped[]=['task_id'=>$tid,'why'=>'并入目标 #'.$target.' 不存在'];continue;}
        $err=task_close($tid,'merged','并入 #'.$target.'：'.$why);
        if($err){$skipped[]=['task_id'=>$tid,'why'=>$err];continue;}
        db()->prepare("UPDATE seo_tasks SET detail=CONCAT_WS('\n',NULLIF(detail,''),?) WHERE id=?")
            ->execute(['（并入自 #'.$tid.' '.mb_substr((string)$title,0,120,'UTF-8').'）',$target]);
        $done['merge']++;
    }
    $qskipped=[];
    if($doIds){
        list($ej,$qskipped)=queue_task_jobs($cid,'execute_task',$doIds,$u['username'],'seo_job_create');
        $jids=array_merge($jids,$ej);
    }
    if($releaseIds){
        list($rj,$rs)=queue_task_jobs($cid,'apply_task',$releaseIds,$u['username'],'seo_tasks_release');
        $jids=array_merge($jids,$rj);$qskipped=array_merge($qskipped,$rs);
    }
    audit($u['username'],'seo_tasks_apply_verdicts',(string)$cid,['ids'=>$ids,'done'=>$done,'job_ids'=>$jids,'skipped'=>$skipped,'queue_skipped'=>$qskipped]);
    res(200,['ok'=>true,'done'=>$done,'job_ids'=>$jids,'skipped'=>$skipped,'queue_skipped'=>$qskipped]);
}

// POST /feedback_upload -> one screenshot, multipart form field "file".
// Runs before the feedback row exists: the browser uploads on paste, gets a
// name back, and only sends the names along when the note is submitted. A file
// nobody submits just sits there, which is the cheap tradeoff for pasting.
// The stored MIME comes from finfo, never from the client's Content-Type.
if($m==='POST'&&$ROUTE==='/feedback_upload'){
    $u=auth_admin();
    if(!isset($_FILES['file'])){
        /* An oversized POST is discarded by PHP before this script runs, which
           leaves both $_FILES and $_POST empty. Say so instead of "no file". */
        $clen=(int)($_SERVER['CONTENT_LENGTH']??0);
        if($clen>0&&!$_POST){
            res(400,['error'=>'Upload rejected before PHP saw it, larger than post_max_size']);
        }
        res(400,['error'=>'file field required']);
    }
    $f=$_FILES['file'];
    if(is_array($f['name']))res(400,['error'=>'one file per request']);
    if((int)$f['error']!==UPLOAD_ERR_OK)res(400,['error'=>fb_upload_error((int)$f['error'])]);
    $size=(int)$f['size'];
    if($size<=0)res(400,['error'=>'empty file']);
    if($size>$FEEDBACK_MAX_BYTES)res(400,['error'=>'File over 5MB']);
    $tmp=(string)$f['tmp_name'];
    if(!is_uploaded_file($tmp))res(400,['error'=>'not an uploaded file']);
    $mime='';
    if(function_exists('finfo_open')){
        $fi=finfo_open(FILEINFO_MIME_TYPE);
        $mime=(string)finfo_file($fi,$tmp);
        finfo_close($fi);
    }elseif(function_exists('getimagesize')){
        $gi=@getimagesize($tmp);
        $mime=$gi&&isset($gi['mime'])?(string)$gi['mime']:'';
    }
    $exts=['image/png'=>'png','image/jpeg'=>'jpg','image/webp'=>'webp'];
    if(!isset($exts[$mime]))res(400,['error'=>'Only png, jpeg or webp images are accepted, got '.($mime?:'unknown')]);
    if(!fb_dir_ready())res(500,['error'=>'Upload directory is missing or not writable: '.fb_dir()]);
    $name=bin2hex(random_bytes(16)).'.'.$exts[$mime];
    if(!@move_uploaded_file($tmp,fb_path($name)))res(500,['error'=>'Could not store the upload in '.fb_dir()]);
    @chmod(fb_path($name),0640);
    audit($u['username'],'seo_feedback_upload',$name,['bytes'=>$size,'mime'=>$mime]);
    res(200,['ok'=>true,'name'=>$name,'bytes'=>$size]);
}

// POST /tasks/{id}/feedback -> a human writes a note on a task in plain words,
// their own judgement (source=manual) or the client's exact words (source=client).
// The row is stored raw and a feedback job is queued to parse it. No dedup on
// purpose: several notes on one task may legitimately queue up.
if($m==='POST'&&preg_match('#^/tasks/(\d+)/feedback$#',$ROUTE,$mm)){
    $u=auth_admin();
    ensure_feedback_schema();
    $tid=(int)$mm[1];
    $i=input();
    $tq=db()->prepare("SELECT id,client_id FROM seo_tasks WHERE id=?");
    $tq->execute([$tid]);
    $task=$tq->fetch();
    if(!$task)res(404,['error'=>'Task not found']);
    $text=trim((string)($i['text']??''));
    if(mb_strlen($text,'UTF-8')>20000)res(400,['error'=>'text over 20000 chars']);
    /* Screenshots already went through /feedback_upload, so all that is left is
       to check the names still look like ours and the files are really there. */
    $imgs=[];
    if(isset($i['images'])&&is_array($i['images'])){
        foreach($i['images'] as $n){
            $n=(string)$n;
            if(!fb_name_ok($n))res(400,['error'=>'bad image name']);
            if(!is_file(fb_path($n)))res(400,['error'=>'Image no longer on disk: '.$n]);
            if(!in_array($n,$imgs,true))$imgs[]=$n;
        }
    }
    if(count($imgs)>$FEEDBACK_MAX_IMAGES)res(400,['error'=>'too many images, max '.$FEEDBACK_MAX_IMAGES]);
    /* A screenshot on its own is a complete feedback, so text is only required
       when there is nothing else in the note. */
    if($text===''&&!$imgs)res(400,['error'=>'text or images required']);
    $src=(string)($i['source']??'manual');
    if(!in_array($src,['manual','client'],true))res(400,['error'=>'bad source']);
    $complete=empty($i['complete_on_parse'])?false:true;
    $cid=(int)$task['client_id'];
    db()->prepare("INSERT INTO seo_feedback(client_id,task_id,source,`text`,images,status,created_by)VALUES(?,?,?,?,?,'pending',?)")
        ->execute([$cid,$tid,$src,$text,$imgs?json_encode($imgs):null,$u['username']]);
    $fid=(int)db()->lastInsertId();
    $payload=json_encode([
        'task_id'=>$tid,
        'feedback_id'=>$fid,
        'source'=>$src,
        'text'=>$text,
        'images'=>$imgs,
        'complete_on_parse'=>$complete
    ],JSON_UNESCAPED_UNICODE);
    db()->prepare("INSERT INTO agent_jobs(client_id,type,payload,status,created_by)VALUES(?,'feedback',?,'queued',?)")
        ->execute([$cid,$payload,$u['username']]);
    $jid=(int)db()->lastInsertId();
    db()->prepare("UPDATE seo_feedback SET job_id=? WHERE id=?")->execute([$jid,$fid]);
    audit($u['username'],'seo_task_feedback',(string)$tid,[
        'client_id'=>$cid,'feedback_id'=>$fid,'job_id'=>$jid,'source'=>$src,
        'chars'=>mb_strlen($text,'UTF-8'),'images'=>count($imgs),'complete_on_parse'=>$complete?1:0
    ]);
    fire_wake($jid);
    res(200,['ok'=>true,'feedback_id'=>$fid,'job_id'=>$jid]);
}

// GET /tasks/{id}/feedback -> the note history for one task, newest first.
// text is cut to 500 chars: this feeds a card, not an archive.
if($m==='GET'&&preg_match('#^/tasks/(\d+)/feedback$#',$ROUTE,$mm)){
    auth_admin();
    ensure_feedback_schema();
    $tid=(int)$mm[1];
    $s=db()->prepare("SELECT id,client_id,task_id,source,status,parsed_note,job_id,created_by,created_at,parsed_at,images,
        LEFT(`text`,500) AS text_short,CHAR_LENGTH(`text`) AS text_len
        FROM seo_feedback WHERE task_id=? ORDER BY id DESC LIMIT 50");
    $s->execute([$tid]);
    $rows=$s->fetchAll();
    foreach($rows as &$r){
        $r['id']=(int)$r['id'];
        $r['job_id']=$r['job_id']===null?null:(int)$r['job_id'];
        $r['text_len']=(int)$r['text_len'];
        $r['truncated']=$r['text_len']>500;
        $im=jdec($r['images']);
        $r['images']=is_array($im)?array_values(array_filter($im,'fb_name_ok')):[];
    }
    unset($r);
    res(200,['feedback'=>$rows]);
}

// GET /attention?client_id= -> the exception queue: what needs a human.
// Either layer: same list the console shows, and the triage runner starts from it.
// Nothing here is new to the worker: the task rows already reach it through
// /context, and the failed job rows carry no payload and no log.
if($m==='GET'&&$ROUTE==='/attention'){
    auth_any();
    $cid=need_client();
    $ord="FIELD(priority,'P0','P1','P2','P3'),id";
    $ft=db()->prepare("SELECT * FROM seo_tasks WHERE client_id=? AND attention=1 AND status NOT IN('done','blocked') ORDER BY $ord");
    $ft->execute([$cid]);
    $co=db()->prepare("SELECT * FROM seo_tasks WHERE client_id=? AND owner_type='client' AND status<>'done' ORDER BY $ord");
    $co->execute([$cid]);
    $fj=db()->prepare("SELECT id,type,status,created_at,finished_at FROM agent_jobs WHERE client_id=? AND status='failed' ORDER BY id DESC LIMIT 10");
    $fj->execute([$cid]);
    $jobs=[];
    foreach($fj->fetchAll() as $r){$r['id']=(int)$r['id'];$jobs[]=$r;}
    $pf=db()->prepare("SELECT COUNT(*) AS n FROM seo_facts WHERE client_id=? AND status='unconfirmed'");
    $pf->execute([$cid]);
    /* 待复验：apply 成功但有 deferred 验证项、且没盖章的。done 的任务也在，这是它唯一的出口。
       2026-08-29 起 deferred 只剩两类：要 Google 交互工具的（抽查项）和要等 N 天的（到期由 PJ 用机器复验）。 */
    ensure_review_schema();
    $mq=db()->prepare("SELECT id,title,priority,status,sprint,result_note,manual_done_at FROM seo_tasks WHERE client_id=? AND manual_done_at IS NULL AND (result_note LIKE '%待人工%' OR result_note LIKE '%待复验%') ORDER BY $ord");
    $mq->execute([$cid]);
    $manual=[];
    foreach($mq->fetchAll() as $r){
        $mc=manual_checks_of($r);
        if(!$mc['pending'])continue;
        $manual[]=['id'=>(int)$r['id'],'title'=>$r['title'],'priority'=>$r['priority'],'status'=>$r['status'],'sprint'=>$r['sprint'],'items'=>$mc['items']];
    }
    res(200,[
        'flagged_tasks'=>$ft->fetchAll(),
        'client_open'=>$co->fetchAll(),
        'failed_jobs'=>$jobs,
        'manual_checks'=>$manual,
        'pending_facts_count'=>(int)$pf->fetch()['n']
    ]);
}

// POST /tasks/{id}/manual_done body { note } -> 人把 deferred 验证项补跑完了，盖章。note 必填，写跑了什么、结果如何。
if($m==='POST'&&preg_match('#^/tasks/(\d+)/manual_done$#',$ROUTE,$mm)){
    $u=auth_any();
    ensure_review_schema();
    $tid=(int)$mm[1];
    $i=input();
    $note=trim((string)($i['note']??''));
    if($note==='')res(400,['error'=>'note required：写清补跑了哪几项、结果如何']);
    if(mb_strlen($note,'UTF-8')>400)res(400,['error'=>'note over 400 chars']);
    $g=db()->prepare("SELECT id,result_note,manual_done_at FROM seo_tasks WHERE id=?");
    $g->execute([$tid]);
    $t=$g->fetch();
    if(!$t)res(404,['error'=>'Task not found']);
    $mc=manual_checks_of($t);
    if(!$mc['items'])res(400,['error'=>'这条任务没有待人工的验证项']);
    if($t['manual_done_at'])res(409,['error'=>'已经盖过章：'.$t['manual_done_at']]);
    db()->prepare("UPDATE seo_tasks SET manual_done_at=NOW(),manual_done_note=?,result_note=CONCAT_WS('\n',NULLIF(result_note,''),?) WHERE id=?")
        ->execute([$note,'[manual-ok] '.$u['username'].'：'.$note,$tid]);
    audit($u['username'],'seo_task_manual_done',(string)$tid,['note'=>$note,'items'=>$mc['items']]);
    res(200,['ok'=>true]);
}

/* GET /board -> 跨客户总览（/overview 已被单客户 Dashboard 占用），worker token 或 admin 都能读。2026-08-29 W1：看板是任务状态唯一真相，
   PJ 从这里派生待办，不再自己记一份。每客户：sprint 锚点与本期档号、任务（带 human_state、
   manual_checks、预览链接、结束态证据），以及 attention 三类计数。只读，一次拉全。 */
if($m==='GET'&&$ROUTE==='/board'){
    auth_any();
    ensure_review_schema();
    $days=14;
    $today=new DateTime('today');
    $out=[];
    $cs=db()->query("SELECT p.client_id,c.name,p.domain,p.platform,p.status FROM seo_profiles p INNER JOIN clients c ON c.id=p.client_id WHERE p.status='active' ORDER BY c.name");
    foreach($cs->fetchAll() as $c){
        $cid=(int)$c['client_id'];
        $pq=db()->prepare("SELECT id,created_at FROM seo_plans WHERE client_id=? ORDER BY FIELD(status,'active') DESC, id DESC LIMIT 1");
        $pq->execute([$cid]);
        $pr=$pq->fetch();
        $pq->closeCursor();
        $anchor=($pr&&$pr['created_at'])?substr((string)$pr['created_at'],0,10):null;
        $cur=null;
        if($anchor){
            $a=new DateTime($anchor);
            $n=(int)floor($today->diff($a)->days/$days)+1;
            if($a>$today)$n=1;
            $cur=max(1,min($n,6));
        }
        $tq=db()->prepare("SELECT * FROM seo_tasks WHERE client_id=? ORDER BY FIELD(status,'proposed','approved','in_progress','review','blocked','done'),FIELD(priority,'P0','P1','P2','P3'),id");
        $tq->execute([$cid]);
        $rows=attach_human_state(attach_review_state(attach_job_state($tq->fetchAll(),$cid),$cid),$cid);
        /* 方案状态：草稿方案（等人批准）的任务不算本期活，单列「待确认方案」；
           被取代 / 打回的方案里已关掉的任务是过渡产物，不上看板（2026-08-29 W7 联调后 Ben's AU 冒出 12 条）。 */
        $psq=db()->prepare("SELECT id,version,status FROM seo_plans WHERE client_id=?");
        $psq->execute([$cid]);
        $planStatus=[];foreach($psq->fetchAll() as $pl)$planStatus[(int)$pl['id']]=$pl;
        $tasks=[];$nManual=0;$nWaitMe=0;$nRunning=0;$pendingPlans=[];$hiddenClosed=0;
        foreach($rows as $t){
            $pl=$t['plan_id']?($planStatus[(int)$t['plan_id']]??null):null;
            if($pl&&$pl['status']==='draft'){
                $k=(int)$pl['id'];
                if(!isset($pendingPlans[$k]))$pendingPlans[$k]=['plan_id'=>$k,'version'=>(int)$pl['version'],'task_count'=>0,'s1_count'=>0];
                $pendingPlans[$k]['task_count']++;
                if(strtoupper(trim((string)$t['sprint']))==='S1')$pendingPlans[$k]['s1_count']++;
                continue;
            }
            if($pl&&in_array($pl['status'],['superseded','rejected'],true)&&$t['status']==='done'){$hiddenClosed++;continue;}
            $note=(string)($t['result_note']??'');
            $pv='';
            if(preg_match_all('/预览: (https?:\/\/\S+)/',$note,$pm))$pv=end($pm[1]);
            $evidence='';
            if($t['status']==='done'){
                $ck=($t['closed_kind']??'')?:'done';
                if($ck==='done'){
                    if(preg_match_all('/检查:[^\n]*/u',$note,$em))$evidence=end($em[0]);
                    else $evidence='无证据（落地态没有检查行）';
                }else{
                    if(preg_match_all('/\[(accepted|dropped|merged|killed)\][^\n]*/u',$note,$em))$evidence=end($em[0]);
                    elseif(preg_match('/\[applied\] [^\n]*/u',$note,$km))$evidence=$km[0];
                    else $evidence='无证据';
                }
            }
            $sn=null;
            if(preg_match('/^S(\d+)$/i',trim((string)($t['sprint']??'')),$sm))$sn=(int)$sm[1];
            if(!empty($t['manual_pending']))$nManual++;
            if(($t['human_state']??'')==='wait_me')$nWaitMe++;
            if(($t['human_state']??'')==='running')$nRunning++;
            $tasks[]=[
                'id'=>(int)$t['id'],'title'=>$t['title'],'sprint'=>$t['sprint'],'sprint_num'=>$sn,
                'overdue'=>($cur!==null&&$sn!==null&&$sn<$cur&&($t['human_state']??'')!=='closed'),
                'status'=>$t['status'],'priority'=>$t['priority'],'owner_type'=>$t['owner_type'],
                'human_state'=>$t['human_state'],'wait_reason'=>$t['wait_reason'],'run_note'=>$t['run_note'],
                'closed_kind'=>$t['closed_kind'],'round'=>$t['round'],
                'manual_checks'=>$t['manual_checks'],'manual_pending'=>$t['manual_pending'],
                'preview_url'=>$pv,'output_url'=>$t['output_url'],'evidence'=>$evidence,'updated_at'=>$t['updated_at']??null,
            ];
        }
        $fj=db()->prepare("SELECT COUNT(*) AS n FROM agent_jobs WHERE client_id=? AND status='failed' AND finished_at>=DATE_SUB(NOW(),INTERVAL 7 DAY)");
        $fj->execute([$cid]);
        $out[]=[
            'client_id'=>$cid,'name'=>$c['name'],'domain'=>$c['domain'],'platform'=>$c['platform'],
            'plan_id'=>$pr?(int)$pr['id']:null,'sprint_anchor'=>$anchor,'sprint_days'=>$days,'current_sprint'=>$cur,
            'counts'=>['tasks'=>count($tasks),'wait_me'=>$nWaitMe,'running'=>$nRunning,'manual_pending'=>$nManual,'failed_jobs_7d'=>(int)$fj->fetch()['n'],'hidden_closed'=>$hiddenClosed],
            'pending_plans'=>array_values($pendingPlans),
            'tasks'=>$tasks,
        ];
    }
    /* 看板自己的部署记录（deploy.sh api 写的 DEPLOYED-seo），PJ 的 board_todo 拿它和仓库 HEAD 比漂移。 */
    $dep=@file_get_contents(__DIR__.'/DEPLOYED-seo');
    $apiRev=null;$apiDate=null;
    if($dep){
        if(preg_match('/^rev (\S+)/m',$dep,$dm))$apiRev=$dm[1];
        if(preg_match('/^date (\S+)/m',$dep,$dd))$apiDate=$dd[1];
    }
    res(200,['generated_at'=>date('Y-m-d H:i:s'),'api_rev'=>$apiRev,'api_deployed'=>$apiDate,'clients'=>$out]);
}

// POST /plans/{id}/reject -> body.reason required
if($m==='POST'&&preg_match('#^/plans/(\d+)/reject$#',$ROUTE,$mm)){
    $u=auth_admin();
    $pid=(int)$mm[1];
    $i=input();
    $reason=trim((string)($i['reason']??''));
    if($reason==='')res(400,['error'=>'reason required']);
    $g=db()->prepare("SELECT id,client_id FROM seo_plans WHERE id=?");
    $g->execute([$pid]);
    $plan=$g->fetch();
    if(!$plan)res(404,['error'=>'Plan not found']);
    db()->prepare("UPDATE seo_plans SET status='rejected',reject_reason=?,approved_by=? WHERE id=?")
        ->execute([$reason,$u['username'],$pid]);
    /* 打回的方案，它带来的 proposed 任务一起关掉（killed 带原因），方向确认卡收掉。
       原因会被 tools/experience_sync.js 抓进跨客户经验。 */
    $oq=db()->prepare("SELECT id FROM seo_tasks WHERE plan_id=? AND status='proposed'");
    $oq->execute([$pid]);
    $killed=[];
    foreach($oq->fetchAll() as $r){ if(!task_close((int)$r['id'],'killed','方案 #'.$pid.' 被打回：'.$reason,$u['username']))$killed[]=(int)$r['id']; }
    db()->prepare("UPDATE seo_inbox SET status='resolved' WHERE client_id=? AND kind='digest' AND status='open' AND body LIKE ?")->execute([(int)$plan['client_id'],'[plan:'.$pid.']%']);
    audit($u['username'],'seo_plan_reject',(string)$pid,['client_id'=>(int)$plan['client_id'],'reason'=>$reason,'killed'=>$killed]);
    res(200,['ok'=>true,'killed'=>$killed]);
}

// GET /tasks?client_id=
// Every row carries its deliverables array, so the board can draw the download
// list without a second request per card.
// 每行还挂一个 job_state，任务卡上直接看得到「排队第几 / 在跑 / 上次失败」，
// 不用前端拿 job 列表反查。两块都是一次 SQL 拉全量再在 PHP 里挂，不做每卡一查。
if($m==='GET'&&$ROUTE==='/tasks'){
    auth_admin();
    $cid=need_client();
    ensure_review_schema();
    $s=db()->prepare("SELECT * FROM seo_tasks WHERE client_id=? ORDER BY FIELD(owner_type,'agency','client','agent'),FIELD(status,'proposed','approved','in_progress','review','blocked','done'),FIELD(priority,'P0','P1','P2','P3'),id");
    $s->execute([$cid]);
    /* sprint 锚点：生效 plan 的生成日（没有生效的取最新一份）。前端按两周一档推算 S1..S6 的日历区间，
       「本期」按今天落在哪一档定，逾期的照显示，做完了就等下一档，不再按「最小未完成 S 号」跳。 */
    $pq=db()->prepare("SELECT created_at FROM seo_plans WHERE client_id=? ORDER BY FIELD(status,'active') DESC, id DESC LIMIT 1");
    $pq->execute([$cid]);
    $pr=$pq->fetch();
    $pq->closeCursor();
    res(200,['tasks'=>attach_human_state(attach_review_state(attach_job_state(attach_deliverables($s->fetchAll()),$cid),$cid),$cid),'sprint_anchor'=>($pr&&$pr['created_at'])?substr((string)$pr['created_at'],0,10):null,'sprint_days'=>14]);
}

// POST /tasks
if($m==='POST'&&$ROUTE==='/tasks'){
    $u=auth_admin();
    $i=input();
    $cid=(int)($i['client_id']??0);
    if(!$cid)res(400,['error'=>'client_id required']);
    /* 字段校验走 task_fields_clean()，收件箱对话的立项按钮走的是同一个函数。 */
    list($t,$err)=task_fields_clean($i);
    if($err)res(400,['error'=>$err]);
    $id=task_insert($cid,$t,$u['username']);
    audit($u['username'],'seo_task_add',(string)$id,['client_id'=>$cid,'title'=>$t['title'],'owner_type'=>$t['owner_type']]);
    /* 人工新建的也判一轮，几十秒，省得手写的任务绕过了「该不该做」这一问。 */
    list($rjid,$rmerged)=queue_review_job($cid,[$id],$u['username'],'seo_tasks_review_auto');
    res(200,['ok'=>true,'id'=>$id,'review_job_id'=>$rjid]);
}

// PATCH /tasks/{id}
if($m==='PATCH'&&preg_match('#^/tasks/(\d+)$#',$ROUTE,$mm)){
    $u=auth_admin();
    $tid=(int)$mm[1];
    $i=input();
    $chk=db()->prepare("SELECT id FROM seo_tasks WHERE id=?");
    $chk->execute([$tid]);
    if(!$chk->fetch())res(404,['error'=>'Task not found']);
    $sets=[];$args=[];
    if(isset($i['status'])){
        if(!in_array($i['status'],['proposed','approved','in_progress','review','done','blocked'],true))res(400,['error'=>'bad status']);
        $sets[]='status=?';$args[]=$i['status'];
    }
    if(isset($i['owner_type'])){
        if(!in_array($i['owner_type'],['agency','client','agent'],true))res(400,['error'=>'bad owner_type']);
        $sets[]='owner_type=?';$args[]=$i['owner_type'];
    }
    if(isset($i['module'])){
        if(!in_array($i['module'],['technical','onpage','content','local','offpage'],true))res(400,['error'=>'bad module']);
        $sets[]='module=?';$args[]=$i['module'];
    }
    if(isset($i['priority'])){
        if(!in_array($i['priority'],['P0','P1','P2','P3'],true))res(400,['error'=>'bad priority']);
        $sets[]='priority=?';$args[]=$i['priority'];
    }
    if(isset($i['title'])){$sets[]='title=?';$args[]=(string)$i['title'];}
    if(isset($i['detail'])){$sets[]='detail=?';$args[]=(string)$i['detail'];}
    if(isset($i['sprint'])){$sets[]='sprint=?';$args[]=(string)$i['sprint'];}
    if(isset($i['output_url'])){$sets[]='output_url=?';$args[]=(string)$i['output_url'];}
    if(isset($i['ops'])){$sets[]='ops=?';$args[]=(string)$i['ops'];}
    if(isset($i['result_note'])){$sets[]='result_note=?';$args[]=(string)$i['result_note'];}
    if(array_key_exists('attention',$i)){$sets[]='attention=?';$args[]=empty($i['attention'])?0:1;}
    if(array_key_exists('plan_id',$i)){$sets[]='plan_id=?';$args[]=$i['plan_id']?(int)$i['plan_id']:null;}
    if(!$sets)res(400,['error'=>'nothing to update']);
    $args[]=$tid;
    db()->prepare("UPDATE seo_tasks SET ".implode(',',$sets)." WHERE id=?")->execute($args);
    audit($u['username'],'seo_task_update',(string)$tid,$i);
    res(200,['ok'=>true]);
}

// POST /jobs -> queue one job, 409 if the same client+type is already in flight
// 例外是 execute_task 带 task_ids 数组：任务是工作单位，勾几个任务就建几个 job，
// 每个 job 的 payload 只装一个 task_id（runner 现有解析不变），各自吃满 30 分钟预算，
// 各自成败互不牵连，worker 按 job id 顺序一条条消化。去重也随之改成按任务，
// 不再是「同客户同类型只许一个」（那条对其他类型照旧）。
if($m==='POST'&&$ROUTE==='/jobs'){
    $u=auth_admin();
    $i=input();
    $cid=(int)($i['client_id']??0);
    $type=(string)($i['type']??'');
    if(!$cid)res(400,['error'=>'client_id required']);
    /* feedback is here so a stuck note can be re-queued by hand; the normal
       path is POST /tasks/{id}/feedback, which also writes the seo_feedback row.
       triage is read only: it looks at everything and writes a report, nothing else. */
    /* backfill_metrics 零 LLM，把 GSC/GA4 的历史按日数据补进 seo_metrics_daily。
       幂等可重跑，所以放开给控制台手动触发。 */
    if(!in_array($type,['discover','pull_data','plan','execute_task','report','feedback','triage','backfill_metrics'],true))res(400,['error'=>'bad type']);
    if($type==='feedback')ensure_feedback_schema();
    if($type==='report')ensure_reports_schema();
    if($type==='triage')ensure_job_types();
    if($type==='backfill_metrics'){ensure_job_types();ensure_metrics_schema();}
    $payloadIn=$i['payload']??null;
    if($type==='execute_task'&&is_array($payloadIn)&&isset($payloadIn['task_ids'])&&is_array($payloadIn['task_ids'])){
        $ids=[];
        foreach($payloadIn['task_ids'] as $x){$x=(int)$x;if($x&&!in_array($x,$ids,true))$ids[]=$x;}
        if(!$ids)res(400,['error'=>'task_ids required']);
        if(count($ids)>50)res(400,['error'=>'batch too large, max 50 tasks']);
        list($jids,$skipped)=queue_task_jobs($cid,$type,$ids,$u['username'],'seo_job_create');
        /* 一条都没新建说明勾的任务全在飞。旧前端认 409 加 job_id 那套提示，
           这里照旧回 409，body 里同时带上 ids 与 skipped 给新前端用。 */
        if(!$jids)res(409,['error'=>'Job already queued or running','job_id'=>$skipped?$skipped[0]['job_id']:0,'ids'=>[],'skipped'=>$skipped]);
        /* id 保留成第一个新建 job，旧前端的「已排队 job #」提示不至于变成 undefined。 */
        res(200,['ok'=>true,'ids'=>$jids,'id'=>$jids[0],'skipped'=>$skipped]);
    }
    $dup=db()->prepare("SELECT id FROM agent_jobs WHERE client_id=? AND type=? AND status IN('queued','running') LIMIT 1");
    $dup->execute([$cid,$type]);
    $d=$dup->fetch();
    if($d)res(409,['error'=>'Job already queued or running','job_id'=>(int)$d['id']]);
    $payload=$payloadIn;
    $s=db()->prepare("INSERT INTO agent_jobs(client_id,type,payload,status,created_by)VALUES(?,?,?,'queued',?)");
    $s->execute([$cid,$type,$payload===null?null:(is_string($payload)?$payload:json_encode($payload,JSON_UNESCAPED_UNICODE)),$u['username']]);
    $id=(int)db()->lastInsertId();
    audit($u['username'],'seo_job_create',(string)$id,['client_id'=>$cid,'type'=>$type,'payload'=>$payload]);
    fire_wake($id);
    res(200,['ok'=>true,'id'=>$id]);
}

// GET /jobs?client_id=&limit=
// Either layer: the console lists jobs, the triage runner reads the same history
// to work out what has been failing. The worker gets a narrower row on purpose:
//   payload is dropped, a feedback job's payload carries the client's own words
//     and the runner has no business feeding another job's raw note to a model;
//   created_by is dropped, it names a member of staff and triage never needs it.
// Everything else (type, status, timings, token_usage, log_text) is worker output
// in the first place, so reading it back exposes nothing new.
if($m==='GET'&&$ROUTE==='/jobs'){
    $a=auth_any();
    $isWorker=($a['role']==='seo_worker');
    $cid=need_client();
    $lim=(int)($_GET['limit']??30);
    if($lim<1)$lim=30;
    if($lim>200)$lim=200;
    $s=db()->prepare("SELECT * FROM agent_jobs WHERE client_id=? ORDER BY id DESC LIMIT $lim");
    $s->execute([$cid]);
    $rows=$s->fetchAll();
    foreach($rows as &$r){
        $r['token_usage']=(int)$r['token_usage'];
        if($isWorker){unset($r['payload']);unset($r['created_by']);}
        else $r['payload']=jdec($r['payload']);
    }
    unset($r);
    res(200,['jobs'=>$rows]);
}

// POST /jobs/{id}/retry -> failed jobs only, cloned as a fresh queued job
if($m==='POST'&&preg_match('#^/jobs/(\d+)/retry$#',$ROUTE,$mm)){
    $u=auth_admin();
    $jid=(int)$mm[1];
    $g=db()->prepare("SELECT * FROM agent_jobs WHERE id=?");
    $g->execute([$jid]);
    $job=$g->fetch();
    if(!$job)res(404,['error'=>'Job not found']);
    if($job['status']!=='failed')res(400,['error'=>'Only failed jobs can be retried']);
    $dup=db()->prepare("SELECT id FROM agent_jobs WHERE client_id=? AND type=? AND status IN('queued','running') LIMIT 1");
    $dup->execute([$job['client_id'],$job['type']]);
    $d=$dup->fetch();
    if($d)res(409,['error'=>'Job already queued or running','job_id'=>(int)$d['id']]);
    $s=db()->prepare("INSERT INTO agent_jobs(client_id,type,payload,status,created_by)VALUES(?,?,?,'queued',?)");
    $s->execute([$job['client_id'],$job['type'],$job['payload'],$u['username']]);
    $id=(int)db()->lastInsertId();
    audit($u['username'],'seo_job_retry',(string)$id,['from_job'=>$jid,'type'=>$job['type']]);
    fire_wake($id);
    res(200,['ok'=>true,'id'=>$id]);
}

/* ---------------- 报告 ----------------
   /reports/generate 是固定路径，必须写在 /reports/{id} 的正则之前，
   否则 generate 会掉进 {id} 分支，同 /jobs/claim 与 /jobs/{id} 的关系。 */

// POST /reports/generate -> 人在看板上点「生成月报」，排一个 type='report' 的 job。
// 与 POST /jobs 同级，去重规矩也一样：同客户同类型在跑就 409，一个客户同一时刻
// 只能有一份报告在生成。不改 POST /jobs 本体，那条路留给通用触发。
if($m==='POST'&&$ROUTE==='/reports/generate'){
    $u=auth_admin();
    ensure_reports_schema();
    /* workspace_dir 这一列是 ensure_metrics_schema() 惰性补上去的，
       没跑过它的库里直接 SELECT 会抛异常变成 500，所以先调一次。 */
    ensure_metrics_schema();
    $i=input();
    $cid=(int)($i['client_id']??0);
    if(!$cid)res(400,['error'=>'client_id required']);
    $ptype=(string)($i['period_type']??'month');
    if(!in_array($ptype,['month','quarter','week','custom'],true))res(400,['error'=>'bad period_type']);
    $ps=(string)($i['period_start']??'');
    $pe=(string)($i['period_end']??'');
    if(!ymd_ok($ps)||!ymd_ok($pe))res(400,['error'=>'period_start/period_end 必须是 YYYY-MM-DD']);
    if(strcmp($ps,$pe)>0)res(400,['error'=>'period_start 不能晚于 period_end']);
    /* 月报只出完整自然月（Alvin 2026-08-25 定）：period_end 必须是该月最后一天，
       且月末加 GSC 3 天延迟不晚于今天，否则拒绝并告知当前可出的最新月份。 */
    if($ptype==='month'){
        $lag=3;
        if($ps!==date('Y-m-01',strtotime($ps)))res(400,['error'=>'月报的 period_start 必须是当月 1 日']);
        if($pe!==date('Y-m-t',strtotime($ps)))res(400,['error'=>'月报的 period_end 必须是当月最后一天']);
        $latest=date('Y-m-t',strtotime(date('Y-m-01').' -1 day'));
        while(strtotime($latest)+$lag*86400>time()){
            $latest=date('Y-m-t',strtotime(date('Y-m-01',strtotime($latest)).' -1 day'));
        }
        if(strtotime($pe)+$lag*86400>time())res(400,['error'=>'该月尚未结束或数据尚未齐全，当前可生成的最新月份是 '.substr($latest,0,7),'latest_month'=>substr($latest,0,7)]);
    }
    /* 工作区目录是成品落地的地方，缺了 worker 领到活也只能抛错，
       与其让人去 job 日志里找原因，不如在这里就说清楚该补哪里。 */
    $pf=db()->prepare("SELECT workspace_dir FROM seo_profiles WHERE client_id=?");
    $pf->execute([$cid]);
    $prof=$pf->fetch();
    if(!$prof)res(400,['error'=>'该客户没有档案，先补档案']);
    if(trim((string)($prof['workspace_dir']??''))==='')res(400,['error'=>'档案缺 workspace_dir，先补档案']);
    $dup=db()->prepare("SELECT id FROM agent_jobs WHERE client_id=? AND type='report' AND status IN('queued','running') LIMIT 1");
    $dup->execute([$cid]);
    $d=$dup->fetch();
    if($d)res(409,['error'=>'Job already queued or running','job_id'=>(int)$d['id']]);
    $payload=['period_type'=>$ptype,'period_start'=>$ps,'period_end'=>$pe];
    if(isset($i['instructions'])&&trim((string)$i['instructions'])!=='')$payload['instructions']=(string)$i['instructions'];
    $s=db()->prepare("INSERT INTO agent_jobs(client_id,type,payload,status,created_by)VALUES(?,'report',?,'queued',?)");
    $s->execute([$cid,json_encode($payload,JSON_UNESCAPED_UNICODE),$u['username']]);
    $id=(int)db()->lastInsertId();
    audit($u['username'],'seo_report_generate',(string)$id,['client_id'=>$cid,'payload'=>$payload]);
    fire_wake($id);
    res(200,['ok'=>true,'id'=>$id]);
}

// POST /reports -> worker 把一版成品落库。version 由服务端算，不接受入参：
// 版本号是这张表的唯一真相，让 worker 自己报会在重跑时撞号。
if($m==='POST'&&$ROUTE==='/reports'){
    auth_worker();
    ensure_reports_schema();
    $i=input();
    $cid=(int)($i['client_id']??0);
    if(!$cid)res(400,['error'=>'client_id required']);
    $ptype=(string)($i['period_type']??'month');
    if(!in_array($ptype,['month','quarter','week','custom'],true))res(400,['error'=>'bad period_type']);
    $ps=(string)($i['period_start']??'');
    $pe=(string)($i['period_end']??'');
    if(!ymd_ok($ps)||!ymd_ok($pe))res(400,['error'=>'period_start/period_end 必须是 YYYY-MM-DD']);
    if(strcmp($ps,$pe)>0)res(400,['error'=>'period_start 不能晚于 period_end']);
    $url=(string)($i['url']??'');
    $hp=(string)($i['html_path']??'');
    if(trim($url)==='')res(400,['error'=>'url required']);
    if(trim($hp)==='')res(400,['error'=>'html_path required']);
    $ns=(string)($i['narrative_status']??'ok');
    if(!in_array($ns,['ok','fallback'],true))res(400,['error'=>'bad narrative_status']);
    /* facts_pack 两种形态都收：worker 直接发对象最省事，发字符串的场合
       （比如把已经写到盘上的那份原样上传）也不该被逼着解一遍再编一遍。 */
    $pack=$i['facts_pack']??null;
    if($pack!==null&&!is_string($pack))$pack=json_encode($pack,JSON_UNESCAPED_UNICODE);
    $v=db()->prepare("SELECT COALESCE(MAX(version),0)+1 AS n FROM seo_reports WHERE client_id=? AND period_type=? AND period_start=?");
    $v->execute([$cid,$ptype,$ps]);
    $ver=(int)$v->fetch()['n'];
    $s=db()->prepare("INSERT INTO seo_reports(client_id,period_type,period_start,period_end,version,url,html_path,facts_pack,narrative_status,created_by)VALUES(?,?,?,?,?,?,?,?,?,?)");
    $s->execute([$cid,$ptype,$ps,$pe,$ver,$url,$hp,$pack,$ns,(string)($i['created_by']??'seo-worker')]);
    $id=(int)db()->lastInsertId();
    audit('seo-worker','seo_report_add',(string)$id,['client_id'=>$cid,'period_start'=>$ps,'version'=>$ver,'narrative_status'=>$ns]);
    res(200,['ok'=>true,'id'=>$id,'version'=>$ver]);
}

// GET /reports?client_id= -> 列全部版本，新的周期在前、同周期新版本在前。
// facts_pack 不回传，一份 pack 几十 KB，列表拉十个版本就是几百 KB 的无用负载；
// 想看的走 GET /reports/{id}/pack，列表只回一个 has_pack 让前端知道有没有。
if($m==='GET'&&$ROUTE==='/reports'){
    auth_any();
    ensure_reports_schema();
    $cid=need_client();
    $s=db()->prepare("SELECT id,period_type,period_start,period_end,version,url,html_path,narrative_status,created_by,note,status,created_at,
                             (facts_pack IS NOT NULL AND facts_pack<>'') AS has_pack
                      FROM seo_reports WHERE client_id=?
                      ORDER BY period_start DESC, version DESC");
    $s->execute([$cid]);
    $rows=$s->fetchAll();
    foreach($rows as &$r){
        $r['id']=(int)$r['id'];
        $r['version']=(int)$r['version'];
        $r['has_pack']=(bool)$r['has_pack'];
    }
    unset($r);
    res(200,['ok'=>true,'reports'=>$rows]);
}

// GET /reports/{id}/pack -> 单独取 facts pack。固定后缀 /pack 的正则写在
// PATCH /reports/{id} 之前，方法本来就不同，顺序只是照这个文件的惯例来。
if($m==='GET'&&preg_match('#^/reports/(\d+)/pack$#',$ROUTE,$mm)){
    auth_any();
    ensure_reports_schema();
    $rid=(int)$mm[1];
    $g=db()->prepare("SELECT id,facts_pack FROM seo_reports WHERE id=?");
    $g->execute([$rid]);
    $row=$g->fetch();
    if(!$row)res(404,['error'=>'Report not found']);
    res(200,['ok'=>true,'id'=>(int)$row['id'],'facts_pack'=>jdec($row['facts_pack'])]);
}

// PATCH /reports/{id} -> 人加一句备注、或标记已发送。只有这两个字段可改：
// 周期、版本、链接都是生成时的事实，改它们等于伪造，要换内容就再生成一版。
if($m==='PATCH'&&preg_match('#^/reports/(\d+)$#',$ROUTE,$mm)){
    $u=auth_admin();
    ensure_reports_schema();
    $rid=(int)$mm[1];
    $i=input();
    $chk=db()->prepare("SELECT id FROM seo_reports WHERE id=?");
    $chk->execute([$rid]);
    if(!$chk->fetch())res(404,['error'=>'Report not found']);
    $sets=[];$args=[];
    if(isset($i['status'])){
        if(!in_array($i['status'],['draft','sent'],true))res(400,['error'=>'bad status']);
        $sets[]='status=?';$args[]=$i['status'];
    }
    if(isset($i['note'])){$sets[]='note=?';$args[]=(string)$i['note'];}
    if(!$sets)res(400,['error'=>'nothing to update']);
    $args[]=$rid;
    db()->prepare("UPDATE seo_reports SET ".implode(',',$sets)." WHERE id=?")->execute($args);
    audit($u['username'],'seo_report_update',(string)$rid,$i);
    res(200,['ok'=>true]);
}

res(404,['error'=>'Not found','route'=>$ROUTE]);
