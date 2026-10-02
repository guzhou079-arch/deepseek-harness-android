# DeepSeek Harness · Android Port (Enhanced)

An Android port of **DeepSeek Harness** (DeepSeek's AI agent, originally desktop-only),
packaged as an APK you can simply install.

**No Termux. No root. No environment setup.** Terminal, file access and command
execution all run inside the app.

| What you get | |
|---|---|
| 🐳 **Floating ball / desktop pet** | Tap it and it "talks": lines, account balance, today's spend, last turn's spend, peak/off-peak pricing hints |
| ☁️ **Fluid-cloud reply card** | While the AI is writing, a capsule appears at the top; tap to expand into a card, scroll it by hand |
| 📱 **Phone automation** | Screen reading, taps, typing, notification capture, scheduled tasks, virtual display |
| 🔧 **Build it on the phone** | javac → dex → pack → sign → release, no PC needed (build environment is an in-app on-demand download) |
| 🧩 **Bundled skills** | `dsh-mobile` (phone automation) · `doc-tidy` (Office files) · `dsh-review` (cross-vendor model review) |

**Download**: see this repository's **Releases**. GitHub and Gitee are **two peer
repositories** — same tag, same APK, identical content (neither mirrors the other).

---

> ## ⚠️ Read before updating — only update from this repository's Releases
>
> This app is signed with **this project's own key**. Installing a same-named app from
> **any other source** (the official build, the upstream author's build, a reposted APK)
> will fail with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, because Android refuses to
> overwrite an app signed with a different key.
>
> If you then choose to *uninstall and reinstall*, **all app-private data is wiped**
> — session history, runtime environment, settings. It cannot be recovered.
>
> **Seeing that error means your data is being protected. Do not uninstall.**
> Back up first: `sh selfbuild/scripts/backup-dshhome.sh`
>
> Full guide (Chinese) → [docs/升级与救援.md](docs/升级与救援.md)

---

## Sources & licenses

| Part | Origin | License |
|---|---|---|
| Android shell skeleton | [woaiys3/deepseek-harness-android-app](https://github.com/woaiys3/deepseek-harness-android-app) | MIT |
| `@deepseek-ai/dsh` engine | DeepSeek | © DeepSeek |
| Virtual display (vscreen) | [AAswordman/Operit](https://github.com/AAswordman/Operit) | LGPL-3.0 |

This package is provided **free of charge, for non-commercial use**.
See [README.md](README.md) for the full attribution and license texts
(`LICENSE`, `licenses/`, `THIRD_PARTY_NOTICES.md`).

---

## Build it yourself — on the phone, no PC required

The whole toolchain runs on-device (proot + Alpine + OpenJDK 17, plus
`android.jar` / `d8.jar` / `apksigner.jar`).

**It is _not_ bundled in the APK** — it weighs ~342MB, and most people only want the AI.
So it is an **on-demand download**:

> **Console → "Build environment"** → pick GitHub or Gitee → ~193MB, verified
> (sha256, per part *and* whole) and extracted automatically.
>
> Both repositories host **the same split archives** — neither is a fallback for the other.
>
> The archives stay in `/sdcard/DeepSeekHarness/buildenv`, so **reinstalling the app
> only needs a re-extract, not a re-download**.

Then:

```sh
sh selfbuild/selfbuild.sh all     # payload → patch → pack → sign → verify
```

⚠️ Things that will bite you (learned the hard way):

- **Signing keys**: the on-device key lets you overwrite-update *your* install; a
  distribution build needs the release key. Mixing them up means whoever installs it
  **cannot overwrite-update** — and uninstalling wipes all their data.
- **Version numbers must be set explicitly** when packing, or the update check breaks
  and `pm install -r` may be rejected as a downgrade.
- **⛔ Never install a self-built APK directly** — verify it in an isolated instance first
  and keep a rollback APK on `/sdcard`.

See `selfbuild/` for the scripts and `docs/` for per-patch notes.
