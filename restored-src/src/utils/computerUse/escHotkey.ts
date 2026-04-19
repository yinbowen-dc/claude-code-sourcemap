/**
 * Esc 全局热键注册模块（macOS CGEventTap）。
 *
 * 在 Claude Code 系统中，该模块通过 CGEventTap 注册全局 Escape 键监听，
 * 用于在 Computer Use 工具执行期间允许用户随时中止操作，同时作为提示注入防御：
 * - registerEscHotkey()：注册 CGEventTap Esc 监听，接受中止回调
 * - unregisterEscHotkey()：注销 CGEventTap 监听
 * - notifyExpectedEscape()：在程序主动发送 Esc 键时提前通知，避免误触发中止
 */
import { logForDebugging } from '../debug.js'

/**
 * 全局 Escape → 中止。镜像 Cowork 的 `escAbort.ts`，但不使用 Electron：
 * 通过 `@ant/computer-use-swift` 实现 CGEventTap。注册期间 Escape 键
 * 在全系统范围内被消费（提示注入防御 —— 被注入的操作无法通过 Escape 关闭对话框）。
 *
 * 生命周期：在首次获取锁时注册（`wrapper.tsx` `acquireCuLock`），
 * 在锁释放时注销（`cleanup.ts`）。tap 的 CFRunLoopSource 位于
 * CFRunLoopGetMain() 的 .defaultMode，因此在注册存续期间
 * 持有 drainRunLoop 泵引用 —— 与 `@MainActor` 方法使用同一个带引用计数的 setInterval。
 *
 * `notifyExpectedEscape()` 为模型合成的 Escape 打一个豁免孔：
 * executor 的 `key("escape")` 在发送 CGEvent 前调用此函数。
 * Swift 设置 100ms 衰减时间，防止未到达 tap 回调的 CGEvent 消耗掉下一个用户 ESC。
 */

// 标记当前 CGEventTap Esc 监听是否已注册，防止重复注册
let registered = false

/**
 * 注册全局 Escape 热键监听（CGEventTap）。
 *
 * 首次调用时通过 Swift 层建立 CGEventTap，将系统级 Esc 键路由到 onEscape 回调。
 * 同时调用 retainPump() 增加 CFRunLoop 泵引用计数，确保事件循环在注册期间持续运行。
 * 若 CGEvent.tapCreate 失败（通常因缺少辅助功能权限），降级处理：记录警告并返回 false，
 * Computer Use 主功能仍可正常运行，只是失去 Esc 中止能力。
 */
export function registerEscHotkey(onEscape: () => void): boolean {
  // 幂等：已注册则直接返回，避免重复建立 tap
  if (registered) return true
  const cu = requireComputerUseSwift()
  if (!cu.hotkey.registerEscape(onEscape)) {
    // CGEvent.tapCreate 失败——通常是缺少辅助功能（Accessibility）权限。
    // CU 仍可运行，只是无法通过 ESC 中止。对应 Cowork 的 escAbort.ts:81。
    // tapCreate 失败，通常是缺少辅助功能（Accessibility）权限，降级处理
    logForDebugging('[cu-esc] registerEscape returned false', { level: 'warn' })
    return false
  }
  // 增加 CFRunLoop 泵引用计数，防止事件循环在注册期间被释放
  retainPump()
  registered = true
  logForDebugging('[cu-esc] registered')
  return true
}

/**
 * 注销全局 Escape 热键监听（CGEventTap）。
 *
 * 通过 Swift 层拆除 CGEventTap，并在 finally 块中释放 CFRunLoop 泵引用计数，
 * 确保即使 unregister 抛出异常也能正确更新状态，避免引用计数泄漏。
 */
export function unregisterEscHotkey(): void {
  // 未注册时直接返回，防止重复注销
  if (!registered) return
  try {
    requireComputerUseSwift().hotkey.unregister()
  } finally {
    // 无论 unregister 是否成功，都释放泵引用并重置状态
    releasePump()
    registered = false
    logForDebugging('[cu-esc] unregistered')
  }
}

/**
 * 通知 CGEventTap 下一个 Escape 事件是模型主动合成的（而非用户中止操作）。
 *
 * executor.ts 在通过 enigo 发送 key("escape") 前调用此函数，
 * 向 Swift 侧打一个 100ms 的豁免孔，防止 tap 回调将该合成 Esc 误判为用户中止请求。
 */
export function notifyExpectedEscape(): void {
  // 未注册时不需要通知（tap 不存在，不会误触发）
  if (!registered) return
  requireComputerUseSwift().hotkey.notifyExpectedEscape()
}
