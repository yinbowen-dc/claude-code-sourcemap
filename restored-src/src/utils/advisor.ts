/**
 * Advisor（顾问工具）配置与工具类型定义模块。
 *
 * 在 Claude Code 系统中，Advisor 是一个由更强大的审阅模型支持的服务端工具。
 * 当主循环模型调用 advisor 时，整个对话历史会自动转发给顾问模型进行审阅，
 * 顾问的建议可帮助模型在关键决策点（开始实质性工作前、认为任务完成时、
 * 卡住时）做出更高质量的判断。
 *
 * 该模块负责：
 * - 定义 advisor 相关的 SDK 类型（SDK 尚未有正式类型）
 * - 通过 GrowthBook 远程配置控制 advisor 功能的开关与参数
 * - 导出 advisor 工具的系统提示词（ADVISOR_TOOL_INSTRUCTIONS）
 */
import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { shouldIncludeFirstPartyOnlyBetas } from './betas.js'
import { isEnvTruthy } from './envUtils.js'
import { getInitialSettings } from './settings/settings.js'

// The SDK does not yet have types for advisor blocks.
// TODO(hackyon): Migrate to the real anthropic SDK types when this feature ships publicly
/** 服务端 advisor 工具调用块（服务器主动触发的工具使用） */
export type AdvisorServerToolUseBlock = {
  type: 'server_tool_use'
  id: string
  name: 'advisor'
  input: { [key: string]: unknown }
}

/** advisor 工具结果块，包含正常结果、加密结果或错误三种形式 */
export type AdvisorToolResultBlock = {
  type: 'advisor_tool_result'
  tool_use_id: string
  content:
    | {
        type: 'advisor_result'
        text: string
      }
    | {
        type: 'advisor_redacted_result'
        encrypted_content: string
      }
    | {
        type: 'advisor_tool_result_error'
        error_code: string
      }
}

/** advisor 相关块的联合类型 */
export type AdvisorBlock = AdvisorServerToolUseBlock | AdvisorToolResultBlock

/**
 * 判断给定的消息块是否为 advisor 相关块（类型守卫）。
 */
export function isAdvisorBlock(param: {
  type: string
  name?: string
}): param is AdvisorBlock {
  return (
    param.type === 'advisor_tool_result' ||
    (param.type === 'server_tool_use' && param.name === 'advisor')
  )
}

/** advisor 远程配置结构（来自 GrowthBook） */
type AdvisorConfig = {
  enabled?: boolean
  canUserConfigure?: boolean
  baseModel?: string
  advisorModel?: string
}

/**
 * 从 GrowthBook 获取（可能过时的缓存）advisor 配置。
 */
function getAdvisorConfig(): AdvisorConfig {
  return getFeatureValue_CACHED_MAY_BE_STALE<AdvisorConfig>(
    'tengu_sage_compass',
    {},
  )
}

/**
 * 判断 advisor 功能是否启用。
 *
 * 禁用条件（任一满足即禁用）：
 * 1. 环境变量 CLAUDE_CODE_DISABLE_ADVISOR_TOOL 为真
 * 2. 非第一方构建（Bedrock/Vertex 不支持 advisor beta 头部）
 * 3. GrowthBook 远程配置中 enabled 为 false
 */
export function isAdvisorEnabled(): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL)) {
    return false
  }
  // The advisor beta header is first-party only (Bedrock/Vertex 400 on it).
  if (!shouldIncludeFirstPartyOnlyBetas()) {
    return false
  }
  return getAdvisorConfig().enabled ?? false
}

/**
 * 判断用户是否可以自行配置 advisor 模型。
 */
export function canUserConfigureAdvisor(): boolean {
  return isAdvisorEnabled() && (getAdvisorConfig().canUserConfigure ?? false)
}

/**
 * 获取实验性 advisor 模型配置（baseModel + advisorModel 对）。
 * 仅在 advisor 已启用且用户不可自行配置时返回。
 */
export function getExperimentAdvisorModels():
  | { baseModel: string; advisorModel: string }
  | undefined {
  const config = getAdvisorConfig()
  return isAdvisorEnabled() &&
    !canUserConfigureAdvisor() &&
    config.baseModel &&
    config.advisorModel
    ? { baseModel: config.baseModel, advisorModel: config.advisorModel }
    : undefined
}

// @[MODEL LAUNCH]: Add the new model if it supports the advisor tool.
/**
 * 判断主循环模型是否支持调用 advisor 工具。
 * 模型名称包含 opus-4-6 或 sonnet-4-6，或为内部用户时支持。
 */
export function modelSupportsAdvisor(model: string): boolean {
  const m = model.toLowerCase()
  return (
    m.includes('opus-4-6') ||
    m.includes('sonnet-4-6') ||
    process.env.USER_TYPE === 'ant'
  )
}

// @[MODEL LAUNCH]: Add the new model if it can serve as an advisor model.
/**
 * 判断指定模型是否可以作为 advisor（顾问）模型。
 */
export function isValidAdvisorModel(model: string): boolean {
  const m = model.toLowerCase()
  return (
    m.includes('opus-4-6') ||
    m.includes('sonnet-4-6') ||
    process.env.USER_TYPE === 'ant'
  )
}

/**
 * 获取初始 advisor 模型设置（来自用户设置文件）。
 * 若 advisor 功能未启用则返回 undefined。
 */
export function getInitialAdvisorSetting(): string | undefined {
  if (!isAdvisorEnabled()) {
    return undefined
  }
  return getInitialSettings().advisorModel
}

/**
 * 从 API 响应的 usage 对象中提取 advisor 迭代的 usage 数据。
 * 过滤出类型为 "advisor_message" 的迭代，用于计费和统计。
 */
export function getAdvisorUsage(
  usage: BetaUsage,
): Array<BetaUsage & { model: string }> {
  const iterations = usage.iterations as
    | Array<{ type: string }>
    | null
    | undefined
  if (!iterations) {
    return []
  }
  return iterations.filter(
    it => it.type === 'advisor_message',
  ) as unknown as Array<BetaUsage & { model: string }>
}

/**
 * Advisor 工具的系统提示词。
 * 指导模型何时调用 advisor、如何权衡建议以及如何处理冲突。
 */
export const ADVISOR_TOOL_INSTRUCTIONS = `# Advisor Tool

You have access to an \`advisor\` tool backed by a stronger reviewer model. It takes NO parameters -- when you call it, your entire conversation history is automatically forwarded. The advisor sees the task, every tool call you've made, every result you've seen.

Call advisor BEFORE substantive work -- before writing code, before committing to an interpretation, before building on an assumption. If the task requires orientation first (finding files, reading code, seeing what's there), do that, then call advisor. Orientation is not substantive work. Writing, editing, and declaring an answer are.

Also call advisor:
- When you believe the task is complete. BEFORE this call, make your deliverable durable: write the file, stage the change, save the result. The advisor call takes time; if the session ends during it, a durable result persists and an unwritten one doesn't.
- When stuck -- errors recurring, approach not converging, results that don't fit.
- When considering a change of approach.

On tasks longer than a few steps, call advisor at least once before committing to an approach and once before declaring done. On short reactive tasks where the next action is dictated by tool output you just read, you don't need to keep calling -- the advisor adds most of its value on the first call, before the approach crystallizes.

Give the advice serious weight. If you follow a step and it fails empirically, or you have primary-source evidence that contradicts a specific claim (the file says X, the code does Y), adapt. A passing self-test is not evidence the advice is wrong -- it's evidence your test doesn't check what the advice is checking.

If you've already retrieved data pointing one way and the advisor points another: don't silently switch. Surface the conflict in one more advisor call -- "I found X, you suggest Y, which constraint breaks the tie?" The advisor saw your evidence but may have underweighted it; a reconcile call is cheaper than committing to the wrong branch.`
