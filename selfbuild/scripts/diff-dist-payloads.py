#!/usr/bin/env python3
"""diff-dist-payloads.py —— 机械对比两个**发行 APK** 里的 assets/payload.zip 条目。

为什么要有它：出包流程里 `release-checks.mjs baseline` 只核对上一版**资产哈希**
（"是不是官方那个包"），不回答"这一版比上一版**多了什么**"。写更新文档与核对
"增加的功能"时，需要的是后者，而且必须是**机械的**（不靠印象、不靠 PATCH-NOTES 记忆）。

用法：
    python3 diff-dist-payloads.py <旧.apk> <新.apk> [--list-limit 400]

判据：条目名 + 中央目录里的 CRC32。
  · 新增 = 新包有、旧包没有
  · 删除 = 旧包有、新包没有
  · 改动 = 两边都有但 CRC 不同（不需要解压，读中央目录即可）
退出码 0（只报告，不做判断）。
"""
import argparse
import io
import zipfile


def entries(apk):
    with zipfile.ZipFile(apk) as outer:
        with zipfile.ZipFile(io.BytesIO(outer.read('assets/payload.zip'))) as inner:
            return {i.filename: (i.CRC, i.file_size) for i in inner.infolist()}


def area(name):
    """把条目归到一个粗粒度区域，便于一眼看出变化集中在哪。"""
    if name.startswith('dshhome/skills/'):
        parts = name.split('/')
        return 'dshhome/skills/' + (parts[2] if len(parts) > 2 else '')
    if name.startswith('dshhome/profiles/'):
        return 'dshhome/profiles/' + '/'.join(name.split('/')[2:4])
    kernel = 'dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/'
    if name.startswith(kernel):
        parts = name[len(kernel):].split('/')
        return 'kernel:' + ('/'.join(parts[:2]) if parts[0].startswith('@') else parts[0])
    if name.startswith('dshroot/'):
        return 'dshroot:' + name.split('/')[1]
    return name.split('/')[0]


def grouped(items, limit):
    counts = {}
    for k in items:
        counts[area(k)] = counts.get(area(k), 0) + 1
    for k, v in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]:
        print(f'    {v:5d}  {k}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('old')
    ap.add_argument('new')
    ap.add_argument('--list-limit', type=int, default=400)
    a = ap.parse_args()

    old = entries(a.old)
    new = entries(a.new)
    added = sorted(set(new) - set(old))
    removed = sorted(set(old) - set(new))
    changed = sorted(k for k in set(old) & set(new) if old[k][0] != new[k][0])

    print(f'旧包 {a.old}')
    print(f'     {len(old)} 条目')
    print(f'新包 {a.new}')
    print(f'     {len(new)} 条目')
    print(f'新增 {len(added)} · 删除 {len(removed)} · 改动 {len(changed)}')

    for title, items in (('新增', added), ('删除', removed), ('改动', changed)):
        print(f'\n── {title} {len(items)} ──')
        if not items:
            continue
        print('  按区域汇总：')
        grouped(items, 40)
        print('  明细：')
        for k in items[:a.list_limit]:
            extra = f'   {old[k][1]} → {new[k][1]} 字节' if title == '改动' else ''
            print('    ' + k + extra)
        if len(items) > a.list_limit:
            print(f'    …（还有 {len(items) - a.list_limit} 条）')


if __name__ == '__main__':
    main()
