/**
 * 生产环境错误 ID 注册表
 *
 * 本文件为生产环境中的错误追踪提供数字 ID 标识符。
 * 每个 ID 对应代码库中某个特定的 logError() 调用位置，
 * 用于在混淆后的生产构建中定位错误来源。
 *
 * 设计原则：
 * - 每个错误 ID 单独导出为 const，以支持打包工具的 dead code elimination
 * - 外部构建产物中只会保留实际使用的数字，不会泄露字符串标识符
 * - ID 单调递增，不重复使用已删除的 ID
 *
 * Error IDs for tracking error sources in production.
 * These IDs are obfuscated identifiers that help us trace
 * which logError() call generated an error.
 *
 * These errors are represented as individual const exports for optimal
 * dead code elimination (external build will only see the numbers).
 *
 * ADDING A NEW ERROR TYPE:
 * 1. Add a const based on Next ID.
 * 2. Increment Next ID.
 * Next ID: 346
 */

// 工具调用摘要生成失败（例如 tool_use 响应无法被压缩摘要时）
export const E_TOOL_USE_SUMMARY_GENERATION_FAILED = 344
