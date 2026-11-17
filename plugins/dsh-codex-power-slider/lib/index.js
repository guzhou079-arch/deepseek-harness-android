/**
 * dsh-codex-power-slider —— Node 半边。
 *
 * 这是一个**纯 UI 插件**：浏览器半边的 `lib/client.js` 由宿主侧的
 * `@deepseek-ai/dsh-client-modules` 直接读取、组合并下发给页面，不需要
 * Node 侧做任何服务端工作（不需要 webServer、不需要 index 注入）。
 *
 * Node 半边存在的唯一理由：包必须成为 Loader 条目（`cordis.patch.yml`
 * 的 `insert.name`），扫描器才会把它的 `dsh.client` 声明编进浏览器启动图。
 * 因此这里保持零副作用、零依赖、永不抛错——任何异常都会让整个 profile
 * 启动失败。
 */

/** Cordis 插件名。 */
export const name = 'dsh-codex-power-slider'

/** 该插件不依赖任何 Cordis 服务。 */
export const inject = []

/** 无服务端行为；浏览器半边完全独立。 */
export function apply() {}
