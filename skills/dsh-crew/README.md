# dsh-crew —— 一个人的活拆成一支班组

技能正文在 [SKILL.md](SKILL.md)：岗位怎么写、队形怎么摆、什么时候**不该**造新成员、以及派活的红线。
这里放运行时要用的三个脚本。

## 装法

```sh
cp scripts/crew.js scripts/weekly.js scripts/crew-selftest.sh "$DSH_HOME/tools/"
sh "$DSH_HOME/tools/crew-selftest.sh"          # 41 项断言，跑在临时名册
```

把 `SKILL.md` 放到 `$DSH_HOME/skills/dsh-crew/` 就生效。名册落在 `$DSH_HOME/crew/`，
那是本机数据，**不要**提交进仓库。

## 三个脚本

| 脚本 | 干什么 |
|---|---|
| `crew.js` | 名册 CLI。`team` 出总表、`pool` 列可领的任务、`pull <名>` 认领一张并打印完整 prompt、`shift` 出一轮的开工清单（一人一张，不抢） |
| `weekly.js` | 从名册和任务板生成本周周报初稿 |
| `crew-selftest.sh` | 回归自测，覆盖认领、并发、路径穿越、伪造标题等防回归用例 |

派活是**拉取式**的：任务卡带 `--role`，谁的角色对得上谁领，领到几号卡就干几号卡。
不是主会话挨个点名，所以成员自己开工也不会抢同一张。
