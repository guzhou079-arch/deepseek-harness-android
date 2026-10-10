# Upgrading and rescue

> This document exists for one reason: **so you do not lose data.**
>
> This project has had one data-loss incident. This document is the signpost put up afterwards.

---

## 1. One rule

**Update only from this repository's Releases.**

A same-named app from anywhere else (the official build, another author's build, a re-uploaded APK) will
**refuse to install**, and it very easily pushes people into "uninstall and reinstall" — and that step wipes
everything.

---

## 2. Why it will not install (and why that is a good thing)

Android enforces one rule: **an APK with the same package name but a different signature cannot be installed over
an existing one.**

This app is signed with this project's own key, which is not the official or upstream key. Installing another
source gives you:

```
INSTALL_FAILED_UPDATE_INCOMPATIBLE
```

At that point you have exactly two choices:

| Choice | Result |
|---|---|
| ✅ **Drop it** and keep using this repository's build | Nothing happens; your data is untouched |
| ❌ Uninstall, then install the other build | **All app-private data is gone**: session history, proot environment, configuration, AGENTS.md … |

> ⚠️ **That error is protecting your data. When you see it, do not uninstall.**

---

## 3. Four situations, four responses

### Situation 1 · Updating to a newer release from this repository — normal, no data loss

Same signature, so simply **install over the top**. This is the only recommended way to update.
The in-app "check for updates" also points at this repository's Releases — just use it.

### Situation 2 · You accidentally installed an APK from somewhere else and it refused to install

**Do not uninstall — you have lost nothing.** Go back to this repository's Releases and download the right build.

### Situation 3 · You already uninstalled and reinstalled, and the data is gone

If you ran a backup before (see section 5), you can restore it:

```sh
# 1) see which backups exist
sh selfbuild/scripts/backup-dshhome.sh --list

# 2) restore (writes back into the app's private directory; restart the app to take effect)
sh selfbuild/scripts/backup-dshhome.sh --restore /sdcard/DeepSeekHarness/backups/dshhome-20260930-000934.tar.gz
```

With no backup, **the session history cannot be recovered.** That is the lesson from that incident.

### Situation 4 · Swapping the kernel / rebuilding on a new skeleton (the heaviest case)

After a kernel (`@deepseek-ai/dsh`) upgrade, the patch anchors of those **7 "modify-upstream" files may all stop
matching**, and the engine will not start. The full procedure lives in
`selfbuild/notes/kernel-upgrade-runbook.md`; the essentials:

1. Before upgrading, **while the kernel is still pristine**, build a baseline:
   `node selfbuild/scripts/upstream-baseline.js build`
2. Archive the currently installed APK: `sh selfbuild/selfbuild.sh base`
3. Back up dshhome: `sh selfbuild/scripts/backup-dshhome.sh`
4. **Upgrade the kernel alone**, with no other changes mixed in
5. Get it working under an **independent DSH_HOME and an independent port** before you even talk about installing

> ⚠️ `dshroot/REVISION` is the anchor the patches hang from. **Do not change it on its own** — changing it triggers
> a full re-extraction.

---

## 4. Three things that save your life (do them routinely)

| # | What | How |
|---|---|---|
| 1 | **Back up** | `sh selfbuild/scripts/backup-dshhome.sh` (keeps the most recent 5, about 40 MB each). The boot-time self-check runs `--auto` for you |
| 2 | **Keep a rollback APK** | `sh selfbuild/selfbuild.sh base` — stores the currently installed APK in `selfbuild/work/` |
| 3 | **Redundant keys** | `files/keys/` · `keys-rescued/keys/` · `files/_verify/keys/` |

---

## 5. What a backup contains — and what it does not

**Contains** (all small, all painful to lose):

```
dshhome/                   session history, settings, cordis.patch.yml, profiles, AGENTS.md
keys/                      signing keys
.pip/                      pip configuration (cert + index)
bin/                       $HOME/bin wrappers (proot tool entry points)
.local/…/usercustomize.py  TLS fix
```

**Does not contain** (no need to back up):

- `payload/` — re-extracted automatically on reinstall
- the proot rootfs — rebuild it with `selfbuild/scripts/setup-proot-alpine.sh`

---

## 6. When something breaks, what to bring

Bring these four and you skip most of the back-and-forth:

1. **Symptoms**: when it started, what you did before (especially: did you install something else?)
2. **Self-check output**: `sh selfbuild/selfbuild.sh check` and `sh selfbuild/selfcheck.sh`
3. **Engine log**: the last 200 lines of `files/dsh-web.log`
4. **Overlay status** (if the issue is the little whale): the response from `GET /overlay?action=status`

---

> **A note on paths**: this document uses paths relative to the **project root**.
> The source tree can live anywhere (for example under `/sdcard/Download/`), and the app's private directory is
> `/data/user/0/com.deepseek.harness/files/`.
