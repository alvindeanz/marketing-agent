#!/usr/bin/env python3
"""Google Ads 白名单 mutate 执行器，apply adapter 的唯一写通道。零 LLM 判断，全参数化。
用法: ads_mutate.py <customer_id> --op <操作> [参数] [--dry-run]
操作白名单（specs/capabilities/googleads.md V3）:
  final-url-change     --ad-id N --new-url URL           改既有 ad 的 final URL（旧值先打印再改）
  ad-pause             --ad-group-id N --ad-id N          暂停单条 ad
  adgroup-pause        --ad-group-id N                    暂停单个 ad group
  keyword-pause        --criterion-resource RES           暂停单个关键词（只停不删）
  negative-keyword-add --level adgroup|campaign --target-id N --text 词 --match broad|phrase|exact
  keyword-bid-adjust   --criterion-resource RES --new-bid-micros N   （幅度硬闸 ±20%）
  adgroup-create       --spec - 从 stdin 读 JSON 建组单（structural，预算中性：不动 campaign 预算与出价策略。
                       流程：查重名拒重复 → 建 PAUSED 组 → 录词/否词/RSA → 逐项回读核数 → 全对才 ENABLED，
                       任何一步不符即停在 PAUSED 并打印已建内容，绝不半开着投放）
  rsa-copy-update      --spec - 从 stdin 读 JSON（external：改既有 RSA 的标题与描述，全量替换语义。
                       spec: {ad_id, headlines:[{text,pin?}], descriptions:[{text}]}，给的是改后的完整集合。
                       流程：读原文案全套打印（回滚依据）→ 校验条数/字符/pin → 与原集合相同则 noop →
                       mutate 手写 mask → 回读逐条比对。注意：文案更新会触发广告重审）
  keyword-add          --ad-group-id N --text 词 --match broad|phrase|exact [--final-url URL] [--cpc-bid-micros N]
                       （structural：往既有组加正向词，预算中性但扩大触发面。查重拒绝同词同匹配重复，
                       建 ENABLED 后回读验证；--final-url 顺带设关键词级最终到达网址）
  keyword-final-url    --criterion-resource RES --new-url URL   给既有关键词设关键词级 final URL（旧值先打印再改）
  ad-create            --spec - 从 stdin 读 JSON 在既有组新建一条 RSA（structural：不动预算与既有广告。
                       spec: {ad_group_id, final_url, path1?, path2?, headlines:[{text,pin?}], descriptions:[{text}]}。
                       流程：查组在且组内非移除广告少于 3 条 → 校验文案 → 创建 → 回读验证。新广告会进审核）
  schedule-adjust      未实现，直接拒，转人工
铁律（脚本硬闸，不靠调用方自觉）:
  - 改前必查旧值并打印（JSON 行，回滚依据）；mutate 后回读验证并打印新值。
  - update_mask 全部手写字段名，不用 protobuf_helpers 自动推（默认值字段会漏，2026-08-10 事故）。
  - pause 类操作先查 campaign 学习期，处于学习期拒绝（学习期内不下杀）。
  - bid 调整超 ±20% 拒绝。
  - --dry-run 只打印将要提交的内容，不发写请求。
输出: JSON 行。成功最后一行 {"ok": true, ...}；拒绝/失败 {"ok": false, "error": "..."} 且退出码非 0。
凭据: /data/aira/.env.google-ads（MCC master，login-customer-id 恒为 MCC）。"""
import argparse
import json
import os
import sys

ENV_FILE = "/data/aira/.env.google-ads"
OPS = ["final-url-change", "ad-pause", "adgroup-pause", "keyword-pause", "negative-keyword-add",
       "keyword-bid-adjust", "adgroup-create", "rsa-copy-update", "keyword-add", "keyword-final-url",
       "ad-create", "schedule-adjust"]
MATCH_TYPES = {"broad": "BROAD", "phrase": "PHRASE", "exact": "EXACT",
               "BROAD": "BROAD", "PHRASE": "PHRASE", "EXACT": "EXACT"}


def out(obj):
    print(json.dumps(obj, ensure_ascii=False))


def die(msg, code=2):
    out({"ok": False, "error": msg})
    sys.exit(code)


def load_env():
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k, v)


def make_client():
    load_env()
    import warnings
    warnings.filterwarnings("ignore")
    from google.ads.googleads.client import GoogleAdsClient
    cfg = {
        "developer_token": os.environ["GOOGLE_ADS_DEVELOPER_TOKEN"],
        "client_id": os.environ["GOOGLE_ADS_CLIENT_ID"],
        "client_secret": os.environ["GOOGLE_ADS_CLIENT_SECRET"],
        "refresh_token": os.environ["GOOGLE_ADS_REFRESH_TOKEN"],
        "login_customer_id": os.environ["GOOGLE_ADS_MCC_ID"].replace("-", ""),
        "use_proto_plus": True,
    }
    return GoogleAdsClient.load_from_dict(cfg)


def gaql(client, cid, query):
    svc = client.get_service("GoogleAdsService")
    rows = []
    for batch in svc.search_stream(customer_id=cid, query=query):
        for row in batch.results:
            rows.append(row)
    return rows


def field_mask(paths):
    from google.protobuf import field_mask_pb2
    fm = field_mask_pb2.FieldMask()
    fm.paths.extend(paths)
    return fm


def campaign_learning(client, cid, campaign_id):
    """学习期判定：campaign primary_status_reasons 含 LEARNING 系即算。"""
    rows = gaql(client, cid,
                "SELECT campaign.id, campaign.primary_status, campaign.primary_status_reasons "
                "FROM campaign WHERE campaign.id = " + str(int(campaign_id)))
    if not rows:
        return False
    reasons = [str(r) for r in rows[0].campaign.primary_status_reasons]
    return any("LEARNING" in r for r in reasons)


def op_final_url_change(client, cid, args):
    if not args.ad_id or not args.new_url:
        die("final-url-change 需要 --ad-id 与 --new-url")
    if not args.new_url.startswith("https://"):
        die("new-url 必须是 https 绝对地址")
    rows = gaql(client, cid,
                "SELECT ad_group_ad.ad.id, ad_group_ad.ad.final_urls, ad_group_ad.status, "
                "ad_group.id, campaign.id FROM ad_group_ad WHERE ad_group_ad.ad.id = " + str(int(args.ad_id)))
    if not rows:
        die("ad " + str(args.ad_id) + " 不存在")
    old_urls = list(rows[0].ad_group_ad.ad.final_urls)
    out({"step": "before", "op": "final-url-change", "ad_id": args.ad_id, "old_final_urls": old_urls})
    if old_urls == [args.new_url]:
        out({"ok": True, "noop": True, "note": "final_urls 已是目标值，零改动"})
        return
    if args.dry_run:
        out({"ok": True, "dry_run": True, "would_set": [args.new_url]})
        return
    svc = client.get_service("AdService")
    op = client.get_type("AdOperation")
    op.update.resource_name = svc.ad_path(cid, int(args.ad_id))
    del op.update.final_urls[:]
    op.update.final_urls.append(args.new_url)
    op.update_mask.CopyFrom(field_mask(["final_urls"]))
    svc.mutate_ads(customer_id=cid, operations=[op])
    rows2 = gaql(client, cid,
                 "SELECT ad_group_ad.ad.final_urls FROM ad_group_ad WHERE ad_group_ad.ad.id = " + str(int(args.ad_id)))
    new_urls = list(rows2[0].ad_group_ad.ad.final_urls) if rows2 else []
    if new_urls != [args.new_url]:
        die("回读验证失败：期望 [" + args.new_url + "]，读到 " + json.dumps(new_urls))
    out({"ok": True, "op": "final-url-change", "ad_id": args.ad_id,
         "old_final_urls": old_urls, "new_final_urls": new_urls, "budget_impact": 0})


def op_ad_pause(client, cid, args):
    if not args.ad_group_id or not args.ad_id:
        die("ad-pause 需要 --ad-group-id 与 --ad-id")
    rows = gaql(client, cid,
                "SELECT ad_group_ad.status, campaign.id FROM ad_group_ad "
                "WHERE ad_group.id = " + str(int(args.ad_group_id)) +
                " AND ad_group_ad.ad.id = " + str(int(args.ad_id)))
    if not rows:
        die("ad 不存在")
    if campaign_learning(client, cid, rows[0].campaign.id):
        die("目标 campaign 处于学习期，暂停动作拒绝执行（学习期内不下杀）")
    old = str(rows[0].ad_group_ad.status)
    out({"step": "before", "op": "ad-pause", "old_status": old})
    if args.dry_run:
        out({"ok": True, "dry_run": True, "would_set": "PAUSED"})
        return
    svc = client.get_service("AdGroupAdService")
    op = client.get_type("AdGroupAdOperation")
    op.update.resource_name = svc.ad_group_ad_path(cid, int(args.ad_group_id), int(args.ad_id))
    op.update.status = client.enums.AdGroupAdStatusEnum.PAUSED
    op.update_mask.CopyFrom(field_mask(["status"]))
    svc.mutate_ad_group_ads(customer_id=cid, operations=[op])
    out({"ok": True, "op": "ad-pause", "old_status": old, "new_status": "PAUSED", "budget_impact": 0})


def op_adgroup_pause(client, cid, args):
    if not args.ad_group_id:
        die("adgroup-pause 需要 --ad-group-id")
    rows = gaql(client, cid,
                "SELECT ad_group.status, campaign.id FROM ad_group WHERE ad_group.id = " + str(int(args.ad_group_id)))
    if not rows:
        die("ad group 不存在")
    if campaign_learning(client, cid, rows[0].campaign.id):
        die("目标 campaign 处于学习期，暂停动作拒绝执行（学习期内不下杀）")
    old = str(rows[0].ad_group.status)
    out({"step": "before", "op": "adgroup-pause", "old_status": old})
    if args.dry_run:
        out({"ok": True, "dry_run": True, "would_set": "PAUSED"})
        return
    svc = client.get_service("AdGroupService")
    op = client.get_type("AdGroupOperation")
    op.update.resource_name = svc.ad_group_path(cid, int(args.ad_group_id))
    op.update.status = client.enums.AdGroupStatusEnum.PAUSED
    op.update_mask.CopyFrom(field_mask(["status"]))
    svc.mutate_ad_groups(customer_id=cid, operations=[op])
    out({"ok": True, "op": "adgroup-pause", "old_status": old, "new_status": "PAUSED", "budget_impact": 0})


def op_negative_keyword_add(client, cid, args):
    if args.level not in ("adgroup", "campaign") or not args.target_id or not args.text:
        die("negative-keyword-add 需要 --level adgroup|campaign --target-id --text")
    match = {"broad": "BROAD", "phrase": "PHRASE", "exact": "EXACT"}.get(args.match or "broad")
    if not match:
        die("match 只认 broad|phrase|exact")
    out({"step": "before", "op": "negative-keyword-add", "level": args.level,
         "target_id": args.target_id, "text": args.text, "match": match})
    if args.dry_run:
        out({"ok": True, "dry_run": True})
        return
    if args.level == "adgroup":
        svc = client.get_service("AdGroupCriterionService")
        op = client.get_type("AdGroupCriterionOperation")
        c = op.create
        c.ad_group = client.get_service("AdGroupService").ad_group_path(cid, int(args.target_id))
        c.negative = True
        c.keyword.text = args.text
        c.keyword.match_type = getattr(client.enums.KeywordMatchTypeEnum, match)
        res = svc.mutate_ad_group_criteria(customer_id=cid, operations=[op])
    else:
        svc = client.get_service("CampaignCriterionService")
        op = client.get_type("CampaignCriterionOperation")
        c = op.create
        c.campaign = client.get_service("CampaignService").campaign_path(cid, int(args.target_id))
        c.negative = True
        c.keyword.text = args.text
        c.keyword.match_type = getattr(client.enums.KeywordMatchTypeEnum, match)
        res = svc.mutate_campaign_criteria(customer_id=cid, operations=[op])
    out({"ok": True, "op": "negative-keyword-add", "resource_name": res.results[0].resource_name,
         "budget_impact": 0})


def op_keyword_pause(client, cid, args):
    if not args.criterion_resource:
        die("keyword-pause 需要 --criterion-resource")
    res_name = args.criterion_resource.replace("'", "")
    rows = gaql(client, cid,
                "SELECT ad_group_criterion.status, ad_group_criterion.keyword.text "
                "FROM ad_group_criterion WHERE ad_group_criterion.resource_name = '" + res_name + "'")
    if not rows:
        die("criterion 不存在")
    old = str(rows[0].ad_group_criterion.status)
    kw = rows[0].ad_group_criterion.keyword.text
    out({"step": "before", "op": "keyword-pause", "keyword": kw, "old_status": old})
    if old == "PAUSED":
        out({"ok": True, "noop": True, "note": "关键词已是 PAUSED，零改动"})
        return
    if args.dry_run:
        out({"ok": True, "dry_run": True, "would_set": "PAUSED"})
        return
    svc = client.get_service("AdGroupCriterionService")
    op = client.get_type("AdGroupCriterionOperation")
    op.update.resource_name = res_name
    op.update.status = client.enums.AdGroupCriterionStatusEnum.PAUSED
    op.update_mask.CopyFrom(field_mask(["status"]))
    svc.mutate_ad_group_criteria(customer_id=cid, operations=[op])
    rows2 = gaql(client, cid,
                 "SELECT ad_group_criterion.status FROM ad_group_criterion WHERE ad_group_criterion.resource_name = '" + res_name + "'")
    new = str(rows2[0].ad_group_criterion.status) if rows2 else ""
    if "PAUSED" not in new:
        die("回读验证失败：期望 PAUSED，读到 " + new)
    out({"ok": True, "op": "keyword-pause", "keyword": kw, "old_status": old, "new_status": "PAUSED",
         "budget_impact": 0})


def _adgroup_create_validate(spec):
    """建组单硬校验，返回错误串或 None。上限按 Google RSA 与常识：词 1 到 40，RSA 3 到 15 标题 2 到 4 描述。"""
    if not isinstance(spec, dict):
        return "spec 不是 JSON 对象"
    if not spec.get("campaign_id"):
        return "spec 缺 campaign_id"
    name = str(spec.get("name") or "").strip()
    if not name:
        return "spec 缺 name"
    kws = spec.get("keywords") or []
    if not (1 <= len(kws) <= 40):
        return "keywords 数量须在 1 到 40"
    for k in kws:
        if not str(k.get("text") or "").strip() or str(k.get("match") or "") not in MATCH_TYPES:
            return "keyword 缺 text 或 match 非法: " + json.dumps(k, ensure_ascii=False)
    for n in spec.get("negatives") or []:
        if not str(n.get("text") or "").strip() or str(n.get("match") or "") not in MATCH_TYPES:
            return "negative 缺 text 或 match 非法: " + json.dumps(n, ensure_ascii=False)
    rsa = spec.get("rsa") or {}
    url = str(rsa.get("final_url") or "")
    if not url.startswith("https://"):
        return "rsa.final_url 必须是 https 绝对地址"
    hs = rsa.get("headlines") or []
    ds = rsa.get("descriptions") or []
    if not (3 <= len(hs) <= 15):
        return "rsa.headlines 数量须在 3 到 15"
    if not (2 <= len(ds) <= 4):
        return "rsa.descriptions 数量须在 2 到 4"
    for h in hs:
        t = str(h.get("text") or "")
        if not t or len(t) > 30:
            return "headline 为空或超 30 字符: " + t
        if h.get("pin") not in (None, 1, 2, 3):
            return "headline pin 只认 1/2/3"
    for d in ds:
        t = str(d.get("text") or "")
        if not t or len(t) > 90:
            return "description 为空或超 90 字符: " + t
    return None


def op_adgroup_create(client, cid, args):
    raw = sys.stdin.read() if (args.spec or "") == "-" else None
    if raw is None:
        die("adgroup-create 需要 --spec -（建组单 JSON 走 stdin）")
    try:
        spec = json.loads(raw)
    except Exception as e:
        die("spec JSON 解析失败: " + str(e)[:200])
    err = _adgroup_create_validate(spec)
    if err:
        die("建组单校验不过: " + err)
    campaign_id = int(spec["campaign_id"])
    name = str(spec["name"]).strip()
    kws = spec["keywords"]
    negs = spec.get("negatives") or []
    rsa = spec["rsa"]
    rows = gaql(client, cid,
                "SELECT campaign.id, campaign.name, campaign.status FROM campaign WHERE campaign.id = " + str(campaign_id))
    if not rows:
        die("campaign " + str(campaign_id) + " 不存在")
    out({"step": "campaign", "id": campaign_id, "name": rows[0].campaign.name, "status": str(rows[0].campaign.status),
         "note": "本操作不动 campaign 预算与出价策略，预算中性"})
    dup = gaql(client, cid,
               "SELECT ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE campaign.id = " + str(campaign_id) +
               " AND ad_group.status != 'REMOVED'")
    for r in dup:
        if r.ad_group.name.strip().lower() == name.lower():
            die("同名 ad group 已存在（id " + str(r.ad_group.id) + "，status " + str(r.ad_group.status) + "），拒绝重复建组")
    plan = {"create": name, "keywords": len(kws), "negatives": len(negs),
            "rsa_headlines": len(rsa["headlines"]), "rsa_descriptions": len(rsa["descriptions"]),
            "final_url": rsa["final_url"], "cpc_bid_micros": spec.get("cpc_bid_micros")}
    if args.dry_run:
        out({"ok": True, "dry_run": True, "would_create": plan})
        return
    # 1. 建 PAUSED 组：装配全对之前一秒都不投放。
    ag_svc = client.get_service("AdGroupService")
    ag_op = client.get_type("AdGroupOperation")
    ag = ag_op.create
    ag.name = name
    ag.campaign = client.get_service("CampaignService").campaign_path(cid, campaign_id)
    ag.status = client.enums.AdGroupStatusEnum.PAUSED
    ag.type_ = client.enums.AdGroupTypeEnum.SEARCH_STANDARD
    if spec.get("cpc_bid_micros"):
        ag.cpc_bid_micros = int(spec["cpc_bid_micros"])
    ag_res = ag_svc.mutate_ad_groups(customer_id=cid, operations=[ag_op])
    ag_rn = ag_res.results[0].resource_name
    out({"step": "adgroup_created_paused", "resource_name": ag_rn})
    # 2. 词与否词
    cr_svc = client.get_service("AdGroupCriterionService")
    cr_ops = []
    for k in kws:
        o = client.get_type("AdGroupCriterionOperation")
        c = o.create
        c.ad_group = ag_rn
        c.status = client.enums.AdGroupCriterionStatusEnum.ENABLED
        c.keyword.text = str(k["text"]).strip()
        c.keyword.match_type = getattr(client.enums.KeywordMatchTypeEnum, MATCH_TYPES[str(k["match"])])
        cr_ops.append(o)
    for n in negs:
        o = client.get_type("AdGroupCriterionOperation")
        c = o.create
        c.ad_group = ag_rn
        c.negative = True
        c.keyword.text = str(n["text"]).strip()
        c.keyword.match_type = getattr(client.enums.KeywordMatchTypeEnum, MATCH_TYPES[str(n["match"])])
        cr_ops.append(o)
    cr_svc.mutate_ad_group_criteria(customer_id=cid, operations=cr_ops)
    out({"step": "criteria_created", "keywords": len(kws), "negatives": len(negs)})
    # 3. RSA
    ada_svc = client.get_service("AdGroupAdService")
    ada_op = client.get_type("AdGroupAdOperation")
    ada = ada_op.create
    ada.ad_group = ag_rn
    ada.status = client.enums.AdGroupAdStatusEnum.ENABLED
    ada.ad.final_urls.append(rsa["final_url"])
    if rsa.get("path1"):
        ada.ad.responsive_search_ad.path1 = str(rsa["path1"])[:15]
    if rsa.get("path2"):
        ada.ad.responsive_search_ad.path2 = str(rsa["path2"])[:15]
    for h in rsa["headlines"]:
        a = client.get_type("AdTextAsset")
        a.text = str(h["text"])
        if h.get("pin") in (1, 2, 3):
            a.pinned_field = getattr(client.enums.ServedAssetFieldTypeEnum, "HEADLINE_" + str(h["pin"]))
        ada.ad.responsive_search_ad.headlines.append(a)
    for d in rsa["descriptions"]:
        a = client.get_type("AdTextAsset")
        a.text = str(d["text"])
        ada.ad.responsive_search_ad.descriptions.append(a)
    ada_res = ada_svc.mutate_ad_group_ads(customer_id=cid, operations=[ada_op])
    out({"step": "rsa_created", "resource_name": ada_res.results[0].resource_name})
    # 4. 回读核数，全对才启用
    ag_id = int(ag_rn.split("/")[-1])
    kc = gaql(client, cid, "SELECT ad_group_criterion.criterion_id, ad_group_criterion.negative FROM ad_group_criterion "
              "WHERE ad_group.id = " + str(ag_id) + " AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'")
    got_kw = sum(1 for r in kc if not r.ad_group_criterion.negative)
    got_neg = sum(1 for r in kc if r.ad_group_criterion.negative)
    ac = gaql(client, cid, "SELECT ad_group_ad.ad.id FROM ad_group_ad WHERE ad_group.id = " + str(ag_id) + " AND ad_group_ad.status != 'REMOVED'")
    if got_kw != len(kws) or got_neg != len(negs) or len(ac) != 1:
        die("回读核数不符（词 " + str(got_kw) + "/" + str(len(kws)) + "，否词 " + str(got_neg) + "/" + str(len(negs)) +
            "，广告 " + str(len(ac)) + "/1），组保持 PAUSED 不启用，人工核对 " + ag_rn, 1)
    en_op = client.get_type("AdGroupOperation")
    en_op.update.resource_name = ag_rn
    en_op.update.status = client.enums.AdGroupStatusEnum.ENABLED
    en_op.update_mask.CopyFrom(field_mask(["status"]))
    ag_svc.mutate_ad_groups(customer_id=cid, operations=[en_op])
    out({"ok": True, "op": "adgroup-create", "resource_name": ag_rn, "ad_group_id": ag_id,
         "keywords": got_kw, "negatives": got_neg, "ads": 1, "enabled": True,
         "budget_impact": "0（campaign 预算与出价策略未动，预算中性新建）"})


def _rsa_texts_validate(hs, ds):
    if not (3 <= len(hs) <= 15):
        return "headlines 数量须在 3 到 15"
    if not (2 <= len(ds) <= 4):
        return "descriptions 数量须在 2 到 4"
    for h in hs:
        t = str(h.get("text") or "")
        if not t or len(t) > 30:
            return "headline 为空或超 30 字符: " + t
        if h.get("pin") not in (None, 1, 2, 3):
            return "headline pin 只认 1/2/3"
    for d in ds:
        t = str(d.get("text") or "")
        if not t or len(t) > 90:
            return "description 为空或超 90 字符: " + t
    return None


def op_rsa_copy_update(client, cid, args):
    raw = sys.stdin.read() if (args.spec or "") == "-" else None
    if raw is None:
        die("rsa-copy-update 需要 --spec -（JSON 走 stdin）")
    try:
        spec = json.loads(raw)
    except Exception as e:
        die("spec JSON 解析失败: " + str(e)[:200])
    ad_id = int(spec.get("ad_id") or 0)
    hs = spec.get("headlines") or []
    ds = spec.get("descriptions") or []
    if not ad_id:
        die("spec 缺 ad_id")
    err = _rsa_texts_validate(hs, ds)
    if err:
        die("文案校验不过: " + err)
    rows = gaql(client, cid,
                "SELECT ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.status, "
                "ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions "
                "FROM ad_group_ad WHERE ad_group_ad.ad.id = " + str(ad_id))
    if not rows:
        die("ad " + str(ad_id) + " 不存在")
    ad = rows[0].ad_group_ad.ad
    if str(ad.type_) != "AdType.RESPONSIVE_SEARCH_AD" and "RESPONSIVE_SEARCH_AD" not in str(ad.type_):
        die("ad " + str(ad_id) + " 不是 RSA（type " + str(ad.type_) + "），本操作只改 RSA 文案")
    def dump(assets):
        out_l = []
        for a in assets:
            row = {"text": a.text}
            pf = str(a.pinned_field)
            if "HEADLINE_" in pf:
                row["pin"] = int(pf.rsplit("_", 1)[1])
            out_l.append(row)
        return out_l
    old_h = dump(ad.responsive_search_ad.headlines)
    old_d = dump(ad.responsive_search_ad.descriptions)
    out({"step": "before", "op": "rsa-copy-update", "ad_id": ad_id,
         "old_headlines": old_h, "old_descriptions": old_d})
    new_h = [{"text": str(h["text"]), **({"pin": h["pin"]} if h.get("pin") else {})} for h in hs]
    new_d = [{"text": str(d["text"])} for d in ds]
    if new_h == old_h and new_d == [{"text": r["text"]} for r in old_d]:
        out({"ok": True, "noop": True, "note": "文案与目标一致，零改动"})
        return
    if args.dry_run:
        out({"ok": True, "dry_run": True, "would_set": {"headlines": new_h, "descriptions": new_d}})
        return
    svc = client.get_service("AdService")
    op = client.get_type("AdOperation")
    op.update.resource_name = svc.ad_path(cid, ad_id)
    for h in hs:
        a = client.get_type("AdTextAsset")
        a.text = str(h["text"])
        if h.get("pin") in (1, 2, 3):
            a.pinned_field = getattr(client.enums.ServedAssetFieldTypeEnum, "HEADLINE_" + str(h["pin"]))
        op.update.responsive_search_ad.headlines.append(a)
    for d in ds:
        a = client.get_type("AdTextAsset")
        a.text = str(d["text"])
        op.update.responsive_search_ad.descriptions.append(a)
    op.update_mask.CopyFrom(field_mask(["responsive_search_ad.headlines", "responsive_search_ad.descriptions"]))
    svc.mutate_ads(customer_id=cid, operations=[op])
    rows2 = gaql(client, cid,
                 "SELECT ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions "
                 "FROM ad_group_ad WHERE ad_group_ad.ad.id = " + str(ad_id))
    got_h = dump(rows2[0].ad_group_ad.ad.responsive_search_ad.headlines) if rows2 else []
    got_d = dump(rows2[0].ad_group_ad.ad.responsive_search_ad.descriptions) if rows2 else []
    if [r["text"] for r in got_h] != [r["text"] for r in new_h] or [r["text"] for r in got_d] != [r["text"] for r in new_d]:
        die("回读比对不符，人工核对 ad " + str(ad_id) + "：读到 headlines " + json.dumps(got_h, ensure_ascii=False)[:300], 1)
    out({"ok": True, "op": "rsa-copy-update", "ad_id": ad_id,
         "headlines": len(new_h), "descriptions": len(new_d),
         "old_headlines": old_h, "old_descriptions": old_d,
         "budget_impact": 0, "note": "文案已更新并回读一致，广告将重新进入审核"})


def op_keyword_add(client, cid, args):
    """往既有 ad group 加一条正向关键词（2026-09-11 W17，ctomi #678 缺口）。
    预算中性但扩大触发面，risk_class structural：有客户批文自动，无批文停人。"""
    if not args.ad_group_id or not args.text:
        die("keyword-add 需要 --ad-group-id 与 --text")
    match = MATCH_TYPES.get(args.match or "")
    if not match:
        die("match 只认 broad|phrase|exact")
    text = str(args.text).strip()
    if args.final_url and not args.final_url.startswith("https://"):
        die("final-url 必须是 https 绝对地址")
    rows = gaql(client, cid,
                "SELECT ad_group.id, ad_group.name, ad_group.status, campaign.id FROM ad_group "
                "WHERE ad_group.id = " + str(int(args.ad_group_id)))
    if not rows:
        die("ad group " + str(args.ad_group_id) + " 不存在")
    if "REMOVED" in str(rows[0].ad_group.status):
        die("ad group " + str(args.ad_group_id) + " 已移除")
    dup = gaql(client, cid,
               "SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, "
               "ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.negative "
               "FROM ad_group_criterion WHERE ad_group.id = " + str(int(args.ad_group_id)) +
               " AND ad_group_criterion.type = 'KEYWORD' AND ad_group_criterion.status != 'REMOVED'")
    for r in dup:
        if (not r.ad_group_criterion.negative
                and r.ad_group_criterion.keyword.text.strip().lower() == text.lower()
                and match in str(r.ad_group_criterion.keyword.match_type)):
            die("同词同匹配已存在（criterion " + str(r.ad_group_criterion.criterion_id) +
                "，status " + str(r.ad_group_criterion.status) + "），拒绝重复加词")
    out({"step": "before", "op": "keyword-add", "ad_group_id": args.ad_group_id,
         "ad_group_name": rows[0].ad_group.name, "text": text, "match": match,
         "final_url": args.final_url or None, "cpc_bid_micros": args.cpc_bid_micros or None})
    if args.dry_run:
        out({"ok": True, "dry_run": True, "would_create": {"text": text, "match": match}})
        return
    svc = client.get_service("AdGroupCriterionService")
    op = client.get_type("AdGroupCriterionOperation")
    c = op.create
    c.ad_group = client.get_service("AdGroupService").ad_group_path(cid, int(args.ad_group_id))
    c.status = client.enums.AdGroupCriterionStatusEnum.ENABLED
    c.keyword.text = text
    c.keyword.match_type = getattr(client.enums.KeywordMatchTypeEnum, match)
    if args.final_url:
        c.final_urls.append(args.final_url)
    if args.cpc_bid_micros:
        c.cpc_bid_micros = int(args.cpc_bid_micros)
    res = svc.mutate_ad_group_criteria(customer_id=cid, operations=[op])
    rn = res.results[0].resource_name
    rows2 = gaql(client, cid,
                 "SELECT ad_group_criterion.status, ad_group_criterion.keyword.text, ad_group_criterion.final_urls "
                 "FROM ad_group_criterion WHERE ad_group_criterion.resource_name = '" + rn.replace("'", "") + "'")
    if not rows2 or "ENABLED" not in str(rows2[0].ad_group_criterion.status):
        die("回读验证失败：新词状态不是 ENABLED，人工核对 " + rn, 1)
    if args.final_url and args.final_url not in list(rows2[0].ad_group_criterion.final_urls):
        die("回读验证失败：关键词级 final URL 未生效，人工核对 " + rn, 1)
    out({"ok": True, "op": "keyword-add", "resource_name": rn, "text": text, "match": match,
         "final_url": args.final_url or None,
         "budget_impact": "0（预算与出价策略未动；新词扩大触发面，回滚 = 暂停该词）"})


def op_keyword_final_url(client, cid, args):
    """给既有关键词设关键词级 final URL（2026-09-11 W17，ctomi #678 缺口）。reversible。"""
    if not args.criterion_resource or not args.new_url:
        die("keyword-final-url 需要 --criterion-resource 与 --new-url")
    if not args.new_url.startswith("https://"):
        die("new-url 必须是 https 绝对地址")
    res_name = args.criterion_resource.replace("'", "")
    rows = gaql(client, cid,
                "SELECT ad_group_criterion.status, ad_group_criterion.keyword.text, ad_group_criterion.final_urls, "
                "ad_group_criterion.negative FROM ad_group_criterion "
                "WHERE ad_group_criterion.resource_name = '" + res_name + "'")
    if not rows:
        die("criterion 不存在")
    if rows[0].ad_group_criterion.negative:
        die("目标是否定关键词，设不了 final URL")
    old_urls = list(rows[0].ad_group_criterion.final_urls)
    kw = rows[0].ad_group_criterion.keyword.text
    out({"step": "before", "op": "keyword-final-url", "keyword": kw, "old_final_urls": old_urls})
    if old_urls == [args.new_url]:
        out({"ok": True, "noop": True, "note": "关键词级 final URL 已是目标值，零改动"})
        return
    if args.dry_run:
        out({"ok": True, "dry_run": True, "would_set": [args.new_url]})
        return
    svc = client.get_service("AdGroupCriterionService")
    op = client.get_type("AdGroupCriterionOperation")
    op.update.resource_name = res_name
    del op.update.final_urls[:]
    op.update.final_urls.append(args.new_url)
    op.update_mask.CopyFrom(field_mask(["final_urls"]))
    svc.mutate_ad_group_criteria(customer_id=cid, operations=[op])
    rows2 = gaql(client, cid,
                 "SELECT ad_group_criterion.final_urls FROM ad_group_criterion "
                 "WHERE ad_group_criterion.resource_name = '" + res_name + "'")
    new_urls = list(rows2[0].ad_group_criterion.final_urls) if rows2 else []
    if new_urls != [args.new_url]:
        die("回读验证失败：期望 [" + args.new_url + "]，读到 " + json.dumps(new_urls))
    out({"ok": True, "op": "keyword-final-url", "keyword": kw,
         "old_final_urls": old_urls, "new_final_urls": new_urls, "budget_impact": 0})


def op_ad_create(client, cid, args):
    """在既有 ad group 新建一条 RSA（2026-09-11 W17，ctomi #678 缺口）。
    不动预算与既有广告，risk_class structural：有客户批文自动，无批文停人。新广告会进审核。"""
    raw = sys.stdin.read() if (args.spec or "") == "-" else None
    if raw is None:
        die("ad-create 需要 --spec -（JSON 走 stdin）")
    try:
        spec = json.loads(raw)
    except Exception as e:
        die("spec JSON 解析失败: " + str(e)[:200])
    ag_id = int(spec.get("ad_group_id") or 0)
    if not ag_id:
        die("spec 缺 ad_group_id")
    url = str(spec.get("final_url") or "")
    if not url.startswith("https://"):
        die("final_url 必须是 https 绝对地址")
    hs = spec.get("headlines") or []
    ds = spec.get("descriptions") or []
    err = _rsa_texts_validate(hs, ds)
    if err:
        die("文案校验不过: " + err)
    rows = gaql(client, cid,
                "SELECT ad_group.id, ad_group.name, ad_group.status FROM ad_group WHERE ad_group.id = " + str(ag_id))
    if not rows:
        die("ad group " + str(ag_id) + " 不存在")
    if "REMOVED" in str(rows[0].ad_group.status):
        die("ad group " + str(ag_id) + " 已移除")
    ex = gaql(client, cid,
              "SELECT ad_group_ad.ad.id, ad_group_ad.status FROM ad_group_ad "
              "WHERE ad_group.id = " + str(ag_id) + " AND ad_group_ad.status != 'REMOVED'")
    if len(ex) >= 3:
        die("组内非移除广告已有 " + str(len(ex)) + " 条（RSA 上限 3），先暂停或删一条旧广告再建，本操作不代删")
    out({"step": "before", "op": "ad-create", "ad_group_id": ag_id, "ad_group_name": rows[0].ad_group.name,
         "existing_ads": [str(r.ad_group_ad.ad.id) for r in ex],
         "note": "既有广告一条不动，新建一条 RSA"})
    if args.dry_run:
        out({"ok": True, "dry_run": True,
             "would_create": {"final_url": url, "headlines": len(hs), "descriptions": len(ds)}})
        return
    svc = client.get_service("AdGroupAdService")
    op = client.get_type("AdGroupAdOperation")
    ada = op.create
    ada.ad_group = client.get_service("AdGroupService").ad_group_path(cid, ag_id)
    ada.status = client.enums.AdGroupAdStatusEnum.ENABLED
    ada.ad.final_urls.append(url)
    if spec.get("path1"):
        ada.ad.responsive_search_ad.path1 = str(spec["path1"])[:15]
    if spec.get("path2"):
        ada.ad.responsive_search_ad.path2 = str(spec["path2"])[:15]
    for h in hs:
        a = client.get_type("AdTextAsset")
        a.text = str(h["text"])
        if h.get("pin") in (1, 2, 3):
            a.pinned_field = getattr(client.enums.ServedAssetFieldTypeEnum, "HEADLINE_" + str(h["pin"]))
        ada.ad.responsive_search_ad.headlines.append(a)
    for d in ds:
        a = client.get_type("AdTextAsset")
        a.text = str(d["text"])
        ada.ad.responsive_search_ad.descriptions.append(a)
    res = svc.mutate_ad_group_ads(customer_id=cid, operations=[op])
    rn = res.results[0].resource_name
    new_ad_id = int(rn.split("~")[-1]) if "~" in rn else 0
    rows2 = gaql(client, cid,
                 "SELECT ad_group_ad.ad.id, ad_group_ad.status, ad_group_ad.policy_summary.approval_status, "
                 "ad_group_ad.ad.final_urls FROM ad_group_ad "
                 "WHERE ad_group.id = " + str(ag_id) + " AND ad_group_ad.ad.id = " + str(new_ad_id))
    if not rows2:
        die("回读验证失败：新广告读不到，人工核对 " + rn, 1)
    if url not in list(rows2[0].ad_group_ad.ad.final_urls):
        die("回读验证失败：final URL 不符，人工核对 " + rn, 1)
    out({"ok": True, "op": "ad-create", "resource_name": rn, "ad_id": new_ad_id,
         "approval_status": str(rows2[0].ad_group_ad.policy_summary.approval_status),
         "headlines": len(hs), "descriptions": len(ds),
         "budget_impact": "0（预算与既有广告未动；新广告进审核，回滚 = 暂停新广告）"})


def op_keyword_bid_adjust(client, cid, args):
    if not args.criterion_resource or not args.new_bid_micros:
        die("keyword-bid-adjust 需要 --criterion-resource 与 --new-bid-micros")
    rows = gaql(client, cid,
                "SELECT ad_group_criterion.cpc_bid_micros, ad_group_criterion.keyword.text "
                "FROM ad_group_criterion WHERE ad_group_criterion.resource_name = '" +
                args.criterion_resource.replace("'", "") + "'")
    if not rows:
        die("criterion 不存在")
    old = int(rows[0].ad_group_criterion.cpc_bid_micros)
    new = int(args.new_bid_micros)
    out({"step": "before", "op": "keyword-bid-adjust",
         "keyword": rows[0].ad_group_criterion.keyword.text, "old_bid_micros": old})
    if old > 0 and abs(new - old) / old > 0.2:
        die("出价调整幅度 " + str(round(abs(new - old) / old * 100)) + "% 超过 ±20% 硬闸，拒绝执行")
    if args.dry_run:
        out({"ok": True, "dry_run": True, "would_set": new})
        return
    svc = client.get_service("AdGroupCriterionService")
    op = client.get_type("AdGroupCriterionOperation")
    op.update.resource_name = args.criterion_resource
    op.update.cpc_bid_micros = new
    op.update_mask.CopyFrom(field_mask(["cpc_bid_micros"]))
    svc.mutate_ad_group_criteria(customer_id=cid, operations=[op])
    out({"ok": True, "op": "keyword-bid-adjust", "old_bid_micros": old, "new_bid_micros": new,
         "budget_impact": "出价级，无预算变动"})


def main():
    p = argparse.ArgumentParser(add_help=True)
    p.add_argument("customer_id")
    p.add_argument("--op", required=True, choices=OPS)
    p.add_argument("--ad-id", type=int)
    p.add_argument("--ad-group-id", type=int)
    p.add_argument("--new-url")
    p.add_argument("--level")
    p.add_argument("--target-id", type=int)
    p.add_argument("--text")
    p.add_argument("--match")
    p.add_argument("--criterion-resource")
    p.add_argument("--new-bid-micros", type=int)
    p.add_argument("--spec")
    p.add_argument("--final-url")
    p.add_argument("--cpc-bid-micros", type=int)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    cid = args.customer_id.replace("-", "")
    if args.op == "schedule-adjust":
        die("schedule-adjust 落地器未实现，转人工（能力清单 V2 已标注）")
    client = make_client()
    try:
        {"final-url-change": op_final_url_change,
         "ad-pause": op_ad_pause,
         "adgroup-pause": op_adgroup_pause,
         "keyword-pause": op_keyword_pause,
         "negative-keyword-add": op_negative_keyword_add,
         "keyword-bid-adjust": op_keyword_bid_adjust,
         "adgroup-create": op_adgroup_create,
         "rsa-copy-update": op_rsa_copy_update,
         "keyword-add": op_keyword_add,
         "keyword-final-url": op_keyword_final_url,
         "ad-create": op_ad_create}[args.op](client, cid, args)
    except SystemExit:
        raise
    except Exception as e:
        die(str(e)[:500], 1)


if __name__ == "__main__":
    sys.exit(main() or 0)
