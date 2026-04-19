/**
 * types.ts — Bridge 核心类型定义中心
 *
 * 在 Claude Code 系统流程中的位置：
 *   Bridge 模块（src/bridge/）的类型基础设施
 *     ├─> bridgeMain.ts / replBridge.ts（使用 BridgeConfig、SessionHandle 等运行时类型）
 *     ├─> bridgeApi.ts（实现 BridgeApiClient 接口）
 *     ├─> sessionRunner.ts（使用 WorkData、WorkResponse、WorkSecret 处理工作项）
 *     └─> sessionHandle.ts（实现 SessionHandle 接口）
 *
 * 主要类型分组：
 *   1. 环境/工作项协议类型：WorkData、WorkResponse、WorkSecret
 *      与服务端 environments API 的 wire format 一一对应
 *   2. Bridge 运行时配置：BridgeConfig（dir/机器名/最大会话数/spawn 模式等）
 *   3. 会话管理接口：SessionHandle、SessionSpawnOpts、SessionSpawner
 *   4. Bridge API 客户端接口：BridgeApiClient（轮询/确认/心跳/归档等）
 *   5. 日志/显示接口：BridgeLogger（多会话状态显示、进度追踪）
 *   6. 枚举/联合类型：SpawnMode、BridgeWorkerType、SessionDoneStatus 等
 */

/** 单个 Bridge 会话的默认超时时间（24 小时，单位：毫秒） */
export const DEFAULT_SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000

/** Bridge 认证错误时附加的登录引导语句（显示在错误信息末尾） */
export const BRIDGE_LOGIN_INSTRUCTION =
  'Remote Control is only available with claude.ai subscriptions. Please use `/login` to sign in with your claude.ai account.'

/** `claude remote-control` 未登录时的完整错误信息 */
export const BRIDGE_LOGIN_ERROR =
  'Error: You must be logged in to use Remote Control.\n\n' +
  BRIDGE_LOGIN_INSTRUCTION

/** 用户断开 Remote Control（通过 /remote-control 或 ultraplan 启动）时显示的提示信息 */
export const REMOTE_CONTROL_DISCONNECTED_MSG = 'Remote Control disconnected.'

// --- 环境 API 协议类型（与服务端 wire format 对应）---

/**
 * 工作项数据类型。
 *
 * type：
 *   - 'session'：正常的会话工作项（用户发起的代码执行请求）
 *   - 'healthcheck'：服务端发起的健康检查请求（无实际工作，仅测试连通性）
 * id：工作项唯一标识符
 */
export type WorkData = {
  type: 'session' | 'healthcheck'
  id: string
}

/**
 * 服务端返回的工作响应（/poll 接口的响应体）。
 *
 * secret 字段为 base64url 编码的 JSON，解码后为 WorkSecret 类型，
 * 包含 session_ingress_token、api_base_url 等启动会话所需的凭证信息。
 */
export type WorkResponse = {
  id: string
  type: 'work'
  environment_id: string
  state: string
  data: WorkData
  secret: string // base64url-encoded JSON，解码后为 WorkSecret
  created_at: string
}

/**
 * 工作项密钥（WorkResponse.secret 解码后的结构）。
 *
 * 包含启动 Claude Code 子会话所需的全部凭证和配置：
 *   - session_ingress_token：JWT，用于 WebSocket 认证和 API 调用
 *   - api_base_url：子会话应连接的 API 地址
 *   - sources：代码来源（git 仓库信息等）
 *   - auth：认证令牌数组（可能包含多种认证方式）
 *   - claude_code_args：传递给 Claude Code 子进程的额外命令行参数
 *   - mcp_config：MCP（Model Context Protocol）配置
 *   - environment_variables：注入子进程的环境变量
 *   - use_code_sessions：服务端驱动的 CCR v2 选择器（ccr_v2_compat_enabled 开启时由服务端设置）
 */
export type WorkSecret = {
  version: number
  session_ingress_token: string
  api_base_url: string
  sources: Array<{
    type: string
    git_info?: { type: string; repo: string; ref?: string; token?: string }
  }>
  auth: Array<{ type: string; token: string }>
  claude_code_args?: Record<string, string> | null
  mcp_config?: unknown | null
  environment_variables?: Record<string, string> | null
  /**
   * 服务端驱动的 CCR v2 选择器。
   * 当会话通过 v2 兼容层（ccr_v2_compat_enabled）创建时，
   * 由 prepare_work_secret() 在服务端设置为 true。
   * BYOC runner 在 environment-runner/sessionExecutor.ts 中读取此字段。
   *
   * Server-driven CCR v2 selector. Set by prepare_work_secret() when the
   * session was created via the v2 compat layer (ccr_v2_compat_enabled).
   */
  use_code_sessions?: boolean
}

/** 会话完成状态：正常完成、失败、或被中断 */
export type SessionDoneStatus = 'completed' | 'failed' | 'interrupted'

/** 会话活动类型：工具启动、文本输出、结果、错误 */
export type SessionActivityType = 'tool_start' | 'text' | 'result' | 'error'

/**
 * 会话活动记录（用于 Bridge Logger 显示和状态追踪）。
 *
 * 存储最近的会话活动（如"Editing src/foo.ts"、"Reading package.json"），
 * SessionHandle.activities 维护一个最近约 10 条的环形缓冲。
 */
export type SessionActivity = {
  type: SessionActivityType
  summary: string // 例如："Editing src/foo.ts"、"Reading package.json"
  timestamp: number
}

/**
 * Remote Control 会话的工作目录选择模式。
 *
 *   - `single-session`：单会话模式，在 cwd 运行，会话结束时 bridge 退出
 *   - `worktree`：持久化服务器，每个会话获得独立的 git worktree（会话间隔离）
 *   - `same-dir`：持久化服务器，所有会话共享 cwd（会话间可能相互影响）
 *
 * How `claude remote-control` chooses session working directories.
 */
export type SpawnMode = 'single-session' | 'worktree' | 'same-dir'

/**
 * 本代码库产生的 worker_type 枚举。
 *
 * 在环境注册时作为 `metadata.worker_type` 发送，使 claude.ai 可以按来源过滤
 * 会话选择器（如 assistant tab 只显示 assistant worker）。
 * 后端将此字段视为不透明字符串——桌面协作功能发送 "cowork"，不在此联合类型内。
 * REPL 代码使用此窄类型作穷举性检查；wire-level 字段接受任意字符串。
 *
 * Well-known worker_type values THIS codebase produces.
 */
export type BridgeWorkerType = 'claude_code' | 'claude_code_assistant'

/**
 * Bridge 运行时配置（从命令行参数和环境解析而来）。
 *
 * 在 bridgeMain.ts 和 replBridge.ts 初始化时构建，
 * 整个 Bridge 生命周期内保持不变。
 */
export type BridgeConfig = {
  /** 工作目录（会话子进程的 cwd） */
  dir: string
  /** 机器名称（显示在 claude.ai 的 session picker 中） */
  machineName: string
  /** 当前 git 分支名称 */
  branch: string
  /** Git 仓库远程 URL（无 git 仓库时为 null） */
  gitRepoUrl: string | null
  /** 允许的最大并发会话数 */
  maxSessions: number
  /** 会话工作目录生成模式 */
  spawnMode: SpawnMode
  /** 是否启用详细日志 */
  verbose: boolean
  /** 是否在沙盒模式下运行 */
  sandbox: boolean
  /** 客户端生成的 UUID，标识本 bridge 实例（用于环境注册） */
  bridgeId: string
  /**
   * 发送为 metadata.worker_type，使 web 客户端可按来源过滤。
   * 后端视此为不透明字符串，不仅限于 BridgeWorkerType 枚举。
   */
  workerType: string
  /** 客户端生成的 UUID，用于幂等的环境注册请求 */
  environmentId: string
  /**
   * 后端颁发的 environment_id，用于重连时重用（而非创建新环境）。
   * 设置时，后端将注册请求视为对已有环境的重连。
   * 由 `claude remote-control --session-id` 恢复会话时使用。
   * 必须为后端格式的 ID——客户端 UUID 会被服务端以 400 拒绝。
   */
  reuseEnvironmentId?: string
  /** bridge 连接的 API 基础 URL（用于轮询） */
  apiBaseUrl: string
  /** WebSocket 连接的 session ingress 基础 URL（本地开发时可能与 apiBaseUrl 不同） */
  sessionIngressUrl: string
  /** 通过 --debug-file 传入的调试文件路径 */
  debugFile?: string
  /** 单个会话的超时时间（毫秒），超时后会话被终止 */
  sessionTimeoutMs?: number
}

// --- 依赖注入接口（提升可测试性）---

/**
 * 会话权限响应事件（control_response）。
 *
 * 通过 session events API 发回给会话的权限决策事件。
 * subtype 固定为 'success'（符合 SDK 协议），
 * 内层 response 携带权限决策 payload（如 `{ behavior: 'allow' }`）。
 *
 * A control_response event sent back to a session (e.g. a permission decision).
 */
export type PermissionResponseEvent = {
  type: 'control_response'
  response: {
    subtype: 'success'
    request_id: string
    response: Record<string, unknown>
  }
}

/**
 * Bridge API 客户端接口（environments API 的完整方法集）。
 *
 * 由 bridgeApi.ts 实现，通过依赖注入传入各 bridge 组件，
 * 使单元测试可以通过 mock 实现替换真实 HTTP 调用。
 *
 * 主要方法：
 *   - registerBridgeEnvironment：注册 bridge 环境，获取 environment_id 和 environment_secret
 *   - pollForWork：轮询工作项（返回 WorkResponse | null）
 *   - acknowledgeWork：确认工作项已接收（避免服务端重派发）
 *   - stopWork：终止工作项（支持强制终止）
 *   - deregisterEnvironment：优雅关闭时注销环境
 *   - sendPermissionResponseEvent：发送权限响应事件（control_response）
 *   - archiveSession：归档会话（使其不再显示为活跃状态）
 *   - reconnectSession：强制停止过期 worker 并在环境上重新排队会话（--session-id 恢复用）
 *   - heartbeatWork：发送轻量级心跳以延长工作项租约（使用 JWT 认证而非 EnvironmentSecretAuth）
 */
export type BridgeApiClient = {
  registerBridgeEnvironment(config: BridgeConfig): Promise<{
    environment_id: string
    environment_secret: string
  }>
  pollForWork(
    environmentId: string,
    environmentSecret: string,
    signal?: AbortSignal,
    reclaimOlderThanMs?: number,
  ): Promise<WorkResponse | null>
  acknowledgeWork(
    environmentId: string,
    workId: string,
    sessionToken: string,
  ): Promise<void>
  /** 通过 environments API 停止工作项 */
  stopWork(environmentId: string, workId: string, force: boolean): Promise<void>
  /** 优雅关闭时注销/删除 bridge 环境 */
  deregisterEnvironment(environmentId: string): Promise<void>
  /** 通过 session events API 向会话发送权限响应事件（control_response） */
  sendPermissionResponseEvent(
    sessionId: string,
    event: PermissionResponseEvent,
    sessionToken: string,
  ): Promise<void>
  /** 归档会话，使其不再在服务端显示为活跃状态 */
  archiveSession(sessionId: string): Promise<void>
  /**
   * 强制停止过期 worker 实例并在环境上重新排队会话。
   * 由 `--session-id` 在原 bridge 崩溃后恢复会话时使用。
   */
  reconnectSession(environmentId: string, sessionId: string): Promise<void>
  /**
   * 为活跃工作项发送轻量级心跳，延长其租约。
   * 使用 SessionIngressAuth（JWT，无 DB 访问）而非 EnvironmentSecretAuth。
   * 返回服务端响应（含租约状态）。
   */
  heartbeatWork(
    environmentId: string,
    workId: string,
    sessionToken: string,
  ): Promise<{ lease_extended: boolean; state: string }>
}

/**
 * 会话句柄接口（代表一个正在运行的 Claude Code 子会话）。
 *
 * 由 sessionHandle.ts 实现，通过 SessionSpawner.spawn() 创建。
 * 包含会话生命周期管理、活动追踪、令牌更新等能力。
 */
export type SessionHandle = {
  /** 会话唯一标识符 */
  sessionId: string
  /** 会话完成 Promise，resolved 时返回完成状态 */
  done: Promise<SessionDoneStatus>
  /** 优雅终止会话（发送 SIGTERM） */
  kill(): void
  /** 强制终止会话（发送 SIGKILL） */
  forceKill(): void
  /** 最近活动的环形缓冲（最多约 10 条） */
  activities: SessionActivity[]
  /** 最近一条活动（当前正在执行的工具或文本输出） */
  currentActivity: SessionActivity | null
  /** session_ingress_token（用于 API 调用的 JWT） */
  accessToken: string
  /** 最近几行 stderr 输出的环形缓冲 */
  lastStderr: string[]
  /** 直接向子进程 stdin 写入数据 */
  writeStdin(data: string): void
  /** 更新运行中会话的访问令牌（如令牌刷新后调用） */
  updateAccessToken(token: string): void
}

/**
 * 会话启动选项（传入 SessionSpawner.spawn()）。
 *
 * 包含启动 Claude Code 子进程所需的完整参数。
 */
export type SessionSpawnOpts = {
  /** 会话唯一标识符 */
  sessionId: string
  /** SDK URL（子进程连接的 WebSocket 端点） */
  sdkUrl: string
  /** 访问令牌（session_ingress_token） */
  accessToken: string
  /** 是否使用 CCR v2 环境变量（SSE transport + CCRClient）启动子进程 */
  useCcrV2?: boolean
  /** useCcrV2 为 true 时必需，从 POST /worker/register 获取 */
  workerEpoch?: number
  /**
   * 子进程 stdout 中检测到首条真实用户消息时触发（通过 --replay-user-messages）。
   * 允许调用方在尚无会话标题时从消息内容派生标题。
   * 工具结果和合成用户消息会被跳过，只有真实用户文本消息触发此回调。
   */
  onFirstUserMessage?: (text: string) => void
}

/**
 * 会话生成器接口（抽象会话启动逻辑，提升可测试性）。
 *
 * 由 sessionRunner.ts 使用，生产环境下注入真实的 spawn 实现，
 * 测试中可注入 mock 实现。
 */
export type SessionSpawner = {
  spawn(opts: SessionSpawnOpts, dir: string): SessionHandle
}

/**
 * Bridge 日志/显示接口（多会话状态 UI 的抽象层）。
 *
 * 由 bridgeLogger.ts 实现，控制 Bridge 的 Ink 状态显示：
 *   - 横幅（Banner）：启动时打印的 ASCII 信息框
 *   - 空闲/重连/失败/附着状态：驱动主状态行显示
 *   - 多会话列表：每个会话一行，显示进度和活动摘要
 *   - QR 码切换、会话计数更新等辅助功能
 */
export type BridgeLogger = {
  /** 打印 Bridge 启动横幅（含配置信息和环境 ID） */
  printBanner(config: BridgeConfig, environmentId: string): void
  /** 记录会话开始（打印会话 ID 和首条 prompt 摘要） */
  logSessionStart(sessionId: string, prompt: string): void
  /** 记录会话正常完成 */
  logSessionComplete(sessionId: string, durationMs: number): void
  /** 记录会话失败 */
  logSessionFailed(sessionId: string, error: string): void
  /** 打印一般状态信息 */
  logStatus(message: string): void
  /** 打印详细调试信息（仅 verbose 模式） */
  logVerbose(message: string): void
  /** 打印错误信息 */
  logError(message: string): void
  /** 记录重连成功事件（含断线持续时间） */
  logReconnected(disconnectedMs: number): void
  /** 更新为空闲状态（含仓库/分支信息和 shimmer 动画） */
  updateIdleStatus(): void
  /** 更新为重连状态（显示延迟和已等待时长） */
  updateReconnectingStatus(delayStr: string, elapsedStr: string): void
  /** 更新指定会话的状态（显示已用时间、当前活动、活动历史） */
  updateSessionStatus(
    sessionId: string,
    elapsed: string,
    activity: SessionActivity,
    trail: string[],
  ): void
  /** 清除状态显示 */
  clearStatus(): void
  /** 设置状态行显示的仓库信息 */
  setRepoInfo(repoName: string, branch: string): void
  /** 设置状态行上方显示的调试日志 glob（ant 用户专用） */
  setDebugLogPath(path: string): void
  /** 切换为"已附着"状态（会话开始时调用） */
  setAttached(sessionId: string): void
  /** 更新为失败状态（显示错误信息） */
  updateFailedStatus(error: string): void
  /** 切换 QR 码显示/隐藏 */
  toggleQr(): void
  /** 更新"<n> of <m> sessions"指示器和 spawn 模式提示 */
  updateSessionCount(active: number, max: number, mode: SpawnMode): void
  /** 更新显示的 spawn 模式。传 null 则隐藏（单会话模式或切换不可用时） */
  setSpawnModeDisplay(mode: 'same-dir' | 'worktree' | null): void
  /** 注册新会话到多会话列表（spawn 成功后调用） */
  addSession(sessionId: string, url: string): void
  /** 更新多会话列表中指定会话的活动摘要（当前正在运行的工具） */
  updateSessionActivity(sessionId: string, activity: SessionActivity): void
  /**
   * 设置会话显示标题。
   * 多会话模式下更新 bullet list 条目；
   * 单会话模式下同时在主状态行显示标题。
   * 触发重渲染（在重连/失败状态下受保护，不会意外覆盖状态）。
   */
  setSessionTitle(sessionId: string, title: string): void
  /** 会话结束时从多会话列表移除该会话 */
  removeSession(sessionId: string): void
  /** 强制刷新状态显示（多会话活动刷新时使用） */
  refreshDisplay(): void
}
