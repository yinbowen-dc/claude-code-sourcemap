/**
 * 任务输出格式化模块（outputFormatting.ts）
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本模块处于 Claude Code 任务结果处理层，在任务输出被送入 API 请求之前
 * 进行截断处理。它确保单个任务的输出不会超出 API 消息的合理大小限制，
 * 同时提供指向完整输出文件的路径，使模型仍能通过工具读取完整内容。
 *
 * 【主要职责】
 * 1. 读取 TASK_MAX_OUTPUT_LENGTH 环境变量（含边界校验和默认值回退）；
 * 2. 对超出限制的输出执行截断：保留末尾内容并添加包含文件路径的截断提示头。
 */

import { validateBoundedIntEnvVar } from '../envValidation.js'
import { getTaskOutputPath } from './diskOutput.js'

/** 任务输出长度上限的绝对最大值（防止环境变量设置过大） */
export const TASK_MAX_OUTPUT_UPPER_LIMIT = 160_000

/** 任务输出长度的默认值（字符数） */
export const TASK_MAX_OUTPUT_DEFAULT = 32_000

/**
 * 获取任务输出的最大允许长度（字符数）。
 *
 * 【执行流程】
 * 1. 读取 TASK_MAX_OUTPUT_LENGTH 环境变量；
 * 2. 通过 validateBoundedIntEnvVar() 验证其为有效整数且在允许范围内；
 *    若未设置或无效，回退到 TASK_MAX_OUTPUT_DEFAULT（32000）；
 *    若超出 TASK_MAX_OUTPUT_UPPER_LIMIT（160000），截断到上限；
 * 3. 返回最终生效的长度值。
 *
 * @returns 最大任务输出长度（字符数）
 */
export function getMaxTaskOutputLength(): number {
  const result = validateBoundedIntEnvVar(
    'TASK_MAX_OUTPUT_LENGTH',
    process.env.TASK_MAX_OUTPUT_LENGTH,
    TASK_MAX_OUTPUT_DEFAULT,
    TASK_MAX_OUTPUT_UPPER_LIMIT,
  )
  return result.effective
}

/**
 * 格式化任务输出以供 API 消费，超出限制时截断并添加文件路径提示。
 *
 * 【截断策略】
 * 保留输出的末尾部分（而非开头），因为最近的输出通常是最相关的结果。
 * 截断提示头格式为 `[Truncated. Full output: {filePath}]`，
 * 模型可通过文件读取工具访问完整内容。
 *
 * 【执行流程】
 * 1. 获取当前生效的最大长度限制；
 * 2. 若输出长度未超出限制，直接返回原始内容；
 * 3. 若超出限制：
 *    a. 计算截断提示头的长度；
 *    b. 从输出末尾截取剩余可用空间的内容；
 *    c. 拼接截断提示头和末尾内容返回。
 *
 * @param output - 原始任务输出字符串
 * @param taskId - 任务唯一标识（用于构建输出文件路径）
 * @returns 格式化后的内容和是否被截断的标志
 */
export function formatTaskOutput(
  output: string,
  taskId: string,
): { content: string; wasTruncated: boolean } {
  const maxLen = getMaxTaskOutputLength()

  // 未超出限制，直接返回原始内容
  if (output.length <= maxLen) {
    return { content: output, wasTruncated: false }
  }

  // 构建截断提示头，包含完整输出文件的路径
  const filePath = getTaskOutputPath(taskId)
  const header = `[Truncated. Full output: ${filePath}]\n\n`
  // 计算扣除提示头后剩余可用的字符数
  const availableSpace = maxLen - header.length
  // 保留末尾内容（最近的输出最相关）
  const truncated = output.slice(-availableSpace)

  return { content: header + truncated, wasTruncated: true }
}
