# FAQ

> Reporting a problem? Open an issue in this repository and include the **version, device model, Android version,
> reproduction steps and logs**.
> ⛔ Do **not** paste API keys, login credentials, full session content, or screenshots containing personal
> information into an issue.

## Installing and upgrading

**Q: I get `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. What now?**
A: It means a same-named app with a **different signature** is already installed (the official build, somebody else's
build, or a self-built one). **Do not uninstall** — first back up from the in-app console
(Console → Rescue → Export all data), then decide whether to uninstall and reinstall.
That error is telling you "this came from somewhere else"; it is not a malfunction.

**Q: I get a version-downgrade error (`INSTALL_FAILED_VERSION_DOWNGRADE`).**
A: The version you are installing is lower than the one already present. Install a newer version; if you really need
to downgrade, back up first and then uninstall and reinstall.

**Q: Will I lose data when I upgrade?**
A: Upgrading by **installing over the top** from this repository's Releases does not lose data. Uninstalling and
reinstalling does (sessions, configuration, runtime).

## Starting and running

**Q: The first launch spins forever.**
A: It is extracting the runtime (a few hundred MB; 1–3 minutes depending on the device). If it keeps failing you can
retry the extraction from the console; make sure you have enough free space (about 0.6 GB of app data, plus an
optional 340 MB for the build environment).

**Q: The engine will not start / gets stuck on the splash screen.**
A: The console has a **Safe mode** (it sidesteps a broken configuration without touching your data) and a
**Repair / re-extract** entry. If a previously installed plugin corrupted the configuration, safe mode usually gets
you back.

**Q: Signing in opens the browser and does not come back to the app.**
A: It should return automatically once sign-in finishes. If it does not, switch back to the app manually; if that
still fails, please report it with your device model and OS version.

## Floating ball / desktop pet

**Q: I cannot find the floating ball.**
A: Two normal cases: ① you are **using this app itself** (the ball hides while the app is in the foreground —
go to the home screen and it appears); ② you previously tapped "hide", so only half of it peeks out at the screen
edge. You can also bring it back from the "toggle panel" entry in the notification shade.

**Q: Tapping the ball does nothing / I have to press the very bottom of it.**
A: A known issue in early versions, fixed in **v1.30**. Please update to the latest release.

**Q: The ball disappears after I restart the phone or the app.**
A: Since **v1.30** the app remembers your on/off intent: if you had it on, it comes back after a restart; if you
never turned it on, you are not bothered.

## Permissions

**Q: The accessibility service keeps turning itself off.**
A: Some systems (vendor ROMs especially) disable accessibility services after an app install or after clearing
background apps. Turn it back on at **Settings → Accessibility → Downloaded services → DeepSeek Harness screen
assistant**. Leaving it off does not affect chat, only automation.

**Q: Notifications / verification codes are not being read.**
A: Check in order: ① notification permission is granted; ② the accessibility service is running; ③ the system's
notification grouping/summary is not swallowing that notification.

**Q: Screenshots / the virtual display do not work.**
A: Accessibility **screenshots** need **Android 11+**; the **virtual display** additionally needs the privileged
channel (Shizuku). If your version or permissions fall short, those two features are unavailable and nothing else
is affected.

**Q: Scheduled tasks fire at the wrong time.**
A: Grant the **exact alarm** permission, and add the app to the system's "no background restrictions / battery
optimisation allowlist".

## Build environment (for people who want to build their own APK)

**Q: The build environment download fails or is very slow.**
A: Prefer Wi-Fi (about 193 MB, ~340 MB extracted). The parts stay in
`/sdcard/DeepSeekHarness/buildenv`, so **reinstalling the app only needs a re-extract, not a re-download**;
parts already downloaded and verified are skipped.

**Q: Can a self-built APK install over the official one?**
A: **No.** A self-built APK is signed with your own key, which differs from the official one; you can only have one
of the two installed. If you just want to use the AI, install the official release; if you want to build your own,
read [Build environment and packaging](build-on-device.md) first.

## Other

**Q: How much space does it take?**
A: The APK is about 95 MB; app data about 0.6 GB; the optional build environment about 340 MB.

**Q: Are tablets / landscape supported?**
A: Phone portrait is the primary target. Landscape and tablets work but are not specifically adapted — layout
reports are welcome.

**Q: Does it secretly upload my data?**
A: This project runs no servers and has no analytics or telemetry; only what you send to the AI goes to the model
service you configured. See [Permissions & privacy](permissions.md).
