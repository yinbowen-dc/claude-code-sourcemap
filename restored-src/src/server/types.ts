/**
 * @file types.ts
 * @description 服务器模块共享类型定义 —— Claude Code `--server` 模式（直连服务器）的核心数据结构。
 *
 * 在整个 Claude Code 系统流程中的位置：
 *   `claude --server` / `claude --server-url` 入口
 *     └─► server/ 模块（本文件定义共享类型）
 *           ├─► createDirectConnectSession.ts（使用 connectResponseSchema 验证响应）
 *           ├─► directConnectManager.ts（使用 DirectConnectConfig / DirectConnectCallbacks）
 *           └─► ClaudeServer（使用 ServerConfig / SessionInfo / SessionIndex 管理会话）
 *
 * 主要类型：
 *  - connectResponseSchema：POST /sessions 响应体的 Zod 验证 schema
 *  - ServerConfig：服务器启动配置（端口、认证、超时等）
 *  - SessionState：会话生命周期状态机的状态枚举
 *  - SessionInfo：运行时会话信息（含子进程引用）
 *  - SessionIndexEntry / SessionIndex：持久化的会话索引（支持跨重启恢复）
 */

import type { ChildProcess } from 'child_process'
import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'

/**
 * POST /sessions 端点响应体的 Zod 验证 schema。
 *
 * 使用 lazySchema 包装以延迟 Zod schema 构建时机，
 * 避免循环导入导致的初始化顺序问题。
 *
 * 字段说明：
 *  - session_id：服务器分配的会话唯一标识
 *  - ws_url：客户端应连接的 WebSocket URL（用于接收 SDKMessage 流）
 *  - work_dir：服务端为本次会话设置的工作目录（可选，客户端可用于显示路径）
 */
export const connectResponseSchema = lazySchema(() =>
  z.object({
    session_id: z.string(),
    ws_url: z.string(),
    work_dir: z.string().optional(), // 服务端返回的工作目录，客户端展示用
  }),
)

/**
 * 服务器启动配置。
 *
 * - port / host：HTTP + WebSocket 服务监听地址
 * - authToken：Bearer 令牌，客户端在每次请求中须携带（用于访问控制）
 * - unix：Unix Domain Socket 路径（优先级高于 port/host，用于本机进程间通信）
 * - idleTimeoutMs：分离会话的空闲超时毫秒数，0 表示永不超时
 * - maxSessions：最大并发会话数，超出后拒绝新建会话请求
 * - workspace：未指定 cwd 的会话的默认工作目录
 */
export type ServerConfig = {
  port: number
  host: string
  authToken: string
  unix?: string
  /** Idle timeout for detached sessions (ms). 0 = never expire. */
  idleTimeoutMs?: number
  /** Maximum number of concurrent sessions. */
  maxSessions?: number
  /** Default workspace directory for sessions that don't specify cwd. */
  workspace?: string
}

/**
 * 会话生命周期状态枚举。
 *
 * 状态转换流程：
 *  starting → running（子进程启动完成）
 *  running  → detached（客户端断开 WebSocket，会话进入后台运行）
 *  detached → running（客户端重新连接）
 *  running/detached → stopping（收到停止请求）
 *  stopping → stopped（子进程退出）
 */
export type SessionState =
  | 'starting'   // 子进程正在启动
  | 'running'    // 子进程运行中，客户端已连接
  | 'detached'   // 子进程运行中，客户端已断开（后台运行）
  | 'stopping'   // 正在停止子进程
  | 'stopped'    // 子进程已退出

/**
 * 运行时会话信息（内存中，不持久化）。
 *
 * 包含会话的完整运行时状态，其中 process 字段持有子进程引用，
 * 使服务器能够向子进程发送信号（如 SIGTERM）或等待其退出。
 *
 * - id：会话唯一标识（与 connectResponseSchema 中的 session_id 一致）
 * - status：当前状态
 * - createdAt：创建时间戳（Unix 毫秒）
 * - workDir：会话的工作目录
 * - process：子进程引用，null 表示进程尚未启动或已退出
 * - sessionKey：客户端提供的稳定键值，用于关联 SessionIndexEntry
 */
export type SessionInfo = {
  id: string
  status: SessionState
  createdAt: number
  workDir: string
  process: ChildProcess | null // 子进程引用，进程退出后置为 null
  sessionKey?: string          // 与 SessionIndex 中的键值对应
}

/**
 * 持久化的会话索引条目，存储到 ~/.claude/server-sessions.json。
 *
 * 服务器重启后，通过此索引可重新关联已存在的 claude 会话，
 * 使客户端能够使用 --resume 恢复上次中断的对话。
 *
 * - sessionId：服务器分配的会话 ID（与子进程的 claude 会话 ID 相同）
 * - transcriptSessionId：用于 --resume 的对话记录会话 ID（直连模式与 sessionId 相同）
 * - cwd：会话的工作目录
 * - permissionMode：会话使用的权限模式（如 default / bypassPermissions）
 * - createdAt / lastActiveAt：时间戳，用于空闲超时计算和排序
 */
export type SessionIndexEntry = {
  /** Server-assigned session ID (matches the subprocess's claude session). */
  sessionId: string
  /** The claude transcript session ID for --resume. Same as sessionId for direct sessions. */
  transcriptSessionId: string
  cwd: string
  permissionMode?: string
  createdAt: number
  lastActiveAt: number
}

/**
 * 会话索引全局映射：sessionKey → SessionIndexEntry。
 *
 * sessionKey 由客户端提供（通常是工作目录的哈希或用户自定义名称），
 * 作为稳定的外部标识符，在服务器重启后仍可通过此键找到对应会话。
 */
export type SessionIndex = Record<string, SessionIndexEntry>
