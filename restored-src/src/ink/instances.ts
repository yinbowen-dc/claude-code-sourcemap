/**
 * @file instances.ts
 * Ink 实例注册表（全局单例 Map）
 *
 * 在 Claude Code 的 Ink 生命周期管理中，本文件处于实例管理层：
 *   render()（创建或复用 Ink 实例）
 *   → 【本文件：instances Map 存储 stdout → Ink 的映射】
 *   → Ink 实例（卸载时从 Map 中删除自身）
 *   → useSelection / useSearchHighlight（通过此 Map 获取 Ink 单例）
 *
 * 设计原因：
 *  - 同一个 stdout 流上连续调用 render() 时，应复用同一个 Ink 实例，
 *    而不是创建新实例（避免重复渲染和终端状态冲突）
 *  - render.ts（创建实例）和 ink.ts（卸载时删除自身）需要共享此 Map，
 *    但两者互相引用会造成循环依赖，故将 Map 抽离到独立文件
 *  - useSelection / useSearchHighlight 等 hook 也通过此 Map
 *    在不传参的情况下访问当前进程的 Ink 实例
 */

import type Ink from './ink.js'

/**
 * 全局 Ink 实例注册表：NodeJS.WriteStream（通常为 process.stdout）→ Ink 实例。
 *
 * 生命周期：
 *  - render() 调用时：若 Map 中已有对应 stdout 的实例则复用，否则创建并注册
 *  - Ink 实例卸载时（unmount）：从 Map 中删除自身，释放对该 stdout 的持有
 *
 * 实践中一个 Node.js 进程通常只有一个 Ink 实例（对应 process.stdout），
 * 但 Map 结构支持多实例场景（如同时渲染到多个流的测试环境）。
 */
const instances = new Map<NodeJS.WriteStream, Ink>()
export default instances
