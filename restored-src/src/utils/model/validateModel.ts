// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * 模型验证模块（Model Validation）
 *
 * 【在 Claude Code 系统流中的位置】
 * 本文件处于 /model 命令处理流程的最终验证环节，在用户输入的模型名称
 * 被持久化到配置前，通过实际 API 调用确认模型是否可用。
 *
 * 调用链路：
 *   /model 命令处理器
 *     → validateModel(model)
 *     → isModelAllowed (allowlist 前置过滤)
 *     → sideQuery (max_tokens: 1 探针 API 调用)
 *     → handleValidationError (错误分类)
 *     → get3PFallbackSuggestion (3P 用户兜底建议)
 *
 * 【验证流程】
 * 1. 去除首尾空白，空字符串直接拒绝
 * 2. 检查 availableModels allowlist（管理员配置的白名单）
 * 3. 检查是否为已知别名（MODEL_ALIASES，始终合法）
 * 4. 检查是否匹配 ANTHROPIC_CUSTOM_MODEL_OPTION（用户预声明的自定义模型）
 * 5. 检查进程级缓存 validModelCache（避免重复 API 调用）
 * 6. 发起 max_tokens=1 的最小化探针请求验证模型可用性
 *
 * 【主要导出】
 * - validateModel : 异步验证模型字符串，返回 { valid, error? }
 */

import { MODEL_ALIASES } from './aliases.js'
import { isModelAllowed } from './modelAllowlist.js'
import { getAPIProvider } from './providers.js'
import { sideQuery } from '../sideQuery.js'
import {
  NotFoundError,
  APIError,
  APIConnectionError,
  AuthenticationError,
} from '@anthropic-ai/sdk'
import { getModelStrings } from './modelStrings.js'

// 进程级缓存：记录已通过 API 验证的合法模型，避免重复调用
const validModelCache = new Map<string, boolean>()

/**
 * 通过实际 API 调用验证模型是否可用。
 *
 * 【验证步骤（按优先级）】
 * 1. 去空白后为空字符串 → 直接拒绝
 * 2. 不在 availableModels allowlist 中 → 拒绝（管理员白名单限制）
 * 3. 是已知别名（sonnet/opus/haiku 等）→ 始终合法，直接通过
 * 4. 等于 ANTHROPIC_CUSTOM_MODEL_OPTION → 用户已预声明，直接通过
 * 5. 在进程级缓存中 → 使用缓存结果，避免重复 API 调用
 * 6. 发起 max_tokens=1 的最小探针请求，通过则缓存结果
 *
 * @param model 用户输入的模型名称字符串
 * @returns { valid: true } 或 { valid: false, error: string }
 */
export async function validateModel(
  model: string,
): Promise<{ valid: boolean; error?: string }> {
  const normalizedModel = model.trim()

  // 空字符串模型名称无效
  if (!normalizedModel) {
    return { valid: false, error: 'Model name cannot be empty' }
  }

  // 若 availableModels 白名单已配置，先过滤不在其中的模型
  if (!isModelAllowed(normalizedModel)) {
    return {
      valid: false,
      error: `Model '${normalizedModel}' is not in the list of available models`,
    }
  }

  // 已知别名（sonnet/opus/haiku/best 等）始终视为合法，无需 API 验证
  const lowerModel = normalizedModel.toLowerCase()
  if ((MODEL_ALIASES as readonly string[]).includes(lowerModel)) {
    return { valid: true }
  }

  // ANTHROPIC_CUSTOM_MODEL_OPTION 是用户在环境变量中预声明的合法自定义模型
  if (normalizedModel === process.env.ANTHROPIC_CUSTOM_MODEL_OPTION) {
    return { valid: true }
  }

  // 进程级缓存命中，无需再次调用 API
  if (validModelCache.has(normalizedModel)) {
    return { valid: true }
  }


  // 发起最小化探针 API 请求（max_tokens: 1），验证模型是否真实可用
  try {
    await sideQuery({
      model: normalizedModel,
      max_tokens: 1,
      maxRetries: 0,
      querySource: 'model_validation',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Hi',
              cache_control: { type: 'ephemeral' },
            },
          ],
        },
      ],
    })

    // 请求成功，模型有效，加入缓存
    validModelCache.set(normalizedModel, true)
    return { valid: true }
  } catch (error) {
    // 请求失败，进入错误分类处理
    return handleValidationError(error, normalizedModel)
  }
}

/**
 * 将 API 调用错误分类为用户友好的验证失败消息。
 *
 * 【错误分类逻辑】
 * - NotFoundError (404)           : 模型不存在，附加 3P 兜底建议
 * - AuthenticationError (401)     : 认证失败，提示检查 API 凭证
 * - APIConnectionError            : 网络错误，提示检查网络连接
 * - APIError（body not_found_error）: 模型特定的未找到错误
 * - 其他 APIError                 : 通用 API 错误
 * - 未知错误                      : 兜底处理，提示无法验证
 *
 * @param error     捕获到的异常对象
 * @param modelName 被验证的模型名称（用于错误消息格式化）
 * @returns { valid: false, error: string }
 */
function handleValidationError(
  error: unknown,
  modelName: string,
): { valid: boolean; error: string } {
  // NotFoundError (404) 表示模型不存在，为 3P 用户提供兜底建议
  if (error instanceof NotFoundError) {
    const fallback = get3PFallbackSuggestion(modelName)
    const suggestion = fallback ? `. Try '${fallback}' instead` : ''
    return {
      valid: false,
      error: `Model '${modelName}' not found${suggestion}`,
    }
  }

  // 其他 API 错误按类型细分
  if (error instanceof APIError) {
    if (error instanceof AuthenticationError) {
      return {
        valid: false,
        error: 'Authentication failed. Please check your API credentials.',
      }
    }

    if (error instanceof APIConnectionError) {
      return {
        valid: false,
        error: 'Network error. Please check your internet connection.',
      }
    }

    // 检查错误 body 中是否包含模型特定的 not_found_error
    const errorBody = error.error as unknown
    if (
      errorBody &&
      typeof errorBody === 'object' &&
      'type' in errorBody &&
      errorBody.type === 'not_found_error' &&
      'message' in errorBody &&
      typeof errorBody.message === 'string' &&
      errorBody.message.includes('model:')
    ) {
      return { valid: false, error: `Model '${modelName}' not found` }
    }

    // 通用 API 错误，透传错误消息
    return { valid: false, error: `API error: ${error.message}` }
  }

  // 未知错误类型，兜底处理并提取错误消息
  const errorMessage = error instanceof Error ? error.message : String(error)
  return {
    valid: false,
    error: `Unable to validate model: ${errorMessage}`,
  }
}

// @[MODEL LAUNCH]: Add a fallback suggestion chain for the new model → previous version
/**
 * 为 3P 用户提供模型版本降级兜底建议。
 *
 * 当 3P 提供商尚未部署最新模型时，建议用户切换到已知可用的上一版本：
 * - opus-4-6    → opus41（上一代 Opus）
 * - sonnet-4-6  → sonnet45（上一代 Sonnet）
 * - sonnet-4-5  → sonnet40（再上一代 Sonnet）
 *
 * 仅对 3P 提供商生效；firstParty 用户始终能访问最新模型，无需兜底建议。
 *
 * @param model 验证失败的模型名称
 * @returns 建议的兜底模型 ID，或 undefined（无建议）
 */
function get3PFallbackSuggestion(model: string): string | undefined {
  // 官方 API 不需要兜底建议
  if (getAPIProvider() === 'firstParty') {
    return undefined
  }
  const lowerModel = model.toLowerCase()
  // opus-4-6 不可用时，建议切换到 opus41
  if (lowerModel.includes('opus-4-6') || lowerModel.includes('opus_4_6')) {
    return getModelStrings().opus41
  }
  // sonnet-4-6 不可用时，建议切换到 sonnet45
  if (lowerModel.includes('sonnet-4-6') || lowerModel.includes('sonnet_4_6')) {
    return getModelStrings().sonnet45
  }
  // sonnet-4-5 不可用时，建议切换到 sonnet40
  if (lowerModel.includes('sonnet-4-5') || lowerModel.includes('sonnet_4_5')) {
    return getModelStrings().sonnet40
  }
  return undefined
}
