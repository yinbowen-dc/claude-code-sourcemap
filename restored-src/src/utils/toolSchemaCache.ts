/**
 * 【文件定位】API 层 — 工具 Schema 会话级缓存
 *
 * 在 Claude Code 系统流程中的位置：
 *   每次向 Anthropic API 发送请求时需要附带工具的 BetaTool schema 定义。
 *     → 若每次都重新渲染 schema（含动态内容），GrowthBook 标志翻转或 MCP 重连
 *       会导致工具块字节变化，破坏 ~11K token 工具块的 prompt cache 前缀。
 *     → 本模块维护会话级缓存，首次渲染后锁定 schema，后续 API 调用直接复用，
 *       避免中途刷新破坏 prompt cache。
 *
 * 主要职责：
 *   1. TOOL_SCHEMA_CACHE — 模块级 Map，键为工具名，值为缓存的 BetaTool schema
 *   2. getToolSchemaCache() — 返回缓存 Map 引用（供 api.ts 读写）
 *   3. clearToolSchemaCache() — 清空缓存（登出/重新认证时由 auth.ts 调用）
 *
 * 设计说明：
 *   此模块位于依赖树叶节点，auth.ts 可以安全导入它，无需引入 api.ts
 *   （否则会创建 plans→settings→file→growthbook→config→bridgeEnabled→auth 的循环依赖）。
 */

import type { BetaTool } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

/**
 * 缓存的 Schema 类型：在 BetaTool 基础上扩展了 strict（严格模式）
 * 和 eager_input_streaming（提前流式输入）两个可选字段。
 */
// Session-scoped cache of rendered tool schemas. Tool schemas render at server
// position 2 (before system prompt), so any byte-level change busts the entire
// ~11K-token tool block AND everything downstream. GrowthBook gate flips
// (tengu_tool_pear, tengu_fgts), MCP reconnects, or dynamic content in
// tool.prompt() all cause this churn. Memoizing per-session locks the schema
// bytes at first render — mid-session GB refreshes no longer bust the cache.
//
// Lives in a leaf module so auth.ts can clear it without importing api.ts
// (which would create a cycle via plans→settings→file→growthbook→config→
// bridgeEnabled→auth).
type CachedSchema = BetaTool & {
  strict?: boolean
  eager_input_streaming?: boolean
}

// 模块级单例缓存，生命周期与 Claude Code 会话相同
const TOOL_SCHEMA_CACHE = new Map<string, CachedSchema>()

/**
 * 获取工具 Schema 缓存 Map 的引用。
 * api.ts 通过此函数读写缓存（读取已缓存 schema / 写入首次渲染结果）。
 *
 * @returns 工具 Schema 缓存 Map（键：工具名，值：BetaTool schema）
 */
export function getToolSchemaCache(): Map<string, CachedSchema> {
  return TOOL_SCHEMA_CACHE
}

/**
 * 清空工具 Schema 缓存。
 *
 * 在用户登出或重新认证时调用，确保下次 API 请求使用最新的 schema。
 * 由 auth.ts 调用（此模块无需导入 api.ts，避免循环依赖）。
 */
export function clearToolSchemaCache(): void {
  TOOL_SCHEMA_CACHE.clear()
}
