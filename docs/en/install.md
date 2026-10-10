# Install and system requirements

> 中文原版（以此为最新）：[安装与要求.md](../安装与要求.md)

## 1. What you need

| Item | Requirement |
|---|---|
| **Android version** | **7.0 (API 24) or newer.** ⚠️ Accessibility **screenshots**, the **virtual display** and similar advanced features need **Android 11+**. On older versions you can still chat, but some automation features are unavailable. |
| **Storage** | The APK is about **95 MB**; after installing, app data is about **0.6 GB** (runtime + engine + sessions). The optional build environment is another **~340 MB**. |
| **Network** | Required (the models run remotely). LAN access is **off by default**. |
| **Hardware** | **No root needed.** NFC tag reading needs a phone with NFC. |
| **Permissions** | Chat itself only needs network access; every other permission is optional — see [Permissions & privacy](permissions.md). |

## 2. Download and verify

Download **only from this repository's Releases**.

Each release lists the APK's **SHA-256** and **signing certificate fingerprint**, so you can verify it before installing:

```sh
sha256sum DeepSeekHarness-v1.36-dist.apk     # compare with the value in the release notes
```

## 3. Install

1. Open the downloaded APK; Android will ask you to allow installing unknown apps.
2. Open the app when the installation finishes.
3. **The first launch extracts the runtime** (a few hundred MB; roughly 1–3 minutes depending on the device; progress is shown on screen).
4. Sign in when prompted (phone number / account).
5. Optional: enable the floating ball, accessibility and other capabilities from the in-app console as needed.

## 4. Updating — **read this section first**

- Update **only from this repository's Releases**; install straight over the top.
- ⛔ **Do not uninstall and reinstall** — uninstalling wipes app-private data (session history, runtime, configuration).
- If you see `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, the copy currently installed was signed with a **different key**.
  Do **not** uninstall straight away: first export your data from the in-app console
  (Console → Rescue → Export all data), then decide what to do.
- Exporting before every upgrade is a good habit (same path as above).

## 5. Uninstall / switching phones / migration

- **Export**: Console → Rescue → Export all data → you get a zip containing sessions, configuration and workspace.
- **Import**: after switching phones or reinstalling → "Restore from backup" → pick that zip.
- ⚠️ The backup zip **contains login credentials** — treat it like a password and do not pass it around.
- Uninstalling deletes app-private data; export packages, screenshots and build-environment parts under
  `/sdcard/DeepSeekHarness` are **not** deleted.

## 6. If it will not install

| Symptom | Cause / what to do |
|---|---|
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | A same-named app signed with a different key. Back up first, then decide whether to uninstall (see section 4). |
| `INSTALL_FAILED_VERSION_DOWNGRADE` | You are installing a lower version than the one already present. Use a newer version, or back up and uninstall first. |
| Parse error | Incomplete download — download again and check the SHA-256. |
| First launch spins forever | The runtime is still being extracted; wait a few minutes. If it keeps failing, retry the extraction from the in-app console. |
| The engine will not start | The console has **Safe mode** and **Repair** entries. If that does not help, open an issue with the logs. |
