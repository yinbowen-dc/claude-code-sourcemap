/**
 * Claude AI 配额限制状态订阅 Hook
 *
 * 在 Claude Code 系统流程中的位置：
 *   UI 组件挂载 → useClaudeAiLimits() 注册监听器
 *   → claudeAiLimits 模块调用 emitStatusChange() 时触发 setLimits
 *   → React 重新渲染，UI 展示最新的限额提示
 *
 * 主要功能：
 *  - useClaudeAiLimits — React Hook：订阅全局配额限制状态，组件卸载时自动注销
 *
 * 设计特点：
 *  - 初始状态从模块级 currentLimits 同步（避免首次渲染显示空状态）
 *  - useEffect 依赖数组为空，监听器只注册一次（不随渲染次数重复注册）
 *  - 使用 Set（statusListeners）管理多个订阅组件，互不干扰
 *  - 组件卸载时通过 useEffect 返回的清理函数自动注销监听（防内存泄漏）
 */

import { useEffect, useState } from 'react'
import {
  type ClaudeAILimits,
  currentLimits,
  statusListeners,
} from './claudeAiLimits.js'

/**
 * 订阅 Claude AI 配额限制状态的 React Hook。
 *
 * 流程：
 *  1. 使用 currentLimits 的浅拷贝初始化本地状态（避免共享引用导致意外修改）
 *  2. 通过 useEffect 向 statusListeners 注册监听回调
 *  3. 监听回调接收新限制对象时，创建浅拷贝并调用 setLimits 触发重渲染
 *  4. 组件卸载时 useEffect 清理函数从 statusListeners 中删除监听器
 *
 * @returns 当前的 ClaudeAILimits 状态（实时更新）
 */
export function useClaudeAiLimits(): ClaudeAILimits {
  // 初始状态：使用 currentLimits 的浅拷贝（同步获取当前值，避免初始空状态）
  const [limits, setLimits] = useState<ClaudeAILimits>({ ...currentLimits })

  useEffect(() => {
    // 创建监听回调：收到新限制时创建浅拷贝更新本地状态
    // 使用展开运算符确保 React 能检测到对象引用变化，触发重渲染
    const listener = (newLimits: ClaudeAILimits) => {
      setLimits({ ...newLimits })
    }
    // 向全局 Set 注册监听器（多个组件可同时订阅）
    statusListeners.add(listener)

    // 清理函数：组件卸载时自动注销监听器，防止内存泄漏和无效状态更新
    return () => {
      statusListeners.delete(listener)
    }
  }, []) // 空依赖数组：仅在组件挂载/卸载时执行，不随渲染重新注册

  return limits
}
