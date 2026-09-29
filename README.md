# 来源与许可 · Attribution & License

本项目是 **DeepSeek Harness 的安卓移植与增强版**，由个人制作并**免费开放**（源码 + 安装包）。
以下逐项说明各部分来源与许可。

---

## 一、本版本相对上游做了什么

上游 `woaiys3/deepseek-harness-android-app` 提供的是**安卓壳骨架**（WebView + Service 结构、
payload 打包、权限引导）。在这个底子之上，本版本包含大量适配与增强：

### 1. 安卓适配补丁（25 条）

| 类别 | 内容 |
|---|---|
| 系统能力 | NFC 读卡 · 无障碍读屏/点击/截图 · 虚拟屏 · 通知读取 · 特权通道（Shizuku/root）|
| 引擎适配 | `bash-local` sandboxMode · `flock` 安卓回退 · `session-persistence` 硬链接绕行 |
| 安全加固 | 静态资源门禁 · 客户端路由鉴权 · update-check 门禁 · 局域网绑定显式开关 |
| 界面 | 账户 UI 解锁 · 自定义背景图 · 移动端布局改造 · 应用更新日志 |
| 登录 | 授权链接改由系统浏览器打开 · 登录完成后自动回到 App |

### 2. 自建构建流水线（可在手机上完成出包，无需电脑）

```
proot + Alpine + OpenJDK 17   → 手机内 javac
android.jar / d8.jar          → classes.dex
selfbuild.js / ziptool.js     → 拆包重打包
pkcs12.keystore               → 自签名
set-apk-version.js            → 二进制 manifest 改版本号
```

约 5,000 行自建脚本（26 个工具脚本 + 6 个打包库）。

### 3. 自研插件与补丁

- `whale-shota` —— 皮肤 + 桌宠
- `dsh-android-ui` —— 安卓界面适配
- 背景图补丁、账户 UI 补丁

---

## 二、来源与许可

### 1. 安卓壳骨架 — MIT

| 项 | 内容 |
|---|---|
| 项目 | **deepseek-harness-android-app** |
| 作者 | [woaiys3](https://github.com/woaiys3) |
| 仓库 | <https://github.com/woaiys3/deepseek-harness-android-app> |
| 许可证 | **MIT License**，Copyright (c) 2026 woaiys3 |

MIT 许可允许修改、分发与再发布。本项目已保留其版权声明与许可证全文（见 `LICENSE`）。

### 2. DSH 引擎内核 — 归 DeepSeek 所有

| 项 | 内容 |
|---|---|
| 项目 | **@deepseek-ai/dsh**（DeepSeek Harness）|
| 权利人 | DeepSeek |
| 说明 | 本包内含其构建产物，**版权归 DeepSeek 所有** |

### 3. 虚拟屏（vscreen）— LGPL-3.0

| 项 | 内容 |
|---|---|
| 项目 | **Operit** — Android AI Agent |
| 作者 | [AAswordman](https://github.com/AAswordman) |
| 仓库 | <https://github.com/AAswordman/Operit> |
| 许可证 | **GNU Lesser General Public License v3.0（LGPL-3.0）** |

虚拟屏功能的实现移植/对齐自 Operit 的 shower 模块。相关源文件**已带原始许可声明**，
许可证全文见 `licenses/lgpl-3.0.txt`（LGPL-3.0 以 GPL-3.0 为基础，故同时提供 `licenses/gpl-3.0.txt`）。

---

## 三、免责

- 本包由个人**免费提供**，本项目不从分发中盈利
- 使用者可依 **MIT 许可**自由使用、修改与再分发
- 使用本包产生的任何后果由使用者自行承担
- 本包不修改、不绕过任何付费机制
- **（致各原项目作者）** 若认为本包不妥，请联系，我会立即下架

---

## 四、许可全文位置

```
LICENSE                     MIT（本项目）
licenses/lgpl-3.0.txt       LGPL-3.0（虚拟屏部分）
licenses/gpl-3.0.txt        GPL-3.0（LGPL-3.0 的基础）
THIRD_PARTY_NOTICES.md      第三方组件逐项声明
```
