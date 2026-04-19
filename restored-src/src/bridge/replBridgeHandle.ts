/**
 * replBridgeHandle.ts — 全局 REPL Bridge 句柄指针模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   REPL（交互式终端）Bridge 层
 *     ├─> useReplBridge.tsx（设置/清除 handle）
 *     └─> replBridgeHandle.ts（本文件）——存储全局指针，供 React 树外部（工具、斜杠命令）访问
 *
 * 主要功能：
 *   - 维护进程级唯一的 ReplBridgeHandle 指针（handle 变量）
 *   - setReplBridgeHandle：设置/清除 handle，并同步发布 bridgeId 到 concurrentSessions
 *   - getReplBridgeHandle：返回当前 handle（可能为 null）
 *   - getSelfBridgeCompatId：以 session_* 格式（v1 compat）返回本实例的 bridge session ID
 *
 * 设计原因（全局指针而非 React Context）：
 *   工具（tools/）和斜杠命令在 React 树外部运行，无法访问 Context。
 *   handle 的闭包中已捕获 sessionId 和 getAccessToken，直接重派生有
 *   暂存/生产令牌错位的风险（参见 BriefTool/upload.ts 模式）。
 *   同样的理由见 bridgeDebug.ts 的"one-bridge-per-process"注释。
 */
import { updateSessionBridgeId } from '../utils/concurrentSessions.js'
import type { ReplBridgeHandle } from './replBridge.js'
import { toCompatSessionId } from './sessionIdCompat.js'

/**
 * 进程级全局 REPL Bridge 句柄（最多只有一个活跃 bridge）。
 *
 * 由 useReplBridge.tsx 在初始化完成时设置；teardown 时清除为 null。
 * React 树外部的调用方（工具、斜杠命令）通过 getReplBridgeHandle() 访问。
 */
let handle: ReplBridgeHandle | null = null

/**
 * 设置（或清除）全局 REPL Bridge 句柄，并同步更新 concurrentSessions 中的 bridgeId。
 *
 * 流程：
 *   1. 更新模块级 handle 指针
 *   2. 调用 updateSessionBridgeId（发布 compat session ID 到会话记录）
 *      - 其他本地实例可据此将本 bridge 从其 bridge 列表中去重（本地优先）
 *      - fire-and-forget：捕获所有错误，不阻塞调用方
 *
 * 在 initReplBridge.ts 初始化成功后由 useReplBridge.tsx 调用 setReplBridgeHandle(handle)，
 * 在 teardown 时调用 setReplBridgeHandle(null)。
 */
export function setReplBridgeHandle(h: ReplBridgeHandle | null): void {
  handle = h
  // 发布（或清除）本实例的 bridge session ID 到会话记录，
  // 使同一机器上的其他本地 peer 可以从其 bridge 列表中去重本实例（本地优先策略）
  void updateSessionBridgeId(getSelfBridgeCompatId() ?? null).catch(() => {})
}

/**
 * 获取当前全局 REPL Bridge 句柄。
 *
 * 返回 null 表示当前没有活跃的 bridge 连接。
 * 调用方应在使用前检查返回值是否为 null。
 */
export function getReplBridgeHandle(): ReplBridgeHandle | null {
  return handle
}

/**
 * 获取本实例 bridge session ID 的 session_* compat 格式（供 API /v1/sessions 响应使用）。
 *
 * 背景：
 *   基础设施层（sandbox-gateway 工作队列）使用 cse_* 格式；
 *   v1 API 兼容层（/v1/sessions 响应）使用 session_* 格式。
 *   toCompatSessionId 将 cse_* 转换为 session_* 格式（sameSessionId 可忽略前缀比较）。
 *
 * 返回 undefined 表示 bridge 未连接。
 */
export function getSelfBridgeCompatId(): string | undefined {
  const h = getReplBridgeHandle()
  // h.bridgeSessionId 为 cse_* 格式（基础设施层），转换为 session_* 格式（API 层）
  return h ? toCompatSessionId(h.bridgeSessionId) : undefined
}
