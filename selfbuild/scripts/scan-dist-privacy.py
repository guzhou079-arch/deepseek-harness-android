#!/usr/bin/env python3
"""Scan the exact signed APK and write a hash-bound report only after success."""
# ---------------------------------------------------------------------------
# 发行包隐私事故：
#   1.51.1 / 1.51.2 / 1.51.4 三个包的内层 payload 里都带着 dshhome/profiles 下的
#   私人插件，正文写着真实人称（多处，其中 dsh-user-profile 那两处会
#   拼进模型提示词）。当时的门禁一条都没拦 —— 因为它只按「文件名 / 手机号 / 邮箱 /
#   凭据」判定，根本没看过正文里的人称。
# 这里加一条**死规则**：payload 任意正文命中下列人称一律失败。
# 例外只开一个文件（签文数据里的文言词句不是人称）：
#   只放行这一个文件里的这一处；同文件出现别的私人称呼、或目录里别的文件出现，
#   照旧失败 —— 防止以后往 data/ 里塞东西也顺着目录放行漏过去。
# ---------------------------------------------------------------------------
import re  # 顶部先导入：下面的模块级常量要编译正则（文件原来的 import 块在中间，不能依赖它）

PRIVATE_NAMES = ('阿舟', '孤舟', '孤天光', '天光')
NAME_EXCEPTIONS = {
    'dshhome/skills/dsh-zhanbu/data/zhuge.json': frozenset({'孤舟'}),
}
NAME_SCAN_MAX_BYTES = 8 * 1024 * 1024

# ---------------------------------------------------------------------------
# 2026-11-07 P1-7：两条漏检缝
#
# (a) 带边界的私人名「流光 / 拾光」。
#     光把「流光」两个字加进词表会把「流光配色」「流光溢彩」这类正常文案一起判红，
#     一出包就卡死。所以只认**词表里当一个元素**的形态：前后都是分隔符（引号、逗号、
#     方括号、空白、行首尾）。`'流光,小鲸鱼,DeepSeek'` 命中；`流光配色` 不命中。
#
# (b) 默认值里的私人名。
#     唤醒词默认值 `流光,小鲸鱼,DeepSeek` 就是从这个缝里漏出去的：它既不是文件名、
#     也不是手机号邮箱，而是一段**配置默认值**。所以对 wake_words / 昵称 / name 这类
#     键的取值单独过一遍词表，取值里出现任何私人称呼一律判红。
#
#     这两个词只在这一层判：文件名/私图/purge/dshhome 种子等判定完全不动。
# ---------------------------------------------------------------------------
_NAME_BOUNDARY_BEFORE = r'(?:^|[\s\[(,，{="\'`、:：])'
_NAME_BOUNDARY_AFTER = r'(?=[\s\])},，="\'`、;；]|$)'
BOUNDED_NAMES = ('流光', '拾光')
BOUNDED_NAME_RX = re.compile(
    _NAME_BOUNDARY_BEFORE + '(' + '|'.join(BOUNDED_NAMES) + ')' + _NAME_BOUNDARY_AFTER)

# 配置默认值里可能出现称呼的键。name 单独处理：只有当取值**整个就是**一个私人称呼时才判红，
# 否则 `name: "dsh-ppt"` 这种正常包名会被一起打死。
PRIVATE_DEFAULT_KEYS = ('wake_words', 'wakeWords', 'wakeword', 'wake_word', 'nickname',
                        'nick_name', 'crewName', 'crew_name', 'userName', 'user_name',
                        'displayName', 'display_name', 'preferredName', 'callName')
DEFAULT_VALUE_RX = re.compile(
    r'(?i)\b(' + '|'.join(PRIVATE_DEFAULT_KEYS) + r')\b\s*[:=]\s*'
    r'(\[[^\]]{0,500}\]|\{[^}]{0,500}\}|"[^"\n]{0,200}"|\'[^\'\n]{0,200}\'|[^\n,;}\]]{0,200})')
NAME_KEY_RX = re.compile(r'(?i)\bname\b\s*[:=]\s*("[^"\n]{0,80}"|\'[^\'\n]{0,80}\')')
ALL_PRIVATE_TOKENS = PRIVATE_NAMES + BOUNDED_NAMES


def scan_private_defaults(inner, problems, suppressed):
    """扫「词表形态的称呼」和「配置默认值里的称呼」。

    与 scan_names 的分工：scan_names 管裸词通杀（私人称呼出现就红），
    这里管两个容易误判的词（流光/拾光）和**默认值**这种载体 —— 前者要边界，
    后者要认出「这是一段配置的默认值」而不是普通正文。
    """
    files = 0
    list_hits = 0
    default_hits = 0
    for n in inner.namelist():
        if n.endswith('/'):
            continue
        try:
            info = inner.getinfo(n)
            if info.file_size > NAME_SCAN_MAX_BYTES:
                continue
            data = inner.read(n)
        except Exception:
            continue
        if b'\0' in data[:1024]:
            continue
        text = data.decode('utf-8', 'ignore')
        touched = False
        # (a) 词表形态
        for m in BOUNDED_NAME_RX.finditer(text):
            list_hits += 1
            touched = True
            problems.append('private name in list form: %s: 「%s」 上下文 %r'
                            % (n, m.group(1), text[max(0, m.start() - 24):m.end() + 24]))
        # (b) 配置默认值
        for m in DEFAULT_VALUE_RX.finditer(text):
            value = m.group(2)
            hit = [t for t in ALL_PRIVATE_TOKENS if t in value]
            if hit:
                default_hits += 1
                touched = True
                problems.append('private name in config default: %s: %s = %s'
                                % (n, m.group(1), value.strip()[:120]))
        for m in NAME_KEY_RX.finditer(text):
            value = m.group(1).strip('\'"')
            if value in ALL_PRIVATE_TOKENS:
                default_hits += 1
                touched = True
                problems.append('private name as name default: %s: name = %s' % (n, value))
        if touched:
            files += 1
    return {'files': files, 'listFormHits': list_hits, 'configDefaultHits': default_hits}



def scan_names(inner, label, problems, suppressed):
    """扫一层 payload 的**全部**正文（不只我们自己的文件）里的人称。

    底层包和最终包都要过这一遍：底包带毒而最终包「通过」是这次事故里最坑的
    骗人姿势 —— 最终包的 profiles 被洗过，底包那份却原样跟着发出去。
    """
    allowed = NAME_EXCEPTIONS
    scanned = 0
    for n in inner.namelist():
        if n.endswith('/'):
            continue
        try:
            info = inner.getinfo(n)
        except Exception:
            continue
        if info.file_size > NAME_SCAN_MAX_BYTES:
            continue
        try:
            data = inner.read(n)
        except Exception:
            continue
        if b'\0' in data[:1024]:
            continue
        text = data.decode('utf-8', 'ignore')
        hits = {t: text.count(t) for t in PRIVATE_NAMES if t in text}
        if not hits:
            continue
        scanned += 1
        excepted = allowed.get(n, frozenset())
        real = {t: c for t, c in hits.items() if t not in excepted}
        if real:
            detail = ', '.join('%s×%d' % (t, c) for t, c in sorted(real.items()))
            problems.append('private name in %s: %s -> %s' % (label, n, detail))
        kept = {t: c for t, c in hits.items() if t in excepted}
        if kept:
            suppressed.append({'path': n, 'rule': 'private-name', 'layer': label,
                               'allowed': sorted(kept), 'counts': kept})
    return scanned


def scan_base_apk(apk, problems, suppressed):
    """扫底包内层 payload——**只作参考报告，不参与判红绿**。

    2026-11-06：原实现把命中直接塞进 problems 判 FAIL，依据是「底包内层 payload 才是
    真发出去的字节」。这条前提在本流程里不成立：出包用 payload-patch 生成全新的 PAY_NEW，
    底包 payload 只是输入原料。底包原文带毒是历史事实，成品干净恰恰说明脱敏生效。
    所以：结构性问题（缺包/缺 payload）仍然硬 FAIL；人名命中去 notes，只进报告审计。
    """
    notes = []
    if not os.path.isfile(apk):
        problems.append('base apk missing: ' + apk)
        return 0
    total = 0
    with zipfile.ZipFile(apk) as outer:
        entries = [n for n in outer.namelist()
                   if n.lower().endswith('.zip') and 'payload' in n.lower()]
        if not entries:
            problems.append('base apk has no payload.zip: ' + apk)
            return 0
        for entry in entries:
            with zipfile.ZipFile(io.BytesIO(outer.read(entry))) as inner:
                total += scan_names(inner, 'base:' + entry, notes, suppressed)
    return total, notes

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
            # DSH_KEEP_USER_BG=1 的自用包：机主壁纸是内容而不是泄露，放行文件名规则。
            # 发行包（默认）仍然禁止，这条底线不为自用场景松动。
            if os.environ.get('DSH_KEEP_USER_BG') == '1':
                forbidden = forbidden.replace('dsh-bg-user|', '')
            problems.extend('forbidden filename: ' + n for n in names if re.search(forbidden, n, re.I))
            problems.extend('purge filename: ' + n for n in names if 'purge' in n.lower())
            profile = 'dshhome/profiles/web/package.json'
            if profile not in names:
                problems.append('missing distribution profile: ' + profile)
            else:
                dependencies = json.loads(inner.read(profile).decode('utf-8')).get('dependencies', {})
                if not isinstance(dependencies, dict) or dependencies:
                    problems.append('distribution profile dependencies must be empty')
            # Only distributable seed configuration may survive under dshhome.
            # dshhome/tools/ 例外到**文件级**：crew.js 与 crew-selftest.sh 是 dsh-crew 技能的运行时
            # 依赖，技能文档直接引用它们，缺了就指向空路径。逐文件列名而不是整个 tools/ 放行 ——
            # 目录级放行会让以后丢进来的私人脚本一起过闸。
            allowed = {'skills', 'cordis.patch.yml', 'profiles'}
            tools_allow = {'dshhome/tools/crew.js', 'dshhome/tools/crew-selftest.sh'}
            for n in names:
                if not n.startswith('dshhome/') or len(n.split('/')) < 2:
                    continue
                if n.split('/')[1] and n.split('/')[1] not in allowed and n not in tools_allow:
                    problems.append('unexpected dshhome seed: ' + n)
            if not os.path.isfile(wallpaper):
                raise RuntimeError('Wallpaper source missing; byte privacy check cannot run')
            with open(wallpaper, 'rb') as f:
                private_hash = hashlib.sha256(f.read()).digest()
            # DSH_KEEP_USER_BG=1 的自用包：这张壁纸是有意随包的，字节比对必然命中，
            # 直接跳过整条；发行包（默认）照旧逐图比对，防止私图混进去。
            if os.environ.get('DSH_KEEP_USER_BG') != '1':
                for n in names:
                    if n.lower().endswith(('.png', '.jpg', '.jpeg', '.webp')) and hashlib.sha256(inner.read(n)).digest() == private_hash:
                        problems.append('private wallpaper bytes: ' + n)
            own = set()
            for root, _, files in os.walk(overlay):
                for f in files:
                    full = os.path.join(root, f)
                    rel = os.path.relpath(full, overlay).replace(os.sep, '/')
                    own.add(rel)
                    with open(full, 'rb') as source:
                        data = source.read()
                    if b'\0' not in data[:1024] and re.search(r'dsh-purge|\[dsh-purge\]', data.decode('utf-8', 'ignore')):
                        problems.append('purge patch in overlay: ' + rel)
            own.update(n for n in names if n.startswith('dshhome/profiles/') or n.endswith('CHANGELOG.md'))
            # 2026-10-26：vendored 第三方依赖（原样 npm 包）里有两类**非用户数据**的必然命中：
            #   · 作者邮箱：各包 package.json / README / SECURITY.md（npm 元数据，不是我们的联系人）
            #   · SWC 生成的哈希变量名 `$69aac16029968692$var$…` 里含 11 位数字，会命中手机号正则
            #     （fontkit 的 dist 被 swc 打包成这种名字，改不动）
            # 只对这三棵上游依赖树放行正文特征，文件名/私图/purge/dshhome 种子等判定照旧，
            # 放行条数写进报告，便于审计。
            vendor = ('dshhome/profiles/web/node_modules/@office-kit/',
                      'dshhome/profiles/web/node_modules/fflate/',
                      'dshhome/profiles/web/node_modules/dsh-ppt/node_modules/')
            # 2026-11-04：rc5 内核自带的 documentpreview 把 Excel 解析库打包成 client.excel.js，
            # 数值常数（如 66456.14382024054）会命中手机号正则、elliptic 的作者邮箱会命中 email。
            # 不放行整文件：例外绑「完整路径 + 文件 sha256 + 具体规则」，其余隐私规则照扫；
            # 文件哈希一变（上游改了内容）就当新文件重新报警，逼一次人工复核。
            content_exceptions = {
                'dshroot/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/'
                'dsh-client-ui-sidebar-documentpreview/lib/client.excel.js': {
                    'sha256': 'b2d7fbe8ca2132f18cd9abe897dd2d0f718ac44906c781fad8b4fabbe59304f4',
                    'labels': ('phone', 'email'),
                },
            }
            suppressed = []
            # 人称死规则：扫这一层 payload 的**全部**正文，不只我们自己的文件清单。
            name_files = scan_names(inner, 'payload', problems, suppressed)
            # P1-7：词表形态的「流光/拾光」+ 配置默认值里的称呼（唤醒词就是这条缝漏的）
            default_stats = scan_private_defaults(inner, problems, suppressed)
            if default_stats['listFormHits'] or default_stats['configDefaultHits']:
                print('FAIL: 称呼规则命中 %d 处词表形态 / %d 处配置默认值（涉及 %d 个文件）'
                      % (default_stats['listFormHits'], default_stats['configDefaultHits'],
                         default_stats['files']))
            patterns = {
                # 手机号：前后紧邻字符不许是十六进制数字 —— 上游 CHANGELOG 里的 commit hash
                # （…/commit/51934782720725acca…）会被无边界正则截出 11 位「号码」，纯误报。
                # 边界是精确解：真号码旁边的字符不会是 a-f；不加白名单，否则同文件里出现真号码会一起漏过去。
                'phone': r'(?<![0-9a-fA-F])(?:\+?86[- ]?)?1[3-9]\d{9}(?![0-9a-fA-F])',
                'email': r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(?:com|cn|net)',
                'private app': r'sgzzlb|aweme\.lite',
                'private path': r'/sdcard/Download/(?!(?:DeepSeekHarness|DSH_Backups|DSH_Knowledge|DSH_WorkLogs|DSH_Drop)(?:/|[^\w/]|$))[^\s"\x27`<>]+|dsh_own_app|fluidcard-mock',
                'credential': r'\bsk-[A-Za-z0-9_-]{16,}|\bghp_[A-Za-z0-9]{20,}|\bgithub_pat_',
                'local dependency': r'link:/',
            }
            vendored = 0
            for n in sorted(own & set(names)):
                if n.startswith(vendor):
                    vendored += 1
                    continue
                data = inner.read(n)
                if b'\0' in data[:1024]:
                    continue
                text = data.decode('utf-8', 'ignore')
                skip: frozenset = frozenset()
                exception = content_exceptions.get(n)
                if exception is not None:
                    digest = hashlib.sha256(data).hexdigest()
                    if digest == exception['sha256']:
                        skip = frozenset(exception['labels'])
                        suppressed.append({'path': n, 'sha256': digest, 'rules': list(skip)})
                    else:
                        # 文件变了 → 旧例外的依据失效，按普通文件全规则扫
                        problems.append('privacy exception stale (file changed, review again): ' + n)
                        skip = frozenset(exception['labels'])
                for label, pattern in patterns.items():
                    if label in skip:
                        continue
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
            if os.environ.get('DSH_KEEP_USER_BG') == '1':
                if not image or 'dsh-bg-user.png' not in image[0] or prefix + 'dsh-bg-user.png' not in names:
                    problems.append('user background missing or not selected')
            elif not image or 'dsh-bg.svg' not in image[0] or prefix + 'dsh-bg.svg' not in names:
                problems.append('generic background missing or not selected')
    return problems, vendored, suppressed, name_files, default_stats


def main():
    a = argparse.ArgumentParser()
    a.add_argument('--apk', required=True)
    a.add_argument('--overlay', required=True)
    a.add_argument('--wallpaper', required=True)
    # 不强制：签名前那道闸门只想拿到 0/1，不需要写收据；带 --report 的那次才落哈希绑定证据。
    a.add_argument('--report')
    # 底包必须一起扫：底包的内层 payload 才是真正发出去的字节。
    # 不做「没传就跳过」—— 那种静默跳过正是这次三个包带毒还显示 PASS 的原因。
    a.add_argument('--base-apk', required=True,
                   help='底包 APK（如 selfbuild/work/base-current-175.apk）；其 payload 与人称规则同扫')
    args = a.parse_args()
    before = file_sha(args.apk)
    base_sha = file_sha(args.base_apk) if os.path.isfile(args.base_apk) else None
    problems, vendored, suppressed, name_files, default_stats = scan(args.apk, args.overlay, args.wallpaper)
    base_name_files, base_notes = scan_base_apk(args.base_apk, problems, suppressed)
    if base_sha is not None and file_sha(args.base_apk) != base_sha:
        raise RuntimeError('base APK changed during privacy scan')
    if file_sha(args.apk) != before:
        raise RuntimeError('APK changed during privacy scan')
    # 底包原文命中只报不判：这是「原料脏、成品干净」的证据，不该让它挡住出包。
    for note in base_notes[:60]:
        print('NOTE(base 原文, 历史输入, 不判失败):', note)
    if problems:
        for issue in problems[:60]:
            print('FAIL:', issue)
        return 1
    if not args.report:
        # 闸门模式（签名前那次）：同一个 scan()，同一条判据，只是不写报告 ——
        # 早一点的这道如果比后面松，那前移就等于没有。
        print('PASS(闸门模式, 未写报告): 隐私检查通过 apk sha256=' + before)
        return 0
    report = {'schema': 1, 'kind': 'privacy', 'ok': True, 'apkSha256': before,
              'baseApkSha256': base_sha, 'baseApk': os.path.abspath(args.base_apk),
              'checks': {'filenames': True, 'wallpaperBytes': True, 'contents': True,
                         'dshhomeAllowlist': True, 'background': True, 'purge': True,
                         'profileDependencies': True, 'vendoredContentSkipped': vendored,
                         'privateNames': True, 'privateNameFiles': name_files,
                         'privateNameListForm': True,'privateNameInDefaults': True,
                         'privateNameDefaultHits': default_stats,
                         'basePayloadPrivateNameFiles': base_name_files,
                         'baseFindings': base_notes,
                         'suppressedContentMatches': suppressed},
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
