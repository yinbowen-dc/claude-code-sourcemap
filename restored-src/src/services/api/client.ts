/**
 * 【Anthropic API 客户端工厂模块】api/client.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * - 属于 API 服务层的核心基础设施，负责创建与 Anthropic API 的连接客户端
 * - 被 api/claude.ts 在每次发起 LLM 请求前调用 getAnthropicClient() 获取已配置的客户端
 * - 支持四种 API 提供商：标准 Anthropic API、AWS Bedrock、Google Vertex AI、Azure Foundry
 * - 依赖 auth.ts 处理认证（OAuth、API Key、AWS/GCP/Azure 凭证），proxy.ts 处理代理设置
 *
 * 核心功能：
 * - getAnthropicClient(): 根据环境变量自动选择合适的客户端实现（Anthropic/Bedrock/Foundry/Vertex）
 * - createStderrLogger(): 创建将 SDK 日志输出到 stderr 的 logger（调试模式使用）
 * - configureApiKeyHeaders(): 为非 OAuth 用户配置 API 密钥认证头
 * - getCustomHeaders(): 解析 ANTHROPIC_CUSTOM_HEADERS 环境变量中的自定义请求头
 * - buildFetch(): 构建带请求 ID 注入和调试日志的 fetch 包装器
 *
 * 环境变量说明：
 * - 标准 API：ANTHROPIC_API_KEY
 * - Bedrock：AWS credentials / AWS_REGION / ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
 * - Foundry（Azure）：ANTHROPIC_FOUNDRY_RESOURCE / ANTHROPIC_FOUNDRY_BASE_URL / ANTHROPIC_FOUNDRY_API_KEY
 * - Vertex：ANTHROPIC_VERTEX_PROJECT_ID / CLOUD_ML_REGION / VERTEX_REGION_* / GCP credentials
 */

import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk'
import { randomUUID } from 'crypto'
import type { GoogleAuth } from 'google-auth-library'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getAnthropicApiKey,
  getApiKeyFromApiKeyHelper,
  getClaudeAIOAuthTokens,
  isClaudeAISubscriber,
  refreshAndGetAwsCredentials,
  refreshGcpCredentialsIfNeeded,
} from 'src/utils/auth.js'
import { getUserAgent } from 'src/utils/http.js'
import { getSmallFastModel } from 'src/utils/model/model.js'
import {
  getAPIProvider,
  isFirstPartyAnthropicBaseUrl,
} from 'src/utils/model/providers.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import {
  getIsNonInteractiveSession,
  getSessionId,
} from '../../bootstrap/state.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { isDebugToStdErr, logForDebugging } from '../../utils/debug.js'
import {
  getAWSRegion,
  getVertexRegionForModel,
  isEnvTruthy,
} from '../../utils/envUtils.js'

/**
 * Environment variables for different client types:
 *
 * Direct API:
 * - ANTHROPIC_API_KEY: Required for direct API access
 *
 * AWS Bedrock:
 * - AWS credentials configured via aws-sdk defaults
 * - AWS_REGION or AWS_DEFAULT_REGION: Sets the AWS region for all models (default: us-east-1)
 * - ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION: Optional. Override AWS region specifically for the small fast model (Haiku)
 *
 * Foundry (Azure):
 * - ANTHROPIC_FOUNDRY_RESOURCE: Your Azure resource name (e.g., 'my-resource')
 *   For the full endpoint: https://{resource}.services.ai.azure.com/anthropic/v1/messages
 * - ANTHROPIC_FOUNDRY_BASE_URL: Optional. Alternative to resource - provide full base URL directly
 *   (e.g., 'https://my-resource.services.ai.azure.com')
 *
 * Authentication (one of the following):
 * - ANTHROPIC_FOUNDRY_API_KEY: Your Microsoft Foundry API key (if using API key auth)
 * - Azure AD authentication: If no API key is provided, uses DefaultAzureCredential
 *   which supports multiple auth methods (environment variables, managed identity,
 *   Azure CLI, etc.). See: https://docs.microsoft.com/en-us/javascript/api/@azure/identity
 *
 * Vertex AI:
 * - Model-specific region variables (highest priority):
 *   - VERTEX_REGION_CLAUDE_3_5_HAIKU: Region for Claude 3.5 Haiku model
 *   - VERTEX_REGION_CLAUDE_HAIKU_4_5: Region for Claude Haiku 4.5 model
 *   - VERTEX_REGION_CLAUDE_3_5_SONNET: Region for Claude 3.5 Sonnet model
 *   - VERTEX_REGION_CLAUDE_3_7_SONNET: Region for Claude 3.7 Sonnet model
 * - CLOUD_ML_REGION: Optional. The default GCP region to use for all models
 *   If specific model region not specified above
 * - ANTHROPIC_VERTEX_PROJECT_ID: Required. Your GCP project ID
 * - Standard GCP credentials configured via google-auth-library
 *
 * Priority for determining region:
 * 1. Hardcoded model-specific environment variables
 * 2. Global CLOUD_ML_REGION variable
 * 3. Default region from config
 * 4. Fallback region (us-east5)
 */

/**
 * 创建将 SDK 日志输出到 stderr 的 logger 对象
 *
 * 在调试模式（isDebugToStdErr()）下使用，将 SDK 内部的 error/warn/info/debug
 * 级别日志都输出到 stderr，避免干扰标准输出中的 CLI 交互内容。
 *
 * 注意：使用 console.error 而非 console.log，因为 SDK logger 接口要求。
 */
function createStderrLogger(): ClientOptions['logger'] {
  return {
    error: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Anthropic SDK ERROR]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    warn: (msg, ...args) => console.error('[Anthropic SDK WARN]', msg, ...args),
    // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
    info: (msg, ...args) => console.error('[Anthropic SDK INFO]', msg, ...args),
    debug: (msg, ...args) =>
      // biome-ignore lint/suspicious/noConsole:: intentional console output -- SDK logger must use console
      console.error('[Anthropic SDK DEBUG]', msg, ...args),
  }
}

/**
 * 创建并返回已配置的 Anthropic API 客户端
 *
 * 根据环境变量自动选择客户端实现：
 * 1. CLAUDE_CODE_USE_BEDROCK=1 → AnthropicBedrock（AWS Bedrock）
 * 2. CLAUDE_CODE_USE_FOUNDRY=1 → AnthropicFoundry（Azure AI Foundry）
 * 3. CLAUDE_CODE_USE_VERTEX=1 → AnthropicVertex（Google Vertex AI）
 * 4. 默认 → 标准 Anthropic SDK
 *
 * 认证处理：
 * - OAuth 用户（isClaudeAISubscriber）：使用 OAuth Bearer token
 * - 非 OAuth 用户：使用 API Key 或 ANTHROPIC_AUTH_TOKEN 环境变量
 *
 * 其他特性：
 * - 注入 x-app、User-Agent、X-Claude-Code-Session-Id 等标准请求头
 * - 支持容器 ID（CLAUDE_CODE_CONTAINER_ID）和远程会话 ID（CLAUDE_CODE_REMOTE_SESSION_ID）头
 * - 支持附加保护头（CLAUDE_CODE_ADDITIONAL_PROTECTION）
 * - 通过 buildFetch() 注入客户端请求 ID 和调试日志
 *
 * @param apiKey - 可选的 API Key，不提供则从环境变量读取
 * @param maxRetries - SDK 层面的最大重试次数
 * @param model - 请求的目标模型（影响 Bedrock/Vertex 的区域选择）
 * @param fetchOverride - 可选的自定义 fetch 实现（用于 VCR 录制等场景）
 * @param source - 请求来源标识（用于调试日志）
 */
export async function getAnthropicClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,
  source,
}: {
  apiKey?: string
  maxRetries: number
  model?: string
  fetchOverride?: ClientOptions['fetch']
  source?: string
}): Promise<Anthropic> {
  const containerId = process.env.CLAUDE_CODE_CONTAINER_ID
  const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
  const customHeaders = getCustomHeaders()
  // 构建所有请求共用的默认请求头
  const defaultHeaders: { [key: string]: string } = {
    'x-app': 'cli',                               // 标识客户端类型为 CLI
    'User-Agent': getUserAgent(),                  // 包含版本信息的 User-Agent
    'X-Claude-Code-Session-Id': getSessionId(),   // 当前会话 ID（用于服务端关联日志）
    ...customHeaders,                              // 用户通过 ANTHROPIC_CUSTOM_HEADERS 注入的头
    ...(containerId ? { 'x-claude-remote-container-id': containerId } : {}),
    ...(remoteSessionId
      ? { 'x-claude-remote-session-id': remoteSessionId }
      : {}),
    // SDK 消费者可通过此头标识其应用/库，用于后端分析
    ...(clientApp ? { 'x-client-app': clientApp } : {}),
  }

  // 记录 API 客户端配置信息（用于 HFI 调试）
  logForDebugging(
    `[API:request] Creating client, ANTHROPIC_CUSTOM_HEADERS present: ${!!process.env.ANTHROPIC_CUSTOM_HEADERS}, has Authorization header: ${!!customHeaders['Authorization']}`,
  )

  // 若启用了附加保护（企业安全策略），注入对应请求头
  const additionalProtectionEnabled = isEnvTruthy(
    process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION,
  )
  if (additionalProtectionEnabled) {
    defaultHeaders['x-anthropic-additional-protection'] = 'true'
  }

  // 检查并刷新过期的 OAuth token（确保后续请求有有效认证）
  logForDebugging('[API:auth] OAuth token check starting')
  await checkAndRefreshOAuthTokenIfNeeded()
  logForDebugging('[API:auth] OAuth token check complete')

  // 非 OAuth 订阅用户需要额外配置 API Key 认证头
  if (!isClaudeAISubscriber()) {
    await configureApiKeyHeaders(defaultHeaders, getIsNonInteractiveSession())
  }

  const resolvedFetch = buildFetch(fetchOverride, source)

  // 所有客户端共用的基础参数
  const ARGS = {
    defaultHeaders,
    maxRetries,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10), // 默认 600 秒超时
    dangerouslyAllowBrowser: true, // 允许在 Bun 环境（类 browser 环境）中运行
    fetchOptions: getProxyFetchOptions({
      forAnthropicAPI: true,
    }) as ClientOptions['fetchOptions'],
    ...(resolvedFetch && {
      fetch: resolvedFetch,
    }),
  }

  // AWS Bedrock 客户端分支
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    const { AnthropicBedrock } = await import('@anthropic-ai/bedrock-sdk')
    // 若指定了小型快速模型（Haiku）的专用区域，优先使用；否则使用全局 AWS 区域
    const awsRegion =
      model === getSmallFastModel() &&
      process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
        ? process.env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION
        : getAWSRegion()

    const bedrockArgs: ConstructorParameters<typeof AnthropicBedrock>[0] = {
      ...ARGS,
      awsRegion,
      ...(isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH) && {
        skipAuth: true, // 测试/代理场景下跳过 AWS 认证
      }),
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }

    // 优先使用 Bedrock API Key 认证（AWS Bearer Token）
    if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
      bedrockArgs.skipAuth = true
      // 注入 Bearer token 用于 Bedrock API 密钥认证
      bedrockArgs.defaultHeaders = {
        ...bedrockArgs.defaultHeaders,
        Authorization: `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}`,
      }
    } else if (!isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)) {
      // 无 Bearer Token 且不跳过认证时，刷新并获取 AWS 临时凭证
      const cachedCredentials = await refreshAndGetAwsCredentials()
      if (cachedCredentials) {
        bedrockArgs.awsAccessKey = cachedCredentials.accessKeyId
        bedrockArgs.awsSecretKey = cachedCredentials.secretAccessKey
        bedrockArgs.awsSessionToken = cachedCredentials.sessionToken
      }
    }
    // 注意：AnthropicBedrock 不支持 batching 和 models，类型转换为 Anthropic 以满足接口要求
    return new AnthropicBedrock(bedrockArgs) as unknown as Anthropic
  }

  // Azure AI Foundry 客户端分支
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) {
    const { AnthropicFoundry } = await import('@anthropic-ai/foundry-sdk')
    // 根据配置决定 Azure AD token 提供方式：SDK 默认读取 ANTHROPIC_FOUNDRY_API_KEY
    let azureADTokenProvider: (() => Promise<string>) | undefined
    if (!process.env.ANTHROPIC_FOUNDRY_API_KEY) {
      if (isEnvTruthy(process.env.CLAUDE_CODE_SKIP_FOUNDRY_AUTH)) {
        // 测试/代理场景：使用空 token 的 mock provider
        azureADTokenProvider = () => Promise.resolve('')
      } else {
        // 正式环境：使用 DefaultAzureCredential（支持多种 Azure 认证方式）
        const {
          DefaultAzureCredential: AzureCredential,
          getBearerTokenProvider,
        } = await import('@azure/identity')
        azureADTokenProvider = getBearerTokenProvider(
          new AzureCredential(),
          'https://cognitiveservices.azure.com/.default',
        )
      }
    }

    const foundryArgs: ConstructorParameters<typeof AnthropicFoundry>[0] = {
      ...ARGS,
      ...(azureADTokenProvider && { azureADTokenProvider }),
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }
    // 注意：AnthropicFoundry 不支持 batching 和 models
    return new AnthropicFoundry(foundryArgs) as unknown as Anthropic
  }

  // Google Vertex AI 客户端分支
  if (isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    // 若配置了 GCP 凭证刷新（gcpAuthRefresh），在凭证过期时自动刷新（类似 Bedrock 的 AWS 凭证刷新）
    if (!isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)) {
      await refreshGcpCredentialsIfNeeded()
    }

    const [{ AnthropicVertex }, { GoogleAuth }] = await Promise.all([
      import('@anthropic-ai/vertex-sdk'),
      import('google-auth-library'),
    ])
    // TODO: 缓存 GoogleAuth 实例或 AuthClient 以提升性能
    // 目前每次 getAnthropicClient() 都创建新的 GoogleAuth 实例，可能导致重复认证流程和 metadata server 查询
    // 缓存需要小心处理凭证刷新/过期、环境变量变化、跨请求认证状态等问题

    // google-auth-library 检查 project ID 的顺序：
    // 1. 环境变量（GCLOUD_PROJECT、GOOGLE_CLOUD_PROJECT 等）
    // 2. 凭证文件（service account JSON、ADC 文件）
    // 3. gcloud config
    // 4. GCE metadata server（在 GCP 外会产生 12 秒超时）
    //
    // 仅当用户未配置其他 project 发现方式时，才使用 ANTHROPIC_VERTEX_PROJECT_ID 作为兜底，
    // 避免干扰已有的认证配置

    // 按 google-auth-library 的顺序检查 project 环境变量
    const hasProjectEnvVar =
      process.env['GCLOUD_PROJECT'] ||
      process.env['GOOGLE_CLOUD_PROJECT'] ||
      process.env['gcloud_project'] ||
      process.env['google_cloud_project']

    // 检查凭证文件路径（service account 或 ADC），包含大小写变体
    const hasKeyFile =
      process.env['GOOGLE_APPLICATION_CREDENTIALS'] ||
      process.env['google_application_credentials']

    const googleAuth = isEnvTruthy(process.env.CLAUDE_CODE_SKIP_VERTEX_AUTH)
      ? ({
          // 测试/代理场景：使用 mock GoogleAuth，始终返回空 headers
          getClient: () => ({
            getRequestHeaders: () => ({}),
          }),
        } as unknown as GoogleAuth)
      : new GoogleAuth({
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
          // 仅在以下条件同时满足时，才使用 ANTHROPIC_VERTEX_PROJECT_ID 作为兜底 projectId：
          // - 未设置任何 project 环境变量（hasProjectEnvVar 为假）
          // - 未指定凭证文件路径（hasKeyFile 为假）
          // 这可以防止 GCE metadata server 的 12 秒超时
          // 风险：若认证项目与 API 目标项目不同，可能导致计费/审计问题
          // 缓解：用户可通过设置 GOOGLE_CLOUD_PROJECT 覆盖
          ...(hasProjectEnvVar || hasKeyFile
            ? {}
            : {
                projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
              }),
        })

    const vertexArgs: ConstructorParameters<typeof AnthropicVertex>[0] = {
      ...ARGS,
      region: getVertexRegionForModel(model), // 根据模型名自动选择 Vertex 区域
      googleAuth,
      ...(isDebugToStdErr() && { logger: createStderrLogger() }),
    }
    // 注意：AnthropicVertex 不支持 batching 和 models
    return new AnthropicVertex(vertexArgs) as unknown as Anthropic
  }

  // 标准 Anthropic API 客户端（默认路径）
  // OAuth 订阅用户使用 authToken（Bearer）；非 OAuth 用户使用 apiKey
  const clientConfig: ConstructorParameters<typeof Anthropic>[0] = {
    apiKey: isClaudeAISubscriber() ? null : apiKey || getAnthropicApiKey(),
    authToken: isClaudeAISubscriber()
      ? getClaudeAIOAuthTokens()?.accessToken
      : undefined,
    // ant 用户使用 staging OAuth 时，将 baseURL 切换到 staging 环境
    ...(process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.USE_STAGING_OAUTH)
      ? { baseURL: getOauthConfig().BASE_API_URL }
      : {}),
    ...ARGS,
    ...(isDebugToStdErr() && { logger: createStderrLogger() }),
  }

  return new Anthropic(clientConfig)
}

/**
 * 为非 OAuth 用户配置 API Key 认证请求头
 *
 * 认证优先级：
 * 1. ANTHROPIC_AUTH_TOKEN 环境变量（Bearer token 形式）
 * 2. getApiKeyFromApiKeyHelper()（从 keychain 或其他辅助工具获取）
 *
 * @param headers - 待修改的请求头对象（直接修改引用）
 * @param isNonInteractiveSession - 是否为非交互式会话（影响 keychain 查询行为）
 */
async function configureApiKeyHeaders(
  headers: Record<string, string>,
  isNonInteractiveSession: boolean,
): Promise<void> {
  const token =
    process.env.ANTHROPIC_AUTH_TOKEN ||
    (await getApiKeyFromApiKeyHelper(isNonInteractiveSession))
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
}

/**
 * 解析 ANTHROPIC_CUSTOM_HEADERS 环境变量中的自定义请求头
 *
 * 支持通过换行符分隔多个 header，每个 header 格式为 "Name: Value"（curl 风格）。
 * 解析时以第一个冒号为分隔符（避免 value 中含冒号时的正则回溯风险）。
 *
 * 用途：企业用户可以通过此环境变量注入自定义头（如认证代理需要的特殊头）
 */
function getCustomHeaders(): Record<string, string> {
  const customHeaders: Record<string, string> = {}
  const customHeadersEnv = process.env.ANTHROPIC_CUSTOM_HEADERS

  if (!customHeadersEnv) return customHeaders

  // 按换行符分割，支持多个 header
  const headerStrings = customHeadersEnv.split(/\n|\r\n/)

  for (const headerString of headerStrings) {
    if (!headerString.trim()) continue

    // 以第一个冒号为分隔符解析 header（curl 格式 "Name: Value"）
    // 使用字符串操作而非正则，避免对格式异常的超长 header 触发正则回溯
    const colonIdx = headerString.indexOf(':')
    if (colonIdx === -1) continue
    const name = headerString.slice(0, colonIdx).trim()
    const value = headerString.slice(colonIdx + 1).trim()
    if (name) {
      customHeaders[name] = value
    }
  }

  return customHeaders
}

/** 客户端请求 ID 头名称（用于与服务端日志关联超时请求） */
export const CLIENT_REQUEST_ID_HEADER = 'x-client-request-id'

/**
 * 构建带请求 ID 注入和调试日志的 fetch 包装器
 *
 * 主要功能：
 * 1. 为仅向 Anthropic 第一方 API 发出的请求注入 x-client-request-id（UUID），
 *    使服务端可以通过客户端 ID 关联超时请求（超时时无服务端 request ID）
 * 2. 记录 API 请求路径和客户端请求 ID 到调试日志（非关键路径，异常时静默忽略）
 *
 * 注意：仅对 firstParty API 且 URL 为 Anthropic 域名时注入 request ID；
 * Bedrock/Vertex/Foundry 或自定义 base URL 不注入（避免触发严格代理的未知头拒绝）
 *
 * @param fetchOverride - 调用方提供的 fetch 替代实现（如 VCR）
 * @param source - 请求来源标识（用于调试日志中的 source 字段）
 */
function buildFetch(
  fetchOverride: ClientOptions['fetch'],
  source: string | undefined,
): ClientOptions['fetch'] {
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const inner = fetchOverride ?? globalThis.fetch
  // 只向第一方 Anthropic API 注入 client request ID，避免未知头被严格代理拒绝
  const injectClientRequestId =
    getAPIProvider() === 'firstParty' && isFirstPartyAnthropicBaseUrl()
  return (input, init) => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(init?.headers)
    // 生成客户端侧请求 ID，使超时请求（服务端无返回 ID）也能与服务端日志关联
    // 若调用方已预设该头（如 VCR 回放），则不覆盖
    if (injectClientRequestId && !headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID())
    }
    try {
      // 记录 API 请求路径和 client request ID 到调试日志
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const url = input instanceof Request ? input.url : String(input)
      const id = headers.get(CLIENT_REQUEST_ID_HEADER)
      logForDebugging(
        `[API REQUEST] ${new URL(url).pathname}${id ? ` ${CLIENT_REQUEST_ID_HEADER}=${id}` : ''} source=${source ?? 'unknown'}`,
      )
    } catch {
      // 日志记录失败不应影响实际的 fetch 请求
    }
    return inner(input, { ...init, headers })
  }
}
