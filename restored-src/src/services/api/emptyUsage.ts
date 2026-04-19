/**
 * 【空用量常量模块】api/emptyUsage.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * - 属于 API 服务层的共享常量模块，专门存放零初始化的 token 用量对象
 * - 从 logging.ts 中拆分出来，目的是打破循环依赖链：
 *   bridge/replBridge.ts → logging.ts → api/errors.ts → utils/messages.ts → BashTool.tsx → 大量模块
 * - 被 bridge/replBridge.ts 直接导入，而无需引入整个 api/errors.ts 依赖树
 *
 * 核心功能：
 * - EMPTY_USAGE: 所有 token 用量字段均为 0 的不可变常量，作为 NonNullableUsage 类型的零值
 *
 * 设计决策：
 * - 使用 Readonly<NonNullableUsage> 类型确保调用方不会意外修改此常量
 * - 模块保持极简（无任何依赖），确保可以被任何模块安全导入而不产生副作用
 */

import type { NonNullableUsage } from '../../entrypoints/sdk/sdkUtilityTypes.js'

/**
 * 零初始化的 token 用量对象
 *
 * 所有计数字段均为 0，service_tier 默认为 'standard'，inference_geo 为空字符串。
 * 用于以下场景：
 * - 会话开始时的初始用量累加基准
 * - 错误场景下需要返回用量对象但无实际用量数据时
 * - 单元测试中作为用量对象的占位符
 *
 * Zero-initialized usage object. Extracted from logging.ts so that
 * bridge/replBridge.ts can import it without transitively pulling in
 * api/errors.ts → utils/messages.ts → BashTool.tsx → the world.
 */
export const EMPTY_USAGE: Readonly<NonNullableUsage> = {
  input_tokens: 0,                          // 输入 token 数（未使用缓存的普通输入）
  cache_creation_input_tokens: 0,           // 创建缓存时消耗的 input token 数
  cache_read_input_tokens: 0,               // 从缓存读取的 input token 数（计费较低）
  output_tokens: 0,                         // 输出 token 数
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, // 服务端工具调用次数
  service_tier: 'standard',                 // 服务等级（标准/优先）
  cache_creation: {
    ephemeral_1h_input_tokens: 0,           // 1 小时 ephemeral 缓存创建 token 数
    ephemeral_5m_input_tokens: 0,           // 5 分钟 ephemeral 缓存创建 token 数
  },
  inference_geo: '',                        // 推理地理区域（空字符串表示未指定）
  iterations: [],                           // 迭代记录（用于多轮推理场景）
  speed: 'standard',                        // 推理速度模式（standard/fast）
}
