/**
 * 【文件定位】DreamTask.ts — 自动记忆整合子代理（Dream Agent）的任务注册与状态管理层
 *
 * 在 Claude Code 系统流程中的位置：
 *   autoDream 服务（services/autoDream/）→ 派生子代理 → DreamTask 注册到任务框架
 *   → 底部状态栏胶囊（footer pill）及 Shift+Down 任务列表对话框可见
 *
 * 主要职责：
 *   Dream Agent 是在后台静默运行的记忆整合子代理（执行定向、收集、整合、裁剪四阶段）。
 *   本文件唯一的作用是将该"不可见"的子代理暴露到统一任务注册表（task registry）中，
 *   使其在 UI 层面可见并可被用户中止，同时维护其状态（阶段、触碰文件、对话轮次等）。
 *   不修改 Dream Agent 自身的执行逻辑。
 */

// Background task entry for auto-dream (memory consolidation subagent).
// Makes the otherwise-invisible forked agent visible in the footer pill and
// Shift+Down dialog. The dream agent itself is unchanged — this is pure UI
// surfacing via the existing task registry.

import { rollbackConsolidationLock } from '../../services/autoDream/consolidationLock.js'
import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'

// Keep only the N most recent turns for live display.
// 保留最近 N 轮对话用于实时展示，防止内存无限增长
const MAX_TURNS = 30

// A single assistant turn from the dream agent, tool uses collapsed to a count.
// 代表 Dream Agent 一次助手回合的简化结构：文本内容 + 工具调用次数
export type DreamTurn = {
  text: string
  toolUseCount: number
}

// No phase detection — the dream prompt has a 4-stage structure
// (orient/gather/consolidate/prune) but we don't parse it. Just flip from
// 'starting' to 'updating' when the first Edit/Write tool_use lands.
// Dream Agent 内部有四阶段结构，但此处只在第一个 Edit/Write 工具调用出现时
// 将阶段从 'starting' 切换到 'updating'，不做细粒度解析
export type DreamPhase = 'starting' | 'updating'

/** Dream 任务的完整状态结构，继承通用任务状态基类 */
export type DreamTaskState = TaskStateBase & {
  type: 'dream'
  phase: DreamPhase          // 当前阶段：starting（初始）或 updating（已开始写文件）
  sessionsReviewing: number  // 正在被此次整合回顾的会话数量
  /**
   * Paths observed in Edit/Write tool_use blocks via onMessage. This is an
   * INCOMPLETE reflection of what the dream agent actually changed — it misses
   * any bash-mediated writes and only captures the tool calls we pattern-match.
   * Treat as "at least these were touched", not "only these were touched".
   *
   * 通过 onMessage 监听 Edit/Write 工具调用获取的文件路径集合。
   * 注意：这是不完整的——bash 途径写入的文件不会被捕获，应视为"至少触碰了这些"。
   */
  filesTouched: string[]
  /** Assistant text responses, tool uses collapsed. Prompt is NOT included.
   *  已折叠工具调用的助手回合列表（不含系统提示）
   */
  turns: DreamTurn[]
  abortController?: AbortController  // 用于中止整个 Dream Agent 的控制器（运行时，不序列化）
  /** Stashed so kill can rewind the lock mtime (same path as fork-failure).
   *  保存整合锁修改时间戳，以便中止时回滚锁，允许下次会话重试
   */
  priorMtime: number
}

/**
 * 类型守卫：判断一个未知对象是否为 DreamTaskState。
 * 检查 type 字段是否为 'dream'，用于在任务列表中安全地区分任务类型。
 */
export function isDreamTask(task: unknown): task is DreamTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'dream'  // 仅当 type === 'dream' 时返回 true
  )
}

/**
 * 注册一个新的 Dream 任务到全局任务框架。
 *
 * 流程：
 *   1. 生成带 'dream' 前缀的唯一任务 ID
 *   2. 构建初始 DreamTaskState（阶段为 starting，触碰文件列表为空）
 *   3. 调用 registerTask 写入 AppState
 *   4. 返回新任务 ID 供调用方跟踪
 *
 * @param setAppState - 全局状态更新函数
 * @param opts        - 回顾会话数、锁修改时间戳、中止控制器
 * @returns 新注册的任务 ID
 */
export function registerDreamTask(
  setAppState: SetAppState,
  opts: {
    sessionsReviewing: number
    priorMtime: number
    abortController: AbortController
  },
): string {
  const id = generateTaskId('dream')  // 生成 dream-xxxx 格式的唯一 ID
  const task: DreamTaskState = {
    ...createTaskStateBase(id, 'dream', 'dreaming'),  // 创建通用基础状态（描述为 'dreaming'）
    type: 'dream',
    status: 'running',          // 初始状态为运行中
    phase: 'starting',          // 阶段为启动中（尚未触碰任何文件）
    sessionsReviewing: opts.sessionsReviewing,
    filesTouched: [],           // 已触碰文件列表初始为空
    turns: [],                  // 对话轮次初始为空
    abortController: opts.abortController,
    priorMtime: opts.priorMtime,
  }
  registerTask(task, setAppState)  // 写入 AppState，触发 UI 更新
  return id
}

/**
 * 追加一个新的 Dream 对话轮次，并更新已触碰文件列表。
 *
 * 流程：
 *   1. 通过 updateTaskState 获取当前任务快照
 *   2. 对 touchedPaths 去重，只保留新增路径
 *   3. 如果轮次为空且没有新触碰文件，则直接返回原任务（跳过无意义更新）
 *   4. 若有新触碰文件，将阶段切换为 'updating'
 *   5. 保持最近 MAX_TURNS 轮次，超出时丢弃最旧的
 *
 * @param taskId      - 目标任务 ID
 * @param turn        - 新的 Dream 轮次数据
 * @param touchedPaths - 本轮新触碰的文件路径列表
 * @param setAppState  - 全局状态更新函数
 */
export function addDreamTurn(
  taskId: string,
  turn: DreamTurn,
  touchedPaths: string[],
  setAppState: SetAppState,
): void {
  updateTaskState<DreamTaskState>(taskId, setAppState, task => {
    // 利用 Set 对已有文件路径去重，筛选出真正新增的路径
    const seen = new Set(task.filesTouched)
    const newTouched = touchedPaths.filter(p => !seen.has(p) && seen.add(p))
    // Skip the update entirely if the turn is empty AND nothing new was
    // touched. Avoids re-rendering on pure no-ops.
    // 如果本轮既无文本/工具调用，也没有新触碰文件，则跳过更新，避免无效渲染
    if (
      turn.text === '' &&
      turn.toolUseCount === 0 &&
      newTouched.length === 0
    ) {
      return task
    }
    return {
      ...task,
      // 若有新触碰文件，则将阶段从 starting 切换为 updating
      phase: newTouched.length > 0 ? 'updating' : task.phase,
      filesTouched:
        newTouched.length > 0
          ? [...task.filesTouched, ...newTouched]  // 追加新路径
          : task.filesTouched,
      // 保留最近 MAX_TURNS 轮，超出时从头部截断
      turns: task.turns.slice(-(MAX_TURNS - 1)).concat(turn),
    }
  })
}

/**
 * 将 Dream 任务标记为成功完成状态。
 *
 * 注意：立即将 notified 设为 true——Dream 没有模型侧通知路径（纯 UI），
 * 而任务驱逐（eviction）要求 terminal + notified 同时满足。
 * 内联追加的 appendSystemMessage 完成提示即是用户可见的表面。
 */
export function completeDreamTask(
  taskId: string,
  setAppState: SetAppState,
): void {
  // notified: true immediately — dream has no model-facing notification path
  // (it's UI-only), and eviction requires terminal + notified. The inline
  // appendSystemMessage completion note IS the user surface.
  updateTaskState<DreamTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'completed',
    endTime: Date.now(),        // 记录完成时间戳
    notified: true,             // 立即标记为已通知，允许驱逐
    abortController: undefined, // 释放中止控制器引用
  }))
}

/**
 * 将 Dream 任务标记为失败状态（如派生子代理时发生错误）。
 * 同样立即设置 notified=true，逻辑同 completeDreamTask。
 */
export function failDreamTask(taskId: string, setAppState: SetAppState): void {
  updateTaskState<DreamTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'failed',
    endTime: Date.now(),        // 记录失败时间戳
    notified: true,             // 立即标记为已通知
    abortController: undefined, // 释放中止控制器引用
  }))
}

/**
 * DreamTask — 实现 Task 接口的 Dream 任务对象。
 *
 * 注册到全局任务注册表后，框架会通过 kill() 方法在用户手动停止时调用。
 *
 * kill 流程：
 *   1. 通过 updateTaskState 原子性地将任务状态切换为 'killed'
 *   2. 调用 AbortController.abort() 中止 Dream Agent 的异步执行
 *   3. 保存 priorMtime 后清空 abortController 引用
 *   4. 若 priorMtime 有效，调用 rollbackConsolidationLock 回滚整合锁
 *      （与派生失败路径相同，确保下次会话可以重新触发整合）
 */
export const DreamTask: Task = {
  name: 'DreamTask',
  type: 'dream',

  async kill(taskId, setAppState) {
    let priorMtime: number | undefined  // 用于回滚整合锁的时间戳（仅在成功切换状态时赋值）
    updateTaskState<DreamTaskState>(taskId, setAppState, task => {
      if (task.status !== 'running') return task  // 非运行中状态无需处理
      task.abortController?.abort()               // 中止 Dream Agent 异步执行
      priorMtime = task.priorMtime                // 保存锁时间戳用于后续回滚
      return {
        ...task,
        status: 'killed',
        endTime: Date.now(),
        notified: true,              // 立即标记为已通知，允许驱逐
        abortController: undefined,  // 清空中止控制器引用
      }
    })
    // Rewind the lock mtime so the next session can retry. Same path as the
    // fork-failure catch in autoDream.ts. If updateTaskState was a no-op
    // (already terminal), priorMtime stays undefined and we skip.
    // 回滚整合锁修改时间戳，使下次会话可以重新尝试整合。
    // 若 updateTaskState 是无操作（任务已终止），则 priorMtime 为 undefined，直接跳过。
    if (priorMtime !== undefined) {
      await rollbackConsolidationLock(priorMtime)
    }
  },
}
