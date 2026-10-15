#!/usr/bin/env python3
"""Scan the exact signed APK and write a hash-bound report only after success."""
import argparse
import hashlib
import io
import json
import os
import re
import sys
import zipfile


def file_sha(file):
    h = hashlib.sha256()
    with open(file, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def scan(apk, overlay, wallpaper):
    problems = []
    with zipfile.ZipFile(apk) as outer:
        with zipfile.ZipFile(io.BytesIO(outer.read('assets/payload.zip'))) as inner:
            names = inner.namelist()
            if len(set(names)) != len(names):
                problems.append('duplicate payload entries')
            forbidden = r'dsh-bg-user|keystore|\.(?:p12|pfx)$|(?:^|/)AGENTS\.md$|selfbuild/|PATCH-NOTES|whale-shota|archive-2\.5d|\.(?:bak|orig|pre-lan)(?:-[\d.]+)?$|session\.v4\.jsonl|\.credentials|(?:^|/)review\.json|(?:^|/)skills-local/'
            problems.extend('forbidden filename: ' + n for n in names if re.search(forbidden, n, re.I))
            # Only distributable seed configuration may survive under dshhome.
            allowed = {'skills', 'cordis.patch.yml', 'profiles'}
            for n in names:
                if n.startswith('dshhome/') and len(n.split('/')) > 1 and n.split('/')[1] and n.split('/')[1] not in allowed:
                    problems.append('unexpected dshhome seed: ' + n)
            if not os.path.isfile(wallpaper):
                raise RuntimeError('Wallpaper source missing; byte privacy check cannot run')
            with open(wallpaper, 'rb') as f:
                private_hash = hashlib.sha256(f.read()).digest()
            for n in names:
                if n.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')) and hashlib.sha256(inner.read(n)).digest() == private_hash:
                    problems.append('private wallpaper bytes: ' + n)
            own = set()
            for root, _, files in os.walk(overlay):
                for f in files:
                    own.add(os.path.relpath(os.path.join(root, f), overlay).replace(os.sep, '/'))
            own.update(n for n in names if n.startswith('dshhome/profiles/') or n.endswith('CHANGELOG.md'))
            patterns = {
                'phone': r'(?<!\d)1[3-9]\d{9}(?!\d)',
                'email': r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(?:com|cn|net)',
                'private app': r'sgzzlb|aweme\.lite',
                'private path': r'/sdcard/Download/(?!(?:DeepSeekHarness|DSH_Backups|DSH_Knowledge|DSH_WorkLogs|DSH_Drop)(?:/|[^\w/]|$))[^\s"\x27`<>]+|dsh_own_app|fluidcard-mock',
                'credential': r'\bsk-[A-Za-z0-9_-]{16,}|\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_',
                'local dependency': r'link:/',
            }
            for n in sorted(own & set(names)):
                data = inner.read(n)
                if b'\0' in data[:1024]:
                    continue
                text = data.decode('utf-8', 'ignore')
                for label, pattern in patterns.items():
                    if re.search(pattern, text):
                        problems.append(f'{label} in {n}')
            for n in ('assets/mobile.css', 'assets/mobile.js', 'AndroidManifest.xml'):
                if n not in outer.namelist():
                    continue
                data = outer.read(n)
                # Binary XML uses UTF16 strings on some base APKs.
                text = data.decode('utf-8', 'ignore') + '\n' + data.decode('utf-16le', 'ignore')
                for label, pattern in patterns.items():
                    if re.search(pattern, text):
                        problems.append(f'{label} in {n}')
            prefix = 'dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/'
            css = inner.read(prefix + 'dsh-bg.css').decode('utf-8')
            image = [line.strip() for line in css.splitlines() if '--dsh-user-bg-image:' in line]
            if not image or 'dsh-bg.svg' not in image[0] or prefix + 'dsh-bg.svg' not in names:
                problems.append('generic background missing or not selected')
    return problems


def main():
    a = argparse.ArgumentParser()
    a.add_argument('--apk', required=True)
    a.add_argument('--overlay', required=True)
    a.add_argument('--wallpaper', required=True)
    a.add_argument('--report', required=True)
    args = a.parse_args()
    before = file_sha(args.apk)
    problems = scan(args.apk, args.overlay, args.wallpaper)
    if file_sha(args.apk) != before:
        raise RuntimeError('APK changed during privacy scan')
    if problems:
        for issue in problems[:30]:
            print('FAIL:', issue)
        return 1
    report = {'schema': 1, 'kind': 'privacy', 'ok': True, 'apkSha256': before,
              'checks': {'filenames': True, 'wallpaperBytes': True, 'contents': True,
                         'dshhomeAllowlist': True, 'background': True},
              'scannerSha256': file_sha(__file__), 'overlay': os.path.abspath(args.overlay)}
    target = os.path.abspath(args.report)
    tmp = target + '.tmp-' + str(os.getpid())
    assert os.path.dirname(target) == os.path.dirname(tmp)
    with open(tmp, 'x', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
        f.write('\n')
    os.replace(tmp, target)
    with open(target, encoding='utf-8') as f:
        assert json.load(f) == report
    print('PASS: privacy report bound to APK sha256=' + before)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as e:
        print('FAIL:', e, file=sys.stderr)
        sys.exit(1)
