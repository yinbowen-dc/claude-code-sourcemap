/**
 * AWS Bedrock 客户端与推理配置工具模块
 *
 * 【在 Claude Code 系统流中的位置】
 * 本文件是 Bedrock 提供商层的基础支撑模块，被以下上层模块依赖：
 *   - agent.ts     : 继承父模型的 Bedrock 跨区域前缀
 *   - model.ts     : 解析 Bedrock 模型 ID 和推理 Profile
 *   - modelOptions.ts : 列举可用的 Bedrock 推理 Profile
 *
 * 【主要功能】
 * 1. getBedrockInferenceProfiles — 列举当前区域所有 Anthropic 推理配置 Profile（带 memoize 缓存）
 * 2. findFirstMatch              — 在 Profile 列表中按子串匹配第一个 Profile ID
 * 3. createBedrockClient         — 创建 Bedrock 管理平面客户端（用于列举 Profile）
 * 4. createBedrockRuntimeClient  — 创建 Bedrock 推理运行时客户端（用于模型调用）
 * 5. getInferenceProfileBackingModel — 解析 Profile 背后的实际基础模型 ID（带 memoize 缓存）
 * 6. isFoundationModel           — 判断模型 ID 是否为基础模型格式（anthropic. 前缀）
 * 7. extractModelIdFromArn       — 从 ARN 字符串中提取模型/Profile ID
 * 8. getBedrockRegionPrefix      — 从模型 ID 中提取跨区域推理前缀（us/eu/apac/global）
 * 9. applyBedrockRegionPrefix    — 向 Bedrock 模型 ID 添加或替换跨区域推理前缀
 */

import memoize from 'lodash-es/memoize.js'
import { refreshAndGetAwsCredentials } from '../auth.js'
import { getAWSRegion, isEnvTruthy } from '../envUtils.js'
import { logError } from '../log.js'
import { getAWSClientProxyConfig } from '../proxy.js'

/**
 * 列举当前 AWS 区域内所有 Anthropic SYSTEM_DEFINED 推理配置 Profile。
 *
 * 【缓存机制】
 * 使用 lodash memoize 缓存结果，避免在同一进程内重复调用 Bedrock ListInferenceProfiles API。
 * 进程级别缓存，进程重启后自动失效。
 *
 * 【分页处理】
 * 通过 do-while 循环处理 nextToken 翻页，确保拉取所有 Profile。
 *
 * 【过滤逻辑】
 * 仅返回 inferenceProfileId 中包含 'anthropic' 的 Profile（排除其他供应商）。
 *
 * @returns 包含 Anthropic 推理 Profile ID 的字符串数组
 */
export const getBedrockInferenceProfiles = memoize(async function (): Promise<
  string[]
> {
  const [client, { ListInferenceProfilesCommand }] = await Promise.all([
    createBedrockClient(),
    import('@aws-sdk/client-bedrock'),
  ])
  const allProfiles = []
  let nextToken: string | undefined

  try {
    do {
      // 构造 ListInferenceProfiles 请求，仅拉取 SYSTEM_DEFINED 类型
      const command = new ListInferenceProfilesCommand({
        ...(nextToken && { nextToken }),
        typeEquals: 'SYSTEM_DEFINED',
      })
      const response = await client.send(command)

      if (response.inferenceProfileSummaries) {
        allProfiles.push(...response.inferenceProfileSummaries)
      }

      // 更新分页游标，若为 undefined 则循环结束
      nextToken = response.nextToken
    } while (nextToken)

    // 过滤保留 Anthropic 供应商的 Profile，并去除 undefined 值
    return allProfiles
      .filter(profile => profile.inferenceProfileId?.includes('anthropic'))
      .map(profile => profile.inferenceProfileId)
      .filter(Boolean) as string[]
  } catch (error) {
    logError(error as Error)
    throw error
  }
})

/**
 * 在推理 Profile ID 列表中查找第一个包含指定子串的 Profile。
 *
 * @param profiles  Profile ID 字符串数组
 * @param substring 要匹配的子串（如模型家族名称片段）
 * @returns 第一个匹配的 Profile ID，若无匹配则返回 null
 */
export function findFirstMatch(
  profiles: string[],
  substring: string,
): string | null {
  return profiles.find(p => p.includes(substring)) ?? null
}

/**
 * 创建 AWS Bedrock 管理平面客户端（BedrockClient）。
 *
 * 【区域读取规则】
 * 完全匹配 Anthropic Bedrock SDK 行为：
 *   1. 读取 AWS_REGION 或 AWS_DEFAULT_REGION 环境变量
 *   2. 默认回退到 'us-east-1'
 * 确保 Profile 列举与模型调用使用相同区域。
 *
 * 【跳过认证模式】
 * 当 CLAUDE_CODE_SKIP_BEDROCK_AUTH=1 时，注入 smithy.api#noAuth scheme，
 * 绕过 AWS 签名，用于本地代理/测试环境。
 *
 * 【Bearer Token 认证】
 * 当 AWS_BEARER_TOKEN_BEDROCK 已设置时，不刷新 IAM 凭证，
 * 由 SDK 直接使用 Bearer Token 认证。
 */
async function createBedrockClient() {
  const { BedrockClient } = await import('@aws-sdk/client-bedrock')
  // 与 Anthropic Bedrock SDK 保持完全一致的区域读取逻辑
  const region = getAWSRegion()

  const skipAuth = isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)

  const clientConfig: ConstructorParameters<typeof BedrockClient>[0] = {
    region,
    // 若配置了自定义 Bedrock Base URL，覆盖默认端点
    ...(process.env.ANTHROPIC_BEDROCK_BASE_URL && {
      endpoint: process.env.ANTHROPIC_BEDROCK_BASE_URL,
    }),
    // 注入代理配置（HTTP/HTTPS proxy）
    ...(await getAWSClientProxyConfig()),
    // 跳过认证时注入 noAuth 方案（本地/测试环境）
    ...(skipAuth && {
      requestHandler: new (
        await import('@smithy/node-http-handler')
      ).NodeHttpHandler(),
      httpAuthSchemes: [
        {
          schemeId: 'smithy.api#noAuth',
          identityProvider: () => async () => ({}),
          signer: new (await import('@smithy/core')).NoAuthSigner(),
        },
      ],
      httpAuthSchemeProvider: () => [{ schemeId: 'smithy.api#noAuth' }],
    }),
  }

  if (!skipAuth && !process.env.AWS_BEARER_TOKEN_BEDROCK) {
    // 非 Bearer Token 认证时，刷新并注入 IAM 短期凭证
    const cachedCredentials = await refreshAndGetAwsCredentials()
    if (cachedCredentials) {
      clientConfig.credentials = {
        accessKeyId: cachedCredentials.accessKeyId,
        secretAccessKey: cachedCredentials.secretAccessKey,
        sessionToken: cachedCredentials.sessionToken,
      }
    }
  }

  return new BedrockClient(clientConfig)
}

/**
 * 创建 AWS Bedrock 推理运行时客户端（BedrockRuntimeClient）。
 *
 * 与 createBedrockClient 逻辑基本相同，但有以下差异：
 *   - 使用 BedrockRuntimeClient（用于模型推理调用，而非管理 API）
 *   - skipAuth 时显式强制 HTTP/1.1（默认 HTTP/2 可能与代理不兼容）
 *
 * 【代理兼容性】
 * BedrockRuntimeClient 默认使用 HTTP/2，部分代理服务器不支持，
 * 因此在跳过认证（通常为代理环境）时显式切换到 HTTP/1.1。
 */
export async function createBedrockRuntimeClient() {
  const { BedrockRuntimeClient } = await import(
    '@aws-sdk/client-bedrock-runtime'
  )
  const region = getAWSRegion()
  const skipAuth = isEnvTruthy(process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH)

  const clientConfig: ConstructorParameters<typeof BedrockRuntimeClient>[0] = {
    region,
    ...(process.env.ANTHROPIC_BEDROCK_BASE_URL && {
      endpoint: process.env.ANTHROPIC_BEDROCK_BASE_URL,
    }),
    ...(await getAWSClientProxyConfig()),
    ...(skipAuth && {
      // BedrockRuntimeClient 默认使用 HTTP/2，代理服务器可能不支持，
      // 显式强制 HTTP/1.1 以确保代理兼容性
      requestHandler: new (
        await import('@smithy/node-http-handler')
      ).NodeHttpHandler(),
      httpAuthSchemes: [
        {
          schemeId: 'smithy.api#noAuth',
          identityProvider: () => async () => ({}),
          signer: new (await import('@smithy/core')).NoAuthSigner(),
        },
      ],
      httpAuthSchemeProvider: () => [{ schemeId: 'smithy.api#noAuth' }],
    }),
  }

  if (!skipAuth && !process.env.AWS_BEARER_TOKEN_BEDROCK) {
    // 非 Bearer Token 认证时，刷新并注入 IAM 短期凭证
    const cachedCredentials = await refreshAndGetAwsCredentials()
    if (cachedCredentials) {
      clientConfig.credentials = {
        accessKeyId: cachedCredentials.accessKeyId,
        secretAccessKey: cachedCredentials.secretAccessKey,
        sessionToken: cachedCredentials.sessionToken,
      }
    }
  }

  return new BedrockRuntimeClient(clientConfig)
}

/**
 * 解析 Bedrock 推理 Profile 背后的实际基础模型 ID（memoize 缓存）。
 *
 * 【用途】
 * 用于 Token 用量成本计算：推理 Profile 在多个基础模型间负载均衡，
 * 但同一 Profile 下的模型成本结构相同，取第一个即可。
 *
 * 【ARN 解析】
 * Bedrock GetInferenceProfile 返回的模型 ARN 格式为：
 *   arn:aws:bedrock:<region>:<account>:foundation-model/<model-name>
 * 通过截取最后一个 '/' 后的部分得到短 model-name。
 *
 * @param profileId 推理 Profile ID 或 ARN
 * @returns 背后的基础模型短 ID，失败时返回 null
 */
export const getInferenceProfileBackingModel = memoize(async function (
  profileId: string,
): Promise<string | null> {
  try {
    const [client, { GetInferenceProfileCommand }] = await Promise.all([
      createBedrockClient(),
      import('@aws-sdk/client-bedrock'),
    ])
    const command = new GetInferenceProfileCommand({
      inferenceProfileIdentifier: profileId,
    })
    const response = await client.send(command)

    if (!response.models || response.models.length === 0) {
      return null
    }

    // 取第一个基础模型作为主要代表（用于成本计算）
    // 实际上应用推理 Profile 在同成本结构模型间负载均衡
    const primaryModel = response.models[0]
    if (!primaryModel?.modelArn) {
      return null
    }

    // 从 ARN 中提取模型名称（截取最后一个 '/' 后的部分）
    // ARN 格式: arn:aws:bedrock:region:account:foundation-model/model-name
    const lastSlashIndex = primaryModel.modelArn.lastIndexOf('/')
    return lastSlashIndex >= 0
      ? primaryModel.modelArn.substring(lastSlashIndex + 1)
      : primaryModel.modelArn
  } catch (error) {
    logError(error as Error)
    return null
  }
})

/**
 * 判断给定模型 ID 是否为 Bedrock 基础模型格式。
 * 基础模型格式以 'anthropic.' 开头，如 "anthropic.claude-sonnet-4-5-20250929-v1:0"。
 *
 * @param modelId 模型 ID 字符串
 * @returns true 表示基础模型格式，false 表示跨区域推理 Profile 或其他格式
 */
export function isFoundationModel(modelId: string): boolean {
  return modelId.startsWith('anthropic.')
}

/**
 * Bedrock 跨区域推理 Profile 前缀常量列表。
 * 这些前缀允许将请求路由到特定区域的模型。
 */
const BEDROCK_REGION_PREFIXES = ['us', 'eu', 'apac', 'global'] as const

/**
 * 从 Bedrock ARN 或模型 ID 中提取纯 Profile/模型 ID。
 * 若输入不是 ARN（不以 'arn:' 开头），则原样返回。
 *
 * 【支持的 ARN 格式】
 *   - arn:aws:bedrock:<region>:<account>:inference-profile/<profile-id>
 *   - arn:aws:bedrock:<region>:<account>:application-inference-profile/<profile-id>
 *   - arn:aws:bedrock:<region>::foundation-model/<model-id>
 *
 * @param modelId 模型 ID 或 ARN 字符串
 * @returns 纯 Profile/模型 ID（截取最后一个 '/' 后的部分）
 */
export function extractModelIdFromArn(modelId: string): string {
  if (!modelId.startsWith('arn:')) {
    return modelId
  }
  const lastSlashIndex = modelId.lastIndexOf('/')
  if (lastSlashIndex === -1) {
    return modelId
  }
  return modelId.substring(lastSlashIndex + 1)
}

// 从常量数组派生跨区域前缀联合类型
export type BedrockRegionPrefix = (typeof BEDROCK_REGION_PREFIXES)[number]

/**
 * 从 Bedrock 跨区域推理模型 ID 中提取区域前缀。
 * 同时支持纯 ID 格式和完整 ARN 格式。
 *
 * 【示例】
 * - "eu.anthropic.claude-sonnet-4-5-20250929-v1:0"           → "eu"
 * - "us.anthropic.claude-3-7-sonnet-20250219-v1:0"            → "us"
 * - "arn:…/global.anthropic.claude-opus-4-6-v1"               → "global"
 * - "anthropic.claude-3-5-sonnet-20241022-v2:0"               → undefined（基础模型）
 * - "claude-sonnet-4-5-20250929"                              → undefined（官方格式）
 *
 * @param modelId 模型 ID 或 ARN
 * @returns 区域前缀字符串，若无前缀则返回 undefined
 */
export function getBedrockRegionPrefix(
  modelId: string,
): BedrockRegionPrefix | undefined {
  // 若为 ARN 格式，先提取出实际 Profile ID
  const effectiveModelId = extractModelIdFromArn(modelId)

  for (const prefix of BEDROCK_REGION_PREFIXES) {
    if (effectiveModelId.startsWith(`${prefix}.anthropic.`)) {
      return prefix
    }
  }
  return undefined
}

/**
 * 向 Bedrock 模型 ID 添加或替换跨区域推理前缀。
 *
 * 【处理规则】
 * 1. 若模型 ID 已有区域前缀（如 "us."），替换为新前缀
 * 2. 若模型 ID 为基础模型格式（"anthropic."），在前面添加前缀
 * 3. 若模型 ID 不是 Bedrock 格式，原样返回（无操作）
 *
 * 【示例】
 * - applyBedrockRegionPrefix("us.anthropic.claude-sonnet-4-5-v1:0", "eu") → "eu.anthropic.claude-sonnet-4-5-v1:0"
 * - applyBedrockRegionPrefix("anthropic.claude-sonnet-4-5-v1:0", "eu")    → "eu.anthropic.claude-sonnet-4-5-v1:0"
 * - applyBedrockRegionPrefix("claude-sonnet-4-5-20250929", "eu")           → "claude-sonnet-4-5-20250929"（非 Bedrock 格式）
 *
 * @param modelId 原始模型 ID
 * @param prefix  要应用的区域前缀
 * @returns 应用前缀后的模型 ID
 */
export function applyBedrockRegionPrefix(
  modelId: string,
  prefix: BedrockRegionPrefix,
): string {
  // 若已有区域前缀，替换为新前缀
  const existingPrefix = getBedrockRegionPrefix(modelId)
  if (existingPrefix) {
    return modelId.replace(`${existingPrefix}.`, `${prefix}.`)
  }

  // 若为基础模型格式（anthropic. 开头），添加前缀
  if (isFoundationModel(modelId)) {
    return `${prefix}.${modelId}`
  }

  // 非 Bedrock 格式模型 ID（如官方 API 格式），原样返回
  return modelId
}
