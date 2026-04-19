// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
/**
 * 【分析事件元数据富化模块】analytics/metadata.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * - 属于分析（analytics）子系统，是所有分析系统（Datadog、1P）的元数据单一来源
 * - 由 datadog.ts 的 trackDatadogEvent() 和 firstPartyEventLogger.ts 的 logEventTo1P() 共同依赖
 * - buildEnvContext() 通过 memoize 保证环境上下文只构建一次（对 Promise.all 内的异步操作友好）
 *
 * 核心功能：
 * - sanitizeToolNameForAnalytics(): MCP 工具名脱敏（mcp__ → 'mcp_tool'）
 * - isAnalyticsToolDetailsLoggingEnabled(): 判断 MCP 工具名是否可安全记录（local-agent/官方 URL/claudeai-proxy）
 * - mcpToolDetailsForAnalytics(): 工具调用事件的 MCP 名称字段填充（统一收口，替代各事件点的 IIFE 模式）
 * - extractMcpToolDetails(): 从 mcp__<server>__<tool> 格式解析服务器名和工具名
 * - extractSkillName(): 从 Skill 工具调用输入提取技能名称
 * - extractToolInputForTelemetry(): 工具输入序列化（截断长字符串/深层嵌套），OTEL_LOG_TOOL_DETAILS=1 时启用
 * - getFileExtensionForAnalytics(): 文件扩展名提取，超长扩展名（>10 字符）替换为 'other' 防止哈希泄露
 * - getFileExtensionsFromBashCommand(): 从 Bash 命令提取文件扩展名（仅分析 FILE_COMMANDS 白名单命令）
 * - buildEnvContext(): 构建环境上下文（平台/架构/运行时/CI/WSL/Linux 发行版/VCS 等），memoized
 * - getEventMetadata(): 获取所有分析事件的核心元数据（model/session/userType/envContext 等）
 * - to1PEventFormat(): 将 EventMetadata 转换为 1P 事件格式（snake_case），写入 proto-typed EnvironmentMetadata
 */

import { extname } from 'path'
import memoize from 'lodash-es/memoize.js'
import { env, getHostPlatformForAnalytics } from '../../utils/env.js'
import { envDynamic } from '../../utils/envDynamic.js'
import { getModelBetas } from '../../utils/betas.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import {
  getSessionId,
  getIsInteractive,
  getKairosActive,
  getClientType,
  getParentSessionId as getParentSessionIdFromState,
} from '../../bootstrap/state.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isOfficialMcpUrl } from '../mcp/officialRegistry.js'
import { isClaudeAISubscriber, getSubscriptionType } from '../../utils/auth.js'
import { getRepoRemoteHash } from '../../utils/git.js'
import {
  getWslVersion,
  getLinuxDistroInfo,
  detectVcs,
} from '../../utils/platform.js'
import type { CoreUserData } from 'src/utils/user.js'
import { getAgentContext } from '../../utils/agentContext.js'
import type { EnvironmentMetadata } from '../../types/generated/events_mono/claude_code/v1/claude_code_internal_event.js'
import type { PublicApiAuth } from '../../types/generated/events_mono/common/v1/auth.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getAgentId,
  getParentSessionId as getTeammateParentSessionId,
  getTeamName,
  isTeammate,
} from '../../utils/teammate.js'
import { feature } from 'bun:bundle'

/**
 * 分析元数据安全性标记类型
 *
 * never 类型标记，强制调用者在传入字符串值时显式断言该字符串不包含代码片段或文件路径。
 * 用法：`myString as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`
 * metadata 预期为 JSON 可序列化值。
 */
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never

/**
 * MCP 工具名脱敏（用于 analytics 上报）
 *
 * MCP 工具名格式为 `mcp__<server>__<tool>`，可能泄露用户特定的服务器配置（PII-medium 级别）。
 * 此函数将 MCP 工具名统一替换为 'mcp_tool'，保留内置工具名（Bash/Read/Write 等）不变。
 *
 * @param toolName - 待脱敏的工具名
 * @returns 内置工具返回原名，MCP 工具返回 'mcp_tool'
 */
export function sanitizeToolNameForAnalytics(
  toolName: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  if (toolName.startsWith('mcp__')) {
    return 'mcp_tool' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }
  return toolName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * 检查 OTLP 事件中是否启用详细工具名记录
 *
 * 启用后，MCP 服务器/工具名和 Skill 名称都会被记录。
 * 默认禁用以保护 PII（用户特定的服务器配置）。
 * 通过 OTEL_LOG_TOOL_DETAILS=1 启用。
 */
export function isToolDetailsLoggingEnabled(): boolean {
  return isEnvTruthy(process.env.OTEL_LOG_TOOL_DETAILS)
}

/**
 * 判断 analytics 事件中是否可安全记录详细 MCP 工具名
 *
 * 根据 go/taxonomy，MCP 名称属于 medium PII。以下情况可以安全记录：
 * - Cowork 模式（entrypoint=local-agent）：无 ZDR 概念，记录所有 MCP
 * - claude.ai 代理的连接器（claudeai-proxy）：始终来自 claude.ai 官方列表
 * - 官方 MCP Registry URL 中的服务器（通过 `claude mcp add` 添加的目录连接器）
 *
 * 用户自定义 MCP（不满足以上条件）保持脱敏（toolName='mcp_tool'）。
 */
export function isAnalyticsToolDetailsLoggingEnabled(
  mcpServerType: string | undefined,
  mcpServerBaseUrl: string | undefined,
): boolean {
  // Cowork 模式：无 ZDR 限制，可记录所有 MCP 名称
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'local-agent') {
    return true
  }
  // claude.ai 代理的连接器始终来自官方列表，可安全记录
  if (mcpServerType === 'claudeai-proxy') {
    return true
  }
  // URL 匹配官方 MCP Registry 的服务器可安全记录（目录连接器，非用户自定义）
  if (mcpServerBaseUrl && isOfficialMcpUrl(mcpServerBaseUrl)) {
    return true
  }
  return false
}

/**
 * 内置第一方 MCP 服务器名称集合（固定保留字符串，非用户配置，可安全记录）
 *
 * 通过 feature gate（CHICAGO_MCP）控制：
 * - feature off 时集合为空（此时 'computer-use' 可能是用户配置的服务器）
 * - feature on 时包含已知的内置服务器名
 *
 * 此集合在 isAnalyticsToolDetailsLoggingEnabled 的传输/URL 检查之外额外检查（stdio 内置服务器会通不过那些检查）。
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const BUILTIN_MCP_SERVER_NAMES: ReadonlySet<string> = new Set(
  feature('CHICAGO_MCP')
    ? [
        (
          require('../../utils/computerUse/common.js') as typeof import('../../utils/computerUse/common.js')
        ).COMPUTER_USE_MCP_SERVER_NAME,
      ]
    : [],
)
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * logEvent payload 中 MCP 工具详情字段的填充助手
 *
 * 返回 {mcpServerName, mcpToolName}（若条件满足），否则返回空对象。
 * 统一替代各 tengu_tool_use_* 调用点中重复的 IIFE 模式，消除冗余代码。
 *
 * 判断逻辑：
 * 1. 不是 MCP 工具（不含 mcp__ 前缀）→ 空对象
 * 2. 是内置服务器（BUILTIN_MCP_SERVER_NAMES）→ 记录（跳过传输/URL 检查）
 * 3. isAnalyticsToolDetailsLoggingEnabled 通过 → 记录
 * 4. 其他 → 空对象（脱敏）
 */
export function mcpToolDetailsForAnalytics(
  toolName: string,
  mcpServerType: string | undefined,
  mcpServerBaseUrl: string | undefined,
): {
  mcpServerName?: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  mcpToolName?: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
} {
  const details = extractMcpToolDetails(toolName)
  if (!details) {
    return {}
  }
  // 内置服务器或可信传输/URL → 记录详情
  if (
    !BUILTIN_MCP_SERVER_NAMES.has(details.serverName) &&
    !isAnalyticsToolDetailsLoggingEnabled(mcpServerType, mcpServerBaseUrl)
  ) {
    return {}
  }
  return {
    mcpServerName: details.serverName,
    mcpToolName: details.mcpToolName,
  }
}

/**
 * 从完整 MCP 工具名解析服务器名和工具名
 *
 * MCP 工具名格式：mcp__<server>__<tool>
 * 注意：工具名本身可能含 __，因此 parts[2..] 需要重新 join。
 *
 * @param toolName - 完整工具名（如 'mcp__slack__read_channel'）
 * @returns {serverName, mcpToolName}，非 MCP 工具返回 undefined
 */
export function extractMcpToolDetails(toolName: string):
  | {
      serverName: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      mcpToolName: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    }
  | undefined {
  if (!toolName.startsWith('mcp__')) {
    return undefined
  }

  // Format: mcp__<server>__<tool>
  const parts = toolName.split('__')
  if (parts.length < 3) {
    return undefined
  }

  const serverName = parts[1]
  // 工具名可能含 __，重新 join 剩余部分
  const mcpToolName = parts.slice(2).join('__')

  if (!serverName || !mcpToolName) {
    return undefined
  }

  return {
    serverName:
      serverName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    mcpToolName:
      mcpToolName as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  }
}

/**
 * 从 Skill 工具调用输入中提取技能名称
 *
 * Skill 工具的 input 对象包含 skill 字段（技能名称字符串）。
 * 对于非 Skill 工具或输入格式不符的情况返回 undefined。
 *
 * @param toolName - 工具名（应为 'Skill'）
 * @param input - 工具输入（包含技能名称的对象）
 * @returns 技能名称字符串，非 Skill 工具返回 undefined
 */
export function extractSkillName(
  toolName: string,
  input: unknown,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS | undefined {
  if (toolName !== 'Skill') {
    return undefined
  }

  if (
    typeof input === 'object' &&
    input !== null &&
    'skill' in input &&
    typeof (input as { skill: unknown }).skill === 'string'
  ) {
    return (input as { skill: string })
      .skill as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }

  return undefined
}

// 工具输入截断参数：长字符串截断阈值、截断目标长度、JSON 最大字节数、集合最大元素数、最大嵌套深度
const TOOL_INPUT_STRING_TRUNCATE_AT = 512
const TOOL_INPUT_STRING_TRUNCATE_TO = 128
const TOOL_INPUT_MAX_JSON_CHARS = 4 * 1024
const TOOL_INPUT_MAX_COLLECTION_ITEMS = 20
const TOOL_INPUT_MAX_DEPTH = 2

/**
 * 递归截断工具输入值（OTel tool_result 事件序列化辅助）
 *
 * 截断规则：
 * - 字符串 > 512 字符：截断到 128 字符并附加 '…[N chars]'
 * - 数字/布尔/null/undefined：原样返回
 * - 超过最大深度（2）的嵌套对象/数组：替换为 '<nested>'
 * - 数组：最多保留 20 个元素，超出部分追加 '…[N items]'
 * - 对象：最多保留 20 个键，跳过以 _ 开头的内部标记键（如 _simulatedSedEdit）
 * - 其他类型：转为字符串
 */
function truncateToolInputValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    if (value.length > TOOL_INPUT_STRING_TRUNCATE_AT) {
      return `${value.slice(0, TOOL_INPUT_STRING_TRUNCATE_TO)}…[${value.length} chars]`
    }
    return value
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  ) {
    return value
  }
  if (depth >= TOOL_INPUT_MAX_DEPTH) {
    return '<nested>'
  }
  if (Array.isArray(value)) {
    const mapped = value
      .slice(0, TOOL_INPUT_MAX_COLLECTION_ITEMS)
      .map(v => truncateToolInputValue(v, depth + 1))
    if (value.length > TOOL_INPUT_MAX_COLLECTION_ITEMS) {
      mapped.push(`…[${value.length} items]`)
    }
    return mapped
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // Skip internal marker keys (e.g. _simulatedSedEdit re-introduced by
      // SedEditPermissionRequest) so they don't leak into telemetry.
      .filter(([k]) => !k.startsWith('_'))
    const mapped = entries
      .slice(0, TOOL_INPUT_MAX_COLLECTION_ITEMS)
      .map(([k, v]) => [k, truncateToolInputValue(v, depth + 1)])
    if (entries.length > TOOL_INPUT_MAX_COLLECTION_ITEMS) {
      mapped.push(['…', `${entries.length} keys`])
    }
    return Object.fromEntries(mapped)
  }
  return String(value)
}

/**
 * 序列化工具输入参数（用于 OTel tool_result 事件）
 *
 * 对长字符串和深层嵌套进行截断，保持输出有界，
 * 同时保留有取证价值的字段（文件路径、URL、MCP 参数等）。
 * 仅在 OTEL_LOG_TOOL_DETAILS=1 时启用（默认禁用保护 PII）。
 *
 * 若输出超过 4KB JSON 字符数，在末尾追加 '…[truncated]'。
 * 返回 undefined 表示工具详情日志未启用。
 */
export function extractToolInputForTelemetry(
  input: unknown,
): string | undefined {
  if (!isToolDetailsLoggingEnabled()) {
    return undefined
  }
  const truncated = truncateToolInputValue(input)
  let json = jsonStringify(truncated)
  if (json.length > TOOL_INPUT_MAX_JSON_CHARS) {
    // 超出最大 JSON 字符数，截断并添加提示
    json = json.slice(0, TOOL_INPUT_MAX_JSON_CHARS) + '…[truncated]'
  }
  return json
}

/**
 * 文件扩展名最大长度（用于 analytics 上报）
 *
 * 超过此长度的扩展名被视为潜在敏感信息
 * （如 hash 文件名 "key-hash-abcd-123-456"）并替换为 'other'。
 */
const MAX_FILE_EXTENSION_LENGTH = 10

/**
 * 提取并脱敏文件扩展名（用于 analytics 上报）
 *
 * 使用 Node 的 path.extname 进行跨平台的扩展名提取。
 * 超长扩展名（> MAX_FILE_EXTENSION_LENGTH）返回 'other' 防止泄露敏感信息（如 hash 文件名）。
 * 无扩展名（无 '.' 或仅有 '.'）返回 undefined。
 *
 * @param filePath - 文件路径
 * @returns 脱敏后的扩展名，超长时返回 'other'，无扩展名返回 undefined
 */
export function getFileExtensionForAnalytics(
  filePath: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS | undefined {
  const ext = extname(filePath).toLowerCase()
  if (!ext || ext === '.') {
    return undefined
  }

  const extension = ext.slice(1) // 移除前导 '.'
  // 扩展名过长，可能是 hash 文件名，替换为 'other'
  if (extension.length > MAX_FILE_EXTENSION_LENGTH) {
    return 'other' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }

  return extension as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/** 允许从中提取文件扩展名的命令白名单 */
const FILE_COMMANDS = new Set([
  'rm',
  'mv',
  'cp',
  'touch',
  'mkdir',
  'chmod',
  'chown',
  'cat',
  'head',
  'tail',
  'sort',
  'stat',
  'diff',
  'wc',
  'grep',
  'rg',
  'sed',
])

/** 复合操作符（&&、||、;、|）分割正则 */
const COMPOUND_OPERATOR_REGEX = /\s*(?:&&|\|\||[;|])\s*/

/** 空白分割正则 */
const WHITESPACE_REGEX = /\s+/

/**
 * 从 Bash 命令提取文件扩展名（尽力而为，用于 analytics）
 *
 * 分析策略：
 * 1. 无 '.' 且无 simulatedSedEditFilePath 时快速返回 undefined
 * 2. 按复合操作符（&&/||/;/|）分割为子命令
 * 3. 仅处理 FILE_COMMANDS 白名单中的命令
 * 4. 提取非 flag 参数（不以 '-' 开头）的扩展名
 * 5. 多个不同扩展名以 ',' 连接，去重（Set）
 *
 * 不做完整 shell 解析（无需重型解析，grep 模式和 sed 脚本很少像文件扩展名）。
 *
 * @param command - Bash 命令字符串
 * @param simulatedSedEditFilePath - 可选的模拟 sed 编辑目标路径
 * @returns 逗号分隔的扩展名字符串，无结果返回 undefined
 */
export function getFileExtensionsFromBashCommand(
  command: string,
  simulatedSedEditFilePath?: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS | undefined {
  // 快速退出：无 '.' 且无额外路径
  if (!command.includes('.') && !simulatedSedEditFilePath) return undefined

  let result: string | undefined
  const seen = new Set<string>()

  // 先处理 simulatedSedEditFilePath（模拟 sed 编辑的目标文件）
  if (simulatedSedEditFilePath) {
    const ext = getFileExtensionForAnalytics(simulatedSedEditFilePath)
    if (ext) {
      seen.add(ext)
      result = ext
    }
  }

  // 按复合操作符分割，处理每个子命令
  for (const subcmd of command.split(COMPOUND_OPERATOR_REGEX)) {
    if (!subcmd) continue
    const tokens = subcmd.split(WHITESPACE_REGEX)
    if (tokens.length < 2) continue

    // 提取基础命令名（忽略路径前缀，如 /usr/bin/cat → cat）
    const firstToken = tokens[0]!
    const slashIdx = firstToken.lastIndexOf('/')
    const baseCmd = slashIdx >= 0 ? firstToken.slice(slashIdx + 1) : firstToken
    // 仅处理 FILE_COMMANDS 白名单中的命令
    if (!FILE_COMMANDS.has(baseCmd)) continue

    for (let i = 1; i < tokens.length; i++) {
      const arg = tokens[i]!
      // 跳过 flag 参数（以 '-' 开头，charCode 45）
      if (arg.charCodeAt(0) === 45 /* - */) continue
      const ext = getFileExtensionForAnalytics(arg)
      if (ext && !seen.has(ext)) {
        seen.add(ext)
        // 多个扩展名以 ',' 连接
        result = result ? result + ',' + ext : ext
      }
    }
  }

  if (!result) return undefined
  return result as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * 环境上下文元数据类型
 *
 * 包含所有分析系统需要的平台/运行时/部署环境信息。
 * 所有字段均为可选（除核心必填字段外），缺失字段不写入 1P proto。
 */
export type EnvContext = {
  platform: string
  platformRaw: string
  arch: string
  nodeVersion: string
  terminal: string | null
  packageManagers: string
  runtimes: string
  isRunningWithBun: boolean
  isCi: boolean
  isClaubbit: boolean
  isClaudeCodeRemote: boolean
  isLocalAgentMode: boolean
  isConductor: boolean
  remoteEnvironmentType?: string
  coworkerType?: string
  claudeCodeContainerId?: string
  claudeCodeRemoteSessionId?: string
  tags?: string
  isGithubAction: boolean
  isClaudeCodeAction: boolean
  isClaudeAiAuth: boolean
  version: string
  versionBase?: string
  buildTime: string
  deploymentEnvironment: string
  githubEventName?: string
  githubActionsRunnerEnvironment?: string
  githubActionsRunnerOs?: string
  githubActionRef?: string
  wslVersion?: string
  linuxDistroId?: string
  linuxDistroVersion?: string
  linuxKernel?: string
  vcs?: string
}

/**
 * 进程指标类型（所有事件均携带）
 *
 * 包含内存用量、CPU 时间、进程启动时间等运行时诊断信息。
 * cpuPercent 为可选（首次调用时无法计算增量）。
 */
export type ProcessMetrics = {
  uptime: number
  rss: number
  heapTotal: number
  heapUsed: number
  external: number
  arrayBuffers: number
  constrainedMemory: number | undefined
  cpuUsage: NodeJS.CpuUsage
  cpuPercent: number | undefined
}

/**
 * 所有分析系统共享的核心事件元数据类型
 *
 * 包含模型名、会话 ID、用户类型、环境上下文、Agent 标识等。
 * rh: 仓库远端 URL 的 SHA256 前 16 字符哈希，用于与服务端仓库捆绑数据关联。
 * kairosActive: KAIROS 助手模式激活状态（ant only）。
 * skillMode: 技能发现/辅导机制开关状态（ant only，用于 BQ 会话分段）。
 * observerMode: 观察者分类器开关状态（ant only，用于 BQ 队列分割）。
 */
export type EventMetadata = {
  model: string
  sessionId: string
  userType: string
  betas?: string
  envContext: EnvContext
  entrypoint?: string
  agentSdkVersion?: string
  isInteractive: string
  clientType: string
  processMetrics?: ProcessMetrics
  sweBenchRunId: string
  sweBenchInstanceId: string
  sweBenchTaskId: string
  // Swarm/team agent identification for analytics attribution
  agentId?: string // CLAUDE_CODE_AGENT_ID (format: agentName@teamName) or subagent UUID
  parentSessionId?: string // CLAUDE_CODE_PARENT_SESSION_ID (team lead's session)
  agentType?: 'teammate' | 'subagent' | 'standalone' // Distinguishes swarm teammates, Agent tool subagents, and standalone agents
  teamName?: string // Team name for swarm agents (from env var or AsyncLocalStorage)
  subscriptionType?: string // OAuth subscription tier (max, pro, enterprise, team)
  rh?: string // Hashed repo remote URL (first 16 chars of SHA256), for joining with server-side data
  kairosActive?: true // KAIROS assistant mode active (ant-only; set in main.tsx after gate check)
  skillMode?: 'discovery' | 'coach' | 'discovery_and_coach' // Which skill surfacing mechanism(s) are gated on (ant-only; for BQ session segmentation)
  observerMode?: 'backseat' | 'skillcoach' | 'both' // Which observer classifiers are gated on (ant-only; for BQ cohort splits on tengu_backseat_* events)
}

/**
 * 元数据富化选项
 *
 * model: 指定模型名，若未提供则回退到 getMainLoopModel()
 * betas: 已 join 的 betas 字符串（若未提供则从模型配置获取）
 * additionalMetadata: 附加的自定义元数据
 */
export type EnrichMetadataOptions = {
  // Model to use, falls back to getMainLoopModel() if not provided
  model?: unknown
  // Explicit betas string (already joined)
  betas?: unknown
  // Additional metadata to include (optional)
  additionalMetadata?: Record<string, unknown>
}

/**
 * 获取 analytics 事件的 Agent 标识信息
 *
 * 优先级：AsyncLocalStorage（同进程子 agent）> 环境变量（swarm 团队 agent）
 *
 * - AsyncLocalStorage 适用于通过 Agent 工具启动的子 agent（同进程内）
 * - 环境变量（CLAUDE_CODE_AGENT_ID 等）适用于 swarm 模式下的团队 agent（独立进程）
 * - bootstrap state 中的 parentSessionId 适用于 plan 模式 → 实现阶段的跨会话关联
 */
function getAgentIdentification(): {
  agentId?: string
  parentSessionId?: string
  agentType?: 'teammate' | 'subagent' | 'standalone'
  teamName?: string
} {
  // 优先检查 AsyncLocalStorage（同进程子 agent）
  const agentContext = getAgentContext()
  if (agentContext) {
    const result: ReturnType<typeof getAgentIdentification> = {
      agentId: agentContext.agentId,
      parentSessionId: agentContext.parentSessionId,
      agentType: agentContext.agentType,
    }
    // 只有 teammate 类型的 agent 有 teamName
    if (agentContext.agentType === 'teammate') {
      result.teamName = agentContext.teamName
    }
    return result
  }

  // 回退：环境变量（swarm 团队 agent）
  const agentId = getAgentId()
  const parentSessionId = getTeammateParentSessionId()
  const teamName = getTeamName()
  const isSwarmAgent = isTeammate()
  // 有 agentId 但不是 teammate 的为 standalone
  const agentType = isSwarmAgent
    ? ('teammate' as const)
    : agentId
      ? ('standalone' as const)
      : undefined
  if (agentId || agentType || parentSessionId || teamName) {
    return {
      ...(agentId ? { agentId } : {}),
      ...(agentType ? { agentType } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(teamName ? { teamName } : {}),
    }
  }

  // 最终回退：bootstrap state 中的 parentSessionId（plan 模式跨会话关联）
  const stateParentSessionId = getParentSessionIdFromState()
  if (stateParentSessionId) {
    return { parentSessionId: stateParentSessionId }
  }

  return {}
}

/**
 * 从完整版本字符串提取基础版本号（memoized）
 *
 * 示例："2.0.36-dev.20251107.t174150.sha2709699" → "2.0.36-dev"
 * 格式：{major}.{minor}.{patch}[-{channel}]
 */
const getVersionBase = memoize((): string | undefined => {
  const match = MACRO.VERSION.match(/^\d+\.\d+\.\d+(?:-[a-z]+)?/)
  return match ? match[0] : undefined
})

/**
 * 构建环境上下文对象（memoized，只构建一次）
 *
 * 并发异步收集：package managers、runtimes、Linux 发行版信息、VCS 信息
 * 通过 Promise.all 并发执行，最小化启动延迟。
 *
 * 注意：
 * - buildEnvContext() 在第一次调用后 memoize，后续调用直接返回缓存 Promise
 * - kairosActive 不在此缓存（main.tsx 中 setKairosActive() 在 memoize 之后运行，
 *   需在每个事件时动态读取）
 * - platformRaw 使用 process.platform 而非 getHostPlatformForAnalytics()，
 *   保留 freebsd/openbsd 等原始平台信息（getHostPlatformForAnalytics 会将它们桶化为 'linux'）
 * - coworkerType 通过 feature gate（COWORKER_TYPE_TELEMETRY）控制，防止字符串在外部构建中泄露
 */
const buildEnvContext = memoize(async (): Promise<EnvContext> => {
  // 并发异步收集环境信息（最小化启动延迟）
  const [packageManagers, runtimes, linuxDistroInfo, vcs] = await Promise.all([
    env.getPackageManagers(),
    env.getRuntimes(),
    getLinuxDistroInfo(),
    detectVcs(),
  ])

  return {
    platform: getHostPlatformForAnalytics(),
    // Raw process.platform so freebsd/openbsd/aix/sunos are visible in BQ.
    // getHostPlatformForAnalytics() buckets those into 'linux'; here we want
    // the truth. CLAUDE_CODE_HOST_PLATFORM still overrides for container/remote.
    platformRaw: process.env.CLAUDE_CODE_HOST_PLATFORM || process.platform,
    arch: env.arch,
    nodeVersion: env.nodeVersion,
    terminal: envDynamic.terminal,
    packageManagers: packageManagers.join(','),
    runtimes: runtimes.join(','),
    isRunningWithBun: env.isRunningWithBun(),
    isCi: isEnvTruthy(process.env.CI),
    isClaubbit: isEnvTruthy(process.env.CLAUBBIT),
    isClaudeCodeRemote: isEnvTruthy(process.env.CLAUDE_CODE_REMOTE),
    isLocalAgentMode: process.env.CLAUDE_CODE_ENTRYPOINT === 'local-agent',
    isConductor: env.isConductor(),
    ...(process.env.CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE && {
      remoteEnvironmentType: process.env.CLAUDE_CODE_REMOTE_ENVIRONMENT_TYPE,
    }),
    // coworkerType 通过 feature gate 控制，防止字符串在外部构建中泄露
    ...(feature('COWORKER_TYPE_TELEMETRY')
      ? process.env.CLAUDE_CODE_COWORKER_TYPE
        ? { coworkerType: process.env.CLAUDE_CODE_COWORKER_TYPE }
        : {}
      : {}),
    ...(process.env.CLAUDE_CODE_CONTAINER_ID && {
      claudeCodeContainerId: process.env.CLAUDE_CODE_CONTAINER_ID,
    }),
    ...(process.env.CLAUDE_CODE_REMOTE_SESSION_ID && {
      claudeCodeRemoteSessionId: process.env.CLAUDE_CODE_REMOTE_SESSION_ID,
    }),
    ...(process.env.CLAUDE_CODE_TAGS && {
      tags: process.env.CLAUDE_CODE_TAGS,
    }),
    isGithubAction: isEnvTruthy(process.env.GITHUB_ACTIONS),
    isClaudeCodeAction: isEnvTruthy(process.env.CLAUDE_CODE_ACTION),
    isClaudeAiAuth: isClaudeAISubscriber(),
    version: MACRO.VERSION,
    versionBase: getVersionBase(),
    buildTime: MACRO.BUILD_TIME,
    deploymentEnvironment: env.detectDeploymentEnvironment(),
    // GitHub Actions 专用字段（仅在 GITHUB_ACTIONS=true 时添加）
    ...(isEnvTruthy(process.env.GITHUB_ACTIONS) && {
      githubEventName: process.env.GITHUB_EVENT_NAME,
      githubActionsRunnerEnvironment: process.env.RUNNER_ENVIRONMENT,
      githubActionsRunnerOs: process.env.RUNNER_OS,
      // 提取 claude-code-action/ 后的相对路径作为 action ref
      githubActionRef: process.env.GITHUB_ACTION_PATH?.includes(
        'claude-code-action/',
      )
        ? process.env.GITHUB_ACTION_PATH.split('claude-code-action/')[1]
        : undefined,
    }),
    ...(getWslVersion() && { wslVersion: getWslVersion() }),
    ...(linuxDistroInfo ?? {}),
    ...(vcs.length > 0 ? { vcs: vcs.join(',') } : {}),
  }
})

// --
// CPU% 增量追踪 — 进程全局状态（同 datadog.ts 中的 logBatch/flushTimer 模式）
let prevCpuUsage: NodeJS.CpuUsage | null = null
let prevWallTimeMs: number | null = null

/**
 * 构建进程指标对象（所有用户均记录）
 *
 * 计算 CPU 百分比（user+system delta / wall time delta × 100）：
 * - 首次调用无法计算增量（prevCpuUsage/prevWallTimeMs 为 null），cpuPercent 为 undefined
 * - 后续调用计算两次调用间的 CPU 使用率增量
 * 所有异常静默捕获（process.memoryUsage/cpuUsage 在某些环境下可能不可用）。
 */
function buildProcessMetrics(): ProcessMetrics | undefined {
  try {
    const mem = process.memoryUsage()
    const cpu = process.cpuUsage()
    const now = Date.now()

    let cpuPercent: number | undefined
    if (prevCpuUsage && prevWallTimeMs) {
      const wallDeltaMs = now - prevWallTimeMs
      if (wallDeltaMs > 0) {
        const userDeltaUs = cpu.user - prevCpuUsage.user
        const systemDeltaUs = cpu.system - prevCpuUsage.system
        // CPU% = (user+system 微秒增量) / (wall time 微秒总量) × 100
        cpuPercent =
          ((userDeltaUs + systemDeltaUs) / (wallDeltaMs * 1000)) * 100
      }
    }
    // 更新上次采样值
    prevCpuUsage = cpu
    prevWallTimeMs = now

    return {
      uptime: process.uptime(),
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      constrainedMemory: process.constrainedMemory(),
      cpuUsage: cpu,
      cpuPercent,
    }
  } catch {
    return undefined
  }
}

/**
 * 获取所有分析系统共享的核心事件元数据
 *
 * 并发执行：
 * - buildEnvContext()：构建环境上下文（memoized，只执行一次）
 * - getRepoRemoteHash()：计算仓库远端 URL 的 SHA256 前 16 字符
 *
 * 注意：
 * - kairosActive 在 buildEnvContext() 之外动态读取（setKairosActive 在 memoize 之后运行）
 * - agentIdentification 同时支持 AsyncLocalStorage（子 agent）和环境变量（swarm agent）
 * - processMetrics 始终收集（不受用户类型限制）
 *
 * @param options - 可选的模型名、betas 字符串、附加元数据
 * @returns 富化后的 EventMetadata 对象
 */
export async function getEventMetadata(
  options: EnrichMetadataOptions = {},
): Promise<EventMetadata> {
  // 解析模型名：优先使用传入值，回退到全局主循环模型
  const model = options.model ? String(options.model) : getMainLoopModel()
  // 解析 betas：优先使用传入字符串，回退到从模型配置获取并 join
  const betas =
    typeof options.betas === 'string'
      ? options.betas
      : getModelBetas(model).join(',')
  // 并发收集环境上下文和仓库 hash
  const [envContext, repoRemoteHash] = await Promise.all([
    buildEnvContext(),
    getRepoRemoteHash(),
  ])
  const processMetrics = buildProcessMetrics()

  const metadata: EventMetadata = {
    model,
    sessionId: getSessionId(),
    userType: process.env.USER_TYPE || '',
    ...(betas.length > 0 ? { betas: betas } : {}),
    envContext,
    ...(process.env.CLAUDE_CODE_ENTRYPOINT && {
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT,
    }),
    ...(process.env.CLAUDE_AGENT_SDK_VERSION && {
      agentSdkVersion: process.env.CLAUDE_AGENT_SDK_VERSION,
    }),
    isInteractive: String(getIsInteractive()),
    clientType: getClientType(),
    ...(processMetrics && { processMetrics }),
    sweBenchRunId: process.env.SWE_BENCH_RUN_ID || '',
    sweBenchInstanceId: process.env.SWE_BENCH_INSTANCE_ID || '',
    sweBenchTaskId: process.env.SWE_BENCH_TASK_ID || '',
    // Swarm/team agent identification
    // Priority: AsyncLocalStorage context (subagents) > env vars (swarm teammates)
    ...getAgentIdentification(),
    // Subscription tier for DAU-by-tier analytics
    ...(getSubscriptionType() && {
      subscriptionType: getSubscriptionType()!,
    }),
    // kairosActive 在 buildEnvContext memoize 之外动态读取（setKairosActive 在 memoize 后运行）
    ...(feature('KAIROS') && getKairosActive()
      ? { kairosActive: true as const }
      : {}),
    // 仓库远端 hash，用于与服务端仓库捆绑数据关联
    ...(repoRemoteHash && { rh: repoRemoteHash }),
  }

  return metadata
}


/**
 * 1P 事件日志核心元数据类型（snake_case 格式）
 *
 * 对应 ClaudeCodeInternalEvent proto 的顶层字段。
 * 这些字段直接导出到 BigQuery 的独立列（不是 additional_metadata JSON blob）。
 */
export type FirstPartyEventLoggingCoreMetadata = {
  session_id: string
  model: string
  user_type: string
  betas?: string
  entrypoint?: string
  agent_sdk_version?: string
  is_interactive: boolean
  client_type: string
  swe_bench_run_id?: string
  swe_bench_instance_id?: string
  swe_bench_task_id?: string
  // Swarm/team agent identification
  agent_id?: string
  parent_session_id?: string
  agent_type?: 'teammate' | 'subagent' | 'standalone'
  team_name?: string
}

/**
 * 1P 事件日志完整元数据格式类型
 *
 * 结构说明：
 * - env: 环境元数据（proto-typed EnvironmentMetadata，写入失误会产生编译错误）
 * - process: base64 编码的进程指标 JSON（可选）
 * - auth: 用户认证信息（仅含 UUID 字段，不含 account_id）
 * - core: 核心字段（直接映射到 ClaudeCodeInternalEvent 顶层列）
 * - additional: 附加元数据（写入 additional_metadata JSON blob，包含事件特定字段）
 */
export type FirstPartyEventLoggingMetadata = {
  env: EnvironmentMetadata
  process?: string
  // auth is a top-level field on ClaudeCodeInternalEvent (proto PublicApiAuth).
  // account_id is intentionally omitted — only UUID fields are populated client-side.
  auth?: PublicApiAuth
  // core fields correspond to the top level of ClaudeCodeInternalEvent.
  // They get directly exported to their individual columns in the BigQuery tables
  core: FirstPartyEventLoggingCoreMetadata
  // additional fields are populated in the additional_metadata field of the
  // ClaudeCodeInternalEvent proto. Includes but is not limited to information
  // that differs by event type.
  additional: Record<string, unknown>
}

/**
 * 将 EventMetadata 转换为 1P 事件日志格式（snake_case）
 *
 * /api/event_logging/batch 端点期望 snake_case 字段名。
 * 此函数将 camelCase EventMetadata 转换为 proto-typed EnvironmentMetadata。
 *
 * 关键设计：
 * - env 类型为 proto 生成的 EnvironmentMetadata，添加未定义字段会产生编译错误
 *   （生成的 toJSON() 序列化器会静默丢弃未知键；手写的并行类型曾导致 #11318/#13924/#19448 等
 *    字段多次漏报 BQ，此 proto-typed 设计从根本上杜绝此类问题）
 * - processMetrics 序列化为 base64 编码的 JSON 字符串（避免 proto 字段膨胀）
 * - auth 仅包含 UUID 字段（account_id 客户端侧不填充）
 * - additional 包含 rh/kairosActive/skillMode/observerMode 等不在 core/env 中的字段
 * - GitHub Actions 元数据（camelCase → snake_case）写入 env.github_actions_metadata
 *
 * 添加新字段时：先更新 monorepo proto（go/cc-logging），再执行 `bun run generate:proto`。
 *
 * @param metadata - 核心事件元数据
 * @param userMetadata - 用户数据（GitHub Actions metadata、UUID 等）
 * @param additionalMetadata - 附加的自定义元数据
 * @returns 1P 事件日志格式的元数据
 */
export function to1PEventFormat(
  metadata: EventMetadata,
  userMetadata: CoreUserData,
  additionalMetadata: Record<string, unknown> = {},
): FirstPartyEventLoggingMetadata {
  const {
    envContext,
    processMetrics,
    rh,
    kairosActive,
    skillMode,
    observerMode,
    ...coreFields
  } = metadata

  // Convert envContext to snake_case.
  // IMPORTANT: env is typed as the proto-generated EnvironmentMetadata so that
  // adding a field here that the proto doesn't define is a compile error. The
  // generated toJSON() serializer silently drops unknown keys — a hand-written
  // parallel type previously let #11318, #13924, #19448, and coworker_type all
  // ship fields that never reached BQ.
  // Adding a field? Update the monorepo proto first (go/cc-logging):
  //   event_schemas/.../claude_code/v1/claude_code_internal_event.proto
  // then run `bun run generate:proto` here.
  const env: EnvironmentMetadata = {
    platform: envContext.platform,
    platform_raw: envContext.platformRaw,
    arch: envContext.arch,
    node_version: envContext.nodeVersion,
    terminal: envContext.terminal || 'unknown',
    package_managers: envContext.packageManagers,
    runtimes: envContext.runtimes,
    is_running_with_bun: envContext.isRunningWithBun,
    is_ci: envContext.isCi,
    is_claubbit: envContext.isClaubbit,
    is_claude_code_remote: envContext.isClaudeCodeRemote,
    is_local_agent_mode: envContext.isLocalAgentMode,
    is_conductor: envContext.isConductor,
    is_github_action: envContext.isGithubAction,
    is_claude_code_action: envContext.isClaudeCodeAction,
    is_claude_ai_auth: envContext.isClaudeAiAuth,
    version: envContext.version,
    build_time: envContext.buildTime,
    deployment_environment: envContext.deploymentEnvironment,
  }

  // 添加可选 env 字段（仅在有值时写入，避免传递 undefined）
  if (envContext.remoteEnvironmentType) {
    env.remote_environment_type = envContext.remoteEnvironmentType
  }
  // coworkerType 通过 feature gate 控制（防止字符串在外部构建中泄露）
  if (feature('COWORKER_TYPE_TELEMETRY') && envContext.coworkerType) {
    env.coworker_type = envContext.coworkerType
  }
  if (envContext.claudeCodeContainerId) {
    env.claude_code_container_id = envContext.claudeCodeContainerId
  }
  if (envContext.claudeCodeRemoteSessionId) {
    env.claude_code_remote_session_id = envContext.claudeCodeRemoteSessionId
  }
  if (envContext.tags) {
    // tags 字符串按 ',' 分割并清理空白
    env.tags = envContext.tags
      .split(',')
      .map(t => t.trim())
      .filter(Boolean)
  }
  if (envContext.githubEventName) {
    env.github_event_name = envContext.githubEventName
  }
  if (envContext.githubActionsRunnerEnvironment) {
    env.github_actions_runner_environment =
      envContext.githubActionsRunnerEnvironment
  }
  if (envContext.githubActionsRunnerOs) {
    env.github_actions_runner_os = envContext.githubActionsRunnerOs
  }
  if (envContext.githubActionRef) {
    env.github_action_ref = envContext.githubActionRef
  }
  if (envContext.wslVersion) {
    env.wsl_version = envContext.wslVersion
  }
  if (envContext.linuxDistroId) {
    env.linux_distro_id = envContext.linuxDistroId
  }
  if (envContext.linuxDistroVersion) {
    env.linux_distro_version = envContext.linuxDistroVersion
  }
  if (envContext.linuxKernel) {
    env.linux_kernel = envContext.linuxKernel
  }
  if (envContext.vcs) {
    env.vcs = envContext.vcs
  }
  if (envContext.versionBase) {
    env.version_base = envContext.versionBase
  }

  // 构建 core 字段（camelCase → snake_case）
  const core: FirstPartyEventLoggingCoreMetadata = {
    session_id: coreFields.sessionId,
    model: coreFields.model,
    user_type: coreFields.userType,
    is_interactive: coreFields.isInteractive === 'true',
    client_type: coreFields.clientType,
  }

  // 添加可选 core 字段
  if (coreFields.betas) {
    core.betas = coreFields.betas
  }
  if (coreFields.entrypoint) {
    core.entrypoint = coreFields.entrypoint
  }
  if (coreFields.agentSdkVersion) {
    core.agent_sdk_version = coreFields.agentSdkVersion
  }
  if (coreFields.sweBenchRunId) {
    core.swe_bench_run_id = coreFields.sweBenchRunId
  }
  if (coreFields.sweBenchInstanceId) {
    core.swe_bench_instance_id = coreFields.sweBenchInstanceId
  }
  if (coreFields.sweBenchTaskId) {
    core.swe_bench_task_id = coreFields.sweBenchTaskId
  }
  // Swarm/team agent identification（camelCase → snake_case）
  if (coreFields.agentId) {
    core.agent_id = coreFields.agentId
  }
  if (coreFields.parentSessionId) {
    core.parent_session_id = coreFields.parentSessionId
  }
  if (coreFields.agentType) {
    core.agent_type = coreFields.agentType
  }
  if (coreFields.teamName) {
    core.team_name = coreFields.teamName
  }

  // Map userMetadata to output fields.
  // Based on src/utils/user.ts getUser(), but with fields present in other
  // parts of ClaudeCodeInternalEvent deduplicated.
  // Convert camelCase GitHubActionsMetadata to snake_case for 1P API
  // Note: github_actions_metadata is placed inside env (EnvironmentMetadata)
  // rather than at the top level of ClaudeCodeInternalEvent
  if (userMetadata.githubActionsMetadata) {
    // GitHub Actions 元数据写入 env.github_actions_metadata（camelCase → snake_case）
    const ghMeta = userMetadata.githubActionsMetadata
    env.github_actions_metadata = {
      actor_id: ghMeta.actorId,
      repository_id: ghMeta.repositoryId,
      repository_owner_id: ghMeta.repositoryOwnerId,
    }
  }

  // auth 仅含 UUID 字段（account_id 客户端侧不填充）
  let auth: PublicApiAuth | undefined
  if (userMetadata.accountUuid || userMetadata.organizationUuid) {
    auth = {
      account_uuid: userMetadata.accountUuid,
      organization_uuid: userMetadata.organizationUuid,
    }
  }

  return {
    env,
    // processMetrics 序列化为 base64 JSON（避免 proto 字段膨胀）
    ...(processMetrics && {
      process: Buffer.from(jsonStringify(processMetrics)).toString('base64'),
    }),
    ...(auth && { auth }),
    core,
    additional: {
      // rh/kairosActive/skillMode/observerMode 写入 additional_metadata（不在 core/env 中）
      ...(rh && { rh }),
      ...(kairosActive && { is_assistant_mode: true }),
      ...(skillMode && { skill_mode: skillMode }),
      ...(observerMode && { observer_mode: observerMode }),
      ...additionalMetadata,
    },
  }
}
