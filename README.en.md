# DeepSeek Harness · Android port (enhanced)

**DeepSeek Harness**, packaged as a ready-to-install **Android APK**.

**No Termux, no root, no setup** — the terminal, file access and command execution all run inside the app.
It can even compile, package, sign and release itself, entirely on the phone, without a computer.

**中文** | [English](README.en.md)

| What you get | Detail |
|---|---|
| 🐳 **Floating ball / desktop pet** | Tap the ball and it "speaks": lines, account balance, usage today, last-turn cost, peak/off-peak hints |
| ☁️ **Fluid notification card** | While the AI is writing, a capsule appears under the status bar; tap to expand into a card you can scroll by hand |
| 📱 **Phone automation** | Screen reading, tapping, text input, notification access, scheduled tasks, virtual display |
| 🔧 **Self-building on the phone** | javac → dex → package → sign → release, all on-device (the build environment is downloaded on demand) |
| 🧩 **21 bundled skills** | Ready out of the box — no plugin hunting: diagrams, slide decks, storyboards, memory hub, Office batch processing, Word/公文 publishing, Excel multi-sheet alignment, meeting notes, business mail, local RAG search, full-site backup, phone automation, cross-vendor review, effort tiering, web crawling, code craft, data insight, deep research, scrum planning, life hub, voice |
| ⬇️ **Quick install** | Download the APK → allow installing unknown apps → open it, follow the permission guide → paste your own model API key |

**Download**: see **Releases**. Each release lists the APK's SHA-256 so you can verify it before installing.

**Docs** (English): [install & requirements](docs/en/install.md) · [permissions & privacy](docs/en/permissions.md) · [FAQ](docs/en/faq.md) · [upgrade & rescue](docs/en/upgrade-and-rescue.md) · [build environment](docs/en/build-on-device.md) · [attribution & license](docs/en/sources-and-licenses.md) · [changelog](CHANGELOG.en.md)

> 中文文档（最新原文）：[安装与要求](docs/安装与要求.md) · [权限与隐私](docs/权限与隐私.md) · [常见问题](docs/常见问题.md) · [升级与救援](docs/升级与救援.md) · [自建环境与出包](docs/自建环境与出包.md)

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

- Android adaptation patches (45+): app shell, single-process engine, storage/permission handling, engine startup and HTTP dispatch.
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

⭐ If this saved you time, a **star** is the best feedback — issues and feature requests are welcome (https://github.com/guzhou079-arch/deepseek-harness-android/issues).
