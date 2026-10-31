# DeepSeek Harness for Android

<div align="center">

**English** ｜ [中文](README.md)

[![Download the latest APK](https://img.shields.io/badge/%E2%AC%87_Download_APK-2ea44f?style=for-the-badge)](https://github.com/guzhou079-arch/deepseek-harness-android/releases/latest)
[![Install & requirements](https://img.shields.io/badge/Install_%26_requirements-3_steps-0b6bcb?style=for-the-badge)](docs/en/install.md)
[![FAQ](https://img.shields.io/badge/FAQ-common_questions-6e40c9?style=for-the-badge)](docs/en/faq.md)

![Platform](https://img.shields.io/badge/Platform-Android%208.0%2B-brightgreen)
[![Release](https://img.shields.io/github/v/release/guzhou079-arch/deepseek-harness-android?label=latest%20release)](https://github.com/guzhou079-arch/deepseek-harness-android/releases/latest)
[![Stars](https://img.shields.io/github/stars/guzhou079-arch/deepseek-harness-android?style=flat&label=stars)](https://github.com/guzhou079-arch/deepseek-harness-android/stargazers)
[![Last commit](https://img.shields.io/github/last-commit/guzhou079-arch/deepseek-harness-android)](https://github.com/guzhou079-arch/deepseek-harness-android/commits/main)

</div>

**DeepSeek Harness as a ready-to-install Android APK — no Termux, no root, no PC.**

Paste your own model API key and it is working: screen reading, taps, typing, a virtual display to drive other apps, scheduled tasks, 21 bundled skills.
**What makes it different: it builds itself** — edit code on the phone and run `javac → d8 → repackage → sign → release` without ever touching a computer.

## What you skip

| | Rolling your own | This APK |
|---|---|---|
| Setup | Termux, Node, clone the repo, wire up the config | Download, install |
| First run | A pile of commands and docs | Paste one API key |
| Skills | Install them one by one | 21 bundled |
| Your screen while the AI works | Occupied | It works on a virtual display; your screen stays yours |
| Build / release | Back to the PC | The phone builds, signs and ships it |

## What it does

| Highlight | Detail |
|---|---|
| 📱 **Phone automation** | Accessibility screen reading, taps, typing, notification access, scheduled tasks, and a virtual display so the AI works while your own screen stays yours |
| 🐳 **Floating ball / desktop pet** | Tap the ball and it "speaks": lines, balance, usage today, last-turn cost, peak/off-peak hints |
| ☁️ **Reply capsule** | While the AI writes, a capsule appears under the status bar; tap it for a scrollable card |
| 🎛️ **Console inside settings** | Engine control, rescue mode, permission overview, plugin switches, time-machine backup |
| 🧩 **21 bundled skills** | Diagrams · slide decks · storyboards · memory hub · Office batch · Word / formal docs · Excel · meeting notes · business mail · local RAG · full-site backup · cross-vendor review · web crawling · code craft · data insight · deep research · scrum planning · life hub · voice |
| 🔧 **Builds itself on the phone** | `javac → d8 → repackage → sign → release`; the build environment is downloaded on demand (~193 MB) |

On top of the upstream Android shell, this build ships 25 Android adaptation patches (system capability / engine / hardening / UI / login) plus self-authored plugins. Provenance and licenses are at the end of this file.

### Install in three steps

1. Open **[Releases](https://github.com/guzhou079-arch/deepseek-harness-android/releases/latest)** and download the latest `DeepSeekHarness-vX.Y-dist.apk` (~192 MB, Android 8.0 and up).
2. Install it, then follow the first-run permission guide (accessibility, notifications, floating window — every one of them can be revoked in system settings later).
3. Paste your own model API key in the settings page and start talking to it. No Termux, no root, no computer.

Each release note carries the APK's **SHA-256**, so you can verify the file before installing it.

> ⭐ If this saves you time, a star is the best way to say thanks — it also tells me the maintenance is worth it.
> Install / usage / upgrade problems → [Discussions](https://github.com/guzhou079-arch/deepseek-harness-android/discussions); bugs and ideas → [Issues](https://github.com/guzhou079-arch/deepseek-harness-android/issues).

> **In mainland China, where `github.com` often will not open?** The first line of every release note is an
> accelerator link (`ghproxy`-style prefix + the official URL). You can also prefix the official URL yourself:
> `https://ghproxy.net/`, `https://ghfast.top/`, `https://gh-proxy.com/`.

**Docs** (English): [install & requirements](docs/en/install.md) · [permissions & privacy](docs/en/permissions.md) · [FAQ](docs/en/faq.md) · [upgrade & rescue](docs/en/upgrade-and-rescue.md) · [build environment](docs/en/build-on-device.md) · [attribution & license](docs/en/sources-and-licenses.md) · [changelog](CHANGELOG.en.md)

> 中文文档（最新原文）：[安装与要求](docs/安装与要求.md) · [权限与隐私](docs/权限与隐私.md) · [常见问题](docs/常见问题.md) · [升级与救援](docs/升级与救援.md) · [自建环境与出包](docs/自建环境与出包.md)

**Related**: [Discussions](https://github.com/guzhou079-arch/deepseek-harness-android/discussions) — install / upgrade / usage questions

**Companion plugin** — [dsh-plugin-android-vscreen](https://github.com/guzhou079-arch/dsh-plugin-android-vscreen):
drive *other* apps on a **virtual display** (screen reading, taps, swipes, frames) while your own screen
stays yours. The same tools are already built into this APK; DSH on a computer can install the plugin
separately over `adb`:

```sh
dsh plugin --profile web add https://github.com/guzhou079-arch/dsh-plugin-android-vscreen/releases/download/v0.1.0/dsh-plugin-android-vscreen-0.1.0.tgz
```

> ## ⚠️ Read before upgrading — only update from this repository's Releases
>
> This app is signed with **this project's own key**. Installing a same-named app from **another source**
> (the official build, the upstream author's package, a forwarded APK) cannot overwrite it — the signatures differ.
> If you then choose to uninstall and reinstall, **all app-private data is wiped** (session history, runtime
> environment, configuration).
>
> When you see `INSTALL_FAILED_UPDATE_INCOMPATIBLE`: **do not uninstall** — that error is protecting your data.
> Back up first from the in-app console, or with `selfbuild/scripts/backup-dshhome.sh`.

## What was changed vs upstream

- Android adaptation patches (25): app shell, single-process engine, storage/permission handling, engine startup and HTTP dispatch.
- **On-device build chain**: the app can build, sign and publish itself; project sources and scripts are in this repository.
- Bundled skills and self-authored patches (see the repository tree).

## Provenance and license

| Part | Upstream | License |
|---|---|---|
| Android app shell | [woaiys3/deepseek-harness-android-app](https://github.com/woaiys3/deepseek-harness-android-app) | MIT |
| DSH engine core | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | see upstream |
| Virtual display bridge | [AAswordman/Operit](https://github.com/AAswordman/Operit) | LGPL-3.0 |

Full license texts: [licenses/](licenses/) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Disclaimer

Use at your own risk. Features that touch other apps or system settings require explicit authorization
(accessibility service, Shizuku, notifications, storage). Nothing in this repository grants any right to
third-party assets or trademarks.

---

⭐ If this saved you time, a **star** is the best feedback. **Install / usage / upgrade questions** → [Discussions](https://github.com/guzhou079-arch/deepseek-harness-android/discussions); **bugs and feature requests** → [Issues](https://github.com/guzhou079-arch/deepseek-harness-android/issues).
