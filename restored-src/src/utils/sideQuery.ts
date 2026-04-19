/**
 * 旁路查询（Side Query）API 封装模块。
 *
 * 在 Claude Code 系统中，该模块为主对话循环之外的"旁路查询"提供
 * 轻量级 API 包装，例如权限解释器、会话搜索、模型验证等。
 *
 * 使用此模块而非直接调用 client.beta.messages.create() 的原因：
 * - 自动注入 fingerprint + attribution header，确保 OAuth Token 校验正确
 * - 自动添加 CLI 系统提示前缀（attribution header 独立 block，服务端解析不含系统提示内容）
 * - 自动获取模型对应的 betas 列表，支持 structured outputs
 * - 自动规范化 model 字符串（去除 [1m] 后缀）
 * - 自动记录 tengu_api_success 事件（含完整 token 用量和耗时）
 *
 * 主要导出：
 * - `SideQueryOptions`：查询选项类型
 * - `sideQuery(opts)`：执行旁路查询，返回 BetaMessage
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages.js'
import {
  getLastApiCompletionTimestamp,
  setLastApiCompletionTimestamp,
} from '../bootstrap/state.js'
import { STRUCTURED_OUTPUTS_BETA_HEADER } from '../constants/betas.js'
import type { QuerySource } from '../constants/querySource.js'
import {
  getAttributionHeader,
  getCLISyspromptPrefix,
} from '../constants/system.js'
import { logEvent } from '../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../services/analytics/metadata.js'
import { getAPIMetadata } from '../services/api/claude.js'
import { getAnthropicClient } from '../services/api/client.js'
import { getModelBetas, modelSupportsStructuredOutputs } from './betas.js'
import { computeFingerprint } from './fingerprint.js'
import { normalizeModelStringForAPI } from './model/model.js'

type MessageParam = Anthropic.MessageParam
type TextBlockParam = Anthropic.TextBlockParam
type Tool = Anthropic.Tool
type ToolChoice = Anthropic.ToolChoice
type BetaMessage = Anthropic.Beta.Messages.BetaMessage
type BetaJSONOutputFormat = Anthropic.Beta.Messages.BetaJSONOutputFormat
type BetaThinkingConfigParam = Anthropic.Beta.Messages.BetaThinkingConfigParam

/** 旁路查询选项类型，涵盖模型、消息、工具、thinking、限制等全部参数 */
export type SideQueryOptions = {
  /** 用于本次查询的模型 */
  model: string
  /**
   * 系统提示：字符串或 TextBlockParam 数组。
   * attribution header 始终放在独立的 TextBlockParam block 中，
   * 以确保服务端解析时能正确提取 cc_entrypoint，不混入系统提示内容。
   */
  system?: string | TextBlockParam[]
  /** 发送的消息（content block 支持 cache_control） */
  messages: MessageParam[]
  /** 可选工具列表（支持标准 Tool[] 和 BetaToolUnion[] 自定义工具类型） */
  tools?: Tool[] | BetaToolUnion[]
  /** 可选工具选择（使用 { type: 'tool', name: 'x' } 强制输出） */
  tool_choice?: ToolChoice
  /** 可选 JSON 输出格式，用于结构化响应 */
  output_format?: BetaJSONOutputFormat
  /** 最大输出 token 数（默认：1024） */
  max_tokens?: number
  /** 最大重试次数（默认：2） */
  maxRetries?: number
  /** 中止信号 */
  signal?: AbortSignal
  /** 跳过 CLI 系统提示前缀（内部分类器自带系统提示时使用；仍保留 OAuth attribution header） */
  skipSystemPromptPrefix?: boolean
  /** 温度覆盖值 */
  temperature?: number
  /** thinking 预算（启用 thinking）；false 表示发送 { type: 'disabled' } */
  thinking?: number | false
  /** 停止序列——生成时遇到任意字符串即停止 */
  stop_sequences?: string[]
  /** 在 tengu_api_success 事件中标识本次调用来源，用于 COGS 报表关联 */
  querySource: QuerySource
}

/**
 * 从第一条用户消息中提取文本内容，用于计算 fingerprint。
 *
 * 遍历 messages 找到第一条 role=user 的消息，提取其文本内容；
 * 若 content 为数组，则取第一个 type=text 的 block。
 *
 * @param messages 消息数组
 * @returns 第一条用户消息的文本，未找到时返回空字符串
 */
function extractFirstUserMessageText(messages: MessageParam[]): string {
  const firstUserMessage = messages.find(m => m.role === 'user')
  if (!firstUserMessage) return ''

  const content = firstUserMessage.content
  // 若 content 为字符串，直接返回
  if (typeof content === 'string') return content

  // 若 content 为 block 数组，找第一个 text block
  const textBlock = content.find(block => block.type === 'text')
  return textBlock?.type === 'text' ? textBlock.text : ''
}

/**
 * 执行主对话循环之外的旁路查询。
 *
 * 处理流程：
 * 1. 获取 Anthropic 客户端（含重试配置）
 * 2. 组装 betas 列表（含 structured outputs beta）
 * 3. 从第一条用户消息提取文本，计算 OAuth fingerprint
 * 4. 构建 systemBlocks：attribution header + CLI 前缀 + 用户 system
 * 5. 处理 thinking 配置（disabled / enabled + budget_tokens）
 * 6. 规范化 model 字符串，调用 beta.messages.create()
 * 7. 记录 tengu_api_success 事件（token 用量、耗时、上次 API 调用间隔）
 *
 * @param opts 查询选项
 * @returns API 响应的 BetaMessage
 */
export async function sideQuery(opts: SideQueryOptions): Promise<BetaMessage> {
  const {
    model,
    system,
    messages,
    tools,
    tool_choice,
    output_format,
    max_tokens = 1024,
    maxRetries = 2,
    signal,
    skipSystemPromptPrefix,
    temperature,
    thinking,
    stop_sequences,
  } = opts

  // 获取带有重试配置的 Anthropic 客户端
  const client = await getAnthropicClient({
    maxRetries,
    model,
    source: 'side_query',
  })
  // 获取模型专属 betas 列表
  const betas = [...getModelBetas(model)]
  // 若请求结构化输出且模型支持，追加 structured-outputs beta header
  if (
    output_format &&
    modelSupportsStructuredOutputs(model) &&
    !betas.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
  ) {
    betas.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }

  // 从第一条用户消息提取文本，用于计算 OAuth fingerprint
  const messageText = extractFirstUserMessageText(messages)

  // 计算 fingerprint，用于 OAuth Token 归因校验
  const fingerprint = computeFingerprint(messageText, MACRO.VERSION)
  const attributionHeader = getAttributionHeader(fingerprint)

  // 构建系统提示 block 数组：attribution header 独立 block + CLI 前缀 + 用户 system
  // attribution header 必须放在单独 block，以防服务端解析将系统提示内容混入 cc_entrypoint
  const systemBlocks: TextBlockParam[] = [
    attributionHeader ? { type: 'text', text: attributionHeader } : null,
    // 内部分类器（skipSystemPromptPrefix=true）自带 system prompt，跳过 CLI 前缀
    ...(skipSystemPromptPrefix
      ? []
      : [
          {
            type: 'text' as const,
            text: getCLISyspromptPrefix({
              isNonInteractive: false,
              hasAppendSystemPrompt: false,
            }),
          },
        ]),
    // 将用户 system 转换为 block 数组格式
    ...(Array.isArray(system)
      ? system
      : system
        ? [{ type: 'text' as const, text: system }]
        : []),
  ].filter((block): block is TextBlockParam => block !== null)

  // 处理 thinking 配置：false → disabled，数字 → enabled + budget_tokens
  let thinkingConfig: BetaThinkingConfigParam | undefined
  if (thinking === false) {
    thinkingConfig = { type: 'disabled' }
  } else if (thinking !== undefined) {
    // budget_tokens 不得超过 max_tokens-1（至少留 1 token 给文本输出）
    thinkingConfig = {
      type: 'enabled',
      budget_tokens: Math.min(thinking, max_tokens - 1),
    }
  }

  // 规范化 model 字符串（去除 [1m] 等 UI 后缀，使 API 能正确识别）
  const normalizedModel = normalizeModelStringForAPI(model)
  const start = Date.now()
  // biome-ignore lint/plugin: 此模块是处理 OAuth attribution 的封装层
  const response = await client.beta.messages.create(
    {
      model: normalizedModel,
      max_tokens,
      system: systemBlocks,
      messages,
      ...(tools && { tools }),
      ...(tool_choice && { tool_choice }),
      ...(output_format && { output_config: { format: output_format } }),
      ...(temperature !== undefined && { temperature }),
      ...(stop_sequences && { stop_sequences }),
      ...(thinkingConfig && { thinking: thinkingConfig }),
      ...(betas.length > 0 && { betas }),
      metadata: getAPIMetadata(),
    },
    { signal },
  )

  // 提取 request ID（用于日志关联）
  const requestId =
    (response as { _request_id?: string | null })._request_id ?? undefined
  const now = Date.now()
  const lastCompletion = getLastApiCompletionTimestamp()
  // 记录 API 成功事件：request ID、来源、模型、token 用量、耗时
  logEvent('tengu_api_success', {
    requestId:
      requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource:
      opts.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    model:
      normalizedModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
    uncachedInputTokens: response.usage.cache_creation_input_tokens ?? 0,
    durationMsIncludingRetries: now - start,
    // 上次 API 调用完成到本次开始的间隔（null 表示首次调用）
    timeSinceLastApiCallMs:
      lastCompletion !== null ? now - lastCompletion : undefined,
  })
  // 更新最近一次 API 完成时间戳
  setLastApiCompletionTimestamp(now)

  return response
}
