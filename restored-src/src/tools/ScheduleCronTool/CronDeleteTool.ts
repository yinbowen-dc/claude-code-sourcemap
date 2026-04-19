/**
 * CronDeleteTool.ts — 定时任务删除工具
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具层（tools/ScheduleCronTool）→ 调度存储（utils/cronTasks）
 *
 * 主要功能：
 *   - 根据 CronCreate 返回的任务 ID 取消（删除）定时任务
 *   - 同时支持删除内存中的 session-only 任务和磁盘上的 durable 任务
 *   - 权限控制：teammate 只能删除自己创建的任务，无法删除其他 agent 的任务
 */

import { z } from 'zod/v4'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  getCronFilePath,
  listAllCronTasks,
  removeCronTasks,
} from '../../utils/cronTasks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import {
  buildCronDeletePrompt,
  CRON_DELETE_DESCRIPTION,
  CRON_DELETE_TOOL_NAME,
  isDurableCronEnabled,
  isKairosCronEnabled,
} from './prompt.js'
import { renderDeleteResultMessage, renderDeleteToolUseMessage } from './UI.js'

// 输入 Schema：只需提供 CronCreate 返回的任务 ID
const inputSchema = lazySchema(() =>
  z.strictObject({
    id: z.string().describe('Job ID returned by CronCreate.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 输出 Schema：返回被删除任务的 ID 以供确认
const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type DeleteOutput = z.infer<OutputSchema>

/**
 * CronDeleteTool — 定时任务删除工具的主体定义
 *
 * 整体流程：
 *   1. validateInput 校验任务 ID 是否存在，并检查 teammate 权限
 *   2. call 调用 removeCronTasks 从存储中删除任务
 *   3. 返回被删除的任务 ID
 */
export const CronDeleteTool = buildTool({
  // 工具注册名，供模型调用时识别
  name: CRON_DELETE_TOOL_NAME,
  // 自动分类器使用的搜索提示
  searchHint: 'cancel a scheduled cron job',
  // 单次工具调用结果的最大字符数
  maxResultSizeChars: 100_000,
  // 允许此工具在 UI 中延迟渲染
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  /**
   * 工具启用条件：需通过 Kairos cron 功能开关
   */
  isEnabled() {
    return isKairosCronEnabled()
  },
  /**
   * 生成传给自动分类器的简短描述（仅任务 ID）
   */
  toAutoClassifierInput(input) {
    return input.id
  },
  /**
   * 返回工具的功能简介（静态常量，无需动态构建）
   */
  async description() {
    return CRON_DELETE_DESCRIPTION
  },
  /**
   * 返回系统提示词中工具的使用说明，根据是否开启 durable 功能动态调整文本
   */
  async prompt() {
    return buildCronDeletePrompt(isDurableCronEnabled())
  },
  /**
   * 返回 cron 任务的持久化文件路径，供工具权限系统使用
   */
  getPath() {
    return getCronFilePath()
  },
  /**
   * 输入合法性校验：
   *   1. 检查指定 ID 的任务是否存在于当前会话或磁盘存储中
   *   2. 若当前上下文为 teammate，则检查该任务是否属于本 teammate（防止越权删除）
   */
  async validateInput(input): Promise<ValidationResult> {
    // 获取所有任务列表，查找目标任务
    const tasks = await listAllCronTasks()
    const task = tasks.find(t => t.id === input.id)
    // 任务不存在则返回错误
    if (!task) {
      return {
        result: false,
        message: `No scheduled job with id '${input.id}'`,
        errorCode: 1,
      }
    }
    // Teammates may only delete their own crons.
    // teammate 权限检查：只能删除自己创建的任务
    const ctx = getTeammateContext()
    if (ctx && task.agentId !== ctx.agentId) {
      return {
        result: false,
        message: `Cannot delete cron job '${input.id}': owned by another agent`,
        errorCode: 2,
      }
    }
    return { result: true }
  },
  /**
   * 工具执行逻辑：
   *   调用 removeCronTasks 将指定任务从内存存储和（若存在）磁盘文件中删除
   */
  async call({ id }) {
    // 从调度存储中移除任务（同时处理 session-only 和 durable 两种情况）
    await removeCronTasks([id])
    return { data: { id } }
  },
  /**
   * 将工具输出映射为 Anthropic API 格式的 tool_result 块
   */
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Cancelled job ${output.id}.`,
    }
  },
  // UI 渲染函数：分别处理工具调用时和结果返回时的界面展示
  renderToolUseMessage: renderDeleteToolUseMessage,
  renderToolResultMessage: renderDeleteResultMessage,
} satisfies ToolDef<InputSchema, DeleteOutput>)
