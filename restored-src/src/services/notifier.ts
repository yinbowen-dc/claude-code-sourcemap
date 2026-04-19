/**
 * 多通道终端通知分发服务
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件是 Claude Code 通知子系统的分发层，在任务完成或需要用户关注时，
 * 通过合适的终端通知通道提醒用户。它位于 UI 层（ink/useTerminalNotification）
 * 和配置层（globalConfig.preferredNotifChannel）之间，负责将配置的通道
 * 映射到具体的终端通知实现。
 *
 * 主要功能：
 * - sendNotification：统一入口，执行通知 hooks 后根据配置分发到具体通道
 * - sendToChannel：按 preferredNotifChannel 路由到 iterm2/kitty/ghostty/terminal_bell/auto/disabled
 * - sendAuto：自动检测终端类型（env.terminal）并选择最合适的通知方式
 * - isAppleTerminalBellDisabled：通过 osascript + plist 解析检查 Apple Terminal 铃声配置
 * - 所有通知方法调用后均记录 tengu_notification_method_used 分析事件
 *
 * 设计说明：
 * - plist 模块（~280KB）使用懒加载（import()），仅在 Apple Terminal + auto 通道时才加载
 * - kitty 通知 ID 使用随机数生成，避免消息重复合并
 * - DEFAULT_TITLE = 'Claude Code'，可被 NotificationOptions.title 覆盖
 */

import type { TerminalNotification } from '../ink/useTerminalNotification.js'
import { getGlobalConfig } from '../utils/config.js'
import { env } from '../utils/env.js'
import { execFileNoThrow } from '../utils/execFileNoThrow.js'
import { executeNotificationHooks } from '../utils/hooks.js'
import { logError } from '../utils/log.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from './analytics/index.js'

/**
 * 通知选项类型
 *
 * - message：通知正文内容
 * - title：通知标题（可选，默认为 'Claude Code'）
 * - notificationType：通知类型标识，用于分析事件区分来源
 */
export type NotificationOptions = {
  message: string
  title?: string
  notificationType: string
}

/**
 * 发送终端通知的统一入口
 *
 * 整体流程：
 * 1. 从全局配置读取用户首选通知通道（preferredNotifChannel）
 * 2. 执行所有已注册的通知 hooks（允许用户自定义通知逻辑）
 * 3. 根据通道配置调用 sendToChannel 分发到具体实现
 * 4. 记录 tengu_notification_method_used 分析事件，含配置通道、实际使用方法和终端类型
 *
 * @param notif 通知内容（message、title、notificationType）
 * @param terminal 终端通知接口实例（由 ink/useTerminalNotification 提供）
 */
export async function sendNotification(
  notif: NotificationOptions,
  terminal: TerminalNotification,
): Promise<void> {
  // 从全局配置读取用户设置的首选通知通道
  const config = getGlobalConfig()
  const channel = config.preferredNotifChannel

  // 先执行用户自定义的通知 hooks（hook 失败不阻断通知发送）
  await executeNotificationHooks(notif)

  // 按通道分发通知，返回实际使用的通知方式
  const methodUsed = await sendToChannel(channel, notif, terminal)

  // 记录分析事件：配置通道、实际方法、终端类型
  logEvent('tengu_notification_method_used', {
    configured_channel:
      channel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    method_used:
      methodUsed as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    term: env.terminal as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}

// 通知标题默认值，当 NotificationOptions.title 未提供时使用
const DEFAULT_TITLE = 'Claude Code'

/**
 * 按通知通道路由到具体的通知实现
 *
 * 支持的通道：
 * - auto：自动检测终端类型，智能选择通知方式（见 sendAuto）
 * - iterm2：仅使用 iTerm2 原生通知
 * - iterm2_with_bell：iTerm2 通知 + 终端铃声
 * - kitty：Kitty 终端通知（含随机 ID 防止重复合并）
 * - ghostty：Ghostty 终端通知
 * - terminal_bell：仅发送终端铃声（ASCII BEL）
 * - notifications_disabled：禁用通知，静默返回 'disabled'
 * - 其他未知通道：返回 'none'
 *
 * 任何通知发送异常都被捕获，返回 'error' 而非抛出，保证通知失败不影响主流程。
 *
 * @param channel 通知通道名称（来自 globalConfig.preferredNotifChannel）
 * @param opts 通知选项
 * @param terminal 终端通知接口
 * @returns 实际使用的通知方式标识字符串
 */
async function sendToChannel(
  channel: string,
  opts: NotificationOptions,
  terminal: TerminalNotification,
): Promise<string> {
  // title 未提供时使用默认值 'Claude Code'
  const title = opts.title || DEFAULT_TITLE

  try {
    switch (channel) {
      case 'auto':
        // 自动模式：根据终端类型选择最合适的通知方式
        return sendAuto(opts, terminal)
      case 'iterm2':
        terminal.notifyITerm2(opts)
        return 'iterm2'
      case 'iterm2_with_bell':
        // iTerm2 通知 + 终端铃声组合（用于声音+视觉双重提醒）
        terminal.notifyITerm2(opts)
        terminal.notifyBell()
        return 'iterm2_with_bell'
      case 'kitty':
        // Kitty 通知需要唯一 ID，使用随机数避免消息被终端合并去重
        terminal.notifyKitty({ ...opts, title, id: generateKittyId() })
        return 'kitty'
      case 'ghostty':
        terminal.notifyGhostty({ ...opts, title })
        return 'ghostty'
      case 'terminal_bell':
        // 仅发送终端铃声，最基础的通知方式，兼容所有终端
        terminal.notifyBell()
        return 'terminal_bell'
      case 'notifications_disabled':
        // 用户明确禁用通知，静默返回
        return 'disabled'
      default:
        return 'none'
    }
  } catch {
    // 捕获所有通知发送错误，不抛出，返回 'error' 供分析系统记录
    return 'error'
  }
}

/**
 * 自动检测终端类型并选择通知方式
 *
 * 检测逻辑（基于 env.terminal）：
 * - Apple_Terminal：检查当前配置文件的铃声设置，若启用则发送铃声；否则无通知
 * - iTerm.app：使用 iTerm2 原生通知协议
 * - kitty：使用 Kitty 终端通知（含随机 ID）
 * - ghostty：使用 Ghostty 终端通知
 * - 其他终端：返回 'no_method_available'
 *
 * @param opts 通知选项
 * @param terminal 终端通知接口
 * @returns 实际使用的通知方式标识字符串
 */
async function sendAuto(
  opts: NotificationOptions,
  terminal: TerminalNotification,
): Promise<string> {
  const title = opts.title || DEFAULT_TITLE

  switch (env.terminal) {
    case 'Apple_Terminal': {
      // Apple Terminal：检查当前窗口配置文件是否启用了铃声
      const bellDisabled = await isAppleTerminalBellDisabled()
      if (bellDisabled) {
        // 铃声被禁用时仍发送（注意：此处逻辑为"铃声被禁用时才发送"，见函数说明）
        terminal.notifyBell()
        return 'terminal_bell'
      }
      // 铃声未被禁用时没有更好的通知方式
      return 'no_method_available'
    }
    case 'iTerm.app':
      // iTerm2：使用原生通知协议（无需铃声）
      terminal.notifyITerm2(opts)
      return 'iterm2'
    case 'kitty':
      // Kitty：使用终端图形通知协议
      terminal.notifyKitty({ ...opts, title, id: generateKittyId() })
      return 'kitty'
    case 'ghostty':
      // Ghostty：使用终端通知协议
      terminal.notifyGhostty({ ...opts, title })
      return 'ghostty'
    default:
      // 未知终端类型，无可用通知方式
      return 'no_method_available'
  }
}

/**
 * 生成 Kitty 通知的唯一 ID
 *
 * Kitty 终端会根据通知 ID 去重/合并通知，
 * 使用随机整数确保每条通知都以独立消息显示而非被合并。
 *
 * @returns 0-9999 范围内的随机整数
 */
function generateKittyId(): number {
  return Math.floor(Math.random() * 10000)
}

/**
 * 检查 Apple Terminal 当前配置文件是否禁用了铃声
 *
 * 实现思路：
 * 1. 通过 osascript 获取当前 Terminal 窗口正在使用的配置文件名称
 * 2. 通过 `defaults export com.apple.Terminal -` 导出 plist 格式的终端偏好设置
 * 3. 懒加载 plist 解析库（~280KB，仅在需要时加载，避免影响启动性能）
 * 4. 在 "Window Settings" 字典中查找当前配置文件的 Bell 字段
 * 5. Bell === false 表示铃声已禁用
 *
 * 任何步骤失败（osascript 不可用、plist 解析错误等）都返回 false（保守策略：
 * 不确定时假设铃声启用，避免漏发通知）。
 *
 * 性能注意：plist 库约 280KB，使用懒加载（await import('plist')）仅在
 * Apple Terminal + auto 通道时才加载，影响用户比例很小。
 *
 * @returns true 表示铃声已禁用，false 表示铃声已启用（或状态未知）
 */
async function isAppleTerminalBellDisabled(): Promise<boolean> {
  try {
    // 非 Apple Terminal 时快速返回 false（不应被调用到此分支）
    if (env.terminal !== 'Apple_Terminal') {
      return false
    }

    // 通过 AppleScript 获取当前 Terminal 窗口的配置文件名称
    const osascriptResult = await execFileNoThrow('osascript', [
      '-e',
      'tell application "Terminal" to name of current settings of front window',
    ])
    const currentProfile = osascriptResult.stdout.trim()

    // 获取配置文件名失败（如无前台窗口）时保守返回 false
    if (!currentProfile) {
      return false
    }

    // 通过 defaults 命令导出 com.apple.Terminal 的完整偏好设置（plist 格式）
    const defaultsOutput = await execFileNoThrow('defaults', [
      'export',
      'com.apple.Terminal',
      '-',
    ])

    // defaults 命令失败时保守返回 false
    if (defaultsOutput.code !== 0) {
      return false
    }

    // Lazy-load plist (~280KB with xmlbuilder+@xmldom) — only hit on
    // Apple_Terminal with auto-channel, which is a small fraction of users.
    // 懒加载 plist 解析库：仅在此路径执行时才加载，降低对大多数用户的性能影响
    const plist = await import('plist')
    const parsed: Record<string, unknown> = plist.parse(defaultsOutput.stdout)
    // 从 "Window Settings" 字典中查找当前配置文件的设置
    const windowSettings = parsed?.['Window Settings'] as
      | Record<string, unknown>
      | undefined
    const profileSettings = windowSettings?.[currentProfile] as
      | Record<string, unknown>
      | undefined

    // 找不到配置文件设置时保守返回 false
    if (!profileSettings) {
      return false
    }

    // Bell === false 表示用户在该配置文件中禁用了铃声
    return profileSettings.Bell === false
  } catch (error) {
    // 任何异常（osascript 不存在、plist 格式错误等）都记录错误并返回 false
    logError(error)
    return false
  }
}
