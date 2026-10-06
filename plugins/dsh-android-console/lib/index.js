/**
 * dsh-android-console —— node 半边：什么都不做。
 *
 * 控制台的动作全部是**安卓壳**的事（解压 / 起引擎 / 授权 / 安装自建环境…），
 * 由客户端半边经 window.dshshell（WebView 的 JavascriptInterface）回调原生执行。
 * 引擎这边既不需要路由、也不需要服务，所以这里刻意保持零依赖、零副作用：
 * 一个 import 都不写，就不会有 "failed to import" 把引擎拖住。
 */
export const name = 'android-console';

export function apply() {}
