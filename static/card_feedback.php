<?php
/* 方向卡反馈同源中继（2026-09-08，部署在 agencyreport/blogpreview webroot）。
   背景：对客方向卡挂公网 agencyreport，反馈端点在内部看板域（外网不可达，也不该开放）。
   页面同源 POST 到这里，服务器本机转发给 seo-api 的 /card_feedback。
   这里不做鉴权：上游端点自己校验 task_id+token（hash_equals），本文件只是通路，
   转发目标写死单一路径，不透传任何其他 API。 */
header('Content-Type: application/json');
if(($_SERVER['REQUEST_METHOD']??'')!=='POST'){http_response_code(405);echo '{"error":"POST only"}';exit;}
$raw=file_get_contents('php://input');
if($raw===false||strlen($raw)>10000){http_response_code(413);echo '{"error":"body too large"}';exit;}
$in=json_decode($raw,true);
if(!is_array($in)||!isset($in['task_id'],$in['token'])){http_response_code(400);echo '{"error":"bad body"}';exit;}
$ch=curl_init('https://always.horntech-dev.com/seo-api.php/card_feedback');
curl_setopt_array($ch,[
    CURLOPT_POST=>true,
    CURLOPT_POSTFIELDS=>$raw,
    CURLOPT_HTTPHEADER=>['Content-Type: application/json'],
    CURLOPT_RETURNTRANSFER=>true,
    CURLOPT_TIMEOUT=>10,
]);
$out=curl_exec($ch);
$code=(int)curl_getinfo($ch,CURLINFO_HTTP_CODE);
if($out===false){http_response_code(502);echo json_encode(['error'=>'upstream unreachable']);exit;}
http_response_code($code?:502);
echo $out;
