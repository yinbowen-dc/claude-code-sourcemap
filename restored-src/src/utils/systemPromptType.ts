/**
 * systemPromptType.ts — 系统提示词数组品牌类型模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   基础类型定义层。为系统提示词数组提供 TypeScript 品牌类型（branded type），
 *   防止普通字符串数组被意外传入要求 SystemPrompt 的接口，增强类型安全性。
 *
 * 主要职责：
 *   1. 定义 SystemPrompt 品牌类型（readonly string[] + __brand 标记）；
 *   2. 提供 asSystemPrompt() 转换函数，将普通数组显式转换为该类型；
 *   3. 本模块故意不依赖任何其他模块，避免在任何初始化路径中引发循环依赖。
 */

/**
 * 系统提示词数组的品牌类型。
 *
 * 使用品牌类型（branded type）的目的：
 * - 确保系统提示词只能通过 asSystemPrompt() 显式创建，
 *   防止将任意 readonly string[] 直接传入期望 SystemPrompt 的接口；
 * - __brand 字段仅存在于类型层面，运行时不占用任何内存。
 *
 * 本模块故意不引入任何依赖，以便可以从任意位置安全导入，
 * 不会因模块初始化顺序产生循环依赖问题。
 */
export type SystemPrompt = readonly string[] & {
  readonly __brand: 'SystemPrompt'
}

/**
 * 将普通 readonly string[] 强制转换为 SystemPrompt 品牌类型。
 *
 * 执行流程：
 *   直接通过类型断言（as）完成转换，不修改数组本身的运行时结构。
 *   调用方需要确保传入的数组内容符合系统提示词的语义。
 *
 * @param value - 包含系统提示词各段文本的只读字符串数组
 * @returns 具有 SystemPrompt 品牌的相同数组引用
 */
export function asSystemPrompt(value: readonly string[]): SystemPrompt {
  return value as SystemPrompt
}
