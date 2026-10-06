# dsh-android-console

DSH 设置弹窗里的 **「控制台」** 页 —— 把原先安卓壳**原生控制台**的全部功能与文字，
照「通用设置」那一页的样子重做。

## 这一页有什么

| 分组 | 行 |
|---|---|
| 运行环境 | 解压文件（解压 / 重新解压）、引擎（启动 / 重启 / 停止 / 回到界面） |
| 救援 | 安全模式（进入 / 退出）、导出全部数据、从备份导入还原 |
| 设置 | 授予权限、插件、自建环境、日志、时光机全站备份、界面主题、检查更新 |

权限 / 插件 / 自建环境 / 日志是页内子页（左上角有返回箭头），与原控制台一致。

## 结构

- `lib/client.js` —— 客户端半边：注册 `settings.section`（id `android-console`），渲染整页。
  按钮与开关直接用前端自带的 `@deepseek-ai/dsh-client-ui-primitives`，所以深浅色、
  圆角、焦点环与「通用设置」一致。
- `lib/index.js` —— node 半边：**空的**。这一页的动作全是安卓壳的事，引擎侧不需要路由或服务。
- `cordis.patch.yml` —— 用 `insert` 把插件挂进 profile 的加载树。

## 动作怎么落地

客户端半边不认识安卓，全部经 WebView 上壳注册的 JS 桥：

```js
window.dshshell.ctlState()          // → 状态 JSON 字符串
window.dshshell.ctlAct(id, arg)     // → {"ok":true} / {"ok":false,"msg":"..."}
```

对应的原生实现是 `MainActivity.ctlStateJson()` / `ctlAction(...)`。
在桌面浏览器里没有 `dshshell`，页面会显示「控制台只在安卓应用内可用」。

## 为什么不继续用 WebView DOM 注入

早期做法是往设置弹窗里克隆一行 DOM 挂「控制台」入口。那要猜上游的 DOM 结构与文案，
内核一升级就碎。`settings.section` 是上游给的正规缝，并且插件住在
`profiles/web/node_modules/`（内核升级不重解压 `dshhome`），所以这条路更耐用。

## 装法

```sh
# 装进正在跑的 profile（内核升级不覆盖 dshhome）
cp -a . "$DSH_HOME/profiles/web/node_modules/dsh-android-console/"
# 再往 $DSH_HOME/profiles/web/cordis.patch.yml 末尾加：
#   - insert:
#       - id: android-console
#         name: 'dsh-android-console'
```

全新安装随 APK 走 `selfbuild/build-overlay/dshhome/profiles/web/`。
