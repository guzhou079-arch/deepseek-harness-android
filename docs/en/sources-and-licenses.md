# Attribution & License

This release package is an **Android port and enhancement of DeepSeek Harness**, made by an individual.
Below is an honest account of where each part comes from.

> 中文原版（以此为最新）：[发布用-来源与许可.md](../发布用-来源与许可.md)

---

## 1. What I did (changes relative to upstream)

The upstream project `woaiys3/deepseek-harness-android-app` provides the **Android shell skeleton** (WebView +
Service structure, payload packaging, permission onboarding). On top of that foundation this version contains a
large amount of adaptation and enhancement work:

### 1.1 Android adaptation patches (25 of them)

| Category | Content |
|---|---|
| System capabilities | NFC tag reading · accessibility screen reading / taps / screenshots · virtual display · notification reading · privileged channel (Shizuku / root) |
| Engine adaptation | `bash-local` sandboxMode · `flock` Android fallback · `session-persistence` hard-link workaround |
| Security hardening | static asset gate · client route authentication · update-check gate · explicit switch for LAN binding |
| Interface | account UI unlocked · custom background image · mobile layout rework · in-app release notes |
| Sign-in | authorisation link opened in the system browser · automatic return to the app after sign-in |

### 1.2 A self-contained build pipeline (packaging done on the phone, no computer)

```
proot + Alpine + OpenJDK 17   → javac on the phone
android.jar / d8.jar          → classes.dex
selfbuild.js / ziptool.js     → unpack and repackage
pkcs12.keystore               → self-signing
set-apk-version.js            → change the version in the binary manifest
```

Roughly 5,000 lines of self-build scripting (26 tool scripts + 6 packaging libraries).

**How to get the build environment**: it is not in the repository and not in the APK (342 MB is too much) — it is
**downloaded on demand inside the app**. Go to "Console → Build environment", download about 193 MB, and after the
automatic verification and extraction you can build. The parts stay on `/sdcard`, so **reinstalling the app only
requires re-extraction, not re-downloading**.
Full steps and pitfalls: [`docs/自建环境与出包.md`](../自建环境与出包.md).

### 1.3 Self-authored plugins and patches

- `whale-shota` — skin + desktop pet
- `dsh-android-ui` — Android interface adaptation
- background-image patch, account UI patch

---

## 2. Sources and licences

### 2.1 Android shell skeleton — MIT

| Item | Content |
|---|---|
| Project | **deepseek-harness-android-app** |
| Author | [woaiys3](https://github.com/woaiys3) |
| Repository | <https://github.com/woaiys3/deepseek-harness-android-app> |
| Licence | **MIT License**, Copyright (c) 2026 woaiys3 |

The MIT licence permits modification, distribution and redistribution, and **requires that the copyright notice and
the licence text be retained**.

### 2.2 DSH engine kernel — owned by DeepSeek

| Item | Content |
|---|---|
| Project | **@deepseek-ai/dsh** (DeepSeek Harness) |
| Repository | <https://github.com/deepseek-ai/deepseek-harness> |
| Licence | **MIT License** (copyright DeepSeek; the full licence ships with the package) |
| Note | This package contains its build output; copyright and licence remain with the original authors, and this project claims no rights over it |

### 2.3 Virtual display (vscreen) — LGPL-3.0

| Item | Content |
|---|---|
| Project | **Operit** — Android AI Agent |
| Author | [AAswordman](https://github.com/AAswordman) |
| Repository | <https://github.com/AAswordman/Operit> |
| Licence | **GNU Lesser General Public License v3.0 (LGPL-3.0)** |

The virtual-display implementation is ported from / aligned with Operit's `shower` module. The relevant source files
**carry the original licence notice**, and the full licence text is at `licenses/lgpl-3.0.txt` (LGPL-3.0 is built on
GPL-3.0, so `licenses/gpl-3.0.txt` is provided as well).

---

## 3. Disclaimer

- Any consequence of using this package is the user's own responsibility
- If any original author considers this package inappropriate, **please contact me and I will take it down immediately**
- This package does not modify or circumvent any paid mechanism

---

## 4. Where the full licence texts are

```
LICENSE                     MIT (this project)
licenses/lgpl-3.0.txt       LGPL-3.0 (the virtual-display part)
licenses/gpl-3.0.txt        GPL-3.0 (the basis of LGPL-3.0)
THIRD_PARTY_NOTICES.md      item-by-item third-party component notices
```
