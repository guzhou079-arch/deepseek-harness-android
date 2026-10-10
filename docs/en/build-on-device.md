# Build environment and packaging (compiling itself on the phone)

> The core value of this project is **not features — it is maintainability**: it can compile, package, sign and
> install *itself*, on the phone. This document explains how to get that pipeline running.

> 中文原版（以此为最新）：[自建环境与出包.md](../自建环境与出包.md)

## 1. First things first: the build environment is not inside the APK, but it is **one tap away**

| | Where | Size |
|---|---|---|
| Main package (APK) | This repository's Releases | about **95 MB** |
| **Build environment** | **Downloaded on demand inside the app** | about **193 MB** (342 MB extracted) |
| Source code | This repository | tiny |

Why it is not bundled: the vast majority of people just want to use the AI, and making everyone pay 342 MB plus a
longer first launch is a bad trade. People who want to build can get it with one tap — **the majority should not
have to carry 342 MB for the minority**, and equally **the capability should not be cut just because most people
do not need it**.

## 2. Installing the build environment (one tap in the app)

**Console → Build environment**, then wait for download → verification → extraction → ready.

The environment lives in this repository's Releases under `buildenv-v1`, split into 3 parts (no single attachment
over 100 MB), verified part by part with resume support. Any alternate source shown in the UI is a legacy snapshot;
**this repository's copy is the one that counts**.

What it does:

1. Reads the manifest → downloads part by part (**parts already downloaded and verified are skipped**; resumable)
2. Verifies each part's sha256 → merges → verifies the sha256 of the **whole archive**
3. Extracts with the bundled python3 (`filter='fully_trusted'`, so **symlinks and permission bits are preserved**)
4. Places it in the app's private directory and writes a ready marker

⚠️ **It must be extracted to internal storage**: `/sdcard` is FUSE and **cannot store symlinks**, while the Alpine
rootfs contains **918 symlinks** (more than regular files) — put it there and you get a pile of broken links.

✅ The parts stay in `/sdcard/DeepSeekHarness/buildenv`, so **after reinstalling the app you only re-extract, you
do not re-download**.

## 3. Building your own APK

Once the environment is installed, run the `selfbuild/` scripts from your source directory. **The path is
configurable** — it works from any directory:

```sh
cd <your source directory>            # any writable directory will do
export DSH_PROJECT="$PWD"             # optional; by default it is derived from the script's own location

sh selfbuild/scripts/javac-app.sh                                  # app-side Java → classes.dex
sh selfbuild.sh payload && sh selfbuild.sh patch                   # extract the payload + apply the overlay
sh selfbuild.sh pack --dex work/appbuild/out/classes.dex           # package
sh selfbuild.sh version 1.29 61                                    # ⚠️ set the version explicitly
sh selfbuild.sh sign                                               # sign with your own key
```

### ⚠️ Pitfalls you have to know about (all of them cost someone a day)

- **Do not mix up the signing keys**: the install package uses "the key this device already trusts"; a distribution
  build for other people uses the distribution key. Using the wrong one means the other person **cannot install over
  the top** — and "uninstall then reinstall" wipes all of their data.
- **The version number must be set explicitly**: skip it and the skeleton's old version is reused → **the update
  check stops working**, and if `versionCode` is lower than what the user already has, `pm install -r` is
  **rejected as a downgrade**.
- **Packaging overwrites local changes**: files in `build-overlay/` overwrite the runtime copy. The classic victim is
  the **background-image loading injection** (it lives in `dsh-client-ui-open-in-app/lib/client.js`, a file that is
  also in the overlay) — without it the background image does not show at all. The `patch` step now **verifies this
  automatically** and fails the build if it is missing.
- **⛔ Do not install a self-built package straight onto a phone you care about**: validate it in an isolated
  instance first, and copy the current APK to `/sdcard` as a rollback. This rule was paid for.

## 4. Recovering a broken environment

In the app, just tap **Build environment → reinstall / repair**. (If the parts are still there, it is quick.)

Manual recovery: the tarball is in `/sdcard/DeepSeekHarness/buildenv/`. Two things are **easy to miss** after
extracting:

1. It **must** be extracted into the app's private directory (`/data/user/<id>/<pkg>/files/`), never `/sdcard`
2. You **must** create `work/linux/tmp` — `run.sh` points `PROOT_TMP_DIR` at it, and without it proot exits with
   `can't create glue rootfs`

```sh
F=/data/user/0/com.deepseek.harness/files
python3 -c "import tarfile,sys; tarfile.open(sys.argv[1]).extractall(sys.argv[2], filter='fully_trusted')" \
  /sdcard/DeepSeekHarness/buildenv/dsh-buildenv-v1.tar.gz "$F/tmp/restore"
mv "$F/tmp/restore/env/work/linux" "$F/work/linux"
mkdir -p "$F/work/linux/tmp"                       # ← without this proot will not start
cp "$F/tmp/restore/env/toolchain/"*.jar "$F/toolchain/"
sh "$F/work/linux/run.sh" java -version            # sanity check
```
