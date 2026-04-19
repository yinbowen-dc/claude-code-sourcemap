/**
 * Prompt 缓存断裂检测模块（Prompt Cache Break Detection）
 *
 * 在 Claude Code 系统流程中的位置：
 *   每次 API 调用前 → recordPromptState() 记录当前 prompt/工具状态（阶段一）
 *   每次 API 调用后 → checkResponseForCacheBreak() 对比缓存读取令牌数，判断是否发生断裂（阶段二）
 *   断裂事件 → 上报 tengu_prompt_cache_break 分析事件 + 写入 diff 文件（供调试）
 *
 * 主要功能：
 *  - recordPromptState           — 阶段一：记录 prompt/工具/模型状态，检测变更点
 *  - checkResponseForCacheBreak  — 阶段二：检测缓存读取令牌下降，上报断裂事件
 *  - notifyCacheDeletion         — 通知后续响应的缓存读取令牌下降是预期行为（cached microcompact 删除）
 *  - notifyCompaction            — 通知压缩后缓存基线重置
 *  - cleanupAgentTracking        — 清理特定 Agent 的追踪状态
 *  - resetPromptCacheBreakDetection — 清空所有追踪状态（用于测试/重置）
 *
 * 设计特点：
 *  - 两阶段检测：阶段一记录变更，阶段二结合 API 响应令牌数判断是否真的断裂
 *  - 按 querySource + agentId 分隔追踪状态（最多 MAX_TRACKED_SOURCES = 10 个条目）
 *  - 排除 haiku 模型（不同的缓存行为）
 *  - 断裂阈值：缓存读取令牌下降超过 5% 且绝对降幅超过 MIN_CACHE_MISS_TOKENS = 2000
 *  - 工具名脱敏：MCP 工具名统一替换为 'mcp'（用户配置，可能泄露路径）
 */

import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { createPatch } from 'diff'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { AgentId } from 'src/types/ids.js'
import type { Message } from 'src/types/message.js'
import { logForDebugging } from 'src/utils/debug.js'
import { djb2Hash } from 'src/utils/hash.js'
import { logError } from 'src/utils/log.js'
import { getClaudeTempDir } from 'src/utils/permissions/filesystem.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import type { QuerySource } from '../../constants/querySource.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'

/**
 * 生成缓存断裂 diff 文件的随机路径。
 * 文件名格式：cache-break-XXXX.diff（4 位随机字母数字后缀）。
 */
function getCacheBreakDiffPath(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let suffix = ''
  // 生成 4 位随机字符，构成唯一文件名后缀
  for (let i = 0; i < 4; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)]
  }
  return join(getClaudeTempDir(), `cache-break-${suffix}.diff`)
}

/** 某一 querySource 的追踪状态（上一次调用的 prompt/工具状态） */
type PreviousState = {
  systemHash: number
  toolsHash: number
  /** 含 cache_control 的系统块哈希。捕获 scope/TTL 翻转（global↔org, 1h↔5m），
   *  这些翻转在 stripCacheControl 后的 systemHash 中不可见。 */
  cacheControlHash: number
  toolNames: string[]
  /** 按工具名存储各工具的 schema 哈希。用于在 toolSchemasChanged 但工具数量不变时
   *  定位具体哪个工具的 description/schema 发生了变化（BQ 2026-03-22 数据：77% 的工具断裂属于此类）。 */
  perToolHashes: Record<string, number>
  systemCharCount: number
  model: string
  fastMode: boolean
  /** 全局缓存策略：'tool_based' | 'system_prompt' | 'none'，MCP 工具发现/移除时翻转 */
  globalCacheStrategy: string
  /** 已排序的 beta 请求头列表，用于显示哪些 beta 被添加/删除 */
  betas: string[]
  /** AFK_MODE_BETA_HEADER 是否存在（应已不再导致缓存断裂，追踪用于验证修复效果） */
  autoModeActive: boolean
  /** 超额状态翻转（已锁定为会话稳定，不应再导致缓存断裂，追踪用于验证） */
  isUsingOverage: boolean
  /** cached microcompact beta 是否存在（已锁定为 sticky-on，追踪用于验证） */
  cachedMCEnabled: boolean
  /** 解析后的 effort 值（来自 env/options/模型默认值） */
  effortValue: string
  /** getExtraBodyParams() 的哈希，捕获 CLAUDE_CODE_EXTRA_BODY 和 anthropic_internal 变化 */
  extraBodyHash: number
  callCount: number
  pendingChanges: PendingChanges | null
  prevCacheReadTokens: number | null
  /** 为 true 时表示 cached microcompact 发送了 cache_edits 删除操作，
   *  下一次响应的缓存读取令牌下降是预期行为，不算断裂 */
  cacheDeletionsPending: boolean
  buildDiffableContent: () => string
}

/** 本次调用与上一次调用之间检测到的变更信息（用于阶段二解释断裂原因） */
type PendingChanges = {
  systemPromptChanged: boolean
  toolSchemasChanged: boolean
  modelChanged: boolean
  fastModeChanged: boolean
  cacheControlChanged: boolean
  globalCacheStrategyChanged: boolean
  betasChanged: boolean
  autoModeChanged: boolean
  overageChanged: boolean
  cachedMCChanged: boolean
  effortChanged: boolean
  extraBodyChanged: boolean
  addedToolCount: number
  removedToolCount: number
  systemCharDelta: number
  addedTools: string[]
  removedTools: string[]
  changedToolSchemas: string[]
  previousModel: string
  newModel: string
  prevGlobalCacheStrategy: string
  newGlobalCacheStrategy: string
  addedBetas: string[]
  removedBetas: string[]
  prevEffortValue: string
  newEffortValue: string
  buildPrevDiffableContent: () => string
}

// 按 querySource（或 agentId）分隔的追踪状态 Map
const previousStateBySource = new Map<string, PreviousState>()

// 限制追踪条目数量上限，防止内存无限增长。
// 每个条目存储约 300KB+ 的 diffableContent（序列化后的系统 prompt + 工具 schema）。
// 若不设上限，大量子 Agent（每个有唯一 agentId）会导致 Map 无限膨胀。
const MAX_TRACKED_SOURCES = 10

// 需要追踪的 querySource 前缀列表（其他来源不追踪，如 speculation、session_memory 等短命 Agent）
const TRACKED_SOURCE_PREFIXES = [
  'repl_main_thread',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
]

// 触发缓存断裂告警的最小绝对令牌降幅。
// 小幅下降（如几千个令牌）可能由正常波动引起，不值得告警。
const MIN_CACHE_MISS_TOKENS = 2_000

// Anthropic 服务端 prompt 缓存 TTL 阈值，用于判断断裂是否由 TTL 过期引起
const CACHE_TTL_5MIN_MS = 5 * 60 * 1000
export const CACHE_TTL_1HOUR_MS = 60 * 60 * 1000

/** 判断是否为排除的模型（如 haiku 缓存行为不同，不做断裂检测） */
function isExcludedModel(model: string): boolean {
  return model.includes('haiku')
}

/**
 * 返回 querySource 对应的追踪键，无法追踪则返回 null。
 *
 * compact 与 repl_main_thread 共享同一服务端缓存（相同的 cacheSafeParams），
 * 因此映射到同一追踪键。
 *
 * 对于有 agentId 的子 Agent，使用 agentId 隔离追踪状态，
 * 防止同类型 Agent 并发运行时互相干扰（误报缓存断裂）。
 *
 * 不追踪的来源（speculation、session_memory、prompt_suggestion 等）是短命的 fork Agent，
 * 每次运行 1-3 轮且 agentId 不同，缓存断裂检测对其没有意义。
 * 其缓存指标仍通过 tengu_api_success 记录用于分析。
 */
function getTrackingKey(
  querySource: QuerySource,
  agentId?: AgentId,
): string | null {
  // compact 与主线程共享缓存，映射到相同追踪键
  if (querySource === 'compact') return 'repl_main_thread'
  for (const prefix of TRACKED_SOURCE_PREFIXES) {
    // 前缀匹配：使用 agentId（如果有）作为唯一追踪键，否则使用 querySource
    if (querySource.startsWith(prefix)) return agentId || querySource
  }
  return null // 不在追踪范围内的 querySource
}

/**
 * 从对象数组中剥离 cache_control 字段，用于计算不含缓存控制的哈希。
 * 这样系统文本内容变化和 cache_control 变化可以分开检测。
 */
function stripCacheControl(
  items: ReadonlyArray<Record<string, unknown>>,
): unknown[] {
  return items.map(item => {
    if (!('cache_control' in item)) return item
    // 解构剔除 cache_control，返回剩余字段
    const { cache_control: _, ...rest } = item
    return rest
  })
}

/**
 * 计算任意数据的哈希值（整数）。
 * Bun 环境使用 Bun.hash（性能更高），否则回退到 djb2Hash。
 */
function computeHash(data: unknown): number {
  const str = jsonStringify(data)
  if (typeof Bun !== 'undefined') {
    const hash = Bun.hash(str)
    // Bun.hash 对大输入可能返回 bigint，安全转换为 number
    return typeof hash === 'bigint' ? Number(hash & 0xffffffffn) : hash
  }
  // 非 Bun 运行时（如 npm 全局安装的 Node.js）回退到 djb2
  return djb2Hash(str)
}

/** 脱敏工具名：MCP 工具名折叠为 'mcp'（用户配置，可能泄露路径）；内置工具名保留 */
function sanitizeToolName(name: string): string {
  return name.startsWith('mcp__') ? 'mcp' : name
}

/**
 * 计算各工具的 schema 哈希，以工具名为键。
 * 仅在聚合哈希（toolsHash）发生变化时调用，避免不必要的序列化开销。
 */
function computePerToolHashes(
  strippedTools: ReadonlyArray<unknown>,
  names: string[],
): Record<string, number> {
  const hashes: Record<string, number> = {}
  for (let i = 0; i < strippedTools.length; i++) {
    // 工具名缺失时用索引作为回退键
    hashes[names[i] ?? `__idx_${i}`] = computeHash(strippedTools[i])
  }
  return hashes
}

/** 计算系统 prompt 的总字符数（用于在断裂报告中显示字符变化量） */
function getSystemCharCount(system: TextBlockParam[]): number {
  let total = 0
  for (const block of system) {
    total += block.text.length
  }
  return total
}

/**
 * 将系统 prompt 和工具 schema 序列化为可读的 diff 格式字符串。
 * 工具按名称排序，确保 diff 结果稳定（不受参数顺序影响）。
 */
function buildDiffableContent(
  system: TextBlockParam[],
  tools: BetaToolUnion[],
  model: string,
): string {
  const systemText = system.map(b => b.text).join('\n\n')
  const toolDetails = tools
    .map(t => {
      if (!('name' in t)) return 'unknown'
      const desc = 'description' in t ? t.description : ''
      const schema = 'input_schema' in t ? jsonStringify(t.input_schema) : ''
      return `${t.name}\n  description: ${desc}\n  input_schema: ${schema}`
    })
    .sort() // 排序确保 diff 稳定
    .join('\n\n')
  return `Model: ${model}\n\n=== System Prompt ===\n\n${systemText}\n\n=== Tools (${tools.length}) ===\n\n${toolDetails}\n`
}

/** 扩展的追踪快照类型——包含所有可能影响服务端缓存键的客户端可观测字段。
 *  所有字段均为可选，方便调用方增量添加；未定义的字段视为未变化。 */
export type PromptStateSnapshot = {
  system: TextBlockParam[]
  toolSchemas: BetaToolUnion[]
  querySource: QuerySource
  model: string
  agentId?: AgentId
  fastMode?: boolean
  globalCacheStrategy?: string
  betas?: readonly string[]
  autoModeActive?: boolean
  isUsingOverage?: boolean
  cachedMCEnabled?: boolean
  effortValue?: string | number
  extraBodyParams?: unknown
}

/**
 * 阶段一（API 调用前）：记录当前 prompt/工具状态，检测与上一次调用的变更点。
 *
 * 流程：
 *  1. 根据 querySource + agentId 计算追踪键，不在追踪范围内则直接返回
 *  2. 计算各维度哈希（系统 prompt、工具、cache_control、extraBody 等）
 *  3. 若无历史记录（首次调用）：初始化追踪状态
 *  4. 若有历史记录：逐字段对比，构建 PendingChanges（待决变更）供阶段二使用
 *  5. 若超出 MAX_TRACKED_SOURCES 上限：驱逐最旧条目后再插入
 *
 * 注意：此函数不触发任何事件——仅存储待决变更，由阶段二决定是否上报。
 */
export function recordPromptState(snapshot: PromptStateSnapshot): void {
  try {
    const {
      system,
      toolSchemas,
      querySource,
      model,
      agentId,
      fastMode,
      globalCacheStrategy = '',
      betas = [],
      autoModeActive = false,
      isUsingOverage = false,
      cachedMCEnabled = false,
      effortValue,
      extraBodyParams,
    } = snapshot
    // 获取追踪键，不在追踪范围内则跳过
    const key = getTrackingKey(querySource, agentId)
    if (!key) return

    // 剥离 cache_control，计算纯内容哈希
    const strippedSystem = stripCacheControl(
      system as unknown as ReadonlyArray<Record<string, unknown>>,
    )
    const strippedTools = stripCacheControl(
      toolSchemas as unknown as ReadonlyArray<Record<string, unknown>>,
    )

    const systemHash = computeHash(strippedSystem)
    const toolsHash = computeHash(strippedTools)
    // 包含 cache_control 的哈希：捕获 scope 翻转（global↔org/none）和 TTL 翻转（1h↔5m）
    // 这些变化在剥离 cache_control 后的哈希中不可见，但同样会导致服务端缓存断裂
    const cacheControlHash = computeHash(
      system.map(b => ('cache_control' in b ? b.cache_control : null)),
    )
    // 提取所有工具名（未知工具用 'unknown' 标记）
    const toolNames = toolSchemas.map(t => ('name' in t ? t.name : 'unknown'))
    // 懒计算各工具哈希（仅当聚合 toolsHash 变化时才实际计算，优化性能）
    const computeToolHashes = () =>
      computePerToolHashes(strippedTools, toolNames)
    const systemCharCount = getSystemCharCount(system)
    // 懒计算 diffable 内容（仅在需要写 diff 文件时才序列化）
    const lazyDiffableContent = () =>
      buildDiffableContent(system, toolSchemas, model)
    const isFastMode = fastMode ?? false
    const sortedBetas = [...betas].sort() // 排序保证哈希稳定
    const effortStr = effortValue === undefined ? '' : String(effortValue)
    // extraBodyParams 未定义时哈希为 0（视为无变化）
    const extraBodyHash =
      extraBodyParams === undefined ? 0 : computeHash(extraBodyParams)

    const prev = previousStateBySource.get(key)

    if (!prev) {
      // 首次调用：若 Map 已满，驱逐最旧条目（Map 按插入顺序迭代）
      while (previousStateBySource.size >= MAX_TRACKED_SOURCES) {
        const oldest = previousStateBySource.keys().next().value
        if (oldest !== undefined) previousStateBySource.delete(oldest)
      }

      // 初始化追踪状态（无 pendingChanges，无历史缓存令牌数）
      previousStateBySource.set(key, {
        systemHash,
        toolsHash,
        cacheControlHash,
        toolNames,
        systemCharCount,
        model,
        fastMode: isFastMode,
        globalCacheStrategy,
        betas: sortedBetas,
        autoModeActive,
        isUsingOverage,
        cachedMCEnabled,
        effortValue: effortStr,
        extraBodyHash,
        callCount: 1,
        pendingChanges: null,
        prevCacheReadTokens: null,
        cacheDeletionsPending: false,
        buildDiffableContent: lazyDiffableContent,
        perToolHashes: computeToolHashes(),
      })
      return
    }

    // 递增调用计数（用于断裂报告中的 callNumber 字段）
    prev.callCount++

    // 逐字段对比，检测各维度是否发生变化
    const systemPromptChanged = systemHash !== prev.systemHash
    const toolSchemasChanged = toolsHash !== prev.toolsHash
    const modelChanged = model !== prev.model
    const fastModeChanged = isFastMode !== prev.fastMode
    const cacheControlChanged = cacheControlHash !== prev.cacheControlHash
    const globalCacheStrategyChanged =
      globalCacheStrategy !== prev.globalCacheStrategy
    // beta 列表比较：长度不同或任一元素不同则视为变化
    const betasChanged =
      sortedBetas.length !== prev.betas.length ||
      sortedBetas.some((b, i) => b !== prev.betas[i])
    const autoModeChanged = autoModeActive !== prev.autoModeActive
    const overageChanged = isUsingOverage !== prev.isUsingOverage
    const cachedMCChanged = cachedMCEnabled !== prev.cachedMCEnabled
    const effortChanged = effortStr !== prev.effortValue
    const extraBodyChanged = extraBodyHash !== prev.extraBodyHash

    if (
      systemPromptChanged ||
      toolSchemasChanged ||
      modelChanged ||
      fastModeChanged ||
      cacheControlChanged ||
      globalCacheStrategyChanged ||
      betasChanged ||
      autoModeChanged ||
      overageChanged ||
      cachedMCChanged ||
      effortChanged ||
      extraBodyChanged
    ) {
      // 至少有一个字段变化：构建工具增删集合，用于生成详细的变更说明
      const prevToolSet = new Set(prev.toolNames)
      const newToolSet = new Set(toolNames)
      const prevBetaSet = new Set(prev.betas)
      const newBetaSet = new Set(sortedBetas)
      const addedTools = toolNames.filter(n => !prevToolSet.has(n))
      const removedTools = prev.toolNames.filter(n => !newToolSet.has(n))
      const changedToolSchemas: string[] = []
      if (toolSchemasChanged) {
        // 仅在聚合哈希变化时才计算各工具哈希，定位具体哪个工具 schema 发生了变化
        const newHashes = computeToolHashes()
        for (const name of toolNames) {
          if (!prevToolSet.has(name)) continue // 新增工具不算 schema 变化
          if (newHashes[name] !== prev.perToolHashes[name]) {
            changedToolSchemas.push(name)
          }
        }
        prev.perToolHashes = newHashes // 更新各工具哈希
      }
      // 记录待决变更，供阶段二（checkResponseForCacheBreak）使用
      prev.pendingChanges = {
        systemPromptChanged,
        toolSchemasChanged,
        modelChanged,
        fastModeChanged,
        cacheControlChanged,
        globalCacheStrategyChanged,
        betasChanged,
        autoModeChanged,
        overageChanged,
        cachedMCChanged,
        effortChanged,
        extraBodyChanged,
        addedToolCount: addedTools.length,
        removedToolCount: removedTools.length,
        addedTools,
        removedTools,
        changedToolSchemas,
        systemCharDelta: systemCharCount - prev.systemCharCount, // 系统 prompt 字符变化量
        previousModel: prev.model,
        newModel: model,
        prevGlobalCacheStrategy: prev.globalCacheStrategy,
        newGlobalCacheStrategy: globalCacheStrategy,
        addedBetas: sortedBetas.filter(b => !prevBetaSet.has(b)),
        removedBetas: prev.betas.filter(b => !newBetaSet.has(b)),
        prevEffortValue: prev.effortValue,
        newEffortValue: effortStr,
        buildPrevDiffableContent: prev.buildDiffableContent, // 保存上一次的序列化快照用于生成 diff
      }
    } else {
      // 所有字段均未变化：清除上一次的待决变更
      prev.pendingChanges = null
    }

    // 将当前状态写入追踪记录（覆盖旧值）
    prev.systemHash = systemHash
    prev.toolsHash = toolsHash
    prev.cacheControlHash = cacheControlHash
    prev.toolNames = toolNames
    prev.systemCharCount = systemCharCount
    prev.model = model
    prev.fastMode = isFastMode
    prev.globalCacheStrategy = globalCacheStrategy
    prev.betas = sortedBetas
    prev.autoModeActive = autoModeActive
    prev.isUsingOverage = isUsingOverage
    prev.cachedMCEnabled = cachedMCEnabled
    prev.effortValue = effortStr
    prev.extraBodyHash = extraBodyHash
    prev.buildDiffableContent = lazyDiffableContent
  } catch (e: unknown) {
    logError(e)
  }
}

/**
 * 阶段二（API 调用后）：根据响应中的缓存令牌数检测是否发生了缓存断裂，
 * 若确认断裂则结合阶段一记录的变更信息生成解释。
 *
 * 流程：
 *  1. 获取追踪状态，不在追踪范围或首次调用则直接返回
 *  2. 若处于 cacheDeletionsPending 状态：令牌下降是预期行为，重置基线后返回
 *  3. 计算缓存读取令牌降幅：超过 5% 且超过 MIN_CACHE_MISS_TOKENS 才视为断裂
 *  4. 根据 pendingChanges 构建断裂原因说明（clientside 变更或 TTL 过期或服务端原因）
 *  5. 上报 tengu_prompt_cache_break 分析事件
 *  6. 若有 diff 内容，写入 diff 文件（供 --debug 调试）
 *  7. 输出调试日志摘要
 */
export async function checkResponseForCacheBreak(
  querySource: QuerySource,
  cacheReadTokens: number,
  cacheCreationTokens: number,
  messages: Message[],
  agentId?: AgentId,
  requestId?: string | null,
): Promise<void> {
  try {
    const key = getTrackingKey(querySource, agentId)
    if (!key) return

    const state = previousStateBySource.get(key)
    if (!state) return

    // 排除 haiku 等缓存行为不同的模型
    if (isExcludedModel(state.model)) return

    const prevCacheRead = state.prevCacheReadTokens
    // 将本次缓存读取令牌数记录为新基线
    state.prevCacheReadTokens = cacheReadTokens

    // 通过查找最近的 assistant 消息时间戳来估算距上次调用的时间
    // 用于判断断裂是否由 TTL 过期引起
    const lastAssistantMessage = messages.findLast(m => m.type === 'assistant')
    const timeSinceLastAssistantMsg = lastAssistantMessage
      ? Date.now() - new Date(lastAssistantMessage.timestamp).getTime()
      : null

    // 首次调用时无历史值可比较，直接返回
    if (prevCacheRead === null) return

    const changes = state.pendingChanges

    // cached microcompact 发送了 cache_edits 删除操作，缓存读取令牌下降是预期行为
    // 重置基线，不上报为断裂，同时清除待决变更
    if (state.cacheDeletionsPending) {
      state.cacheDeletionsPending = false
      logForDebugging(
        `[PROMPT CACHE] cache deletion applied, cache read: ${prevCacheRead} → ${cacheReadTokens} (expected drop)`,
      )
      // 不上报断裂——剩余状态仍然有效
      state.pendingChanges = null
      return
    }

    // 断裂检测阈值：缓存读取令牌小于上一次的 95%，且绝对降幅超过最小阈值
    const tokenDrop = prevCacheRead - cacheReadTokens
    if (
      cacheReadTokens >= prevCacheRead * 0.95 || // 降幅不超过 5%，不视为断裂
      tokenDrop < MIN_CACHE_MISS_TOKENS           // 绝对降幅过小，不值得告警
    ) {
      state.pendingChanges = null
      return
    }

    // 根据阶段一记录的待决变更，逐项构建断裂原因说明
    const parts: string[] = []
    if (changes) {
      if (changes.modelChanged) {
        parts.push(
          `model changed (${changes.previousModel} → ${changes.newModel})`,
        )
      }
      if (changes.systemPromptChanged) {
        const charDelta = changes.systemCharDelta
        // 字符变化量：正数显示 +N，负数显示 -N，零不显示
        const charInfo =
          charDelta === 0
            ? ''
            : charDelta > 0
              ? ` (+${charDelta} chars)`
              : ` (${charDelta} chars)`
        parts.push(`system prompt changed${charInfo}`)
      }
      if (changes.toolSchemasChanged) {
        // 工具数量有变化时显示具体增删数量，否则说明是 schema/描述变化
        const toolDiff =
          changes.addedToolCount > 0 || changes.removedToolCount > 0
            ? ` (+${changes.addedToolCount}/-${changes.removedToolCount} tools)`
            : ' (tool prompt/schema changed, same tool set)'
        parts.push(`tools changed${toolDiff}`)
      }
      if (changes.fastModeChanged) {
        parts.push('fast mode toggled')
      }
      if (changes.globalCacheStrategyChanged) {
        parts.push(
          `global cache strategy changed (${changes.prevGlobalCacheStrategy || 'none'} → ${changes.newGlobalCacheStrategy || 'none'})`,
        )
      }
      if (
        changes.cacheControlChanged &&
        !changes.globalCacheStrategyChanged &&
        !changes.systemPromptChanged
      ) {
        // cache_control 变化仅在其他维度均未变化时才作为独立原因上报，
        // 否则它通常是系统 prompt 变化或 globalCacheStrategy 翻转的副作用
        parts.push('cache_control changed (scope or TTL)')
      }
      if (changes.betasChanged) {
        // 显示新增和删除的 beta 列表（使用 +/- 前缀）
        const added = changes.addedBetas.length
          ? `+${changes.addedBetas.join(',')}`
          : ''
        const removed = changes.removedBetas.length
          ? `-${changes.removedBetas.join(',')}`
          : ''
        const diff = [added, removed].filter(Boolean).join(' ')
        parts.push(`betas changed${diff ? ` (${diff})` : ''}`)
      }
      if (changes.autoModeChanged) {
        parts.push('auto mode toggled')
      }
      if (changes.overageChanged) {
        parts.push('overage state changed (TTL latched, no flip)')
      }
      if (changes.cachedMCChanged) {
        parts.push('cached microcompact toggled')
      }
      if (changes.effortChanged) {
        parts.push(
          `effort changed (${changes.prevEffortValue || 'default'} → ${changes.newEffortValue || 'default'})`,
        )
      }
      if (changes.extraBodyChanged) {
        parts.push('extra body params changed')
      }
    }

    // 根据距上次 assistant 消息的时间，判断是否可能由 TTL 过期引起
    const lastAssistantMsgOver5minAgo =
      timeSinceLastAssistantMsg !== null &&
      timeSinceLastAssistantMsg > CACHE_TTL_5MIN_MS
    const lastAssistantMsgOver1hAgo =
      timeSinceLastAssistantMsg !== null &&
      timeSinceLastAssistantMsg > CACHE_TTL_1HOUR_MS

    // 当所有客户端侧标志均为 false 且时间间隔在 TTL 内时，约 90% 的断裂是
    // 服务端路由/驱逐或计费/推理不一致导致的，明确标注而非归咎于客户端 bug
    let reason: string
    if (parts.length > 0) {
      reason = parts.join(', ') // 有明确客户端变更原因
    } else if (lastAssistantMsgOver1hAgo) {
      reason = 'possible 1h TTL expiry (prompt unchanged)'
    } else if (lastAssistantMsgOver5minAgo) {
      reason = 'possible 5min TTL expiry (prompt unchanged)'
    } else if (timeSinceLastAssistantMsg !== null) {
      reason = 'likely server-side (prompt unchanged, <5min gap)'
    } else {
      reason = 'unknown cause'
    }

    // 上报 tengu_prompt_cache_break 分析事件（全量字段）
    logEvent('tengu_prompt_cache_break', {
      systemPromptChanged: changes?.systemPromptChanged ?? false,
      toolSchemasChanged: changes?.toolSchemasChanged ?? false,
      modelChanged: changes?.modelChanged ?? false,
      fastModeChanged: changes?.fastModeChanged ?? false,
      cacheControlChanged: changes?.cacheControlChanged ?? false,
      globalCacheStrategyChanged: changes?.globalCacheStrategyChanged ?? false,
      betasChanged: changes?.betasChanged ?? false,
      autoModeChanged: changes?.autoModeChanged ?? false,
      overageChanged: changes?.overageChanged ?? false,
      cachedMCChanged: changes?.cachedMCChanged ?? false,
      effortChanged: changes?.effortChanged ?? false,
      extraBodyChanged: changes?.extraBodyChanged ?? false,
      addedToolCount: changes?.addedToolCount ?? 0,
      removedToolCount: changes?.removedToolCount ?? 0,
      systemCharDelta: changes?.systemCharDelta ?? 0,
      // 工具名已脱敏：内置工具名为固定词汇，MCP 工具名折叠为 'mcp'（可能含路径）
      addedTools: (changes?.addedTools ?? [])
        .map(sanitizeToolName)
        .join(
          ',',
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      removedTools: (changes?.removedTools ?? [])
        .map(sanitizeToolName)
        .join(
          ',',
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      changedToolSchemas: (changes?.changedToolSchemas ?? [])
        .map(sanitizeToolName)
        .join(
          ',',
        ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      // beta 请求头名称和缓存策略是类枚举固定值，非代码或路径
      addedBetas: (changes?.addedBetas ?? []).join(
        ',',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      removedBetas: (changes?.removedBetas ?? []).join(
        ',',
      ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      prevGlobalCacheStrategy: (changes?.prevGlobalCacheStrategy ??
        '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      newGlobalCacheStrategy: (changes?.newGlobalCacheStrategy ??
        '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      callNumber: state.callCount,
      prevCacheReadTokens: prevCacheRead,
      cacheReadTokens,
      cacheCreationTokens,
      timeSinceLastAssistantMsg: timeSinceLastAssistantMsg ?? -1, // -1 表示无 assistant 消息
      lastAssistantMsgOver5minAgo,
      lastAssistantMsgOver1hAgo,
      requestId: (requestId ??
        '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })

    // 写入 diff 文件供 --debug 模式调试（diff 路径包含在摘要日志中）
    // DevBar UI 已移除，分析数据直接通过 BQ 流向上游
    let diffPath: string | undefined
    if (changes?.buildPrevDiffableContent) {
      diffPath = await writeCacheBreakDiff(
        changes.buildPrevDiffableContent(), // 上一次的 diffable 内容
        state.buildDiffableContent(),        // 当前的 diffable 内容
      )
    }

    // 构建调试摘要日志，包含原因、来源、调用次数、令牌变化和 diff 文件路径
    const diffSuffix = diffPath ? `, diff: ${diffPath}` : ''
    const summary = `[PROMPT CACHE BREAK] ${reason} [source=${querySource}, call #${state.callCount}, cache read: ${prevCacheRead} → ${cacheReadTokens}, creation: ${cacheCreationTokens}${diffSuffix}]`

    logForDebugging(summary, { level: 'warn' })

    // 清除待决变更（避免下一次响应误用本次变更信息）
    state.pendingChanges = null
  } catch (e: unknown) {
    logError(e)
  }
}

/**
 * 通知追踪系统：cached microcompact 发送了 cache_edits 删除操作。
 *
 * 调用后，下一次 API 响应的缓存读取令牌降低是预期行为（不是断裂）。
 * checkResponseForCacheBreak 检测到此标志时将跳过告警并重置基线。
 */
export function notifyCacheDeletion(
  querySource: QuerySource,
  agentId?: AgentId,
): void {
  const key = getTrackingKey(querySource, agentId)
  const state = key ? previousStateBySource.get(key) : undefined
  if (state) {
    // 标记删除待处理，下一次响应令牌下降为预期行为
    state.cacheDeletionsPending = true
  }
}

/**
 * 通知追踪系统：发生了压缩（compaction），缓存读取令牌基线需重置。
 *
 * 压缩会合法地减少消息数量，因此下一次调用的缓存读取令牌自然下降——不是断裂。
 * 将 prevCacheReadTokens 重置为 null，使下一次调用重新建立基线。
 */
export function notifyCompaction(
  querySource: QuerySource,
  agentId?: AgentId,
): void {
  const key = getTrackingKey(querySource, agentId)
  const state = key ? previousStateBySource.get(key) : undefined
  if (state) {
    // 重置基线：下一次响应不做对比（视为首次调用）
    state.prevCacheReadTokens = null
  }
}

/** 清理特定 Agent 的追踪状态（Agent 生命周期结束时调用） */
export function cleanupAgentTracking(agentId: AgentId): void {
  previousStateBySource.delete(agentId)
}

/** 清空所有追踪状态（用于测试重置或全局复位） */
export function resetPromptCacheBreakDetection(): void {
  previousStateBySource.clear()
}

/**
 * 将缓存断裂前后的 prompt/工具 diff 写入临时文件。
 *
 * 使用 unified diff 格式，文件路径包含在调试摘要日志中。
 * 临时目录不存在时自动创建。
 *
 * @param prevContent - 上一次调用的 diffable 内容
 * @param newContent  - 本次调用的 diffable 内容
 * @returns diff 文件路径，写入失败时返回 undefined
 */
async function writeCacheBreakDiff(
  prevContent: string,
  newContent: string,
): Promise<string | undefined> {
  try {
    const diffPath = getCacheBreakDiffPath()
    // 确保临时目录存在（递归创建）
    await mkdir(getClaudeTempDir(), { recursive: true })
    // 生成 unified diff 格式
    const patch = createPatch(
      'prompt-state',
      prevContent,
      newContent,
      'before',
      'after',
    )
    await writeFile(diffPath, patch)
    return diffPath
  } catch {
    return undefined // 写入失败时静默返回，不影响主流程
  }
}
