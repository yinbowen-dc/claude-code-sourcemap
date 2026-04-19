/**
 * 结构化 IO 层 — SDK 模式下 stdio 的 NDJSON 读写与权限协议实现。
 *
 * 在整个 Claude Code 系统中的位置：
 * 本文件定义 StructuredIO 类，是 CLI 层所有 IO 实现的基类。
 * 它以异步生成器（AsyncGenerator）的形式将 stdin 中的 NDJSON 行解析为
 * StdinMessage / SDKMessage，并提供向 stdout 写出 StdoutMessage 的 write() 方法。
 * 同时实现了 SDK 控制协议的核心机制：
 *
 *   - control_request / control_response：工具权限弹窗的请求-响应配对
 *   - can_use_tool：工具使用权限检查，SDK Host（VS Code、CCR 等）响应
 *   - hook_callback：PermissionRequest hook 的回调协议
 *   - elicitation：MCP elicitation 协议
 *   - mcp_message：MCP JSON-RPC 消息转发
 *   - sandbox_network_access：沙盒网络权限请求（通过 can_use_tool 协议复用）
 *
 * 继承关系：
 *   StructuredIO（本类）← RemoteIO（SDK 远程模式，通过网络传输代替 stdio）
 *
 * 关键设计决策：
 *   - outbound Stream 队列：control_request 和 stream_event 共用同一个出队列，
 *     防止 control_request 超越 stream_event 乱序到达 SDK Host。
 *   - resolvedToolUseIds：防止 WebSocket 重连导致重复 control_response
 *     被再次处理，从而引发 API 400 "tool_use ids must be unique" 错误。
 *   - Hook 与 SDK 权限弹窗的赛跑（race）：两者并行启动，先到先得；
 *     另一方被取消（AbortSignal）。
 */
import { feature } from 'bun:bundle'
import type {
  ElicitResult,
  JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'crypto'
import type { AssistantMessage } from 'src//types/message.js'
import type {
  HookInput,
  HookJSONOutput,
  PermissionUpdate,
  SDKMessage,
  SDKUserMessage,
} from 'src/entrypoints/agentSdkTypes.js'
import { SDKControlElicitationResponseSchema } from 'src/entrypoints/sdk/controlSchemas.js'
import type {
  SDKControlRequest,
  SDKControlResponse,
  StdinMessage,
  StdoutMessage,
} from 'src/entrypoints/sdk/controlTypes.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from 'src/Tool.js'
import { type HookCallback, hookJSONOutputSchema } from 'src/types/hooks.js'
import { logForDebugging } from 'src/utils/debug.js'
import { logForDiagnosticsNoPII } from 'src/utils/diagLogs.js'
import { AbortError } from 'src/utils/errors.js'
import {
  type Output as PermissionToolOutput,
  permissionPromptToolResultToPermissionDecision,
  outputSchema as permissionToolOutputSchema,
} from 'src/utils/permissions/PermissionPromptToolResultSchema.js'
import type {
  PermissionDecision,
  PermissionDecisionReason,
} from 'src/utils/permissions/PermissionResult.js'
import { hasPermissionsToUseTool } from 'src/utils/permissions/permissions.js'
import { writeToStdout } from 'src/utils/process.js'
import { jsonStringify } from 'src/utils/slowOperations.js'
import { z } from 'zod/v4'
import { notifyCommandLifecycle } from '../utils/commandLifecycle.js'
import { normalizeControlMessageKeys } from '../utils/controlMessageCompat.js'
import { executePermissionRequestHooks } from '../utils/hooks.js'
import {
  applyPermissionUpdates,
  persistPermissionUpdates,
} from '../utils/permissions/PermissionUpdate.js'
import {
  notifySessionStateChanged,
  type RequiresActionDetails,
  type SessionExternalMetadata,
} from '../utils/sessionState.js'
import { jsonParse } from '../utils/slowOperations.js'
import { Stream } from '../utils/stream.js'
import { ndjsonSafeStringify } from './ndjsonSafeStringify.js'

/**
 * 沙盒网络权限请求的合成工具名称。
 * 通过复用 can_use_tool 控制协议向 SDK Host 发起沙盒网络访问权限弹窗，
 * SDK Host（如 VS Code、CCR）将其视为普通的工具权限询问。
 */
export const SANDBOX_NETWORK_ACCESS_TOOL_NAME = 'SandboxNetworkAccess'

/**
 * 将权限决策原因序列化为可传输的字符串。
 *
 * 部分原因类型（rule/mode/subcommandResults/permissionPromptTool）无需透出文本说明，
 * 返回 undefined；其余类型（hook/asyncAgent/sandboxOverride/workingDir/safetyCheck/other）
 * 携带具体的 reason 字段；分类器（classifier）只在对应 feature flag 开启时才序列化。
 */
function serializeDecisionReason(
  reason: PermissionDecisionReason | undefined,
): string | undefined {
  if (!reason) {
    return undefined
  }

  if (
    (feature('BASH_CLASSIFIER') || feature('TRANSCRIPT_CLASSIFIER')) &&
    reason.type === 'classifier'
  ) {
    return reason.reason
  }
  switch (reason.type) {
    case 'rule':
    case 'mode':
    case 'subcommandResults':
    case 'permissionPromptTool':
      return undefined
    case 'hook':
    case 'asyncAgent':
    case 'sandboxOverride':
    case 'workingDir':
    case 'safetyCheck':
    case 'other':
      return reason.reason
  }
}

/**
 * 构建权限弹窗所需的 RequiresActionDetails 对象。
 *
 * 依次尝试 getActivityDescription → getToolUseSummary → userFacingName 获取可读描述；
 * 若工具的描述方法因格式错误的 input 抛出异常，则回退到工具名，避免权限流程中断。
 */
function buildRequiresActionDetails(
  tool: Tool,
  input: Record<string, unknown>,
  toolUseID: string,
  requestId: string,
): RequiresActionDetails {
  // 各工具的摘要方法可能因格式错误的 input 而抛出；权限处理不应因此中断
  let description: string
  try {
    description =
      tool.getActivityDescription?.(input) ??
      tool.getToolUseSummary?.(input) ??
      tool.userFacingName(input)
  } catch {
    description = tool.name
  }
  return {
    tool_name: tool.name,
    action_description: description,
    tool_use_id: toolUseID,
    request_id: requestId,
    input,
  }
}

/** 单条待处理权限请求的内部结构，存储 resolve/reject 和可选的响应校验 schema */
type PendingRequest<T> = {
  resolve: (result: T) => void
  reject: (error: unknown) => void
  schema?: z.Schema
  request: SDKControlRequest
}

/**
 * 提供结构化 SDK 消息读写方式的核心 IO 类，封装 SDK 控制协议。
 */
// 已解决 tool_use ID 的最大跟踪数量。超过后逐出最旧的条目，
// 以在极长会话中限制内存，同时保留足够历史记录来拦截重复投递。
const MAX_RESOLVED_TOOL_USE_IDS = 1000

export class StructuredIO {
  readonly structuredInput: AsyncGenerator<StdinMessage | SDKMessage>
  private readonly pendingRequests = new Map<string, PendingRequest<unknown>>()

  // Worker 启动时从 CCR external_metadata 恢复的会话状态；
  // 当传输层不支持恢复时为 null。由 RemoteIO 赋值。
  restoredWorkerState: Promise<SessionExternalMetadata | null> =
    Promise.resolve(null)

  private inputClosed = false
  private unexpectedResponseCallback?: (
    response: SDKControlResponse,
  ) => Promise<void>

  // 记录已通过正常权限流程（或被 hook 中止）的 tool_use ID。
  // 当 WebSocket 重连后重复投递的 control_response 到来时，
  // 此 Set 阻止孤儿处理器再次处理——重复处理会把重复的 assistant 消息
  // 推入 mutableMessages，从而导致 API 400 "tool_use ids must be unique" 错误。
  private readonly resolvedToolUseIds = new Set<string>()
  private prependedLines: string[] = []
  private onControlRequestSent?: (request: SDKControlRequest) => void
  private onControlRequestResolved?: (requestId: string) => void

  // sendRequest() 和 print.ts 均向此队列入队；drain 循环是唯一的写出方。
  // 防止 control_request 超越排队中的 stream_event 乱序到达。
  readonly outbound = new Stream<StdoutMessage>()

  constructor(
    private readonly input: AsyncIterable<string>,
    private readonly replayUserMessages?: boolean,
  ) {
    this.input = input
    this.structuredInput = this.read()
  }

  /**
   * 将 tool_use ID 记录为已解决，使后续到来的重复 control_response
   * 被孤儿处理器忽略。仅对 can_use_tool 类型的请求生效。
   * 当超出最大跟踪数量时，按插入顺序逐出最旧的条目。
   */
  private trackResolvedToolUseId(request: SDKControlRequest): void {
    if (request.request.subtype === 'can_use_tool') {
      this.resolvedToolUseIds.add(request.request.tool_use_id)
      if (this.resolvedToolUseIds.size > MAX_RESOLVED_TOOL_USE_IDS) {
        // 按插入顺序逐出最旧的条目（Set 按插入顺序迭代）
        const first = this.resolvedToolUseIds.values().next().value
        if (first !== undefined) {
          this.resolvedToolUseIds.delete(first)
        }
      }
    }
  }

  /** 刷新待处理的内部事件（transcript 等）。非远程 IO 时为空操作，由 RemoteIO 覆盖。 */
  flushInternalEvents(): Promise<void> {
    return Promise.resolve()
  }

  /** 内部事件队列深度。由 RemoteIO 覆盖；其他情况始终为 0。 */
  get internalEventsPending(): number {
    return 0
  }

  /**
   * 将一条用户消息插入队列，在下一条来自 this.input 的消息之前被 yield。
   * 在迭代开始前和流处理过程中均可调用——read() 在每次 yield 前都会检查 prependedLines。
   */
  prependUserMessage(content: string): void {
    this.prependedLines.push(
      jsonStringify({
        type: 'user',
        session_id: '',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      } satisfies SDKUserMessage) + '\n',
    )
  }

  /**
   * 核心读取循环（异步生成器）：将 input 的字节流解析为结构化消息逐条 yield。
   *
   * 流程：
   * - splitAndProcess 内循环：每次从 content 缓冲区提取一行（以 \n 分隔）交给 processLine；
   *   每次提取前先合并 prependedLines，保证插队消息始终优先出现。
   * - 先对空 input 执行一次 splitAndProcess()（处理 prependedLines 中已有的预置消息），
   *   再通过 for-await 消费流式输入块。
   * - 流结束后处理末尾无换行的残余内容。
   * - 流关闭后（inputClosed=true）reject 所有未响应的权限请求。
   */
  private async *read() {
    let content = ''

    // 在 for-await 开始前执行一次（空 input 否则会跳过循环体），
    // 之后每个输入块也调用一次。prependedLines 检查在 while 内，
    // 因此同一输入块内两条消息之间推入的预置消息仍能正确排序。
    const splitAndProcess = async function* (this: StructuredIO) {
      for (;;) {
        // 每次提取行前先合并预置消息（保证插队优先级）
        if (this.prependedLines.length > 0) {
          content = this.prependedLines.join('') + content
          this.prependedLines = []
        }
        const newline = content.indexOf('\n')
        if (newline === -1) break
        const line = content.slice(0, newline)
        content = content.slice(newline + 1)
        const message = await this.processLine(line)
        if (message) {
          logForDiagnosticsNoPII('info', 'cli_stdin_message_parsed', {
            type: message.type,
          })
          yield message
        }
      }
    }.bind(this)

    yield* splitAndProcess()

    for await (const block of this.input) {
      content += block
      yield* splitAndProcess()
    }
    // 处理末尾没有换行符的残余内容
    if (content) {
      const message = await this.processLine(content)
      if (message) {
        yield message
      }
    }
    this.inputClosed = true
    // 流关闭后 reject 所有未响应的权限请求
    for (const request of this.pendingRequests.values()) {
      // Reject all pending requests if the input stream
      request.reject(
        new Error('Tool permission stream closed before response received'),
      )
    }
  }

  /** 返回所有当前待响应的 can_use_tool 权限请求列表（供 bridge 查询）。 */
  getPendingPermissionRequests() {
    return Array.from(this.pendingRequests.values())
      .map(entry => entry.request)
      .filter(pr => pr.request.subtype === 'can_use_tool')
  }

  /** 注册孤儿 control_response 的处理回调（即无法匹配到 pendingRequests 的响应）。 */
  setUnexpectedResponseCallback(
    callback: (response: SDKControlResponse) => Promise<void>,
  ): void {
    this.unexpectedResponseCallback = callback
  }

  /**
   * 注入一条 control_response，直接解决对应的 pending 权限请求。
   * 用于 bridge 模式：将来自 claude.ai 的权限响应注入 SDK 权限流程。
   *
   * 同时向 SDK 消费方发送 control_cancel_request，中止其 canUseTool 回调
   * 的等待——否则该回调会一直挂起。
   */
  injectControlResponse(response: SDKControlResponse): void {
    const requestId = response.response?.request_id
    if (!requestId) return
    const request = this.pendingRequests.get(requestId)
    if (!request) return
    this.trackResolvedToolUseId(request.request)
    this.pendingRequests.delete(requestId)
    // 取消 SDK 消费方的 canUseTool 回调——bridge 已率先决策
    void this.write({
      type: 'control_cancel_request',
      request_id: requestId,
    })
    if (response.response.subtype === 'error') {
      request.reject(new Error(response.response.error))
    } else {
      const result = response.response.response
      if (request.schema) {
        try {
          request.resolve(request.schema.parse(result))
        } catch (error) {
          request.reject(error)
        }
      } else {
        request.resolve({})
      }
    }
  }

  /**
   * 注册回调：每次 can_use_tool control_request 写出到 stdout 后调用。
   * 供 bridge 将权限请求转发给 claude.ai。
   */
  setOnControlRequestSent(
    callback: ((request: SDKControlRequest) => void) | undefined,
  ): void {
    this.onControlRequestSent = callback
  }

  /**
   * 注册回调：当 SDK 消费方通过 stdin 发回 can_use_tool control_response 时调用。
   * 供 bridge 取消 claude.ai 上已过时的权限弹窗（SDK 消费方赢得了赛跑）。
   */
  setOnControlRequestResolved(
    callback: ((requestId: string) => void) | undefined,
  ): void {
    this.onControlRequestResolved = callback
  }

  /**
   * 将单行 NDJSON 解析为结构化消息。
   *
   * 处理逻辑：
   * - 跳过空行（管道 stdin 的双换行）。
   * - keep_alive：静默丢弃。
   * - update_environment_variables：直接写入 process.env，用于 bridge session runner
   *   刷新 auth token（CLAUDE_CODE_SESSION_ACCESS_TOKEN），不 yield。
   * - control_response：
   *     1. 通知命令生命周期（completed）。
   *     2. 查找对应 pendingRequest；若不存在，检查 resolvedToolUseIds 以拦截重复投递；
   *        否则调用 unexpectedResponseCallback。
   *     3. 若找到，解决 Promise 并在 replayUserMessages 模式下 yield 消息。
   * - 其他未知类型：丢弃并 warn 日志。
   * - control_request / assistant / system / user：直接 yield。
   * - 解析失败：打印错误并以退出码 1 终止进程。
   */
  private async processLine(
    line: string,
  ): Promise<StdinMessage | SDKMessage | undefined> {
    // 跳过空行（如管道 stdin 的双换行符）
    if (!line) {
      return undefined
    }
    try {
      const message = normalizeControlMessageKeys(jsonParse(line)) as
        | StdinMessage
        | SDKMessage
      if (message.type === 'keep_alive') {
        // 静默忽略 keep-alive 消息
        return undefined
      }
      if (message.type === 'update_environment_variables') {
        // 直接应用环境变量更新到 process.env。
        // 用于 bridge session runner 的 auth token 刷新
        // （CLAUDE_CODE_SESSION_ACCESS_TOKEN），需要在 REPL 进程自身可读，
        // 而不仅仅是子 Bash 命令。
        const keys = Object.keys(message.variables)
        for (const [key, value] of Object.entries(message.variables)) {
          process.env[key] = value
        }
        logForDebugging(
          `[structuredIO] applied update_environment_variables: ${keys.join(', ')}`,
        )
        return undefined
      }
      if (message.type === 'control_response') {
        // 对所有 control_response（包括重复和孤儿）都关闭命令生命周期，
        // 因为孤儿不会经过 print.ts 的主循环，此处是唯一能感知到它们的地方。
        // uuid 由服务端注入到 payload 中。
        const uuid =
          'uuid' in message && typeof message.uuid === 'string'
            ? message.uuid
            : undefined
        if (uuid) {
          notifyCommandLifecycle(uuid, 'completed')
        }
        const request = this.pendingRequests.get(message.response.request_id)
        if (!request) {
          // 检查该 tool_use 是否已通过正常权限流程解决。
          // WebSocket 重连后重复投递的 control_response 会在原始处理完成后到来，
          // 若重新处理则会将重复的 assistant 消息推入对话，引发 API 400 错误。
          const responsePayload =
            message.response.subtype === 'success'
              ? message.response.response
              : undefined
          const toolUseID = responsePayload?.toolUseID
          if (
            typeof toolUseID === 'string' &&
            this.resolvedToolUseIds.has(toolUseID)
          ) {
            logForDebugging(
              `Ignoring duplicate control_response for already-resolved toolUseID=${toolUseID} request_id=${message.response.request_id}`,
            )
            return undefined
          }
          if (this.unexpectedResponseCallback) {
            await this.unexpectedResponseCallback(message)
          }
          return undefined // 忽略未知请求 ID 的响应
        }
        this.trackResolvedToolUseId(request.request)
        this.pendingRequests.delete(message.response.request_id)
        // 当 SDK 消费方解决了 can_use_tool 请求时，通知 bridge 取消 claude.ai 上的过时弹窗
        if (
          request.request.request.subtype === 'can_use_tool' &&
          this.onControlRequestResolved
        ) {
          this.onControlRequestResolved(message.response.request_id)
        }

        if (message.response.subtype === 'error') {
          request.reject(new Error(message.response.error))
          return undefined
        }
        const result = message.response.response
        if (request.schema) {
          try {
            request.resolve(request.schema.parse(result))
          } catch (error) {
            request.reject(error)
          }
        } else {
          request.resolve({})
        }
        // replayUserMessages 模式下将 control_response 也 yield 出去
        if (this.replayUserMessages) {
          return message
        }
        return undefined
      }
      if (
        message.type !== 'user' &&
        message.type !== 'control_request' &&
        message.type !== 'assistant' &&
        message.type !== 'system'
      ) {
        logForDebugging(`Ignoring unknown message type: ${message.type}`, {
          level: 'warn',
        })
        return undefined
      }
      if (message.type === 'control_request') {
        if (!message.request) {
          exitWithMessage(`Error: Missing request on control_request`)
        }
        return message
      }
      if (message.type === 'assistant' || message.type === 'system') {
        return message
      }
      if (message.message.role !== 'user') {
        exitWithMessage(
          `Error: Expected message role 'user', got '${message.message.role}'`,
        )
      }
      return message
    } catch (error) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`Error parsing streaming input line: ${line}: ${error}`)
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
  }

  /** 将消息序列化为 NDJSON 写出到 stdout。由子类（RemoteIO）覆盖以走网络传输。 */
  async write(message: StdoutMessage): Promise<void> {
    writeToStdout(ndjsonSafeStringify(message) + '\n')
  }

  /**
   * 向 SDK Host 发送 control_request 并等待对应的 control_response。
   *
   * 流程：
   * 1. 检查 inputClosed / signal.aborted 后入队 outbound（防止超越 stream_event）。
   * 2. 为 can_use_tool 类型通知 onControlRequestSent（bridge 转发权限请求）。
   * 3. 若提供了 signal，在 abort 事件时立即发送 cancel_request 并 reject。
   * 4. 注册 pendingRequest，等待 processLine() 中的 resolve/reject 调用。
   * 5. 无论成功与否，finally 中清理 pendingRequests 条目和 signal 监听器。
   */
  private async sendRequest<Response>(
    request: SDKControlRequest['request'],
    schema: z.Schema,
    signal?: AbortSignal,
    requestId: string = randomUUID(),
  ): Promise<Response> {
    const message: SDKControlRequest = {
      type: 'control_request',
      request_id: requestId,
      request,
    }
    if (this.inputClosed) {
      throw new Error('Stream closed')
    }
    if (signal?.aborted) {
      throw new Error('Request aborted')
    }
    // 入队 outbound，由 drain 循环串行写出（防止超越 stream_event 乱序）
    this.outbound.enqueue(message)
    if (request.subtype === 'can_use_tool' && this.onControlRequestSent) {
      this.onControlRequestSent(message)
    }
    const aborted = () => {
      // 发送取消通知，让 SDK Host 中止对应弹窗
      this.outbound.enqueue({
        type: 'control_cancel_request',
        request_id: requestId,
      })
      // 立即 reject Promise，不等待 Host 确认取消
      const request = this.pendingRequests.get(requestId)
      if (request) {
        // 在 reject 前将 tool_use ID 记录为已解决，
        // 使 Host 延迟响应被孤儿处理器忽略
        this.trackResolvedToolUseId(request.request)
        request.reject(new AbortError())
      }
    }
    if (signal) {
      signal.addEventListener('abort', aborted, {
        once: true,
      })
    }
    try {
      return await new Promise<Response>((resolve, reject) => {
        this.pendingRequests.set(requestId, {
          request: {
            type: 'control_request',
            request_id: requestId,
            request,
          },
          resolve: result => {
            resolve(result as Response)
          },
          reject,
          schema,
        })
      })
    } finally {
      if (signal) {
        signal.removeEventListener('abort', aborted)
      }
      this.pendingRequests.delete(requestId)
    }
  }

  /**
   * 创建 CanUseToolFn，将工具使用权限检查桥接到 SDK Host。
   *
   * 流程：
   * 1. 先调用 hasPermissionsToUseTool 检查本地规则；allow/deny 立即返回。
   * 2. 若需要用户确认（ask），并行启动：
   *    a. executePermissionRequestHooksForSDK：PermissionRequest hook（后台运行）。
   *    b. SDK 权限弹窗（sendRequest，立即向 Host 展示）。
   * 3. Promise.race 竞争：hook 先决策则中止 SDK 请求；SDK 先响应则忽略 hook 结果。
   * 4. 任何失败（流关闭、AbortError 等）均返回 deny。
   * 5. finally 中：若无其他 pending 请求，通知会话状态恢复为 running。
   */
  createCanUseTool(
    onPermissionPrompt?: (details: RequiresActionDetails) => void,
  ): CanUseToolFn {
    return async (
      tool: Tool,
      input: { [key: string]: unknown },
      toolUseContext: ToolUseContext,
      assistantMessage: AssistantMessage,
      toolUseID: string,
      forceDecision?: PermissionDecision,
    ): Promise<PermissionDecision> => {
      const mainPermissionResult =
        forceDecision ??
        (await hasPermissionsToUseTool(
          tool,
          input,
          toolUseContext,
          assistantMessage,
          toolUseID,
        ))
      // If the tool is allowed or denied, return the result
      if (
        mainPermissionResult.behavior === 'allow' ||
        mainPermissionResult.behavior === 'deny'
      ) {
        return mainPermissionResult
      }

      // 在终端 CLI 中，hook 与交互式权限弹窗并行竞争；
      // SDK 模式下同理：SDK Host（VS Code 等）立即展示权限对话框，
      // 同时 hook 在后台运行。先到者获胜，另一方被取消/忽略。

      // AbortController 用于在 hook 先决策时取消 SDK 请求
      const hookAbortController = new AbortController()
      const parentSignal = toolUseContext.abortController.signal
      // 将父级 abort 转发到本地 controller
      const onParentAbort = () => hookAbortController.abort()
      parentSignal.addEventListener('abort', onParentAbort, { once: true })

      try {
        // 启动 hook 评估（后台运行）
        const hookPromise = executePermissionRequestHooksForSDK(
          tool.name,
          toolUseID,
          input,
          toolUseContext,
          mainPermissionResult.suggestions,
        ).then(decision => ({ source: 'hook' as const, decision }))

        // 立即启动 SDK 权限弹窗（不等待 hook）
        const requestId = randomUUID()
        onPermissionPrompt?.(
          buildRequiresActionDetails(tool, input, toolUseID, requestId),
        )
        const sdkPromise = this.sendRequest<PermissionToolOutput>(
          {
            subtype: 'can_use_tool',
            tool_name: tool.name,
            input,
            permission_suggestions: mainPermissionResult.suggestions,
            blocked_path: mainPermissionResult.blockedPath,
            decision_reason: serializeDecisionReason(
              mainPermissionResult.decisionReason,
            ),
            tool_use_id: toolUseID,
            agent_id: toolUseContext.agentId,
          },
          permissionToolOutputSchema(),
          hookAbortController.signal,
          requestId,
        ).then(result => ({ source: 'sdk' as const, result }))

        // 赛跑：hook 完成 vs SDK 弹窗响应。
        // hook Promise 始终 resolve（从不 reject），无决策时返回 undefined。
        const winner = await Promise.race([hookPromise, sdkPromise])

        if (winner.source === 'hook') {
          if (winner.decision) {
            // hook 先决策——中止待处理的 SDK 请求。
            // 静默消耗 sdkPromise 的预期 AbortError rejection。
            sdkPromise.catch(() => {})
            hookAbortController.abort()
            return winner.decision
          }
          // hook 放行（无决策）——等待 SDK 弹窗结果
          const sdkResult = await sdkPromise
          return permissionPromptToolResultToPermissionDecision(
            sdkResult.result,
            tool,
            input,
            toolUseContext,
          )
        }

        // SDK 弹窗先响应——使用其结果（hook 仍在后台运行但结果将被忽略）
        return permissionPromptToolResultToPermissionDecision(
          winner.result,
          tool,
          input,
          toolUseContext,
        )
      } catch (error) {
        return permissionPromptToolResultToPermissionDecision(
          {
            behavior: 'deny',
            message: `Tool permission request failed: ${error}`,
            toolUseID,
          },
          tool,
          input,
          toolUseContext,
        )
      } finally {
        // 仅在没有其他 pending 权限请求时（并发工具执行可能同时有多个），
        // 才将会话状态恢复为 running
        if (this.getPendingPermissionRequests().length === 0) {
          notifySessionStateChanged('running')
        }
        parentSignal.removeEventListener('abort', onParentAbort)
      }
    }
  }

  /**
   * 创建 HookCallback，将 hook 回调请求通过 SDK 控制协议转发给 SDK Host。
   * callbackId 与服务端 hook 配置中的 ID 对应；timeout 为可选等待时限。
   * 若请求失败则返回空对象 {} 以避免 hook 机制崩溃。
   */
  createHookCallback(callbackId: string, timeout?: number): HookCallback {
    return {
      type: 'callback',
      timeout,
      callback: async (
        input: HookInput,
        toolUseID: string | null,
        abort: AbortSignal | undefined,
      ): Promise<HookJSONOutput> => {
        try {
          const result = await this.sendRequest<HookJSONOutput>(
            {
              subtype: 'hook_callback',
              callback_id: callbackId,
              input,
              tool_use_id: toolUseID || undefined,
            },
            hookJSONOutputSchema(),
            abort,
          )
          return result
        } catch (error) {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.error(`Error in hook callback ${callbackId}:`, error)
          return {}
        }
      },
    }
  }

  /**
   * 向 SDK 消费方发送 elicitation 请求并等待响应。
   * elicitation 用于 MCP 协议中由服务端主动向用户请求额外信息的场景。
   * 若请求失败（流关闭、取消等），返回 { action: 'cancel' }。
   */
  async handleElicitation(
    serverName: string,
    message: string,
    requestedSchema?: Record<string, unknown>,
    signal?: AbortSignal,
    mode?: 'form' | 'url',
    url?: string,
    elicitationId?: string,
  ): Promise<ElicitResult> {
    try {
      const result = await this.sendRequest<ElicitResult>(
        {
          subtype: 'elicitation',
          mcp_server_name: serverName,
          message,
          mode,
          url,
          elicitation_id: elicitationId,
          requested_schema: requestedSchema,
        },
        SDKControlElicitationResponseSchema(),
        signal,
      )
      return result
    } catch {
      return { action: 'cancel' as const }
    }
  }

  /**
   * 创建沙盒网络权限询问回调，通过 can_use_tool 协议向 SDK Host 请求网络访问权限。
   *
   * 复用现有 can_use_tool 协议（合成工具名 SANDBOX_NETWORK_ACCESS_TOOL_NAME），
   * 使 SDK Host 无需支持新协议子类型即可处理沙盒网络权限弹窗。
   * 若请求失败（流关闭、AbortError 等）则拒绝连接（返回 false）。
   */
  createSandboxAskCallback(): (hostPattern: {
    host: string
    port?: number
  }) => Promise<boolean> {
    return async (hostPattern): Promise<boolean> => {
      try {
        const result = await this.sendRequest<PermissionToolOutput>(
          {
            subtype: 'can_use_tool',
            tool_name: SANDBOX_NETWORK_ACCESS_TOOL_NAME,
            input: { host: hostPattern.host },
            tool_use_id: randomUUID(),
            description: `Allow network connection to ${hostPattern.host}?`,
          },
          permissionToolOutputSchema(),
        )
        return result.behavior === 'allow'
      } catch {
        // If the request fails (stream closed, abort, etc.), deny the connection
        return false
      }
    }
  }

  /**
   * 向 SDK Server 发送 MCP JSON-RPC 消息并等待响应。
   * 消息通过 mcp_message 控制子协议转发，响应从 mcp_response 字段提取。
   */
  async sendMcpMessage(
    serverName: string,
    message: JSONRPCMessage,
  ): Promise<JSONRPCMessage> {
    const response = await this.sendRequest<{ mcp_response: JSONRPCMessage }>(
      {
        subtype: 'mcp_message',
        server_name: serverName,
        message,
      },
      z.object({
        mcp_response: z.any() as z.Schema<JSONRPCMessage>,
      }),
    )
    return response.mcp_response
  }
}

/** 打印错误消息到 stderr 并以退出码 1 终止进程（返回 never 类型）。 */
function exitWithMessage(message: string): never {
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.error(message)
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
}

/**
 * 运行 PermissionRequest hook 并返回决策结果（如有）。
 *
 * 遍历 hook 生成器，对第一个 allow/deny 决策：
 *   - allow：应用 updatedPermissions（持久化 + 更新 context），构造 allow 决策返回。
 *   - deny：构造 deny 决策返回。
 * 若所有 hook 均未做决策，返回 undefined（调用方回退到 SDK 弹窗结果）。
 */
async function executePermissionRequestHooksForSDK(
  toolName: string,
  toolUseID: string,
  input: Record<string, unknown>,
  toolUseContext: ToolUseContext,
  suggestions: PermissionUpdate[] | undefined,
): Promise<PermissionDecision | undefined> {
  const appState = toolUseContext.getAppState()
  const permissionMode = appState.toolPermissionContext.mode

  // 直接遍历生成器而非使用 `all`，以便在第一个决策时提前退出
  const hookGenerator = executePermissionRequestHooks(
    toolName,
    toolUseID,
    input,
    toolUseContext,
    permissionMode,
    suggestions,
    toolUseContext.abortController.signal,
  )

  for await (const hookResult of hookGenerator) {
    if (
      hookResult.permissionRequestResult &&
      (hookResult.permissionRequestResult.behavior === 'allow' ||
        hookResult.permissionRequestResult.behavior === 'deny')
    ) {
      const decision = hookResult.permissionRequestResult
      if (decision.behavior === 'allow') {
        const finalInput = decision.updatedInput || input

        // 若 hook 提供了权限更新（"始终允许"），持久化并更新 context
        const permissionUpdates = decision.updatedPermissions ?? []
        if (permissionUpdates.length > 0) {
          persistPermissionUpdates(permissionUpdates)
          const currentAppState = toolUseContext.getAppState()
          const updatedContext = applyPermissionUpdates(
            currentAppState.toolPermissionContext,
            permissionUpdates,
          )
          // 通过 setAppState 更新权限 context
          toolUseContext.setAppState(prev => {
            if (prev.toolPermissionContext === updatedContext) return prev
            return { ...prev, toolPermissionContext: updatedContext }
          })
        }

        return {
          behavior: 'allow',
          updatedInput: finalInput,
          userModified: false,
          decisionReason: {
            type: 'hook',
            hookName: 'PermissionRequest',
          },
        }
      } else {
        // hook 拒绝了权限
        return {
          behavior: 'deny',
          message:
            decision.message || 'Permission denied by PermissionRequest hook',
          decisionReason: {
            type: 'hook',
            hookName: 'PermissionRequest',
          },
        }
      }
    }
  }

  return undefined
}
