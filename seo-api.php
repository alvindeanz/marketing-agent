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

/* Every value seo_snapshots.source is allowed to take. One list, used by the
   routes for validation and by ensure_snapshot_sources() for the ENUM widen,
   so the two can never drift apart. Append only, never reorder or remove:
   dropping a value here would make the ALTER truncate existing rows. */
define('SNAPSHOT_SOURCES',['ga4','gsc','semrush','discovery','content_registry']);

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
    $want=['discover','pull_data','plan','execute_task','apply_task','report','feedback','triage'];
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

$PROFILE_FIELDS=['platform','domain','ga4_property','gsc_property','semrush_project','business_goals','conversion_goals','notes'];

/* =========================================================
   Worker endpoints (service token)
   Declared first so /jobs/claim never falls into /jobs/{id}.
   ========================================================= */

// POST /jobs/claim -> one queued job, flipped to running.
// Optimistic lock, not SELECT ... FOR UPDATE SKIP LOCKED: production runs
// MariaDB 10.3, and SKIP LOCKED only landed in MariaDB 10.6.
// The conditional UPDATE is the whole race guard; single worker today, so
// three retries are plenty.
if($m==='POST'&&$ROUTE==='/jobs/claim'){
    auth_worker();
    $jid=0;
    $pick=db()->prepare("SELECT id FROM agent_jobs WHERE status='queued' ORDER BY id LIMIT 1");
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

// PATCH /jobs/{id} -> worker progress: status / log_append / token_usage
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
    res(200,['ok'=>true]);
}

// POST /tasks/{id}/complete -> apply stage finished, task is done for real
if($m==='POST'&&preg_match('#^/tasks/(\d+)/complete$#',$ROUTE,$mm)){
    auth_worker();
    $tid=(int)$mm[1];
    $i=input();
    $chk=db()->prepare("SELECT id FROM seo_tasks WHERE id=?");
    $chk->execute([$tid]);
    if(!$chk->fetch())res(404,['error'=>'Task not found']);
    db()->prepare("UPDATE seo_tasks SET status='done' WHERE id=?")->execute([$tid]);
    $note=trim((string)($i['note']??''));
    if($note!==''){
        db()->prepare("UPDATE seo_tasks SET result_note=CONCAT_WS('\n',NULLIF(result_note,''),?) WHERE id=?")
            ->execute(['[applied] '.$note,$tid]);
    }
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
        db()->prepare("UPDATE seo_tasks SET status='done' WHERE id=?")->execute([$tid]);
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
    $rows=$i['tasks']??null;
    if(!is_array($rows)||!$rows)res(400,['error'=>'tasks required']);
    if(count($rows)>20)res(400,['error'=>'batch too large, max 20 tasks']);
    $clean=[];
    foreach(array_values($rows) as $n=>$t){
        if(!is_array($t))res(400,['error'=>"task #$n: not an object"]);
        $title=trim((string)($t['title']??''));
        if($title==='')res(400,['error'=>"task #$n: title required"]);
        if(mb_strlen($title,'UTF-8')>255)res(400,['error'=>"task #$n: title over 255 chars"]);
        $mod=(string)($t['module']??'');
        if(!in_array($mod,['technical','onpage','content','local','offpage'],true))res(400,['error'=>"task #$n: bad module"]);
        $own=(string)($t['owner_type']??'');
        if(!in_array($own,['agency','client','agent'],true))res(400,['error'=>"task #$n: bad owner_type"]);
        $sprint=(string)($t['sprint']??'');
        if(mb_strlen($sprint,'UTF-8')>10)res(400,['error'=>"task #$n: sprint over 10 chars"]);
        $pri=(string)($t['priority']??'P2');
        if($pri==='')$pri='P2';
        if(!in_array($pri,['P0','P1','P2','P3'],true))res(400,['error'=>"task #$n: bad priority"]);
        $ops=(string)($t['ops']??'');
        if(mb_strlen($ops,'UTF-8')>255)res(400,['error'=>"task #$n: ops over 255 chars"]);
        $att=empty($t['attention'])?0:1;
        $clean[]=[$cid,$pid,$sprint,$mod,$title,(string)($t['detail']??''),$own,$pri,$att,$ops];
    }
    $p=db();
    $ids=[];
    $p->beginTransaction();
    try{
        $ins=$p->prepare("INSERT INTO seo_tasks(client_id,plan_id,sprint,module,title,detail,owner_type,priority,attention,ops,status,created_by)VALUES(?,?,?,?,?,?,?,?,?,?,'proposed','seo-worker')");
        foreach($clean as $row){$ins->execute($row);$ids[]=(int)$p->lastInsertId();}
        $p->commit();
    }catch(Exception $e){
        if($p->inTransaction())$p->rollBack();
        res(500,['error'=>'bulk insert failed']);
    }
    audit('seo-worker','seo_tasks_bulk',(string)$cid,['plan_id'=>$pid,'count'=>count($ids),'ids'=>$ids]);
    res(200,['ok'=>true,'ids'=>$ids]);
}

// GET /context?client_id= -> single briefing payload for the LLM runner
if($m==='GET'&&$ROUTE==='/context'){
    auth_worker();
    $cid=need_client();
    $pf=db()->prepare("SELECT * FROM seo_profiles WHERE client_id=?");
    $pf->execute([$cid]);
    $profile=$pf->fetch();
    if($profile)$profile['target_keywords']=jdec($profile['target_keywords']);

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
   Dashboard endpoints (admin JWT)
   ========================================================= */

// GET /clients -> console sidebar: every onboarded client plus its counters
if($m==='GET'&&$ROUTE==='/clients'){
    auth_admin();
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
    foreach($rows as &$r){
        $id=$r['client_id'];
        $r['client_id']=(int)$id;
        $r['tasks_open']=$tasks[$id]??0;
        $r['facts_pending']=$facts[$id]??0;
        $r['active_plan_version']=isset($plans[$id])?$plans[$id]:null;
        $r['last_job_at']=$jobs[$id]??null;
    }
    unset($r);
    res(200,['clients'=>$rows]);
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

    $sql="INSERT INTO seo_profiles(client_id,platform,domain,ga4_property,gsc_property,semrush_project,target_keywords,business_goals,conversion_goals,notes,status,report_lang)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE platform=VALUES(platform),domain=VALUES(domain),ga4_property=VALUES(ga4_property),
            gsc_property=VALUES(gsc_property),semrush_project=VALUES(semrush_project),target_keywords=VALUES(target_keywords),
            business_goals=VALUES(business_goals),conversion_goals=VALUES(conversion_goals),notes=VALUES(notes),
            status=VALUES(status),report_lang=VALUES(report_lang)";
    db()->prepare($sql)->execute([
        $cid,$vals['platform'],$vals['domain'],$vals['ga4_property'],$vals['gsc_property'],
        $vals['semrush_project'],$kwJson,$vals['business_goals'],$vals['conversion_goals'],$vals['notes'],$st,$lang
    ]);
    audit($u['username'],'seo_profile_save',(string)$cid,['domain'=>$vals['domain'],'status'=>$st,'report_lang'=>$lang]);
    res(200,['ok'=>true]);
}

// GET /plans?client_id=
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
    $excluded=$total-$approved;
    if($excluded<0)$excluded=0;
    audit($u['username'],'seo_plan_approve',(string)$pid,['client_id'=>(int)$plan['client_id'],'approved_count'=>$approved,'excluded_count'=>$excluded]);
    res(200,['ok'=>true,'approved_count'=>$approved,'excluded_count'=>$excluded]);
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
    $dup=db()->prepare("SELECT id FROM agent_jobs WHERE client_id=? AND type='apply_task' AND status IN('queued','running') LIMIT 1");
    $dup->execute([$cid]);
    $d=$dup->fetch();
    if($d)res(409,['error'=>'Apply job already queued or running','job_id'=>(int)$d['id']]);
    $s=db()->prepare("INSERT INTO agent_jobs(client_id,type,payload,status,created_by)VALUES(?,'apply_task',?,'queued',?)");
    $s->execute([$cid,json_encode(['task_ids'=>$ids],JSON_UNESCAPED_UNICODE),$u['username']]);
    $jid=(int)db()->lastInsertId();
    audit($u['username'],'seo_tasks_release',(string)$cid,['job_id'=>$jid,'task_ids'=>$ids]);
    fire_wake($jid);
    res(200,['ok'=>true,'job_id'=>$jid,'count'=>count($ids)]);
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
    res(200,[
        'flagged_tasks'=>$ft->fetchAll(),
        'client_open'=>$co->fetchAll(),
        'failed_jobs'=>$jobs,
        'pending_facts_count'=>(int)$pf->fetch()['n']
    ]);
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
    audit($u['username'],'seo_plan_reject',(string)$pid,['client_id'=>(int)$plan['client_id'],'reason'=>$reason]);
    res(200,['ok'=>true]);
}

// GET /tasks?client_id=
if($m==='GET'&&$ROUTE==='/tasks'){
    auth_admin();
    $cid=need_client();
    $s=db()->prepare("SELECT * FROM seo_tasks WHERE client_id=? ORDER BY FIELD(owner_type,'agency','client','agent'),FIELD(status,'proposed','approved','in_progress','review','blocked','done'),FIELD(priority,'P0','P1','P2','P3'),id");
    $s->execute([$cid]);
    res(200,['tasks'=>$s->fetchAll()]);
}

// POST /tasks
if($m==='POST'&&$ROUTE==='/tasks'){
    $u=auth_admin();
    $i=input();
    $cid=(int)($i['client_id']??0);
    $title=trim((string)($i['title']??''));
    if(!$cid)res(400,['error'=>'client_id required']);
    if($title==='')res(400,['error'=>'title required']);
    $mod=(string)($i['module']??'technical');
    if(!in_array($mod,['technical','onpage','content','local','offpage'],true))res(400,['error'=>'bad module']);
    $own=(string)($i['owner_type']??'agency');
    if(!in_array($own,['agency','client','agent'],true))res(400,['error'=>'bad owner_type']);
    $st=(string)($i['status']??'proposed');
    if(!in_array($st,['proposed','approved','in_progress','review','done','blocked'],true))res(400,['error'=>'bad status']);
    $pri=(string)($i['priority']??'P2');
    if($pri==='')$pri='P2';
    if(!in_array($pri,['P0','P1','P2','P3'],true))res(400,['error'=>'bad priority']);
    $ops=(string)($i['ops']??'');
    if(mb_strlen($ops,'UTF-8')>255)res(400,['error'=>'ops over 255 chars']);
    $s=db()->prepare("INSERT INTO seo_tasks(client_id,plan_id,sprint,module,title,detail,owner_type,priority,attention,ops,status,output_url,created_by)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)");
    $s->execute([
        $cid,
        ($i['plan_id']??null)?(int)$i['plan_id']:null,
        (string)($i['sprint']??''),
        $mod,$title,
        (string)($i['detail']??''),
        $own,$pri,
        empty($i['attention'])?0:1,
        $ops,$st,
        (string)($i['output_url']??''),
        $u['username']
    ]);
    $id=(int)db()->lastInsertId();
    audit($u['username'],'seo_task_add',(string)$id,['client_id'=>$cid,'title'=>$title,'owner_type'=>$own]);
    res(200,['ok'=>true,'id'=>$id]);
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
if($m==='POST'&&$ROUTE==='/jobs'){
    $u=auth_admin();
    $i=input();
    $cid=(int)($i['client_id']??0);
    $type=(string)($i['type']??'');
    if(!$cid)res(400,['error'=>'client_id required']);
    /* feedback is here so a stuck note can be re-queued by hand; the normal
       path is POST /tasks/{id}/feedback, which also writes the seo_feedback row.
       triage is read only: it looks at everything and writes a report, nothing else. */
    if(!in_array($type,['discover','pull_data','plan','execute_task','report','feedback','triage'],true))res(400,['error'=>'bad type']);
    if($type==='feedback')ensure_feedback_schema();
    if($type==='triage')ensure_job_types();
    $dup=db()->prepare("SELECT id FROM agent_jobs WHERE client_id=? AND type=? AND status IN('queued','running') LIMIT 1");
    $dup->execute([$cid,$type]);
    $d=$dup->fetch();
    if($d)res(409,['error'=>'Job already queued or running','job_id'=>(int)$d['id']]);
    $payload=$i['payload']??null;
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

res(404,['error'=>'Not found','route'=>$ROUTE]);
