#!/usr/bin/env python3
"""task_read.py <task_id> — 看板单任务现状只读查询（含已归档）+ 最近关联 job。

给 chat 工具带用（批五第 5 条，2026-10-16）：chat 被问任务进度时查这个，不许猜。
只 GET /task_state 一个端点，凭据读 worker config，天然只读。
"""
import json
import sys
import urllib.request

CONFIG = '/data/aira/seo-worker/config.json'
STATUS_LABEL = {
    'proposed': '已立项待判定',
    'approved': '已批准待执行',
    'in_progress': '执行中',
    'review': '方案已出，判定与放行环节',
    'blocked': '阻塞',
    'done': '已收口',
}


def main():
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        print('用法: task_read.py <task_id>')
        return 2
    with open(CONFIG) as f:
        cfg = json.load(f)
    url = cfg['apiBase'] + '/task_state?task_id=' + sys.argv[1]
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + cfg['serviceToken']})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        print('查询失败 HTTP %d: %s' % (e.code, e.read().decode('utf-8', 'replace')[:200]))
        return 1
    t = data.get('task') or {}
    print('任务 #%s「%s」' % (t.get('id'), t.get('title', '')))
    print('状态: %s%s | 泳道: %s | 模块: %s | 期: %s'
          % (STATUS_LABEL.get(t.get('status'), t.get('status')),
             '（已归档）' if t.get('archived') else '',
             t.get('owner_type'), t.get('module'), t.get('sprint') or '-'))
    print('更新: %s | 产物: %s' % (t.get('updated_at'), t.get('output_url') or '无'))
    jobs = data.get('jobs') or []
    if jobs:
        print('关联 job（新在前）:')
        for j in jobs:
            print('  #%s %s %s（%s）' % (j.get('id'), j.get('type'), j.get('status'), j.get('created_at')))
    tail = (t.get('result_note_tail') or '').strip()
    if tail:
        print('结果备注（末 1500 字）:')
        print(tail)
    return 0


if __name__ == '__main__':
    sys.exit(main())
