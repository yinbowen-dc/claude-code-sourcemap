/**
 * CronListTool.ts — 定时任务列表查询工具
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具层（tools/ScheduleCronTool）→ 调度存储（utils/cronTasks）
 *
 * 主要功能：
 *   - 列出当前会话（或磁盘上）所有活跃的定时任务
 *   - teammate 只能看到自己的任务；team lead（无 teammate 上下文）可以看到所有任务
 *   - 只读、并发安全，不会修改任何状态
 *   - 每条任务显示 ID、cron 表达式、人类可读计划、提示词、循环/一次性标志及持久化标志
 */

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { cronToHuman } from '../../utils/cron.js'
import { listAllCronTasks } from '../../utils/cronTasks.js'
import { truncate } from '../../utils/format.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import {
  buildCronListPrompt,
  CRON_LIST_DESCRIPTION,
  CRON_LIST_TOOL_NAME,
  isDurableCronEnabled,
  isKairosCronEnabled,
} from './prompt.js'
import { renderListResultMessage, renderListToolUseMessage } from './UI.js'

// 输入 Schema：无需任何参数（空对象）
const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

// 输出 Schema：任务列表，每条包含 ID、cron 表达式、可读计划、提示词及可选标志
const outputSchema = lazySchema(() =>
  z.object({
    jobs: z.array(
      z.object({
        id: z.string(),                           // 任务唯一标识符
        cron: z.string(),                          // 原始 cron 表达式
        humanSchedule: z.string(),                 // 人类可读的执行计划描述
        prompt: z.string(),                        // 触发时执行的提示词
        recurring: z.boolean().optional(),         // true=循环，false 或缺省=一次性
        durable: z.boolean().optional(),           // false=仅 session-only（省略表示 durable）
      }),
    ),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type ListOutput = z.infer<OutputSchema>

/**
 * CronListTool — 定时任务列表工具的主体定义
 *
 * 整体流程：
 *   1. listAllCronTasks 从内存和磁盘中读取所有任务
 *   2. 根据 teammate 上下文过滤：teammate 只看自己的，team lead 看全部
 *   3. 将任务列表转换为标准输出格式（含人类可读时间表达式）
 *   4. 格式化为文本行返回给模型
 */
export const CronListTool = buildTool({
  // 工具注册名，供模型调用时识别
  name: CRON_LIST_TOOL_NAME,
  // 自动分类器使用的搜索提示
  searchHint: 'list active cron jobs',
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
   * 标记为并发安全：可与其他工具同时调用，不存在竞态条件风险
   */
  isConcurrencySafe() {
    return true
  },
  /**
   * 标记为只读：不会修改任何文件或状态，无需写权限
   */
  isReadOnly() {
    return true
  },
  /**
   * 返回工具的功能简介（静态常量）
   */
  async description() {
    return CRON_LIST_DESCRIPTION
  },
  /**
   * 返回系统提示词中工具的使用说明，根据是否开启 durable 功能动态调整文本
   */
  async prompt() {
    return buildCronListPrompt(isDurableCronEnabled())
  },
  /**
   * 工具执行逻辑：
   *   1. 获取所有任务列表
   *   2. 按 teammate 上下文过滤（teammate 只看自己的任务）
   *   3. 将每条任务转换为含 humanSchedule 的输出对象
   *   4. 仅在 recurring=true 或 durable=false 时才将这些字段包含在输出中（减少冗余）
   */
  async call() {
    // 从内存存储和磁盘中读取所有活跃任务
    const allTasks = await listAllCronTasks()
    // Teammates only see their own crons; team lead (no ctx) sees all.
    // teammate 仅能看到自己的任务，team lead（无 ctx）可以看到全部
    const ctx = getTeammateContext()
    const tasks = ctx
      ? allTasks.filter(t => t.agentId === ctx.agentId)   // 按 agentId 过滤
      : allTasks
    // 将任务转换为输出格式，包含人类可读时间表达式
    const jobs = tasks.map(t => ({
      id: t.id,
      cron: t.cron,
      humanSchedule: cronToHuman(t.cron),  // 将 cron 表达式转换为自然语言描述
      prompt: t.prompt,
      // 仅在 recurring 为 true 时才包含该字段（省略表示一次性）
      ...(t.recurring ? { recurring: true } : {}),
      // 仅在 durable 明确为 false 时才包含该字段（省略表示 durable）
      ...(t.durable === false ? { durable: false } : {}),
    }))
    return { data: { jobs } }
  },
  /**
   * 将工具输出映射为 Anthropic API 格式的 tool_result 块，
   * 每行展示一条任务摘要（ID、计划、循环/一次性标志、提示词预览）
   */
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content:
        output.jobs.length > 0
          ? output.jobs
              .map(
                j =>
                  // 格式：ID — 计划（循环/一次性）[session-only 标记]：提示词预览（截断至 80 字符）
                  `${j.id} — ${j.humanSchedule}${j.recurring ? ' (recurring)' : ' (one-shot)'}${j.durable === false ? ' [session-only]' : ''}: ${truncate(j.prompt, 80, true)}`,
              )
              .join('\n')
          : 'No scheduled jobs.',
    }
  },
  // UI 渲染函数：分别处理工具调用时和结果返回时的界面展示
  renderToolUseMessage: renderListToolUseMessage,
  renderToolResultMessage: renderListResultMessage,
} satisfies ToolDef<InputSchema, ListOutput>)
