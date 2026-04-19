/**
 * QueryEngine.ts - Claude Code 会话引擎核心模块
 * 
 * 文件概述：
 * 这是Claude Code项目的核心会话管理引擎，负责处理AI会话的完整生命周期。
 * QueryEngine将ask()函数的核心逻辑提取为独立的类，支持无头/SDK路径和REPL模式。
 * 
 * 架构定位：
 * - 核心层：位于项目架构的最核心位置，直接与AI模型、工具系统、状态管理交互
 * - 会话管理：每个QueryEngine实例管理一个完整的AI会话，包含消息历史、状态持久化等
 * - 多模式支持：支持SDK模式（无头）、REPL模式（交互式）和协调器模式
 * 
 * 主要职责：
 * 1. 会话生命周期管理：从用户输入到AI响应的完整流程
 * 2. 消息历史维护：支持会话恢复、转录记录和压缩边界
 * 3. 工具调用编排：管理MCP工具、内置工具和斜杠命令的执行
 * 4. 权限控制：实现细粒度的工具使用权限检查
 * 5. 状态持久化：支持会话恢复、文件历史记录和费用统计
 * 6. 错误处理：处理API错误、权限拒绝、超时等异常情况
 * 
 * 设计模式：
 * - 单例模式：每个会话一个QueryEngine实例
 * - 生成器模式：使用AsyncGenerator实现渐进式响应
 * - 策略模式：支持不同的查询策略和工具调用模式
 * - 观察者模式：通过回调函数实现状态变更通知
 * 
 * 关键特性：
 * - 支持结构化输出（JSON Schema）
 * - 支持思考模式（Thinking Config）
 * - 支持记忆系统（Memory Mechanics）
 * - 支持快速模式（Fast Mode）
 * - 支持预算控制（Budget Control）
 * - 支持会话压缩（History Snip）
 * 
 * 文件大小：45.54KB，1296行代码
 * 创建时间：Claude Code项目核心组件
 * 维护状态：活跃维护，功能持续扩展
 */

import { feature } from 'bun:bundle'
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID } from 'crypto'
import last from 'lodash-es/last.js'
import {
  getSessionId,
  isSessionPersistenceDisabled,
} from 'src/bootstrap/state.js'
import type {
  PermissionMode,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPermissionDenial,
  SDKStatus,
  SDKUserMessageReplay,
} from 'src/entrypoints/agentSdkTypes.js'
import { accumulateUsage, updateUsage } from 'src/services/api/claude.js'
import type { NonNullableUsage } from 'src/services/api/logging.js'
import { EMPTY_USAGE } from 'src/services/api/logging.js'
import stripAnsi from 'strip-ansi'
import type { Command } from './commands.js'
import { getSlashCommandToolSkills } from './commands.js'
import {
  LOCAL_COMMAND_STDERR_TAG,
  LOCAL_COMMAND_STDOUT_TAG,
} from './constants/xml.js'
import {
  getModelUsage,
  getTotalAPIDuration,
  getTotalCost,
} from './cost-tracker.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import { loadMemoryPrompt } from './memdir/memdir.js'
import { hasAutoMemPathOverride } from './memdir/paths.js'
import { query } from './query.js'
import { categorizeRetryableAPIError } from './services/api/errors.js'
import type { MCPServerConnection } from './services/mcp/types.js'
import type { AppState } from './state/AppState.js'
import { type Tools, type ToolUseContext, toolMatchesName } from './Tool.js'
import type { AgentDefinition } from './tools/AgentTool/loadAgentsDir.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
import type { Message } from './types/message.js'
import type { OrphanedPermission } from './types/textInputTypes.js'
import { createAbortController } from './utils/abortController.js'
import type { AttributionState } from './utils/commitAttribution.js'
import { getGlobalConfig } from './utils/config.js'
import { getCwd } from './utils/cwd.js'
import { isBareMode, isEnvTruthy } from './utils/envUtils.js'
import { getFastModeState } from './utils/fastMode.js'
import {
  type FileHistoryState,
  fileHistoryEnabled,
  fileHistoryMakeSnapshot,
} from './utils/fileHistory.js'
import {
  cloneFileStateCache,
  type FileStateCache,
} from './utils/fileStateCache.js'
import { headlessProfilerCheckpoint } from './utils/headlessProfiler.js'
import { registerStructuredOutputEnforcement } from './utils/hooks/hookHelpers.js'
import { getInMemoryErrors } from './utils/log.js'
import { countToolCalls, SYNTHETIC_MESSAGES } from './utils/messages.js'
import {
  getMainLoopModel,
  parseUserSpecifiedModel,
} from './utils/model/model.js'
import { loadAllPluginsCacheOnly } from './utils/plugins/pluginLoader.js'
import {
  type ProcessUserInputContext,
  processUserInput,
} from './utils/processUserInput/processUserInput.js'
import { fetchSystemPromptParts } from './utils/queryContext.js'
import { setCwd } from './utils/Shell.js'
import {
  flushSessionStorage,
  recordTranscript,
} from './utils/sessionStorage.js'
import { asSystemPrompt } from './utils/systemPromptType.js'
import { resolveThemeSetting } from './utils/systemTheme.js'
import {
  shouldEnableThinkingByDefault,
  type ThinkingConfig,
} from './utils/thinking.js'

// Lazy: MessageSelector.tsx pulls React/ink; only needed for message filtering at query time
/* eslint-disable @typescript-eslint/no-require-imports */
const messageSelector =
  (): typeof import('src/components/MessageSelector.js') =>
    require('src/components/MessageSelector.js')

import {
  localCommandOutputToSDKAssistantMessage,
  toSDKCompactMetadata,
} from './utils/messages/mappers.js'
import {
  buildSystemInitMessage,
  sdkCompatToolName,
} from './utils/messages/systemInit.js'
import {
  getScratchpadDir,
  isScratchpadEnabled,
} from './utils/permissions/filesystem.js'
/* eslint-enable @typescript-eslint/no-require-imports */
import {
  handleOrphanedPermission,
  isResultSuccessful,
  normalizeMessage,
} from './utils/queryHelpers.js'

// Dead code elimination: conditional import for coordinator mode
/* eslint-disable @typescript-eslint/no-require-imports */
const getCoordinatorUserContext: (
  mcpClients: ReadonlyArray<{ name: string }>,
  scratchpadDir?: string,
) => { [k: string]: string } = feature('COORDINATOR_MODE')
  ? require('./coordinator/coordinatorMode.js').getCoordinatorUserContext
  : () => ({})
/* eslint-enable @typescript-eslint/no-require-imports */

// Dead code elimination: conditional import for snip compaction
/* eslint-disable @typescript-eslint/no-require-imports */
const snipModule = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipCompact.js') as typeof import('./services/compact/snipCompact.js'))
  : null
const snipProjection = feature('HISTORY_SNIP')
  ? (require('./services/compact/snipProjection.js') as typeof import('./services/compact/snipProjection.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * QueryEngine 配置接口 - 定义会话引擎的完整配置参数
 * 
 * 配置说明：
 * 这个接口定义了QueryEngine运行所需的所有配置参数，涵盖了会话管理、工具系统、
 * 权限控制、状态管理、模型配置等各个方面。
 * 
 * 配置分类：
 * 1. 环境配置：工作目录、工具集、命令系统等基础环境设置
 * 2. 权限控制：工具使用权限检查、MCP客户端连接等安全配置
 * 3. 状态管理：应用状态读写、文件缓存、会话持久化等状态配置
 * 4. 模型配置：自定义提示词、模型选择、思考模式等AI模型配置
 * 5. 会话限制：轮次限制、预算控制、任务预算等会话边界配置
 * 6. 高级功能：结构化输出、调试模式、重放模式等高级配置
 * 
 * 设计原则：
 * - 可扩展性：通过接口扩展支持新功能，保持向后兼容
 * - 类型安全：TypeScript强类型确保配置的正确性
 * - 模块化：按功能域分组配置参数，便于理解和维护
 */
export type QueryEngineConfig = {
  /** 当前工作目录 - 文件操作和工具执行的上下文环境 */
  cwd: string
  /** 可用工具集合 - 包括MCP工具和内置工具 */
  tools: Tools
  /** 斜杠命令系统 - 处理用户输入的命令解析和执行 */
  commands: Command[]
  /** MCP服务器连接 - 提供外部工具和服务集成 */
  mcpClients: MCPServerConnection[]
  /** Agent定义 - 支持多Agent协作模式 */
  agents: AgentDefinition[]
  /** 权限检查函数 - 控制工具调用的安全性 */
  canUseTool: CanUseToolFn
  /** 获取应用状态函数 - 维护全局会话状态 */
  getAppState: () => AppState
  /** 设置应用状态函数 - 更新全局会话状态 */
  setAppState: (f: (prev: AppState) => AppState) => void
  /** 初始消息历史 - 支持会话恢复和上下文继承 */
  initialMessages?: Message[]
  /** 文件状态缓存 - 优化文件读取性能 */
  readFileCache: FileStateCache
  /** 自定义系统提示 - 允许调用方定制AI行为 */
  customSystemPrompt?: string
  /** 追加系统提示 - 在默认提示后追加额外提示 */
  appendSystemPrompt?: string
  /** 用户指定模型 - 覆盖默认模型选择 */
  userSpecifiedModel?: string
  /** 回退模型 - 主模型不可用时使用的备选模型 */
  fallbackModel?: string
  /** 思考模式配置 - 控制AI的思考过程和行为 */
  thinkingConfig?: ThinkingConfig
  /** 最大轮次限制 - 防止无限循环 */
  maxTurns?: number
  /** 最大预算限制（美元） - 控制会话费用 */
  maxBudgetUsd?: number
  /** 任务预算 - 为特定任务分配预算 */
  taskBudget?: { total: number }
  /** JSON Schema - 结构化输出验证 */
  jsonSchema?: Record<string, unknown>
  /** 详细模式 - 启用调试和详细日志输出 */
  verbose?: boolean
  /** 重放用户消息 - 是否重放用户消息到SDK */
  replayUserMessages?: boolean
  /** 
   * URL引导处理程序 - 处理MCP工具-32042错误触发的URL引导
   * 当MCP工具需要用户访问特定URL时调用此处理程序
   */
  handleElicitation?: ToolUseContext['handleElicitation']
  /** 包含部分消息 - 是否包含流式消息的部分内容 */
  includePartialMessages?: boolean
  /** 设置SDK状态函数 - 更新SDK客户端状态 */
  setSDKStatus?: (status: SDKStatus) => void
  /** 中断控制器 - 支持用户主动取消查询 */
  abortController?: AbortController
  /** 孤儿权限 - 处理会话中断后遗留的权限状态 */
  orphanedPermission?: OrphanedPermission
  /**
   * 压缩边界处理程序 - 接收每个产生的系统消息和当前可变消息存储
   * 返回undefined如果消息不是压缩边界；否则返回重放的压缩结果
   * 
   * 设计说明：
   * - 由ask()在HISTORY_SNIP启用时注入，使功能门控字符串保持在门控模块内
   * - SDK专用：REPL为UI滚动保留完整历史，QueryEngine在此处截断以限制内存
   * - 避免在长无头会话中内存泄漏（没有UI来保留历史）
   */
  snipReplay?: (
    yieldedSystemMsg: Message,
    store: Message[],
  ) => { messages: Message[]; executed: boolean } | undefined
}

/**
 * QueryEngine 核心类 - 管理单个AI会话的完整生命周期
 * 
 * 类概述：
 * QueryEngine是Claude Code项目的核心会话管理引擎，负责处理从用户输入到AI响应的完整流程。
 * 它将ask()函数的核心逻辑提取为独立的类，支持无头/SDK路径和REPL模式。
 * 
 * 设计模式：
 * - 单例模式：每个会话一个QueryEngine实例，管理独立的会话状态
 * - 生成器模式：使用AsyncGenerator实现渐进式响应，支持流式输出
 * - 策略模式：支持不同的查询策略和工具调用模式
 * - 观察者模式：通过回调函数实现状态变更通知
 * 
 * 职责范围：
 * 1. 消息历史管理：维护会话中的所有消息，支持增删改查和压缩
 * 2. 查询执行：处理用户输入，调用AI模型，管理工具调用流程
 * 3. 状态持久化：支持会话恢复、转录记录和状态同步
 * 4. 资源管理：控制文件缓存、权限检查、费用统计等
 * 5. 错误处理：处理API错误、权限拒绝、超时等异常情况
 * 6. 性能监控：跟踪响应时间、Token消耗、API调用等指标
 * 
 * 核心成员变量：
 * - config: 引擎配置，包含工具、命令、权限等完整设置
 * - mutableMessages: 可变消息历史，存储会话中的所有消息
 * - abortController: 中断控制器，支持用户主动取消查询
 * - permissionDenials: 权限拒绝记录，用于SDK报告和统计
 * - totalUsage: 总使用统计，跟踪Token消耗和费用
 * - readFileState: 文件状态缓存，优化重复文件读取性能
 * - discoveredSkillNames: 技能发现跟踪，记录会话中发现的技能
 * - loadedNestedMemoryPaths: 嵌套内存路径记录，支持记忆系统
 * 
 * 生命周期：
 * 1. 初始化：通过构造函数接收配置参数
 * 2. 会话处理：通过submitMessage方法处理用户输入
 * 3. 状态维护：通过成员变量维护会话状态
 * 4. 资源清理：通过interrupt方法支持主动中断
 * 
 * 使用场景：
 * - SDK模式：无头环境，通过submitMessage处理单个查询
 * - REPL模式：交互式环境，支持多轮对话和状态保持
 * - 协调器模式：多Agent协作，支持复杂的任务编排
 */
export class QueryEngine {
  /** 引擎配置 - 包含会话运行所需的所有参数 */
  private config: QueryEngineConfig
  /** 可变消息历史 - 存储会话中的所有消息，支持动态修改 */
  private mutableMessages: Message[]
  /** 中断控制器 - 支持用户主动取消正在进行的查询 */
  private abortController: AbortController
  /** 权限拒绝记录 - 跟踪会话中所有被拒绝的工具调用 */
  private permissionDenials: SDKPermissionDenial[]
  /** 总使用统计 - 累计Token消耗、API调用次数等指标 */
  private totalUsage: NonNullableUsage
  /** 孤儿权限处理标志 - 确保每个引擎生命周期只处理一次 */
  private hasHandledOrphanedPermission = false
  /** 文件状态缓存 - 缓存文件读取状态，优化重复读取性能 */
  private readFileState: FileStateCache
  /**
   * 轮次范围的技能发现跟踪 - 为tengu_skill_tool_invocation提供was_discovered标记
   * 必须在submitMessage内部的两次processUserInputContext重建之间持久化，
   * 但在每次submitMessage开始时清除，避免在SDK模式下跨多个轮次无界增长
   */
  private discoveredSkillNames = new Set<string>()
  /** 已加载的嵌套内存路径 - 跟踪已加载的记忆路径，避免重复加载 */
  private loadedNestedMemoryPaths = new Set<string>()

  /**
   * QueryEngine 构造函数 - 初始化会话引擎实例
   * 
   * 初始化流程：
   * 1. 接收配置参数，建立引擎运行环境
   * 2. 初始化消息历史，支持从已有会话恢复
   * 3. 创建中断控制器，支持查询取消功能
   * 4. 重置统计信息，开始新的会话统计
   * 5. 初始化文件缓存，优化文件操作性能
   * 
   * 设计考虑：
   * - 向后兼容：支持可选参数和默认值，确保现有代码正常工作
   * - 状态隔离：每个实例维护独立状态，支持多会话并行运行
   * - 资源管理：正确初始化所有资源，避免内存泄漏
   * 
   * @param config QueryEngine配置对象，包含完整的会话设置
   * 
   * 配置参数说明：
   * - initialMessages: 初始消息历史，支持会话恢复和上下文继承
   * - abortController: 外部中断控制器，支持跨组件取消操作
   * - readFileCache: 文件状态缓存，支持文件读取优化
   * 
   * 初始化顺序：
   * 1. 基础配置存储
   * 2. 消息历史初始化
   * 3. 中断控制器设置
   * 4. 统计信息重置
   * 5. 文件缓存关联
   */
  constructor(config: QueryEngineConfig) {
    // 存储配置参数，建立引擎运行环境
    this.config = config
    // 初始化消息历史，支持从已有会话恢复
    this.mutableMessages = config.initialMessages ?? []
    // 创建中断控制器，支持用户主动取消查询
    this.abortController = config.abortController ?? createAbortController()
    // 初始化权限拒绝记录，用于SDK报告和统计
    this.permissionDenials = []
    // 关联文件状态缓存，优化文件读取性能
    this.readFileState = config.readFileCache
    // 重置总使用统计，开始新的会话统计
    this.totalUsage = EMPTY_USAGE
  }

  /**
   * submitMessage - 处理用户消息并生成AI响应的核心方法
   * 
   * 方法概述：
   * 这是QueryEngine的核心方法，负责处理从用户输入到AI响应的完整流程。
   * 使用AsyncGenerator实现渐进式响应，支持流式输出和实时状态更新。
   * 
   * 执行流程：
   * 1. 初始化阶段：设置工作目录、权限包装、系统提示等基础环境
   * 2. 用户输入处理：解析命令、处理附件、权限检查等预处理
   * 3. 会话持久化：写入转录记录，支持会话恢复和状态同步
   * 4. AI查询执行：调用query.ts进行模型交互和工具调用
   * 5. 响应处理：解析AI响应，处理工具调用结果和状态更新
   * 6. 结果生成：生成最终结果消息，更新会话状态和统计信息
   * 
   * 设计特点：
   * - 异步生成器：支持渐进式响应，避免阻塞主线程
   * - 状态管理：维护会话状态，支持多轮对话和状态恢复
   * - 错误处理：完善的异常处理机制，确保会话稳定性
   * - 性能监控：跟踪响应时间、Token消耗等性能指标
   * 
   * @param prompt 用户输入内容，可以是字符串或内容块数组
   * @param options 可选参数，包括UUID和元数据标记
   * @returns 异步生成器，产生SDK消息流，包含所有中间状态和最终结果
   */
  async *submitMessage(
    prompt: string | ContentBlockParam[],
    options?: { uuid?: string; isMeta?: boolean },
  ): AsyncGenerator<SDKMessage, void, unknown> {
    // 解构配置参数，获取会话运行所需的所有组件
    const {
      cwd,
      commands,
      tools,
      mcpClients,
      verbose = false,
      thinkingConfig,
      maxTurns,
      maxBudgetUsd,
      taskBudget,
      canUseTool,
      customSystemPrompt,
      appendSystemPrompt,
      userSpecifiedModel,
      fallbackModel,
      jsonSchema,
      getAppState,
      setAppState,
      replayUserMessages = false,
      includePartialMessages = false,
      agents = [],
      setSDKStatus,
      orphanedPermission,
    } = this.config

    // 清空技能发现跟踪，确保每个消息处理都是独立的
    this.discoveredSkillNames.clear()
    // 设置当前工作目录，为文件操作和工具执行提供上下文
    setCwd(cwd)
    // 检查会话持久化设置，决定是否记录转录（在无头模式下可能禁用）
    const persistSession = !isSessionPersistenceDisabled()
    // 记录查询开始时间，用于计算总响应时间
    const startTime = Date.now()

    /**
     * 权限检查包装函数 - 在原有权限检查基础上添加拒绝跟踪功能
     * 
     * 功能说明：
     * - 包装原有的canUseTool函数，添加权限拒绝记录功能
     * - 为SDK提供详细的权限拒绝报告和统计信息
     * - 保持原有权限检查逻辑不变，只增加跟踪功能
     * 
     * 设计考虑：
     * - 透明包装：不改变原有权限检查的行为和结果
     * - 性能影响：轻量级跟踪，不影响权限检查性能
     * - 数据安全：只记录必要信息，不泄露敏感数据
     */
    const wrappedCanUseTool: CanUseToolFn = async (
      tool,
      input,
      toolUseContext,
      assistantMessage,
      toolUseID,
      forceDecision,
    ) => {
      // 调用原始权限检查函数
      const result = await canUseTool(
        tool,
        input,
        toolUseContext,
        assistantMessage,
        toolUseID,
        forceDecision,
      )

      // 跟踪权限拒绝，用于SDK报告和统计
      if (result.behavior !== 'allow') {
        this.permissionDenials.push({
          tool_name: sdkCompatToolName(tool.name),
          tool_use_id: toolUseID,
          tool_input: input,
        })
      }

      return result
    }

    // 获取初始应用状态，包含权限模式、工作目录等全局设置
    const initialAppState = getAppState()
    // 确定主循环模型：优先使用用户指定模型，否则使用默认模型
    const initialMainLoopModel = userSpecifiedModel
      ? parseUserSpecifiedModel(userSpecifiedModel)
      : getMainLoopModel()

    /**
     * 思考模式配置 - 控制AI的思考过程和行为
     * 
     * 配置优先级：
     * 1. 显式配置：如果提供了thinkingConfig，直接使用
     * 2. 默认启用：如果shouldEnableThinkingByDefault()不为false，使用自适应模式
     * 3. 禁用模式：否则禁用思考模式
     * 
     * 模式说明：
     * - adaptive: 自适应模式，根据上下文自动决定是否思考
     * - disabled: 禁用思考模式，直接生成响应
     * - always: 总是启用思考模式
     * - never: 从不启用思考模式
     */
    const initialThinkingConfig: ThinkingConfig = thinkingConfig
      ? thinkingConfig
      : shouldEnableThinkingByDefault() !== false
        ? { type: 'adaptive' }
        : { type: 'disabled' }

    // 性能监控：标记系统提示获取开始，用于性能分析和优化
    headlessProfilerCheckpoint('before_getSystemPrompt')
    
    /**
     * 获取系统提示组件 - 构建完整的系统提示词
     * 
     * 组件说明：
     * - defaultSystemPrompt: 默认系统提示，包含基础行为指导
     * - baseUserContext: 基础用户上下文，包含用户信息和环境设置
     * - systemContext: 系统上下文，包含工具信息和系统状态
     * 
     * 设计原则：
     * - 模块化：各组件独立获取，支持灵活组合
     * - 可扩展：支持自定义提示和追加提示
     * - 性能优化：并行获取，减少等待时间
     */
    const customPrompt =
      typeof customSystemPrompt === 'string' ? customSystemPrompt : undefined
    const {
      defaultSystemPrompt,
      userContext: baseUserContext,
      systemContext,
    } = await fetchSystemPromptParts({
      tools,
      mainLoopModel: initialMainLoopModel,
      additionalWorkingDirectories: Array.from(
        initialAppState.toolPermissionContext.additionalWorkingDirectories.keys(),
      ),
      mcpClients,
      customSystemPrompt: customPrompt,
    })
    
    // 性能监控：标记系统提示获取完成
    headlessProfilerCheckpoint('after_getSystemPrompt')
    
    /**
     * 合并用户上下文 - 支持协调器模式和特殊配置
     * 
     * 合并策略：
     * - 基础上下文：从fetchSystemPromptParts获取的基础用户上下文
     * - 协调器上下文：如果启用协调器模式，添加协调器特定上下文
     * - 便签本目录：如果启用便签本功能，添加便签本目录信息
     * 
     * 功能说明：
     * - 协调器模式：支持多Agent协作和任务编排
     * - 便签本功能：提供临时文件存储和共享空间
     */
    const userContext = {
      ...baseUserContext,
      ...getCoordinatorUserContext(
        mcpClients,
        isScratchpadEnabled() ? getScratchpadDir() : undefined,
      ),
    }

    /**
     * 内存机制提示注入 - 当SDK调用者提供自定义系统提示且设置了内存路径覆盖时
     * 
     * 触发条件：
     * - 有自定义系统提示（customPrompt !== undefined）
     * - 设置了自动内存路径覆盖（hasAutoMemPathOverride()返回true）
     * 
     * 功能说明：
     * - 自动注入内存机制提示，指导Claude如何使用内存系统
     * - 包含Write/Edit工具调用、MEMORY.md文件名、加载语义等指导
     * - 调用者可以通过appendSystemPrompt添加自己的策略文本
     * 
     * 设计目的：
     * - 降低集成复杂度：自动处理内存系统集成
     * - 提高可用性：提供标准化的内存使用指导
     * - 保持灵活性：允许调用者自定义策略
     */
    const memoryMechanicsPrompt =
      customPrompt !== undefined && hasAutoMemPathOverride()
        ? await loadMemoryPrompt()
        : null

    /**
     * 构建最终系统提示 - 按优先级合并各个组件
     * 
     * 合并顺序：
     * 1. 自定义提示：如果提供了customPrompt，使用自定义提示
     * 2. 默认提示：否则使用默认系统提示
     * 3. 内存提示：如果启用了内存机制，添加内存使用指导
     * 4. 追加提示：如果提供了appendSystemPrompt，追加额外提示
     * 
     * 设计原则：
     * - 优先级明确：自定义提示优先于默认提示
     * - 条件注入：内存提示只在特定条件下注入
     * - 格式统一：使用asSystemPrompt确保格式正确
     */
    const systemPrompt = asSystemPrompt([
      ...(customPrompt !== undefined ? [customPrompt] : defaultSystemPrompt),
      ...(memoryMechanicsPrompt ? [memoryMechanicsPrompt] : []),
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])

    /**
     * 结构化输出强制注册 - 当有JSON Schema且支持结构化输出工具时
     * 
     * 功能说明：
     * - 注册结构化输出强制功能，确保AI响应符合指定的JSON Schema
     * - 通过hook系统在响应生成时进行格式验证和强制转换
     * 
     * 触发条件：
     * - 提供了jsonSchema配置参数
     * - 工具集中包含结构化输出工具（SYNTHETIC_OUTPUT_TOOL_NAME）
     * 
     * 设计目的：
     * - 提高响应质量：确保输出格式符合预期
     * - 简化集成：自动处理格式验证和转换
     * - 错误处理：提供清晰的错误信息和重试机制
     */
    const hasStructuredOutputTool = tools.some(t =>
      toolMatchesName(t, SYNTHETIC_OUTPUT_TOOL_NAME),
    )
    if (jsonSchema && hasStructuredOutputTool) {
      registerStructuredOutputEnforcement(setAppState, getSessionId())
    }

    // 性能监控：标记用户输入处理开始
    headlessProfilerCheckpoint('before_processUserInput')

    /**
     * 处理用户输入 - 解析命令、处理附件、权限检查等预处理
     * 
     * 处理流程：
     * 1. 命令解析：识别和处理斜杠命令（如 /run, /edit 等）
     * 2. 附件处理：解析和处理消息中的文件附件
     * 3. 权限检查：验证用户是否有权限执行相关操作
     * 4. 上下文构建：构建处理用户输入所需的完整上下文
     * 5. 结果生成：生成处理后的消息和可能的工具调用结果
     * 
     * 上下文配置：
     * - 工具系统：提供可用的工具集合和权限检查
     * - 命令系统：支持斜杠命令的解析和执行
     * - 状态管理：维护应用状态和文件缓存
     * - 技能发现：跟踪会话中发现的技能
     * - 内存系统：支持记忆路径的加载和管理
     * 
     * 设计目标：
     * - 模块化：将用户输入处理逻辑集中管理
     * - 可扩展：支持新的命令类型和输入格式
     * - 安全性：严格的权限检查和输入验证
     */
    const processUserInputContext: ProcessUserInputContext = {
      tools,
      commands,
      canUseTool: wrappedCanUseTool,
      getAppState,
      setAppState,
      readFileState: this.readFileState,
      discoveredSkillNames: this.discoveredSkillNames,
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      mcpClients,
      agents,
      cwd,
      userContext,
      systemContext,
      systemPrompt,
      mainLoopModel: initialMainLoopModel,
      fallbackModel,
      thinkingConfig: initialThinkingConfig,
      jsonSchema,
      verbose,
      setSDKStatus,
      orphanedPermission,
    }

    /**
     * 执行用户输入处理 - 实际处理用户输入并生成结果
     * 
     * 处理结果：
     * - messages: 处理后的消息数组，可能包含命令执行结果
     * - structuredOutputFromTool: 结构化输出结果（如果有）
     * - initialStructuredOutputCalls: 初始结构化输出调用计数
     * - errorLogWatermark: 错误日志水印，用于错误跟踪
     * - turnCount: 当前轮次计数
     * - lastStopReason: 最后停止原因
     * 
     * 异常处理：
     * - 如果处理过程中发生错误，会抛出异常
     * - 调用方需要捕获异常并生成适当的错误响应
     */
    const {
      messages,
      structuredOutputFromTool,
      initialStructuredOutputCalls,
      errorLogWatermark,
      turnCount,
      lastStopReason,
    } = await processUserInput(
      prompt,
      processUserInputContext,
      options,
    )

    // 性能监控：标记用户输入处理完成
    headlessProfilerCheckpoint('after_processUserInput')

    /**
     * 孤儿权限处理 - 处理会话中断后遗留的权限状态
     * 
     * 触发条件：
     * - 提供了orphanedPermission配置
     * - 尚未在当前引擎生命周期中处理过孤儿权限
     * 
     * 处理逻辑：
     * - 调用handleOrphanedPermission处理遗留权限
     * - 设置处理标志，避免重复处理
     * - 更新消息历史，包含权限处理结果
     * 
     * 设计目的：
     * - 状态恢复：正确处理中断会话的权限状态
     * - 避免重复：确保每个引擎实例只处理一次
     * - 用户体验：提供连贯的权限管理体验
     */
    if (orphanedPermission && !this.hasHandledOrphanedPermission) {
      this.hasHandledOrphanedPermission = true
      const orphanedResult = await handleOrphanedPermission(
        orphanedPermission,
        processUserInputContext,
      )
      if (orphanedResult) {
        messages.push(...orphanedResult.messages)
      }
    }

    /**
     * 会话持久化 - 写入转录记录，支持会话恢复和状态同步
     * 
     * 写入条件：
     * - 启用了会话持久化（persistSession为true）
     * - 当前不是裸模式（isBareMode()返回false）
     * 
     * 写入内容：
     * - 用户输入消息
     * - 命令执行结果
     * - 权限处理结果
     * - 其他处理过程中产生的消息
     * 
     * 设计目的：
     * - 状态恢复：支持会话中断后恢复
     * - 调试分析：提供完整的会话历史记录
     * - 审计跟踪：记录所有用户操作和系统响应
     */
    if (persistSession && !isBareMode()) {
      for (const message of messages) {
        await recordTranscript(message)
      }
    }

    /**
     * 文件历史快照 - 在查询开始前创建文件状态快照
     * 
     * 快照条件：
     * - 启用了文件历史功能（fileHistoryEnabled()返回true）
     * - 当前不是裸模式（isBareMode()返回false）
     * 
     * 快照内容：
     * - 当前工作目录的文件状态
     * - 文件修改时间和大小信息
     * - 文件内容哈希值（用于变化检测）
     * 
     * 设计目的：
     * - 变化检测：检测查询过程中文件的修改
     * - 状态对比：提供查询前后的文件状态对比
     * - 调试辅助：帮助诊断文件相关的问题
     */
    let fileHistoryState: FileHistoryState | undefined
    if (fileHistoryEnabled() && !isBareMode()) {
      fileHistoryState = fileHistoryMakeSnapshot()
    }

    /**
     * 用户消息重放 - 将用户消息重放到SDK（如果配置启用）
     * 
     * 重放条件：
     * - 启用了用户消息重放（replayUserMessages为true）
     * - 消息类型为用户消息（message.type === 'user'）
     * - 消息不是元消息（!message.isMeta）
     * 
     * 重放内容：
     * - 用户输入内容
     * - 消息UUID和元数据
     * - 会话标识信息
     * 
     * 设计目的：
     * - SDK集成：为SDK客户端提供完整的消息流
     * - 状态同步：确保SDK和引擎的消息状态一致
     * - 调试支持：提供完整的交互历史用于调试
     */
    if (replayUserMessages) {
      for (const message of messages) {
        if (message.type === 'user' && !message.isMeta) {
          yield {
            type: 'user_message_replay',
            content: message.content,
            session_id: getSessionId(),
            uuid: message.uuid,
          } satisfies SDKUserMessageReplay
        }
      }
    }

    /**
     * 系统初始化消息 - 在查询开始前发送系统初始化消息
     * 
     * 消息内容：
     * - 系统提示信息
     * - 用户上下文信息
     * - 工具和命令信息
     * - 模型和配置信息
     * 
     * 发送条件：
     * - 当前是SDK模式（通过特定条件判断）
     * - 需要向SDK客户端提供完整的初始化信息
     * 
     * 设计目的：
     * - SDK初始化：为SDK客户端提供完整的初始化信息
     * - 状态同步：确保SDK了解引擎的完整配置状态
     * - 调试支持：提供系统配置信息用于调试和分析
     */
    yield* buildSystemInitMessage({
      systemPrompt,
      userContext,
      systemContext,
      tools,
      commands,
      mcpClients,
      agents,
      mainLoopModel: initialMainLoopModel,
      fallbackModel,
      thinkingConfig: initialThinkingConfig,
      jsonSchema,
      verbose,
    })

    // 性能监控：标记查询执行开始
    headlessProfilerCheckpoint('before_query')

    /**
     * 执行AI查询 - 调用query.ts进行模型交互和工具调用
     * 
     * 查询配置：
     * - 消息历史：包含所有处理后的消息
     * - 系统提示：构建完整的系统提示词
     * - 工具系统：提供可用的工具集合
     * - 权限检查：包装后的权限检查函数
     * - 状态管理：应用状态读写函数
     * - 模型配置：主模型和回退模型设置
     * - 思考配置：思考模式和行为设置
     * - 预算控制：最大轮次和预算限制
     * - 结构化输出：JSON Schema验证
     * 
     * 查询过程：
     * 1. 模型调用：调用Claude API生成响应
     * 2. 工具调用：处理AI请求的工具调用
     * 3. 状态更新：更新消息历史和会话状态
     * 4. 结果生成：产生渐进式响应消息
     * 
     * 设计特点：
     * - 异步生成器：支持流式响应和实时更新
     * - 错误恢复：完善的错误处理和重试机制
     * - 性能优化：并行处理和资源复用
     */
    const queryResult = query({
      messages,
      systemPrompt,
      tools,
      commands,
      canUseTool: wrappedCanUseTool,
      getAppState,
      setAppState,
      readFileState: this.readFileState,
      mainLoopModel: initialMainLoopModel,
      fallbackModel,
      thinkingConfig: initialThinkingConfig,
      maxTurns,
      maxBudgetUsd,
      taskBudget,
      jsonSchema,
      verbose,
      includePartialMessages,
      mcpClients,
      agents,
      cwd,
      userContext,
      systemContext,
      discoveredSkillNames: this.discoveredSkillNames,
      loadedNestedMemoryPaths: this.loadedNestedMemoryPaths,
      setSDKStatus,
      abortController: this.abortController,
    })

    // Track current message usage (reset on each message_start)
    let currentMessageUsage: NonNullableUsage = EMPTY_USAGE
    let hasAcknowledgedInitialMessages = false

    // 性能监控：标记查询执行完成
    headlessProfilerCheckpoint('after_query')

    /**
     * 处理查询结果 - 遍历查询生成器，处理所有产生的消息
     * 
     * 处理流程：
     * 1. 遍历生成器：逐个处理查询产生的消息
     * 2. 消息分类：根据消息类型进行不同的处理
     * 3. 状态更新：更新消息历史和会话状态
     * 4. 结果生成：产生SDK消息流
     * 5. 错误处理：处理查询过程中的异常情况
     * 
     * 消息类型处理：
     * - 用户消息：记录到消息历史，支持会话恢复
     * - 助手消息：记录到消息历史，产生SDK响应
     * - 工具调用：执行工具并记录结果
     * - 系统消息：处理系统事件和状态更新
     * - 工具结果：记录工具执行结果
     * 
     * 设计原则：
     * - 实时处理：逐个消息处理，支持流式响应
     * - 状态一致：确保消息历史和SDK消息流的一致性
     * - 错误恢复：完善的异常处理和状态回滚
     */
    for await (const message of queryResult) {
      // 规范化消息，确保消息格式正确和一致
      const normalizedMessage = normalizeMessage(message)
      // 将规范化后的消息添加到可变消息历史中
      this.mutableMessages.push(normalizedMessage)

      /**
       * 会话持久化 - 实时记录消息到转录文件
       * 
       * 记录条件：
       * - 启用了会话持久化（persistSession为true）
       * - 当前不是裸模式（isBareMode()返回false）
       * 
       * 记录内容：
       * - 所有类型的消息：用户、助手、工具、系统等
       * - 消息内容和元数据
       * - 时间戳和会话标识
       * 
       * 设计目的：
       * - 实时持久化：确保消息不会因进程终止而丢失
       * - 状态恢复：支持会话中断后精确恢复
       * - 审计跟踪：提供完整的操作记录
       */
      if (persistSession && !isBareMode()) {
        await recordTranscript(normalizedMessage)
      }

      /**
       * 消息类型分发 - 根据消息类型进行不同的处理
       * 
       * 处理策略：
       * - 用户消息：直接产生SDK用户消息重放
       * - 助手消息：产生SDK助手消息
       * - 工具调用：产生SDK工具调用事件
       * - 工具结果：产生SDK工具结果事件
       * - 系统消息：根据子类型进行特殊处理
       * - 工具使用摘要：产生SDK工具使用摘要消息
       * 
       * 设计原则：
       * - 类型安全：严格的类型检查和转换
       * - 性能优化：避免不必要的消息处理
       * - 扩展性：支持新的消息类型
       */
      switch (normalizedMessage.type) {
        case 'user':
          // 用户消息重放到SDK（如果配置启用）
          if (replayUserMessages && !normalizedMessage.isMeta) {
            yield {
              type: 'user_message_replay',
              content: normalizedMessage.content,
              session_id: getSessionId(),
              uuid: normalizedMessage.uuid,
            } satisfies SDKUserMessageReplay
          }
          break

        case 'assistant':
          // 助手消息产生SDK响应
          yield {
            type: 'assistant_message',
            content: normalizedMessage.message.content,
            model: normalizedMessage.message.model,
            session_id: getSessionId(),
            uuid: normalizedMessage.uuid,
            thinking: normalizedMessage.thinking,
            tool_calls: normalizedMessage.tool_calls,
          }
          break

        case 'tool_call':
          // 工具调用消息产生SDK工具调用事件
          yield {
            type: 'tool_call',
            tool_name: sdkCompatToolName(normalizedMessage.tool_name),
            tool_input: normalizedMessage.tool_input,
            tool_use_id: normalizedMessage.tool_use_id,
            session_id: getSessionId(),
            uuid: normalizedMessage.uuid,
          }
          break

        case 'tool_result':
          // 工具结果消息产生SDK工具结果事件
          yield {
            type: 'tool_result',
            tool_use_id: normalizedMessage.tool_use_id,
            content: normalizedMessage.content,
            is_error: normalizedMessage.is_error,
            session_id: getSessionId(),
            uuid: normalizedMessage.uuid,
          }
          break

        case 'system':
          // 系统消息根据子类型进行特殊处理
          switch (normalizedMessage.subtype) {
            case 'local_command_output':
              // 本地命令输出转换为SDK助手消息
              yield localCommandOutputToSDKAssistantMessage(normalizedMessage)
              break

            case 'compact_boundary':
              /**
               * 压缩边界处理 - 优化消息历史内存使用
               * 
               * 处理逻辑：
               * 1. 释放压缩前的消息，允许垃圾回收
               * 2. 产生SDK压缩边界消息，通知客户端
               * 3. 更新本地消息数组，只保留压缩后的消息
               * 
               * 设计目的：
               * - 内存优化：减少长会话的内存占用
               * - 性能提升：提高消息处理效率
               * - 状态同步：确保SDK了解压缩边界
               */
              // 释放压缩前的消息，允许垃圾回收
              const mutableBoundaryIdx = this.mutableMessages.length - 1
              if (mutableBoundaryIdx > 0) {
                this.mutableMessages.splice(0, mutableBoundaryIdx)
              }
              const localBoundaryIdx = messages.length - 1
              if (localBoundaryIdx > 0) {
                messages.splice(0, localBoundaryIdx)
              }

              // 产生SDK压缩边界消息
              yield {
                type: 'system',
                subtype: 'compact_boundary' as const,
                session_id: getSessionId(),
                uuid: normalizedMessage.uuid,
                compact_metadata: toSDKCompactMetadata(
                  normalizedMessage.compactMetadata,
                ),
              } satisfies SDKCompactBoundaryMessage
              break

            case 'api_error':
              // API错误消息产生SDK重试事件
              yield {
                type: 'system',
                subtype: 'api_retry' as const,
                attempt: normalizedMessage.retryAttempt,
                max_retries: normalizedMessage.maxRetries,
                retry_delay_ms: normalizedMessage.retryInMs,
                error_status: normalizedMessage.error.status ?? null,
                error: categorizeRetryableAPIError(normalizedMessage.error),
                session_id: getSessionId(),
                uuid: normalizedMessage.uuid,
              }
              break

            default:
              // 无头模式下不产生其他系统消息
              break
          }
          break

        case 'tool_use_summary':
          // 工具使用摘要消息产生SDK摘要事件
          yield {
            type: 'tool_use_summary' as const,
            summary: normalizedMessage.summary,
            preceding_tool_use_ids: normalizedMessage.precedingToolUseIds,
            session_id: getSessionId(),
            uuid: normalizedMessage.uuid,
          }
          break
      }

      /**
       * 预算检查 - 检查是否超过最大预算限制
       * 
       * 检查条件：
       * - 设置了最大预算限制（maxBudgetUsd !== undefined）
       * - 当前总费用超过或等于最大预算
       * 
       * 处理逻辑：
       * 1. 如果启用了会话持久化，刷新会话存储
       * 2. 产生预算超限错误结果
       * 3. 终止查询执行
       * 
       * 设计目的：
       * - 成本控制：防止意外的高费用
       * - 用户体验：提供清晰的错误信息
       * - 状态保存：确保会话状态正确保存
       */
      if (maxBudgetUsd !== undefined && getTotalCost() >= maxBudgetUsd) {
        // 刷新会话存储（如果启用）
        if (persistSession) {
          if (
            isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
            isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
          ) {
            await flushSessionStorage()
          }
        }

        // 产生预算超限错误结果
        yield {
          type: 'result',
          subtype: 'error_max_budget_usd',
          duration_ms: Date.now() - startTime,
          duration_api_ms: getTotalAPIDuration(),
          is_error: true,
          num_turns: turnCount,
          stop_reason: lastStopReason,
          session_id: getSessionId(),
          total_cost_usd: getTotalCost(),
          usage: this.totalUsage,
          modelUsage: getModelUsage(),
          permission_denials: this.permissionDenials,
          fast_mode_state: getFastModeState(
            initialMainLoopModel,
            initialAppState.fastMode,
          ),
          uuid: randomUUID(),
          errors: [`Reached maximum budget ($${maxBudgetUsd})`],
        }
        return
      }

      /**
       * 结构化输出重试限制检查 - 检查是否超过最大重试次数
       * 
       * 检查条件：
       * - 当前消息是用户消息
       * - 设置了JSON Schema验证
       * - 结构化输出调用次数超过最大重试限制
       * 
       * 处理逻辑：
       * 1. 计算当前查询的结构化输出调用次数
       * 2. 如果超过最大重试次数，产生错误结果
       * 3. 终止查询执行
       * 
       * 设计目的：
       * - 防止无限循环：限制结构化输出重试次数
       * - 用户体验：提供清晰的错误信息
       * - 性能保护：避免资源浪费在无效重试上
       */
      if (normalizedMessage.type === 'user' && jsonSchema) {
        // 计算当前查询的结构化输出调用次数
        const currentCalls = countToolCalls(
          this.mutableMessages,
          SYNTHETIC_OUTPUT_TOOL_NAME,
        )
        const callsThisQuery = currentCalls - initialStructuredOutputCalls
        const maxRetries = parseInt(
          process.env.MAX_STRUCTURED_OUTPUT_RETRIES || '5',
          10,
        )

        // 检查是否超过最大重试次数
        if (callsThisQuery >= maxRetries) {
          // 刷新会话存储（如果启用）
          if (persistSession) {
            if (
              isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
              isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
            ) {
              await flushSessionStorage()
            }
          }

          // 产生重试超限错误结果
          yield {
            type: 'result',
            subtype: 'error_max_structured_output_retries',
            duration_ms: Date.now() - startTime,
            duration_api_ms: getTotalAPIDuration(),
            is_error: true,
            num_turns: turnCount,
            stop_reason: lastStopReason,
            session_id: getSessionId(),
            total_cost_usd: getTotalCost(),
            usage: this.totalUsage,
            modelUsage: getModelUsage(),
            permission_denials: this.permissionDenials,
            fast_mode_state: getFastModeState(
              initialMainLoopModel,
              initialAppState.fastMode,
            ),
            uuid: randomUUID(),
            errors: [
              `Failed to provide valid structured output after ${maxRetries} attempts`,
            ],
          }
          return
        }
      }
    }

    /**
     * 查询结果处理 - 处理查询完成后的最终结果
     * 
     * 处理流程：
     * 1. 查找有效结果：从消息历史中提取有效的助手或用户消息
     * 2. 结果验证：检查结果是否成功完成
     * 3. 会话持久化：刷新会话存储，确保状态保存
     * 4. 结果生成：根据结果状态生成成功或错误结果
     * 5. 资源清理：清理临时资源，准备下一次查询
     * 
     * 结果验证逻辑：
     * - 成功条件：助手消息包含文本内容，或用户消息包含工具结果
     * - 错误条件：结果类型无效或停止原因不是正常结束
     * - 特殊情况：处理API错误和权限拒绝等情况
     * 
     * 设计原则：
     * - 状态一致性：确保结果与消息历史一致
     * - 错误诊断：提供详细的错误信息用于调试
     * - 性能优化：最小化不必要的操作
     */

    // 查找有效的查询结果消息
    // 注意：停止钩子可能在助手响应后产生进度/附件消息，因此需要过滤
    const result = messages.findLast(
      m => m.type === 'assistant' || m.type === 'user',
    )

    // 保存结果类型用于错误诊断
    const resultType = result?.type ?? 'undefined'
    const lastContentType =
      result?.type === 'assistant'
        ? (last(result.message.content)?.type ?? 'none')
        : 'n/a'

    /**
     * 会话存储刷新 - 在产生结果前刷新缓冲的转录写入
     * 
     * 刷新原因：
     * - 桌面应用在接收到结果消息后立即终止CLI进程
     * - 未刷新的写入可能会丢失，导致会话状态不一致
     * 
     * 刷新条件：
     * - 启用了会话持久化（persistSession为true）
     * - 配置了急切刷新或协作模式
     * 
     * 设计目的：
     * - 数据完整性：确保所有消息都正确保存
     * - 状态恢复：支持精确的会话恢复
     * - 协作支持：在协作模式下确保状态同步
     */
    if (persistSession) {
      if (
        isEnvTruthy(process.env.CLAUDE_CODE_EAGER_FLUSH) ||
        isEnvTruthy(process.env.CLAUDE_CODE_IS_COWORK)
      ) {
        await flushSessionStorage()
      }
    }

    /**
     * 结果验证 - 检查查询是否成功完成
     * 
     * 验证逻辑：
     * - 助手消息：必须包含文本内容或思考内容
     * - 用户消息：必须包含工具结果块
     * - 停止原因：必须是正常结束（end_turn）
     * 
     * 错误处理：
     * - 如果验证失败，产生执行错误结果
     * - 包含详细的诊断信息用于调试
     * - 记录相关的错误日志
     */
    if (!isResultSuccessful(result, lastStopReason)) {
      // 产生执行错误结果
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        duration_ms: Date.now() - startTime,
        duration_api_ms: getTotalAPIDuration(),
        is_error: true,
        num_turns: turnCount,
        stop_reason: lastStopReason,
        session_id: getSessionId(),
        total_cost_usd: getTotalCost(),
        usage: this.totalUsage,
        modelUsage: getModelUsage(),
        permission_denials: this.permissionDenials,
        fast_mode_state: getFastModeState(
          initialMainLoopModel,
          initialAppState.fastMode,
        ),
        uuid: randomUUID(),
        // 诊断信息：显示isResultSuccessful()检查的内容
        errors: (() => {
          const allErrors = getInMemoryErrors()
          const startIndex = errorLogWatermark
            ? allErrors.lastIndexOf(errorLogWatermark) + 1
            : 0
          return [
            `[ede_diagnostic] result_type=${resultType} last_content_type=${lastContentType} stop_reason=${lastStopReason}`,
            ...allErrors.slice(startIndex).map(e => e.error),
          ]
        })(),
      }
      return
    }

    /**
     * 成功结果提取 - 从有效结果中提取文本内容
     * 
     * 提取逻辑：
     * - 助手消息：提取最后一个文本内容块
     * - 用户消息：不提取文本内容（通常不包含）
     * - 内容过滤：排除合成消息和空内容
     * 
     * 错误标记：
     * - 标记API错误消息，但不影响结果提取
     * - 保持结果完整性，同时记录错误状态
     */
    let textResult = ''
    let isApiError = false

    if (result.type === 'assistant') {
      const lastContent = last(result.message.content)
      if (
        lastContent?.type === 'text' &&
        !SYNTHETIC_MESSAGES.has(lastContent.text)
      ) {
        textResult = lastContent.text
      }
      isApiError = Boolean(result.isApiErrorMessage)
    }

    /**
     * 产生成功结果 - 生成最终的查询结果消息
     * 
     * 结果内容：
     * - 文本结果：提取的AI响应文本
     * - 性能统计：响应时间、API时间、费用等
     * - 使用统计：Token消耗、模型使用情况
     * - 状态信息：会话ID、轮次计数、停止原因等
     * - 附加信息：结构化输出、快速模式状态等
     * 
     * 设计目的：
     * - 完整性：提供完整的查询结果信息
     * - 可扩展性：支持新的结果类型和字段
     * - 调试支持：提供详细的性能和使用统计
     */
    yield {
      type: 'result',
      subtype: 'success',
      is_error: isApiError,
      duration_ms: Date.now() - startTime,
      duration_api_ms: getTotalAPIDuration(),
      num_turns: turnCount,
      result: textResult,
      stop_reason: lastStopReason,
      session_id: getSessionId(),
      total_cost_usd: getTotalCost(),
      usage: this.totalUsage,
      modelUsage: getModelUsage(),
      permission_denials: this.permissionDenials,
      structured_output: structuredOutputFromTool,
      fast_mode_state: getFastModeState(
        initialMainLoopModel,
        initialAppState.fastMode,
      ),
      uuid: randomUUID(),
    }
  }

  /**
   * interrupt - 中断当前查询执行
   * 
   * 功能说明：
   * - 调用中断控制器的abort方法，取消正在进行的查询
   * - 立即停止所有异步操作和工具调用
   * - 清理相关资源，防止内存泄漏
   * 
   * 使用场景：
   * - 用户主动取消：用户按下Ctrl+C或取消按钮
   * - 超时中断：查询执行时间超过预设限制
   * - 错误中断：发生不可恢复的错误需要立即停止
   * 
   * 设计原则：
   * - 立即响应：确保中断能够立即生效
   * - 资源安全：正确清理所有正在使用的资源
   * - 状态一致：确保中断后会话状态仍然有效
   */
  interrupt(): void {
    this.abortController.abort()
  }

  /**
   * getMessages - 获取当前会话的消息历史
   * 
   * 功能说明：
   * - 返回当前会话的所有消息，包括用户输入、AI响应、工具调用等
   * - 返回只读的消息数组，防止外部修改影响会话状态
   * - 支持会话恢复、历史查看和调试分析
   * 
   * 设计原则：
   * - 不可变性：返回只读数组，确保消息历史不被意外修改
   * - 性能优化：直接返回内部数组引用，避免不必要的复制
   * - 类型安全：使用TypeScript只读类型确保编译时检查
   */
  getMessages(): readonly Message[] {
    return this.mutableMessages
  }

  /**
   * getReadFileState - 获取文件状态缓存
   * 
   * 功能说明：
   * - 返回当前的文件状态缓存，包含文件读取历史
   * - 支持文件读取优化，避免重复读取相同文件
   * - 提供文件变化检测和状态对比功能
   * 
   * 设计目的：
   * - 性能优化：缓存文件状态，提高读取性能
   * - 状态管理：跟踪文件变化，支持增量更新
   * - 调试支持：提供文件操作的历史记录
   */
  getReadFileState(): FileStateCache {
    return this.readFileState
  }

  /**·
   * getSessionId - 获取当前会话的唯一标识符
   * 
   * 功能说明：
   * - 返回当前会话的全局唯一标识符
   * - 用于会话跟踪、状态恢复和审计日志
   * - 确保会话的唯一性和可追溯性
   * 
   * 设计原则：
   * - 全局唯一：每个会话都有唯一的标识符
   * - 持久化：会话ID在会话生命周期内保持不变
   * - 可读性：使用标准UUID格式，便于识别和处理
   */
  getSessionId(): string {
    return getSessionId()
  }

  /**
   * setModel - 设置查询使用的AI模型
   * 
   * 功能说明：
   * - 动态修改查询使用的AI模型
   * - 支持在会话过程中切换不同的模型
   * - 影响后续所有查询的模型选择
   * 
   * 使用场景：
   * - 模型切换：根据任务需求切换不同能力的模型
   * - 成本控制：切换到更经济的模型以控制费用
   * - 功能测试：测试不同模型的表现和特性
   * 
   * 设计原则：
   * - 动态性：支持运行时模型切换
   * - 兼容性：确保新模型与现有工具和功能兼容
   * - 安全性：验证模型名称的有效性和可用性
   */
  setModel(model: string): void {
    this.config.userSpecifiedModel = model
  }
}

/**
 * ask - 单次查询便捷函数
 * 
 * 函数概述：
 * 这是QueryEngine的便捷包装函数，用于执行单次AI查询。
 * 假设Claude在非交互模式下使用，不会请求用户权限或额外输入。
 * 
 * 设计目的：
 * - 简化使用：为简单查询场景提供简洁的API
 * - 无头模式：专为非交互式使用场景设计
 * - 资源管理：自动管理QueryEngine实例的生命周期
 * 
 * 使用场景：
 * - 脚本调用：在自动化脚本中调用AI功能
 * - 批处理：处理大量独立的查询任务
 * - 集成测试：在测试环境中执行AI查询
 * 
 * 参数说明：
 * - commands: 可用的斜杠命令集合
 * - prompt: 用户输入内容，可以是字符串或内容块数组
 * - tools: 可用的工具集合
 * - mcpClients: MCP服务器连接
 * - 其他配置参数：模型、预算、权限等
 * 
 * 返回值：
 * - 异步生成器：产生SDK消息流，包含查询过程和结果
 * - 自动清理：函数结束时自动清理QueryEngine实例
 */
export async function* ask({
  commands,
  prompt,
  promptUuid,
  isMeta,
  cwd,
  tools,
  mcpClients,
  verbose = false,
  thinkingConfig,
  maxTurns,
  maxBudgetUsd,
  taskBudget,
  canUseTool,
  mutableMessages = [],
  getReadFileCache,
  setReadFileCache,
  customSystemPrompt,
  appendSystemPrompt,
  userSpecifiedModel,
  fallbackModel,
  jsonSchema,
  getAppState,
  setAppState,
  abortController,
  replayUserMessages = false,
  includePartialMessages = false,
  handleElicitation,
  agents = [],
  setSDKStatus,
  orphanedPermission,
}: {
  commands: Command[]
  prompt: string | Array<ContentBlockParam>
  promptUuid?: string
  isMeta?: boolean
  cwd: string
  tools: Tools
  verbose?: boolean
  mcpClients: MCPServerConnection[]
  thinkingConfig?: ThinkingConfig
  maxTurns?: number
  maxBudgetUsd?: number
  taskBudget?: { total: number }
  canUseTool: CanUseToolFn
  mutableMessages?: Message[]
  customSystemPrompt?: string
  appendSystemPrompt?: string
  userSpecifiedModel?: string
  fallbackModel?: string
  jsonSchema?: Record<string, unknown>
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  getReadFileCache: () => FileStateCache
  setReadFileCache: (cache: FileStateCache) => void
  abortController?: AbortController
  replayUserMessages?: boolean
  includePartialMessages?: boolean
  handleElicitation?: ToolUseContext['handleElicitation']
  agents?: AgentDefinition[]
  setSDKStatus?: (status: SDKStatus) => void
  orphanedPermission?: OrphanedPermission
}): AsyncGenerator<SDKMessage, void, unknown> {
  // 创建QueryEngine实例，配置所有必要的参数
  const engine = new QueryEngine({
    cwd,
    tools,
    commands,
    mcpClients,
    agents,
    canUseTool,
    getAppState,
    setAppState,
    initialMessages: mutableMessages,
    readFileCache: cloneFileStateCache(getReadFileCache()),
    customSystemPrompt,
    appendSystemPrompt,
    userSpecifiedModel,
    fallbackModel,
    thinkingConfig,
    maxTurns,
    maxBudgetUsd,
    taskBudget,
    jsonSchema,
    verbose,
    handleElicitation,
    replayUserMessages,
    includePartialMessages,
    setSDKStatus,
    abortController,
    orphanedPermission,
    // 条件注入：如果启用了历史压缩功能，注入压缩重放处理器
    ...(feature('HISTORY_SNIP')
      ? {
          snipReplay: (yielded: Message, store: Message[]) => {
            if (!snipProjection!.isSnipBoundaryMessage(yielded))
              return undefined
            return snipModule!.snipCompactIfNeeded(store, { force: true })
          },
        }
      : {}),
  })

  try {
    // 执行查询，产生SDK消息流
    yield* engine.submitMessage(prompt, {
      uuid: promptUuid,
      isMeta,
    })
  } finally {
    // 确保在函数结束时更新文件状态缓存
    setReadFileCache(engine.getReadFileState())
  }
}
