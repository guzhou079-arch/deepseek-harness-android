'use strict';
/**
 * dist-tools-allow.js —— 读随包工具白名单（scripts/dist-tools-allow.json）
 * ============================================================================
 * 为什么要有这层壳：名单原来在三个地方各抄一份
 *   ① strip-dist-payload.js 的 ALLOW      —— 决定谁**能**进包
 *   ② assert-dist-privacy.js 的 TOOLS_ALLOW —— 决定谁**算**多余
 *   ③ scan-dist-privacy.py 的 tools_allow  —— APK 级复查，同上
 * 三份手抄的名单一定会漂，而且漂的方向恰恰是最危险的那个：打包时把技能要调的工具删了，
 * 三道闸各自拿自己的名单比对，三道全绿 —— 装到新机器上 SKILL.md 里每一行
 * `$DSH_HOME/tools/xxx` 都是空路径。这类「闸各自绿、产物是坏的」比没有闸更糟。
 *
 * 现在名单只有 dist-tools-allow.json 一份，本文件把它读成数组给两处 JS 用；
 * scan-dist-privacy.py 直接读同一个 JSON（Python 侧不走这里）。
 *
 * 读不到 / 读出来是空的，一律抛错，绝不返回空数组兜底：空名单会让 strip 把
 * 所有工具当该删的、让隐私闸把一切当多余 —— 静默的错比响亮的死难查得多。
 */
const fs = require('node:fs');
const path = require('node:path');

// 默认就是同目录这份。DSH_DIST_TOOLS_ALLOW 只为自测留的口子：闸的负向断言要造
// 「名单缺一条 / 名单是空的 / 名单读不到」三种坏名单，绝不能靠在真文件上改来改去
// ——跑测试时进程一崩，真名单就停在被改坏的状态，下一次打包直接删错东西。
const REGISTRY = process.env.DSH_DIST_TOOLS_ALLOW || path.join(__dirname, 'dist-tools-allow.json');

function loadDistToolsAllow() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  } catch (e) {
    throw new Error(`读不了随包工具名单 ${REGISTRY}：${e.message}\n  它是 strip / 隐私闸共用的唯一真相源，读不到就无法判断谁能进包。`);
  }
  const list = raw && raw.tools;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`${REGISTRY} 里 tools 不是非空数组 —— 名单空了等于「所有工具都该删」，必须当场失败。`);
  }
  return list.slice();
}

module.exports = loadDistToolsAllow;
module.exports.loadDistToolsAllow = loadDistToolsAllow;
module.exports.REGISTRY = REGISTRY;
