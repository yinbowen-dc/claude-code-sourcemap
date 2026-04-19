/**
 * Swarm 后端系统共享类型定义模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 该模块是整个 Swarm 多智能体后端系统的类型基础层，
 * 被 TmuxBackend、ITermBackend、InProcessBackend、PaneBackendExecutor、
 * registry.ts 以及 swarm 工具层等所有后端相关模块引用。
 *
 * 架构设计：
 * 本模块定义了两个核心抽象接口：
 * 1. PaneBackend — 低级终端窗格操作接口（tmux/iTerm2 实现）
 *    负责创建、样式化、显示/隐藏、关闭终端窗格
 * 2. TeammateExecutor — 高级 teammate 生命周期管理接口（所有模式实现）
 *    负责生成、通信、关闭、状态查询 teammate
 *
 * PaneBackendExecutor 是连接两者的适配器，将 PaneBackend → TeammateExecutor。
 *
 * 主要类型：
 * - BackendType：后端类型枚举（'tmux' | 'iterm2' | 'in-process'）
 * - PaneBackend：终端窗格操作接口
 * - TeammateExecutor：teammate 执行接口
 * - TeammateIdentity / TeammateSpawnConfig / TeammateSpawnResult：生命周期类型
 * - TeammateMessage：消息通信类型
 * - BackendDetectionResult：后端检测结果
 * - isPaneBackend：类型守卫函数
 */

import type { AgentColorName } from '../../../tools/AgentTool/agentColorManager.js'

// =============================================================================
// 后端类型定义
// =============================================================================

/**
 * 可用的后端类型枚举。
 * - 'tmux'：使用 tmux 管理终端窗格，支持独立运行和嵌入 tmux 两种模式
 * - 'iterm2'：使用 iTerm2 原生分割窗格，通过 it2 CLI 操作
 * - 'in-process'：在同一 Node.js 进程中运行 teammate，使用 AsyncLocalStorage 隔离
 */
export type BackendType = 'tmux' | 'iterm2' | 'in-process'

/**
 * 仅包含基于终端窗格的后端类型。
 * 用于只处理终端窗格操作的消息和类型，排除 in-process 模式。
 */
export type PaneBackendType = 'tmux' | 'iterm2'

/**
 * 窗格的不透明标识符。
 * - tmux 后端：tmux 窗格 ID（如 "%1"、"%42"）
 * - iTerm2 后端：it2 返回的会话 ID（字符串格式）
 */
export type PaneId = string

/**
 * 创建 teammate 窗格的结果。
 * 包含新窗格的 ID 和是否为第一个 teammate（影响布局策略）。
 */
export type CreatePaneResult = {
  /** 新创建窗格的 ID */
  paneId: PaneId
  /** 是否为第一个 teammate 窗格（影响 leader 窗格的放置策略）*/
  isFirstTeammate: boolean
}

// =============================================================================
// PaneBackend 接口（低级窗格操作）
// =============================================================================

/**
 * 终端窗格管理后端接口。
 * 抽象了在 Swarm 模式下创建和管理终端窗格的操作，
 * 使上层代码无需关心底层是 tmux 还是 iTerm2。
 *
 * 实现类：TmuxBackend（tmux 后端）、ITermBackend（iTerm2 后端）
 */
export type PaneBackend = {
  /** 后端类型标识符 */
  readonly type: BackendType

  /** 后端的人类可读显示名称（用于日志和 UI）*/
  readonly displayName: string

  /** 是否支持隐藏/显示窗格操作（tmux 支持，iTerm2 不支持）*/
  readonly supportsHideShow: boolean

  /**
   * 检查后端在当前系统上是否可用。
   * - tmux：检查 tmux 命令是否存在
   * - iTerm2：检查 it2 CLI 是否安装且配置正确
   */
  isAvailable(): Promise<boolean>

  /**
   * 检查当前是否正在后端的原生环境中运行。
   * - tmux：是否在 tmux 会话中运行
   * - iTerm2：是否在 iTerm2 终端中运行
   */
  isRunningInside(): Promise<boolean>

  /**
   * 在 Swarm 视图中为 teammate 创建新窗格。
   * 后端负责决定布局策略（是否有 leader 窗格等）。
   *
   * @param name teammate 的名称（用于窗格标题显示）
   * @param color 窗格边框/标题的颜色
   * @returns 新窗格的 ID 和布局信息
   */
  createTeammatePaneInSwarmView(
    name: string,
    color: AgentColorName,
  ): Promise<CreatePaneResult>

  /**
   * 向指定窗格发送要执行的命令。
   *
   * @param paneId 目标窗格的 ID
   * @param command 要在窗格中执行的命令字符串
   * @param useExternalSession 是否使用外部 session socket（tmux 特有，用于外部 swarm 会话）
   */
  sendCommandToPane(
    paneId: PaneId,
    command: string,
    useExternalSession?: boolean,
  ): Promise<void>

  /**
   * 设置窗格的边框颜色（用于 teammate 颜色区分）。
   *
   * @param paneId 目标窗格的 ID
   * @param color 要应用的边框颜色
   * @param useExternalSession 是否使用外部 session socket（tmux 特有）
   */
  setPaneBorderColor(
    paneId: PaneId,
    color: AgentColorName,
    useExternalSession?: boolean,
  ): Promise<void>

  /**
   * 设置窗格的标题（显示在窗格边框/标题栏中）。
   *
   * @param paneId 目标窗格的 ID
   * @param name 要显示的标题文本
   * @param color 标题文字的颜色
   * @param useExternalSession 是否使用外部 session socket（tmux 特有）
   */
  setPaneTitle(
    paneId: PaneId,
    name: string,
    color: AgentColorName,
    useExternalSession?: boolean,
  ): Promise<void>

  /**
   * 启用窗格边框状态显示（在边框中显示标题）。
   *
   * @param windowTarget 要启用状态显示的窗口（可选）
   * @param useExternalSession 是否使用外部 session socket（tmux 特有）
   */
  enablePaneBorderStatus(
    windowTarget?: string,
    useExternalSession?: boolean,
  ): Promise<void>

  /**
   * 重新平衡窗格布局（在添加/删除窗格后调整大小）。
   *
   * @param windowTarget 包含窗格的窗口目标标识
   * @param hasLeader 是否有 leader 窗格（影响布局计算策略）
   */
  rebalancePanes(windowTarget: string, hasLeader: boolean): Promise<void>

  /**
   * 关闭/删除指定窗格。
   *
   * @param paneId 要关闭的窗格 ID
   * @param useExternalSession 是否使用外部 session socket（tmux 特有）
   * @returns true 表示成功关闭，false 表示失败
   */
  killPane(paneId: PaneId, useExternalSession?: boolean): Promise<boolean>

  /**
   * 隐藏窗格（将其移至隐藏窗口，但保持运行）。
   * tmux 实现：使用 break-pane -d 移至 claude-hidden 会话。
   * iTerm2 实现：不支持，返回 false。
   *
   * @param paneId 要隐藏的窗格 ID
   * @param useExternalSession 是否使用外部 session socket（tmux 特有）
   * @returns true 表示成功隐藏，false 表示不支持或失败
   */
  hidePane(paneId: PaneId, useExternalSession?: boolean): Promise<boolean>

  /**
   * 显示之前被隐藏的窗格（重新加入主窗口布局）。
   * tmux 实现：使用 join-pane -h，再执行 main-vertical 重新平衡。
   * iTerm2 实现：不支持，返回 false。
   *
   * @param paneId 要显示的窗格 ID
   * @param targetWindowOrPane 目标窗口或窗格标识
   * @param useExternalSession 是否使用外部 session socket（tmux 特有）
   * @returns true 表示成功显示，false 表示不支持或失败
   */
  showPane(
    paneId: PaneId,
    targetWindowOrPane: string,
    useExternalSession?: boolean,
  ): Promise<boolean>
}

// =============================================================================
// 后端检测结果
// =============================================================================

/**
 * 后端检测结果类型。
 * registry.ts 的 detectAndGetBackend() 函数返回此类型。
 */
export type BackendDetectionResult = {
  /** 应使用的后端实例 */
  backend: PaneBackend
  /** 是否正在该后端的原生环境中运行（如在 tmux 中运行时 tmux 后端 isNative=true）*/
  isNative: boolean
  /** 若检测到 iTerm2 但 it2 未安装，此字段为 true，提示需要安装 it2 */
  needsIt2Setup?: boolean
}

// =============================================================================
// Teammate 生命周期类型（In-Process 模式共用）
// =============================================================================

/**
 * Teammate 身份信息类型（TeammateContext 的子集）。
 * 避免循环依赖：TeammateContext 完整类型由 lifecycle-specialist 模块定义，
 * 本类型仅包含此处需要的字段。
 */
export type TeammateIdentity = {
  /** Agent 名称（如 "researcher"、"tester"）*/
  name: string
  /** 所属团队名称 */
  teamName: string
  /** UI 差异化显示颜色 */
  color?: AgentColorName
  /** 是否要求在实现前通过计划模式审批 */
  planModeRequired?: boolean
}

/**
 * 生成 teammate 的配置类型（适用于所有执行模式）。
 * 扩展 TeammateIdentity，增加运行时所需的全部参数。
 */
export type TeammateSpawnConfig = TeammateIdentity & {
  /** 发送给 teammate 的初始提示词 */
  prompt: string
  /** teammate 的工作目录 */
  cwd: string
  /** 要使用的 AI 模型（可选，默认继承领导者配置）*/
  model?: string
  /** teammate 的系统提示词（从工作流配置解析而来）*/
  systemPrompt?: string
  /** 系统提示词应用方式：'replace'（替换默认）或 'append'（追加到默认）*/
  systemPromptMode?: 'default' | 'replace' | 'append'
  /** 可选的 git worktree 路径（隔离文件系统修改）*/
  worktreePath?: string
  /** 父会话 ID（用于上下文关联）*/
  parentSessionId: string
  /** 授予 teammate 的工具权限列表 */
  permissions?: string[]
  /** 是否允许 teammate 对未列出的工具弹出权限提示。
   * false（默认）时，未授权工具自动拒绝。*/
  allowPermissionPrompts?: boolean
}

/**
 * 生成 teammate 的结果类型。
 * 不同后端类型返回不同的控制字段：
 * - pane-based：返回 paneId
 * - in-process：返回 abortController 和 taskId
 */
export type TeammateSpawnResult = {
  /** 是否生成成功 */
  success: boolean
  /** 唯一 agent ID（格式：agentName@teamName）*/
  agentId: string
  /** 失败时的错误信息 */
  error?: string

  /**
   * 生命周期控制用的 AbortController（仅 in-process 模式）。
   * 领导者通过此控制器取消/终止 teammate。
   * 窗格模式 teammate 使用 kill() 方法替代。
   */
  abortController?: AbortController

  /**
   * AppState.tasks 中的任务 ID（仅 in-process 模式）。
   * 用于 UI 渲染和进度追踪。
   * agentId 是逻辑标识符；taskId 是 AppState 索引键。
   */
  taskId?: string

  /** 窗格 ID（仅窗格模式）*/
  paneId?: PaneId
}

/**
 * 发送给 teammate 的消息类型。
 * 通过文件邮箱传递，格式在所有后端模式间保持一致。
 */
export type TeammateMessage = {
  /** 消息正文 */
  text: string
  /** 发送者的 agent ID */
  from: string
  /** 发送者的显示颜色（可选）*/
  color?: string
  /** 消息时间戳（ISO 字符串格式）*/
  timestamp?: string
  /** UI 预览摘要（5-10 个词，显示在消息列表中）*/
  summary?: string
}

// =============================================================================
// TeammateExecutor 接口（高级 teammate 生命周期管理）
// =============================================================================

/**
 * Teammate 执行后端的统一接口。
 * 抽象了窗格模式（tmux/iTerm2）与进程内模式之间的差异，
 * 使上层代码（TeammeTool、swarm 协调器等）无需关心底层实现。
 *
 * PaneBackend 处理低级窗格操作；TeammateExecutor 处理
 * 高级 teammate 生命周期操作，适用于所有后端模式。
 *
 * 实现类：
 * - PaneBackendExecutor（适配器：PaneBackend → TeammateExecutor）
 * - InProcessBackend（直接实现）
 */
export type TeammateExecutor = {
  /** 后端类型标识符 */
  readonly type: BackendType

  /** 检查后端在当前系统上是否可用 */
  isAvailable(): Promise<boolean>

  /** 使用给定配置生成新的 teammate */
  spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult>

  /** 向 teammate 发送消息 */
  sendMessage(agentId: string, message: TeammateMessage): Promise<void>

  /** 优雅关闭 teammate（发送关闭请求，等待其自行退出）*/
  terminate(agentId: string, reason?: string): Promise<boolean>

  /** 强制终止 teammate（立即终止，不等待）*/
  kill(agentId: string): Promise<boolean>

  /** 检查 teammate 是否仍在运行 */
  isActive(agentId: string): Promise<boolean>
}

// =============================================================================
// 类型守卫
// =============================================================================

/**
 * 类型守卫：检查后端类型是否为基于终端窗格的后端（tmux 或 iTerm2）。
 * 用于在需要窗格 ID 或窗格特有操作时的类型收窄。
 *
 * @param type 要检查的后端类型
 * @returns 若为 'tmux' 或 'iterm2' 则返回 true，同时将类型收窄为 'tmux' | 'iterm2'
 */
export function isPaneBackend(type: BackendType): type is 'tmux' | 'iterm2' {
  return type === 'tmux' || type === 'iterm2'
}
