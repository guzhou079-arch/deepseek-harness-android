---
name: dsh-backup
description: DSH 全站一键备份与还原。备份会话、记忆库、模型通道配置、账号凭据、技能、工具与团队数据，打成单个 .dshbackup 文件；换手机或系统出问题时用它恢复。
---

# DSH 时光机全站备份

一个文件装下整台 DSH：会话记录、记忆库、模型通道配置、账号凭据、技能、工具、团队数据。

## 什么时候用

- 换手机、重装 App 前
- 改配置、装插件之前，先留一个能回滚的点
- 把整套配置搬到另一台设备

## 备份

```bash
node <本技能目录>/scripts/backup.mjs create
node <本技能目录>/scripts/backup.mjs create --full      # 连聊天附件、office 文档、参考图一起
node <本技能目录>/scripts/backup.mjs create --name 换机前
```

默认存到手机的 `Download/DSH_Backups/`。写不进去（比如没给存储权限）会自动退到 App 私有目录 `backups/`，实际位置会在结尾打印出来。

默认（core）包含记忆库、会话、配置、技能、工具、团队数据、根目录凭据与抬头。
`--full` 额外包含聊天附件、office 文档和参考图，体积会大很多。

## 看一眼

```bash
node <本技能目录>/scripts/backup.mjs list              # 有哪些快照、占多大
node <本技能目录>/scripts/backup.mjs inspect <文件>    # 里面装了什么
node <本技能目录>/scripts/backup.mjs verify <文件>     # 逐文件校验，确认没坏
```

`list` 会给出总占用；快照攒多了会提示怎么清理。

## 还原

```bash
node <本技能目录>/scripts/backup.mjs restore <文件> --yes
```

先逐文件校验哈希，再覆盖回数据目录；`--yes` 是确认覆盖，不带它不会写盘。
覆盖前自动做一份 `BeforeRestore_<时间戳>` 安全快照，中途出事可以用它回滚。
装了记忆工具的会自动跑一次 `mem.js sync` 重建记忆投影，没装就跳过。

## 清理

```bash
node <本技能目录>/scripts/backup.mjs prune --keep 3        # 只列，不删
node <本技能目录>/scripts/backup.mjs prune --keep 3 --yes  # 真删
```

## 说明

- 会话记录是 zstd 存好的、图片本来就是压缩格式，再压一遍基本没收益，所以包体偏大（核心约 750 MB）。
- 记忆库用 `VACUUM INTO` 出一致性快照，不会在写入中途打包到半个数据库。
