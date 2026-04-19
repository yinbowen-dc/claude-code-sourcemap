/**
 * 【Skill Hook 注册模块】
 *
 * 本文件在 Claude Code 系统流中的位置：
 *   Skill 启动 → registerSkillHooks（当前文件）→ sessionHooks（会话作用域存储）
 *
 * 主要职责：
 * 1. 将 Skill frontmatter（YAML 头部）中定义的 Hook 注册为会话作用域 Hook
 * 2. 支持 once: true 语义：注册成功一次后自动移除 Hook（单次触发）
 * 3. 传递 skillRoot 路径供 CLAUDE_PLUGIN_ROOT 环境变量使用
 * 4. 输出注册成功数量的 debug 日志，便于问题排查
 *
 * 与 registerFrontmatterHooks 的区别：
 * - 本模块专用于 Skill（技能）的 Hook 注册，增加了 once 支持和 skillRoot 传递
 * - registerFrontmatterHooks 用于 Agent frontmatter，支持 Stop → SubagentStop 转换
 * - 两者都委托 addSessionHook 完成实际注册操作
 */

import { HOOK_EVENTS } from 'src/entrypoints/agentSdkTypes.js'
import type { AppState } from 'src/state/AppState.js'
import { logForDebugging } from '../debug.js'
import type { HooksSettings } from '../settings/types.js'
import { addSessionHook, removeSessionHook } from './sessionHooks.js'

/**
 * 将 Skill frontmatter 中定义的 Hook 注册为会话作用域 Hook。
 * 支持 once: true 语义：Hook 成功执行一次后自动从会话中移除。
 *
 * 处理流程：
 * 1. 遍历所有 HOOK_EVENTS，查找 frontmatter 中对应的 matcher 配置
 * 2. 对每个 hook，若设置了 once: true，则创建 onHookSuccess 回调，
 *    在首次成功执行后调用 removeSessionHook 自动清理
 * 3. 调用 addSessionHook 完成注册，同时传入 skillRoot（用于 CLAUDE_PLUGIN_ROOT）
 * 4. 统计并输出注册数量日志
 *
 * @param setAppState  更新应用状态的函数
 * @param sessionId    当前会话 ID，Hook 注册到此会话作用域
 * @param hooks        Skill frontmatter 中解析出的 HooksSettings 对象
 * @param skillName    Skill 名称（用于日志输出）
 * @param skillRoot    Skill 根目录路径（可选，注入为 CLAUDE_PLUGIN_ROOT 环境变量）
 */
export function registerSkillHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  hooks: HooksSettings,
  skillName: string,
  skillRoot?: string,
): void {
  // 已注册 Hook 数量，用于最终统计日志
  let registeredCount = 0

  // 遍历所有支持的 Hook 事件类型
  for (const eventName of HOOK_EVENTS) {
    const matchers = hooks[eventName]
    // 若该事件无配置，跳过
    if (!matchers) continue

    // 遍历该事件下的所有 matcher 配置
    for (const matcher of matchers) {
      // 遍历该 matcher 下的所有 hook
      for (const hook of matcher.hooks) {
        // 若 hook 设置了 once: true，注册 onHookSuccess 回调
        // 在首次成功执行后自动移除该 Hook（单次触发语义）
        const onHookSuccess = hook.once
          ? () => {
              logForDebugging(
                `Removing one-shot hook for event ${eventName} in skill '${skillName}'`,
              )
              // 调用 removeSessionHook 从会话中精确删除此 hook
              removeSessionHook(setAppState, sessionId, eventName, hook)
            }
          : undefined

        // 注册 hook 到会话，同时传入 onHookSuccess 回调和 skillRoot
        addSessionHook(
          setAppState,
          sessionId,
          eventName,
          matcher.matcher || '', // matcher 为空时匹配所有工具/操作
          hook,
          onHookSuccess,
          skillRoot, // 供执行时设置 CLAUDE_PLUGIN_ROOT 环境变量
        )
        registeredCount++
      }
    }
  }

  // 注册完成后输出统计日志
  if (registeredCount > 0) {
    logForDebugging(
      `Registered ${registeredCount} hooks from skill '${skillName}'`,
    )
  }
}
