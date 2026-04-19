/**
 * 【启动引导数据获取模块】api/bootstrap.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * - 属于 API 服务层，在 app 启动时获取后端下发的客户端配置数据
 * - 被主入口（main.tsx）在 setupBackend() 中调用，为会话提供初始配置
 * - 获取到的数据持久化到全局配置（~/.claude.json 中的 clientDataCache 和 additionalModelOptionsCache），
 *   供后续会话使用（即使网络请求失败，也能使用上次缓存的配置）
 *
 * 核心功能：
 * - fetchBootstrapData(): 对外暴露的主函数，获取引导数据并仅在数据变更时持久化到磁盘
 * - fetchBootstrapAPI(): 内部函数，处理认证（OAuth 优先，回退到 API Key）、请求、响应校验
 *
 * 引导数据内容：
 * - client_data: 服务端下发的任意客户端配置（存储到 clientDataCache）
 * - additional_model_options: 服务端动态提供的额外模型选项（存储到 additionalModelOptionsCache）
 *
 * 跳过条件（不发起请求的情况）：
 * - isEssentialTrafficOnly() 为 true（用户开启了仅必要流量模式）
 * - 非 firstParty API 提供商（Bedrock/Vertex/Foundry 用户跳过）
 * - 没有可用的 OAuth token（含 user:profile 作用域）且没有 API Key
 */

import axios from 'axios'
import isEqual from 'lodash-es/isEqual.js'
import {
  getAnthropicApiKey,
  getClaudeAIOAuthTokens,
  hasProfileScope,
} from 'src/utils/auth.js'
import { z } from 'zod'
import { getOauthConfig, OAUTH_BETA_HEADER } from '../../constants/oauth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { withOAuth401Retry } from '../../utils/http.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getClaudeCodeUserAgent } from '../../utils/userAgent.js'

// 引导 API 响应的 Zod schema（懒加载，避免过早执行依赖的模块）
const bootstrapResponseSchema = lazySchema(() =>
  z.object({
    // client_data: 服务端下发的任意键值对配置，nullish 表示可以为 null 或 undefined
    client_data: z.record(z.unknown()).nullish(),
    // additional_model_options: 服务端动态提供的额外模型选项列表
    additional_model_options: z
      .array(
        z
          .object({
            model: z.string(),
            name: z.string(),
            description: z.string(),
          })
          // 通过 transform 重命名字段，使其与 UI 的下拉选项格式（value/label）对齐
          .transform(({ model, name, description }) => ({
            value: model,
            label: name,
            description,
          })),
      )
      .nullish(),
  }),
)

/** 引导 API 响应的 TypeScript 类型（从 Zod schema 推断） */
type BootstrapResponse = z.infer<ReturnType<typeof bootstrapResponseSchema>>

/**
 * 内部函数：向 Anthropic 引导端点发起 HTTP 请求并返回响应数据
 *
 * 认证策略：
 * - 优先使用 OAuth Bearer token（需要 user:profile scope）
 * - OAuth 不可用时回退到 API Key 认证
 * - service-key OAuth tokens 缺少 user:profile scope，会返回 403，因此排除
 *
 * 跳过条件（直接返回 null）：
 * 1. isEssentialTrafficOnly()：用户开启了隐私模式
 * 2. 非 firstParty 提供商：3P 用户（Bedrock/Vertex）不走此接口
 * 3. 既无可用 OAuth token 也无 API Key
 *
 * 错误处理：
 * - 使用 withOAuth401Retry 包装，在 401 时自动刷新 OAuth token 并重试
 * - API Key 用户在 401 时不重试（无刷新机制）
 * - 捕获所有异常并 re-throw（让 fetchBootstrapData 的 catch 块处理）
 */
async function fetchBootstrapAPI(): Promise<BootstrapResponse | null> {
  // 隐私模式：跳过非必要的网络请求
  if (isEssentialTrafficOnly()) {
    logForDebugging('[Bootstrap] Skipped: Nonessential traffic disabled')
    return null
  }

  // 仅对 firstParty（Anthropic）API 提供商发起引导请求
  if (getAPIProvider() !== 'firstParty') {
    logForDebugging('[Bootstrap] Skipped: 3P provider')
    return null
  }

  // OAuth 优先（需要 user:profile scope — service-key OAuth tokens 缺此 scope 会 403）
  // 无 OAuth 时回退到 API Key 认证（console 用户场景）
  const apiKey = getAnthropicApiKey()
  const hasUsableOAuth =
    getClaudeAIOAuthTokens()?.accessToken && hasProfileScope()
  if (!hasUsableOAuth && !apiKey) {
    logForDebugging('[Bootstrap] Skipped: no usable OAuth or API key')
    return null
  }

  const endpoint = `${getOauthConfig().BASE_API_URL}/api/claude_cli/bootstrap`

  // withOAuth401Retry 处理 token 刷新与重试；API Key 用户在 401 时通过（无 OAuth 令牌可刷新）
  try {
    return await withOAuth401Retry(async () => {
      // 每次调用时重新读取 OAuth token，确保重试时使用刷新后的 token
      const token = getClaudeAIOAuthTokens()?.accessToken
      let authHeaders: Record<string, string>
      if (token && hasProfileScope()) {
        // OAuth 路径：Bearer token + OAuth beta 标识头
        authHeaders = {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA_HEADER,
        }
      } else if (apiKey) {
        // API Key 路径：x-api-key 头
        authHeaders = { 'x-api-key': apiKey }
      } else {
        // 重试时也没有可用认证（极少数边缘情况），放弃本次请求
        logForDebugging('[Bootstrap] No auth available on retry, aborting')
        return null
      }

      logForDebugging('[Bootstrap] Fetching')
      const response = await axios.get<unknown>(endpoint, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': getClaudeCodeUserAgent(),
          ...authHeaders,
        },
        timeout: 5000, // 5 秒超时，引导数据不在关键路径上，超时后静默失败
      })
      // 使用 Zod 校验响应结构，失败时返回 null 而非抛出异常
      const parsed = bootstrapResponseSchema().safeParse(response.data)
      if (!parsed.success) {
        logForDebugging(
          `[Bootstrap] Response failed validation: ${parsed.error.message}`,
        )
        return null
      }
      logForDebugging('[Bootstrap] Fetch ok')
      return parsed.data
    })
  } catch (error) {
    logForDebugging(
      `[Bootstrap] Fetch failed: ${axios.isAxiosError(error) ? (error.response?.status ?? error.code) : 'unknown'}`,
    )
    throw error
  }
}

/**
 * 获取引导数据并持久化到磁盘缓存
 *
 * 工作流程：
 * 1. 调用 fetchBootstrapAPI() 发起网络请求
 * 2. 若请求返回 null（跳过或失败），直接返回
 * 3. 将响应数据与当前磁盘缓存进行深度比较（isEqual）：
 *    - 若数据未变更，跳过写盘操作（避免每次启动都写磁盘）
 *    - 若数据有变更，通过 saveGlobalConfig 更新缓存
 * 4. 任何异常均被 logError 捕获，不影响 app 启动流程
 *
 * Fetch bootstrap data from the API and persist to disk cache.
 */
export async function fetchBootstrapData(): Promise<void> {
  try {
    const response = await fetchBootstrapAPI()
    if (!response) return

    const clientData = response.client_data ?? null
    const additionalModelOptions = response.additional_model_options ?? []

    // 深度比较新旧数据，仅在数据实际变更时才写盘，避免每次启动都触发磁盘 I/O
    const config = getGlobalConfig()
    if (
      isEqual(config.clientDataCache, clientData) &&
      isEqual(config.additionalModelOptionsCache, additionalModelOptions)
    ) {
      logForDebugging('[Bootstrap] Cache unchanged, skipping write')
      return
    }

    // 数据有变更，持久化新数据到全局配置文件（~/.claude.json）
    logForDebugging('[Bootstrap] Cache updated, persisting to disk')
    saveGlobalConfig(current => ({
      ...current,
      clientDataCache: clientData,
      additionalModelOptionsCache: additionalModelOptions,
    }))
  } catch (error) {
    // 引导数据失败不阻塞 app 启动，仅记录错误
    logError(error)
  }
}
