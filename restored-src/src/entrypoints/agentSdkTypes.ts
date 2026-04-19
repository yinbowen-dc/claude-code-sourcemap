/**
 * @file agentSdkTypes.ts
 * @description Claude Code Agent SDK 公共类型入口文件
 *
 * 【在系统流程中的位置与作用】
 * 本文件是整个 Claude Code Agent SDK 的"类型总出口"，位于 entrypoints/ 目录下，
 * 作为外部调用方（Python SDK、第三方集成商、Daemon 进程等）与 Claude Code CLI 内核之间
 * 的类型契约层。系统调用链如下：
 *
 *   外部调用方 (SDK 消费者)
 *     └─> agentSdkTypes.ts          ← 本文件（统一再导出所有公共类型与函数）
 *           ├─> sdk/coreTypes.ts     （可序列化的核心数据类型：消息、配置等）
 *           ├─> sdk/runtimeTypes.ts  （不可序列化的运行时类型：回调函数、接口等）
 *           ├─> sdk/controlTypes.ts  （控制协议类型，供 SDK 构建者使用）
 *           ├─> sdk/settingsTypes.generated.ts（从 settings JSON Schema 生成的设置类型）
 *           └─> sdk/toolTypes.ts     （工具定义类型，标记为 @internal）
 *
 * 本文件除了类型再导出外，还声明了全套 SDK 函数的"存根签名"（stub signatures）：
 * 这些函数在此文件中均抛出 "not implemented" 错误，真正的实现由 CLI 运行时
 * 在进程启动时通过模块替换注入。SDK 消费者通过这些函数签名获得完整的 TypeScript 类型推断。
 *
 * 包含的功能模块：
 * - 工具注册（tool / createSdkMcpServer）
 * - 单次查询（query）
 * - V2 会话管理（unstable_v2_createSession / resumeSession / prompt）
 * - 会话历史读写（getSessionMessages / listSessions / getSessionInfo）
 * - 会话元数据变更（renameSession / tagSession / forkSession）
 * - 守护进程原语（watchScheduledTasks / buildMissedTaskNotification）
 * - 远程控制桥接（connectRemoteControl）
 *
 * SDK 构建者（bridge subpath consumers）若需要控制协议类型，应直接从
 * sdk/controlTypes.ts 导入，而非通过本文件。
 */

import type {
  CallToolResult,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js'

// 控制协议类型——供 SDK 构建者（bridge subpath 消费者）使用，标记为 alpha 不稳定 API
/** @alpha */
export type {
  SDKControlRequest,
  SDKControlResponse,
} from './sdk/controlTypes.js'
// 再导出核心类型（可序列化的公共数据类型：消息、会话信息、配置等）
export * from './sdk/coreTypes.js'
// 再导出运行时类型（回调函数、带方法的接口等不可序列化类型）
export * from './sdk/runtimeTypes.js'

// 再导出设置类型（由 settings JSON Schema 自动生成）
export type { Settings } from './sdk/settingsTypes.generated.js'
// 再导出工具类型（在 SDK API 稳定前全部标记为 @internal）
export * from './sdk/toolTypes.js'

// ============================================================================
// Functions（函数定义区）
// ============================================================================

import type {
  SDKMessage,
  SDKResultMessage,
  SDKSessionInfo,
  SDKUserMessage,
} from './sdk/coreTypes.js'
// 导入函数签名所需的运行时类型
import type {
  AnyZodRawShape,
  ForkSessionOptions,
  ForkSessionResult,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  InferShape,
  InternalOptions,
  InternalQuery,
  ListSessionsOptions,
  McpSdkServerConfigWithInstance,
  Options,
  Query,
  SDKSession,
  SDKSessionOptions,
  SdkMcpToolDefinition,
  SessionMessage,
  SessionMutationOptions,
} from './sdk/runtimeTypes.js'

export type {
  ListSessionsOptions,
  GetSessionInfoOptions,
  SessionMutationOptions,
  ForkSessionOptions,
  ForkSessionResult,
  SDKSessionInfo,
}

/**
 * 注册一个自定义 MCP 工具定义。
 *
 * 【函数作用】
 * 将工具名称、描述、输入 Schema、处理函数及可选注解组合为
 * SdkMcpToolDefinition 对象，供后续传入 createSdkMcpServer 使用。
 *
 * 注意：本函数在此文件中为存根（stub），实际实现由 CLI 运行时注入。
 *
 * @param _name        工具唯一名称
 * @param _description 工具描述，用于 LLM 工具选择
 * @param _inputSchema Zod 输入验证 Schema
 * @param _handler     工具调用处理函数，返回 MCP CallToolResult
 * @param _extras      可选扩展：注解、搜索提示、是否始终加载
 */
export function tool<Schema extends AnyZodRawShape>(
  _name: string,
  _description: string,
  _inputSchema: Schema,
  _handler: (
    args: InferShape<Schema>,
    extra: unknown,
  ) => Promise<CallToolResult>,
  _extras?: {
    annotations?: ToolAnnotations
    searchHint?: string
    alwaysLoad?: boolean
  },
): SdkMcpToolDefinition<Schema> {
  throw new Error('not implemented')
}

// MCP 服务器配置选项：服务器名称、版本，以及要注册的工具列表
type CreateSdkMcpServerOptions = {
  name: string
  version?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools?: Array<SdkMcpToolDefinition<any>>
}

/**
 * 创建一个可与 SDK 传输层配合使用的 MCP 服务器实例。
 * 允许 SDK 用户在同一进程内定义并运行自定义工具。
 *
 * 【函数作用】
 * 将用户提供的工具列表打包为 McpSdkServerConfigWithInstance，
 * CLI 运行时在建立 SDK 传输时会从该配置中启动内置 MCP 服务器。
 *
 * 注意：如果 SDK MCP 调用耗时超过 60 秒，请通过环境变量
 * CLAUDE_CODE_STREAM_CLOSE_TIMEOUT 覆盖默认超时时长。
 *
 * @param _options 服务器配置，包含 name、version 和工具列表
 */
export function createSdkMcpServer(
  _options: CreateSdkMcpServerOptions,
): McpSdkServerConfigWithInstance {
  throw new Error('not implemented')
}

export class AbortError extends Error {}

// AbortError：用于标识被主动中断（abort）的操作，与普通 Error 区分，便于调用方捕获处理
export class AbortError extends Error {}

/**
 * 向 Claude Code 发起一次 AI 查询（内部重载，供 CLI 内部模块使用）。
 * @internal
 */
export function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: InternalOptions
}): InternalQuery
/**
 * 向 Claude Code 发起一次 AI 查询（公开重载，供 SDK 消费者使用）。
 *
 * 【函数作用】
 * query 是 SDK 的核心入口函数，接受字符串或异步可迭代消息流作为 prompt，
 * 返回一个可异步迭代的 Query 对象，消费者通过 for await 遍历 AI 响应消息。
 * 本存根由 CLI 运行时在进程启动时替换为真实实现。
 *
 * @param _params.prompt   用户提示字符串或异步消息流
 * @param _params.options  可选的会话选项（模型、权限、工具列表等）
 */
export function query(_params: {
  prompt: string | AsyncIterable<SDKUserMessage>
  options?: Options
}): Query
export function query(): Query {
  // 存根：真实实现由 CLI 运行时注入，此处永远不会被执行
  throw new Error('query is not implemented in the SDK')
}

/**
 * V2 API（不稳定）- 创建一个持久化会话，用于多轮对话。
 *
 * 【函数作用】
 * 返回一个 SDKSession 对象，调用方可在该会话上持续发起多轮对话，
 * 会话状态（对话历史、文件快照等）在会话生命周期内保持。
 * 区别于 query()：query 每次调用均为独立请求，不共享上下文。
 *
 * @alpha 不稳定 API，后续版本可能发生破坏性变更
 * @param _options 会话初始化选项（模型、工具、权限等）
 */
export function unstable_v2_createSession(
  _options: SDKSessionOptions,
): SDKSession {
  throw new Error('unstable_v2_createSession is not implemented in the SDK')
}

/**
 * V2 API（不稳定）- 通过会话 ID 恢复已有会话。
 *
 * 【函数作用】
 * 根据给定的 sessionId 加载已有的会话状态并返回 SDKSession 对象，
 * 允许调用方在进程重启后续接上一次对话上下文继续交互。
 *
 * @alpha 不稳定 API
 * @param _sessionId 要恢复的会话 UUID
 * @param _options   会话选项（可覆盖原会话的模型、工具等配置）
 */
export function unstable_v2_resumeSession(
  _sessionId: string,
  _options: SDKSessionOptions,
): SDKSession {
  throw new Error('unstable_v2_resumeSession is not implemented in the SDK')
}

// @[MODEL LAUNCH]: Update the example model ID in this docstring.
/**
 * V2 API（不稳定）- 单次提示便捷函数，适合一次性查询场景。
 *
 * 【函数作用】
 * 内部自动创建临时会话、发送消息、等待完整响应后销毁会话，
 * 将整个流程封装为单个 async 调用，无需调用方管理会话生命周期。
 * 适用于不需要多轮对话的简单场景。
 *
 * @alpha 不稳定 API
 *
 * @example
 * ```typescript
 * const result = await unstable_v2_prompt("What files are here?", {
 *   model: 'claude-sonnet-4-6'
 * })
 * ```
 *
 * @param _message  用户输入的提示字符串
 * @param _options  会话选项（模型选择、工具配置等）
 * @returns         包含完整 AI 响应内容的 SDKResultMessage
 */
export async function unstable_v2_prompt(
  _message: string,
  _options: SDKSessionOptions,
): Promise<SDKResultMessage> {
  throw new Error('unstable_v2_prompt is not implemented in the SDK')
}

/**
 * 从会话的 JSONL 转录文件中读取对话消息列表。
 *
 * 【函数作用】
 * 解析指定会话的 .jsonl 转录文件，通过 parentUuid 链接字段重建对话顺序，
 * 按时间先后顺序返回用户消息和助手消息。
 * 若设置 includeSystemMessages: true，则同时包含系统消息。
 *
 * 典型用途：用于 UI 展示历史对话、断点续传时恢复上下文、审计日志分析等。
 *
 * @param _sessionId  目标会话的 UUID
 * @param _options    可选参数：dir（项目目录）、limit、offset（分页）、includeSystemMessages
 * @returns           按时间顺序排列的消息数组，若会话不存在则返回空数组
 */
export async function getSessionMessages(
  _sessionId: string,
  _options?: GetSessionMessagesOptions,
): Promise<SessionMessage[]> {
  throw new Error('getSessionMessages is not implemented in the SDK')
}

/**
 * 列举满足条件的会话及其元数据。
 *
 * 【函数作用】
 * 扫描会话存储目录，读取每个会话的摘要元数据（标题、标签、最后活跃时间等），
 * 返回 SDKSessionInfo 数组。
 *
 * - 提供 dir 时：仅返回该项目目录及其 git worktree 下的会话
 * - 省略 dir 时：跨所有已知项目目录返回全部会话
 * - 通过 limit / offset 实现分页，避免一次加载海量会话
 *
 * @example
 * ```typescript
 * // 列举特定项目的所有会话
 * const sessions = await listSessions({ dir: '/path/to/project' })
 *
 * // 分页加载
 * const page1 = await listSessions({ limit: 50 })
 * const page2 = await listSessions({ limit: 50, offset: 50 })
 * ```
 *
 * @param _options  可选：dir（项目路径）、limit、offset（分页控制）
 * @returns         会话元数据数组
 */
export async function listSessions(
  _options?: ListSessionsOptions,
): Promise<SDKSessionInfo[]> {
  throw new Error('listSessions is not implemented in the SDK')
}

/**
 * 按会话 ID 读取单个会话的元数据。
 *
 * 【函数作用】
 * 与 listSessions 不同，本函数只读取单个会话文件，性能开销更低。
 * 若该会话文件不存在、为 sidechain 会话，或无法提取摘要信息，则返回 undefined。
 *
 * @param _sessionId  目标会话的 UUID
 * @param _options    可选：dir（项目路径）；省略时在所有项目目录中搜索
 * @returns           会话元数据，或 undefined（未找到时）
 */
export async function getSessionInfo(
  _sessionId: string,
  _options?: GetSessionInfoOptions,
): Promise<SDKSessionInfo | undefined> {
  throw new Error('getSessionInfo is not implemented in the SDK')
}

/**
 * 重命名指定会话。
 *
 * 【函数作用】
 * 向目标会话的 JSONL 文件追加一条 custom-title 条目，更新显示标题。
 * 不修改已有消息记录，仅追加元数据变更记录。
 *
 * @param _sessionId  目标会话的 UUID
 * @param _title      新的会话标题字符串
 * @param _options    可选：dir（项目路径）；省略时在所有项目中搜索
 */
export async function renameSession(
  _sessionId: string,
  _title: string,
  _options?: SessionMutationOptions,
): Promise<void> {
  throw new Error('renameSession is not implemented in the SDK')
}

/**
 * 为指定会话打标签。传入 null 可清除现有标签。
 *
 * 【函数作用】
 * 向目标会话的 JSONL 文件追加标签元数据条目，用于会话分类和筛选。
 * 传入 null 时清除已有标签。
 *
 * @param _sessionId  目标会话的 UUID
 * @param _tag        标签字符串，或 null（清除标签）
 * @param _options    可选：dir（项目路径）；省略时在所有项目中搜索
 */
export async function tagSession(
  _sessionId: string,
  _tag: string | null,
  _options?: SessionMutationOptions,
): Promise<void> {
  throw new Error('tagSession is not implemented in the SDK')
}

/**
 * 将指定会话 fork 为一个新的对话分支，所有消息获得全新的 UUID。
 *
 * 【函数作用】
 * 从源会话的 JSONL 转录文件中复制消息到新会话文件，
 * 重新映射每条消息的 UUID，并保持 parentUuid 链完整，
 * 从而实现"分支对话"功能（类似 git 的 branch/checkout）。
 *
 * - 支持通过 upToMessageId 从对话中间某处开始 fork
 * - Fork 后的新会话不含文件编辑撤销历史（快照不会被复制）
 * - 常用于 A/B 测试不同提示词路径、保存对话检查点等场景
 *
 * @param _sessionId  源会话的 UUID
 * @param _options    可选：dir（项目路径）、upToMessageId（fork 截止消息 ID）、title（新会话标题）
 * @returns           包含新会话 UUID 的结果对象 `{ sessionId }`
 */
export async function forkSession(
  _sessionId: string,
  _options?: ForkSessionOptions,
): Promise<ForkSessionResult> {
  throw new Error('forkSession is not implemented in the SDK')
}

// ============================================================================
// Assistant daemon primitives（助手守护进程原语，仅内部使用）
// ============================================================================

/**
 * 来自 `<dir>/.claude/scheduled_tasks.json` 的计划任务定义。
 *
 * 【类型作用】
 * 描述一条定时任务的完整配置，包含触发时间（cron 表达式）、
 * 要执行的 AI 提示词、任务 ID 及创建时间。
 * 守护进程通过 watchScheduledTasks 读取并调度这些任务。
 *
 * @internal
 */
export type CronTask = {
  id: string         // 任务唯一标识符
  cron: string       // cron 表达式，定义触发时间规律（如 "0 9 * * 1-5"）
  prompt: string     // 任务触发时传递给 AI 的提示词
  createdAt: number  // 任务创建的 Unix 毫秒时间戳
  recurring?: boolean // 是否为周期性任务（false/undefined 表示一次性任务）
}

/**
 * Cron 调度器抖动（jitter）与过期控制参数。
 *
 * 【类型作用】
 * 防止多个守护进程在同一时刻同时触发任务（thundering herd 问题），
 * 通过随机抖动将实际触发时间分散在窗口内。
 * 运行时从 GrowthBook 配置 `tengu_kairos_cron_config` 获取这些参数。
 * 守护进程通过 watchScheduledTasks({ getJitterConfig }) 注入此配置。
 *
 * @internal
 */
export type CronJitterConfig = {
  recurringFrac: number      // 周期任务抖动系数（占周期时长的比例）
  recurringCapMs: number     // 周期任务抖动上限（毫秒）
  oneShotMaxMs: number       // 一次性任务最大延迟（毫秒）
  oneShotFloorMs: number     // 一次性任务最小延迟（毫秒）
  oneShotMinuteMod: number   // 一次性任务分钟对齐模数
  recurringMaxAgeMs: number  // 周期任务最大过期时长（超过则删除，毫秒）
}

/**
 * watchScheduledTasks() 产出的事件类型。
 *
 * - fire：一条任务的 cron 调度时间到达，守护进程应立即执行
 * - missed：守护进程下线期间错过的一次性任务，需提示用户确认后补执行
 *
 * @internal
 */
export type ScheduledTaskEvent =
  | { type: 'fire'; task: CronTask }      // 正常触发事件
  | { type: 'missed'; tasks: CronTask[] } // 错过的任务批量事件

/**
 * watchScheduledTasks() 返回的句柄接口。
 *
 * 【类型作用】
 * 提供对调度器的控制接口：通过 events() 异步迭代获取触发事件，
 * 通过 getNextFireTime() 判断是否需要保持守护进程活跃（避免不必要的进程启动）。
 *
 * @internal
 */
export type ScheduledTasksHandle = {
  /** 异步事件流，产出 fire/missed 事件，使用 for await 消费 */
  events(): AsyncGenerator<ScheduledTaskEvent>
  /**
   * 返回所有已加载任务中最早的下次触发时间（Unix 毫秒），
   * 若无任何计划任务则返回 null。
   * 守护进程可据此决定是否提前保持子进程热启动（warm），
   * 以减少临近触发时的冷启动延迟。
   */
  getNextFireTime(): number | null
}

/**
 * 监听 `<dir>/.claude/scheduled_tasks.json` 并在任务触发时产出事件。
 *
 * 【函数作用】
 * 这是守护进程架构的调度核心：
 * 1. 获取该目录的调度器排他锁（基于 PID 存活检测），确保同目录下的 REPL 会话
 *    与守护进程不会重复触发同一任务
 * 2. 监听文件变化（chokidar/fs.watch），实时响应任务文件的增删改
 * 3. 通过 AbortSignal 信号释放锁并关闭文件监听器
 *
 * 事件语义：
 * - `fire`：任务的 cron 触发时间到达。一次性任务在此事件产出前已从文件中删除；
 *           周期性任务会被重新调度（若超过 maxAge 则删除）
 * - `missed`：守护进程离线期间错过的一次性任务，仅在初始加载时产出一次；
 *             后台将在短暂延迟后从文件中删除这些过期任务
 *
 * 适用于外部守护进程架构（守护进程管理调度，通过 query() 创建 Agent 子进程）；
 * Agent 子进程（-p 模式）不运行自有调度器。
 *
 * @internal
 *
 * @param _opts.dir             监听的项目目录路径
 * @param _opts.signal          用于停止监听并释放资源的 AbortSignal
 * @param _opts.getJitterConfig 可选：动态获取抖动配置的函数
 */
export function watchScheduledTasks(_opts: {
  dir: string
  signal: AbortSignal
  getJitterConfig?: () => CronJitterConfig
}): ScheduledTasksHandle {
  throw new Error('not implemented')
}

/**
 * 将错过的一次性任务格式化为提示词，要求模型在执行前先通过 AskUserQuestion 工具确认用户意图。
 *
 * 【函数作用】
 * 当守护进程检测到 missed 事件时，调用此函数生成结构化的用户确认提示，
 * 防止守护进程重启后自动执行用户可能已不再需要的任务。
 *
 * @internal
 * @param _missed  错过的任务列表
 * @returns        格式化后的提示词字符串
 */
export function buildMissedTaskNotification(_missed: CronTask[]): string {
  throw new Error('not implemented')
}

/**
 * 从 claude.ai bridge WebSocket 接收到的用户输入消息。
 *
 * 【类型作用】
 * 描述从 claude.ai 前端通过 WebSocket 桥接传递到 CLI 守护进程的一条用户消息。
 * content 可以是纯文本字符串，也可以是包含附件（图片、文件等）的内容块数组。
 *
 * @internal
 */
export type InboundPrompt = {
  content: string | unknown[] // 用户消息内容：纯文本或多模态内容块数组
  uuid?: string               // 消息的可选唯一标识符，用于去重和取消
}

/**
 * connectRemoteControl 函数的入参选项。
 *
 * 【类型作用】
 * 封装建立 claude.ai 远程控制桥接连接所需的全部参数，
 * 包括工作目录、身份标识、OAuth 令牌提供函数及 claude.ai 服务地址等。
 *
 * @internal
 */
export type ConnectRemoteControlOptions = {
  dir: string                            // Agent 工作目录
  name?: string                          // 可选：会话显示名称
  workerType?: string                    // 可选：Worker 类型标识
  branch?: string                        // 可选：当前 git 分支名
  gitRepoUrl?: string | null             // 可选：git 仓库 URL
  getAccessToken: () => string | undefined // 获取 OAuth 访问令牌的函数（惰性求值）
  baseUrl: string                        // claude.ai API 基础 URL
  orgUUID: string                        // 组织 UUID
  model: string                          // 使用的模型名称
}

/**
 * connectRemoteControl() 返回的远程控制桥接句柄。
 *
 * 【类型作用】
 * 提供对 claude.ai 桥接 WebSocket 连接的完整操作接口：
 * - 写入 Agent 输出（write / sendResult）
 * - 发送/响应控制消息（sendControlRequest / sendControlResponse）
 * - 读取用户的入站提示（inboundPrompts）
 * - 处理权限请求响应（permissionResponses）
 * - 监听连接状态变化（onStateChange）
 * - 优雅关闭连接（teardown）
 *
 * 完整字段文档参见 src/assistant/daemonBridge.ts。
 *
 * @internal
 */
export type RemoteControlHandle = {
  sessionUrl: string                                    // 此次会话在 claude.ai 上的 URL
  environmentId: string                                 // 远端环境唯一 ID
  bridgeSessionId: string                               // 桥接会话 ID
  write(msg: SDKMessage): void                          // 向 claude.ai 推送 Agent 产出的消息
  sendResult(): void                                    // 通知 claude.ai 当前轮次 Agent 执行完毕
  sendControlRequest(req: unknown): void                // 向 claude.ai 发送控制请求
  sendControlResponse(res: unknown): void               // 响应来自 claude.ai 的控制请求
  sendControlCancelRequest(requestId: string): void     // 取消一个正在等待响应的控制请求
  inboundPrompts(): AsyncGenerator<InboundPrompt>       // 异步迭代来自 claude.ai 的用户输入
  controlRequests(): AsyncGenerator<unknown>            // 异步迭代来自 claude.ai 的控制指令
  permissionResponses(): AsyncGenerator<unknown>        // 异步迭代权限请求的用户响应
  onStateChange(
    cb: (
      state: 'ready' | 'connected' | 'reconnecting' | 'failed', // 连接状态枚举
      detail?: string,                                           // 可选的状态详情（错误信息等）
    ) => void,
  ): void
  teardown(): Promise<void>                             // 优雅关闭 WebSocket 连接，释放所有资源
}

/**
 * 从守护进程持有 claude.ai 远程控制桥接的 WebSocket 连接。
 *
 * 【函数作用】
 * 守护进程（PARENT 进程）持有 WebSocket 连接，而非 Agent 子进程。
 * 这样当 Agent 子进程崩溃时，守护进程可以重新启动子进程，
 * 而 claude.ai 前端仍维持同一会话（不断连），对用户透明。
 *
 * 对比 `query.enableRemoteControl`：
 * - enableRemoteControl：WebSocket 在子进程内（随 Agent 崩溃而断开）
 * - connectRemoteControl：WebSocket 在守护进程内（Agent 崩溃后可复活）
 *
 * 使用模式：
 * - 将 query() 产出的消息通过 write() + sendResult() 推送给 claude.ai
 * - 通过 inboundPrompts() 读取用户在 claude.ai 输入的新消息，传入 query() 的输入流
 * - 通过 controlRequests() 在本地处理控制指令（如 interrupt → abort、set_model → 重配置）
 *
 * 权限说明：
 * - 跳过 tengu_ccr_bridge 功能门控和策略限制检查（内部调用方已预先授权）
 * - OAuth 认证仍然必需（通过环境变量或系统 keychain 提供）
 *
 * @internal
 * @param _opts  桥接连接选项
 * @returns      桥接句柄，或 null（无 OAuth 凭证或注册失败时）
 */
export async function connectRemoteControl(
  _opts: ConnectRemoteControlOptions,
): Promise<RemoteControlHandle | null> {
  throw new Error('not implemented')
}
