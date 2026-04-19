/**
 * 【Frontmatter Hook 注册模块】
 *
 * 本文件在 Claude Code 系统流中的位置：
 *   Agent/Skill 启动 → registerFrontmatterHooks（当前文件）→ sessionHooks（会话作用域存储）
 *
 * 主要职责：
 * 1. 将 Agent 或 Skill 的 frontmatter（YAML 头部）中定义的 Hook 注册为会话作用域 Hook
 * 2. 处理 Agent 场景下的事件转换：将 Stop Hook 自动转换为 SubagentStop Hook
 *    （Agent 完成时触发的是 SubagentStop 而非 Stop）
 * 3. 遍历所有 HOOK_EVENTS，逐一解析 matcher 配置并注册到会话
 *
 * 设计要点：
 * - isAgent=true 时对 Stop 事件做自动转换，确保 Agent 生命周期结束时 Hook 能正确触发
 * - 注册操作委托给 addSessionHook，利用其 Map 的 O(1) 特性避免状态复制
 * - 注册完成后输出 debug 日志，包含 Hook 数量和来源名称，便于排查问题
 */

import { HOOK_EVENTS, type HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { AppState } from 'src/state/AppState.js'
import { logForDebugging } from '../debug.js'
import type { HooksSettings } from '../settings/types.js'
import { addSessionHook } from './sessionHooks.js'

/**
 * 将 frontmatter（来自 Agent 或 Skill）中定义的 Hook 注册为会话作用域 Hook。
 * 这些 Hook 在会话/Agent 运行期间有效，会话结束时自动清理。
 *
 * 处理流程：
 * 1. 若 hooks 为空，直接返回
 * 2. 遍历所有 HOOK_EVENTS，查找 frontmatter 中对应的 matcher 配置
 * 3. 若 isAgent=true 且事件为 'Stop'，转换为 'SubagentStop'（Agent 完成时触发 SubagentStop）
 * 4. 对每个 matcher 下的每个 hook 调用 addSessionHook 注册
 * 5. 输出注册成功的 debug 日志
 *
 * @param setAppState  更新应用状态的函数
 * @param sessionId    Hook 作用域的会话 ID（Agent 为 agentId，Skill 为 sessionId）
 * @param hooks        frontmatter 中解析出的 HooksSettings 对象
 * @param sourceName   人类可读的来源名称（如 "agent 'my-agent'"），用于日志
 * @param isAgent      若为 true，将 Stop Hook 转换为 SubagentStop Hook
 */
export function registerFrontmatterHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  hooks: HooksSettings,
  sourceName: string,
  isAgent: boolean = false,
): void {
  // 若 hooks 对象为空，直接返回，无需进一步处理
  if (!hooks || Object.keys(hooks).length === 0) {
    return
  }

  // 记录已注册 Hook 数量，用于最终统计日志
  let hookCount = 0

  // 遍历所有支持的 Hook 事件类型
  for (const event of HOOK_EVENTS) {
    const matchers = hooks[event]
    // 若该事件没有配置 matcher，跳过
    if (!matchers || matchers.length === 0) {
      continue
    }

    // Agent 场景下将 Stop 转换为 SubagentStop：
    // Agent 完成时触发的是 SubagentStop（通过 executeStopHooks 传入 agentId 调用）
    let targetEvent: HookEvent = event
    if (isAgent && event === 'Stop') {
      targetEvent = 'SubagentStop'
      logForDebugging(
        `Converting Stop hook to SubagentStop for ${sourceName} (subagents trigger SubagentStop)`,
      )
    }

    // 遍历该事件下的所有 matcher 配置
    for (const matcherConfig of matchers) {
      // matcher 为空字符串时匹配所有工具/操作
      const matcher = matcherConfig.matcher ?? ''
      const hooksArray = matcherConfig.hooks

      // 若该 matcher 下没有 hooks，跳过
      if (!hooksArray || hooksArray.length === 0) {
        continue
      }

      // 将每个 hook 逐一注册到会话
      for (const hook of hooksArray) {
        addSessionHook(setAppState, sessionId, targetEvent, matcher, hook)
        hookCount++
      }
    }
  }

  // 注册完成后输出统计日志
  if (hookCount > 0) {
    logForDebugging(
      `Registered ${hookCount} frontmatter hook(s) from ${sourceName} for session ${sessionId}`,
    )
  }
}
