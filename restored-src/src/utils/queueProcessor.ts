/**
 * 队列处理器模块 (queueProcessor.ts)
 *
 * 在 Claude Code 系统流程中的位置：
 *   用户输入层 → 消息队列层 → 【本模块：队列处理器】 → executeInput 执行层 → AI 响应层
 *
 * 主要职责：
 *   1. 从 messageQueueManager 中取出待处理的命令（仅处理主线程命令，过滤子代理命令）
 *   2. 区分斜杠命令（slash command）与普通命令，斜杠命令和 bash 命令逐条执行
 *   3. 对同一 mode 的普通命令批量合并后一次性传给 executeInput
 *   4. 暴露 hasQueuedCommands() 供调用方判断队列是否有待处理命令
 *
 * 与其他模块的关系：
 *   - 依赖 messageQueueManager 进行底层队列操作（入队/出队/查看）
 *   - 由 REPL 主线程在每轮对话结束后调用，直到队列清空
 */

import type { QueuedCommand } from '../types/textInputTypes.js'
import {
  dequeue,
  dequeueAllMatching,
  hasCommandsInQueue,
  peek,
} from './messageQueueManager.js'

// 处理队列所需的参数类型：包含一个用于执行命令数组的异步回调
type ProcessQueueParams = {
  executeInput: (commands: QueuedCommand[]) => Promise<void>
}

// 处理结果类型：标记是否成功从队列中取出并处理了命令
type ProcessQueueResult = {
  processed: boolean
}

/**
 * 判断一条排队命令是否为斜杠命令（以 '/' 开头）。
 *
 * 流程：
 *   - 若命令值为字符串，直接检查去除首尾空白后是否以 '/' 开头
 *   - 若命令值为 ContentBlockParam 数组，找到第一个 text 类型的块并检查其文本
 *   - 两种情况都找不到 '/' 开头则返回 false
 *
 * 用途：区分需要单条处理的斜杠命令与可批量处理的普通提示词命令
 */
function isSlashCommand(cmd: QueuedCommand): boolean {
  if (typeof cmd.value === 'string') {
    // 字符串命令：直接检查是否以斜杠开头
    return cmd.value.trim().startsWith('/')
  }
  // ContentBlockParam 数组：遍历找到第一个文本块进行判断
  for (const block of cmd.value) {
    if (block.type === 'text') {
      return block.text.trim().startsWith('/')
    }
  }
  return false
}

/**
 * 从队列中取出命令并触发执行，是 REPL 轮次间主线程的核心调度函数。
 *
 * 整体流程：
 *   1. 用 isMainThread 过滤器 peek 队列头部，跳过所有子代理（agentId !== undefined）命令
 *   2. 若队列头为斜杠命令或 bash 模式命令 → 单条出队并执行（保证错误隔离、退出码和进度 UI）
 *   3. 否则 → 批量出队所有与头部 mode 相同的主线程非斜杠命令，作为数组一次性执行
 *      （不同 mode 不混合，因为下游对 prompt 与 task-notification 的处理方式不同）
 *   4. 返回 { processed: true/false } 告知调用方是否有命令被消费
 *
 * 调用方职责：
 *   - 确保当前没有正在运行的 query
 *   - 每次命令完成后再次调用本函数，直到 hasQueuedCommands() 返回 false
 *
 * @returns 处理结果，processed 为 true 表示成功从队列取出并触发了命令执行
 */
export function processQueueIfReady({
  executeInput,
}: ProcessQueueParams): ProcessQueueResult {
  // 主线程过滤器：只处理 agentId 为 undefined 的命令
  // 若不过滤，子代理通知命令会被 peek 到，进而导致 dequeueAllMatching 找不到匹配项，
  // 使 React effect 永不再触发，用户提示词在队列中永久卡住
  const isMainThread = (cmd: QueuedCommand) => cmd.agentId === undefined

  // 查看队列头部（不出队）
  const next = peek(isMainThread)
  if (!next) {
    // 队列为空或只有子代理命令，无需处理
    return { processed: false }
  }

  // 斜杠命令和 bash 模式命令必须单条处理：
  // - 斜杠命令需要独立路由（如 /help、/clear 等）
  // - bash 命令需要每条独立的错误隔离、退出码处理和进度 UI
  if (isSlashCommand(next) || next.mode === 'bash') {
    const cmd = dequeue(isMainThread)! // 出队单条命令
    void executeInput([cmd])           // 触发执行（fire-and-forget，调用方管理 await）
    return { processed: true }
  }

  // 批量出队：取出所有与头部 mode 相同、且为主线程非斜杠命令的条目
  const targetMode = next.mode
  const commands = dequeueAllMatching(
    cmd => isMainThread(cmd) && !isSlashCommand(cmd) && cmd.mode === targetMode,
  )
  if (commands.length === 0) {
    // 理论上不应走到这里，但防御性处理
    return { processed: false }
  }

  // 将批量命令一次性传给 executeInput，每条命令在下游各自生成独立的用户消息和 UUID
  void executeInput(commands)
  return { processed: true }
}

/**
 * 检查消息队列中是否有待处理的命令。
 *
 * 用途：供 REPL 的 React effect 或其他调用方判断是否需要触发 processQueueIfReady。
 * 直接代理 messageQueueManager 的 hasCommandsInQueue()，不做额外过滤。
 */
export function hasQueuedCommands(): boolean {
  return hasCommandsInQueue()
}
