#!/usr/bin/env python3
"""把 src/client.template.js + layers/*.webp 打成 lib/client.js。

自用版刻意不引 TypeScript / tsdown：只需要把两张图层做成 data URL 内联进去。
（内联而不是走资源路由：纯 JS 插件没有 node 半边静态服务，套件的做法也是内联。）

用法：python3 tools/build-client.py
"""
import base64
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TPL = os.path.join(ROOT, "src", "client.template.js")
OUT = os.path.join(ROOT, "lib", "client.js")
LAYERS = os.path.join(ROOT, "layers")


def data_url(name: str) -> str:
    p = os.path.join(LAYERS, name)
    if not os.path.exists(p):
        sys.exit("缺少图层：%s（先跑 tools/build-layers.py）" % p)
    raw = open(p, "rb").read()
    print("  %-12s %6.1f KB -> base64 %6.1f KB" % (name, len(raw) / 1024, len(raw) * 4 / 3 / 1024))
    return "data:image/webp;base64," + base64.b64encode(raw).decode("ascii")


def main():
    tpl = open(TPL, encoding="utf-8").read()
    for token in ("__BODY_IMG__", "__HEAD_IMG__"):
        if token not in tpl:
            sys.exit("模板里找不到占位符 %s" % token)

    print("内联图层：")
    tpl = tpl.replace("__BODY_IMG__", data_url("body.webp"))
    tpl = tpl.replace("__HEAD_IMG__", data_url("head.webp"))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(tpl)
    print("wrote %s  %.1f KB" % (OUT, os.path.getsize(OUT) / 1024))


if __name__ == "__main__":
    main()
