/**
 * computer-use-swift 原生模块懒加载器（macOS）。
 *
 * 在 Claude Code 系统中，该模块负责按需加载 `@ant/computer-use-swift`（Swift）原生模块，
 * 提供 SCContentFilter 截图、NSWorkspace 应用列表及 TCC 权限请求功能：
 * - requireComputerUseSwift()：首次调用时加载并缓存原生模块，非 macOS 平台抛出异常
 *   注意：captureExcluding、captureRegion、apps.listInstalled、resolvePrepareCapture
 *   为 @MainActor 方法，需通过 drainRunLoop() 泵送 CFRunLoop.main 才能正常执行
 */
import type { ComputerUseAPI } from '@ant/computer-use-swift'

// 懒加载缓存：模块仅加载一次，后续调用直接返回缓存实例，避免重复初始化开销
let cached: ComputerUseAPI | undefined

/**
 * 懒加载并返回 `@ant/computer-use-swift` 原生模块实例（Swift）。
 *
 * 加载细节：
 * - COMPUTER_USE_SWIFT_NODE_PATH 由 build-with-plugins.ts 在 darwin 目标构建时写入，
 *   未设置时回退到 node_modules prebuilds/ 路径（开发环境）
 * - captureExcluding、captureRegion、apps.listInstalled、resolvePrepareCapture
 *   四个 @MainActor 方法会 dispatch 到 DispatchQueue.main 执行；
 *   Electron 下 CFRunLoop 自动抽干主队列，而 Node.js libuv 不抽干，
 *   调用方（executor.ts）必须将这些调用包装在 drainRunLoop() 内，
 *   否则 Promise 永远不会 resolve（挂起）
 */
export function requireComputerUseSwift(): ComputerUseAPI {
  // 仅支持 macOS，其他平台直接抛出异常
  if (process.platform !== 'darwin') {
    throw new Error('@ant/computer-use-swift is macOS-only')
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  // ??= 确保首次 require 后结果缓存，后续调用零开销返回已加载模块
  return (cached ??= require('@ant/computer-use-swift') as ComputerUseAPI)
}

export type { ComputerUseAPI }
