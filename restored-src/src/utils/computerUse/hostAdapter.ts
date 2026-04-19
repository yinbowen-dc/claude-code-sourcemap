/**
 * Computer Use 宿主适配器单例模块。
 *
 * 在 Claude Code 系统中，该模块创建并缓存进程生命周期内唯一的 ComputerUseHostAdapter 实例：
 * - getComputerUseHostAdapter()：返回单例 HostAdapter，首次调用时使用 createCliExecutor()
 *   创建执行器，并传入鼠标动画和动作前隐藏的子功能开关
 * - DebugLogger 类：实现 Logger 接口，将日志转发至 logForDebugging
 */
import type {
  ComputerUseHostAdapter,
  Logger,
} from '@ant/computer-use-mcp/types'
import { format } from 'util'
import { logForDebugging } from '../debug.js'
import { COMPUTER_USE_MCP_SERVER_NAME } from './common.js'
import { createCliExecutor } from './executor.js'
import { getChicagoEnabled, getChicagoSubGates } from './gates.js'
import { requireComputerUseSwift } from './swiftLoader.js'

/**
 * 实现 Logger 接口，将所有日志级别的消息转发到 logForDebugging。
 *
 * format() 支持 printf 风格的占位符（如 %s, %d），
 * 与 Node.js util.format 兼容，确保日志消息正确格式化。
 */
class DebugLogger implements Logger {
  /** silly 级别（最详细调试信息）→ debug */
  silly(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'debug' })
  }
  /** debug 级别调试信息 */
  debug(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'debug' })
  }
  /** info 级别信息 */
  info(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'info' })
  }
  /** warn 级别警告 */
  warn(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'warn' })
  }
  /** error 级别错误 */
  error(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'error' })
  }
}

// 进程级单例缓存，避免重复创建原生模块实例
let cached: ComputerUseHostAdapter | undefined

/**
 * 获取进程生命周期内唯一的 ComputerUseHostAdapter 单例。
 *
 * 首次调用时通过 createCliExecutor() 加载原生模块（input + swift）并构建适配器。
 * 原生模块加载失败时直接抛出异常，无降级模式。
 * 后续调用直接返回缓存实例，零额外开销。
 */
export function getComputerUseHostAdapter(): ComputerUseHostAdapter {
  // 已有缓存实例则直接返回，避免重复初始化
  if (cached) return cached
  cached = {
    serverName: COMPUTER_USE_MCP_SERVER_NAME,
    // 日志转发至 logForDebugging（调试模式可见）
    logger: new DebugLogger(),
    // 创建整合 Swift + Rust 原生模块的执行器，传入子功能开关的懒加载 getter
    executor: createCliExecutor({
      getMouseAnimationEnabled: () => getChicagoSubGates().mouseAnimation,
      getHideBeforeActionEnabled: () => getChicagoSubGates().hideBeforeAction,
    }),
    // 检查 macOS TCC 权限（辅助功能 + 屏幕录制）
    ensureOsPermissions: async () => {
      const cu = requireComputerUseSwift()
      const accessibility = cu.tcc.checkAccessibility()
      const screenRecording = cu.tcc.checkScreenRecording()
      // 两项权限均已授权时返回 granted: true，否则返回各项状态供提示用户
      return accessibility && screenRecording
        ? { granted: true }
        : { granted: false, accessibility, screenRecording }
    },
    // 总开关关闭时禁用 Computer Use
    isDisabled: () => !getChicagoEnabled(),
    getSubGates: getChicagoSubGates,
    // cleanup.ts 在每轮结束时始终恢复隐藏的应用，无用户配置项
    getAutoUnhideEnabled: () => true,

    // 像素验证的 JPEG 解码裁剪（必须同步）。
    // Cowork 使用 Electron nativeImage（同步），CLI 的 image-processor-napi 仅异步。
    // 返回 null → 跳过验证，点击继续执行（符合 PixelCompareResult.skipped 设计）。
    // 该子功能开关默认为 false，此处 null 不影响正常流程。
    cropRawPatch: () => null,
  }
  return cached
}
