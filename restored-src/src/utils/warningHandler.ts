/**
 * Node.js 进程警告处理器模块。
 *
 * 在 Claude Code 系统流程中的位置：
 * 此模块是运行时健康监控层，在应用启动时通过 initializeWarningHandler()
 * 初始化，拦截 Node.js 进程警告（process 'warning' 事件）。
 * 被主入口点（entrypoints）在初始化阶段调用。
 *
 * 主要功能：
 * - 在生产环境中移除默认 Node.js 警告输出（抑制 stderr 噪音）
 * - 将警告上报到 Statsig 分析系统（tengu_node_warning 事件）
 * - 对已知内部警告（MaxListenersExceededWarning）静默处理
 * - 通过有界 Map（最多 1000 个键）去重并计数警告出现次数
 * - 调试模式（CLAUDE_DEBUG=true）下通过 logForDebugging 输出警告详情
 */

import { posix, win32 } from 'path'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { getPlatform } from './platform.js'

// 防止无限制内存增长：警告键最多缓存 1000 个
export const MAX_WARNING_KEYS = 1000
// 警告键 → 出现次数的有界映射
const warningCounts = new Map<string, number>()

/**
 * 检测当前是否从构建目录运行（开发模式判断）。
 * 这是 getCurrentInstallationType() 逻辑的同步版本，避免异步调用。
 *
 * 流程：
 * 1. 获取 process.argv[1]（调用路径）和 process.execPath（可执行路径）
 * 2. Windows 环境下将反斜杠转为正斜杠以统一路径匹配
 * 3. 检查这两个路径是否包含任意构建目录子串
 *
 * @returns 若从开发构建目录运行则返回 true
 */
function isRunningFromBuildDirectory(): boolean {
  let invokedPath = process.argv[1] || ''
  let execPath = process.execPath || process.argv[0] || ''

  // Windows 下统一路径分隔符，确保后续 includes 匹配一致
  if (getPlatform() === 'windows') {
    invokedPath = invokedPath.split(win32.sep).join(posix.sep)
    execPath = execPath.split(win32.sep).join(posix.sep)
  }

  const pathsToCheck = [invokedPath, execPath]
  // 已知的内部开发构建目录标识
  const buildDirs = [
    '/build-ant/',
    '/build-external/',
    '/build-external-native/',
    '/build-ant-native/',
  ]

  // 任一路径包含任一构建目录标识，则判定为开发模式
  return pathsToCheck.some(path => buildDirs.some(dir => path.includes(dir)))
}

// 已知内部警告模式：这些警告会被分析上报但不展示给用户
const INTERNAL_WARNINGS = [
  /MaxListenersExceededWarning.*AbortSignal/,
  /MaxListenersExceededWarning.*EventTarget/,
]

/**
 * 判断警告是否属于已知内部警告。
 *
 * @param warning 要检查的警告对象
 * @returns 若匹配内部警告模式则返回 true
 */
function isInternalWarning(warning: Error): boolean {
  // 将警告转为 "name: message" 格式后逐一匹配模式
  const warningStr = `${warning.name}: ${warning.message}`
  return INTERNAL_WARNINGS.some(pattern => pattern.test(warningStr))
}

// 存储当前安装的警告处理器引用，用于检测重复安装
let warningHandler: ((warning: Error) => void) | null = null

/**
 * 重置警告处理器（仅用于测试）。
 * 移除当前处理器并清空计数映射。
 */
export function resetWarningHandler(): void {
  if (warningHandler) {
    process.removeListener('warning', warningHandler)
  }
  warningHandler = null
  warningCounts.clear()
}

/**
 * 初始化 Node.js 进程警告处理器。
 *
 * 流程：
 * 1. 检查是否已安装处理器，避免重复安装
 * 2. 非开发模式下移除默认 Node.js 警告处理器（抑制 stderr 输出）
 * 3. 创建自定义处理器：去重计数 → 分析上报 → 调试日志
 * 4. 将处理器注册到 process 'warning' 事件
 */
export function initializeWarningHandler(): void {
  // 检查是否已安装：防止同一处理器被多次注册
  const currentListeners = process.listeners('warning')
  if (warningHandler && currentListeners.includes(warningHandler)) {
    return
  }

  // 开发模式保留默认警告输出；生产模式移除以避免 stderr 噪音
  const isDevelopment =
    process.env.NODE_ENV === 'development' || isRunningFromBuildDirectory()
  if (!isDevelopment) {
    // 移除 Node.js 默认的 warning 事件处理器，禁止 stderr 输出
    process.removeAllListeners('warning')
  }

  // 创建自定义警告处理器并存储引用
  warningHandler = (warning: Error) => {
    try {
      // 使用前 50 个字符构造警告键，平衡唯一性和内存占用
      const warningKey = `${warning.name}: ${warning.message.slice(0, 50)}`
      const count = warningCounts.get(warningKey) || 0

      // 有界计数：达到上限后新的唯一键不再追踪（analytics 会上报 count=1）
      if (
        warningCounts.has(warningKey) ||
        warningCounts.size < MAX_WARNING_KEYS
      ) {
        warningCounts.set(warningKey, count + 1)
      }

      const isInternal = isInternalWarning(warning)

      // 始终上报到 Statsig 进行监控
      // 仅对 ant 用户包含完整 message（可能含代码或文件路径）
      logEvent('tengu_node_warning', {
        is_internal: isInternal ? 1 : 0,       // 是否为已知内部警告
        occurrence_count: count + 1,            // 当前出现次数
        classname:
          warning.name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        ...(process.env.USER_TYPE === 'ant' && {
          // ant 用户才上报 message，避免外部用户的敏感信息泄漏
          message:
            warning.message as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        }),
      })

      // 调试模式下将警告输出到日志
      if (isEnvTruthy(process.env.CLAUDE_DEBUG)) {
        const prefix = isInternal ? '[Internal Warning]' : '[Warning]'
        logForDebugging(`${prefix} ${warning.toString()}`, { level: 'warn' })
      }
      // 对用户隐藏所有警告：仅上报 Statsig 用于监控
    } catch {
      // 处理器内部异常静默忽略，防止警告处理器本身引发问题
    }
  }

  // 注册自定义警告处理器
  process.on('warning', warningHandler)
}
