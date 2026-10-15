# dsh-plugin-turn-notify

让 DSH 在**一轮回答真正结束**时，往安卓通知栏发一条**横幅通知**。

## 为什么需要它

DSH 自己没有"回答结束"的通知 —— 通知只在模型主动调 `android_notify` 工具时才发。
所以"跑完任务弹个横幅"从来不是自动的，依赖模型记得调工具，于是长期表现为"时有时无 / 基本没有"。

本插件挂在 `agent/turn-stopping` 事件上，自己发通知。

## 装法（本机）

```sh
F=/data/user/0/com.deepseek.harness/files
SRC=/sdcard/DeepSeekHarness/projects/dsh-plugin-turn-notify
DST=$F/payload/dshhome/profiles/web/node_modules/dsh-plugin-turn-notify
rm -rf "$DST" && cp -r "$SRC" "$DST"

# 把 insert 追加到 profile patch（先备份）
P=$F/payload/dshhome/profiles/web/cordis.patch.yml
cp -p "$P" "$P.bak-before-turn-notify-$(date +%Y%m%d-%H%M%S)"
cat "$SRC/cordis.patch.yml" | grep -A3 '^- insert:' >> "$P"
```

⚠️ 改完 patch **要重启引擎**（patchReload 不是热加载）。

## 配置 `/sdcard/DeepSeekHarness/turn-notify.json`

```json
{
  "enabled": true,
  "minSeconds": 20,
  "cooldownSeconds": 60,
  "skipWhenForeground": true
}
```

| 键 | 含义 |
|---|---|
| `enabled` | 总开关 |
| `minSeconds` | 少于这么多秒的一轮不打扰 |
| `cooldownSeconds` | 两条通知之间的最短间隔 |
| `skipWhenForeground` | 用户正看着 DSH 时不打扰（走无障碍桥 3181 判前台） |

## 日志

`/sdcard/DeepSeekHarness/turn-notify.log`，每次事件一行：`fired` / `skip foreground` / `skip too-short` / `skip cooldown`。

## 两条实现红线

- **监听器不许 await**：`agent/turn-stopping` 是 serial 派发，阻塞会卡住收尾。
- **必须用 `node:http`，不能 `fetch`**：本机桥有 LocalHttpFence，浏览器来源 fetch 会被 403 挡掉。
