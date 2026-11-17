/**
 * dsh-session-delete —— Node 半边。
 *
 * 纯 UI 插件：浏览器半边 lib/client.js 由 dsh-client-modules 读取并下发给页面。
 * Node 侧存在的唯一理由是让包成为 Loader 条目，扫描器才会把 dsh.client 编进
 * 浏览器启动图。保持零副作用、零依赖、永不抛错。
 */

/** Cordis 插件名。 */
export const name = 'dsh-session-delete'

/** 不依赖任何 Cordis 服务。 */
export const inject = []

/** 无服务端行为。 */
export function apply() {}
