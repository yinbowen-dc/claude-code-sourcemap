/**
 * VSCode SDK MCP 双向通信模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件是 MCP 子系统与 VSCode 扩展之间的专用 IPC（进程间通信）桥梁。
 * 在 Claude Code 启动时，setupVscodeSdkMcp() 会被调用，找到名为
 * 'claude-vscode' 的 MCP 客户端连接，并建立双向通知通道：
 *   - Claude → VSCode：通过 file_updated 通知告知文件变更
 *   - VSCode → Claude：通过 log_event 通知将 VSCode 侧事件转发给分析系统
 *   - Claude → VSCode：通过 experiment_gates 通知推送实验开关状态
 *
 * 主要功能：
 * - 维护全局 vscodeMcpClient 引用，供 notifyVscodeFileUpdated 使用
 * - 注册 log_event 通知处理器，将 VSCode 事件桥接到 Anthropic 分析系统
 * - 启动时推送实验开关（5 个 feature gate + 可选的 auto_mode 三态）
 * - notifyVscodeFileUpdated：仅对 Anthropic 员工账户（USER_TYPE === 'ant'）生效
 *
 * 设计说明：
 * - AutoModeEnabledState 从 permissionSetup.ts 内联复制，避免引入过多依赖
 * - LogEventNotificationSchema 使用 lazySchema 延迟初始化，防止循环依赖
 */

import { logForDebugging } from 'src/utils/debug.js'
import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from '../analytics/growthbook.js'
import { logEvent } from '../analytics/index.js'
import type { ConnectedMCPServer, MCPServerConnection } from './types.js'

// 从 permissionSetup.ts 内联复制的类型 — 避免引入该文件过多的依赖项
// 此模块作为轻量级 IPC 模块，不应承担过多依赖
type AutoModeEnabledState = 'enabled' | 'disabled' | 'opt-in'

/**
 * 读取自动模式启用状态
 *
 * 作用：从 GrowthBook feature flag 'tengu_auto_mode_config' 中读取 enabled 字段，
 * 返回三态枚举值：'enabled' | 'disabled' | 'opt-in'。
 * 若值不在枚举范围内则返回 undefined，表示状态未知。
 *
 * 使用场景：setupVscodeSdkMcp 发送 experiment_gates 时附带此状态，
 * VSCode 侧若收不到该字段则 fail closed（当作 'disabled' 处理）。
 */
function readAutoModeEnabledState(): AutoModeEnabledState | undefined {
  // 从缓存的 GrowthBook feature value 中读取 tengu_auto_mode_config.enabled 字段
  const v = getFeatureValue_CACHED_MAY_BE_STALE<{ enabled?: string }>(
    'tengu_auto_mode_config',
    {},
  )?.enabled
  // 严格校验：只接受枚举中定义的三个值，其他值（包括 undefined）一律返回 undefined
  return v === 'enabled' || v === 'disabled' || v === 'opt-in' ? v : undefined
}

/**
 * log_event 通知的 Zod Schema
 *
 * 作用：定义从 VSCode 扩展发往 Claude Code 的 log_event MCP 通知的结构。
 * VSCode 通过此通知将自身侧的用户行为事件转发给 Claude 的分析系统。
 *
 * 使用 lazySchema 包装，避免模块初始化时的循环依赖问题。
 * params.eventData 使用 passthrough() 允许任意额外字段通过校验。
 */
export const LogEventNotificationSchema = lazySchema(() =>
  z.object({
    method: z.literal('log_event'),
    params: z.object({
      eventName: z.string(),
      // passthrough() 允许 eventData 中包含任意额外字段，不会因未知字段而拒绝
      eventData: z.object({}).passthrough(),
    }),
  }),
)

// 存储 VSCode MCP 客户端引用，供 notifyVscodeFileUpdated 在任意时刻发送通知
let vscodeMcpClient: ConnectedMCPServer | null = null

/**
 * 向 VSCode MCP 服务器发送 file_updated 通知
 *
 * 作用：当 Claude 编辑或写入文件时，通知 VSCode 扩展文件内容发生了变化，
 * 使 VSCode 可以同步刷新编辑器视图或触发其他响应逻辑。
 *
 * 流程：
 * 1. 安全检查：仅限 Anthropic 内部员工账户（USER_TYPE === 'ant'）且已连接 vscodeMcpClient
 * 2. 异步发送 fire-and-forget 通知（void + catch），失败时仅记录调试日志不抛出
 *
 * @param filePath 被修改的文件路径
 * @param oldContent 修改前的文件内容（null 表示新建文件）
 * @param newContent 修改后的文件内容（null 表示删除文件）
 */
export function notifyVscodeFileUpdated(
  filePath: string,
  oldContent: string | null,
  newContent: string | null,
): void {
  // 安全卫士：仅对 Anthropic 员工账户且 vscodeMcpClient 已连接时才发送通知
  if (process.env.USER_TYPE !== 'ant' || !vscodeMcpClient) {
    return
  }

  // 异步发送通知，不等待结果（fire-and-forget）
  // 使用 void 明确表示有意忽略 Promise 返回值
  void vscodeMcpClient.client
    .notification({
      method: 'file_updated',
      params: { filePath, oldContent, newContent },
    })
    .catch((error: Error) => {
      // 通知发送失败不应影响主流程，仅记录调试日志
      logForDebugging(
        `[VSCode] Failed to send file_updated notification: ${error.message}`,
      )
    })
}

/**
 * 初始化 VSCode SDK MCP 双向通信通道
 *
 * 作用：在 Claude Code 启动阶段，从所有 MCP 客户端连接中找到专用的
 * 'claude-vscode' 客户端，建立双向通知通道，并立即推送实验开关状态。
 *
 * 完整流程：
 * 1. 查找 name === 'claude-vscode' 且 type === 'connected' 的客户端
 * 2. 将其引用存入模块级 vscodeMcpClient，供后续 notifyVscodeFileUpdated 使用
 * 3. 注册 log_event 通知处理器：将 VSCode 事件名添加 'tengu_vscode_' 前缀后
 *    转发给 Anthropic 的 logEvent 分析系统
 * 4. 构建 experiment_gates 字典，包含 4 个 boolean/string feature value：
 *    - tengu_vscode_review_upsell：代码审查相关功能门控
 *    - tengu_vscode_onboarding：VSCode 新用户引导功能
 *    - tengu_quiet_fern：浏览器支持功能
 *    - tengu_vscode_cc_auth：带内 OAuth 认证方式（vs. 扩展原生 PKCE）
 * 5. 可选地附加 tengu_auto_mode_state（三态），若状态未知则省略
 * 6. 异步发送 experiment_gates 通知（不等待结果）
 *
 * @param sdkClients 所有已连接的 MCP 服务器连接列表
 */
export function setupVscodeSdkMcp(sdkClients: MCPServerConnection[]): void {
  // 在所有 MCP 客户端中查找专用的 VSCode MCP 连接
  const client = sdkClients.find(client => client.name === 'claude-vscode')

  if (client && client.type === 'connected') {
    // 保存客户端引用，供模块内其他函数（notifyVscodeFileUpdated）后续使用
    vscodeMcpClient = client

    // 注册 log_event 通知处理器：VSCode → Claude 的事件桥接
    // 将 VSCode 发来的自定义事件名添加 'tengu_vscode_' 前缀后转发给分析系统
    client.client.setNotificationHandler(
      LogEventNotificationSchema(),
      async notification => {
        const { eventName, eventData } = notification.params
        logEvent(
          `tengu_vscode_${eventName}`,
          eventData as { [key: string]: boolean | number | undefined },
        )
      },
    )

    // 构建需要推送给 VSCode 的实验开关字典
    // 使用 CACHED_MAY_BE_STALE 变体：启动时 Statsig 数据可能尚未完全同步，
    // 但仍需立即发送以避免 VSCode 侧等待超时
    const gates: Record<string, boolean | string> = {
      tengu_vscode_review_upsell: checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
        'tengu_vscode_review_upsell',
      ),
      tengu_vscode_onboarding: checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
        'tengu_vscode_onboarding',
      ),
      // 浏览器支持功能开关
      tengu_quiet_fern: getFeatureValue_CACHED_MAY_BE_STALE(
        'tengu_quiet_fern',
        false,
      ),
      // 带内 OAuth 认证方式（claude_authenticate）vs. VSCode 扩展原生 PKCE
      tengu_vscode_cc_auth: getFeatureValue_CACHED_MAY_BE_STALE(
        'tengu_vscode_cc_auth',
        false,
      ),
    }
    // 三态自动模式：'enabled' | 'disabled' | 'opt-in'
    // 若状态未知则省略该字段，VSCode 侧收不到时 fail closed（视为 'disabled'）
    const autoModeState = readAutoModeEnabledState()
    if (autoModeState !== undefined) {
      gates.tengu_auto_mode_state = autoModeState
    }
    // 异步发送 experiment_gates 通知，不等待结果（fire-and-forget）
    void client.client.notification({
      method: 'experiment_gates',
      params: { gates },
    })
  }
}
