/**
 * 策略限制类型定义模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件是 policyLimits 服务的数据契约层，定义了从 Anthropic 后端 API 获取的
 * 组织级策略限制的数据结构。这些类型由 policyLimits/index.ts 使用，
 * 用于解析 API 响应、本地缓存文件读写，以及在 isPolicyAllowed() 等函数中
 * 进行策略检查。
 *
 * 主要功能：
 * - 定义 API 响应的 Zod schema（懒加载）
 * - 导出对应的 TypeScript 类型
 * - 定义单次 fetch 操作的结果类型
 */
import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * 策略限制 API 响应的 Zod schema
 *
 * 用途：
 * - 在运行时验证从 /api/claude_code/policy_limits 端点获取的 JSON 响应
 * - 同时用于验证本地缓存文件中的数据（loadCachedRestrictions）
 *
 * 结构说明：
 * - restrictions 是一个字典，键为策略名（如 'allow_product_feedback'），
 *   值为 { allowed: boolean }
 * - 只有被明确设置的策略才会出现在字典中；缺失的策略默认为允许（fail open）
 *
 * 使用 lazySchema 包装：避免模块加载时立即初始化 Zod schema，
 * 防止循环依赖导致的初始化问题
 */
export const PolicyLimitsResponseSchema = lazySchema(() =>
  z.object({
    restrictions: z.record(z.string(), z.object({ allowed: z.boolean() })),
  }),
)

/** PolicyLimitsResponse 的 TypeScript 类型，由 Zod schema 推导而来 */
export type PolicyLimitsResponse = z.infer<
  ReturnType<typeof PolicyLimitsResponseSchema>
>

/**
 * 单次 fetch 策略限制操作的结果类型
 *
 * 在 fetchPolicyLimits() 和 fetchWithRetry() 中使用，
 * 表示一次 HTTP 请求的完整结果，包含成功/失败状态及相关数据。
 *
 * 字段说明：
 * - success: 请求是否成功（包括 304 Not Modified 也算成功）
 * - restrictions: null 表示收到 304（缓存仍有效），{} 表示 404（无策略限制）
 * - etag: 用于下次请求的 If-None-Match 头部值（即 SHA-256 checksum）
 * - error: 失败时的错误描述字符串
 * - skipRetry: 为 true 时不重试（如 4xx 认证错误）
 */
export type PolicyLimitsFetchResult = {
  success: boolean
  restrictions?: PolicyLimitsResponse['restrictions'] | null // null means 304 Not Modified (cache is valid)
  etag?: string
  error?: string
  skipRetry?: boolean // If true, don't retry on failure (e.g., auth errors)
}
