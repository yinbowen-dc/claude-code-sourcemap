/**
 * 【文件定位】修饰键检测模块 — Claude Code 交互层的键盘状态感知组件
 *
 * 在 Claude Code 的系统架构中，本文件处于"用户输入感知"环节：
 *   用户按键操作 → [本模块：检测修饰键状态] → UI 交互逻辑（如 Shift+Enter 换行）
 *
 * 主要职责：
 *   1. 通过 macOS 原生 NAPI 模块（modifiers-napi）同步读取当前修饰键状态
 *   2. 提供预热接口，在首次使用前提前加载原生模块，避免首次调用延迟
 *   3. 仅在 macOS (darwin) 平台生效，其他平台直接返回 false
 *
 * 注意：modifiers-napi 是一个原生 Node.js 扩展，在非 macOS 系统不可用。
 * 惰性加载（dynamic require）策略确保原生模块不会在顶层被提前引入。
 */

// 支持检测的修饰键类型枚举
export type ModifierKey = 'shift' | 'command' | 'control' | 'option'

// 模块级预热状态标志，确保预热操作只执行一次
let prewarmed = false

/**
 * 预热原生修饰键模块（提前加载，消除首次调用的延迟）。
 *
 * 调用时机：应在应用启动早期（如 bootstrap 阶段）调用，
 * 以便在用户真正触发快捷键检测时，模块已经就绪。
 *
 * 流程：
 *   1. 检查是否已预热或非 macOS 平台 → 直接返回
 *   2. 设置预热标志（防止重复调用）
 *   3. 动态 require 原生模块并调用其 prewarm() 方法
 *   4. 如果加载失败，静默忽略错误（不影响功能，只是首次调用会稍慢）
 */
export function prewarmModifiers(): void {
  // 非 macOS 平台（如 Windows/Linux）没有该原生模块，直接跳过
  if (prewarmed || process.platform !== 'darwin') {
    return
  }
  // 置位，防止多次预热
  prewarmed = true
  // 在后台异步加载原生模块
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { prewarm } = require('modifiers-napi') as { prewarm: () => void }
    prewarm()
  } catch {
    // 预热失败不影响功能，仅影响首次检测的响应速度
  }
}

/**
 * 同步检测指定修饰键当前是否被按下（实时查询系统按键状态）。
 *
 * 使用场景：
 *   - 检测 Shift 是否按下，用于"Shift+Enter 发送"等交互逻辑
 *   - 检测 Command/Control/Option 键，用于键盘快捷键处理
 *
 * 实现原理：调用 macOS Cocoa 原生 API 获取实时键盘状态，是同步操作，
 * 不涉及事件监听，因此每次调用都反映最新的按键状态。
 *
 * @param modifier - 要检测的修饰键名称
 * @returns 若该键当前被按下返回 true，非 macOS 平台或未按下返回 false
 */
export function isModifierPressed(modifier: ModifierKey): boolean {
  // 非 macOS 平台无原生支持，直接返回 false
  if (process.platform !== 'darwin') {
    return false
  }
  // 惰性加载：只在首次实际检测时才引入原生模块（避免顶层 import 的加载开销）
  const { isModifierPressed: nativeIsModifierPressed } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('modifiers-napi') as { isModifierPressed: (m: string) => boolean }
  // 调用底层原生函数实时查询键盘状态
  return nativeIsModifierPressed(modifier)
}
