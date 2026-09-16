#!/usr/bin/env python3
# weekly_digest.py — 每周批跑的结构化收尾：跑前跑后各拍一次任务快照，diff 出
# 「顺利推进多少、卡壳多少、各因为什么」，按修复动作分组给人一张清单。
# 用法:
#   snapshot: weekly_digest.py snapshot <out.json> <cid> [cid ...]
#   digest:   weekly_digest.py digest <before.json> <after.json>
# 认证: SEO_AGENT_TOKEN 环境变量。
import json, os, re, sys, urllib.request, datetime

API = os.environ.get('MA_API', 'https://always.horntech-dev.com/seo-api.php')
TOKEN = os.environ.get('SEO_AGENT_TOKEN', '')

def req(path):
    r = urllib.request.Request(API + path, headers={'Authorization': 'Bearer ' + TOKEN})
    return json.loads(urllib.request.urlopen(r, timeout=60).read().decode())

def snapshot(out, cids):
    data = {}
    names = {}
    for c in (req('/clients').get('clients') or []):
        names[c.get('client_id')] = c.get('name')
    for cid in cids:
        ts = req('/tasks?client_id=%d' % cid)['tasks']
        data[str(cid)] = {'name': names.get(cid, str(cid)), 'tasks': [
            {k: t.get(k) for k in ('id', 'title', 'status', 'sprint', 'ops', 'owner_type',
                                   'human_state', 'wait_reason', 'closed_kind', 'sent_at',
                                   'card_feedback_at', 'result_note', 'review_verdict')}
            for t in ts]}
    json.dump(data, open(out, 'w'), ensure_ascii=False)
    print('快照 %d 家 -> %s' % (len(cids), out))

def cur_sprint(tasks):
    nums = [int(m.group(1)) for t in tasks if t.get('status') != 'done'
            for m in [re.match(r'S(\d+)', str(t.get('sprint') or ''))] if m]
    return min(nums) if nums else None

def is_card(t):
    s = str(t.get('result_note') or '') + str(t.get('ops') or '')
    return bool(re.search(r'direction|确认卡|blog_confirmation', s))

def classify(t):
    """返回 (桶, 人的修复动作)。None = 不算卡壳。"""
    hs = t.get('human_state') or ''
    wr = str(t.get('wait_reason') or '')
    if hs in ('closed', 'running'):
        return None
    if '失败' in wr:
        return ('执行失败', '看失败原因，修材料或环境后重放（多为凭据/基线/lint，修法通常在任务 note 里）')
    if is_card(t) and t.get('status') == 'review':
        if not t.get('sent_at'):
            return ('卡待发', '把卡发给客户并在看板打「已发」')
        return ('卡等客户', '催客户，或等 30 天到期视同同意')
    if t.get('status') == 'review':
        return ('待放行（真闸/L2）', '看板放行或改判不做（spend/不可逆类是留给人的）')
    if hs == 'wait_ext':
        return ('等外部', wr or '等平台/客户侧动作')
    if wr in ('待判', '待拍板', '判定中'):
        return ('判决缺失或在飞', '再跑一轮 harness 即消化；反复出现属异常，报 Aira')
    return ('其他', wr or hs)

def digest(before_f, after_f):
    B = json.load(open(before_f))
    A = json.load(open(after_f))
    stamp = datetime.datetime.now().strftime('%Y-%m-%d %H:%M')
    lines = ['# 每周批跑收尾 ' + stamp, '']
    tot_done = 0
    smooth, stuck_clients = [], []
    stuck_all = {}
    for cid, a in A.items():
        b = B.get(cid, {'tasks': []})
        bst = {t['id']: t for t in b['tasks']}
        done_new = [t for t in a['tasks'] if t.get('status') == 'done'
                    and bst.get(t['id'], {}).get('status') != 'done']
        cur = cur_sprint(a['tasks'])
        cur_open = [t for t in a['tasks'] if cur and str(t.get('sprint')) == 'S%d' % cur
                    and t.get('status') != 'done']
        stuck = [(t, classify(t)) for t in cur_open]
        stuck = [(t, c) for t, c in stuck if c]
        tot_done += len(done_new)
        head = '## %s（本期 %s）：收口 %d，卡壳 %d' % (
            a['name'], ('S%d' % cur) if cur else '全清', len(done_new), len(stuck))
        lines.append(head)
        for t in done_new:
            lines.append('- 收口 #%s %s（%s）' % (t['id'], str(t['title'])[:40], t.get('closed_kind') or 'done'))
        for t, (bucket, fix) in stuck:
            lines.append('- 卡壳 #%s [%s] %s' % (t['id'], bucket, str(t['title'])[:40]))
            stuck_all.setdefault(bucket, []).append((a['name'], t['id'], fix))
        lines.append('')
        (stuck_clients if stuck else smooth).append(a['name'])
    lines.insert(2, '**总结：顺利跑完 %d 家（%s），卡壳 %d 家，本轮共收口任务 %d 条。**' % (
        len(smooth), '、'.join(smooth) or '无', len(stuck_clients), tot_done))
    lines.insert(3, '')
    if stuck_all:
        lines.append('## 人工修复清单（按原因分组）')
        for bucket, rows in stuck_all.items():
            lines.append('### %s（%d 条）— %s' % (bucket, len(rows), rows[0][2]))
            for name, tid, _ in rows:
                lines.append('- %s #%s' % (name, tid))
        lines.append('')
    out = '\n'.join(lines)
    print(out)
    return out

if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'snapshot':
        snapshot(sys.argv[2], [int(x) for x in sys.argv[3:]])
    elif cmd == 'digest':
        digest(sys.argv[2], sys.argv[3])
    else:
        sys.exit('用法: snapshot <out.json> <cid...> | digest <before.json> <after.json>')
