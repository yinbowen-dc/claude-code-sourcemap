/**
 * bridgeMessaging.ts — Bridge 消息传输层通用工具
 *
 * 在 Claude Code 系统流程中的位置：
 *   WebSocket 传输层（ReplBridgeTransport）
 *     └─> bridgeMessaging.ts（本文件）——被以下两个核心模块共享
 *           ├─ initBridgeCore（基于环境变量的 v1 REPL Bridge）
 *           └─ initEnvLessBridgeCore（无环境变量的 v2 REPL Bridge）
 *
 * 背景：本文件从 replBridge.ts 中提取，使两个 Bridge 核心实现（v1 基于 env 的
 * initBridgeCore 和 v2 无 env 的 initEnvLessBridgeCore）能够复用同一套：
 *   - 入站消息解析与路由（handleIngressMessage）
 *   - 服务端控制请求处理（handleServerControlRequest）
 *   - 会话结果消息构建（makeResultMessage）
 *   - 回声去重环形缓冲区（BoundedUUIDSet）
 *   - SDKMessage / ControlRequest / ControlResponse 类型守卫
 *
 * 设计原则：本文件中所有函数均为纯函数（Pure Function）——不持有 Bridge 特定
 * 状态的闭包，所有协作对象（transport、sessionId、UUID 集合、回调）均通过参数传入。
 *
 * Shared transport-layer helpers for bridge message handling.
 *
 * Extracted from replBridge.ts so both the env-based core (initBridgeCore)
 * and the env-less core (initEnvLessBridgeCore) can use the same ingress
 * parsing, control-request handling, and echo-dedup machinery.
 *
 * Everything here is pure — no closure over bridge-specific state. All
 * collaborators (transport, sessionId, UUID sets, callbacks) are passed
 * as params.
 */

import { randomUUID } from 'crypto'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type {
  SDKControlRequest,
  SDKControlResponse,
} from '../entrypoints/sdk/controlTypes.js'
import type { SDKResultSuccess } from '../entrypoints/sdk/coreTypes.js'
import { logEvent } from '../services/analytics/index.js'
import { EMPTY_USAGE } from '../services/api/emptyUsage.js'
import type { Message } from '../types/message.js'
import { normalizeControlMessageKeys } from '../utils/controlMessageCompat.js'
import { logForDebugging } from '../utils/debug.js'
import { stripDisplayTagsAllowEmpty } from '../utils/displayTags.js'
import { errorMessage } from '../utils/errors.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'
import { jsonParse } from '../utils/slowOperations.js'
import type { ReplBridgeTransport } from './replBridgeTransport.js'

// ─── Type guards ─────────────────────────────────────────────────────────────

/**
 * 检查一个未知值是否为 SDKMessage（WebSocket 消息的判别联合类型）。
 *
 * SDKMessage 是以 `type` 字段为判别符的联合类型，
 * 只要 `type` 字段存在且为字符串，即满足此类型守卫的要求；
 * 调用方可在此基础上进一步通过联合类型收窄具体子类型。
 *
 * Type predicate for parsed WebSocket messages. SDKMessage is a
 * discriminated union on `type` — validating the discriminant is
 * sufficient for the predicate; callers narrow further via the union.
 */
export function isSDKMessage(value: unknown): value is SDKMessage {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    typeof value.type === 'string'
  )
}

/**
 * 检查一个未知值是否为来自服务端的 control_response 消息。
 *
 * control_response 是服务端对本地发出的 control_request 的响应，
 * 用于确认模型切换、权限设置等操作的执行结果。
 * 要求：type === 'control_response' 且存在 response 字段。
 *
 * Type predicate for control_response messages from the server.
 */
export function isSDKControlResponse(
  value: unknown,
): value is SDKControlResponse {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'control_response' && // 判别符：control_response
    'response' in value                  // 必须有 response 字段
  )
}

/**
 * 检查一个未知值是否为来自服务端的 control_request 消息。
 *
 * control_request 由服务端主动发起，用于触发会话生命周期事件
 * （如 initialize、set_model）或轮次级别的协调（如 interrupt）。
 * 要求：type === 'control_request' 且同时存在 request_id 和 request 字段。
 * 必须及时响应，否则服务端约 10-14 秒后会关闭 WebSocket 连接。
 *
 * Type predicate for control_request messages from the server.
 */
export function isSDKControlRequest(
  value: unknown,
): value is SDKControlRequest {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'control_request' && // 判别符：control_request
    'request_id' in value &&             // 请求唯一标识，用于回复时匹配
    'request' in value                   // 请求体
  )
}

/**
 * 判断一条消息是否应转发到 Bridge 传输层（即发送到 claude.ai 服务端）。
 *
 * 规则：
 *   - 虚拟消息（REPL 内部调用产生的 user/assistant 消息，isVirtual=true）
 *     仅用于 UI 展示，不应转发——Bridge/SDK 消费方会看到 tool_use/result 的摘要；
 *   - 可转发的消息类型：user、assistant、以及 subtype=local_command 的 system 消息。
 *   - 其他类型（tool_result、progress 等）为 REPL 内部通信，不发送到服务端。
 *
 * True for message types that should be forwarded to the bridge transport.
 * The server only wants user/assistant turns and slash-command system events;
 * everything else (tool_result, progress, etc.) is internal REPL chatter.
 */
export function isEligibleBridgeMessage(m: Message): boolean {
  // Virtual messages (REPL inner calls) are display-only — bridge/SDK
  // consumers see the REPL tool_use/result which summarizes the work.
  // 虚拟消息仅用于本地 UI 展示，不转发
  if ((m.type === 'user' || m.type === 'assistant') && m.isVirtual) {
    return false
  }
  return (
    m.type === 'user' ||
    m.type === 'assistant' ||
    (m.type === 'system' && m.subtype === 'local_command') // 斜线命令系统事件
  )
}

/**
 * 从消息中提取可用于会话标题的文本内容。
 *
 * 返回规则（满足任一则返回 undefined，不参与标题命名）：
 *   - 非 user 类型的消息；
 *   - meta 消息（如 nudge 提示）；
 *   - 含 toolUseResult 的消息；
 *   - compact 摘要消息；
 *   - 非人类来源（任务通知、频道消息等）；
 *   - 纯展示标签内容（如 <ide_opened_file>、<session-start-hook>）。
 *
 * 注意：合成中断消息（[Request interrupted by user]）不在此处过滤——
 * isSyntheticMessage 位于 messages.ts（重型模块，会拉入命令注册表）。
 * initialMessages 路径在 initReplBridge 中已检查；
 * 中断作为第一条消息进入 writeMessages 路径的情况极不可能出现。
 *
 * Extract title-worthy text from a Message for onUserMessage. Returns
 * undefined for messages that shouldn't title the session.
 */
export function extractTitleText(m: Message): string | undefined {
  // 过滤不适合作为标题的消息类型
  if (m.type !== 'user' || m.isMeta || m.toolUseResult || m.isCompactSummary)
    return undefined
  if (m.origin && m.origin.kind !== 'human') return undefined // 过滤非人类来源

  const content = m.message.content
  let raw: string | undefined

  if (typeof content === 'string') {
    raw = content // 纯文本内容直接使用
  } else {
    // 在内容块数组中寻找第一个 text 类型的块
    for (const block of content) {
      if (block.type === 'text') {
        raw = block.text
        break
      }
    }
  }

  if (!raw) return undefined
  // 去除展示标签（如 <ide_opened_file>），若清理后为空则返回 undefined
  const clean = stripDisplayTagsAllowEmpty(raw)
  return clean || undefined
}

// ─── Ingress routing ─────────────────────────────────────────────────────────

/**
 * 解析并路由一条入站 WebSocket 消息到对应的处理器。
 *
 * 处理流程：
 *   1. JSON 解析并规范化 control 消息的键名（兼容旧版消息格式）；
 *   2. control_response → onPermissionResponse（服务端对本地控制请求的回复）；
 *   3. control_request → onControlRequest（服务端发起的生命周期/协调请求）；
 *   4. 非 SDKMessage → 静默丢弃；
 *   5. 检查 UUID 是否在 recentPostedUUIDs 中（我们自己发出的消息的回声）；
 *   6. 检查 UUID 是否在 recentInboundUUIDs 中（服务端重播历史时的重复投递）；
 *   7. 仅 user 类型消息 → 记录 UUID 到 recentInboundUUIDs，触发 onInboundMessage。
 *
 * 防御性去重说明：
 *   SSE seq-num 续传（lastTransportSequenceNum）是重播去重的主要机制；
 *   recentInboundUUIDs 作为边缘情况的兜底（如服务端忽略 from_sequence_num、
 *   传输在收到任何帧之前就已断开等）。
 *
 * Parse an ingress WebSocket message and route it to the appropriate handler.
 * Ignores messages whose UUID is in recentPostedUUIDs (echoes of what we sent)
 * or in recentInboundUUIDs (re-deliveries we've already forwarded).
 */
export function handleIngressMessage(
  data: string,
  recentPostedUUIDs: BoundedUUIDSet,
  recentInboundUUIDs: BoundedUUIDSet,
  onInboundMessage: ((msg: SDKMessage) => void | Promise<void>) | undefined,
  onPermissionResponse?: ((response: SDKControlResponse) => void) | undefined,
  onControlRequest?: ((request: SDKControlRequest) => void) | undefined,
): void {
  try {
    // 解析 JSON 并规范化 control 消息键名（兼容旧版格式）
    const parsed: unknown = normalizeControlMessageKeys(jsonParse(data))

    // control_response 不是 SDKMessage，需在 isSDKMessage 类型守卫之前检查
    if (isSDKControlResponse(parsed)) {
      logForDebugging('[bridge:repl] Ingress message type=control_response')
      onPermissionResponse?.(parsed) // 权限响应回调（用户在 claude.ai 点击允许/拒绝）
      return
    }

    // control_request from the server (initialize, set_model, can_use_tool).
    // Must respond promptly or the server kills the WS (~10-14s timeout).
    // 服务端发起的控制请求，必须及时响应，否则约 10-14 秒后服务端会关闭 WebSocket
    if (isSDKControlRequest(parsed)) {
      logForDebugging(
        `[bridge:repl] Inbound control_request subtype=${parsed.request.subtype}`,
      )
      onControlRequest?.(parsed) // 控制请求回调（会话初始化、模型切换等）
      return
    }

    // 非 SDKMessage 格式，静默丢弃
    if (!isSDKMessage(parsed)) return

    // Check for UUID to detect echoes of our own messages
    // 提取消息 UUID，用于回声检测和重复投递检测
    const uuid =
      'uuid' in parsed && typeof parsed.uuid === 'string'
        ? parsed.uuid
        : undefined

    // 若 UUID 在已发送集合中，说明是我们自己消息的回声，直接丢弃
    if (uuid && recentPostedUUIDs.has(uuid)) {
      logForDebugging(
        `[bridge:repl] Ignoring echo: type=${parsed.type} uuid=${uuid}`,
      )
      return
    }

    // Defensive dedup: drop inbound prompts we've already forwarded. The
    // SSE seq-num carryover (lastTransportSequenceNum) is the primary fix
    // for history-replay; this catches edge cases where that negotiation
    // fails (server ignores from_sequence_num, transport died before
    // receiving any frames, etc).
    // 防御性去重：若 UUID 在已入站集合中，说明是重复投递（如服务端重播历史），丢弃
    if (uuid && recentInboundUUIDs.has(uuid)) {
      logForDebugging(
        `[bridge:repl] Ignoring re-delivered inbound: type=${parsed.type} uuid=${uuid}`,
      )
      return
    }

    logForDebugging(
      `[bridge:repl] Ingress message type=${parsed.type}${uuid ? ` uuid=${uuid}` : ''}`,
    )

    if (parsed.type === 'user') {
      if (uuid) recentInboundUUIDs.add(uuid) // 记录 UUID，防止重复处理
      logEvent('tengu_bridge_message_received', {
        is_repl: true,
      })
      // Fire-and-forget — handler may be async (attachment resolution).
      // 异步触发入站消息处理器（附件解析可能是异步的），不等待结果
      void onInboundMessage?.(parsed)
    } else {
      // 非 user 类型的入站消息（如 assistant 消息是我们自己发出的，不应作为输入）
      logForDebugging(
        `[bridge:repl] Ignoring non-user inbound message: type=${parsed.type}`,
      )
    }
  } catch (err) {
    // JSON 解析失败或类型检查异常，记录错误并继续（不中断轮询循环）
    logForDebugging(
      `[bridge:repl] Failed to parse ingress message: ${errorMessage(err)}`,
    )
  }
}

// ─── Server-initiated control requests ───────────────────────────────────────

/**
 * handleServerControlRequest 的依赖注入参数类型。
 * 包含 transport、会话 ID、可选的各类回调及仅出站模式标志。
 */
export type ServerControlRequestHandlers = {
  /** 当前活跃的 WebSocket 传输层，用于发送控制响应 */
  transport: ReplBridgeTransport | null
  /** 当前会话 ID，附加到每条控制响应消息中 */
  sessionId: string
  /**
   * When true, all mutable requests (interrupt, set_model, set_permission_mode,
   * set_max_thinking_tokens) reply with an error instead of false-success.
   * initialize still replies success — the server kills the connection otherwise.
   * Used by the outbound-only bridge mode and the SDK's /bridge subpath so claude.ai sees a
   * proper error instead of "action succeeded but nothing happened locally".
   *
   * 为 true 时，所有可变请求（interrupt/set_model/set_permission_mode/set_max_thinking_tokens）
   * 均回复错误，而非虚假的成功。initialize 仍回复成功（否则服务端会断开连接）。
   * 用于仅出站（outbound-only）Bridge 模式和 SDK /bridge 子路径，
   * 确保 claude.ai 看到真实错误而非"操作成功但本地无效果"的误导。
   */
  outboundOnly?: boolean
  /** 用户触发中断（Ctrl+C）时调用的回调 */
  onInterrupt?: () => void
  /** 服务端要求切换模型时调用的回调 */
  onSetModel?: (model: string | undefined) => void
  /** 服务端要求设置最大 Thinking Token 数量时调用的回调 */
  onSetMaxThinkingTokens?: (maxTokens: number | null) => void
  /** 服务端要求切换权限模式时调用的回调，返回操作是否成功及错误信息 */
  onSetPermissionMode?: (
    mode: PermissionMode,
  ) => { ok: true } | { ok: false; error: string }
}

/** 仅出站模式下，拒绝可变请求时发送的错误消息 */
const OUTBOUND_ONLY_ERROR =
  'This session is outbound-only. Enable Remote Control locally to allow inbound control.'

/**
 * 处理服务端发起的 control_request 消息并发送对应的 control_response。
 *
 * 整体流程：
 *   1. 若 transport 为 null，记录警告并返回（无法响应）；
 *   2. 若 outboundOnly=true 且非 initialize 请求，回复错误（拒绝可变操作）；
 *   3. 按 request.subtype 路由：
 *      - initialize：回复最小能力声明（commands/models/account 均为空）；
 *      - set_model：调用 onSetModel 回调后回复成功；
 *      - set_max_thinking_tokens：调用回调后回复成功；
 *      - set_permission_mode：调用回调，根据策略裁决（ok/error）回复；
 *      - interrupt：调用 onInterrupt 回调后回复成功；
 *      - 未知 subtype：回复错误，防止服务端挂起等待超时。
 *   4. 将响应附加 session_id 后通过 transport.write 发送出去。
 *
 * 注意：必须在约 10-14 秒内响应，否则服务端会主动关闭 WebSocket 连接。
 *
 * Respond to inbound control_request messages from the server.
 */
export function handleServerControlRequest(
  request: SDKControlRequest,
  handlers: ServerControlRequestHandlers,
): void {
  const {
    transport,
    sessionId,
    outboundOnly,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
  } = handlers

  // 没有活跃的 transport，无法发送响应
  if (!transport) {
    logForDebugging(
      '[bridge:repl] Cannot respond to control_request: transport not configured',
    )
    return
  }

  let response: SDKControlResponse

  // Outbound-only: reply error for mutable requests so claude.ai doesn't show
  // false success. initialize must still succeed (server kills the connection
  // if it doesn't — see comment above).
  // 仅出站模式：对可变请求回复错误，避免 claude.ai 显示虚假的"操作成功"
  if (outboundOnly && request.request.subtype !== 'initialize') {
    response = {
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: request.request_id,
        error: OUTBOUND_ONLY_ERROR,
      },
    }
    const event = { ...response, session_id: sessionId }
    void transport.write(event)
    logForDebugging(
      `[bridge:repl] Rejected ${request.request.subtype} (outbound-only) request_id=${request.request_id}`,
    )
    return
  }

  switch (request.request.subtype) {
    case 'initialize':
      // Respond with minimal capabilities — the REPL handles
      // commands, models, and account info itself.
      // 回复最小能力声明：REPL 自己管理命令、模型和账户信息，不通过此接口暴露
      response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
          response: {
            commands: [],              // REPL 不通过 Bridge 暴露命令列表
            output_style: 'normal',
            available_output_styles: ['normal'],
            models: [],                // REPL 自己管理可用模型列表
            account: {},               // REPL 自己管理账户信息
            pid: process.pid,          // 上报当前进程 PID，便于服务端调试
          },
        },
      }
      break

    case 'set_model':
      // 切换当前会话使用的 AI 模型
      onSetModel?.(request.request.model)
      response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
        },
      }
      break

    case 'set_max_thinking_tokens':
      // 设置扩展思考功能的最大 Token 数量
      onSetMaxThinkingTokens?.(request.request.max_thinking_tokens)
      response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
        },
      }
      break

    case 'set_permission_mode': {
      // The callback returns a policy verdict so we can send an error
      // control_response without importing isAutoModeGateEnabled /
      // isBypassPermissionsModeDisabled here (bootstrap-isolation). If no
      // callback is registered (daemon context, which doesn't wire this —
      // see daemonBridge.ts), return an error verdict rather than a silent
      // false-success: the mode is never actually applied in that context,
      // so success would lie to the client.
      //
      // 回调返回策略裁决，避免在此处引入 isAutoModeGateEnabled /
      // isBypassPermissionsModeDisabled（bootstrap 隔离要求）。
      // 若无回调（Daemon 上下文），返回错误裁决而非虚假成功。
      const verdict = onSetPermissionMode?.(request.request.mode) ?? {
        ok: false,
        error:
          'set_permission_mode is not supported in this context (onSetPermissionMode callback not registered)',
      }
      if (verdict.ok) {
        // 权限模式切换成功
        response = {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: request.request_id,
          },
        }
      } else {
        // 权限模式切换被策略拒绝，回复错误信息
        response = {
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: request.request_id,
            error: verdict.error,
          },
        }
      }
      break
    }

    case 'interrupt':
      // 用户在 claude.ai 上点击中断按钮，触发本地的 SIGINT 等效操作
      onInterrupt?.()
      response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
        },
      }
      break

    default:
      // Unknown subtype — respond with error so the server doesn't
      // hang waiting for a reply that never comes.
      // 未知子类型：回复错误，防止服务端无限等待超时
      response = {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: request.request_id,
          error: `REPL bridge does not handle control_request subtype: ${request.request.subtype}`,
        },
      }
  }

  // 附加 session_id 后通过 transport 发送响应
  const event = { ...response, session_id: sessionId }
  void transport.write(event)
  logForDebugging(
    `[bridge:repl] Sent control_response for ${request.request.subtype} request_id=${request.request_id} result=${response.response.subtype}`,
  )
}

// ─── Result message (for session archival on teardown) ───────────────────────

/**
 * 构造一条最小化的 SDKResultSuccess 消息，用于会话归档。
 *
 * 服务端需要在 WebSocket 关闭之前收到 result 事件，才能触发会话归档流程。
 * 在以下场景中调用此函数：
 *   - Bridge 正常关闭（graceful shutdown）前；
 *   - 会话因错误提前终止时。
 *
 * 所有数值字段（duration、cost、num_turns 等）均设为零，
 * 因为此消息仅用于触发归档，不代表真实的会话统计数据。
 *
 * Build a minimal `SDKResultSuccess` message for session archival.
 * The server needs this event before a WS close to trigger archival.
 */
export function makeResultMessage(sessionId: string): SDKResultSuccess {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 0,        // 持续时间置零（非真实统计）
    duration_api_ms: 0,
    is_error: false,
    num_turns: 0,          // 轮次数置零
    result: '',
    stop_reason: null,
    total_cost_usd: 0,     // 费用置零
    usage: { ...EMPTY_USAGE }, // 使用空 Usage 对象
    modelUsage: {},
    permission_denials: [],
    session_id: sessionId, // 关联当前会话 ID
    uuid: randomUUID(),    // 为每条 result 消息生成唯一 UUID
  }
}

// ─── BoundedUUIDSet (echo-dedup ring buffer) ─────────────────────────────────

/**
 * 有界 UUID 集合（循环缓冲区实现的 FIFO 去重集合）。
 *
 * 用于 Bridge 消息的回声去重和重复投递去重：
 *   - recentPostedUUIDs：记录本地已发出消息的 UUID，过滤服务端的回声；
 *   - recentInboundUUIDs：记录已处理的入站消息 UUID，过滤服务端的历史重播。
 *
 * 实现特点：
 *   - 使用循环缓冲区（ring buffer）保证内存占用恒定为 O(capacity)；
 *   - 同时维护 Set<string> 保证 O(1) 的查找性能；
 *   - 消息按时间顺序添加，因此被淘汰的总是最旧的条目；
 *   - 调用方以外部排序（lastWrittenIndexRef hook）作为主要去重手段，
 *     此集合作为次级安全网，处理回声过滤和竞态条件去重。
 *
 * FIFO-bounded set backed by a circular buffer. Evicts the oldest entry
 * when capacity is reached, keeping memory usage constant at O(capacity).
 */
export class BoundedUUIDSet {
  /** 集合的最大容量 */
  private readonly capacity: number
  /** 循环缓冲区，存储 UUID 字符串，按写入顺序循环覆盖 */
  private readonly ring: (string | undefined)[]
  /** 快速查找集合，与 ring 保持同步 */
  private readonly set = new Set<string>()
  /** 下一次写入的环形缓冲区索引 */
  private writeIdx = 0

  constructor(capacity: number) {
    this.capacity = capacity
    this.ring = new Array<string | undefined>(capacity) // 初始化为 undefined 的数组
  }

  /**
   * 向集合中添加一个 UUID。
   *
   * 若 UUID 已存在，直接返回（幂等）。
   * 若缓冲区已满，先淘汰 writeIdx 位置的旧 UUID（从 set 中删除），
   * 再将新 UUID 写入该位置，然后推进 writeIdx（循环）。
   */
  add(uuid: string): void {
    if (this.set.has(uuid)) return // UUID 已存在，幂等返回
    // Evict the entry at the current write position (if occupied)
    // 淘汰 writeIdx 位置的旧条目（若存在）
    const evicted = this.ring[this.writeIdx]
    if (evicted !== undefined) {
      this.set.delete(evicted) // 从 Set 中删除被淘汰的 UUID
    }
    this.ring[this.writeIdx] = uuid // 写入新 UUID
    this.set.add(uuid)              // 同步更新 Set
    this.writeIdx = (this.writeIdx + 1) % this.capacity // 推进写指针（循环）
  }

  /**
   * 检查 UUID 是否在集合中（O(1) 查找）。
   */
  has(uuid: string): boolean {
    return this.set.has(uuid)
  }

  /**
   * 清空集合（用于 Bridge 重置或会话切换时清理旧状态）。
   */
  clear(): void {
    this.set.clear()              // 清空快速查找 Set
    this.ring.fill(undefined)     // 清空循环缓冲区
    this.writeIdx = 0             // 重置写指针
  }
}
