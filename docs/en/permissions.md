# Permissions and privacy

> 中文原版（以此为最新）：[权限与隐私.md](../权限与隐私.md)

## 1. Permission list

**Every one of these can be denied** — denying it only disables the matching feature. Chat itself needs nothing but **network**.

| Permission | What it is for | If you do not grant it |
|---|---|---|
| **Network** | Talking to the model service you configure | Chat does not work |
| **Notifications** | Persistent status, and the quick toggles in the notification shade (on/off panel, battery-saver cloud) | No notification-shade entry; the app still works |
| **Display over other apps** | Floating ball / desktop pet / cloud reply card | The floating ball does not show; nothing else is affected |
| **Accessibility service** | Screen reading, taps, typing, screenshots (phone automation) | Automation is unavailable; **chat and file features are unaffected** |
| **Notification access** (via accessibility) | Reading notifications (verification codes, chat messages, …) | The related tools cannot read notifications |
| **File read/write** | Reading and writing files under `/sdcard`, import/export, saving files the AI produces | The AI cannot save or read files |
| **All files access** | Reaching arbitrary directories (for example WeChat/QQ download folders) | Only the app's own directories are reachable |
| **Usage access** | Per-app usage time statistics | That feature is unavailable |
| **NFC** | Reading an NFC tag's UID / NDEF records | Tag reading is unavailable |
| **Install unknown apps** | In-app one-tap upgrade | You have to download and install manually |
| **Exact alarms** | Scheduled tasks firing on time | Schedules may be deferred by the system |
| **Modify system settings** | Adjusting brightness, volume, and similar | Those small features are unavailable |
| **Ignore battery optimisation** | Long tasks are not killed by the system | Long background tasks may be interrupted |

> This project **does not need root**. Some system-level operations (the virtual display, for example) are
> optionally provided through the privileged channel that **Shizuku** exposes — everything else works without Shizuku.

## 2. Where your data lives

- **Sessions, configuration, attachments and logs all stay on the phone**: the app's private directory plus `/sdcard/DeepSeekHarness/`.
- **This project runs no servers and reports nothing anywhere** — no analytics SDK, no telemetry.
- What you send to the AI goes to **the service you selected under "Models"** (DeepSeek official, or a third-party
  gateway you configured yourself). **That data is governed by that provider's privacy policy and does not pass through us.**

## 3. How credentials are stored

- Login credentials and API keys live in a credential file inside the app's private directory (other apps cannot read it).
- ⚠️ **The backup zip produced by "Export all data" contains credentials** — treat it like a password and do not share it publicly.
- The project repository contains **no** keys, credentials or session data; the packaging scripts strip such things
  automatically and run a privacy scan.

## 4. LAN access (off by default)

- By default the engine **only listens on the device itself** (`127.0.0.1`), so other devices on your LAN cannot reach it.
- If you need it, turn it on explicitly inside the app: the engine then listens on the LAN, access requires a local token,
  and **it takes effect after restarting the app**.
- Turn it off when you do not need it, and never enable it on an untrusted Wi-Fi network.

## 5. Sensitive capabilities — please be careful

- **Screen reading / notification access** can expose **passwords, verification codes, chat logs and payment information**.
  Do not run automation on screens you do not trust, and do not send that content to any AI service.
- **Automated taps** can misfire (placing an order, deleting something, sending a message). By default this project
  **stops and asks you to confirm** before an irreversible action.
- When you use a **third-party model gateway**, the operator can see everything you send — that is inherent to such services.
  **Never send keys, private data or identifying information.**

## 6. Deleting your data

- A single session: delete it in the UI.
- Everything: uninstall the app (this clears app-private data), or export a backup first and then uninstall.
- Files under `/sdcard/DeepSeekHarness/` (screenshots, export packages, build-environment parts) you have to delete yourself.
