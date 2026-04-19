/**
 * 【会话作用域 Hook 存储模块】
 *
 * 本文件在 Claude Code 系统流中的位置：
 *   Hook 注册（registerFrontmatterHooks / registerSkillHooks / hookHelpers）
 *     → sessionHooks（当前文件，会话作用域存储）
 *     → Hook 执行引擎（hooks.ts）
 *
 * 主要职责：
 * 1. 定义核心类型：FunctionHook、SessionHookMatcher、SessionStore、SessionHooksState
 * 2. 提供 addSessionHook：注册命令/提示 Hook 到会话
 * 3. 提供 addFunctionHook：注册内存回调 Hook，返回唯一 ID
 * 4. 提供 removeFunctionHook：按 ID 精确删除函数 Hook
 * 5. 提供 removeSessionHook：按内容等值比较删除命令/提示 Hook
 * 6. 提供 clearSessionHooks：清除指定会话的所有 Hook
 * 7. 提供 getSessionHooks / getSessionFunctionHooks：分别获取命令类和函数类 Hook
 * 8. 提供 getSessionHookCallback：获取 hook 的完整条目（含 onHookSuccess 回调）
 * 9. 提供 convertToHookMatchers：将内部 SessionHookMatcher 转为外部 HookMatcher 格式
 *
 * 关键设计：
 * - SessionHooksState 使用 Map<string, SessionStore> 而非 Record，
 *   使得 .set()/.delete() 操作为 O(1) 且不改变容器身份，
 *   从而让 store.ts 的 Object.is(next, prev) 检查短路，避免触发监听器通知。
 *   在高并发（如 parallel() N 个 schema-mode agents 并发调用 addFunctionHook）场景下，
 *   Record+spread 会产生 O(N²) 复制开销并触发所有 ~30 个监听器；Map 则全程 O(1)。
 * - FunctionHook 仅存在于内存中，无法序列化到 settings.json
 */

import { HOOK_EVENTS, type HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { AppState } from 'src/state/AppState.js'
import type { Message } from 'src/types/message.js'
import { logForDebugging } from '../debug.js'
import type { AggregatedHookResult } from '../hooks.js'
import type { HookCommand } from '../settings/types.js'
import { isHookEqual } from './hooksSettings.js'

/**
 * Hook 成功回调类型。
 * 在 hook 执行成功后调用，用于 once: true 的自动移除逻辑。
 */
type OnHookSuccess = (
  hook: HookCommand | FunctionHook,
  result: AggregatedHookResult,
) => void

/**
 * 函数 Hook 回调类型。
 * 接收消息历史和可选的中断信号，返回布尔值（true 表示通过，false 表示阻断）。
 */
export type FunctionHookCallback = (
  messages: Message[],
  signal?: AbortSignal,
) => boolean | Promise<boolean>

/**
 * 函数 Hook 类型：嵌入了 TypeScript 回调的内存 Hook。
 * 仅存在于会话运行期间，无法持久化到 settings.json。
 *
 * 字段说明：
 * - type: 'function'  — 固定标识符，用于与 HookCommand 区分
 * - id              — 可选唯一 ID，用于精确删除
 * - timeout         — 执行超时（毫秒），防止回调无限阻塞
 * - callback        — 实际执行的 TypeScript 函数
 * - errorMessage    — 校验失败时向模型发送的错误提示
 * - statusMessage   — 可选的执行状态提示
 */
export type FunctionHook = {
  type: 'function'
  id?: string // 可选唯一 ID，用于删除
  timeout?: number
  callback: FunctionHookCallback
  errorMessage: string
  statusMessage?: string
}

/**
 * 会话 Hook Matcher 内部类型。
 * 包含 matcher 字符串、可选的 skillRoot 路径，以及该 matcher 下的所有 hook 及其回调。
 */
type SessionHookMatcher = {
  matcher: string
  skillRoot?: string
  hooks: Array<{
    hook: HookCommand | FunctionHook
    onHookSuccess?: OnHookSuccess
  }>
}

/**
 * 单个会话的 Hook 存储结构。
 * 按事件类型分组存储 SessionHookMatcher 数组。
 */
export type SessionStore = {
  hooks: {
    [event in HookEvent]?: SessionHookMatcher[]
  }
}

/**
 * 全局会话 Hook 状态类型。
 *
 * 使用 Map<string, SessionStore> 而非 Record 的原因：
 * - Map.set() / Map.delete() 在原地修改容器，不改变 Map 对象本身的引用
 * - store.ts 的 Object.is(next, prev) 检查因此短路，不触发监听器通知
 * - 高并发场景（N 个 agent 并发 addFunctionHook）下，Map 为 O(1) vs Record+spread 的 O(N²)
 * - 与 LocalWorkflowTaskState 上的 agentControllers 设计模式一致
 *
 * 会话 Hook 是短暂的运行时回调，仅通过 getAppState() 快照访问，不需要响应式读取。
 */
export type SessionHooksState = Map<string, SessionStore>

/**
 * 向会话添加命令或提示 Hook。
 * 会话 Hook 是临时的、仅存于内存中的，会话结束时自动清理。
 *
 * @param setAppState    更新应用状态的函数
 * @param sessionId      Hook 注册的目标会话 ID
 * @param event          Hook 触发的事件类型
 * @param matcher        工具/操作匹配字符串（空字符串匹配所有）
 * @param hook           要注册的 HookCommand
 * @param onHookSuccess  执行成功后的回调（如 once: true 的自动移除）
 * @param skillRoot      Skill 根目录（可选，注入为 CLAUDE_PLUGIN_ROOT）
 */
export function addSessionHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  hook: HookCommand,
  onHookSuccess?: OnHookSuccess,
  skillRoot?: string,
): void {
  // 委托给内部 addHookToSession 函数处理实际注册逻辑
  addHookToSession(
    setAppState,
    sessionId,
    event,
    matcher,
    hook,
    onHookSuccess,
    skillRoot,
  )
}

/**
 * 向会话添加函数 Hook（内存回调）。
 * 函数 Hook 执行 TypeScript 回调进行内存校验（不调用外部进程/LLM）。
 *
 * @param setAppState    更新应用状态的函数
 * @param sessionId      目标会话 ID
 * @param event          Hook 触发的事件类型
 * @param matcher        工具/操作匹配字符串
 * @param callback       校验回调：返回 true 通过，false 阻断
 * @param errorMessage   校验失败时发给模型的错误信息
 * @param options        可选配置：timeout（超时毫秒）和 id（自定义 ID）
 * @returns              Hook 的唯一 ID（可用于后续移除）
 */
export function addFunctionHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  callback: FunctionHookCallback,
  errorMessage: string,
  options?: {
    timeout?: number
    id?: string
  },
): string {
  // 生成唯一 ID：优先使用自定义 ID，否则用时间戳+随机数
  const id = options?.id || `function-hook-${Date.now()}-${Math.random()}`
  const hook: FunctionHook = {
    type: 'function',
    id,
    timeout: options?.timeout || 5000, // 默认超时 5 秒
    callback,
    errorMessage,
  }
  // 注册到会话（不传 onHookSuccess 和 skillRoot）
  addHookToSession(setAppState, sessionId, event, matcher, hook)
  return id
}

/**
 * 按 ID 从会话中删除函数 Hook。
 * 只删除指定事件下匹配 ID 的函数 Hook，不影响其他 Hook。
 *
 * @param setAppState  更新应用状态的函数
 * @param sessionId    目标会话 ID
 * @param event        Hook 所在的事件类型
 * @param hookId       要删除的函数 Hook ID
 */
export function removeFunctionHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  hookId: string,
): void {
  setAppState(prev => {
    const store = prev.sessionHooks.get(sessionId)
    if (!store) {
      // 会话不存在，直接返回原状态
      return prev
    }

    const eventMatchers = store.hooks[event] || []

    // 从所有 matcher 中过滤掉匹配 hookId 的函数 Hook
    const updatedMatchers = eventMatchers
      .map(matcher => {
        const updatedHooks = matcher.hooks.filter(h => {
          // 非函数 Hook 保留
          if (h.hook.type !== 'function') return true
          // 函数 Hook 中，保留 ID 不匹配的
          return h.hook.id !== hookId
        })

        // 若该 matcher 下还有 hook，返回更新后的 matcher；否则返回 null（待过滤）
        return updatedHooks.length > 0
          ? { ...matcher, hooks: updatedHooks }
          : null
      })
      .filter((m): m is SessionHookMatcher => m !== null)

    // 重建 hooks 对象：若该事件下无 matcher，则移除该事件键
    const newHooks =
      updatedMatchers.length > 0
        ? { ...store.hooks, [event]: updatedMatchers }
        : Object.fromEntries(
            Object.entries(store.hooks).filter(([e]) => e !== event),
          )

    // 原地修改 Map（O(1)，不触发监听器通知）
    prev.sessionHooks.set(sessionId, { hooks: newHooks })
    return prev
  })

  logForDebugging(
    `Removed function hook ${hookId} for event ${event} in session ${sessionId}`,
  )
}

/**
 * 内部辅助函数：将 hook 添加到会话状态。
 * 实现 addSessionHook 和 addFunctionHook 共享的核心注册逻辑。
 *
 * 策略：
 * - 若该 (matcher, skillRoot) 组合已存在，则向其 hooks 数组追加
 * - 否则创建新的 SessionHookMatcher 条目
 * - 使用 Map.set() 原地修改，避免触发监听器
 */
function addHookToSession(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  hook: HookCommand | FunctionHook,
  onHookSuccess?: OnHookSuccess,
  skillRoot?: string,
): void {
  setAppState(prev => {
    // 获取或初始化该会话的 SessionStore
    const store = prev.sessionHooks.get(sessionId) ?? { hooks: {} }
    const eventMatchers = store.hooks[event] || []

    // 查找是否已存在相同 (matcher, skillRoot) 的 SessionHookMatcher
    const existingMatcherIndex = eventMatchers.findIndex(
      m => m.matcher === matcher && m.skillRoot === skillRoot,
    )

    let updatedMatchers: SessionHookMatcher[]
    if (existingMatcherIndex >= 0) {
      // 已存在：向该 matcher 追加 hook
      updatedMatchers = [...eventMatchers]
      const existingMatcher = updatedMatchers[existingMatcherIndex]!
      updatedMatchers[existingMatcherIndex] = {
        matcher: existingMatcher.matcher,
        skillRoot: existingMatcher.skillRoot,
        hooks: [...existingMatcher.hooks, { hook, onHookSuccess }],
      }
    } else {
      // 不存在：创建新的 matcher 条目
      updatedMatchers = [
        ...eventMatchers,
        {
          matcher,
          skillRoot,
          hooks: [{ hook, onHookSuccess }],
        },
      ]
    }

    const newHooks = { ...store.hooks, [event]: updatedMatchers }

    // 原地修改 Map，不改变 Map 容器的引用（O(1)，不触发监听器）
    prev.sessionHooks.set(sessionId, { hooks: newHooks })
    return prev
  })

  logForDebugging(
    `Added session hook for event ${event} in session ${sessionId}`,
  )
}

/**
 * 按内容等值比较，从会话中删除指定的命令/提示 Hook。
 * 使用 isHookEqual 进行精确匹配，不影响其他 Hook。
 *
 * @param setAppState  更新应用状态的函数
 * @param sessionId    目标会话 ID
 * @param event        Hook 所在的事件类型
 * @param hook         要删除的 HookCommand（按内容匹配）
 */
export function removeSessionHook(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  event: HookEvent,
  hook: HookCommand,
): void {
  setAppState(prev => {
    const store = prev.sessionHooks.get(sessionId)
    if (!store) {
      // 会话不存在，直接返回原状态
      return prev
    }

    const eventMatchers = store.hooks[event] || []

    // 从所有 matcher 中过滤掉与目标 hook 等值的条目
    const updatedMatchers = eventMatchers
      .map(matcher => {
        // 使用 isHookEqual 进行深度比较
        const updatedHooks = matcher.hooks.filter(
          h => !isHookEqual(h.hook, hook),
        )

        return updatedHooks.length > 0
          ? { ...matcher, hooks: updatedHooks }
          : null
      })
      .filter((m): m is SessionHookMatcher => m !== null)

    // 重建 hooks 对象
    const newHooks =
      updatedMatchers.length > 0
        ? { ...store.hooks, [event]: updatedMatchers }
        : { ...store.hooks }

    // 若该事件下无 matcher，则删除该事件键
    if (updatedMatchers.length === 0) {
      delete newHooks[event]
    }

    prev.sessionHooks.set(sessionId, { ...store, hooks: newHooks })
    return prev
  })

  logForDebugging(
    `Removed session hook for event ${event} in session ${sessionId}`,
  )
}

/**
 * 扩展的 Hook Matcher 类型（用于外部消费）。
 * 包含可选的 skillRoot，供 Hook 执行时设置 CLAUDE_PLUGIN_ROOT 环境变量。
 */
export type SessionDerivedHookMatcher = {
  matcher: string
  hooks: HookCommand[]
  skillRoot?: string
}

/**
 * 将内部 SessionHookMatcher 转换为外部可用的 SessionDerivedHookMatcher。
 * 过滤掉函数 Hook（它们无法序列化为 HookMatcher 格式）。
 *
 * @param sessionMatchers  内部 SessionHookMatcher 数组
 * @returns                过滤函数 Hook 后的外部格式数组
 */
function convertToHookMatchers(
  sessionMatchers: SessionHookMatcher[],
): SessionDerivedHookMatcher[] {
  return sessionMatchers.map(sm => ({
    matcher: sm.matcher,
    skillRoot: sm.skillRoot,
    // 过滤掉函数 Hook，只保留可序列化的 HookCommand
    hooks: sm.hooks
      .map(h => h.hook)
      .filter((h): h is HookCommand => h.type !== 'function'),
  }))
}

/**
 * 获取会话中指定事件的所有命令/提示 Hook（不含函数 Hook）。
 * 若未指定事件，则返回所有事件的 Hook。
 *
 * @param appState   应用状态快照
 * @param sessionId  目标会话 ID
 * @param event      可选的事件过滤器
 * @returns          按事件分组的 SessionDerivedHookMatcher 映射
 */
export function getSessionHooks(
  appState: AppState,
  sessionId: string,
  event?: HookEvent,
): Map<HookEvent, SessionDerivedHookMatcher[]> {
  const store = appState.sessionHooks.get(sessionId)
  if (!store) {
    // 会话不存在，返回空 Map
    return new Map()
  }

  const result = new Map<HookEvent, SessionDerivedHookMatcher[]>()

  if (event) {
    // 仅获取指定事件的 Hook
    const sessionMatchers = store.hooks[event]
    if (sessionMatchers) {
      result.set(event, convertToHookMatchers(sessionMatchers))
    }
    return result
  }

  // 获取所有事件的 Hook
  for (const evt of HOOK_EVENTS) {
    const sessionMatchers = store.hooks[evt]
    if (sessionMatchers) {
      result.set(evt, convertToHookMatchers(sessionMatchers))
    }
  }

  return result
}

/**
 * 函数 Hook Matcher 类型（getSessionFunctionHooks 返回格式）。
 */
type FunctionHookMatcher = {
  matcher: string
  hooks: FunctionHook[]
}

/**
 * 获取会话中指定事件的所有函数 Hook。
 * 函数 Hook 与命令 Hook 分开存储，因为它们不能序列化为 HookMatcher 格式。
 *
 * @param appState   应用状态快照
 * @param sessionId  目标会话 ID
 * @param event      可选的事件过滤器
 * @returns          按事件分组的 FunctionHookMatcher 映射
 */
export function getSessionFunctionHooks(
  appState: AppState,
  sessionId: string,
  event?: HookEvent,
): Map<HookEvent, FunctionHookMatcher[]> {
  const store = appState.sessionHooks.get(sessionId)
  if (!store) {
    return new Map()
  }

  const result = new Map<HookEvent, FunctionHookMatcher[]>()

  // 辅助函数：从 SessionHookMatcher 数组中提取函数 Hook
  const extractFunctionHooks = (
    sessionMatchers: SessionHookMatcher[],
  ): FunctionHookMatcher[] => {
    return sessionMatchers
      .map(sm => ({
        matcher: sm.matcher,
        // 只保留 type === 'function' 的 hook
        hooks: sm.hooks
          .map(h => h.hook)
          .filter((h): h is FunctionHook => h.type === 'function'),
      }))
      .filter(m => m.hooks.length > 0) // 过滤无函数 Hook 的 matcher
  }

  if (event) {
    // 仅获取指定事件的函数 Hook
    const sessionMatchers = store.hooks[event]
    if (sessionMatchers) {
      const functionMatchers = extractFunctionHooks(sessionMatchers)
      if (functionMatchers.length > 0) {
        result.set(event, functionMatchers)
      }
    }
    return result
  }

  // 获取所有事件的函数 Hook
  for (const evt of HOOK_EVENTS) {
    const sessionMatchers = store.hooks[evt]
    if (sessionMatchers) {
      const functionMatchers = extractFunctionHooks(sessionMatchers)
      if (functionMatchers.length > 0) {
        result.set(evt, functionMatchers)
      }
    }
  }

  return result
}

/**
 * 获取指定 hook 的完整条目（含 onHookSuccess 回调）。
 * 主要用于 Hook 执行引擎在 hook 成功后触发回调（如 once: true 自动移除）。
 *
 * @param appState   应用状态快照
 * @param sessionId  目标会话 ID
 * @param event      Hook 所在的事件类型
 * @param matcher    Hook 的 matcher 字符串
 * @param hook       要查找的 hook（按内容等值比较）
 * @returns          包含 hook 和 onHookSuccess 的完整条目，若未找到返回 undefined
 */
export function getSessionHookCallback(
  appState: AppState,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  hook: HookCommand | FunctionHook,
):
  | {
      hook: HookCommand | FunctionHook
      onHookSuccess?: OnHookSuccess
    }
  | undefined {
  const store = appState.sessionHooks.get(sessionId)
  if (!store) {
    return undefined
  }

  const eventMatchers = store.hooks[event]
  if (!eventMatchers) {
    return undefined
  }

  // 在所有 matcher 中查找匹配的 hook 条目
  for (const matcherEntry of eventMatchers) {
    // matcher 为空字符串时匹配所有 matcher 条目
    if (matcherEntry.matcher === matcher || matcher === '') {
      const hookEntry = matcherEntry.hooks.find(h => isHookEqual(h.hook, hook))
      if (hookEntry) {
        return hookEntry
      }
    }
  }

  return undefined
}

/**
 * 清除指定会话的所有 Hook。
 * 通常在会话结束时调用，释放内存资源。
 *
 * @param setAppState  更新应用状态的函数
 * @param sessionId    要清除 Hook 的会话 ID
 */
export function clearSessionHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
): void {
  setAppState(prev => {
    // 从 Map 中删除该会话的整个 SessionStore（O(1)，不触发监听器）
    prev.sessionHooks.delete(sessionId)
    return prev
  })

  logForDebugging(`Cleared all session hooks for session ${sessionId}`)
}
