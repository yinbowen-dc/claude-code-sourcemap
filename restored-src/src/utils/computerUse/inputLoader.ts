/**
 * computer-use-input 原生模块懒加载器（macOS）。
 *
 * 在 Claude Code 系统中，该模块负责按需加载 `@ant/computer-use-input`（Rust/enigo）原生模块，
 * 提供鼠标移动、点击、键盘输入及前台应用控制功能：
 * - requireComputerUseInput()：首次调用时加载并缓存原生模块，非 macOS 平台抛出异常
 */
import type {
  ComputerUseInput,
  ComputerUseInputAPI,
} from '@ant/computer-use-input'

// 懒加载缓存：模块仅加载一次，后续调用直接返回缓存实例
let cached: ComputerUseInputAPI | undefined

/**
 * 懒加载并返回 `@ant/computer-use-input` 原生模块实例（Rust/enigo）。
 *
 * 加载细节：
 * - COMPUTER_USE_INPUT_NODE_PATH 由 build-with-plugins.ts 在 darwin 目标构建时写入，
 *   未设置时回退到 node_modules prebuilds/ 路径
 * - 包导出带有 isSupported 判别联合类型，此处收窄一次，调用方无需重复检查
 * - key()/keys() 通过 dispatch2::run_on_main 将 enigo 工作派发到 DispatchQueue.main，
 *   再在 tokio worker 上阻塞等待 channel。Electron 下 CFRunLoop 会持续抽干主队列；
 *   Node/Bun 的 libuv 不抽干主队列，Promise 会挂起。
 *   调用方（executor.ts）必须将这些调用包装在 drainRunLoop() 内。
 */
export function requireComputerUseInput(): ComputerUseInputAPI {
  // 已有缓存则直接返回，避免重复 require
  if (cached) return cached
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const input = require('@ant/computer-use-input') as ComputerUseInput
  // isSupported 为 false 表示当前平台不受支持（仅 macOS 支持）
  if (!input.isSupported) {
    throw new Error('@ant/computer-use-input is not supported on this platform')
  }
  return (cached = input)
}
