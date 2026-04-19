/**
 * @file hooks/use-input.ts
 * @description 终端键盘输入处理 Hook，是 Ink 组件监听用户按键的主要接口。
 *
 * 在 Claude Code 的 Ink 渲染流水线中，本文件属于「输入事件订阅」层：
 *   终端 stdin → StdinContext（解析为 InputEvent） → useInput（本文件） → 组件回调
 *                                                         ↑
 *                                              useStdin（获取事件发射器）
 *
 * 主要职责：
 *  1. 通过 useLayoutEffect 同步开启/关闭终端原始模式（raw mode），
 *     确保在 React commit 阶段即生效，避免按键回显和光标可见的闪烁窗口。
 *  2. 在 EventEmitter 上注册稳定的监听器，防止 stopImmediatePropagation 顺序被破坏。
 *  3. 根据 isActive 选项决定是否处理输入，支持多个 useInput 实例共存时的优先级控制。
 *  4. 过滤 Ctrl+C（当应用配置为不退出时），将其交给监听器处理。
 */

import { useEffect, useLayoutEffect } from 'react'
import { useEventCallback } from 'usehooks-ts'
import type { InputEvent, Key } from '../events/input-event.js'
import useStdin from './use-stdin.js'

/** 输入事件处理器签名：接收原始字符串、结构化按键信息和完整事件对象 */
type Handler = (input: string, key: Key, event: InputEvent) => void

type Options = {
  /**
   * 是否启用此 Hook 的输入捕获。
   * 当多个 useInput Hook 同时存在时，可通过此选项避免重复处理同一输入。
   *
   * @default true
   */
  isActive?: boolean
}

/**
 * 终端键盘输入 Hook。
 *
 * 流程：
 *  1. useLayoutEffect（同步）：isActive 为 true 时调用 setRawMode(true)，
 *     确保在 commit 阶段就进入原始模式，避免按键回显。
 *  2. useEventCallback 创建稳定引用的事件回调，内部读取最新的 isActive 和 inputHandler，
 *     但引用本身不随渲染变化，保证在 EventEmitter 中的位置固定。
 *  3. useEffect（异步）：在 EventEmitter 上注册/注销 'input' 监听器。
 *     监听器仅在组件挂载时注册一次，不因 isActive 变化而移动位置。
 *
 * 为什么用 useLayoutEffect 而非 useEffect 开启 raw mode：
 *  useEffect 是异步的（通过 React 调度器延迟到下一个事件循环），
 *  在此期间终端处于 cooked 模式，按键会回显且光标可见，造成视觉抖动。
 *  useLayoutEffect 在 DOM commit 阶段同步执行，彻底消除这个时间窗口。
 *
 * 为什么监听器不随 isActive 重新注册：
 *  若将 isActive 放入 useEffect 的 deps，false→true 切换时监听器会重新追加到队列末尾，
 *  破坏了 stopImmediatePropagation 依赖的监听器顺序。
 *  useEventCallback 通过 useLayoutEffect 同步更新闭包，兼顾稳定引用和最新状态读取。
 *
 * @param inputHandler 键盘输入回调，参数为 (input, key, event)
 * @param options      配置项，目前仅 isActive（默认 true）
 */
const useInput = (inputHandler: Handler, options: Options = {}) => {
  // 从 StdinContext 获取 raw mode 控制函数、Ctrl+C 退出配置和事件发射器
  const { setRawMode, internal_exitOnCtrlC, internal_eventEmitter } = useStdin()

  // 使用 useLayoutEffect（非 useEffect）以在 React commit 阶段同步设置 raw mode，
  // 避免终端在 cooked 模式下的短暂窗口（按键回显 + 光标可见）
  useLayoutEffect(() => {
    // isActive 显式为 false 时不进入 raw mode
    if (options.isActive === false) {
      return
    }

    // 进入 raw mode：禁用按键回显，逐字符读取输入
    setRawMode(true)

    return () => {
      // cleanup：退出 raw mode，恢复终端正常模式
      setRawMode(false)
    }
  }, [options.isActive, setRawMode])

  // 创建稳定引用的事件回调：
  //  - 引用稳定 → 在 EventEmitter 的监听器数组中位置固定，stopImmediatePropagation 顺序正确
  //  - useEventCallback 通过内部 useLayoutEffect 同步更新闭包 → 读取最新 isActive/inputHandler
  const handleData = useEventCallback((event: InputEvent) => {
    // 若当前实例未激活，忽略此次输入（让其他 useInput 实例处理）
    if (options.isActive === false) {
      return
    }
    const { input, key } = event

    // Ctrl+C 特殊处理：若应用配置为不因 Ctrl+C 退出，则将其交给 inputHandler 处理
    // 注意：App 层在 emit 事件时已调用 discreteUpdates，所有监听器均在高优先级更新上下文中
    if (!(input === 'c' && key.ctrl) || !internal_exitOnCtrlC) {
      inputHandler(input, key, event)
    }
  })

  useEffect(() => {
    // 挂载时注册监听器（仅一次，不依赖 isActive，保持队列位置稳定）
    internal_eventEmitter?.on('input', handleData)

    return () => {
      // 卸载时注销监听器，防止内存泄漏
      internal_eventEmitter?.removeListener('input', handleData)
    }
  }, [internal_eventEmitter, handleData])
}

export default useInput
