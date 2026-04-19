/* eslint-disable eslint-plugin-n/no-unsupported-features/node-builtins */
/**
 * CONNECT-over-WebSocket relay for CCR upstreamproxy.
 *
 * Listens on localhost TCP, accepts HTTP CONNECT from curl/gh/kubectl/etc,
 * and tunnels bytes over WebSocket to the CCR upstreamproxy endpoint.
 * The CCR server-side terminates the tunnel, MITMs TLS, injects org-configured
 * credentials (e.g. DD-API-KEY), and forwards to the real upstream.
 *
 * WHY WebSocket and not raw CONNECT: CCR ingress is GKE L7 with path-prefix
 * routing; there's no connect_matcher in cdk-constructs. The session-ingress
 * tunnel (sessions/tunnel/v1alpha/tunnel.proto) already uses this pattern.
 *
 * Protocol: bytes are wrapped in UpstreamProxyChunk protobuf messages
 * (`message UpstreamProxyChunk { bytes data = 1; }`) for compatibility with
 * gateway.NewWebSocketStreamAdapter on the server side.
 */

/**
 * 【模块概述】CCR 上行代理的 CONNECT-over-WebSocket 本地中继。
 *
 * 在 Claude Code 远程运行（CCR）系统中，本模块处于"本地代理层"：
 *
 *   curl/gh/python（子进程）
 *       │  HTTP CONNECT（HTTPS_PROXY=http://127.0.0.1:PORT）
 *       ▼
 *   本地 TCP 服务器（本模块）
 *       │  二进制 WebSocket（UpstreamProxyChunk protobuf 帧）
 *       ▼
 *   CCR 服务端 upstreamproxy WS 端点
 *       │  MITM TLS 终止 + 凭据注入 + 明文转发
 *       ▼
 *   真实上游服务（如 Datadog API、内部服务等）
 *
 * 采用 WebSocket 而非直接 CONNECT 的原因：CCR 的 GKE L7 Ingress 使用路径前缀
 * 路由，cdk-constructs 中没有 connect_matcher，因此无法透传原始 CONNECT。
 *
 * 数据帧格式：所有字节包裹在手工编码的 UpstreamProxyChunk protobuf 消息中
 * （field 1, wire type 2：tag=0x0a + varint 长度 + 数据），与服务端的
 * gateway.NewWebSocketStreamAdapter 兼容。
 */

import { createServer, type Socket as NodeSocket } from 'node:net'
import { logForDebugging } from '../utils/debug.js'
import { getWebSocketTLSOptions } from '../utils/mtls.js'
import { getWebSocketProxyAgent, getWebSocketProxyUrl } from '../utils/proxy.js'

// The CCR container runs behind an egress gateway — direct outbound is
// blocked, so the WS upgrade must go through the same HTTP CONNECT proxy
// everything else uses. undici's globalThis.WebSocket does not consult
// the global dispatcher for the upgrade, so under Node we use the ws package
// with an explicit agent (same pattern as SessionsWebSocket). Bun's native
// WebSocket takes a proxy URL directly. Preloaded in startNodeRelay so
// openTunnel stays synchronous and the CONNECT state machine doesn't race.
// CCR 容器出站被 egress 网关拦截，WS 握手必须经过 HTTP CONNECT 代理。
// Node.js 下 undici 的 globalThis.WebSocket 不走全局 dispatcher，
// 故使用 ws 包并传入显式代理 agent；Bun 原生 WebSocket 直接接受 proxy URL。
// 在 startNodeRelay 中预先加载 ws 模块，确保 openTunnel 保持同步、
// 不与 CONNECT 状态机产生竞争条件。
type WSCtor = typeof import('ws').default
let nodeWSCtor: WSCtor | undefined

// Intersection of the surface openTunnel touches. Both undici's
// globalThis.WebSocket and the ws package satisfy this via property-style
// onX handlers.
// 最小化 WebSocket 接口抽象：仅包含 openTunnel 函数实际使用到的属性，
// 使得 undici 的 globalThis.WebSocket 和 ws 包均可满足此接口
type WebSocketLike = Pick<
  WebSocket,
  | 'onopen'
  | 'onmessage'
  | 'onerror'
  | 'onclose'
  | 'send'
  | 'close'
  | 'readyState'
  | 'binaryType'
>

// Envoy per-request buffer cap. Week-1 Datadog payloads won't hit this, but
// design for it so git-push doesn't need a relay rewrite.
// Envoy 单请求缓冲上限 512 KB；分块发送防止超出服务端限制
const MAX_CHUNK_BYTES = 512 * 1024

// Sidecar idle timeout is 50s; ping well inside that.
// Sidecar 空闲超时 50 秒，每 30 秒发一次应用层 keepalive 空块，保持连接活跃
const PING_INTERVAL_MS = 30_000

/**
 * Encode an UpstreamProxyChunk protobuf message by hand.
 *
 * For `message UpstreamProxyChunk { bytes data = 1; }` the wire format is:
 *   tag = (field_number << 3) | wire_type = (1 << 3) | 2 = 0x0a
 *   followed by varint length, followed by the bytes.
 *
 * protobufjs would be the general answer; for a single-field bytes message
 * the hand encoding is 10 lines and avoids a runtime dep in the hot path.
 */
/**
 * 手工编码 UpstreamProxyChunk protobuf 消息。
 *
 * 编码格式（单字段 bytes message）：
 *   [0x0a] [varint(len)] [data bytes...]
 *   其中 0x0a = (field_number=1 << 3) | wire_type=2（length-delimited）
 *
 * 避免引入 protobufjs 运行时依赖，单字段 bytes 消息手工实现只需约 10 行，
 * 在热路径（每次转发都调用）上性能更好。
 *
 * @param data - 待封装的原始字节数组
 * @returns 包含 protobuf 头部的完整帧字节
 */
export function encodeChunk(data: Uint8Array): Uint8Array {
  const len = data.length
  // varint encoding of length — most chunks fit in 1–3 length bytes
  // 将长度编码为 protobuf varint：每字节低 7 位存数据，最高位为"还有更多字节"标志
  const varint: number[] = []
  let n = len
  while (n > 0x7f) {
    varint.push((n & 0x7f) | 0x80)   // 低 7 位 | 0x80（表示后续还有字节）
    n >>>= 7                           // 无符号右移 7 位，处理下一组 7 位
  }
  varint.push(n)                       // 最后一组 7 位，最高位为 0 表示结束
  // 整体帧：1 字节 tag + varint 长度字节 + 数据字节
  const out = new Uint8Array(1 + varint.length + len)
  out[0] = 0x0a                        // protobuf field 1, wire type 2（bytes）
  out.set(varint, 1)                   // 写入 varint 编码的长度
  out.set(data, 1 + varint.length)     // 写入实际数据
  return out
}

/**
 * Decode an UpstreamProxyChunk. Returns the data field, or null if malformed.
 * Tolerates the server sending a zero-length chunk (keepalive semantics).
 */
/**
 * 解码来自服务端的 UpstreamProxyChunk protobuf 消息。
 *
 * 解析步骤：
 *   1. 空 buffer → 返回空 Uint8Array（服务端发送的 keepalive 空块）
 *   2. 检查首字节是否为 0x0a（field 1, wire type 2），否则返回 null（格式错误）
 *   3. 解析 varint 编码的长度，varint 超过 28 位时视为格式错误
 *   4. 截取对应长度的 data 子数组返回
 *
 * @param buf - 从 WebSocket message 事件接收到的原始字节
 * @returns 解码后的原始数据字节，或 null（格式非法）
 */
export function decodeChunk(buf: Uint8Array): Uint8Array | null {
  if (buf.length === 0) return new Uint8Array(0)   // 空帧：服务端 keepalive
  if (buf[0] !== 0x0a) return null                 // 首字节必须是 protobuf tag 0x0a
  let len = 0
  let shift = 0
  let i = 1
  while (i < buf.length) {
    const b = buf[i]!
    len |= (b & 0x7f) << shift    // 取低 7 位，左移 shift 位后累加到 len
    i++
    if ((b & 0x80) === 0) break   // 最高位为 0 表示 varint 结束
    shift += 7
    if (shift > 28) return null   // varint 超过 4 字节（28 位），视为格式错误
  }
  if (i + len > buf.length) return null   // 声明长度超出实际 buffer，格式错误
  return buf.subarray(i, i + len)         // 返回数据字节的视图（zero-copy）
}

// 对外暴露的中继实例类型：包含监听端口号和停止函数
export type UpstreamProxyRelay = {
  port: number
  stop: () => void
}

// 每个客户端连接的状态对象，贯穿 CONNECT 握手和 WS 隧道两个阶段
type ConnState = {
  ws?: WebSocketLike
  connectBuf: Buffer                     // 阶段一：累积接收到的 HTTP CONNECT 请求头字节
  pinger?: ReturnType<typeof setInterval> // keepalive 定时器句柄
  // Bytes that arrived after the CONNECT header but before ws.onopen fired.
  // TCP can coalesce CONNECT + ClientHello into one packet, and the socket's
  // data callback can fire again while the WS handshake is still in flight.
  // Both cases would silently drop bytes without this buffer.
  // WS 握手期间到达的数据暂存在此，等 onopen 触发后统一冲刷
  pending: Buffer[]
  wsOpen: boolean     // WS 连接是否已就绪（onopen 已触发）
  // Set once the server's 200 Connection Established has been forwarded and
  // the tunnel is carrying TLS. After that, writing a plaintext 502 would
  // corrupt the client's TLS stream — just close instead.
  // 服务端返回 200 后隧道进入 TLS 阶段，此后不能再写明文 HTTP 响应
  established: boolean
  // WS onerror is always followed by onclose; without a guard the second
  // handler would sock.end() an already-ended socket. First caller wins.
  // onerror 之后必有 onclose，用此标志防止 sock.end() 被调用两次
  closed: boolean
}

/**
 * Minimal socket abstraction so the CONNECT parser and WS tunnel plumbing
 * are runtime-agnostic. Implementations handle write backpressure internally:
 * Bun's sock.write() does partial writes and needs explicit tail-queueing;
 * Node's net.Socket buffers unconditionally and never drops bytes.
 */
/**
 * 最小化客户端 Socket 抽象接口，屏蔽 Bun 和 Node.js 的写入差异。
 *
 * Bun 的 sock.write() 可能发生部分写入（返回实际写入字节数），
 * 未写完的尾部需要由调用方显式排队等 drain 事件冲刷。
 * Node.js 的 net.Socket.write() 内部无限缓冲，不会丢弃字节，
 * 返回 false 仅表示背压，不影响数据完整性。
 */
type ClientSocket = {
  write: (data: Uint8Array | string) => void
  end: () => void
}

/**
 * 创建新的连接状态对象，所有字段初始化为"未连接"状态。
 * 每个新 TCP 客户端连接时调用一次，状态随连接生命周期存在。
 */
function newConnState(): ConnState {
  return {
    connectBuf: Buffer.alloc(0),   // 初始为空 buffer，等待接收 CONNECT 请求头
    pending: [],                   // WS 握手期间收到的数据队列
    wsOpen: false,                 // WS 尚未就绪
    established: false,            // 隧道尚未建立（服务端 200 尚未转发给客户端）
    closed: false,                 // 连接尚未关闭
  }
}

/**
 * Start the relay. Returns the ephemeral port it bound and a stop function.
 * Uses Bun.listen when available, otherwise Node's net.createServer — the CCR
 * container runs the CLI under Node, not Bun.
 */
/**
 * 启动本地 CONNECT→WebSocket 中继服务，返回监听端口和停止函数。
 *
 * 运行时分派策略：
 *   - Bun 环境（typeof Bun !== 'undefined'）→ 调用 startBunRelay()
 *     使用 Bun.listen 高性能原生 TCP API，需手动处理写入背压
 *   - Node.js 环境（CCR 容器实际运行环境）→ 调用 startNodeRelay()
 *     使用 node:net createServer，写入自动缓冲无需背压处理
 *
 * @param opts.wsUrl      CCR upstreamproxy WebSocket 端点 URL
 * @param opts.sessionId  会话 ID（用于构建 Basic Auth 头）
 * @param opts.token      会话令牌（用于构建 Bearer Token 和 Basic Auth 头）
 */
export async function startUpstreamProxyRelay(opts: {
  wsUrl: string
  sessionId: string
  token: string
}): Promise<UpstreamProxyRelay> {
  // Basic Auth 格式：Base64("sessionId:token")，用于隧道内的 Proxy-Authorization 头
  const authHeader =
    'Basic ' + Buffer.from(`${opts.sessionId}:${opts.token}`).toString('base64')
  // WS upgrade itself is auth-gated (proto authn: PRIVATE_API) — the gateway
  // wants the session-ingress JWT on the upgrade request, separate from the
  // Proxy-Authorization that rides inside the tunneled CONNECT.
  // WS 升级请求本身也需要认证（PRIVATE_API 协议），使用 Bearer Token
  // 与隧道内的 Proxy-Authorization（Basic Auth）是两个不同层次的认证
  const wsAuthHeader = `Bearer ${opts.token}`

  // 根据运行时选择 Bun 或 Node.js 实现；Bun 为同步，Node.js 为异步（需等待 listen）
  const relay =
    typeof Bun !== 'undefined'
      ? startBunRelay(opts.wsUrl, authHeader, wsAuthHeader)
      : await startNodeRelay(opts.wsUrl, authHeader, wsAuthHeader)

  logForDebugging(`[upstreamproxy] relay listening on 127.0.0.1:${relay.port}`)
  return relay
}

/**
 * 使用 Bun.listen 启动本地 TCP 中继服务（Bun 运行时专用）。
 *
 * Bun TCP socket 的写入行为与 Node.js 不同：sock.write() 返回实际写入的字节数，
 * 未写完的部分会被静默丢弃。为此维护每连接的 writeBuf 写队列：
 *   - write() 时如果队列非空或 sock.write() 返回部分写入，将剩余字节入队
 *   - drain() 时逐块冲刷队列，直到内核缓冲区再次满为止
 *
 * 端口 0 让 OS 自动分配空闲端口，server.port 获取实际分配的端口号。
 */
function startBunRelay(
  wsUrl: string,
  authHeader: string,
  wsAuthHeader: string,
): UpstreamProxyRelay {
  // Bun TCP sockets don't auto-buffer partial writes: sock.write() returns
  // the byte count actually handed to the kernel, and the remainder is
  // silently dropped. When the kernel buffer fills, we queue the tail and
  // let the drain handler flush it. Per-socket because the adapter closure
  // outlives individual handler calls.
  // Bun 不自动缓冲：sock.write() 可能部分写入，未写完部分需入队等待 drain
  type BunState = ConnState & { writeBuf: Uint8Array[] }

  // eslint-disable-next-line custom-rules/require-bun-typeof-guard -- caller dispatches on typeof Bun
  const server = Bun.listen<BunState>({
    hostname: '127.0.0.1',  // 仅绑定回环地址，外部无法访问
    port: 0,                // 0 = 让 OS 分配空闲端口
    socket: {
      open(sock) {
        // 新连接建立时初始化状态（包含 Bun 专用的 writeBuf 写队列）
        sock.data = { ...newConnState(), writeBuf: [] }
      },
      data(sock, data) {
        const st = sock.data
        // 构造运行时无关的 ClientSocket 适配器，实现 Bun 的背压写入逻辑
        const adapter: ClientSocket = {
          write: payload => {
            const bytes =
              typeof payload === 'string'
                ? Buffer.from(payload, 'utf8')
                : payload
            // 如果写队列非空，说明内核缓冲已满，直接入队等待 drain
            if (st.writeBuf.length > 0) {
              st.writeBuf.push(bytes)
              return
            }
            const n = sock.write(bytes)
            // 如果实际写入字节数小于请求数，将剩余字节存入队列
            if (n < bytes.length) st.writeBuf.push(bytes.subarray(n))
          },
          end: () => sock.end(),
        }
        // 交给共享的 handleData 处理 CONNECT 解析和数据转发
        handleData(adapter, st, data, wsUrl, authHeader, wsAuthHeader)
      },
      drain(sock) {
        // 内核缓冲可用时逐块冲刷写队列
        const st = sock.data
        while (st.writeBuf.length > 0) {
          const chunk = st.writeBuf[0]!
          const n = sock.write(chunk)
          if (n < chunk.length) {
            // 再次发生部分写入，更新队列首块的起始偏移，等待下次 drain
            st.writeBuf[0] = chunk.subarray(n)
            return
          }
          st.writeBuf.shift()   // 整块写完，移出队列
        }
      },
      close(sock) {
        cleanupConn(sock.data)   // 清理 WS 连接和 keepalive 定时器
      },
      error(sock, err) {
        logForDebugging(`[upstreamproxy] client socket error: ${err.message}`)
        cleanupConn(sock.data)
      },
    },
  })

  return {
    port: server.port,            // OS 分配的实际监听端口
    stop: () => server.stop(true), // true = 强制关闭所有现有连接
  }
}

// Exported so tests can exercise the Node path directly — the test runner is
// Bun, so the runtime dispatch in startUpstreamProxyRelay always picks Bun.
/**
 * 使用 Node.js net.createServer 启动本地 TCP 中继（Node.js 运行时，CCR 容器实际使用）。
 *
 * 与 Bun 实现的关键差异：
 *   - Node.js 的 sock.write() 内部无限缓冲，返回 false 只是背压信号，字节不会丢失，
 *     因此无需维护写队列
 *   - 需要 await import('ws') 预加载 ws 包（异步），确保 openTunnel 后续调用同步进行
 *   - 使用 WeakMap<NodeSocket, ConnState> 在事件回调中关联连接状态
 *   - listen(0, '127.0.0.1') + Promise 包装获取实际分配的端口号
 *
 * 导出为 export（而非仅模块内使用）以允许测试直接测试 Node.js 路径，
 * 因为测试运行器是 Bun，startUpstreamProxyRelay() 的运行时分派会选 Bun 路径。
 */
export async function startNodeRelay(
  wsUrl: string,
  authHeader: string,
  wsAuthHeader: string,
): Promise<UpstreamProxyRelay> {
  // 预加载 ws 包（动态 import），此后 openTunnel 可同步使用 nodeWSCtor
  nodeWSCtor = (await import('ws')).default
  // 用 WeakMap 将 ConnState 与 NodeSocket 关联，避免给 Socket 添加自定义属性
  const states = new WeakMap<NodeSocket, ConnState>()

  const server = createServer(sock => {
    const st = newConnState()
    states.set(sock, st)
    // Node's sock.write() buffers internally — a false return signals
    // backpressure but the bytes are already queued, so no tail-tracking
    // needed for correctness. Week-1 payloads won't stress the buffer.
    // Node.js 内部自动缓冲，write() 无需跟踪部分写入
    const adapter: ClientSocket = {
      write: payload => {
        sock.write(typeof payload === 'string' ? payload : Buffer.from(payload))
      },
      end: () => sock.end(),
    }
    // 注册数据事件，转发给共享的 handleData 处理器
    sock.on('data', data =>
      handleData(adapter, st, data, wsUrl, authHeader, wsAuthHeader),
    )
    sock.on('close', () => cleanupConn(states.get(sock)))
    sock.on('error', err => {
      logForDebugging(`[upstreamproxy] client socket error: ${err.message}`)
      cleanupConn(states.get(sock))
    })
  })

  // 用 Promise 封装异步 listen 过程，待绑定成功后 resolve 实际端口号
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      // address() 在 TCP 服务器上应返回对象；null 或字符串表示异常情况
      if (addr === null || typeof addr === 'string') {
        reject(new Error('upstreamproxy: server has no TCP address'))
        return
      }
      resolve({
        port: addr.port,              // OS 分配的实际监听端口
        stop: () => server.close(),   // 停止接受新连接（已建立的连接不受影响）
      })
    })
  })
}

/**
 * Shared per-connection data handler. Phase 1 accumulates the CONNECT request;
 * phase 2 forwards client bytes over the WS tunnel.
 */
/**
 * 共享的每连接数据处理器，处理两个阶段的数据：
 *
 * 阶段一（st.ws 未设置）：HTTP CONNECT 请求解析
 *   - 持续累积数据直到检测到 CRLF CRLF（请求头结束标志）
 *   - 缓冲超过 8192 字节仍未找到头结束符 → 返回 400 Bad Request，关闭连接
 *   - 解析第一行，验证格式为 "CONNECT host:port HTTP/1.x"
 *   - 非 CONNECT 方法 → 返回 405 Method Not Allowed
 *   - 将 CONNECT 头之后的剩余字节存入 st.pending，等 WS 就绪后冲刷
 *   - 调用 openTunnel() 建立 WS 隧道
 *
 * 阶段二（st.ws 已设置）：字节转发
 *   - WS 未就绪（onopen 未触发）→ 数据入 st.pending 暂存
 *   - WS 就绪 → 调用 forwardToWs() 分块发送
 */
function handleData(
  sock: ClientSocket,
  st: ConnState,
  data: Buffer,
  wsUrl: string,
  authHeader: string,
  wsAuthHeader: string,
): void {
  // Phase 1: accumulate until we've seen the full CONNECT request
  // (terminated by CRLF CRLF). curl/gh send this in one packet, but
  // don't assume that.
  // 阶段一：持续累积字节直到找到 CONNECT 请求头的结束标志 "\r\n\r\n"
  if (!st.ws) {
    st.connectBuf = Buffer.concat([st.connectBuf, data])
    const headerEnd = st.connectBuf.indexOf('\r\n\r\n')
    if (headerEnd === -1) {
      // Guard against a client that never sends CRLFCRLF.
      // 防止客户端发送超长或格式异常的头部（上限 8192 字节）
      if (st.connectBuf.length > 8192) {
        sock.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        sock.end()
      }
      return
    }
    // 提取请求头文本，取第一行验证是否为 CONNECT 请求
    const reqHead = st.connectBuf.subarray(0, headerEnd).toString('utf8')
    const firstLine = reqHead.split('\r\n')[0] ?? ''
    // 匹配 "CONNECT host:port HTTP/1.0" 或 "CONNECT host:port HTTP/1.1"
    const m = firstLine.match(/^CONNECT\s+(\S+)\s+HTTP\/1\.[01]$/i)
    if (!m) {
      sock.write('HTTP/1.1 405 Method Not Allowed\r\n\r\n')
      sock.end()
      return
    }
    // Stash any bytes that arrived after the CONNECT header so
    // openTunnel can flush them once the WS is open.
    // TCP 可能将 CONNECT 请求和 TLS ClientHello 合并成一个 packet，
    // 将头部之后的尾部字节暂存，待 WS 就绪后统一冲刷
    const trailing = st.connectBuf.subarray(headerEnd + 4)
    if (trailing.length > 0) {
      st.pending.push(Buffer.from(trailing))
    }
    st.connectBuf = Buffer.alloc(0)  // 清空累积 buffer，释放内存
    openTunnel(sock, st, firstLine, wsUrl, authHeader, wsAuthHeader)
    return
  }
  // Phase 2: WS exists. If it isn't OPEN yet, buffer; ws.onopen will
  // flush. Once open, pump client bytes to WS in chunks.
  // 阶段二：WS 未就绪则入队暂存，就绪后直接转发
  if (!st.wsOpen) {
    st.pending.push(Buffer.from(data))
    return
  }
  forwardToWs(st.ws, data)
}

/**
 * 建立 WebSocket 隧道，绑定 WS 事件处理器，实现双向字节转发。
 *
 * 执行流程：
 *   1. 构造 WS 连接（Node 使用 ws 包 + 代理 agent；Bun 使用原生 WebSocket + proxy URL）
 *   2. onopen：发送包含 CONNECT 行和 Proxy-Authorization 的第一个帧，
 *      随后冲刷 st.pending 中暂存的字节，启动 keepalive 定时器
 *   3. onmessage：解码 protobuf 帧，将解码后的字节写回客户端 TCP 连接
 *   4. onerror：记录日志，若隧道尚未建立则向客户端发送 502，关闭连接
 *   5. onclose：关闭客户端连接，清理资源
 */
function openTunnel(
  sock: ClientSocket,
  st: ConnState,
  connectLine: string,
  wsUrl: string,
  authHeader: string,
  wsAuthHeader: string,
): void {
  // core/websocket/stream.go picks JSON vs binary-proto from the upgrade
  // request's Content-Type header (defaults to JSON). Without application/proto
  // the server protojson.Unmarshals our hand-encoded binary chunks and fails
  // silently with EOF.
  // 服务端 stream.go 通过 Content-Type 区分 JSON 和 binary-proto 模式；
  // 必须设置 application/proto，否则服务端尝试 protojson 反序列化会静默失败（EOF 错误）
  const headers = {
    'Content-Type': 'application/proto',
    Authorization: wsAuthHeader,         // WS 升级请求的认证（Bearer Token）
  }
  let ws: WebSocketLike
  if (nodeWSCtor) {
    // Node.js 路径：使用 ws 包，传入显式代理 agent（undici WebSocket 不走全局 dispatcher）
    ws = new nodeWSCtor(wsUrl, {
      headers,
      agent: getWebSocketProxyAgent(wsUrl),   // egress 代理 agent
      ...getWebSocketTLSOptions(),             // mTLS 证书选项（如有）
    }) as unknown as WebSocketLike
  } else {
    // Bun 路径：原生 WebSocket 支持 proxy 选项（非标准扩展，不在 lib.dom 类型中）
    ws = new globalThis.WebSocket(wsUrl, {
      // @ts-expect-error — Bun extension; not in lib.dom WebSocket types
      headers,
      proxy: getWebSocketProxyUrl(wsUrl),    // Bun 原生 proxy URL 支持
      tls: getWebSocketTLSOptions() || undefined,
    })
  }
  ws.binaryType = 'arraybuffer'   // 接收二进制消息为 ArrayBuffer（而非 Blob）
  st.ws = ws

  ws.onopen = () => {
    // First chunk carries the CONNECT line plus Proxy-Authorization so the
    // server can auth the tunnel and know the target host:port. Server
    // responds with its own "HTTP/1.1 200" over the tunnel; we just pipe it.
    // 第一帧内容：CONNECT 请求行 + Proxy-Authorization + 空行，
    // 让服务端知道目标 host:port 并验证 Basic Auth 凭据
    const head =
      `${connectLine}\r\n` + `Proxy-Authorization: ${authHeader}\r\n` + `\r\n`
    ws.send(encodeChunk(Buffer.from(head, 'utf8')))
    // Flush anything that arrived while the WS handshake was in flight —
    // trailing bytes from the CONNECT packet and any data() callbacks that
    // fired before onopen.
    // 标记 WS 就绪，然后冲刷握手期间暂存的所有字节
    st.wsOpen = true
    for (const buf of st.pending) {
      forwardToWs(ws, buf)
    }
    st.pending = []   // 清空暂存队列，释放内存
    // Not all WS implementations expose ping(); empty chunk works as an
    // application-level keepalive the server can ignore.
    // 启动 keepalive 定时器：部分 WS 实现不支持 ping()，改用发送空块作为应用层 keepalive
    st.pinger = setInterval(sendKeepalive, PING_INTERVAL_MS, ws)
  }

  ws.onmessage = ev => {
    // 将接收到的消息统一转换为 Uint8Array（ArrayBuffer 直接包装，其他转 Buffer 再包装）
    const raw =
      ev.data instanceof ArrayBuffer
        ? new Uint8Array(ev.data)
        : new Uint8Array(Buffer.from(ev.data))
    const payload = decodeChunk(raw)
    // 解码成功且非空（空块为 keepalive，忽略）才写回客户端
    if (payload && payload.length > 0) {
      st.established = true   // 标记隧道已建立（服务端 200 已透传），之后不能再写明文 HTTP
      sock.write(payload)
    }
  }

  ws.onerror = ev => {
    const msg = 'message' in ev ? String(ev.message) : 'websocket error'
    logForDebugging(`[upstreamproxy] ws error: ${msg}`)
    if (st.closed) return     // onerror 之后会触发 onclose，防止重复关闭
    st.closed = true
    // 隧道未建立时可以发明文 HTTP 错误响应；已建立则直接关闭（避免污染 TLS 流）
    if (!st.established) {
      sock.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    }
    sock.end()
    cleanupConn(st)
  }

  ws.onclose = () => {
    if (st.closed) return   // 防止与 onerror 路径重复关闭
    st.closed = true
    sock.end()              // 关闭客户端 TCP 连接
    cleanupConn(st)
  }
}

/**
 * 发送应用层 keepalive 空块（encodeChunk(empty)），保持 WS 连接活跃。
 * 仅在 WS 处于 OPEN 状态时发送，避免向已关闭的连接发送消息。
 */
function sendKeepalive(ws: WebSocketLike): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(encodeChunk(new Uint8Array(0)))   // 空数组 = 零长度 keepalive 帧
  }
}

/**
 * 将客户端字节分块转发到 WebSocket 隧道。
 *
 * 分块策略：每块最大 MAX_CHUNK_BYTES（512 KB），防止超出 Envoy 单请求缓冲上限。
 * 每块单独调用 encodeChunk() 包裹为 protobuf 帧后发送。
 * 仅在 WS 处于 OPEN 状态时转发，避免向关闭中的连接写入。
 */
function forwardToWs(ws: WebSocketLike, data: Buffer): void {
  if (ws.readyState !== WebSocket.OPEN) return
  // 按最大块大小切片，逐块发送
  for (let off = 0; off < data.length; off += MAX_CHUNK_BYTES) {
    const slice = data.subarray(off, off + MAX_CHUNK_BYTES)
    ws.send(encodeChunk(slice))
  }
}

/**
 * 清理连接资源：停止 keepalive 定时器，关闭 WebSocket 连接。
 *
 * 在以下场景调用：
 *   - 客户端 TCP 连接关闭（close 事件）
 *   - 客户端 TCP 连接错误（error 事件）
 *   - WS onerror / onclose 触发
 *
 * 对 undefined 状态安全（WeakMap 查找可能返回 undefined）。
 * WS 关闭时捕获 "already closing" 异常，避免重复关闭报错。
 */
function cleanupConn(st: ConnState | undefined): void {
  if (!st) return
  if (st.pinger) clearInterval(st.pinger)   // 停止 keepalive 定时器
  // readyState <= OPEN 包含 CONNECTING(0) 和 OPEN(1)，均需调用 close() 关闭
  if (st.ws && st.ws.readyState <= WebSocket.OPEN) {
    try {
      st.ws.close()
    } catch {
      // already closing — 已在关闭过程中，忽略异常
    }
  }
  st.ws = undefined   // 清除引用，允许 GC 回收 WS 对象
}
