/**
 * ============================================================================
 * 全局状态管理中心 - state.ts
 * ============================================================================
 * 
 * 这个文件是Claude Code的核心状态管理模块，采用单例模式设计，负责管理整个应用的
 * 生命周期状态。作为bootstrap模块的一部分，它是整个应用的基石，提供跨会话、跨模块
 * 的状态共享和管理能力。
 * 
 * 架构位置：
 * - 位于bootstrap层，是应用启动时最早初始化的模块之一
 * - 作为叶子模块，避免循环依赖，可以被任何其他模块安全引用
 * - 提供全局状态访问接口，但不包含业务逻辑
 * 
 * 主要功能：
 * 1. 会话管理：会话ID、项目路径、会话切换
 * 2. 性能统计：API耗时、代码修改统计、Token使用
 * 3. 认证配置：OAuth Token、API Key、权限设置
 * 4. 功能开关：交互模式、Kairos功能、严格工具配对
 * 5. 缓存管理：系统提示缓存、技能调用记录
 * 6. 监控指标：OpenTelemetry集成、慢操作追踪
 * 7. 会话特定状态：定时任务、信任设置、模式切换
 * 
 * 设计原则：
 * - 单例模式：全局唯一的STATE对象
 * - 类型安全：完整的TypeScript类型定义
 * - 模块化：状态按功能域清晰分离
 * - 可测试性：专门的测试重置函数
 * - 性能优化：懒加载和批量更新支持
 * 
 * 注意：这是一个高度稳定的核心模块，修改需要极其谨慎！
 */

import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { Attributes, Meter, MetricOptions } from '@opentelemetry/api'
import type { logs } from '@opentelemetry/api-logs'
import type { LoggerProvider } from '@opentelemetry/sdk-logs'
import type { MeterProvider } from '@opentelemetry/sdk-metrics'
import type { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
import { realpathSync } from 'fs'
import sumBy from 'lodash-es/sumBy.js'
import { cwd } from 'process'
import type { HookEvent, ModelUsage } from 'src/entrypoints/agentSdkTypes.js'
import type { AgentColorName } from 'src/tools/AgentTool/agentColorManager.js'
import type { HookCallbackMatcher } from 'src/types/hooks.js'
// Indirection for browser-sdk build (package.json "browser" field swaps
// crypto.ts for crypto.browser.ts). Pure leaf re-export of node:crypto —
// zero circular-dep risk. Path-alias import bypasses bootstrap-isolation
// (rule only checks ./ and / prefixes); explicit disable documents intent.
// eslint-disable-next-line custom-rules/bootstrap-isolation
import { randomUUID } from 'src/utils/crypto.js'
import type { ModelSetting } from 'src/utils/model/model.js'
import type { ModelStrings } from 'src/utils/model/modelStrings.js'
import type { SettingSource } from 'src/utils/settings/constants.js'
import { resetSettingsCache } from 'src/utils/settings/settingsCache.js'
import type { PluginHookMatcher } from 'src/utils/settings/types.js'
import { createSignal } from 'src/utils/signal.js'

// Union type for registered hooks - can be SDK callbacks or native plugin hooks
type RegisteredHookMatcher = HookCallbackMatcher | PluginHookMatcher

import type { SessionId } from 'src/types/ids.js'

// DO NOT ADD MORE STATE HERE - BE JUDICIOUS WITH GLOBAL STATE

// dev: true on entries that came via --dangerously-load-development-channels.
// The allowlist gate checks this per-entry (not the session-wide
// hasDevChannels bit) so passing both flags doesn't let the dev dialog's
// acceptance leak allowlist-bypass to the --channels entries.
export type ChannelEntry =
  | { kind: 'plugin'; name: string; marketplace: string; dev?: boolean }
  | { kind: 'server'; name: string; dev?: boolean }

export type AttributedCounter = {
  add(value: number, additionalAttributes?: Attributes): void
}

/**
 * 全局状态对象类型定义 - 包含Claude Code会话的所有状态信息
 * 
 * 这个类型定义了整个应用的单例状态结构，按功能域分组管理：
 * 1. 会话和项目状态
 * 2. 性能统计和成本追踪
 * 3. 认证和配置状态
 * 4. 功能开关和模式状态
 * 5. 监控和遥测状态
 * 6. 缓存和临时状态
 */
type State = {
  // ==================== 会话和项目状态 ====================
  
  /** 原始工作目录 - 会话启动时的cwd，用于会话恢复和项目识别 */
  originalCwd: string
  
  /** 
   * 稳定的项目根目录 - 仅在启动时设置（包括--worktree标志）
   * 会话中期的EnterWorktreeTool不会更新此值
   * 用于项目身份识别（历史、技能、会话），不用于文件操作
   */
  projectRoot: string
  
  /** 当前工作目录 - 可能随会话中文件操作而变化 */
  cwd: string
  
  /** 当前会话的唯一标识符 */
  sessionId: SessionId
  
  /** 父会话ID - 用于追踪会话谱系（例如：计划模式 -> 实现模式） */
  parentSessionId: SessionId | undefined
  
  /** 会话项目目录 - 包含会话`.jsonl`文件的目录，null表示使用originalCwd */
  sessionProjectDir: string | null
  
  // ==================== 性能统计和成本追踪 ====================
  
  /** 总成本（美元） - 累计API使用费用 */
  totalCostUSD: number
  
  /** 总API耗时（毫秒） - 包括重试的API调用时间 */
  totalAPIDuration: number
  
  /** 总API耗时（排除重试） - 仅计算成功的API调用时间 */
  totalAPIDurationWithoutRetries: number
  
  /** 总工具执行耗时（毫秒） - 所有工具调用的累计时间 */
  totalToolDuration: number
  
  /** 当前轮次Hook耗时（毫秒） - 本轮会话的Hook执行时间 */
  turnHookDurationMs: number
  
  /** 当前轮次工具耗时（毫秒） - 本轮会话的工具执行时间 */
  turnToolDurationMs: number
  
  /** 当前轮次分类器耗时（毫秒） - 本轮会话的分类器执行时间 */
  turnClassifierDurationMs: number
  
  /** 当前轮次工具调用次数 */
  turnToolCount: number
  
  /** 当前轮次Hook调用次数 */
  turnHookCount: number
  
  /** 当前轮次分类器调用次数 */
  turnClassifierCount: number
  
  /** 会话开始时间戳（毫秒） */
  startTime: number
  
  /** 最后交互时间戳（毫秒） - 用于空闲检测 */
  lastInteractionTime: number
  
  /** 总新增代码行数 */
  totalLinesAdded: number
  
  /** 总删除代码行数 */
  totalLinesRemoved: number
  
  /** 是否存在未知模型成本 - 用于成本计算容错 */
  hasUnknownModelCost: boolean
  
  /** 各模型使用情况统计 */
  modelUsage: { [modelName: string]: ModelUsage }
  
  // ==================== 认证和配置状态 ====================
  
  /** 主循环模型覆盖设置 - CLI标志或用户配置的模型覆盖 */
  mainLoopModelOverride: ModelSetting | undefined
  
  /** 初始主循环模型 - 会话启动时的默认模型 */
  initialMainLoopModel: ModelSetting
  
  /** 模型字符串配置 - 模型名称和描述的本地化映射 */
  modelStrings: ModelStrings | null
  
  /** 会话入口令牌 - 用于会话身份验证 */
  sessionIngressToken: string | null | undefined
  
  /** 从文件描述符读取的OAuth令牌 */
  oauthTokenFromFd: string | null | undefined
  
  /** 从文件描述符读取的API密钥 */
  apiKeyFromFd: string | null | undefined
  
  /** 标志设置文件路径 - 用于功能开关配置 */
  flagSettingsPath: string | undefined
  
  /** 内联标志设置 - 不从文件加载的直接配置 */
  flagSettingsInline: Record<string, unknown> | null
  
  /** 允许的设置源列表 - 控制配置加载优先级 */
  allowedSettingSources: SettingSource[]
  
  // ==================== 功能开关和模式状态 ====================
  
  /** 是否为交互模式 - 控制用户交互行为 */
  isInteractive: boolean
  
  /** Kairos功能是否激活 - 高级功能开关 */
  kairosActive: boolean
  
  /** 
   * 严格工具结果配对模式 - 当为true时，ensureToolResultPairing在
   * 不匹配时抛出异常而不是使用合成占位符修复。HFI在启动时选择此模式，
   * 以便轨迹快速失败而不是让模型基于假的tool_results进行条件化
   */
  strictToolResultPairing: boolean
  
  /** SDK代理进度摘要是否启用 */
  sdkAgentProgressSummariesEnabled: boolean
  
  /** 用户消息选择加入状态 */
  userMsgOptIn: boolean
  
  /** 客户端类型标识 */
  clientType: string
  
  /** 会话来源标识 */
  sessionSource: string | undefined
  
  /** 问题预览格式设置 */
  questionPreviewFormat: 'markdown' | 'html' | undefined
  
  /** 会话级绕过权限模式标志（不持久化） */
  sessionBypassPermissionsMode: boolean
  
  /** 定时任务是否启用 - 控制.claude/scheduled_tasks.json监听器 */
  scheduledTasksEnabled: boolean
  
  /** 会话级信任标志 - 用于home目录临时信任 */
  sessionTrustAccepted: boolean
  
  /** 会话持久化是否禁用标志 */
  sessionPersistenceDisabled: boolean
  
  /** 用户是否已退出计划模式（用于重新进入指导） */
  hasExitedPlanMode: boolean
  
  /** 是否需要显示计划模式退出附件（一次性通知） */
  needsPlanModeExitAttachment: boolean
  
  /** 是否需要显示自动模式退出附件（一次性通知） */
  needsAutoModeExitAttachment: boolean
  
  /** LSP插件推荐是否已在本会话显示（仅显示一次） */
  lspRecommendationShownThisSession: boolean
  
  /** 远程模式标志（--remote标志） */
  isRemoteMode: boolean
  
  /** 主线程代理类型（来自--agent标志或设置） */
  mainThreadAgentType: string | undefined
  
  // ==================== 监控和遥测状态 ====================
  
  /** OpenTelemetry Meter实例 - 用于指标收集 */
  meter: Meter | null
  
  /** 会话计数器 - 统计会话启动次数 */
  sessionCounter: AttributedCounter | null
  
  /** 代码行数计数器 - 统计代码修改量 */
  locCounter: AttributedCounter | null
  
  /** 拉取请求计数器 - 统计PR创建次数 */
  prCounter: AttributedCounter | null
  
  /** 提交计数器 - 统计Git提交次数 */
  commitCounter: AttributedCounter | null
  
  /** 成本计数器 - 统计会话成本 */
  costCounter: AttributedCounter | null
  
  /** Token计数器 - 统计Token使用量 */
  tokenCounter: AttributedCounter | null
  
  /** 代码编辑工具决策计数器 - 统计工具权限决策 */
  codeEditToolDecisionCounter: AttributedCounter | null
  
  /** 活跃时间计数器 - 统计会话活跃时间 */
  activeTimeCounter: AttributedCounter | null
  
  /** 统计存储接口 - 用于观测指标值 */
  statsStore: { observe(name: string, value: number): void } | null
  
  /** 日志提供者实例 */
  loggerProvider: LoggerProvider | null
  
  /** 事件日志记录器 */
  eventLogger: ReturnType<typeof logs.getLogger> | null
  
  /** Meter提供者实例 */
  meterProvider: MeterProvider | null
  
  /** 追踪器提供者实例 */
  tracerProvider: BasicTracerProvider | null
  
  // ==================== 缓存和临时状态 ====================
  
  /** 最后API请求信息 - 用于错误报告 */
  lastAPIRequest: Omit<BetaMessageStreamParams, 'messages'> | null
  
  /** 
   * 最后API请求消息（仅ant环境；引用而非克隆）
   * 捕获发送到API的确切压缩后、CLAUDE.md注入的消息集，
   * 以便/share的serialized_conversation.json反映实际情况
   */
  lastAPIRequestMessages: BetaMessageStreamParams['messages'] | null
  
  /** 最后自动模式分类器请求 - 用于/share转录 */
  lastClassifierRequests: unknown[] | null
  
  /** CLAUDE.md内容缓存 - 由context.ts为自动模式分类器缓存 */
  cachedClaudeMdContent: string | null
  
  /** 内存错误日志 - 记录最近错误 */
  inMemoryErrorLog: Array<{ error: string; timestamp: string }>
  
  /** 会话级插件列表 - 来自--plugin-dir标志 */
  inlinePlugins: Array<string>
  
  /** 显式--chrome / --no-chrome标志值（undefined = CLI未设置） */
  chromeFlagOverride: boolean | undefined
  
  /** 使用cowork_plugins目录而不是plugins（--cowork标志或环境变量） */
  useCoworkPlugins: boolean
  
  /** 会话级定时任务列表 - 通过CronCreate创建的非持久化任务 */
  sessionCronTasks: SessionCronTask[]
  
  /** 会话创建的团队集合 - 用于会话结束时清理 */
  sessionCreatedTeams: Set<string>
  
  /** SDK初始化事件状态 - jsonSchema用于结构化输出 */
  initJsonSchema: Record<string, unknown> | null
  
  /** 注册的Hook - SDK回调和插件原生Hook */
  registeredHooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>> | null
  
  /** 计划slug缓存：sessionId -> wordSlug */
  planSlugCache: Map<string, string>
  
  /** 传送会话信息追踪 - 用于可靠性日志记录 */
  teleportedSessionInfo: {
    isTeleported: boolean
    hasLoggedFirstMessage: boolean
    sessionId: string | null
  } | null
  
  /** 调用的技能追踪 - 用于在压缩期间保持状态 */
  invokedSkills: Map<
    string,
    {
      skillName: string
      skillPath: string
      content: string
      invokedAt: number
      agentId: string | null
    }
  >
  
  /** 慢操作追踪 - 用于开发栏显示（仅ant环境） */
  slowOperations: Array<{
    operation: string
    durationMs: number
    timestamp: number
  }>
  
  /** SDK提供的beta功能列表 */
  sdkBetas: string[] | undefined
  
  /** 直接连接服务器URL（用于头部显示） */
  directConnectServerUrl: string | undefined
  
  /** 系统提示部分缓存状态 */
  systemPromptSectionCache: Map<string, string | null>
  
  /** 最后发送给模型的日期（用于检测午夜日期变化） */
  lastEmittedDate: string | null
  
  /** 来自--add-dir标志的额外目录（用于CLAUDE.md加载） */
  additionalDirectoriesForClaudeMd: string[]
  
  /** 通道服务器允许列表 - 来自--channels标志 */
  allowedChannels: ChannelEntry[]
  
  /** 是否有开发通道 - 用于策略阻止消息中的标志命名 */
  hasDevChannels: boolean
  
  /** 缓存的提示缓存1小时允许列表 - 来自GrowthBook */
  promptCache1hAllowlist: string[] | null
  
  /** 缓存的1小时TTL用户资格 - 在第一次评估时锁定 */
  promptCache1hEligible: boolean | null
  
  /** AFK模式beta头锁存器 - 一旦激活就保持发送头信息 */
  afkModeHeaderLatched: boolean | null
  
  /** 快速模式beta头锁存器 - 一旦启用就保持发送头信息 */
  fastModeHeaderLatched: boolean | null
  
  /** 缓存编辑beta头锁存器 - 一旦启用就保持发送头信息 */
  cacheEditingHeaderLatched: boolean | null
  
  /** 清除思考锁存器 - 用于优化缓存使用 */
  thinkingClearLatched: boolean | null
  
  /** 当前提示ID - 关联用户提示与后续OTel事件 */
  promptId: string | null
  
  /** 最后主请求ID - 用于缓存失效提示 */
  lastMainRequestId: string | undefined
  
  /** 最后API完成时间戳 - 用于计算缓存空闲时间 */
  lastApiCompletionTimestamp: number | null
  
  /** 压缩后待处理标志 - 用于区分压缩引起的缓存失效 */
  pendingPostCompaction: boolean
  
  // ==================== 其他辅助状态 ====================
  
  /** 代理颜色映射 - 管理不同代理的显示颜色 */
  agentColorMap: Map<string, AgentColorName>
  
  /** 代理颜色索引 - 用于分配新颜色 */
  agentColorIndex: number
}

/**
 * 初始化全局状态对象 - 创建State类型的默认实例
 * 
 * 这个函数在应用启动时调用一次，创建全局的单例状态对象。
 * 它负责：
 * 1. 解析符号链接以匹配shell.ts的setCwd行为
 * 2. 设置所有状态字段的合理默认值
 * 3. 确保路径格式一致性（NFC标准化）
 * 4. 初始化所有集合和映射为空的实例
 * 
 * 重要：这个函数只在应用启动时调用一次，后续状态修改通过setter函数进行
 * 
 * @returns 完全初始化的State对象，包含所有字段的默认值
 */
function getInitialState(): State {
  // 解析符号链接以匹配shell.ts的setCwd行为
  // 这确保与会话存储中路径清理方式的一致性
  let resolvedCwd = ''
  if (
    typeof process !== 'undefined' &&
    typeof process.cwd === 'function' &&
    typeof realpathSync === 'function'
  ) {
    const rawCwd = cwd()
    try {
      // 尝试解析符号链接以获得真实路径
      resolvedCwd = realpathSync(rawCwd).normalize('NFC')
    } catch {
      // 文件提供者在云存储挂载点上可能遇到EPERM错误（每个路径组件都需要lstat）
      // 在这种情况下回退到原始cwd
      resolvedCwd = rawCwd.normalize('NFC')
    }
  }

  // 创建并返回完全初始化的状态对象
  const state: State = {
    // ==================== 会话和项目状态 ====================
    originalCwd: resolvedCwd,        // 原始工作目录
    projectRoot: resolvedCwd,          // 项目根目录（初始与cwd相同）
    cwd: resolvedCwd,                 // 当前工作目录
    sessionId: randomUUID() as SessionId, // 生成唯一的会话ID
    parentSessionId: undefined,       // 父会话ID（初始为空）
    sessionProjectDir: null,          // 会话项目目录（null表示从originalCwd派生）
    
    // ==================== 性能统计和成本追踪 ====================
    totalCostUSD: 0,                  // 总成本初始为0
    totalAPIDuration: 0,              // API总耗时初始为0
    totalAPIDurationWithoutRetries: 0, // 排除重试的API耗时初始为0
    totalToolDuration: 0,             // 工具总耗时初始为0
    turnHookDurationMs: 0,            // 当前轮次Hook耗时初始为0
    turnToolDurationMs: 0,            // 当前轮次工具耗时初始为0
    turnClassifierDurationMs: 0,      // 当前轮次分类器耗时初始为0
    turnToolCount: 0,                 // 当前轮次工具调用次数初始为0
    turnHookCount: 0,                 // 当前轮次Hook调用次数初始为0
    turnClassifierCount: 0,           // 当前轮次分类器调用次数初始为0
    startTime: Date.now(),            // 会话开始时间为当前时间
    lastInteractionTime: Date.now(),  // 最后交互时间为当前时间
    totalLinesAdded: 0,               // 总新增代码行数初始为0
    totalLinesRemoved: 0,             // 总删除代码行数初始为0
    hasUnknownModelCost: false,       // 未知模型成本标志初始为false
    modelUsage: {},                   // 模型使用情况初始为空对象
    
    // ==================== 认证和配置状态 ====================
    mainLoopModelOverride: undefined, // 主循环模型覆盖初始未设置
    initialMainLoopModel: null,       // 初始主循环模型初始为null
    modelStrings: null,               // 模型字符串配置初始为null
    sessionIngressToken: undefined,   // 会话入口令牌初始未设置
    oauthTokenFromFd: undefined,      // OAuth令牌初始未设置
    apiKeyFromFd: undefined,          // API密钥初始未设置
    flagSettingsPath: undefined,      // 标志设置路径初始未设置
    flagSettingsInline: null,         // 内联标志设置初始为null
    allowedSettingSources: [          // 默认允许的设置源列表
      'userSettings',                  // 用户设置（最高优先级）
      'projectSettings',              // 项目设置
      'localSettings',                 // 本地设置
      'flagSettings',                  // 标志设置
      'policySettings',                // 策略设置（最低优先级）
    ],
    
    // ==================== 功能开关和模式状态 ====================
    isInteractive: false,              // 交互模式初始为false（非交互）
    kairosActive: false,              // Kairos功能初始为false（未激活）
    strictToolResultPairing: false,    // 严格工具结果配对初始为false
    sdkAgentProgressSummariesEnabled: false, // SDK代理进度摘要初始为false
    userMsgOptIn: false,              // 用户消息选择加入初始为false
    clientType: 'cli',                 // 客户端类型默认为'cli'
    sessionSource: undefined,         // 会话来源初始未设置
    questionPreviewFormat: undefined,  // 问题预览格式初始未设置
    sessionBypassPermissionsMode: false, // 会话绕过权限模式初始为false
    scheduledTasksEnabled: false,     // 定时任务初始为false（未启用）
    sessionTrustAccepted: false,      // 会话信任初始为false（未接受）
    sessionPersistenceDisabled: false, // 会话持久化初始为启用状态
    hasExitedPlanMode: false,         // 退出计划模式标志初始为false
    needsPlanModeExitAttachment: false, // 计划模式退出附件需求初始为false
    needsAutoModeExitAttachment: false, // 自动模式退出附件需求初始为false
    lspRecommendationShownThisSession: false, // LSP推荐显示标志初始为false
    isRemoteMode: false,               // 远程模式初始为false
    mainThreadAgentType: undefined,    // 主线程代理类型初始未设置
    
    // ==================== 监控和遥测状态 ====================
    meter: null,                       // Meter实例初始为null
    sessionCounter: null,              // 会话计数器初始为null
    locCounter: null,                  // 代码行数计数器初始为null
    prCounter: null,                   // 拉取请求计数器初始为null
    commitCounter: null,               // 提交计数器初始为null
    costCounter: null,                 // 成本计数器初始为null
    tokenCounter: null,                // Token计数器初始为null
    codeEditToolDecisionCounter: null, // 代码编辑工具决策计数器初始为null
    activeTimeCounter: null,           // 活跃时间计数器初始为null
    statsStore: null,                  // 统计存储初始为null
    loggerProvider: null,              // 日志提供者初始为null
    eventLogger: null,                 // 事件日志记录器初始为null
    meterProvider: null,               // Meter提供者初始为null
    tracerProvider: null,              // 追踪器提供者初始为null
    
    // ==================== 缓存和临时状态 ====================
    lastAPIRequest: null,              // 最后API请求初始为null
    lastAPIRequestMessages: null,     // 最后API请求消息初始为null
    lastClassifierRequests: null,      // 最后分类器请求初始为null
    cachedClaudeMdContent: null,       // CLAUDE.md内容缓存初始为null
    inMemoryErrorLog: [],              // 内存错误日志初始为空数组
    inlinePlugins: [],                 // 内联插件列表初始为空数组
    chromeFlagOverride: undefined,     // Chrome标志覆盖初始未设置
    useCoworkPlugins: false,           // 使用cowork插件目录初始为false
    sessionCronTasks: [],              // 会话定时任务初始为空数组
    sessionCreatedTeams: new Set(),    // 会话创建团队初始为空集合
    initJsonSchema: null,              // SDK初始化JSON模式初始为null
    registeredHooks: null,             // 注册Hook初始为null
    planSlugCache: new Map(),          // 计划slug缓存初始为空映射
    teleportedSessionInfo: null,       // 传送会话信息初始为null
    invokedSkills: new Map(),          // 调用技能追踪初始为空映射
    slowOperations: [],                // 慢操作追踪初始为空数组
    sdkBetas: undefined,               // SDK beta功能列表初始未设置
    directConnectServerUrl: undefined, // 直接连接服务器URL初始未设置
    systemPromptSectionCache: new Map(), // 系统提示部分缓存初始为空映射
    lastEmittedDate: null,             // 最后发送日期初始为null
    additionalDirectoriesForClaudeMd: [], // 额外CLAUDE.md目录初始为空数组
    allowedChannels: [],               // 允许通道列表初始为空数组
    hasDevChannels: false,             // 开发通道标志初始为false
    promptCache1hAllowlist: null,      // 提示缓存1小时允许列表初始为null
    promptCache1hEligible: null,       // 提示缓存1小时资格初始为null
    afkModeHeaderLatched: null,        // AFK模式头锁存器初始为null
    fastModeHeaderLatched: null,       // 快速模式头锁存器初始为null
    cacheEditingHeaderLatched: null,   // 缓存编辑头锁存器初始为null
    thinkingClearLatched: null,        // 清除思考锁存器初始为null
    promptId: null,                    // 当前提示ID初始为null
    lastMainRequestId: undefined,      // 最后主请求ID初始未设置
    lastApiCompletionTimestamp: null,  // 最后API完成时间戳初始为null
    pendingPostCompaction: false,      // 压缩后待处理标志初始为false
    
    // ==================== 其他辅助状态 ====================
    agentColorMap: new Map(),          // 代理颜色映射初始为空映射
    agentColorIndex: 0,                // 代理颜色索引初始为0
  }

  return state
}

// AND ESPECIALLY HERE
const STATE: State = getInitialState()

/**
 * 获取当前会话的唯一标识符
 * 
 * 这个函数返回当前活跃会话的SessionId，用于在整个系统中标识当前会话。
 * SessionId是一个UUID字符串，在会话生命周期内保持不变，除非显式重新生成。
 * 
 * 使用场景：
 * - 会话追踪和日志记录
 * - 会话文件路径生成（transcript.jsonl文件命名）
 * - 跨会话通信和关联
 * 
 * @returns 当前会话的SessionId
 */
export function getSessionId(): SessionId {
  return STATE.sessionId
}

/**
 * 重新生成会话ID并可选地将当前ID设置为父ID
 * 
 * 这个函数用于在需要创建新会话但保留历史关联的场景，如：
 * 1. 会话恢复或重新开始
 * 2. 创建会话分支
 * 3. 重置会话状态但保持追踪
 * 
 * 重要行为：
 * - 清理旧会话的计划slug缓存，防止内存泄漏
 * - 重置会话项目目录为null，确保新会话使用正确的项目路径
 * - 生成新的UUID作为会话ID
 * 
 * @param options 选项对象
 * @param options.setCurrentAsParent 是否将当前会话ID设置为父会话ID
 * @returns 新生成的SessionId
 */
export function regenerateSessionId(
  options: { setCurrentAsParent?: boolean } = {},
): SessionId {
  // 如果设置了setCurrentAsParent选项，将当前会话ID保存为父会话ID
  if (options.setCurrentAsParent) {
    STATE.parentSessionId = STATE.sessionId
  }
  
  // 清理即将退出的会话的计划slug缓存项，防止Map积累过时的键
  // 需要跨会话携带slug的调用者（如REPL.tsx clearContext）在调用clearConversation之前读取slug
  STATE.planSlugCache.delete(STATE.sessionId)
  
  // 重新生成的会话在当前项目中：重置projectDir为null
  // 这样getTranscriptPath()会从originalCwd派生路径
  STATE.sessionId = randomUUID() as SessionId
  STATE.sessionProjectDir = null
  
  return STATE.sessionId
}

/**
 * 获取父会话的标识符（如果存在）
 * 
 * 当会话是从另一个会话派生时（如会话恢复或分支），此函数返回父会话的ID。
 * 主要用于会话链追踪和上下文继承。
 * 
 * 使用场景：
 * - 会话谱系追踪
 * - 上下文继承和恢复
 * - 调试和日志记录
 * 
 * @returns 父会话的SessionId，如果没有父会话则返回undefined
 */
export function getParentSessionId(): SessionId | undefined {
  return STATE.parentSessionId
}

/**
 * 原子性地切换活跃会话
 * 
 * 这个函数确保sessionId和sessionProjectDir始终一起更改，没有单独的设置器，
 * 因此它们不会失去同步（CC-34）。
 * 
 * 使用场景：
 * - 会话恢复（--resume标志）
 * - 跨项目会话切换
 * - Git工作树切换
 * 
 * 重要行为：
 * - 清理旧会话的计划slug缓存
 * - 触发sessionSwitched信号通知监听器
 * - 每次调用都会重置项目目录，不会从前一个会话继承
 * 
 * @param sessionId 要切换到的目标会话ID
 * @param projectDir 包含`<sessionId>.jsonl`文件的目录。省略（或传递`null`）
 *   表示会话在当前项目中——路径将在读取时从originalCwd派生。当会话位于不同
 *   项目目录时（git工作树、跨项目恢复）传递`dirname(transcriptPath)`
 */
export function switchSession(
  sessionId: SessionId,
  projectDir: string | null = null,
): void {
  // 清理即将退出的会话的计划slug缓存项，防止Map积累过时的键
  // 只有当前会话的slug会被读取（plans.ts getPlanSlug默认为getSessionId()）
  STATE.planSlugCache.delete(STATE.sessionId)
  
  STATE.sessionId = sessionId
  STATE.sessionProjectDir = projectDir
  
  // 触发会话切换信号，通知所有监听器
  sessionSwitched.emit(sessionId)
}

// 会话切换信号 - 用于监听会话ID变化事件
const sessionSwitched = createSignal<[id: SessionId]>()

/**
 * 注册会话切换回调函数
 * 
 * 当switchSession更改活跃sessionId时触发回调。bootstrap不能直接导入监听器
 * （DAG叶子节点），因此调用者自行注册。concurrentSessions.ts使用此功能来
 * 保持PID文件的sessionId与--resume同步。
 * 
 * @returns 会话切换事件的订阅函数
 */
export const onSessionSwitch = sessionSwitched.subscribe

/**
 * 获取当前会话的transcript文件所在的项目目录
 * 
 * 返回当前会话transcript文件所在的项目目录，如果会话在当前项目中创建
 * （常见情况——从originalCwd派生）则返回`null`。
 * 
 * 使用场景：
 * - 会话文件路径解析
 * - 跨项目会话管理
 * - 会话恢复时的路径定位
 * 
 * @returns 会话项目目录路径，如果使用默认目录则返回null
 */
export function getSessionProjectDir(): string | null {
  return STATE.sessionProjectDir
}

/**
 * 获取原始工作目录路径
 * 
 * 返回应用启动时的原始工作目录，这个路径在会话生命周期内保持不变。
 * 用于恢复原始上下文和路径解析基准。
 * 
 * 使用场景：
 * - 会话恢复时的路径基准
 * - 项目根目录派生
 * - 路径标准化和一致性检查
 * 
 * @returns 原始工作目录的绝对路径
 */
export function getOriginalCwd(): string {
  return STATE.originalCwd
}

/**
 * 获取稳定的项目根目录
 * 
 * 与getOriginalCwd()不同，此目录不会被会话中的EnterWorktreeTool更新
 * （因此当进入临时工作树时，技能/历史记录保持稳定）。
 * 它确实在启动时由--worktree设置，因为该工作树是会话的项目。
 * 用于项目身份识别（历史、技能、会话），不用于文件操作。
 * 
 * 使用场景：
 * - 项目身份识别和追踪
 * - 技能和历史记录管理
 * - 会话持久化路径基准
 * 
 * @returns 项目根目录的绝对路径
 */
export function getProjectRoot(): string {
  return STATE.projectRoot
}

/**
 * 设置原始工作目录路径
 * 
 * 用于显式设置原始工作目录，通常在应用启动时调用。
 * 确保路径格式正确并符合NFC标准化要求。
 * 
 * @param cwd 新的原始工作目录路径
 */
export function setOriginalCwd(cwd: string): void {
  STATE.originalCwd = cwd.normalize('NFC')
}

/**
 * 设置项目根目录路径
 * 
 * 仅用于--worktree启动标志。会话中的EnterWorktreeTool绝对不能调用此函数——
 * 技能/历史记录应锚定在会话开始的位置。
 * 
 * @param cwd 新的项目根目录路径
 */
export function setProjectRoot(cwd: string): void {
  STATE.projectRoot = cwd.normalize('NFC')
}

/**
 * 获取当前工作目录状态
 * 
 * 返回当前活跃的工作目录，这个目录可能在会话过程中发生变化。
 * 用于文件操作和路径解析的当前上下文。
 * 
 * 使用场景：
 * - 文件操作路径基准
 * - 用户导航追踪
 * - 相对路径解析
 * 
 * @returns 当前工作目录的绝对路径
 */
export function getCwdState(): string {
  return STATE.cwd
}

/**
 * 设置当前工作目录状态
 * 
 * 用于更改当前工作目录，通常在用户导航或路径切换时调用。
 * 确保路径格式正确并更新相关状态。
 * 
 * @param cwd 新的当前工作目录路径
 */
export function setCwdState(cwd: string): void {
  STATE.cwd = cwd.normalize('NFC')
}
export function getDirectConnectServerUrl(): string | undefined {
  return STATE.directConnectServerUrl
}

export function setDirectConnectServerUrl(url: string): void {
  STATE.directConnectServerUrl = url
}

/**
 * 添加API耗时统计到总计时器
 * 
 * 这个函数用于记录API调用的耗时，区分包含重试和不包含重试的两种情况。
 * 主要用于性能监控和成本计算，帮助分析API调用的效率。
 * 
 * 使用场景：
 * - API性能分析
 * - 成本计算基准
 * - 重试机制效果评估
 * 
 * @param duration 总API耗时（包含重试）
 * @param durationWithoutRetries 排除重试的API耗时
 */
export function addToTotalDurationState(
  duration: number,
  durationWithoutRetries: number,
): void {
  STATE.totalAPIDuration += duration
  STATE.totalAPIDurationWithoutRetries += durationWithoutRetries
}

/**
 * 重置总耗时和成本状态（仅限测试使用）
 * 
 * 这个函数专门用于测试环境，重置所有性能统计和成本追踪状态。
 * 在生产环境中调用会抛出错误，确保不会意外重置用户会话数据。
 * 
 * 注意：此函数仅应在测试环境中使用
 */
export function resetTotalDurationStateAndCost_FOR_TESTS_ONLY(): void {
  STATE.totalAPIDuration = 0
  STATE.totalAPIDurationWithoutRetries = 0
  STATE.totalCostUSD = 0
}

/**
 * 添加成本统计到总成本并记录模型使用情况
 * 
 * 这个函数用于累积会话总成本，并记录每个模型的详细使用情况。
 * 支持按模型细分的成本分析，帮助用户了解不同模型的使用成本。
 * 
 * 使用场景：
 * - 会话成本追踪
 * - 模型使用分析
 * - 成本优化决策
 * 
 * @param cost 本次调用的成本（美元）
 * @param modelUsage 模型使用详情（输入/输出Token数等）
 * @param model 模型名称标识符
 */
export function addToTotalCostState(
  cost: number,
  modelUsage: ModelUsage,
  model: string,
): void {
  STATE.modelUsage[model] = modelUsage
  STATE.totalCostUSD += cost
}

/**
 * 获取会话总成本（美元）
 * 
 * 返回当前会话累计的API使用总成本，用于用户成本展示和预算控制。
 * 
 * @returns 会话总成本（美元）
 */
export function getTotalCostUSD(): number {
  return STATE.totalCostUSD
}

/**
 * 获取API总耗时（包含重试）
 * 
 * 返回所有API调用的累计耗时，包括重试的时间。
 * 用于整体性能分析和用户体验评估。
 * 
 * @returns API总耗时（毫秒）
 */
export function getTotalAPIDuration(): number {
  return STATE.totalAPIDuration
}

/**
 * 获取会话总时长（从开始到现在）
 * 
 * 返回会话从开始到当前时刻的总时长，用于会话活跃时间统计。
 * 
 * @returns 会话总时长（毫秒）
 */
export function getTotalDuration(): number {
  return Date.now() - STATE.startTime
}

/**
 * 获取API总耗时（排除重试）
 * 
 * 返回成功API调用的累计耗时，排除重试的时间。
 * 用于评估API服务的实际响应性能。
 * 
 * @returns 排除重试的API总耗时（毫秒）
 */
export function getTotalAPIDurationWithoutRetries(): number {
  return STATE.totalAPIDurationWithoutRetries
}

/**
 * 获取工具执行总耗时
 * 
 * 返回所有工具调用的累计执行时间，用于分析工具性能。
 * 
 * @returns 工具执行总耗时（毫秒）
 */
export function getTotalToolDuration(): number {
  return STATE.totalToolDuration
}

/**
 * 添加工具执行耗时统计
 * 
 * 记录单个工具调用的执行时间，并更新当前轮次的工具统计。
 * 
 * 使用场景：
 * - 工具性能监控
 * - 轮次统计更新
 * - 性能瓶颈分析
 * 
 * @param duration 工具执行耗时（毫秒）
 */
export function addToToolDuration(duration: number): void {
  STATE.totalToolDuration += duration
  STATE.turnToolDurationMs += duration
  STATE.turnToolCount++
}

/**
 * 获取当前轮次Hook执行耗时
 * 
 * 返回本轮会话中所有Hook调用的累计执行时间。
 * 
 * @returns 当前轮次Hook耗时（毫秒）
 */
export function getTurnHookDurationMs(): number {
  return STATE.turnHookDurationMs
}

/**
 * 添加Hook执行耗时到当前轮次统计
 * 
 * 记录单个Hook调用的执行时间，并更新当前轮次的Hook统计。
 * 
 * @param duration Hook执行耗时（毫秒）
 */
export function addToTurnHookDuration(duration: number): void {
  STATE.turnHookDurationMs += duration
  STATE.turnHookCount++
}

/**
 * 重置当前轮次Hook统计
 * 
 * 在轮次开始时或轮次切换时调用，清空当前轮次的Hook统计。
 */
export function resetTurnHookDuration(): void {
  STATE.turnHookDurationMs = 0
  STATE.turnHookCount = 0
}

/**
 * 获取当前轮次Hook调用次数
 * 
 * 返回本轮会话中Hook调用的总次数。
 * 
 * @returns Hook调用次数
 */
export function getTurnHookCount(): number {
  return STATE.turnHookCount
}

/**
 * 获取当前轮次工具执行耗时
 * 
 * 返回本轮会话中所有工具调用的累计执行时间。
 * 
 * @returns 当前轮次工具耗时（毫秒）
 */
export function getTurnToolDurationMs(): number {
  return STATE.turnToolDurationMs
}

/**
 * 重置当前轮次工具统计
 * 
 * 在轮次开始时或轮次切换时调用，清空当前轮次的工具统计。
 */
export function resetTurnToolDuration(): void {
  STATE.turnToolDurationMs = 0
  STATE.turnToolCount = 0
}

/**
 * 获取当前轮次工具调用次数
 * 
 * 返回本轮会话中工具调用的总次数。
 * 
 * @returns 工具调用次数
 */
export function getTurnToolCount(): number {
  return STATE.turnToolCount
}

/**
 * 获取当前轮次分类器执行耗时
 * 
 * 返回本轮会话中所有分类器调用的累计执行时间。
 * 
 * @returns 当前轮次分类器耗时（毫秒）
 */
export function getTurnClassifierDurationMs(): number {
  return STATE.turnClassifierDurationMs
}

/**
 * 添加分类器执行耗时到当前轮次统计
 * 
 * 记录单个分类器调用的执行时间，并更新当前轮次的分类器统计。
 * 
 * @param duration 分类器执行耗时（毫秒）
 */
export function addToTurnClassifierDuration(duration: number): void {
  STATE.turnClassifierDurationMs += duration
  STATE.turnClassifierCount++
}

/**
 * 重置当前轮次分类器统计
 * 
 * 在轮次开始时或轮次切换时调用，清空当前轮次的分类器统计。
 */
export function resetTurnClassifierDuration(): void {
  STATE.turnClassifierDurationMs = 0
  STATE.turnClassifierCount = 0
}

/**
 * 获取当前轮次分类器调用次数
 * 
 * 返回本轮会话中分类器调用的总次数。
 * 
 * @returns 分类器调用次数
 */
export function getTurnClassifierCount(): number {
  return STATE.turnClassifierCount
}

/**
 * 获取统计存储接口
 * 
 * 返回统计存储接口实例，用于观测指标值。
 * 如果未设置统计存储，返回null。
 * 
 * @returns 统计存储接口或null
 */
export function getStatsStore(): {
  observe(name: string, value: number): void
} | null {
  return STATE.statsStore
}

/**
 * 设置统计存储接口
 * 
 * 设置统计存储接口实例，用于指标观测。
 * 
 * @param store 统计存储接口实例，null表示禁用统计存储
 */
export function setStatsStore(
  store: { observe(name: string, value: number): void } | null,
): void {
  STATE.statsStore = store
}

// ==================== 交互时间管理 ====================

/**
 * 交互时间脏标记 - 表示有未刷新的交互时间
 * 
 * 用于批量处理交互时间更新，避免每次按键都调用Date.now()
 */
let interactionTimeDirty = false

/**
 * 标记交互发生并更新最后交互时间
 * 
 * 默认情况下，实际的Date.now()调用会延迟到下一个Ink渲染帧
 * （通过flushInteractionTime()），避免每次按键都调用Date.now()。
 * 
 * 当从React useEffect回调或其他在Ink渲染周期已经刷新后运行的代码中调用时，
 * 传递`immediate = true`。如果没有此设置，时间戳会保持陈旧直到下一次渲染，
 * 如果用户空闲（例如权限对话框等待输入），可能永远不会到来。
 * 
 * @param immediate 是否立即刷新交互时间（true = 立即，false = 延迟）
 */
export function updateLastInteractionTime(immediate?: boolean): void {
  if (immediate) {
    flushInteractionTime_inner()
  } else {
    interactionTimeDirty = true
  }
}

/**
 * 刷新交互时间
 * 
 * 如果自上次刷新后记录了交互，立即更新时间戳。
 * 由Ink在每个渲染周期前调用，将多次按键批量处理为单个Date.now()调用。
 */
export function flushInteractionTime(): void {
  if (interactionTimeDirty) {
    flushInteractionTime_inner()
  }
}

/**
 * 内部交互时间刷新函数
 * 
 * 实际更新最后交互时间并重置脏标记。
 */
function flushInteractionTime_inner(): void {
  STATE.lastInteractionTime = Date.now()
  interactionTimeDirty = false
}

/**
 * 添加代码行数变更统计
 * 
 * 记录代码编辑操作中新增和删除的行数。
 * 用于统计代码修改量和生产力分析。
 * 
 * @param added 新增代码行数
 * @param removed 删除代码行数
 */
export function addToTotalLinesChanged(added: number, removed: number): void {
  STATE.totalLinesAdded += added
  STATE.totalLinesRemoved += removed
}

/**
 * 获取总新增代码行数
 * 
 * 返回会话中所有代码编辑操作累计新增的行数。
 * 
 * @returns 总新增代码行数
 */
export function getTotalLinesAdded(): number {
  return STATE.totalLinesAdded
}

/**
 * 获取总删除代码行数
 * 
 * 返回会话中所有代码编辑操作累计删除的行数。
 * 
 * @returns 总删除代码行数
 */
export function getTotalLinesRemoved(): number {
  return STATE.totalLinesRemoved
}

/**
 * 获取总输入Token数
 * 
 * 返回所有模型调用累计的输入Token数量。
 * 
 * @returns 总输入Token数
 */
export function getTotalInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'inputTokens')
}

/**
 * 获取总输出Token数
 * 
 * 返回所有模型调用累计的输出Token数量。
 * 
 * @returns 总输出Token数
 */
export function getTotalOutputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'outputTokens')
}

/**
 * 获取缓存读取输入Token数
 * 
 * 返回缓存读取操作累计的输入Token数量。
 * 
 * @returns 缓存读取输入Token数
 */
export function getTotalCacheReadInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'cacheReadInputTokens')
}

/**
 * 获取缓存创建输入Token数
 * 
 * 返回缓存创建操作累计的输入Token数量。
 * 
 * @returns 缓存创建输入Token数
 */
export function getTotalCacheCreationInputTokens(): number {
  return sumBy(Object.values(STATE.modelUsage), 'cacheCreationInputTokens')
}

/**
 * 获取总Web搜索请求数
 * 
 * 返回所有模型调用累计的Web搜索请求数量。
 * 
 * @returns Web搜索请求数
 */
export function getTotalWebSearchRequests(): number {
  return sumBy(Object.values(STATE.modelUsage), 'webSearchRequests')
}

// ==================== Token预算管理 ====================

/**
 * 轮次开始时输出Token基准值
 * 
 * 用于计算当前轮次的输出Token使用量
 */
let outputTokensAtTurnStart = 0

/**
 * 当前轮次Token预算
 * 
 * 记录当前轮次分配的Token预算，null表示无预算限制
 */
let currentTurnTokenBudget: number | null = null

/**
 * 获取当前轮次输出Token使用量
 * 
 * 返回当前轮次开始后使用的输出Token数量。
 * 
 * @returns 当前轮次输出Token数
 */
export function getTurnOutputTokens(): number {
  return getTotalOutputTokens() - outputTokensAtTurnStart
}

/**
 * 获取当前轮次Token预算
 * 
 * 返回当前轮次分配的Token预算，null表示无预算限制。
 * 
 * @returns Token预算值或null
 */
export function getCurrentTurnTokenBudget(): number | null {
  return currentTurnTokenBudget
}

/**
 * 预算延续次数计数器
 * 
 * 记录Token预算延续的次数
 */
let budgetContinuationCount = 0

/**
 * 为当前轮次快照Token状态
 * 
 * 在轮次开始时调用，记录Token基准值和预算设置。
 * 
 * @param budget 当前轮次Token预算，null表示无限制
 */
export function snapshotOutputTokensForTurn(budget: number | null): void {
  outputTokensAtTurnStart = getTotalOutputTokens()
  currentTurnTokenBudget = budget
  budgetContinuationCount = 0
}

/**
 * 获取预算延续次数
 * 
 * 返回当前轮次Token预算延续的次数。
 * 
 * @returns 预算延续次数
 */
export function getBudgetContinuationCount(): number {
  return budgetContinuationCount
}

/**
 * 增加预算延续次数
 * 
 * 当Token预算需要延续时调用此函数。
 */
export function incrementBudgetContinuationCount(): void {
  budgetContinuationCount++
}

/**
 * 设置未知模型成本标志
 * 
 * 标记会话中存在未知模型的成本计算，用于成本计算容错。
 */
export function setHasUnknownModelCost(): void {
  STATE.hasUnknownModelCost = true
}

/**
 * 检查是否存在未知模型成本
 * 
 * 返回是否存在未知模型的成本计算。
 * 
 * @returns 是否存在未知模型成本
 */
export function hasUnknownModelCost(): boolean {
  return STATE.hasUnknownModelCost
}

/**
 * 获取最后主请求ID
 * 
 * 返回最后主请求的ID，用于缓存失效提示。
 * 
 * @returns 最后主请求ID
 */
export function getLastMainRequestId(): string | undefined {
  return STATE.lastMainRequestId
}

/**
 * 设置最后主请求ID
 * 
 * 记录最后主请求的ID，用于缓存管理。
 * 
 * @param requestId 主请求ID
 */
export function setLastMainRequestId(requestId: string): void {
  STATE.lastMainRequestId = requestId
}

/**
 * 获取最后API完成时间戳
 * 
 * 返回最后API调用完成的时间戳，用于计算缓存空闲时间。
 * 
 * @returns 最后API完成时间戳
 */
export function getLastApiCompletionTimestamp(): number | null {
  return STATE.lastApiCompletionTimestamp
}

/**
 * 设置最后API完成时间戳
 * 
 * 记录最后API调用完成的时间戳。
 * 
 * @param timestamp API完成时间戳
 */
export function setLastApiCompletionTimestamp(timestamp: number): void {
  STATE.lastApiCompletionTimestamp = timestamp
}

/**
 * 标记压缩后状态
 * 
 * 标记刚刚发生了压缩操作。下一个API成功事件将包含isPostCompaction=true，
 * 然后标志自动重置。
 */
export function markPostCompaction(): void {
  STATE.pendingPostCompaction = true
}

/**
 * 消费压缩后标志
 * 
 * 消费压缩后标志。在压缩后返回true一次，然后返回false直到下一次压缩。
 * 
 * @returns 是否在压缩后状态
 */
export function consumePostCompaction(): boolean {
  const was = STATE.pendingPostCompaction
  STATE.pendingPostCompaction = false
  return was
}

/**
 * 获取最后交互时间
 * 
 * 返回最后用户交互的时间戳，用于空闲检测和会话管理。
 * 
 * @returns 最后交互时间戳
 */
export function getLastInteractionTime(): number {
  return STATE.lastInteractionTime
}

// ==================== 滚动管理 ====================

/**
 * 滚动排空标志 - 防止后台任务与滚动帧竞争事件循环
 * 
 * 由ScrollBox的scrollBy/scrollTo设置，在最后一次滚动事件后SCROLL_DRAIN_IDLE_MS毫秒清除。
 * 模块作用域（不在STATE中）- 短暂的热路径标志，不需要测试重置，因为防抖计时器会自清除。
 */
let scrollDraining = false
let scrollDrainTimer: ReturnType<typeof setTimeout> | undefined
const SCROLL_DRAIN_IDLE_MS = 150

/**
 * 标记滚动活动发生
 * 
 * 当滚动事件发生时调用此函数。后台间隔任务会检查getIsScrollDraining()，
 * 并在防抖清除之前跳过它们的工作。
 * 
 * 使用场景：
 * - 滚动期间暂停后台任务
 * - 优化滚动性能
 * - 防止滚动卡顿
 */
export function markScrollActivity(): void {
  scrollDraining = true
  if (scrollDrainTimer) clearTimeout(scrollDrainTimer)
  scrollDrainTimer = setTimeout(() => {
    scrollDraining = false
    scrollDrainTimer = undefined
  }, SCROLL_DRAIN_IDLE_MS)
  scrollDrainTimer.unref?.()
}

/**
 * 检查是否正在滚动排空
 * 
 * 返回滚动是否正在积极排空（在最后一次事件后150毫秒内）。
 * 间隔任务应该在此标志设置时提前返回——工作会在滚动稳定后在下个tick继续。
 * 
 * @returns 是否正在滚动排空
 */
export function getIsScrollDraining(): boolean {
  return scrollDraining
}

/**
 * 等待滚动空闲
 * 
 * 在可能伴随滚动的昂贵一次性工作（网络、子进程）之前等待此函数。
 * 如果不滚动则立即解析；否则在空闲间隔轮询直到标志清除。
 * 
 * @returns Promise，在滚动空闲时解析
 */
export async function waitForScrollIdle(): Promise<void> {
  while (scrollDraining) {
    // bootstrap-isolation禁止从src/utils/导入sleep()
    // eslint-disable-next-line no-restricted-syntax
    await new Promise(r => setTimeout(r, SCROLL_DRAIN_IDLE_MS).unref?.())
  }
}

// ==================== 模型使用统计 ====================

/**
 * 获取所有模型的使用情况统计
 * 
 * 返回按模型名称索引的使用情况对象，包含每个模型的详细使用数据。
 * 
 * @returns 模型使用情况统计对象
 */
export function getModelUsage(): { [modelName: string]: ModelUsage } {
  return STATE.modelUsage
}

/**
 * 获取特定模型的使用情况
 * 
 * 返回指定模型的使用情况统计，如果该模型未被使用则返回undefined。
 * 
 * @param model 模型名称
 * @returns 模型使用情况或undefined
 */
export function getUsageForModel(model: string): ModelUsage | undefined {
  return STATE.modelUsage[model]
}

// ==================== 模型配置管理 ====================

/**
 * 获取主循环模型覆盖设置
 * 
 * 返回从--model CLI标志或用户更新配置模型后设置的模型覆盖。
 * 
 * @returns 模型覆盖设置或undefined
 */
export function getMainLoopModelOverride(): ModelSetting | undefined {
  return STATE.mainLoopModelOverride
}

/**
 * 获取初始主循环模型
 * 
 * 返回会话启动时的默认主循环模型设置。
 * 
 * @returns 初始主循环模型
 */
export function getInitialMainLoopModel(): ModelSetting {
  return STATE.initialMainLoopModel
}

/**
 * 设置主循环模型覆盖
 * 
 * 设置主循环模型覆盖，用于CLI标志或用户配置更新。
 * 
 * @param model 模型设置或undefined（清除覆盖）
 */
export function setMainLoopModelOverride(
  model: ModelSetting | undefined,
): void {
  STATE.mainLoopModelOverride = model
}

/**
 * 设置初始主循环模型
 * 
 * 设置会话启动时的默认主循环模型。
 * 
 * @param model 初始模型设置
 */
export function setInitialMainLoopModel(model: ModelSetting): void {
  STATE.initialMainLoopModel = model
}

/**
 * 获取SDK提供的beta功能列表
 * 
 * 返回SDK提供的beta功能列表，用于启用实验性功能。
 * 
 * @returns beta功能列表或undefined
 */
export function getSdkBetas(): string[] | undefined {
  return STATE.sdkBetas
}

/**
 * 设置SDK beta功能列表
 * 
 * 设置SDK提供的beta功能列表。
 * 
 * @param betas beta功能列表或undefined
 */
export function setSdkBetas(betas: string[] | undefined): void {
  STATE.sdkBetas = betas
}

/**
 * 重置成本状态
 * 
 * 重置所有成本相关统计到初始状态，用于会话重置或测试。
 */
export function resetCostState(): void {
  STATE.totalCostUSD = 0
  STATE.totalAPIDuration = 0
  STATE.totalAPIDurationWithoutRetries = 0
  STATE.totalToolDuration = 0
  STATE.startTime = Date.now()
  STATE.totalLinesAdded = 0
  STATE.totalLinesRemoved = 0
  STATE.hasUnknownModelCost = false
  STATE.modelUsage = {}
  STATE.promptId = null
}

/**
 * 为会话恢复设置成本状态值
 * 
 * 由cost-tracker.ts中的restoreCostStateForSession调用，用于会话恢复时恢复成本统计。
 * 
 * @param params 成本状态参数对象
 * @param params.totalCostUSD 总成本
 * @param params.totalAPIDuration API总耗时
 * @param params.totalAPIDurationWithoutRetries 排除重试的API耗时
 * @param params.totalToolDuration 工具总耗时
 * @param params.totalLinesAdded 总新增行数
 * @param params.totalLinesRemoved 总删除行数
 * @param params.lastDuration 最后持续时间
 * @param params.modelUsage 模型使用情况
 */
export function setCostStateForRestore({
  totalCostUSD,
  totalAPIDuration,
  totalAPIDurationWithoutRetries,
  totalToolDuration,
  totalLinesAdded,
  totalLinesRemoved,
  lastDuration,
  modelUsage,
}: {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
}): void {
  STATE.totalCostUSD = totalCostUSD
  STATE.totalAPIDuration = totalAPIDuration
  STATE.totalAPIDurationWithoutRetries = totalAPIDurationWithoutRetries
  STATE.totalToolDuration = totalToolDuration
  STATE.totalLinesAdded = totalLinesAdded
  STATE.totalLinesRemoved = totalLinesRemoved

  // 恢复按模型细分的成本统计
  if (modelUsage) {
    STATE.modelUsage = modelUsage
  }

  // 调整开始时间以使挂钟持续时间累积
  if (lastDuration) {
    STATE.startTime = Date.now() - lastDuration
  }
}

/**
 * 重置状态用于测试（仅限测试使用）
 * 
 * 这个函数只能在测试环境中调用，用于重置全局状态到初始值。
 * 在生产环境中调用会抛出错误。
 */
export function resetStateForTests(): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetStateForTests can only be called in tests')
  }
  Object.entries(getInitialState()).forEach(([key, value]) => {
    STATE[key as keyof State] = value as never
  })
  outputTokensAtTurnStart = 0
  currentTurnTokenBudget = null
  budgetContinuationCount = 0
  sessionSwitched.clear()
}

/**
 * 获取模型字符串配置
 * 
 * 返回模型字符串配置，包含模型名称和描述的本地化映射。
 * 不应该直接使用此函数，请参考src/utils/model/modelStrings.ts::getModelStrings()
 * 
 * @returns 模型字符串配置或null
 */
export function getModelStrings(): ModelStrings | null {
  return STATE.modelStrings
}

/**
 * 设置模型字符串配置
 * 
 * 设置模型字符串配置。不应该直接使用此函数，请参考src/utils/model/modelStrings.ts
 * 
 * @param modelStrings 模型字符串配置
 */
export function setModelStrings(modelStrings: ModelStrings): void {
  STATE.modelStrings = modelStrings
}

/**
 * 重置模型字符串用于测试（仅限测试使用）
 * 
 * 测试工具函数，用于重置模型字符串以便重新初始化。
 * 与setModelStrings分开，因为我们只希望在测试中接受'null'。
 */
export function resetModelStringsForTestingOnly() {
  STATE.modelStrings = null
}

// ==================== OpenTelemetry监控配置 ====================

/**
 * 设置Meter实例和计数器工厂
 * 
 * 设置OpenTelemetry Meter实例，并使用提供的工厂初始化所有计数器。
 * 
 * @param meter Meter实例
 * @param createCounter 计数器工厂函数
 */
export function setMeter(
  meter: Meter,
  createCounter: (name: string, options: MetricOptions) => AttributedCounter,
): void {
  STATE.meter = meter

  // 使用提供的工厂初始化所有计数器
  STATE.sessionCounter = createCounter('claude_code.session.count', {
    description: 'Count of CLI sessions started',
  })
  STATE.locCounter = createCounter('claude_code.lines_of_code.count', {
    description:
      "Count of lines of code modified, with the 'type' attribute indicating whether lines were added or removed",
  })
  STATE.prCounter = createCounter('claude_code.pull_request.count', {
    description: 'Number of pull requests created',
  })
  STATE.commitCounter = createCounter('claude_code.commit.count', {
    description: 'Number of git commits created',
  })
  STATE.costCounter = createCounter('claude_code.cost.usage', {
    description: 'Cost of the Claude Code session',
    unit: 'USD',
  })
  STATE.tokenCounter = createCounter('claude_code.token.usage', {
    description: 'Number of tokens used',
    unit: 'tokens',
  })
  STATE.codeEditToolDecisionCounter = createCounter(
    'claude_code.code_edit_tool.decision',
    {
      description:
        'Count of code editing tool permission decisions (accept/reject) for Edit, Write, and NotebookEdit tools',
    },
  )
  STATE.activeTimeCounter = createCounter('claude_code.active_time.total', {
    description: 'Total active time in seconds',
    unit: 's',
  })
}

/**
 * 获取Meter实例
 * 
 * 返回OpenTelemetry Meter实例，如果未设置则返回null。
 * 
 * @returns Meter实例或null
 */
export function getMeter(): Meter | null {
  return STATE.meter
}

/**
 * 获取会话计数器
 * 
 * 返回会话计数器实例，用于统计CLI会话启动次数。
 * 
 * @returns 会话计数器或null
 */
export function getSessionCounter(): AttributedCounter | null {
  return STATE.sessionCounter
}

/**
 * 获取代码行数计数器
 * 
 * 返回代码行数计数器实例，用于统计修改的代码行数。
 * 
 * @returns 代码行数计数器或null
 */
export function getLocCounter(): AttributedCounter | null {
  return STATE.locCounter
}

/**
 * 获取拉取请求计数器
 * 
 * 返回拉取请求计数器实例，用于统计创建的PR数量。
 * 
 * @returns 拉取请求计数器或null
 */
export function getPrCounter(): AttributedCounter | null {
  return STATE.prCounter
}

/**
 * 获取提交计数器
 * 
 * 返回提交计数器实例，用于统计Git提交次数。
 * 
 * @returns 提交计数器或null
 */
export function getCommitCounter(): AttributedCounter | null {
  return STATE.commitCounter
}

/**
 * 获取成本计数器
 * 
 * 返回成本计数器实例，用于统计会话成本。
 * 
 * @returns 成本计数器或null
 */
export function getCostCounter(): AttributedCounter | null {
  return STATE.costCounter
}

/**
 * 获取Token计数器
 * 
 * 返回Token计数器实例，用于统计Token使用量。
 * 
 * @returns Token计数器或null
 */
export function getTokenCounter(): AttributedCounter | null {
  return STATE.tokenCounter
}

/**
 * 获取代码编辑工具决策计数器
 * 
 * 返回代码编辑工具决策计数器实例，用于统计代码编辑工具权限决策。
 * 
 * @returns 代码编辑工具决策计数器或null
 */
export function getCodeEditToolDecisionCounter(): AttributedCounter | null {
  return STATE.codeEditToolDecisionCounter
}

/**
 * 获取活跃时间计数器
 * 
 * 返回活跃时间计数器实例，用于统计总活跃时间。
 * 
 * @returns 活跃时间计数器或null
 */
export function getActiveTimeCounter(): AttributedCounter | null {
  return STATE.activeTimeCounter
}

/**
 * 获取日志提供者实例
 * 
 * 返回日志提供者实例，如果未设置则返回null。
 * 
 * @returns 日志提供者或null
 */
export function getLoggerProvider(): LoggerProvider | null {
  return STATE.loggerProvider
}

/**
 * 设置日志提供者实例
 * 
 * 设置日志提供者实例。
 * 
 * @param provider 日志提供者实例或null
 */
export function setLoggerProvider(provider: LoggerProvider | null): void {
  STATE.loggerProvider = provider
}

/**
 * 获取事件日志记录器
 * 
 * 返回事件日志记录器实例，如果未设置则返回null。
 * 
 * @returns 事件日志记录器或null
 */
export function getEventLogger(): ReturnType<typeof logs.getLogger> | null {
  return STATE.eventLogger
}

/**
 * 设置事件日志记录器
 * 
 * 设置事件日志记录器实例。
 * 
 * @param logger 事件日志记录器或null
 */
export function setEventLogger(
  logger: ReturnType<typeof logs.getLogger> | null,
): void {
  STATE.eventLogger = logger
}

/**
 * 获取Meter提供者实例
 * 
 * 返回Meter提供者实例，如果未设置则返回null。
 * 
 * @returns Meter提供者或null
 */
export function getMeterProvider(): MeterProvider | null {
  return STATE.meterProvider
}

/**
 * 设置Meter提供者实例
 * 
 * 设置Meter提供者实例。
 * 
 * @param provider Meter提供者实例或null
 */
export function setMeterProvider(provider: MeterProvider | null): void {
  STATE.meterProvider = provider
}

/**
 * 获取追踪器提供者实例
 * 
 * 返回追踪器提供者实例，如果未设置则返回null。
 * 
 * @returns 追踪器提供者或null
 */
export function getTracerProvider(): BasicTracerProvider | null {
  return STATE.tracerProvider
}

/**
 * 设置追踪器提供者实例
 * 
 * 设置追踪器提供者实例。
 * 
 * @param provider 追踪器提供者实例或null
 */
export function setTracerProvider(provider: BasicTracerProvider | null): void {
  STATE.tracerProvider = provider
}

// ==================== 功能开关和模式状态 ====================

/**
 * 检查是否为非交互会话
 * 
 * 返回当前会话是否为非交互模式。
 * 
 * @returns 是否为非交互会话
 */
export function getIsNonInteractiveSession(): boolean {
  return !STATE.isInteractive
}

/**
 * 检查是否为交互模式
 * 
 * 返回当前会话是否为交互模式。
 * 
 * @returns 是否为交互模式
 */
export function getIsInteractive(): boolean {
  return STATE.isInteractive
}

/**
 * 设置交互模式状态
 * 
 * 设置当前会话的交互模式状态。
 * 
 * @param value 交互模式状态
 */
export function setIsInteractive(value: boolean): void {
  STATE.isInteractive = value
}

/**
 * 获取客户端类型
 * 
 * 返回当前客户端类型标识符。
 * 
 * @returns 客户端类型
 */
export function getClientType(): string {
  return STATE.clientType
}

/**
 * 设置客户端类型
 * 
 * 设置当前客户端类型标识符。
 * 
 * @param type 客户端类型
 */
export function setClientType(type: string): void {
  STATE.clientType = type
}

/**
 * 检查SDK代理进度摘要是否启用
 * 
 * 返回SDK代理进度摘要功能是否启用。
 * 
 * @returns SDK代理进度摘要是否启用
 */
export function getSdkAgentProgressSummariesEnabled(): boolean {
  return STATE.sdkAgentProgressSummariesEnabled
}

/**
 * 设置SDK代理进度摘要启用状态
 * 
 * 设置SDK代理进度摘要功能的启用状态。
 * 
 * @param value 启用状态
 */
export function setSdkAgentProgressSummariesEnabled(value: boolean): void {
  STATE.sdkAgentProgressSummariesEnabled = value
}

/**
 * 检查Kairos功能是否激活
 * 
 * 返回Kairos高级功能是否激活。
 * 
 * @returns Kairos功能是否激活
 */
export function getKairosActive(): boolean {
  return STATE.kairosActive
}

/**
 * 设置Kairos功能激活状态
 * 
 * 设置Kairos高级功能的激活状态。
 * 
 * @param value 激活状态
 */
export function setKairosActive(value: boolean): void {
  STATE.kairosActive = value
}

/**
 * 检查严格工具结果配对模式是否启用
 * 
 * 返回严格工具结果配对模式是否启用。
 * 
 * @returns 严格工具结果配对是否启用
 */
export function getStrictToolResultPairing(): boolean {
  return STATE.strictToolResultPairing
}

/**
 * 设置严格工具结果配对模式
 * 
 * 设置严格工具结果配对模式的启用状态。
 * 
 * @param value 启用状态
 */
export function setStrictToolResultPairing(value: boolean): void {
  STATE.strictToolResultPairing = value
}

/**
 * 检查用户消息选择加入状态
 * 
 * 返回用户消息选择加入功能是否启用。
 * 字段名称'userMsgOptIn'避免排除字符串子串（'BriefTool', 'SendUserMessage' - 不区分大小写）。
 * 所有调用者都在feature()守卫内部，因此这些访问器不需要自己的守卫（与getKairosActive匹配）。
 * 
 * @returns 用户消息选择加入状态
 */
export function getUserMsgOptIn(): boolean {
  return STATE.userMsgOptIn
}

/**
 * 设置用户消息选择加入状态
 * 
 * 设置用户消息选择加入功能的启用状态。
 * 
 * @param value 选择加入状态
 */
export function setUserMsgOptIn(value: boolean): void {
  STATE.userMsgOptIn = value
}

/**
 * 获取会话来源标识
 * 
 * 返回会话来源标识符，如果未设置则返回undefined。
 * 
 * @returns 会话来源标识
 */
export function getSessionSource(): string | undefined {
  return STATE.sessionSource
}

/**
 * 设置会话来源标识
 * 
 * 设置会话来源标识符。
 * 
 * @param source 会话来源标识
 */
export function setSessionSource(source: string): void {
  STATE.sessionSource = source
}

/**
 * 获取问题预览格式
 * 
 * 返回问题预览的格式设置，如果未设置则返回undefined。
 * 
 * @returns 问题预览格式
 */
export function getQuestionPreviewFormat(): 'markdown' | 'html' | undefined {
  return STATE.questionPreviewFormat
}

/**
 * 设置问题预览格式
 * 
 * 设置问题预览的格式。
 * 
 * @param format 预览格式
 */
export function setQuestionPreviewFormat(format: 'markdown' | 'html'): void {
  STATE.questionPreviewFormat = format
}

/**
 * 获取代理颜色映射
 * 
 * 返回代理颜色映射实例，用于管理不同代理的显示颜色。
 * 
 * @returns 代理颜色映射
 */
export function getAgentColorMap(): Map<string, AgentColorName> {
  return STATE.agentColorMap
}

// ==================== 认证和配置状态 ====================

/**
 * 获取标志设置文件路径
 * 
 * 返回标志设置文件的路径，如果未设置则返回undefined。
 * 
 * @returns 标志设置文件路径
 */
export function getFlagSettingsPath(): string | undefined {
  return STATE.flagSettingsPath
}

/**
 * 设置标志设置文件路径
 * 
 * 设置标志设置文件的路径。
 * 
 * @param path 标志设置文件路径
 */
export function setFlagSettingsPath(path: string | undefined): void {
  STATE.flagSettingsPath = path
}

/**
 * 获取内联标志设置
 * 
 * 返回内联标志设置对象，如果未设置则返回null。
 * 
 * @returns 内联标志设置或null
 */
export function getFlagSettingsInline(): Record<string, unknown> | null {
  return STATE.flagSettingsInline
}

/**
 * 设置内联标志设置
 * 
 * 设置内联标志设置对象。
 * 
 * @param settings 内联标志设置或null
 */
export function setFlagSettingsInline(
  settings: Record<string, unknown> | null,
): void {
  STATE.flagSettingsInline = settings
}

/**
 * 获取会话入口令牌
 * 
 * 返回会话入口令牌，用于会话身份验证。
 * 
 * @returns 会话入口令牌
 */
export function getSessionIngressToken(): string | null | undefined {
  return STATE.sessionIngressToken
}

/**
 * 设置会话入口令牌
 * 
 * 设置会话入口令牌。
 * 
 * @param token 会话入口令牌
 */
export function setSessionIngressToken(token: string | null): void {
  STATE.sessionIngressToken = token
}

/**
 * 获取从文件描述符读取的OAuth令牌
 * 
 * 返回从文件描述符读取的OAuth令牌。
 * 
 * @returns OAuth令牌
 */
export function getOauthTokenFromFd(): string | null | undefined {
  return STATE.oauthTokenFromFd
}

/**
 * 设置从文件描述符读取的OAuth令牌
 * 
 * 设置从文件描述符读取的OAuth令牌。
 * 
 * @param token OAuth令牌
 */
export function setOauthTokenFromFd(token: string | null): void {
  STATE.oauthTokenFromFd = token
}

/**
 * 获取从文件描述符读取的API密钥
 * 
 * 返回从文件描述符读取的API密钥。
 * 
 * @returns API密钥
 */
export function getApiKeyFromFd(): string | null | undefined {
  return STATE.apiKeyFromFd
}

/**
 * 设置从文件描述符读取的API密钥
 * 
 * 设置从文件描述符读取的API密钥。
 * 
 * @param key API密钥
 */
export function setApiKeyFromFd(key: string | null): void {
  STATE.apiKeyFromFd = key
}

export function setLastAPIRequest(
  params: Omit<BetaMessageStreamParams, 'messages'> | null,
): void {
  STATE.lastAPIRequest = params
}

export function getLastAPIRequest(): Omit<
  BetaMessageStreamParams,
  'messages'
> | null {
  return STATE.lastAPIRequest
}

export function setLastAPIRequestMessages(
  messages: BetaMessageStreamParams['messages'] | null,
): void {
  STATE.lastAPIRequestMessages = messages
}

export function getLastAPIRequestMessages():
  | BetaMessageStreamParams['messages']
  | null {
  return STATE.lastAPIRequestMessages
}

export function setLastClassifierRequests(requests: unknown[] | null): void {
  STATE.lastClassifierRequests = requests
}

export function getLastClassifierRequests(): unknown[] | null {
  return STATE.lastClassifierRequests
}

export function setCachedClaudeMdContent(content: string | null): void {
  STATE.cachedClaudeMdContent = content
}

export function getCachedClaudeMdContent(): string | null {
  return STATE.cachedClaudeMdContent
}

export function addToInMemoryErrorLog(errorInfo: {
  error: string
  timestamp: string
}): void {
  const MAX_IN_MEMORY_ERRORS = 100
  if (STATE.inMemoryErrorLog.length >= MAX_IN_MEMORY_ERRORS) {
    STATE.inMemoryErrorLog.shift() // Remove oldest error
  }
  STATE.inMemoryErrorLog.push(errorInfo)
}

export function getAllowedSettingSources(): SettingSource[] {
  return STATE.allowedSettingSources
}

export function setAllowedSettingSources(sources: SettingSource[]): void {
  STATE.allowedSettingSources = sources
}

export function preferThirdPartyAuthentication(): boolean {
  // IDE extension should behave as 1P for authentication reasons.
  return getIsNonInteractiveSession() && STATE.clientType !== 'claude-vscode'
}

export function setInlinePlugins(plugins: Array<string>): void {
  STATE.inlinePlugins = plugins
}

export function getInlinePlugins(): Array<string> {
  return STATE.inlinePlugins
}

export function setChromeFlagOverride(value: boolean | undefined): void {
  STATE.chromeFlagOverride = value
}

export function getChromeFlagOverride(): boolean | undefined {
  return STATE.chromeFlagOverride
}

export function setUseCoworkPlugins(value: boolean): void {
  STATE.useCoworkPlugins = value
  resetSettingsCache()
}

export function getUseCoworkPlugins(): boolean {
  return STATE.useCoworkPlugins
}

export function setSessionBypassPermissionsMode(enabled: boolean): void {
  STATE.sessionBypassPermissionsMode = enabled
}

export function getSessionBypassPermissionsMode(): boolean {
  return STATE.sessionBypassPermissionsMode
}

export function setScheduledTasksEnabled(enabled: boolean): void {
  STATE.scheduledTasksEnabled = enabled
}

export function getScheduledTasksEnabled(): boolean {
  return STATE.scheduledTasksEnabled
}

export type SessionCronTask = {
  id: string
  cron: string
  prompt: string
  createdAt: number
  recurring?: boolean
  /**
   * When set, the task was created by an in-process teammate (not the team lead).
   * The scheduler routes fires to that teammate's pendingUserMessages queue
   * instead of the main REPL command queue. Session-only — never written to disk.
   */
  agentId?: string
}

export function getSessionCronTasks(): SessionCronTask[] {
  return STATE.sessionCronTasks
}

export function addSessionCronTask(task: SessionCronTask): void {
  STATE.sessionCronTasks.push(task)
}

/**
 * Returns the number of tasks actually removed. Callers use this to skip
 * downstream work (e.g. the disk read in removeCronTasks) when all ids
 * were accounted for here.
 */
export function removeSessionCronTasks(ids: readonly string[]): number {
  if (ids.length === 0) return 0
  const idSet = new Set(ids)
  const remaining = STATE.sessionCronTasks.filter(t => !idSet.has(t.id))
  const removed = STATE.sessionCronTasks.length - remaining.length
  if (removed === 0) return 0
  STATE.sessionCronTasks = remaining
  return removed
}

export function setSessionTrustAccepted(accepted: boolean): void {
  STATE.sessionTrustAccepted = accepted
}

export function getSessionTrustAccepted(): boolean {
  return STATE.sessionTrustAccepted
}

export function setSessionPersistenceDisabled(disabled: boolean): void {
  STATE.sessionPersistenceDisabled = disabled
}

export function isSessionPersistenceDisabled(): boolean {
  return STATE.sessionPersistenceDisabled
}

export function hasExitedPlanModeInSession(): boolean {
  return STATE.hasExitedPlanMode
}

export function setHasExitedPlanMode(value: boolean): void {
  STATE.hasExitedPlanMode = value
}

export function needsPlanModeExitAttachment(): boolean {
  return STATE.needsPlanModeExitAttachment
}

export function setNeedsPlanModeExitAttachment(value: boolean): void {
  STATE.needsPlanModeExitAttachment = value
}

export function handlePlanModeTransition(
  fromMode: string,
  toMode: string,
): void {
  // If switching TO plan mode, clear any pending exit attachment
  // This prevents sending both plan_mode and plan_mode_exit when user toggles quickly
  if (toMode === 'plan' && fromMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = false
  }

  // If switching out of plan mode, trigger the plan_mode_exit attachment
  if (fromMode === 'plan' && toMode !== 'plan') {
    STATE.needsPlanModeExitAttachment = true
  }
}

export function needsAutoModeExitAttachment(): boolean {
  return STATE.needsAutoModeExitAttachment
}

export function setNeedsAutoModeExitAttachment(value: boolean): void {
  STATE.needsAutoModeExitAttachment = value
}

export function handleAutoModeTransition(
  fromMode: string,
  toMode: string,
): void {
  // Auto↔plan transitions are handled by prepareContextForPlanMode (auto may
  // stay active through plan if opted in) and ExitPlanMode (restores mode).
  // Skip both directions so this function only handles direct auto transitions.
  if (
    (fromMode === 'auto' && toMode === 'plan') ||
    (fromMode === 'plan' && toMode === 'auto')
  ) {
    return
  }
  const fromIsAuto = fromMode === 'auto'
  const toIsAuto = toMode === 'auto'

  // If switching TO auto mode, clear any pending exit attachment
  // This prevents sending both auto_mode and auto_mode_exit when user toggles quickly
  if (toIsAuto && !fromIsAuto) {
    STATE.needsAutoModeExitAttachment = false
  }

  // If switching out of auto mode, trigger the auto_mode_exit attachment
  if (fromIsAuto && !toIsAuto) {
    STATE.needsAutoModeExitAttachment = true
  }
}

// LSP plugin recommendation session tracking
export function hasShownLspRecommendationThisSession(): boolean {
  return STATE.lspRecommendationShownThisSession
}

export function setLspRecommendationShownThisSession(value: boolean): void {
  STATE.lspRecommendationShownThisSession = value
}

// SDK init event state
export function setInitJsonSchema(schema: Record<string, unknown>): void {
  STATE.initJsonSchema = schema
}

export function getInitJsonSchema(): Record<string, unknown> | null {
  return STATE.initJsonSchema
}

export function registerHookCallbacks(
  hooks: Partial<Record<HookEvent, RegisteredHookMatcher[]>>,
): void {
  if (!STATE.registeredHooks) {
    STATE.registeredHooks = {}
  }

  // `registerHookCallbacks` may be called multiple times, so we need to merge (not overwrite)
  for (const [event, matchers] of Object.entries(hooks)) {
    const eventKey = event as HookEvent
    if (!STATE.registeredHooks[eventKey]) {
      STATE.registeredHooks[eventKey] = []
    }
    STATE.registeredHooks[eventKey]!.push(...matchers)
  }
}

export function getRegisteredHooks(): Partial<
  Record<HookEvent, RegisteredHookMatcher[]>
> | null {
  return STATE.registeredHooks
}

export function clearRegisteredHooks(): void {
  STATE.registeredHooks = null
}

export function clearRegisteredPluginHooks(): void {
  if (!STATE.registeredHooks) {
    return
  }

  const filtered: Partial<Record<HookEvent, RegisteredHookMatcher[]>> = {}
  for (const [event, matchers] of Object.entries(STATE.registeredHooks)) {
    // Keep only callback hooks (those without pluginRoot)
    const callbackHooks = matchers.filter(m => !('pluginRoot' in m))
    if (callbackHooks.length > 0) {
      filtered[event as HookEvent] = callbackHooks
    }
  }

  STATE.registeredHooks = Object.keys(filtered).length > 0 ? filtered : null
}

export function resetSdkInitState(): void {
  STATE.initJsonSchema = null
  STATE.registeredHooks = null
}

export function getPlanSlugCache(): Map<string, string> {
  return STATE.planSlugCache
}

export function getSessionCreatedTeams(): Set<string> {
  return STATE.sessionCreatedTeams
}

// Teleported session tracking for reliability logging
export function setTeleportedSessionInfo(info: {
  sessionId: string | null
}): void {
  STATE.teleportedSessionInfo = {
    isTeleported: true,
    hasLoggedFirstMessage: false,
    sessionId: info.sessionId,
  }
}

export function getTeleportedSessionInfo(): {
  isTeleported: boolean
  hasLoggedFirstMessage: boolean
  sessionId: string | null
} | null {
  return STATE.teleportedSessionInfo
}

export function markFirstTeleportMessageLogged(): void {
  if (STATE.teleportedSessionInfo) {
    STATE.teleportedSessionInfo.hasLoggedFirstMessage = true
  }
}

// Invoked skills tracking for preservation across compaction
export type InvokedSkillInfo = {
  skillName: string
  skillPath: string
  content: string
  invokedAt: number
  agentId: string | null
}

export function addInvokedSkill(
  skillName: string,
  skillPath: string,
  content: string,
  agentId: string | null = null,
): void {
  const key = `${agentId ?? ''}:${skillName}`
  STATE.invokedSkills.set(key, {
    skillName,
    skillPath,
    content,
    invokedAt: Date.now(),
    agentId,
  })
}

export function getInvokedSkills(): Map<string, InvokedSkillInfo> {
  return STATE.invokedSkills
}

export function getInvokedSkillsForAgent(
  agentId: string | undefined | null,
): Map<string, InvokedSkillInfo> {
  const normalizedId = agentId ?? null
  const filtered = new Map<string, InvokedSkillInfo>()
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === normalizedId) {
      filtered.set(key, skill)
    }
  }
  return filtered
}

export function clearInvokedSkills(
  preservedAgentIds?: ReadonlySet<string>,
): void {
  if (!preservedAgentIds || preservedAgentIds.size === 0) {
    STATE.invokedSkills.clear()
    return
  }
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === null || !preservedAgentIds.has(skill.agentId)) {
      STATE.invokedSkills.delete(key)
    }
  }
}

export function clearInvokedSkillsForAgent(agentId: string): void {
  for (const [key, skill] of STATE.invokedSkills) {
    if (skill.agentId === agentId) {
      STATE.invokedSkills.delete(key)
    }
  }
}

// Slow operations tracking for dev bar
const MAX_SLOW_OPERATIONS = 10
const SLOW_OPERATION_TTL_MS = 10000

export function addSlowOperation(operation: string, durationMs: number): void {
  if (process.env.USER_TYPE !== 'ant') return
  // Skip tracking for editor sessions (user editing a prompt file in $EDITOR)
  // These are intentionally slow since the user is drafting text
  if (operation.includes('exec') && operation.includes('claude-prompt-')) {
    return
  }
  const now = Date.now()
  // Remove stale operations
  STATE.slowOperations = STATE.slowOperations.filter(
    op => now - op.timestamp < SLOW_OPERATION_TTL_MS,
  )
  // Add new operation
  STATE.slowOperations.push({ operation, durationMs, timestamp: now })
  // Keep only the most recent operations
  if (STATE.slowOperations.length > MAX_SLOW_OPERATIONS) {
    STATE.slowOperations = STATE.slowOperations.slice(-MAX_SLOW_OPERATIONS)
  }
}

const EMPTY_SLOW_OPERATIONS: ReadonlyArray<{
  operation: string
  durationMs: number
  timestamp: number
}> = []

export function getSlowOperations(): ReadonlyArray<{
  operation: string
  durationMs: number
  timestamp: number
}> {
  // Most common case: nothing tracked. Return a stable reference so the
  // caller's setState() can bail via Object.is instead of re-rendering at 2fps.
  if (STATE.slowOperations.length === 0) {
    return EMPTY_SLOW_OPERATIONS
  }
  const now = Date.now()
  // Only allocate a new array when something actually expired; otherwise keep
  // the reference stable across polls while ops are still fresh.
  if (
    STATE.slowOperations.some(op => now - op.timestamp >= SLOW_OPERATION_TTL_MS)
  ) {
    STATE.slowOperations = STATE.slowOperations.filter(
      op => now - op.timestamp < SLOW_OPERATION_TTL_MS,
    )
    if (STATE.slowOperations.length === 0) {
      return EMPTY_SLOW_OPERATIONS
    }
  }
  // Safe to return directly: addSlowOperation() reassigns STATE.slowOperations
  // before pushing, so the array held in React state is never mutated.
  return STATE.slowOperations
}

export function getMainThreadAgentType(): string | undefined {
  return STATE.mainThreadAgentType
}

export function setMainThreadAgentType(agentType: string | undefined): void {
  STATE.mainThreadAgentType = agentType
}

export function getIsRemoteMode(): boolean {
  return STATE.isRemoteMode
}

export function setIsRemoteMode(value: boolean): void {
  STATE.isRemoteMode = value
}

// System prompt section accessors

export function getSystemPromptSectionCache(): Map<string, string | null> {
  return STATE.systemPromptSectionCache
}

export function setSystemPromptSectionCacheEntry(
  name: string,
  value: string | null,
): void {
  STATE.systemPromptSectionCache.set(name, value)
}

export function clearSystemPromptSectionState(): void {
  STATE.systemPromptSectionCache.clear()
}

// Last emitted date accessors (for detecting midnight date changes)

export function getLastEmittedDate(): string | null {
  return STATE.lastEmittedDate
}

export function setLastEmittedDate(date: string | null): void {
  STATE.lastEmittedDate = date
}

export function getAdditionalDirectoriesForClaudeMd(): string[] {
  return STATE.additionalDirectoriesForClaudeMd
}

export function setAdditionalDirectoriesForClaudeMd(
  directories: string[],
): void {
  STATE.additionalDirectoriesForClaudeMd = directories
}

export function getAllowedChannels(): ChannelEntry[] {
  return STATE.allowedChannels
}

export function setAllowedChannels(entries: ChannelEntry[]): void {
  STATE.allowedChannels = entries
}

export function getHasDevChannels(): boolean {
  return STATE.hasDevChannels
}

export function setHasDevChannels(value: boolean): void {
  STATE.hasDevChannels = value
}

export function getPromptCache1hAllowlist(): string[] | null {
  return STATE.promptCache1hAllowlist
}

export function setPromptCache1hAllowlist(allowlist: string[] | null): void {
  STATE.promptCache1hAllowlist = allowlist
}

export function getPromptCache1hEligible(): boolean | null {
  return STATE.promptCache1hEligible
}

export function setPromptCache1hEligible(eligible: boolean | null): void {
  STATE.promptCache1hEligible = eligible
}

export function getAfkModeHeaderLatched(): boolean | null {
  return STATE.afkModeHeaderLatched
}

export function setAfkModeHeaderLatched(v: boolean): void {
  STATE.afkModeHeaderLatched = v
}

export function getFastModeHeaderLatched(): boolean | null {
  return STATE.fastModeHeaderLatched
}

export function setFastModeHeaderLatched(v: boolean): void {
  STATE.fastModeHeaderLatched = v
}

// ==================== 缓存编辑头锁存器管理 ====================

/**
 * 获取缓存编辑头锁存器状态
 * 
 * 返回缓存编辑beta功能的头锁存器状态。当此功能被激活后，锁存器会保持true状态，
 * 确保后续请求继续包含缓存编辑头信息，直到会话重置。
 * 
 * 锁存器状态说明：
 * - null: 尚未触发，等待首次激活
 * - true: 已激活并锁存，持续发送头信息
 * - false: 已停用并锁存，停止发送头信息
 * 
 * @returns 缓存编辑头锁存器状态（null/true/false）
 */
export function getCacheEditingHeaderLatched(): boolean | null {
  return STATE.cacheEditingHeaderLatched
}

/**
 * 设置缓存编辑头锁存器状态
 * 
 * 设置缓存编辑beta功能的头锁存器状态。一旦设置，状态将保持直到会话重置。
 * 主要用于beta功能的持久化激活管理。
 * 
 * @param v 新的锁存器状态（true = 激活并锁存，false = 停用并锁存）
 */
export function setCacheEditingHeaderLatched(v: boolean): void {
  STATE.cacheEditingHeaderLatched = v
}

// ==================== 清除思考锁存器管理 ====================

/**
 * 获取清除思考锁存器状态
 * 
 * 返回清除思考功能的锁存器状态。当此功能被激活后，锁存器会保持true状态，
 * 用于优化缓存使用和思考过程管理。
 * 
 * 锁存器状态说明：
 * - null: 尚未触发，等待首次激活
 * - true: 已激活并锁存，启用清除思考功能
 * - false: 已停用并锁存，禁用清除思考功能
 * 
 * @returns 清除思考锁存器状态（null/true/false）
 */
export function getThinkingClearLatched(): boolean | null {
  return STATE.thinkingClearLatched
}

/**
 * 设置清除思考锁存器状态
 * 
 * 设置清除思考功能的锁存器状态。一旦设置，状态将保持直到会话重置。
 * 用于优化缓存使用和思考过程管理。
 * 
 * @param v 新的锁存器状态（true = 激活并锁存，false = 停用并锁存）
 */
export function setThinkingClearLatched(v: boolean): void {
  STATE.thinkingClearLatched = v
}

// ==================== Beta头锁存器管理 ====================

/**
 * 重置所有Beta头锁存器状态
 * 
 * 此函数在/clear和/compact命令调用时执行，将所有Beta功能的头锁存器重置为null。
 * 这样新的对话会话会重新评估Beta功能资格，获得新鲜的头部评估结果。
 * 
 * 重置的锁存器包括：
 * - AFK模式头锁存器
 * - 快速模式头锁存器
 * - 缓存编辑头锁存器
 * - 清除思考锁存器
 * 
 * 使用场景：
 * - 会话清除操作
 * - 会话压缩操作
 * - Beta功能重新评估
 */
export function clearBetaHeaderLatches(): void {
  STATE.afkModeHeaderLatched = null
  STATE.fastModeHeaderLatched = null
  STATE.cacheEditingHeaderLatched = null
  STATE.thinkingClearLatched = null
}

// ==================== 提示ID管理 ====================

/**
 * 获取当前提示ID
 * 
 * 返回当前提示的唯一标识符。提示ID用于关联用户提示与后续的OpenTelemetry事件，
 * 实现端到端的追踪和关联分析。
 * 
 * 使用场景：
 * - 事件追踪和关联
 * - 性能分析
 * - 调试和故障排查
 * 
 * @returns 当前提示ID，如果未设置则返回null
 */
export function getPromptId(): string | null {
  return STATE.promptId
}

/**
 * 设置当前提示ID
 * 
 * 设置当前提示的唯一标识符。此ID将在后续的OpenTelemetry事件中使用，
 * 用于实现端到端的追踪和关联分析。
 * 
 * @param id 新的提示ID，null表示清除当前提示ID
 */
export function setPromptId(id: string | null): void {
  STATE.promptId = id
}

// ============================================================================
// 模块架构总结
// ============================================================================

/**
 * 🏗️ 全局状态管理模块 - 架构定位和设计哲学
 * 
 * 这个state.ts文件是Claude Code的核心基础设施，采用单例模式设计，
 * 为整个应用提供统一、类型安全的状态管理能力。
 * 
 * 📍 架构层级位置：
 * - 位于bootstrap层，是应用启动时最早初始化的模块
 * - 作为叶子模块，避免循环依赖，可以被任何其他模块安全引用
 * - 提供全局状态访问接口，但不包含业务逻辑
 * 
 * 🎯 核心设计原则：
 * 1. 单例模式：全局唯一的STATE对象，确保状态一致性
 * 2. 类型安全：完整的TypeScript类型定义，编译时错误检查
 * 3. 模块化：状态按功能域清晰分离，便于维护和扩展
 * 4. 可测试性：专门的测试重置函数，支持隔离测试环境
 * 5. 性能优化：懒加载状态初始化，批量更新支持
 * 
 * 🔧 主要功能域划分：
 * 
 * 1. 会话生命周期管理
 *    - 会话ID生成和追踪
 *    - 项目路径和目录管理
 *    - 会话切换和恢复
 * 
 * 2. 性能监控和成本追踪
 *    - API调用耗时统计
 *    - Token使用和成本计算
 *    - 代码修改量统计
 *    - 工具执行性能分析
 * 
 * 3. 认证和配置管理
 *    - OAuth令牌和API密钥管理
 *    - 功能开关和权限控制
 *    - 模型配置和覆盖设置
 * 
 * 4. 功能模式和状态管理
 *    - 交互模式/非交互模式切换
 *    - 计划模式/自动模式状态
 *    - Beta功能激活和锁存
 *    - 缓存策略和优化
 * 
 * 5. 监控和遥测集成
 *    - OpenTelemetry指标收集
 *    - 错误日志和性能追踪
 *    - 会话统计和报告
 * 
 * 6. 缓存和临时状态
 *    - 内存缓存管理
 *    - 会话特定状态
 *    - 临时数据存储
 * 
 * ⚠️ 重要注意事项：
 * - 这是一个高度稳定的核心模块，修改需要极其谨慎
 * - 所有状态修改都应通过提供的setter函数进行
 * - 避免直接访问STATE对象，确保类型安全
 * - 状态重置仅用于测试环境，生产环境禁止使用
 * 
 * 🔄 与其他模块的交互：
 * - 被所有需要访问全局状态的模块引用
 * - 与bootstrap层其他模块协同工作
 * - 为上层业务逻辑提供状态服务
 * - 与OpenTelemetry系统集成进行监控
 * 
 * 这个模块是Claude Code的基石，确保了整个应用的状态一致性和可靠性。
 */

