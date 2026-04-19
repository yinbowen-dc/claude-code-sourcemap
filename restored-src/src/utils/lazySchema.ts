/**
 * lazySchema.ts — Zod Schema 懒加载工厂模块
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于工具层（utils），是一个轻量级的性能优化工具。
 * Zod Schema 的构造（如 z.object({...})）在模块初始化时执行，
 * 而 Claude Code 有大量模块，每个模块可能包含多个 Schema 定义。
 * 若在模块加载时立即构造所有 Schema，会拖慢启动速度。
 *
 * lazySchema 将 Schema 的构造延迟到首次实际使用时，
 * 对于"启动时不一定用到"的 Schema（如仅在特定命令下才访问的验证器），
 * 可有效减少启动延迟。
 *
 * 【主要功能】
 * lazySchema<T>：接受一个 Schema 工厂函数，返回一个懒加载的访问器函数；
 * 首次调用访问器时执行工厂函数并缓存结果，后续调用直接返回缓存值。
 */

/**
 * 创建一个 Zod Schema（或任意值）的懒加载单例工厂。
 *
 * 原理：
 *   - 返回的闭包在首次调用时执行 factory()，并将结果缓存到 cached；
 *   - 后续调用通过 ??= 运算符直接返回缓存值，避免重复构造。
 *
 * 使用场景示例：
 * ```ts
 * // 模块加载时不执行 z.object(...)，仅在首次调用 getSchema() 时才构造
 * const getSchema = lazySchema(() => z.object({ name: z.string() }))
 * // 首次调用触发构造，后续调用命中缓存
 * const schema = getSchema()
 * ```
 *
 * @param factory - 返回目标值的工厂函数，仅在首次调用返回的访问器时执行
 * @returns 懒加载访问器函数（无参数，返回 T 类型的缓存值）
 */
export function lazySchema<T>(factory: () => T): () => T {
  let cached: T | undefined
  // ??= 逻辑空赋值运算符：仅在 cached 为 null/undefined 时才执行 factory() 并赋值
  return () => (cached ??= factory())
}
