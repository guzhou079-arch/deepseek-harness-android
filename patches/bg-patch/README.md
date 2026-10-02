# bg-patch/ —— 给 Web GUI 换背景图（deepdive 背景图 v1）

把 Web GUI 的背景图换成你自己的图片：
这里是不改 APK、也不进 `payload.zip` 白名单的一套补丁：
**改完自动热替换生效，App 重启后也还在。**

| 文件 | 作用 |
|---|---|
| `dsh-bg.css` | 背景样式：铺图 + 遮罩 + 会话列透明；`--dsh-user-bg-*` 三个变量就是全部旋钮 |
| `dsh-bg-user.png` | **当前实际使用的背景图**：用户发来的鲸鱼抱枕插画（PNG 1254²，1.4MB） |
| `dsh-bg.svg` | 备用的自带背景图（深蓝星空 + 官方鲸鱼水印，矢量） |
| `make-bg-svg.py` | 生成 `dsh-bg.svg` 的脚本（改配色/水印后重跑） |
| `apply-bg.sh` | 拷资源进 dist + 在 `dsh-client-ui-open-in-app` 里插注入代码（幂等，可 `--check` / `--revert`） |

## 一条命令

```sh
sh bg-patch/apply-bg.sh            # 打补丁（自动找 dshroot）
sh bg-patch/apply-bg.sh --check    # 只看状态
sh bg-patch/apply-bg.sh --revert   # 卸掉
```

## 为什么挂在 `dsh-client-ui-open-in-app`

1. **不在白名单里**：`MainActivity.FORCE_OVERWRITE_PREFIXES` 只覆盖 4 个 Android 插件、
   `bash-local`、几个内核补丁包、`ui-layout/client.js`、`ui-cordis/client.js` 和
   `dsh-web-frontend/dist/{mobile.css,mobile.js,index.html}`。
   `open-in-app` 与 `dist/dsh-bg.{css,svg}` 都不在其中 → **App 每次启动不会被 payload 打回**。
2. **不是 bootstrap 模块**：`ui-theme` 的 package.json 带 `dsh.client.immediately: true`
   → `client-modules` 拒绝热替换它（`replacing bootstrap module ... requires a page reload`），
   所以最初挂在 ui-theme 上的注入只能等下次刷新页面。`open-in-app` 没有 `immediately`
   → `client-hmr`（宿主侧每 500ms stat 轮询各客户端 bundle）发出 `rebuilt` 帧后，
   浏览器会真的 `entries.reload()` 重新执行本 factory，**背景约 1 秒内生效，不用刷新**。
3. **不动界面**：本机是 Web profile，没有可解析的桌面 "Open In" 应用 → 这个插件本来不渲染任何 UI，
   热替换不会让任何界面闪一下。

## 想换图 / 调效果

- 换图：把新图放进 `dsh-web-frontend/dist/`（如 `mybg.jpg`），
  把 `dsh-bg.css` 里 `--dsh-user-bg-image` 改成 `url("/mybg.jpg?v=1")`（`?v=` 换了就 +1 防缓存）；
  或者直接覆盖同名文件再 `sh bg-patch/apply-bg.sh`。
- 太亮/太暗（正文可读性）：调 `--dsh-user-bg-scrim-top` / `--dsh-user-bg-scrim-bottom`
  （当前 `rgba(4,8,16,.60)` / `.76`；数字越大图越暗、字越清楚）。
- 想更像壁纸、更好读：`--dsh-user-bg-blur: 2px;`（默认 `0px` = 原图清晰）。
- 想换回自带星空图：`--dsh-user-bg-image: url("/dsh-bg.svg?v=1")`。
- 改完不用重启：`touch` 一下注入所在的 `client.js`
  （`sh bg-patch/apply-bg.sh` 重跑一次也会改它的 mtime），约 1 秒后后台页自己热替换。

## 细节 / 坑

- 注入的 `<link>` 是 `id="dsh-user-bg"`，每次执行先删旧的再加新的 → 幂等，且带 `?rev=<时间戳>` 防缓存。
- 图和遮罩**只画在 `.ZTP-Xa_frame::before` 上**（`position:absolute; inset:-10px; z-index:-1; pointer-events:none`），
  并把根容器自身 `background` 置空。原因：`::before` 是半透明的，
  两层都铺会把图与罩各叠一遍 → 灰蒙蒙；而 `z-index:-1` 保证它画在所有内容之下，正文/控件不受 `filter` 影响。
  同时 `::before` 是绝对定位，脱离了 AppFrame 的 grid 布局，不会挤动任何一列。
- 3080 的静态服务只认 `.css/.svg/.html` 的 MIME，**位图一律 `application/octet-stream`**
  （实测 .png/.jpg/.webp/.gif 全一样）。没有 `X-Content-Type-Options: nosniff`，
  浏览器按内容嗅探，CSS `background-image` 正常显示（截图已验证）。
- `!important` 不会被插件运行时样式压过：插件注入的 `.ZTP-Xa_frame` / `.D_tfqW_root`
  规则本身没有 `!important`（`!important` 与声明顺序无关）。
- 换**内核大版本**时 dshroot 会整体重解压 → 本补丁连同 `dsh-bg.*` 一起消失，
  重新 `sh bg-patch/apply-bg.sh` 即可（不需要重新打 APK）。
- 真正要「出厂自带」，得把这段注入做进 `android-app`/payload 构建流程（改源包 + 重编）。

## 验证记录（2026-09-29）

- `apply-bg.sh --check` 四项（css / svg / png / 注入）均「在」；
- `/dsh-bg.css`、`/dsh-bg.svg`、`/dsh-bg-user.png` 由 3080 返回 200；
- 宿主 HMR 实测对 `@deepseek-ai/dsh-client-ui-open-in-app` 发出
  `{"type":"rebuilt","id":"@deepseek-ai/dsh-client-ui-open-in-app","rev":"eff6f75fbc21"}`；
- `node --check` 通过（注入后的 client.js 语法合法）；
- **真机截图确认**：`android_see` 截到 GUI 已铺上用户那张鲸鱼插画，
  正文（工具调用行/思考行）叠在图上仍可读，输入栏为深色面板 —— 热替换路径与渲染都成立。
  （截图存 `/storage/emulated/0/DeepSeekHarness/screenshots/screen-1790629049563.png`）
