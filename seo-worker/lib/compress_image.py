#!/usr/bin/env python3
"""把一张图压到目标字节数以下。用法：compress_image.py <in> <out> <max_bytes> [max_width]
先限宽（默认 1280），再从 JPEG 质量 85 逐档降到 55，最后一档还超就再缩一成宽度重来。
输出 JSON 一行：{"ok":true,"bytes":N,"quality":Q,"width":W} 或 {"ok":false,"error":"..."}。
PJ 手工产线同一做法（Pillow），只是搬进 worker。"""
import json, sys, os
try:
    from PIL import Image
except Exception as e:
    print(json.dumps({"ok": False, "error": "PIL missing: %s" % e})); sys.exit(0)

src, dst = sys.argv[1], sys.argv[2]
max_bytes = int(sys.argv[3]) if len(sys.argv) > 3 else 200 * 1024
max_w = int(sys.argv[4]) if len(sys.argv) > 4 else 1280
try:
    im = Image.open(src)
    im = im.convert("RGB")
    w, h = im.size
    if w > max_w:
        im = im.resize((max_w, int(h * max_w / w)), Image.LANCZOS)
    for shrink in range(0, 4):
        if shrink:
            w2 = int(im.size[0] * 0.9)
            im = im.resize((w2, int(im.size[1] * 0.9)), Image.LANCZOS)
        for q in (85, 80, 75, 70, 65, 60, 55):
            im.save(dst, "JPEG", quality=q, optimize=True, progressive=True)
            n = os.path.getsize(dst)
            if n <= max_bytes:
                print(json.dumps({"ok": True, "bytes": n, "quality": q, "width": im.size[0]})); sys.exit(0)
    print(json.dumps({"ok": True, "bytes": os.path.getsize(dst), "quality": 55, "width": im.size[0], "note": "still over target"}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
