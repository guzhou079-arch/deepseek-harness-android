# whale-shota 🐋

DSH 皮肤 + 傲娇鲸鱼正太**圆贴纸桌宠**。**自用版**，不对外分发。

> ⚠️ **本仓库只含原创代码，不含美术资源。**
> 桌宠用的插画（`assets/`）、由它派生的抠像分层（`archive-2.5d/layers/`）与预览图（`preview/`）
> **均未入库** —— 该插画来源不明且含他人商标，按 `NOTICE` 的边界不得随包分发。
> 所以本插件**克隆下来不能直接跑**：请自备一张图放到 `assets/whale-shota.png`。

## 是什么

一个纯 JS 客户端插件（无 TypeScript、无 tsdown、无构建步骤）。

桌宠 = **从一张插画里裁出来的圆形贴纸**。用 CSS 的 `background-size/position`
直接从宿主已在对外提供的 `/dsh-bg-user.png` 裁出脸部区域：

- **零新增字节**（不复制图片、不内联 base64）
- **画风天然一致**（就是那张图本身）
- 图挂了还有一层渐变兜底（`background-image` 的第二层）

### 桌宠五态

| 状态 | 触发信号 | 台词 | 动效 |
|---|---|---|---|
| `idle` | 无信号 | 哼！ | — |
| `thinking` | `data-step-process-content` / `-body` | 你们还不懂… | 1.5s 上下浮 |
| `streaming` | `data-streaming` | 其实我早就想到了… | 0.8s 快速浮 |
| `done` | 流式结束（保持 2.6s） | 我超聪明的！ | 弹跳两下 |
| `error` | `data-error` | ……哼。 | 灰化 |

信号全部来自宿主 DOM 属性，**低频 1s 兜底 + 只按属性过滤的 MutationObserver**；
读不到任何信号时安全降级为 `idle`。点击贴纸折叠/展开（记忆在 localStorage）。

## 换裁切

改 `lib/client.js` 顶部三个系数即可，`background-size/position` 会自动跟随尺寸：

| 候选 | x | y | side |
|---|---|---|---|
| **A 头+帽**（当前） | .100 | .005 | .620 |
| B 紧脸 | .160 | .060 | .460 |
| C 上方块 | .020 | .000 | .780 |
| D 近全身 | .060 | .000 | .880 |

改完重跑 `python3 tools/render-sticker.py` 刷新预览（脚本里三个常量要同步改）。
⚠️ 预览图只是本地产物，**不要提交进仓库**。

## 纪律

- 浮层 `z-index: 900`（DSH 契约：menu 100 / Modal 1000 / portal 1100，一律 < 1000）
- 纯展示型：不改 DSH 服务、事件、模型请求
- 所有节点/观察器/定时器都由 `ctx.effect` 回收
- **不抢宿主背景**：本机已有一条 `dsh-bg` 注入在铺这张图，两层叠加会灰蒙蒙
  （见 `bg-patch/dsh-bg.css` 的警告）

## 目录

```
whale-shota/
├─ package.json         dsh.bundle.patch + dsh.client
├─ cordis.patch.yml      insert 一行 ui-skin-whale-shota
├─ skin.json            清单
├─ lib/index.js         node 半边（纯展示，空实现）
├─ lib/client.js        浏览器半边：全部逻辑
├─ locale/{zh,en}.json  插件菜单本地化
├─ assets/              源插画（⚠️ 未入库 —— 自备一张图放这里）
├─ preview/             预览图（⚠️ 未入库，本地产物）
├─ tools/render-sticker.py  预览渲染
├─ archive-2.5d/        走过的弯路：抠像 + 头/身分层 + 呼吸歪头
└─ NOTICE               素材来源与使用边界
```

`archive-2.5d/` 里是之前那版 2.5D 分层（抠像、头/身分层、呼吸+歪头动效，
`tools/build-layers.py` / `render-motion.py` / `build-client.py` 一整套）。
代码**留着备用**，但它不参与现行包；`layers/` 下的分层输出**未入库**。

## 装法（待隔离实例验证后再动真 profile）

本机 `dsh` CLI **不在 PATH 上**，profile 靠 `pnpm` + `cordis.patch.yml` 组合。
直接在主 profile 里 `pnpm add` 会重解析整套 bundles，**有把 GUI 搞挂的风险**，
所以流程是：隔离实例（独立 `DSH_HOME` + 独立端口）验证 → 再进 `web profile`。
