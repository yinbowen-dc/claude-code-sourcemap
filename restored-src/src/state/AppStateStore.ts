/**
 * AppState 类型定义与默认值工厂模块
 *
 * 在 Claude Code 的状态管理体系中，本文件处于类型定义层：
 * - 上层：AppState.tsx 的 createStore<AppState>(...) 以本文件的类型和工厂函数为基础，
 *         创建应用全局状态存储
 * - 本层：定义 AppState 类型（100+ 字段，覆盖整个应用所有领域状态），
 *         以及 getDefaultAppState() 初始状态工厂函数
 * - 依赖层：众多子系统类型（MCP、Tool、Task、Plugin、Permission 等）
 *           通过 import type 引入，AppState 是它们的聚合根
 *
 * AppState 的领域分区（按字段功能分组）：
 * - 基础设置：settings / verbose / mainLoopModel
 * - UI 状态：expandedView / footerSelection / viewSelectionMode
 * - 权限：toolPermissionContext
 * - 远程会话：remoteSessionUrl / remoteConnectionStatus / remoteBackgroundTaskCount
 * - REPL 桥接：replBridge* 系列字段（always-on bridge 与 claude.ai 的通信）
 * - 任务系统：tasks / agentNameRegistry / foregroundedTaskId / viewingAgentTaskId
 * - MCP：mcp.{clients, tools, commands, resources}
 * - 插件：plugins.{enabled, disabled, commands, errors}
 * - 推测执行：speculation / speculationSessionTimeSavedMs
 * - 通知/提示：notifications / elicitation / promptSuggestion
 * - tmux/bagel 集成：tungsten*/bagel* 系列字段
 * - computer use MCP：computerUseMcpState
 * - 团队协作：teamContext / standaloneAgentContext / inbox
 * - ultraplan：ultraplan* 系列字段
 */

import type { Notification } from 'src/context/notifications.js'
import type { TodoList } from 'src/utils/todo/types.js'
import type { BridgePermissionCallbacks } from '../bridge/bridgePermissionCallbacks.js'
import type { Command } from '../commands.js'
import type { ChannelPermissionCallbacks } from '../services/mcp/channelPermissions.js'
import type { ElicitationRequestEvent } from '../services/mcp/elicitationHandler.js'
import type {
  MCPServerConnection,
  ServerResource,
} from '../services/mcp/types.js'
import { shouldEnablePromptSuggestion } from '../services/PromptSuggestion/promptSuggestion.js'
import {
  getEmptyToolPermissionContext,
  type Tool,
  type ToolPermissionContext,
} from '../Tool.js'
import type { TaskState } from '../tasks/types.js'
import type { AgentColorName } from '../tools/AgentTool/agentColorManager.js'
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js'
import type { AllowedPrompt } from '../tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import type { AgentId } from '../types/ids.js'
import type { Message, UserMessage } from '../types/message.js'
import type { LoadedPlugin, PluginError } from '../types/plugin.js'
import type { DeepImmutable } from '../types/utils.js'
import {
  type AttributionState,
  createEmptyAttributionState,
} from '../utils/commitAttribution.js'
import type { EffortValue } from '../utils/effort.js'
import type { FileHistoryState } from '../utils/fileHistory.js'
import type { REPLHookContext } from '../utils/hooks/postSamplingHooks.js'
import type { SessionHooksState } from '../utils/hooks/sessionHooks.js'
import type { ModelSetting } from '../utils/model/model.js'
import type { DenialTrackingState } from '../utils/permissions/denialTracking.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import type { SettingsJson } from '../utils/settings/types.js'
import { shouldEnableThinkingByDefault } from '../utils/thinking.js'
import type { Store } from './store.js'

/**
 * 推测执行（Speculation）的完成边界类型。
 *
 * 描述推测执行在哪个操作处"截止"，用于后续合并或丢弃推测结果：
 * - complete：模型输出完整（含 token 计数）
 * - bash：遇到 bash 命令调用
 * - edit：遇到文件编辑操作
 * - denied_tool：遇到被拒绝的工具调用
 */
export type CompletionBoundary =
  | { type: 'complete'; completedAt: number; outputTokens: number }
  | { type: 'bash'; command: string; completedAt: number }
  | { type: 'edit'; toolName: string; filePath: string; completedAt: number }
  | {
      type: 'denied_tool'
      toolName: string
      detail: string
      completedAt: number
    }

/**
 * 推测执行的结果快照。
 *
 * 包含推测生成的消息序列、完成边界信息、以及因预取节省的时间（毫秒）。
 */
export type SpeculationResult = {
  messages: Message[]
  boundary: CompletionBoundary | null
  timeSavedMs: number
}

/**
 * 推测执行状态机。
 *
 * - idle：无推测执行进行中
 * - active：推测执行运行中，包含：
 *   - id / abort：用于取消当前推测
 *   - messagesRef：可变引用，避免每条消息都扩展数组
 *   - writtenPathsRef：已写入 overlay 的相对路径集合
 *   - boundary：当前触发截止的边界（null = 尚未遇到）
 *   - pipelinedSuggestion：流水线模式的提示建议
 */
export type SpeculationState =
  | { status: 'idle' }
  | {
      status: 'active'
      id: string
      abort: () => void
      startTime: number
      messagesRef: { current: Message[] } // Mutable ref - avoids array spreading per message
      writtenPathsRef: { current: Set<string> } // Mutable ref - relative paths written to overlay
      boundary: CompletionBoundary | null
      suggestionLength: number
      toolUseCount: number
      isPipelined: boolean
      contextRef: { current: REPLHookContext }
      pipelinedSuggestion?: {
        text: string
        promptId: 'user_intent' | 'stated_intent'
        generationRequestId: string | null
      } | null
    }

/** 推测执行的 idle 初始状态常量（避免每次创建新对象） */
export const IDLE_SPECULATION_STATE: SpeculationState = { status: 'idle' }

/**
 * 页脚导航项类型。
 *
 * footerSelection 字段使用此类型，标识当前聚焦的页脚 pill
 * （arrow-key 导航，共 6 个 pill）。
 */
export type FooterItem =
  | 'tasks'
  | 'tmux'
  | 'bagel'
  | 'teams'
  | 'bridge'
  | 'companion'

/**
 * Claude Code 应用全局状态类型。
 *
 * 整体分为两部分：
 * 1. DeepImmutable<{...}>：包含基础标量字段，通过 DeepImmutable 保证深度不可变，
 *    防止直接修改嵌套对象（需通过 setState 更新）
 * 2. & { tasks, mcp, plugins, ... }：包含含函数类型或 Map/Set 的字段，
 *    排除在 DeepImmutable 之外，直接以原始类型存储
 *
 * 字段较多（100+），详见各字段注释。
 */
export type AppState = DeepImmutable<{
  settings: SettingsJson           // 用户设置（从 ~/.claude/settings.json 加载）
  verbose: boolean                 // 详细输出模式（--verbose 标志）
  mainLoopModel: ModelSetting      // 主循环模型（null = 使用默认模型）
  mainLoopModelForSession: ModelSetting // 本次会话的主循环模型（不跨会话持久化）
  statusLineText: string | undefined   // 状态栏自定义文字
  expandedView: 'none' | 'tasks' | 'teammates' // 展开视图模式
  isBriefOnly: boolean             // 仅显示简要视图（隐藏详情）
  // Optional - only present when ENABLE_AGENT_SWARMS is true (for dead code elimination)
  showTeammateMessagePreview?: boolean
  selectedIPAgentIndex: number     // 当前选中的 in-process Agent 索引
  // CoordinatorTaskPanel selection: -1 = pill, 0 = main, 1..N = agent rows.
  // AppState (not local) so the panel can read it directly without prop-drilling
  // through PromptInput → PromptInputFooter.
  coordinatorTaskIndex: number
  viewSelectionMode: 'none' | 'selecting-agent' | 'viewing-agent' // 视图选择模式
  // Which footer pill is focused (arrow-key navigation below the prompt).
  // Lives in AppState so pill components rendered outside PromptInput
  // (CompanionSprite in REPL.tsx) can read their own focused state.
  footerSelection: FooterItem | null
  toolPermissionContext: ToolPermissionContext // 工具权限上下文（当前权限模式 + bypass 状态）
  spinnerTip?: string              // 加载中提示文字
  // Agent name from --agent CLI flag or settings (for logo display)
  agent: string | undefined
  // Assistant mode fully enabled (settings + GrowthBook gate + trust).
  // Single source of truth - computed once in main.tsx before option
  // mutation, consumers read this instead of re-calling isAssistantMode().
  kairosEnabled: boolean
  // Remote session URL for --remote mode (shown in footer indicator)
  remoteSessionUrl: string | undefined
  // Remote session WS state (`claude assistant` viewer). 'connected' means the
  // live event stream is open; 'reconnecting' = transient WS drop, backoff
  // in progress; 'disconnected' = permanent close or reconnects exhausted.
  remoteConnectionStatus:
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'disconnected'
  // `claude assistant`: count of background tasks (Agent calls, teammates,
  // workflows) running inside the REMOTE daemon child. Event-sourced from
  // system/task_started and system/task_notification on the WS. The local
  // AppState.tasks is always empty in viewer mode — the tasks live in a
  // different process.
  remoteBackgroundTaskCount: number
  // Always-on bridge: desired state (controlled by /config or footer toggle)
  replBridgeEnabled: boolean
  // Always-on bridge: true when activated via /remote-control command, false when config-driven
  replBridgeExplicit: boolean
  // Outbound-only mode: forward events to CCR but reject inbound prompts/control
  replBridgeOutboundOnly: boolean
  // Always-on bridge: env registered + session created (= "Ready")
  replBridgeConnected: boolean
  // Always-on bridge: ingress WebSocket is open (= "Connected" - user on claude.ai)
  replBridgeSessionActive: boolean
  // Always-on bridge: poll loop is in error backoff (= "Reconnecting")
  replBridgeReconnecting: boolean
  // Always-on bridge: connect URL for Ready state (?bridge=envId)
  replBridgeConnectUrl: string | undefined
  // Always-on bridge: session URL on claude.ai (set when connected)
  replBridgeSessionUrl: string | undefined
  // Always-on bridge: IDs for debugging (shown in dialog when --verbose)
  replBridgeEnvironmentId: string | undefined
  replBridgeSessionId: string | undefined
  // Always-on bridge: error message when connection fails (shown in BridgeDialog)
  replBridgeError: string | undefined
  // Always-on bridge: session name set via `/remote-control <name>` (used as session title)
  replBridgeInitialName: string | undefined
  // Always-on bridge: first-time remote dialog pending (set by /remote-control command)
  showRemoteCallout: boolean
}> & {
  // Unified task state - excluded from DeepImmutable because TaskState contains function types
  tasks: { [taskId: string]: TaskState }
  // Name → AgentId registry populated by Agent tool when `name` is provided.
  // Latest-wins on collision. Used by SendMessage to route by name.
  agentNameRegistry: Map<string, AgentId>
  // Task ID that has been foregrounded - its messages are shown in main view
  foregroundedTaskId?: string
  // Task ID of in-process teammate whose transcript is being viewed (undefined = leader's view)
  viewingAgentTaskId?: string
  // Latest companion reaction from the friend observer (src/buddy/observer.ts)
  companionReaction?: string
  // Timestamp of last /buddy pet — CompanionSprite renders hearts while recent
  companionPetAt?: number
  // TODO (ashwin): see if we can use utility-types DeepReadonly for this
  mcp: {
    clients: MCPServerConnection[]  // 已连接的 MCP 服务器列表
    tools: Tool[]                   // MCP 工具列表
    commands: Command[]             // MCP 命令列表
    resources: Record<string, ServerResource[]> // MCP 资源（按服务器分组）
    /**
     * Incremented by /reload-plugins to trigger MCP effects to re-run
     * and pick up newly-enabled plugin MCP servers. Effects read this
     * as a dependency; the value itself is not consumed.
     */
    pluginReconnectKey: number
  }
  plugins: {
    enabled: LoadedPlugin[]         // 已启用的插件列表
    disabled: LoadedPlugin[]        // 已禁用的插件列表
    commands: Command[]             // 插件提供的命令列表
    /**
     * Plugin system errors collected during loading and initialization.
     * See {@link PluginError} type documentation for complete details on error
     * structure, context fields, and display format.
     */
    errors: PluginError[]
    // Installation status for background plugin/marketplace installation
    installationStatus: {
      marketplaces: Array<{
        name: string
        status: 'pending' | 'installing' | 'installed' | 'failed'
        error?: string
      }>
      plugins: Array<{
        id: string
        name: string
        status: 'pending' | 'installing' | 'installed' | 'failed'
        error?: string
      }>
    }
    /**
     * Set to true when plugin state on disk has changed (background reconcile,
     * /plugin menu install, external settings edit) and active components are
     * stale. In interactive mode, user runs /reload-plugins to consume. In
     * headless mode, refreshPluginState() auto-consumes via refreshActivePlugins().
     */
    needsRefresh: boolean
  }
  agentDefinitions: AgentDefinitionsResult   // 从 agents 目录加载的 Agent 定义列表
  fileHistory: FileHistoryState              // 文件历史快照（用于 rewind 功能）
  attribution: AttributionState             // 代码归因状态（commit attribution）
  todos: { [agentId: string]: TodoList }    // 各 Agent 的待办事项列表
  remoteAgentTaskSuggestions: { summary: string; task: string }[] // 远程 Agent 任务建议
  notifications: {
    current: Notification | null   // 当前显示的通知
    queue: Notification[]          // 待显示的通知队列
  }
  elicitation: {
    queue: ElicitationRequestEvent[] // 待处理的 MCP Elicitation 请求队列
  }
  thinkingEnabled: boolean | undefined      // 是否启用 extended thinking（undefined = 未初始化）
  promptSuggestionEnabled: boolean          // 是否启用提示建议功能
  sessionHooks: SessionHooksState          // 会话钩子状态（postSampling 等）
  tungstenActiveSession?: {
    sessionName: string
    socketName: string
    target: string // The tmux target (e.g., "session:window.pane")
  }
  tungstenLastCapturedTime?: number // Timestamp when frame was captured for model
  tungstenLastCommand?: {
    command: string // The command string to display (e.g., "Enter", "echo hello")
    timestamp: number // When the command was sent
  }
  // Sticky tmux panel visibility — mirrors globalConfig.tungstenPanelVisible for reactivity.
  tungstenPanelVisible?: boolean
  // Transient auto-hide at turn end — separate from tungstenPanelVisible so the
  // pill stays in the footer (user can reopen) but the panel content doesn't take
  // screen space when idle. Cleared on next Tmux tool use or user toggle. NOT persisted.
  tungstenPanelAutoHidden?: boolean
  // WebBrowser tool (codename bagel): pill visible in footer
  bagelActive?: boolean
  // WebBrowser tool: current page URL shown in pill label
  bagelUrl?: string
  // WebBrowser tool: sticky panel visibility toggle
  bagelPanelVisible?: boolean
  // chicago MCP session state. Types inlined (not imported from
  // @ant/computer-use-mcp/types) so external typecheck passes without the
  // ant-scoped dep resolved. Shapes match `AppGrant`/`CuGrantFlags`
  // structurally — wrapper.tsx assigns via structural compatibility. Only
  // populated when feature('CHICAGO_MCP') is active.
  computerUseMcpState?: {
    // Session-scoped app allowlist. NOT persisted across resume.
    allowedApps?: readonly {
      bundleId: string
      displayName: string
      grantedAt: number
    }[]
    // Clipboard/system-key grant flags (orthogonal to allowlist).
    grantFlags?: {
      clipboardRead: boolean
      clipboardWrite: boolean
      systemKeyCombos: boolean
    }
    // Dims-only (NOT the blob) for scaleCoord after compaction. The full
    // `ScreenshotResult` including base64 is process-local in wrapper.tsx.
    lastScreenshotDims?: {
      width: number
      height: number
      displayWidth: number
      displayHeight: number
      displayId?: number
      originX?: number
      originY?: number
    }
    // Accumulated by onAppsHidden, cleared + unhidden at turn end.
    hiddenDuringTurn?: ReadonlySet<string>
    // Which display CU targets. Written back by the package's
    // `autoTargetDisplay` resolver via `onResolvedDisplayUpdated`. Persisted
    // across resume so clicks stay on the display the model last saw.
    selectedDisplayId?: number
    // True when the model explicitly picked a display via `switch_display`.
    // Makes `handleScreenshot` skip the resolver chase chain and honor
    // `selectedDisplayId` directly. Cleared on resolver writeback (pinned
    // display unplugged → Swift fell back to main) and on
    // `switch_display("auto")`.
    displayPinnedByModel?: boolean
    // Sorted comma-joined bundle-ID set the display was last auto-resolved
    // for. `handleScreenshot` only re-resolves when the allowed set has
    // changed since — keeps the resolver from yanking on every screenshot.
    displayResolvedForApps?: string
  }
  // REPL tool VM context - persists across REPL calls for state sharing
  replContext?: {
    vmContext: import('vm').Context
    registeredTools: Map<
      string,
      {
        name: string
        description: string
        schema: Record<string, unknown>
        handler: (args: Record<string, unknown>) => Promise<unknown>
      }
    >
    console: {
      log: (...args: unknown[]) => void
      error: (...args: unknown[]) => void
      warn: (...args: unknown[]) => void
      info: (...args: unknown[]) => void
      debug: (...args: unknown[]) => void
      getStdout: () => string
      getStderr: () => string
      clear: () => void
    }
  }
  teamContext?: {
    teamName: string
    teamFilePath: string
    leadAgentId: string
    // Self-identity for swarm members (separate processes in tmux panes)
    // Note: This is different from toolUseContext.agentId which is for in-process subagents
    selfAgentId?: string // Swarm member's own ID (same as leadAgentId for leaders)
    selfAgentName?: string // Swarm member's name ('team-lead' for leaders)
    isLeader?: boolean // True if this swarm member is the team leader
    selfAgentColor?: string // Assigned color for UI (used by dynamically joined sessions)
    teammates: {
      [teammateId: string]: {
        name: string
        agentType?: string
        color?: string
        tmuxSessionName: string
        tmuxPaneId: string
        cwd: string
        worktreePath?: string
        spawnedAt: number
      }
    }
  }
  // Standalone agent context for non-swarm sessions with custom name/color
  standaloneAgentContext?: {
    name: string
    color?: AgentColorName
  }
  inbox: {
    messages: Array<{
      id: string
      from: string
      text: string
      timestamp: string
      status: 'pending' | 'processing' | 'processed'
      color?: string
      summary?: string
    }>
  }
  // Worker sandbox permission requests (leader side) - for network access approval
  workerSandboxPermissions: {
    queue: Array<{
      requestId: string
      workerId: string
      workerName: string
      workerColor?: string
      host: string
      createdAt: number
    }>
    selectedIndex: number
  }
  // Pending permission request on worker side (shown while waiting for leader approval)
  pendingWorkerRequest: {
    toolName: string
    toolUseId: string
    description: string
  } | null
  // Pending sandbox permission request on worker side
  pendingSandboxRequest: {
    requestId: string
    host: string
  } | null
  promptSuggestion: {
    text: string | null                              // 提示建议文字（null = 无建议）
    promptId: 'user_intent' | 'stated_intent' | null
    shownAt: number                                  // 建议显示时间戳
    acceptedAt: number                               // 建议被接受时间戳
    generationRequestId: string | null
  }
  speculation: SpeculationState                      // 推测执行状态
  speculationSessionTimeSavedMs: number              // 本次会话累计节省时间（毫秒）
  skillImprovement: {
    suggestion: {
      skillName: string
      updates: { section: string; change: string; reason: string }[]
    } | null
  }
  // Auth version - incremented on login/logout to trigger re-fetching of auth-dependent data
  authVersion: number
  // Initial message to process (from CLI args or plan mode exit)
  // When set, REPL will process the message and trigger a query
  initialMessage: {
    message: UserMessage
    clearContext?: boolean
    mode?: PermissionMode
    // Session-scoped permission rules from plan mode (e.g., "run tests", "install dependencies")
    allowedPrompts?: AllowedPrompt[]
  } | null
  // Pending plan verification state (set when exiting plan mode)
  // Used by VerifyPlanExecution tool to trigger background verification
  pendingPlanVerification?: {
    plan: string
    verificationStarted: boolean
    verificationCompleted: boolean
  }
  // Denial tracking for classifier modes (YOLO, headless, etc.) - falls back to prompting when limits exceeded
  denialTracking?: DenialTrackingState
  // Active overlays (Select dialogs, etc.) for Escape key coordination
  activeOverlays: ReadonlySet<string>
  // Fast mode
  fastMode?: boolean
  // Advisor model for server-side advisor tool (undefined = disabled).
  advisorModel?: string
  // Effort value
  effortValue?: EffortValue
  // Set synchronously in launchUltraplan before the detached flow starts.
  // Prevents duplicate launches during the ~5s window before
  // ultraplanSessionUrl is set by teleportToRemote. Cleared by launchDetached
  // once the URL is set or on failure.
  ultraplanLaunching?: boolean
  // Active ultraplan CCR session URL. Set while the RemoteAgentTask runs;
  // truthy disables the keyword trigger + rainbow. Cleared when the poll
  // reaches terminal state.
  ultraplanSessionUrl?: string
  // Approved ultraplan awaiting user choice (implement here vs fresh session).
  // Set by RemoteAgentTask poll on approval; cleared by UltraplanChoiceDialog.
  ultraplanPendingChoice?: { plan: string; sessionId: string; taskId: string }
  // Pre-launch permission dialog. Set by /ultraplan (slash or keyword);
  // cleared by UltraplanLaunchDialog on choice.
  ultraplanLaunchPending?: { blurb: string }
  // Remote-harness side: set via set_permission_mode control_request,
  // pushed to CCR external_metadata.is_ultraplan_mode by onChangeAppState.
  isUltraplanMode?: boolean
  // Always-on bridge: permission callbacks for bidirectional permission checks
  replBridgePermissionCallbacks?: BridgePermissionCallbacks
  // Channel permission callbacks — permission prompts over Telegram/iMessage/etc.
  // Races against local UI + bridge + hooks + classifier via claim() in
  // interactiveHandler.ts. Constructed once in useManageMCPConnections.
  channelPermissionCallbacks?: ChannelPermissionCallbacks
}

/** AppStateStore 类型别名：Store<AppState> 的具名类型，方便在各模块中传递 */
export type AppStateStore = Store<AppState>

/**
 * 创建应用初始状态。
 *
 * 流程：
 * 1. 通过懒加载 require 避免与 teammate.ts 的循环依赖
 * 2. 检测当前进程是否为 teammate 且需要 plan 模式，确定初始权限模式
 * 3. 组装包含所有字段默认值的完整 AppState 对象
 *
 * 注意：tasks、agentNameRegistry 等含引用类型的字段每次调用都创建新实例，
 * 不共享引用，确保多个 store 实例（测试场景）相互隔离。
 *
 * @returns 完整的 AppState 初始值
 */
export function getDefaultAppState(): AppState {
  // Determine initial permission mode for teammates spawned with plan_mode_required
  // Use lazy require to avoid circular dependency with teammate.ts
  /* eslint-disable @typescript-eslint/no-require-imports */
  const teammateUtils =
    require('../utils/teammate.js') as typeof import('../utils/teammate.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  // teammate + plan_mode_required → 以 plan 模式启动；否则以 default 模式启动
  const initialMode: PermissionMode =
    teammateUtils.isTeammate() && teammateUtils.isPlanModeRequired()
      ? 'plan'
      : 'default'

  return {
    settings: getInitialSettings(),       // 从配置文件加载初始设置
    tasks: {},                            // 任务表初始为空
    agentNameRegistry: new Map(),         // Agent 名称注册表初始为空
    verbose: false,
    mainLoopModel: null, // alias, full name (as with --model or env var), or null (default)
    mainLoopModelForSession: null,
    statusLineText: undefined,
    expandedView: 'none',
    isBriefOnly: false,
    showTeammateMessagePreview: false,
    selectedIPAgentIndex: -1,
    coordinatorTaskIndex: -1,
    viewSelectionMode: 'none',
    footerSelection: null,
    kairosEnabled: false,
    remoteSessionUrl: undefined,
    remoteConnectionStatus: 'connecting',
    remoteBackgroundTaskCount: 0,
    replBridgeEnabled: false,
    replBridgeExplicit: false,
    replBridgeOutboundOnly: false,
    replBridgeConnected: false,
    replBridgeSessionActive: false,
    replBridgeReconnecting: false,
    replBridgeConnectUrl: undefined,
    replBridgeSessionUrl: undefined,
    replBridgeEnvironmentId: undefined,
    replBridgeSessionId: undefined,
    replBridgeError: undefined,
    replBridgeInitialName: undefined,
    showRemoteCallout: false,
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(),  // 从空权限上下文扩展
      mode: initialMode,                  // 覆盖权限模式（default 或 plan）
    },
    agent: undefined,
    agentDefinitions: { activeAgents: [], allAgents: [] },
    fileHistory: {
      snapshots: [],
      trackedFiles: new Set(),
      snapshotSequence: 0,
    },
    attribution: createEmptyAttributionState(),
    mcp: {
      clients: [],
      tools: [],
      commands: [],
      resources: {},
      pluginReconnectKey: 0,
    },
    plugins: {
      enabled: [],
      disabled: [],
      commands: [],
      errors: [],
      installationStatus: {
        marketplaces: [],
        plugins: [],
      },
      needsRefresh: false,
    },
    todos: {},
    remoteAgentTaskSuggestions: [],
    notifications: {
      current: null,
      queue: [],
    },
    elicitation: {
      queue: [],
    },
    thinkingEnabled: shouldEnableThinkingByDefault(), // 按默认规则初始化 extended thinking
    promptSuggestionEnabled: shouldEnablePromptSuggestion(),
    sessionHooks: new Map(),
    inbox: {
      messages: [],
    },
    workerSandboxPermissions: {
      queue: [],
      selectedIndex: 0,
    },
    pendingWorkerRequest: null,
    pendingSandboxRequest: null,
    promptSuggestion: {
      text: null,
      promptId: null,
      shownAt: 0,
      acceptedAt: 0,
      generationRequestId: null,
    },
    speculation: IDLE_SPECULATION_STATE,  // 推测执行初始为 idle 状态
    speculationSessionTimeSavedMs: 0,
    skillImprovement: {
      suggestion: null,
    },
    authVersion: 0,
    initialMessage: null,
    effortValue: undefined,
    activeOverlays: new Set<string>(),
    fastMode: false,
  }
}
