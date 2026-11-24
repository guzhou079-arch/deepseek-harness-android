# dsh-doc-actions

文件预览上的三个安卓动作：**用系统应用打开 / 打开所在文件夹 / 分享**。

页面在浏览器里，密钥（`APP_LOCAL_TOKEN`）只在 App 进程和引擎 env 里，所以浏览器半边不能直连
App 壳的 `127.0.0.1:3081/open` 桥（会被 401 挡成「连不上」）。实际链路是：

```
页面（lib/client.js，文档预览侧边栏按钮）
  └─ 同源 POST /doc-actions/open   { path, action }
       └─ 引擎侧（lib/index.js）校验路径 + 附上 x-dsh-token
            └─ POST 127.0.0.1:3081/open  →  App 壳用系统应用打开
```

## 路由契约

| 项 | 值 |
| --- | --- |
| 方法 | `POST`（其它方法 405） |
| 路径 | `/doc-actions/open`（插件以 `prefix` 方式挂 `PREFIX = '/doc-actions'`） |
| 请求体 | `{ "path": "<绝对路径>", "action": "view" \| "reveal" \| "share" }`，≤ 8 KB |
| 成功 | `200 { ok: true }` |
| 壳拒绝 | `200 { ok: false, error: "..." }`（壳的答复原样带回） |
| 参数不对 | `400 { ok: false, error: "缺少绝对路径" \| "不认识的动作: x" \| "请求体不是 JSON" }` |
| 路径越界 / 禁区 | `400 { ok: false, error: "路径不在允许的目录内: ..." }`（越界与禁区**不区分**，不泄漏到底撞了哪道） |
| 文件不存在 | `404 { ok: false, error: "文件不存在: ..." }`（只在根内、非禁区时才可能出现） |
| 路径解析失败 | `400 { ok: false, error: "路径无法解析: ..." }` |

`action` 缺省按 `view` 处理。

## 路径白名单

页面给的是绝对路径（预览器的 `props.absolutePath`），所以**不能**要求相对路径；
但也**不能**什么绝对路径都往壳里递 —— 那等于让任意页面把任意可读文件交给系统应用打开或分享。

校验顺序（`guardPath`）—— 两段判根，顺序不能换：

1. 空 / 非字符串 / 相对的 → `400 缺少绝对路径`
2. **词法判根**：`path.resolve`（纯字符串，**不碰文件系统**）后必须落在白名单根内、且不在禁区
   - 不满足 → `400 路径不在允许的目录内`，**到此为止，不做 stat**
   - 这一段放前面是有原因的：先 `realpath` 再判根会先 stat，于是「越界但不存在 → 404、
     越界但存在 → 400」，任意页面就能拿这两种答复当存在性探针，问「这个路径存不存在」
3. `realpathSync` 解析真实路径（软链按落点算，`/sdcard` 在 Android 上是 `/storage/emulated/0` 的软链）
   - `ENOENT` / `ENOTDIR` → `404 文件不存在`
   - 其它（如 `EACCES`）→ `400 路径无法解析`
4. **真实路径再判一次**根与禁区：词法过关不代表真实落点还在根内（软链逃逸）
   - 不满足 → `400 路径不在允许的目录内`
5. 通过后，**递出去的是 realpath**，不是请求里那串原始字符串；被拒绝时原值一律丢弃

默认根（三种写法都算：配置原样、realpath、`/data/user/0/<pkg>` ↔ `/data/data/<pkg>` 别名）：

- `/sdcard`（用户可见存储：`/sdcard/DeepSeekHarness`、`Download`、`Documents` 都在里面）
- `/data/user/0/com.deepseek.harness/files`（App / 引擎自己的私有工作区，即引擎 env 的 `HOME`）

根内禁区（同样回 `400 路径不在允许的目录内`）：

- `$F/payload` —— 引擎本体
- `$F/sessions` —— 会话记录
- `$F/memory` —— 记忆库
- `$F/.claude` —— Claude Code 目录整块（`sessions` / `projects` / `session-env` / `settings.json` 都是内部数据）
- `$F/life.db` —— 生活助理库
- `$F` 顶层的 `session-*.jsonl` —— 会话转写（会不断新增，按文件名认，只认 `$F` 顶层）
- `/sdcard/DeepSeekHarness/memory` —— 记忆库真身（`mem.db` 在 `/sdcard` 上）

`$F` 整体保留（App 自己产出的东西还要能打开），只排这几块引擎内部数据：它们不该有「打开 / 分享」的入口。

要收紧就设 `DSH_DOC_ACTIONS_ROOTS`（冒号分隔），**整组替换**默认根，例如：

```sh
DSH_DOC_ACTIONS_ROOTS=/sdcard/DeepSeekHarness:/data/user/0/com.deepseek.harness/files
```

想收紧到「只认工作区」就只留第一个；改完重启引擎生效。禁区不受这个变量影响，始终生效（别名写法也过禁区）。

根设成 `/` 也成立（前缀会按原样处理，不会拼出 `//`），只是等于放行整个文件系统，一般别这么用。

`DSH_OPEN_BRIDGE_PORT` 可改桥端口（默认 `3081`），只对本地测试有用。

## 浏览器半边

`lib/client.js`（`dsh.client.platform = "web"`）由 `dsh-client-modules` 下发，挂在
`sidebar.right.tab.document.actions` 槽位；它只负责发请求和显示忙碌态，不碰密钥。

## 自测

```sh
node selfbuild/scripts/doc-actions-path-guard-test.mjs
```

自测同时打 `guardPath` 与 `apply()` 挂出来的路由：空请求、相对路径、白名单外绝对路径、
白名单外**且不存在**的路径（必须是 400，不是 404）、禁区（`$F/payload` / `$F/memory/mem.db` 等）、
根内解析不了（EACCES → 400 无法解析）、软链跳出白名单、根内不存在的路径、非法动作、正常路径仍能走到转发层。

拆坏验证的红点：

- 守卫改回「只判断是否以 `/` 开头」→ 红在「白名单外的绝对路径必须 400」
- 去掉词法判根（只剩 realpath）→ 红在「白名单外不存在的路径必须 400（不是 404）」
- 清空禁区列表 → 红在「禁区必须被拒」
