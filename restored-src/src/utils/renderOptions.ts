/**
 * Ink 渲染选项模块 (renderOptions.ts)
 *
 * 在 Claude Code 系统流程中的位置：
 *   入口层（main.tsx / REPL） → 【本模块：Ink 渲染配置】 → ink.render() → 终端 UI
 *
 * 主要职责：
 *   1. 检测 stdin 是否为管道（piped），若是则打开 /dev/tty 作为替代输入源
 *   2. 将 /dev/tty ReadStream 缓存为进程级单例，避免多次 open() 系统调用
 *   3. 向所有 ink.render() 调用统一提供 stdin override + exitOnCtrlC 配置
 *
 * 与其他模块的关系：
 *   - 被所有调用 ink.render() 的位置使用（REPL、对话框等）
 *   - CI 环境、MCP 模式、Windows 平台不使用 stdin override
 */

import { openSync } from 'fs'
import { ReadStream } from 'tty'
import type { RenderOptions } from '../ink.js'
import { isEnvTruthy } from './envUtils.js'
import { logError } from './log.js'

// 进程级 stdin override 单例：
//   null  = 尚未计算（延迟初始化）
//   undefined = 已计算，无需 override（TTY / CI / MCP / win32）
//   ReadStream = 已打开的 /dev/tty 流，供 Ink 使用
let cachedStdinOverride: ReadStream | undefined | null = null

/**
 * 当 stdin 为管道时，打开 /dev/tty 作为 Ink 的键盘输入源，
 * 使 Ink 在管道输入场景下仍能正常渲染交互式 UI。
 *
 * 结果缓存为进程级单例，仅计算一次。
 *
 * 跳过条件（返回 undefined）：
 *   - stdin 本身已是 TTY（无需 override）
 *   - CI 环境（无交互需求）
 *   - MCP 模式（劫持 stdin 会破坏 MCP 协议通信）
 *   - Windows（/dev/tty 不存在）
 *
 * @returns /dev/tty ReadStream 或 undefined（无需 override 时）
 */
function getStdinOverride(): ReadStream | undefined {
  // 已有缓存结果：直接返回，避免重复计算
  if (cachedStdinOverride !== null) {
    return cachedStdinOverride
  }

  // stdin 本身已是 TTY：不需要 override
  if (process.stdin.isTTY) {
    cachedStdinOverride = undefined
    return undefined
  }

  // CI 环境：跳过（无需交互式输入）
  if (isEnvTruthy(process.env.CI)) {
    cachedStdinOverride = undefined
    return undefined
  }

  // MCP 模式：跳过（劫持 stdin 会破坏 MCP 的 JSON-RPC 通信流）
  if (process.argv.includes('mcp')) {
    cachedStdinOverride = undefined
    return undefined
  }

  // Windows：不存在 /dev/tty 设备
  if (process.platform === 'win32') {
    cachedStdinOverride = undefined
    return undefined
  }

  // 以只读方式打开 /dev/tty 作为替代键盘输入源
  try {
    const ttyFd = openSync('/dev/tty', 'r')
    const ttyStream = new ReadStream(ttyFd)
    // 显式设置 isTTY = true，因为部分运行时（如 Bun 编译二进制）
    // 无法从文件描述符自动检测到 TTY 属性
    ttyStream.isTTY = true
    cachedStdinOverride = ttyStream
    return cachedStdinOverride
  } catch (err) {
    // 打开失败（如容器内无 /dev/tty）：记录错误但不崩溃，优雅降级
    logError(err as Error)
    cachedStdinOverride = undefined
    return undefined
  }
}

/**
 * 返回所有 ink.render() 调用所需的基础渲染选项。
 *
 * 包含：
 *   - exitOnCtrlC：是否在按下 Ctrl+C 时退出（对话框通常设为 false）
 *   - stdin：若 stdin 为管道，则注入 /dev/tty override，确保键盘输入可用
 *
 * @param exitOnCtrlC 是否在 Ctrl+C 时退出，默认为 false
 * @returns Ink RenderOptions 对象
 */
export function getBaseRenderOptions(
  exitOnCtrlC: boolean = false,
): RenderOptions {
  const stdin = getStdinOverride()
  const options: RenderOptions = { exitOnCtrlC }
  // 仅在有 stdin override 时才注入，避免覆盖 Ink 的默认 stdin 处理
  if (stdin) {
    options.stdin = stdin
  }
  return options
}
