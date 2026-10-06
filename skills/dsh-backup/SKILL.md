---
name: dsh-backup
description: DSH 时光机全站一键备份、快照管理与跨设备迁移。用于“帮我备份一下系统/记忆/会话”、“查看备份列表”、“还原指定备份”等需求。
---

# DSH 时光机全站备份与迁移技能 (`dsh-backup`)

本技能封装了 DSH 安卓端全站资产（记忆库 `mem.db`、全部历史会话 `sessions/`、用户配置 `profiles/`、技能集 `skills/`）的一键安全快照打包、校验与迁移还原。

备份文件统一存放在公共目录 `/sdcard/Download/DSH_Backups/`（格式为 `.dshbackup`），支持随时通过微信/QQ/网盘发送到新手机或电脑进行 100% 完整还原。

## 常用操作

> 脚本位置：优先使用随包分发的 `<本技能目录>/scripts/backup.mjs`，或 `/sdcard/DeepSeekHarness/tools/backup.mjs`。

### 1. 创建全站备份快照
```bash
node <本技能目录>/scripts/backup.mjs create [--name 标签名]
```
- 输出包含会话数、文件数、打包后大小与耗时。

### 2. 查看所有历史备份
```bash
node <本技能目录>/scripts/backup.mjs list
```
- 表格化列出所有 `.dshbackup` 备份文件、创建时间、大小与包含的会话数。

### 3. 校验备份文件完整性
```bash
node <本技能目录>/scripts/backup.mjs verify <备份文件绝对路径>
```
- 逐个文件比对 SHA256 哈希，确保无损坏。

### 4. 从快照还原全站数据
```bash
node <本技能目录>/scripts/backup.mjs restore <备份文件绝对路径>
```
- 安全解包并覆盖回 DSH 数据目录，自动触发 `mem.js sync` 重建记忆投影。
