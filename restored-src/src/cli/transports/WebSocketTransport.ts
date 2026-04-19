/**
 * WebSocket 传输层 — 全双工 WebSocket 连接实现。
 *
 * 在整个 Claude Code 系统中的位置：
 * WebSocketTransport 是默认传输实现（非 CCR v2 路径）。
 * HybridTransport 继承自它，仅覆盖写入通道（走 HTTP POST 而非 WebSocket 发送）。
 * 通过 getTransportForUrl 工厂函数在以下条件下被选中：
 *   - CLAUDE_CODE_USE_CCR_V2 未设置（否则用 SSETransport）
 *   - CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2 未设置（否则用 HybridTransport）
 *
 * 关键特性：
 *   - 自动重连：连接断开后以指数退避（1s→30s，±25% 抖动）重连，
 *     总时间预算 10 分钟（DEFAULT_RECONNECT_GIVE_UP_MS）后放弃并触发 onClose。
 *   - 系统睡眠检测：若两次重连间隔超过 60s，认为机器曾被挂起，重置重连预算重试。
 *   - 消息缓冲与重放：CircularBuffer 保存最近 1000 条带 UUID 的消息；
 *     重连后通过 X-Last-Request-Id 协商，服务端确认已收到的 ID，
 *     客户端只重放未确认的消息（Bun 不支持升级响应头，全量重放）。
 *   - Ping/Pong 健康检测：每 10s 发送 WebSocket ping 控制帧，若无 pong 回应则强制重连。
 *   - Keep-alive 数据帧：每 5 分钟发送 keep_alive JSON 数据帧，重置代理空闲计时器
 *     （CCR 远程会话通过 sessionActivity 心跳代替，不启用此机制）。
 *   - 永久关闭码（1002/4001/4003）：立即转为 closed 状态，不重试
 *     （例外：4003 + refreshHeaders 有新 token 时允许重试一次）。
 *   - 双运行时支持：Bun（globalThis.WebSocket）和 Node.js（ws 包）均支持；
 *     事件处理方式分别用 addEventListener/removeEventListener（Bun）和 on/off（ws）。
 */
import type { StdoutMessage } from 'src/entrypoints/sdk/controlTypes.js'
import type WsWebSocket from 'ws'
import { logEvent } from '../../services/analytics/index.js'
import { CircularBuffer } from '../../utils/CircularBuffer.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getWebSocketTLSOptions } from '../../utils/mtls.js'
import {
  getWebSocketProxyAgent,
  getWebSocketProxyUrl,
} from '../../utils/proxy.js'
import {
  registerSessionActivityCallback,
  unregisterSessionActivityCallback,
} from '../../utils/sessionActivity.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { Transport } from './Transport.js'

/** keep_alive 数据帧内容：重置代理空闲计时器用的 JSON 字符串（含换行符） */
const KEEP_ALIVE_FRAME = '{"type":"keep_alive"}\n'

// 消息循环缓冲区容量上限（保存最近 N 条带 UUID 的消息，用于重连重放）
const DEFAULT_MAX_BUFFER_SIZE = 1000
// 重连指数退避基础延迟（毫秒）
const DEFAULT_BASE_RECONNECT_DELAY = 1000
// 重连指数退避最大延迟上限（毫秒）
const DEFAULT_MAX_RECONNECT_DELAY = 30000
/** 重连时间预算上限（10 分钟）：超过后放弃重连并触发 onClose。 */
const DEFAULT_RECONNECT_GIVE_UP_MS = 600_000
// Ping 控制帧发送间隔（毫秒）：用于检测死连接
const DEFAULT_PING_INTERVAL = 10000
// Keep-alive 数据帧发送间隔（毫秒）：5 分钟，重置代理空闲计时器
const DEFAULT_KEEPALIVE_INTERVAL = 300_000 // 5 minutes

/**
 * 系统睡眠检测阈值（毫秒）。
 * 若两次重连尝试之间的间隔超过此值，认为机器曾被挂起（如笔记本合盖）。
 * 此时重置重连预算并重新尝试——若会话在睡眠期间已被回收，
 * 服务端会以永久关闭码（4001/1002）拒绝连接。
 */
const SLEEP_DETECTION_THRESHOLD_MS = DEFAULT_MAX_RECONNECT_DELAY * 2 // 60s

/**
 * 永久性 WebSocket 关闭码集合。
 * 收到这些关闭码时传输层立即转为 closed 状态，不执行重连。
 * 1002：协议错误（服务端拒绝握手，如会话已被回收）；
 * 4001：会话过期或不存在；4003：未授权。
 * 例外：4003 + refreshHeaders 有新 token 时允许重试一次。
 */
const PERMANENT_CLOSE_CODES = new Set([
  1002, // protocol error — server rejected handshake (e.g. session reaped)
  4001, // session expired / not found
  4003, // unauthorized
])

/**
 * WebSocketTransport 的构造选项。
 */
export type WebSocketTransportOptions = {
  /**
   * 为 false 时禁用自动重连。
   * 适用于调用方有自己的恢复机制的场景（如 REPL bridge 轮询循环）。
   * 默认为 true。
   */
  autoReconnect?: boolean
  /**
   * 是否开启 bridge 遥测事件（tengu_ws_transport_*）。
   * 仅在 REPL bridge 构建点设为 true，使只有远程控制会话（Cloudflare 空闲超时人群）
   * 才上报事件；print 模式的 worker 保持静默。默认为 false。
   */
  isBridge?: boolean
}

/**
 * WebSocket 传输层状态机状态。
 * idle        — 初始态，尚未调用 connect()
 * reconnecting — 正在尝试建立/重建连接
 * connected   — 连接已建立，可正常收发消息
 * closing     — 已调用 close()，等待清理
 * closed      — 连接已彻底关闭，不再重连
 */
type WebSocketTransportState =
  | 'idle'
  | 'connected'
  | 'reconnecting'
  | 'closing'
  | 'closed'

/**
 * Bun globalThis.WebSocket 与 Node.js ws 包的公共接口抽象。
 * 仅包含 WebSocketTransport 使用到的方法，便于双运行时统一处理。
 */
type WebSocketLike = {
  close(): void
  send(data: string): void
  ping?(): void // Bun & ws both support this
}

export class WebSocketTransport implements Transport {
  /** 当前活跃的 WebSocket 实例（Bun 或 Node.js ws），未连接时为 null */
  private ws: WebSocketLike | null = null
  /** 最后一条已发送消息的 UUID，重连时作为 X-Last-Request-Id 请求头发送给服务端 */
  private lastSentId: string | null = null
  /** WebSocket 连接目标 URL（子类 HybridTransport 也需访问） */
  protected url: URL
  /** 当前状态（子类可读） */
  protected state: WebSocketTransportState = 'idle'
  /** 数据接收回调，每条入站 NDJSON 消息均触发（子类可读） */
  protected onData?: (data: string) => void
  /** 连接最终关闭回调（可携带关闭码） */
  private onCloseCallback?: (closeCode?: number) => void
  /** 连接成功建立回调 */
  private onConnectCallback?: () => void
  /** 当前请求头，重连前可通过 refreshHeaders 更新 */
  private headers: Record<string, string>
  /** 关联的会话 ID，仅用于日志区分 */
  private sessionId?: string
  /** 是否自动重连（false 时连接断开后直接转为 closed） */
  private autoReconnect: boolean
  /** 是否开启 bridge 遥测（tengu_ws_transport_* 事件） */
  private isBridge: boolean

  // 重连状态
  /** 当前连续重连尝试次数（成功后重置为 0） */
  private reconnectAttempts = 0
  /** 本轮重连开始时间（首次断连时设置，成功后清空），用于计算总耗时 */
  private reconnectStartTime: number | null = null
  /** 待触发的重连定时器引用 */
  private reconnectTimer: NodeJS.Timeout | null = null
  /**
   * 上次重连尝试的时间戳。
   * 用于睡眠检测：若两次尝试间隔超过 SLEEP_DETECTION_THRESHOLD_MS（60s），
   * 认为机器曾被挂起，重置重连预算。
   */
  private lastReconnectAttemptTime: number | null = null
  /**
   * 最后一次数据帧活动的时间戳（入站消息或 ws.send 时更新）。
   * close 时用于计算空闲时长，诊断代理空闲超时导致的 RST
   * （如 Cloudflare 5 分钟空闲断连）。不包含 ping/pong 控制帧。
   */
  private lastActivityTime = 0

  /** Ping 健康检测定时器 */
  private pingInterval: NodeJS.Timeout | null = null
  /** 最近一次 ping 的 pong 是否已收到（若未收到则判定连接死亡） */
  private pongReceived = true

  /** Keep-alive 数据帧定时器（CCR 远程会话不启用，走 sessionActivity 心跳代替） */
  private keepAliveInterval: NodeJS.Timeout | null = null

  /** 消息循环缓冲区：保存最近 N 条带 UUID 的消息，重连后重放未确认的消息 */
  private messageBuffer: CircularBuffer<StdoutMessage>
  /**
   * 标记当前 WebSocket 实例是 Bun 还是 Node.js ws。
   * 用于在 removeWsListeners() 时选择正确的 API
   * （Bun: removeEventListener，Node.js: off）。
   */
  private isBunWs = false

  /**
   * connect() 调用时的时间戳，供 handleOpenEvent() 计算连接耗时。
   * 存为实例字段而非闭包变量，使 onOpen 可以是可移除的类属性箭头函数。
   */
  private connectStartTime = 0

  /** 断线重连时动态刷新请求头的回调（用于获取最新 session ingress token） */
  private refreshHeaders?: () => Record<string, string>

  constructor(
    url: URL,
    headers: Record<string, string> = {},
    sessionId?: string,
    refreshHeaders?: () => Record<string, string>,
    options?: WebSocketTransportOptions,
  ) {
    this.url = url
    this.headers = headers
    this.sessionId = sessionId
    this.refreshHeaders = refreshHeaders
    this.autoReconnect = options?.autoReconnect ?? true
    this.isBridge = options?.isBridge ?? false
    // 初始化消息循环缓冲区，容量为 DEFAULT_MAX_BUFFER_SIZE（1000）
    this.messageBuffer = new CircularBuffer(DEFAULT_MAX_BUFFER_SIZE)
  }

  /**
   * 建立 WebSocket 连接。
   *
   * 流程：
   * 1. 状态必须为 idle 或 reconnecting，否则直接返回。
   * 2. 将 lastSentId（若存在）追加到 X-Last-Request-Id 请求头，
   *    使服务端能确认已收到的消息并指导重放范围。
   * 3. 根据运行时选择 Bun（globalThis.WebSocket）或 Node.js（ws 包）实现，
   *    并注册对应的 open/message/error/close/pong 事件处理器。
   * 4. Bun 不支持升级响应头，重连后全量重放缓冲消息；
   *    Node.js 可从 upgradeReq.headers['x-last-request-id'] 获取服务端确认 ID，
   *    仅重放未确认的消息（见 onNodeOpen）。
   */
  public async connect(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'reconnecting') {
      logForDebugging(
        `WebSocketTransport: Cannot connect, current state is ${this.state}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_websocket_connect_failed')
      return
    }
    this.state = 'reconnecting'

    this.connectStartTime = Date.now()
    logForDebugging(`WebSocketTransport: Opening ${this.url.href}`)
    logForDiagnosticsNoPII('info', 'cli_websocket_connect_opening')

    // Start with provided headers and add runtime headers
    const headers = { ...this.headers }
    if (this.lastSentId) {
      headers['X-Last-Request-Id'] = this.lastSentId
      logForDebugging(
        `WebSocketTransport: Adding X-Last-Request-Id header: ${this.lastSentId}`,
      )
    }

    if (typeof Bun !== 'undefined') {
      // Bun 运行时：使用 globalThis.WebSocket，传入自定义请求头和代理配置
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const ws = new globalThis.WebSocket(this.url.href, {
        headers,
        proxy: getWebSocketProxyUrl(this.url.href),
        tls: getWebSocketTLSOptions() || undefined,
      } as unknown as string[])
      this.ws = ws
      this.isBunWs = true

      ws.addEventListener('open', this.onBunOpen)
      ws.addEventListener('message', this.onBunMessage)
      ws.addEventListener('error', this.onBunError)
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      ws.addEventListener('close', this.onBunClose)
      // 'pong' is Bun-specific — not in DOM typings.
      ws.addEventListener('pong', this.onPong)
    } else {
      // Node.js 运行时：动态导入 ws 包，传入请求头和代理 Agent
      const { default: WS } = await import('ws')
      const ws = new WS(this.url.href, {
        headers,
        agent: getWebSocketProxyAgent(this.url.href),
        ...getWebSocketTLSOptions(),
      })
      this.ws = ws
      this.isBunWs = false

      ws.on('open', this.onNodeOpen)
      ws.on('message', this.onNodeMessage)
      ws.on('error', this.onNodeError)
      ws.on('close', this.onNodeClose)
      ws.on('pong', this.onPong)
    }
  }

  // --- Bun（原生 WebSocket）事件处理器 ---
  // 以类属性箭头函数存储，使其可在 doDisconnect() 中被移除。
  // 若不移除，每次重连都会孤立旧的 WS 对象及其 5 个闭包，
  // 在网络不稳定时持续积累，直到 GC 才释放。
  // 与 src/utils/mcpWebSocketTransport.ts 的模式保持一致。

  private onBunOpen = () => {
    this.handleOpenEvent()
    // Bun 的 WebSocket 不暴露升级响应头，因此重放全部缓冲消息。
    // 服务端通过 UUID 去重，不会重复处理已确认的消息。
    if (this.lastSentId) {
      this.replayBufferedMessages('')
    }
  }

  private onBunMessage = (event: MessageEvent) => {
    const message =
      typeof event.data === 'string' ? event.data : String(event.data)
    // 记录活动时间戳（供关闭时计算空闲时长）
    this.lastActivityTime = Date.now()
    logForDiagnosticsNoPII('info', 'cli_websocket_message_received', {
      length: message.length,
    })
    if (this.onData) {
      this.onData(message)
    }
  }

  private onBunError = () => {
    logForDebugging('WebSocketTransport: Error', {
      level: 'error',
    })
    logForDiagnosticsNoPII('error', 'cli_websocket_connect_error')
    // error 事件后会紧接 close 事件——由 close 处理器调用 handleConnectionError
  }

  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  private onBunClose = (event: CloseEvent) => {
    // 1000/1001 为正常关闭，其余为异常关闭
    const isClean = event.code === 1000 || event.code === 1001
    logForDebugging(
      `WebSocketTransport: Closed: ${event.code}`,
      isClean ? undefined : { level: 'error' },
    )
    logForDiagnosticsNoPII('error', 'cli_websocket_connect_closed')
    this.handleConnectionError(event.code)
  }

  // --- Node.js（ws 包）事件处理器 ---

  private onNodeOpen = () => {
    // 在 handleOpenEvent() 触发 onConnectCallback 之前捕获 ws 引用。
    // 若回调同步关闭了传输层，this.ws 会变为 null；
    // 此处通过本地变量保留旧引用，确保后续操作安全。
    const ws = this.ws
    this.handleOpenEvent()
    if (!ws) return
    // ws 包支持访问升级响应头，可精确获取服务端确认的最后 ID，
    // 仅重放未确认的消息（比 Bun 的全量重放更高效）。
    const nws = ws as unknown as WsWebSocket & {
      upgradeReq?: { headers?: Record<string, string> }
    }
    const upgradeResponse = nws.upgradeReq
    if (upgradeResponse?.headers?.['x-last-request-id']) {
      const serverLastId = upgradeResponse.headers['x-last-request-id']
      this.replayBufferedMessages(serverLastId)
    }
  }

  private onNodeMessage = (data: Buffer) => {
    const message = data.toString()
    // 记录活动时间戳（供关闭时计算空闲时长）
    this.lastActivityTime = Date.now()
    logForDiagnosticsNoPII('info', 'cli_websocket_message_received', {
      length: message.length,
    })
    if (this.onData) {
      this.onData(message)
    }
  }

  private onNodeError = (err: Error) => {
    logForDebugging(`WebSocketTransport: Error: ${err.message}`, {
      level: 'error',
    })
    logForDiagnosticsNoPII('error', 'cli_websocket_connect_error')
    // error 事件后会紧接 close 事件——由 close 处理器调用 handleConnectionError
  }

  private onNodeClose = (code: number, _reason: Buffer) => {
    const isClean = code === 1000 || code === 1001
    logForDebugging(
      `WebSocketTransport: Closed: ${code}`,
      isClean ? undefined : { level: 'error' },
    )
    logForDiagnosticsNoPII('error', 'cli_websocket_connect_closed')
    this.handleConnectionError(code)
  }

  // --- 共用处理器 ---

  /** pong 响应处理器：标记本轮 ping 已收到响应，连接健康 */
  private onPong = () => {
    this.pongReceived = true
  }

  /**
   * 连接建立后的统一处理逻辑（Bun open 和 Node.js open 共用）。
   *
   * 流程：
   * 1. 记录连接耗时并输出调试日志。
   * 2. 若为 bridge 模式且本次为重连（reconnectStartTime 非 null），
   *    上报 tengu_ws_transport_reconnected 遥测事件（含重连次数和停机时长）。
   * 3. 重置重连状态（attempts/startTime/lastAttemptTime）。
   * 4. 将状态设为 connected 并触发 onConnectCallback。
   * 5. 启动 ping 健康检测定时器和 keep-alive 数据帧定时器。
   * 6. 注册 sessionActivity 回调（外部信号触发 keep_alive 写入）。
   */
  private handleOpenEvent(): void {
    const connectDuration = Date.now() - this.connectStartTime
    logForDebugging('WebSocketTransport: Connected')
    logForDiagnosticsNoPII('info', 'cli_websocket_connect_connected', {
      duration_ms: connectDuration,
    })

    // 重连成功——捕获尝试次数和停机时长后重置状态。
    // reconnectStartTime 首次连接时为 null，重连时为非 null。
    if (this.isBridge && this.reconnectStartTime !== null) {
      logEvent('tengu_ws_transport_reconnected', {
        attempts: this.reconnectAttempts,
        downtimeMs: Date.now() - this.reconnectStartTime,
      })
    }

    this.reconnectAttempts = 0
    this.reconnectStartTime = null
    this.lastReconnectAttemptTime = null
    this.lastActivityTime = Date.now()
    this.state = 'connected'
    this.onConnectCallback?.()

    // 启动周期性 ping，用于检测死连接
    this.startPingInterval()

    // 启动周期性 keep_alive 数据帧，重置代理空闲计时器
    this.startKeepaliveInterval()

    // 注册 sessionActivity 回调：外部信号（如工具调用）触发 keep_alive 写入
    registerSessionActivityCallback(() => {
      void this.write({ type: 'keep_alive' })
    })
  }

  /**
   * 向 WebSocket 发送单行文本。
   * 若未连接则返回 false；发送失败则触发 handleConnectionError() 重连流程。
   * 成功时更新 lastActivityTime。
   */
  protected sendLine(line: string): boolean {
    if (!this.ws || this.state !== 'connected') {
      logForDebugging('WebSocketTransport: Not connected')
      logForDiagnosticsNoPII('info', 'cli_websocket_send_not_connected')
      return false
    }

    try {
      this.ws.send(line)
      this.lastActivityTime = Date.now()
      return true
    } catch (error) {
      logForDebugging(`WebSocketTransport: Failed to send: ${error}`, {
        level: 'error',
      })
      logForDiagnosticsNoPII('error', 'cli_websocket_send_error')
      // 不在此处置 null this.ws——让 doDisconnect()（通过 handleConnectionError 调用）
      // 负责清理，确保监听器先被移除再释放 WS 对象。
      this.handleConnectionError()
      return false
    }
  }

  /**
   * 移除 connect() 时附加的所有 WebSocket 监听器。
   * 若不移除，每次重连都会孤立旧 WS 对象及其闭包直到 GC，
   * 在网络不稳定时持续积累内存。
   * 根据 isBunWs 标志选择对应的 API（removeEventListener/off）。
   */
  private removeWsListeners(ws: WebSocketLike): void {
    if (this.isBunWs) {
      const nws = ws as unknown as globalThis.WebSocket
      nws.removeEventListener('open', this.onBunOpen)
      nws.removeEventListener('message', this.onBunMessage)
      nws.removeEventListener('error', this.onBunError)
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      nws.removeEventListener('close', this.onBunClose)
      // 'pong' is Bun-specific — not in DOM typings
      nws.removeEventListener('pong' as 'message', this.onPong)
    } else {
      const nws = ws as unknown as WsWebSocket
      nws.off('open', this.onNodeOpen)
      nws.off('message', this.onNodeMessage)
      nws.off('error', this.onNodeError)
      nws.off('close', this.onNodeClose)
      nws.off('pong', this.onPong)
    }
  }

  /**
   * 断开当前 WebSocket 连接并清理所有定时器和监听器。
   * 先移除监听器再调用 ws.close()，确保旧 WS 对象可被 GC 及时回收。
   */
  protected doDisconnect(): void {
    // 停止 ping 和 keep-alive 定时器
    this.stopPingInterval()
    this.stopKeepaliveInterval()

    // 注销 sessionActivity 回调
    unregisterSessionActivityCallback()

    if (this.ws) {
      // 先移除监听器，再调用 close()——让旧 WS 对象和闭包尽快被 GC 回收，
      // 而不是等到下次 mark-and-sweep。
      this.removeWsListeners(this.ws)
      this.ws.close()
      this.ws = null
    }
  }

  /**
   * 处理连接断开/错误，决定是否重连。
   *
   * 流程：
   * 1. bridge 模式下上报 tengu_ws_transport_closed 遥测事件，
   *    包含关闭码、上次数据帧活动距今时长、是否处于已连接状态等信息。
   * 2. 调用 doDisconnect() 清理 WS 和定时器。
   * 3. 若当前已处于 closing/closed 状态则直接返回。
   * 4. 若为永久关闭码（且未通过 4003 token 刷新获豁免），转为 closed 并触发 onClose。
   * 5. 若 autoReconnect=false，转为 closed 并触发 onClose。
   * 6. 否则计算指数退避延迟（含 ±25% 抖动），检测系统睡眠后重置预算，
   *    若未超时间预算则调度重连定时器；超预算则转为 closed。
   */
  private handleConnectionError(closeCode?: number): void {
    logForDebugging(
      `WebSocketTransport: Disconnected from ${this.url.href}` +
        (closeCode != null ? ` (code ${closeCode})` : ''),
    )
    logForDiagnosticsNoPII('info', 'cli_websocket_disconnected')
    if (this.isBridge) {
      // 每次关闭都上报——包括重连风暴中的中间关闭（不会触发 onCloseCallback）。
      // 针对 Cloudflare 5min 空闲超时假说：若 msSinceLastActivity 峰值约 300s
      // 且 closeCode 为 1006，则可确认是代理 RST。
      logEvent('tengu_ws_transport_closed', {
        closeCode,
        msSinceLastActivity:
          this.lastActivityTime > 0 ? Date.now() - this.lastActivityTime : -1,
        // 'connected' = 正常连接后断开（Cloudflare 情况）；'reconnecting' = 重连途中被拒绝。
        // 此处读取断开前的状态值（下方分支才会修改状态）。
        wasConnected: this.state === 'connected',
        reconnectAttempts: this.reconnectAttempts,
      })
    }
    this.doDisconnect()

    if (this.state === 'closing' || this.state === 'closed') return

    // 永久关闭码：服务端已明确结束会话，不重试。
    // 例外：4003（未授权）在 refreshHeaders 返回新 token 时允许重试一次
    // （如父进程在重连时签发了新的 session ingress token）。
    let headersRefreshed = false
    if (closeCode === 4003 && this.refreshHeaders) {
      const freshHeaders = this.refreshHeaders()
      if (freshHeaders.Authorization !== this.headers.Authorization) {
        Object.assign(this.headers, freshHeaders)
        headersRefreshed = true
        logForDebugging(
          'WebSocketTransport: 4003 received but headers refreshed, scheduling reconnect',
        )
        logForDiagnosticsNoPII('info', 'cli_websocket_4003_token_refreshed')
      }
    }

    if (
      closeCode != null &&
      PERMANENT_CLOSE_CODES.has(closeCode) &&
      !headersRefreshed
    ) {
      logForDebugging(
        `WebSocketTransport: Permanent close code ${closeCode}, not reconnecting`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_websocket_permanent_close', {
        closeCode,
      })
      this.state = 'closed'
      this.onCloseCallback?.(closeCode)
      return
    }

    // autoReconnect=false 时不重连——调用方（如 REPL bridge 轮询循环）自行处理恢复。
    if (!this.autoReconnect) {
      this.state = 'closed'
      this.onCloseCallback?.(closeCode)
      return
    }

    // 计算指数退避延迟并调度重连定时器
    const now = Date.now()
    if (!this.reconnectStartTime) {
      this.reconnectStartTime = now
    }

    // 检测系统睡眠/唤醒：若上次重连尝试距今远超最大延迟，
    // 说明机器曾被挂起（如笔记本合盖）。重置预算重新尝试——
    // 若会话在睡眠期间被回收，服务端会以永久关闭码（4001/1002）拒绝。
    if (
      this.lastReconnectAttemptTime !== null &&
      now - this.lastReconnectAttemptTime > SLEEP_DETECTION_THRESHOLD_MS
    ) {
      logForDebugging(
        `WebSocketTransport: Detected system sleep (${Math.round((now - this.lastReconnectAttemptTime) / 1000)}s gap), resetting reconnection budget`,
      )
      logForDiagnosticsNoPII('info', 'cli_websocket_sleep_detected', {
        gapMs: now - this.lastReconnectAttemptTime,
      })
      this.reconnectStartTime = now
      this.reconnectAttempts = 0
    }
    this.lastReconnectAttemptTime = now

    const elapsed = now - this.reconnectStartTime
    if (elapsed < DEFAULT_RECONNECT_GIVE_UP_MS) {
      // 清除已有重连定时器，防止重复调度
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }

      // 重连前刷新请求头（如获取新的 session ingress token）。
      // 若已在 4003 路径中刷新过则跳过，避免重复调用。
      if (!headersRefreshed && this.refreshHeaders) {
        const freshHeaders = this.refreshHeaders()
        Object.assign(this.headers, freshHeaders)
        logForDebugging('WebSocketTransport: Refreshed headers for reconnect')
      }

      this.state = 'reconnecting'
      this.reconnectAttempts++

      const baseDelay = Math.min(
        DEFAULT_BASE_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1),
        DEFAULT_MAX_RECONNECT_DELAY,
      )
      // 加 ±25% 抖动，防止多客户端同时断连后形成"惊群效应"（thundering herd）
      const delay = Math.max(
        0,
        baseDelay + baseDelay * 0.25 * (2 * Math.random() - 1),
      )

      logForDebugging(
        `WebSocketTransport: Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}, ${Math.round(elapsed / 1000)}s elapsed)`,
      )
      logForDiagnosticsNoPII('error', 'cli_websocket_reconnect_attempt', {
        reconnectAttempts: this.reconnectAttempts,
      })
      if (this.isBridge) {
        logEvent('tengu_ws_transport_reconnecting', {
          attempt: this.reconnectAttempts,
          elapsedMs: elapsed,
          delayMs: Math.round(delay),
        })
      }

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null
        void this.connect()
      }, delay)
    } else {
      logForDebugging(
        `WebSocketTransport: Reconnection time budget exhausted after ${Math.round(elapsed / 1000)}s for ${this.url.href}`,
        { level: 'error' },
      )
      logForDiagnosticsNoPII('error', 'cli_websocket_reconnect_exhausted', {
        reconnectAttempts: this.reconnectAttempts,
        elapsedMs: elapsed,
      })
      this.state = 'closed'

      // Notify close callback
      if (this.onCloseCallback) {
        this.onCloseCallback(closeCode)
      }
    }
  }

  /**
   * 优雅关闭传输层。
   * 清除重连定时器，停止所有定时器，注销 sessionActivity 回调，
   * 然后调用 doDisconnect() 关闭 WebSocket 连接并移除监听器。
   */
  close(): void {
    // 清除待触发的重连定时器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    // 停止 ping 和 keep-alive 定时器
    this.stopPingInterval()
    this.stopKeepaliveInterval()

    // 注销 sessionActivity 回调
    unregisterSessionActivityCallback()

    this.state = 'closing'
    this.doDisconnect()
  }

  /**
   * 重放缓冲区中未被服务端确认的消息。
   *
   * @param lastId 服务端在升级响应头中确认的最后 UUID。
   *   - 非空：找到该 UUID 对应消息，将其及之前的消息从缓冲区中清除，
   *     仅重放其后的未确认消息。
   *   - 空字符串（Bun 路径）：重放缓冲区全部消息，服务端通过 UUID 去重。
   *
   * 注意：重放后不清空缓冲区——消息保留至下次重连时服务端再次确认，
   * 防止重放后连接再次断开导致消息丢失。
   */
  private replayBufferedMessages(lastId: string): void {
    const messages = this.messageBuffer.toArray()
    if (messages.length === 0) return

    // 根据服务端确认 ID 定位起始重放位置
    let startIndex = 0
    if (lastId) {
      const lastConfirmedIndex = messages.findIndex(
        message => 'uuid' in message && message.uuid === lastId,
      )
      if (lastConfirmedIndex >= 0) {
        // 服务端已确认 lastConfirmedIndex 及之前的消息——从缓冲区中清除
        startIndex = lastConfirmedIndex + 1
        // 重建缓冲区，只保留未确认的消息
        const remaining = messages.slice(startIndex)
        this.messageBuffer.clear()
        this.messageBuffer.addAll(remaining)
        if (remaining.length === 0) {
          this.lastSentId = null
        }
        logForDebugging(
          `WebSocketTransport: Evicted ${startIndex} confirmed messages, ${remaining.length} remaining`,
        )
        logForDiagnosticsNoPII(
          'info',
          'cli_websocket_evicted_confirmed_messages',
          {
            evicted: startIndex,
            remaining: remaining.length,
          },
        )
      }
    }

    const messagesToReplay = messages.slice(startIndex)
    if (messagesToReplay.length === 0) {
      logForDebugging('WebSocketTransport: No new messages to replay')
      logForDiagnosticsNoPII('info', 'cli_websocket_no_messages_to_replay')
      return
    }

    logForDebugging(
      `WebSocketTransport: Replaying ${messagesToReplay.length} buffered messages`,
    )
    logForDiagnosticsNoPII('info', 'cli_websocket_messages_to_replay', {
      count: messagesToReplay.length,
    })

    for (const message of messagesToReplay) {
      const line = jsonStringify(message) + '\n'
      const success = this.sendLine(line)
      if (!success) {
        this.handleConnectionError()
        break
      }
    }
    // 重放后保留缓冲区——等到服务端在下次重连时再次确认后才清除。
    // 这样即使重放后连接再次断开，也不会导致消息丢失。
  }

  /** 当前是否处于已连接状态 */
  isConnectedStatus(): boolean {
    return this.state === 'connected'
  }

  /** 当前是否处于已关闭状态 */
  isClosedStatus(): boolean {
    return this.state === 'closed'
  }

  /** 注册数据接收回调（每条入站 NDJSON 消息均触发） */
  setOnData(callback: (data: string) => void): void {
    this.onData = callback
  }

  /** 注册连接建立回调 */
  setOnConnect(callback: () => void): void {
    this.onConnectCallback = callback
  }

  /** 注册连接关闭回调（可携带关闭码） */
  setOnClose(callback: (closeCode?: number) => void): void {
    this.onCloseCallback = callback
  }

  /** 返回当前状态标签（用于日志和调试） */
  getStateLabel(): string {
    return this.state
  }

  /**
   * 将消息发送到 WebSocket。
   *
   * 若消息包含 UUID，先将其加入消息缓冲区并更新 lastSentId（用于重连重放）。
   * 若当前未连接，消息仅缓冲（有 UUID 时）或静默丢弃，等待重连后重放。
   * 若已连接，序列化为 NDJSON 后调用 sendLine() 发送。
   */
  async write(message: StdoutMessage): Promise<void> {
    if ('uuid' in message && typeof message.uuid === 'string') {
      this.messageBuffer.add(message)
      this.lastSentId = message.uuid
    }

    const line = jsonStringify(message) + '\n'

    if (this.state !== 'connected') {
      // 消息已入缓冲区（若有 UUID），待重连后重放；无 UUID 的消息静默丢弃
      return
    }

    const sessionLabel = this.sessionId ? ` session=${this.sessionId}` : ''
    const detailLabel = this.getControlMessageDetailLabel(message)

    logForDebugging(
      `WebSocketTransport: Sending message type=${message.type}${sessionLabel}${detailLabel}`,
    )

    this.sendLine(line)
  }

  /**
   * 为 control_request/control_response 类型消息生成详细日志标签。
   * 其他消息类型返回空字符串。
   */
  private getControlMessageDetailLabel(message: StdoutMessage): string {
    if (message.type === 'control_request') {
      const { request_id, request } = message
      const toolName =
        request.subtype === 'can_use_tool' ? request.tool_name : ''
      return ` subtype=${request.subtype} request_id=${request_id}${toolName ? ` tool=${toolName}` : ''}`
    }
    if (message.type === 'control_response') {
      const { subtype, request_id } = message.response
      return ` subtype=${subtype} request_id=${request_id}`
    }
    return ''
  }

  /**
   * 启动 ping 健康检测定时器（每 10s 发送一次 ping 控制帧）。
   *
   * 同时包含进程挂起检测：
   * 若定时器两次触发间隔超过 SLEEP_DETECTION_THRESHOLD_MS（60s），
   * 说明进程曾被挂起（SIGSTOP/VM 暂停/笔记本合盖）——
   * 此时 socket 几乎可以确定已死亡（NAT 映射通常在 30s~5min 后失效），
   * 无需等待 ping/pong 往返确认，直接强制重连。
   */
  private startPingInterval(): void {
    // 清除已有定时器
    this.stopPingInterval()

    this.pongReceived = true
    let lastTickTime = Date.now()

    // 定期发送 ping 以检测死连接。
    // 若上次 ping 未收到 pong，判定连接死亡并触发重连。
    this.pingInterval = setInterval(() => {
      if (this.state === 'connected' && this.ws) {
        const now = Date.now()
        const gap = now - lastTickTime
        lastTickTime = now

        // 进程挂起检测：若两次 tick 间隔远超 10s 定时器，进程曾被挂起。
        // setInterval 不会积累漏掉的 tick——唤醒后只触发一次，间隔很大。
        // socket 几乎可以确定已死亡：NAT 映射在 30s~5min 内失效，
        // 服务端一直在向无效连接重传。无需等 ping/pong 确认，立即重连。
        // 短暂睡眠后的误重连代价很低——replayBufferedMessages() 会处理，
        // 服务端通过 UUID 去重。
        if (gap > SLEEP_DETECTION_THRESHOLD_MS) {
          logForDebugging(
            `WebSocketTransport: ${Math.round(gap / 1000)}s tick gap detected — process was suspended, forcing reconnect`,
          )
          logForDiagnosticsNoPII(
            'info',
            'cli_websocket_sleep_detected_on_ping',
            { gapMs: gap },
          )
          this.handleConnectionError()
          return
        }

        if (!this.pongReceived) {
          logForDebugging(
            'WebSocketTransport: No pong received, connection appears dead',
            { level: 'error' },
          )
          logForDiagnosticsNoPII('error', 'cli_websocket_pong_timeout')
          this.handleConnectionError()
          return
        }

        this.pongReceived = false
        try {
          this.ws.ping?.()
        } catch (error) {
          logForDebugging(`WebSocketTransport: Ping failed: ${error}`, {
            level: 'error',
          })
          logForDiagnosticsNoPII('error', 'cli_websocket_ping_failed')
        }
      }
    }, DEFAULT_PING_INTERVAL)
  }

  /** 停止 ping 健康检测定时器 */
  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  /**
   * 启动 keep-alive 数据帧定时器（每 5 分钟发送一次 keep_alive 帧）。
   * CCR 远程会话通过 sessionActivity 心跳机制代替，不需要此定时器。
   */
  private startKeepaliveInterval(): void {
    this.stopKeepaliveInterval()

    // CCR 会话（CLAUDE_CODE_REMOTE=true）使用 sessionActivity 心跳，不启用此定时器
    if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
      return
    }

    this.keepAliveInterval = setInterval(() => {
      if (this.state === 'connected' && this.ws) {
        try {
          this.ws.send(KEEP_ALIVE_FRAME)
          this.lastActivityTime = Date.now()
          logForDebugging(
            'WebSocketTransport: Sent periodic keep_alive data frame',
          )
        } catch (error) {
          logForDebugging(
            `WebSocketTransport: Periodic keep_alive failed: ${error}`,
            { level: 'error' },
          )
          logForDiagnosticsNoPII('error', 'cli_websocket_keepalive_failed')
        }
      }
    }, DEFAULT_KEEPALIVE_INTERVAL)
  }

  /** 停止 keep-alive 数据帧定时器 */
  private stopKeepaliveInterval(): void {
    if (this.keepAliveInterval) {
      clearInterval(this.keepAliveInterval)
      this.keepAliveInterval = null
    }
  }
}
