#!/usr/bin/env python3
"""给自建 APK 写正确的 dshroot 标记（问题②的工具化修复）。

为什么必须有这一步（2026-09-29 事故根因）：
  App 的 MainActivity 用 assets/dshroot_kernel_version.txt 与运行副本里的内核版本比对，
  **只有"内核版本变化"或 .complete 缺失才触发全量解压**；否则走"快速同步"
  （只更新 REVISION + 白名单文件）。而之前的构建脚本从不更新这两个标记 ——
  于是 rc.2 的包装上去时标记还写着 0.2.0-rc.1，App 判定"没变"→ 跳过全量解压
  → dshroot 残留旧版本 → 插件 rc.2 / 内核 rc.1 混合 → 插件成批禁用 + 前端半死。

  实测验证（2026-09-29 22:34）：只把内核标记从 0.2.0-rc.1 改成 0.2.0-rc.1+sb2026-09-29，
  覆盖安装后 App 立刻做了全量解压，整棵 dshroot 重建、连新加的 dsh-bg-* 资产都回来了。

用法：
  python3 set-apk-markers.py <in.apk> <out.apk> [--revision 时间戳] [--kernel 版本]
  不带 --kernel 时自动从本包 payload 里的 @deepseek-ai/dsh/package.json 读取真实版本。
"""
import io
import json
import sys
import time
import zipfile

KERNEL_PKG = 'dshroot/lib/node_modules/@deepseek-ai/dsh/package.json'
MARK_KERNEL = 'assets/dshroot_kernel_version.txt'
MARK_REVISION = 'assets/dshroot_revision.txt'


def read_payload_kernel_version(apk_path):
    """从 APK 内 assets/payload.zip 里读出内核真实版本。"""
    with zipfile.ZipFile(apk_path) as apk:
        with apk.open('assets/payload.zip') as payload_file:
            payload = zipfile.ZipFile(io.BytesIO(payload_file.read()))
            with payload.open(KERNEL_PKG) as f:
                return json.load(f)['version']


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    if len(args) < 2:
        print(__doc__)
        return 2
    src, dst = args[0], args[1]

    kernel = None
    revision = None
    argv = sys.argv[1:]
    for i, a in enumerate(argv):
        if a == '--kernel' and i + 1 < len(argv):
            kernel = argv[i + 1]
        if a == '--revision' and i + 1 < len(argv):
            revision = argv[i + 1]

    if kernel is None:
        try:
            kernel = read_payload_kernel_version(src)
        except Exception as exc:                                  # noqa: BLE001
            print(f'✗ 读不出 payload 里的内核版本: {exc}')
            return 1
    if revision is None:
        revision = time.strftime('%Y%m%d%H%M%S')

    written = 0
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, 'w') as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == MARK_KERNEL:
                data = (kernel + '\n').encode()
                written += 1
            elif item.filename == MARK_REVISION:
                data = (revision + '\n').encode()
                written += 1
            zout.writestr(item, data)

    print(f'  ✓ 标记已写入（{written} 项）：kernel={kernel}  revision={revision}')
    if written != 2:
        print('  ⚠ 期望写 2 项，实际 %d —— 包结构可能不对，请核对' % written)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
