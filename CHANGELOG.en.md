# DeepSeek Harness changelog

> Chinese original (authoritative and most up to date): [CHANGELOG.md](CHANGELOG.md).
> This English page mirrors it; if the two ever disagree, the Chinese one wins.

> Current release: `1.36`. Every release installs **straight over the previous one** — same signing key,
> in-place upgrade, no uninstall (uninstalling wipes all app-private data).

---

## v1.36 — one-tap in-app upgrade + eight tools back in the list

- **One-tap upgrade inside the app**: once a new version is detected you can download and install it right in
  the app, with no detour through a browser.
  - **Multi-source download with fallback**: the official direct link and the China-friendly mirrors are all
    candidates; whichever responds first is used, a stalled one is dropped for the next;
    if a downloaded package fails verification, the next source is tried automatically;
  - **HTTP Range resume**, so a flaky connection does not mean starting over;
  - **SHA-256 verification** after the download; the system installer is invoked only once it passes;
  - this release itself installs the old way (older versions download it from a browser); after that, later
    versions can be upgraded from inside the app.
- **Fix: eight tools were not loaded from older packages** (the most important item in this release):
  - because a plugin declared its parameters in a non-compliant way, the `dsh-tool-shizuku` plugin failed to
    load as a whole, so eight tools — privileged execution, notifications, clipboard, scheduled tasks,
    voice input and text-to-speech among them — never appeared in the tool list;
  - fixed here: all eight are available again (whether they actually run still depends on the matching system
    permissions and service state).
- **Notifications**:
  - task-completion alerts get their banner and vibration back instead of quietly sitting in the shade;
  - quieter post-restart self-check notifications (they only speak up when there is enough to report);
  - fixed the occasional "empty message" notification;
  - notification taps: the session-creation request was missing its auth header (the engine used to reject it).
- **New "notification history" in the console**: read the full text of the most recent 100 notifications.
- **Expense tracking**: more phrasings such as "already paid" are recognised, so Alipay/WeChat transactions are
  missed less often.
- **Stability and hardening**: verification of backup archives, safer file read/write boundaries, a local-request
  fence for the virtual display, and one unified channel for engine calls; plus fixes for several API-call errors
  and a leaked connection resource.

> Upgrade as before: same-signature install over the top, **no uninstall** (uninstalling wipes all app data).

---

## v1.35 — life-scene hub + on-device knowledge base and LAN collaboration + deep-work and office skill matrix

- **Proactive life scene engine**:
  - **Morning briefing and evening review**: in the morning it gathers the parcels to collect (pickup code +
    pickup point), the budget and active tasks; in the evening it reviews today's spending by category and
    hard-reminds you about parcels not collected yet;
  - **Ambient life awareness**: verification codes extracted and copied in milliseconds, WeChat/Alipay/bank
    transactions recorded automatically, parcel pickup codes recognised automatically.
- **On-device personal knowledge base with instant full-text search (Local RAG)**:
  - zero-token on-device semantic search, a pure native inverted index with N-gram tokenisation;
  - **Quick Clip** files notes away and indexes them incrementally in real time;
  - a dedicated "local knowledge base and full-text search" page in the console.
- **LAN mesh across devices, with over-the-air file drop**:
  - open the phone's DSH console from a computer's browser;
  - two-way clipboard sync between devices within a second;
  - send large files from the computer to the phone, with MD5 verification.
- **Deep-work and audit-trace engine**:
  - `dsh-code-craft`: five-dimension industrial code review, production-grade refactor diffs, unit tests and mocks;
  - `dsh-data-craft`: zero-dependency fast data cleaning and pivoting, native good-looking charts, deep
    root-cause analysis of business anomalies;
  - `dsh-deep-research`: 10+ dimension trade-off matrices and big-tech-grade RFC/ADR architecture proposals;
  - `dsh-scrum-master`: WBS task breakdown, Mermaid agile Gantt charts and critical-path analysis;
  - every deep task emits a structured workflow plus a local audit card (`/sdcard/Download/DSH_WorkLogs/`).
- **Four high-end office skills**:
  - `dsh-doc-publisher`: Word/DOCX business and government document publishing (zero-dependency export of a
    standard .docx with headings, multi-level numbering and auto-fitting tables);
  - `dsh-excel-copilot`: Excel multi-sheet alignment and formula automation (heterogeneous header merging,
    SUM/AVG formulas injected into .xlsx);
  - `dsh-meeting-copilot`: meeting-transcript noise reduction and action-item extraction (three-layer structured
    minutes plus a group announcement for WeCom/Feishu);
  - `dsh-mail-craft`: workplace-tone official letters and mail advice (three registers: upward reporting, formal
    official letter, cross-team coordination).

> Upgrade as before: same-signature install over the top, **no uninstall** (uninstalling wipes all app data).

---

## v1.34 — reasoning-effort switching and mobile interaction polish

- **Model and thinking-level picker fixed on mobile**:
  - fixed a `blur` event conflict when touching the screen while the software keyboard collapses, which made the
    model picker "flash closed / feel unresponsive";
  - declared `reasoningEfforts` for third-party reasoning models (Gemini-3.7, the Claude Thinking series and
    others), so reasoning depth (`low / high / max`) can be picked right from the popup above the input box.
- **Settings console layout: responsive and slimmer**:
  - rebuilt the mobile responsive layout (media queries), fixing title wrapping and squeezed buttons on narrow screens;
  - removed duplicated configuration entries; the UI is cleaner and tighter.
- **System environment and stability**:
  - a more complete native safe mode and failure-recovery fallback.

---

## v1.33 — native console merged into the web settings page + official productivity skills bundled + terminal and interaction polish

- **Console rebuilt as a native settings page (`android-console`)**:
  - the standalone Android console became a "Console" panel inside DSH's web settings, styled to match "General settings";
  - it manages data extraction, engine state (start/restart/stop), rescue mode (safe mode / config import and
    export), system permissions, plugin switches, the build environment and time-machine backups in one place;
  - the native console is now a minimal rescue screen (it steps in only when files have not been extracted yet or
    the engine is misbehaving).
- **Full set of official and practical skills bundled (built-in skills)**:
  - eleven bundled skills, ready out of the box:
    - `dsh-diagram`: modern, good-looking architecture diagrams for codebases and business logic (Mermaid / inline SVG);
    - `dsh-slides`: automated design and generation of modern decks (PPTX);
    - `dsh-storyboard`: short-video storyboards and motion-effect scripts;
    - `dsh-memory-sync`: cross-session long-term memory hub with distillation and retrieval;
    - `dsh-doc-tidy`: zero-dependency, no-click batch processing and statistics for Office documents (xlsx/docx/pptx);
    - `dsh-backup`: time-machine full-site one-tap backup, snapshot management and cross-device migration;
    - `dsh-doc-search`: second-level lightweight indexing and smart search over local code and docs (Local RAG);
    - `dsh-mobile`: Android accessibility and app-automation plumbing;
    - `dsh-review`: independent cross-vendor multi-model review;
    - `dsh-tier`: model effort tiering and dynamic task routing;
    - `dsh-web-crawler`: scraping public web pages and structured data.
- **System environment and terminal compatibility fixes**:
  - fixed a terminal startup failure caused by a missing `SHELL` environment variable on Android, with a reliable
    system-shell fallback;
  - better console interaction feedback: confirmations and hints now use global overlays (modal/toast) so they are
    not lost at the end of a long scrolling page.

> Upgrade as before: same-signature install over the top, **no uninstall** (uninstalling wipes all app data).

## v1.32 — time-machine full-site backup + local code/doc RAG engine

- **Time-machine full-site backup (`.dshbackup`)**:
  - a one-tap "time-machine full-site backup" card on the console home page;
  - pure Node.js built-in modules, zero dependencies, packaging in seconds — sessions, memory database,
    configuration and skill assets archived in a moment;
  - the `dsh-backup` skill is bundled: snapshot creation, verification, listing and cross-device restore.
- **Smart search/Q&A over local code and technical docs (Local RAG)**:
  - a lightweight multi-dimensional retrieval and chunking engine tuned for phone-class resources;
  - the `dsh-doc-search` skill is bundled: second-level project indexing, cross-file keyword search and
    structured context extraction.
- **Startup and console visuals**:
  - the startup orbital progress ring got finer animation and support for both themes;
  - invasive hooks into the floating window and the clipboard were removed completely, keeping system interaction
    clean and smooth.

> Upgrade as before: same-signature install over the top, **no uninstall** (uninstalling wipes all app data).

## v1.31 — engine core upgraded to 0.2.0-rc.2, plus polish

- **Engine core upgraded to 0.2.0-rc.2**: follows the upstream core and fills in Android platform compatibility.
- **Startup transition rebuilt**: the crude countdown and progress bar are gone, replaced by the official dark,
  minimal look with a soft breathing animation that hands over seamlessly to the web UI.
- **Memory panel fixes and improvements**:
  - fixed mount-prefix path matching, restoring the memory list and its statistics;
  - added safe-area padding for the mobile status bar and tuned the spacing of titles and icons;
  - strengthened the SQLite concurrent-write timeout for stabler multi-module concurrent access.
- **Image input completed**: the multimodal input type declaration was filled in, so multimodal models are no
  longer mistaken for text-only models and images are no longer stripped from attachments.
- **Low-level compatibility fixes**:
  - fixed session-write failures (`EACCES`) caused by hard links in the private directory on some devices;
  - pure-JS image decoding and format reporting aligned;
  - bundled ripgrep and the dynamic-library load path completed.

> Upgrade as before: same-signature install over the top, **no uninstall** (uninstalling wipes all app data).

## v1.30 — desktop pet + fluid notification card + cross-vendor review skill

**New: desktop pet (the floating ball grows up)**
- The ball is no longer just a launcher: **tap it and it "speaks"** (a speech bubble), and tapping the bubble
  opens the chat panel; the bubble closes when you tap elsewhere or when nothing happens for three seconds, and
  it follows the ball when you drag it.
- Bubbles take turns showing: a line, account balance, usage today, last-turn cost, peak/off-peak windows and
  budget hints.
  - "usage today" and "last-turn cost" are **estimated from the balance difference**, and the text always carries
    a "≈";
  - peak/off-peak follows the official rule (weekdays 09:00–12:00 and 14:00–18:00 are peak; everything else,
    weekends included, is off-peak), with holidays counted as peak for now.
- The ball's look/size/lines and the bubble and card styles are all driven by a single file,
  `payload/pet/pet.json`; change it and restart.
  ⚠️ **The character artwork is not distributed with the package** (the original has licensing limits) → a
  built-in whale icon is used by default; to use your own image, drop a square PNG at `payload/pet/whale-shota.png`.

**New: fluid-cloud style reply card**
- While the AI is writing, a **capsule** slides out under the status bar (avatar + the first dozen characters);
  tap the capsule to **expand it into the full card**, the body growing paragraph by paragraph, and it retracts on
  its own a moment after the reply finishes.
- The card can be **scrolled by hand**; auto-scroll only follows when you are already at the bottom (it never
  fights your finger); very long replies are capped in height and scroll inside the card.
- Two switches: "fluid cloud: on/off" in the chat panel and "turn fluid cloud on/off" in the notification shade.
- The card only shows **new content** (the same text does not float by twice), and expanding it does not get in
  the way of using the UI.

**New: three bundled skills** (installed with the app, nothing to configure)
- `dsh-review`: **cross-vendor multi-model review** — have two or more models from different vendors each review
  the same artefact independently, then merge "agreement / disagreement"; ships with a channel health-check
  script, a collaboration template, and cost and privacy red lines.
- `dsh-mobile`: the general method for getting things done on this phone (screen reading / tapping / gestures /
  notifications / scheduling / virtual display).
- `doc-tidy`: zero-dependency reading and tidying of xlsx / docx / pptx.

**Fixes (a long list, all about the floating ball)**
- **The ball comes back after an app restart**: your last on/off intent is remembered; people who never turned it
  on are still never nagged by a popup.
- Fixed "can't hit the ball", "it does not appear when it should" and "the panel will not close after typing".
- The ball can half-hide against the **left / right / top** edges, with **68%** of it showing at rest — easier to grab.
- A "toggle panel" action in the notification shade; panel button meanings sorted out: **"collapse" only closes the
  reply area, "hide" is what half-hides the ball**.
- Two side effects of the self-check probe are gone: the ball flickering when you tap the input box, and the
  fluid-cloud switch "only working once".

---

## v1.35 — in-app changelog (this file)

**New**
- The app now ships a **changelog**: this document travels with the installed package (a reinstall or a kernel
  re-extraction will not lose it).
- Three ways to read it:
  1. open `http://127.0.0.1:3080/CHANGELOG.md` in the UI (credentials are still required);
  2. read it over the API: `GET http://127.0.0.1:3081/changelog` (returns the version plus the full text, for
     tools/AI to read);
  3. after every update the app **posts one notification** (titled like "app updated to v1.34", with that
     release's first bullet as the body) — once per version; a first install stays silent.

**Notes**
- The version number is the build number of our own packages (`v1.xx`), kept separate from the APK's
  `versionCode` (fixed at 51) — the latter stays put so that packages **upgrade in place** (uninstalling wipes data).

---

## v1.34 — compiling native extensions on the device

**New**
- The Android-side C/C++ toolchain is complete (clang 21 + ndk-sysroot + libc++ + lld + binutils + make), all
  extracted into the app's own directory with no external environment required.
- So **any missing native Python module can be compiled on the spot**: `kiwisolver` was built from source and
  `matplotlib` became usable with it (it can plot and save PNGs).
- Three new Python entry points, `dsh-cc` / `dsh-cxx` / `dsh-pip`, so packages with C extensions no longer need an
  external toolchain.

**Fixes**
- The Python interpreter used to need an environment variable to start (otherwise `CANNOT LINK`); RUNPATH is now
  set, so any tool can call it directly.

**Known limitations**
- `pandas` cannot be installed for now: it builds with meson, and the ninja available here cannot spawn build
  subprocesses (Termux's ninja spawn shim conflicts with Android's security policy). Downgrading does not help
  either (older versions do not compile on Python 3.14).

---

## v1.32 / v1.33 — LAN access (switchable), a native Python ecosystem, editable app resources

**New: LAN access (off by default)**
- You can now open this app's UI from a computer's browser on a **trusted LAN**.
- The default is still **localhost only**; to enable: `POST http://127.0.0.1:3081/lan` with the body
  `{"enabled":true,"token":"<local_token>"}` — the engine restarts automatically to apply it; send `false` to turn
  it off.
- Status: `GET http://127.0.0.1:3081/lan` (returns the usable address).
- ⚠ The token travels over plain HTTP and can be sniffed on the same network segment — enable it only on a trusted
  network, and turn it off when you are done.

**New: native Python ecosystem (no longer limited)**
- Python extensions are now **native to the device** (no emulation layer, no system-call restrictions): numpy,
  Pillow, lxml, scipy, cryptography, matplotlib, python-docx, python-pptx, openpyxl, XlsxWriter, requests, bs4,
  PyYAML, tabulate…
- In other words: **Word / Excel / PPT generation, PDF and spreadsheet handling, image processing, plotting and
  scientific computing** all work directly.
- It also brings 40-odd native small tools (`aapt` / `aapt2` / `cwebp` / `dwebp` / `avifenc` / `brotli` …).

**New: the app's own manifest and resources can be modified**
- Android resource compilation (native aapt2) and APK unpack/repack (apktool) are now available.
- Why it matters: previously only code could be changed; now **adding permissions, adding components, changing the
  icon or splash screen and editing resource strings** are all possible, and the whole loop has been verified
  (unpack → edit manifest → repack → sign → verify → read the content back).

---

## v1.31 — security surface closed, assets shipped with the package, automatic backups, package health check

**Security**
- The last unauthenticated route (`/dsh-update-check/status`) is closed. All 14 probeable local routes now
  **require authentication** (401 without credentials).

**Improvements**
- Front-end assets such as the background image are now **distributed with the installed package**: a reinstall or
  a kernel re-extraction no longer loses them, and nothing has to be restored by hand.
- **Automatic backups**: the boot self-check (throttled to once every 20 hours) packs session records, keys and
  configuration into `/sdcard/DeepSeekHarness/backups/`, keeping the last 5; restore with
  `backup-dshhome.sh --restore <archive>`.
- **Offline package health check** (`verify-apk-payload.js`): inspect a package for "complete structure, complete
  patches" without installing it — rollback packages included.

---

## v1.30 — plugin route authentication (redone the safe way)

- `/plugins/<id>/client.js` and `/plugins/events` used to be **completely unauthenticated**; both now require
  credentials (401 without them).
- Note: the first attempt failed back in v1.28 (it changed the dependencies of a plugin the engine needs, and the
  engine would not start). v1.30 uses an approach that **leaves plugin dependencies alone and fetches the auth
  service lazily at runtime**, and it was validated in an isolated instance before being installed.
- To prevent a repeat, a **hard gate before installing** was added: start the engine in an isolated instance and
  verify the routes one by one; no pass, no install.

---

## v1.24 – v1.29 — stability and recovery

**New**
- **Boot self-check**: about 90 seconds after the engine starts it checks the core, the plugins, patch integrity,
  each bridge and the password gate, the disk and the permissions, and only notifies you on failure; it waits for
  the system to settle first so that "still restarting" is not mistaken for a fault.
- **Static-asset gate**: non-entry static assets (personal background images included) could previously be read
  without credentials; now they cannot.

**Recovery**
- The failed changes from v1.28 were fully reverted and recovered in v1.29; the lessons became rules (see the end
  of this file).

---

## v1.21 – v1.23 — the app can update and sense itself

**New**
- **Self-build / self-install**: the app is now a complete build environment (Alpine + OpenJDK 17 + Android
  build/sign tools), and with the same key as the installed package it can **upgrade itself in place** (no
  uninstall, no data loss).
- **Numeric checks**: new procedures such as "save a rollback package before installing", "verify every patch after
  producing a build" and "validate in an isolated instance before installing".
- **Notification reading**: the app can now read phone notifications (title / body / package / time), which needs
  the accessibility service; on the AI side this is exposed as `android_notifications` /
  `android_notifications_wait` and friends.

---

## Known limitations (an honest list)

| Item | Detail |
|---|---|
| `pandas` | see v1.34: the local ninja cannot spawn build subprocesses, so it will not install (downgrading does not help either) |
| LAN access | has to be enabled by hand, and the token is plain HTTP — use it only on a trusted network |
| External command-line tools | ffmpeg / tesseract / poppler and others run inside the proot emulation layer, a little slower than native |
| Engine core version | follows the official releases; the upgrade procedure is documented but has **not been rehearsed for real** |
| Rollback package | signature and structure are verified, but a live "install it, then install back" drill **has not been done yet** |

---
