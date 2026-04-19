/**
 * CronCreateTool.ts — 定时任务创建工具
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具层（tools/ScheduleCronTool）→ 调度系统（utils/cronTasks）→ 引导状态（bootstrap/state）
 *
 * 主要功能：
 *   - 允许 Claude 模型通过标准 5 字段 cron 表达式创建定时任务（循环或一次性）
 *   - 支持两种持久化模式：会话内存（session-only）和磁盘持久化（durable，写入 .claude/scheduled_tasks.json）
 *   - 创建成功后启动调度器，使任务在本会话中生效
 *   - 最多允许同时存在 50 个调度任务
 */

import { z } from 'zod/v4'
import { setScheduledTasksEnabled } from '../../bootstrap/state.js'
import type { ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { cronToHuman, parseCronExpression } from '../../utils/cron.js'
import {
  addCronTask,
  getCronFilePath,
  listAllCronTasks,
  nextCronRunMs,
} from '../../utils/cronTasks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import {
  buildCronCreateDescription,
  buildCronCreatePrompt,
  CRON_CREATE_TOOL_NAME,
  DEFAULT_MAX_AGE_DAYS,
  isDurableCronEnabled,
  isKairosCronEnabled,
} from './prompt.js'
import { renderCreateResultMessage, renderCreateToolUseMessage } from './UI.js'

// 单个 Claude 会话中允许的最大定时任务数量
const MAX_JOBS = 50

// 输入参数 Schema（懒加载，避免模块初始化时触发 zod 解析）
const inputSchema = lazySchema(() =>
  z.strictObject({
    // 标准 5 字段 cron 表达式，使用本地时间，格式为 "分 时 日 月 星期"
    cron: z
      .string()
      .describe(
        'Standard 5-field cron expression in local time: "M H DoM Mon DoW" (e.g. "*/5 * * * *" = every 5 minutes, "30 14 28 2 *" = Feb 28 at 2:30pm local once).',
      ),
    // 每次触发时入队执行的提示词
    prompt: z.string().describe('The prompt to enqueue at each fire time.'),
    // 是否循环执行（true=循环，false=只执行一次后自动删除）
    recurring: semanticBoolean(z.boolean().optional()).describe(
      `true (default) = fire on every cron match until deleted or auto-expired after ${DEFAULT_MAX_AGE_DAYS} days. false = fire once at the next match, then auto-delete. Use false for "remind me at X" one-shot requests with pinned minute/hour/dom/month.`,
    ),
    // 是否持久化到磁盘（true=写入 .claude/scheduled_tasks.json，false=仅在内存中）
    durable: semanticBoolean(z.boolean().optional()).describe(
      'true = persist to .claude/scheduled_tasks.json and survive restarts. false (default) = in-memory only, dies when this Claude session ends. Use true only when the user asks the task to survive across sessions.',
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 输出 Schema：返回任务 ID、可读时间表达式、是否循环及是否持久化
const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    humanSchedule: z.string(),
    recurring: z.boolean(),
    durable: z.boolean().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type CreateOutput = z.infer<OutputSchema>

/**
 * CronCreateTool — 定时任务创建工具的主体定义
 *
 * 整体流程：
 *   1. 校验 cron 表达式合法性及下次触发时间
 *   2. 检查任务数量是否超上限
 *   3. 阻止 teammate 创建 durable 任务（因其不跨会话存活）
 *   4. 调用 addCronTask 写入调度存储
 *   5. 设置 setScheduledTasksEnabled(true) 激活调度器轮询循环
 *   6. 返回任务 ID 和人类可读的执行计划摘要
 */
export const CronCreateTool = buildTool({
  // 工具注册名，供模型调用时识别
  name: CRON_CREATE_TOOL_NAME,
  // 自动分类器使用的搜索提示
  searchHint: 'schedule a recurring or one-shot prompt',
  // 单次工具调用结果的最大字符数
  maxResultSizeChars: 100_000,
  // 允许此工具在 UI 中延迟渲染（非阻塞）
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  /**
   * 工具启用条件：需同时满足 AGENT_TRIGGERS 构建标志和 GrowthBook 远程开关
   */
  isEnabled() {
    return isKairosCronEnabled()
  },
  /**
   * 生成传给自动分类器的简短描述文本（用于判断是否允许自动执行）
   */
  toAutoClassifierInput(input) {
    return `${input.cron}: ${input.prompt}`
  },
  /**
   * 返回工具的功能简介，根据是否开启 durable 功能动态调整文本
   */
  async description() {
    return buildCronCreateDescription(isDurableCronEnabled())
  },
  /**
   * 返回系统提示词（system prompt）中工具的使用说明
   */
  async prompt() {
    return buildCronCreatePrompt(isDurableCronEnabled())
  },
  /**
   * 返回 cron 任务的持久化文件路径，供工具权限系统（file-path 规则）使用
   */
  getPath() {
    return getCronFilePath()
  },
  /**
   * 输入合法性校验：
   *   1. 检验 cron 表达式能被正确解析
   *   2. 检验表达式在未来一年内至少有一次触发
   *   3. 检验任务数量未超过上限 MAX_JOBS
   *   4. 阻止 teammate 创建 durable 任务（teammate 不跨会话存活，durable 会产生孤儿任务）
   */
  async validateInput(input): Promise<ValidationResult> {
    // 校验 cron 表达式格式是否合法（5 字段）
    if (!parseCronExpression(input.cron)) {
      return {
        result: false,
        message: `Invalid cron expression '${input.cron}'. Expected 5 fields: M H DoM Mon DoW.`,
        errorCode: 1,
      }
    }
    // 校验表达式在未来一年内有触发时间（防止 "2月30日" 等无效日期）
    if (nextCronRunMs(input.cron, Date.now()) === null) {
      return {
        result: false,
        message: `Cron expression '${input.cron}' does not match any calendar date in the next year.`,
        errorCode: 2,
      }
    }
    // 校验当前任务总数未超过上限
    const tasks = await listAllCronTasks()
    if (tasks.length >= MAX_JOBS) {
      return {
        result: false,
        message: `Too many scheduled jobs (max ${MAX_JOBS}). Cancel one first.`,
        errorCode: 3,
      }
    }
    // Teammates don't persist across sessions, so a durable teammate cron
    // would orphan on restart (agentId would point to a nonexistent teammate).
    // teammate 不跨会话存活，其 agentId 在重启后会变为无效引用，故禁止创建 durable 任务
    if (input.durable && getTeammateContext()) {
      return {
        result: false,
        message:
          'durable crons are not supported for teammates (teammates do not persist across sessions)',
        errorCode: 4,
      }
    }
    return { result: true }
  },
  /**
   * 工具执行逻辑：
   *   1. 通过 isDurableCronEnabled() 应用 kill-switch，强制 durable 为 false 时不写磁盘
   *   2. 调用 addCronTask 将任务写入调度存储（内存或磁盘）
   *   3. 调用 setScheduledTasksEnabled(true) 启动调度器轮询循环
   *   4. 返回任务 ID 及人类可读的执行计划
   */
  async call({ cron, prompt, recurring = true, durable = false }) {
    // Kill switch forces session-only; schema stays stable so the model sees
    // no validation errors when the gate flips mid-session.
    // 应用 kill-switch：若远程关闭了 durable 功能，强制降级为 session-only
    const effectiveDurable = durable && isDurableCronEnabled()
    // 将任务写入调度存储，返回唯一任务 ID
    const id = await addCronTask(
      cron,
      prompt,
      recurring,
      effectiveDurable,
      getTeammateContext()?.agentId, // 绑定所属 teammate 的 agentId（如有）
    )
    // Enable the scheduler so the task fires in this session. The
    // useScheduledTasks hook polls this flag and will start watching
    // on the next tick. For durable: false tasks the file never changes
    // — check() reads the session store directly — but the enable flag
    // is still what starts the tick loop.
    // 启用调度器，useScheduledTasks hook 会在下一个 tick 开始轮询
    setScheduledTasksEnabled(true)
    return {
      data: {
        id,
        // 将 cron 表达式转换为人类可读描述（如 "every 5 minutes"）
        humanSchedule: cronToHuman(cron),
        recurring,
        durable: effectiveDurable,
      },
    }
  },
  /**
   * 将工具输出映射为 Anthropic API 格式的 tool_result 块，
   * 供模型在下一轮对话中读取执行结果
   */
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    // 根据是否持久化显示不同的存储位置说明
    const where = output.durable
      ? 'Persisted to .claude/scheduled_tasks.json'
      : 'Session-only (not written to disk, dies when Claude exits)'
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      // 循环任务显示过期天数，一次性任务说明执行后自动删除
      content: output.recurring
        ? `Scheduled recurring job ${output.id} (${output.humanSchedule}). ${where}. Auto-expires after ${DEFAULT_MAX_AGE_DAYS} days. Use CronDelete to cancel sooner.`
        : `Scheduled one-shot task ${output.id} (${output.humanSchedule}). ${where}. It will fire once then auto-delete.`,
    }
  },
  // UI 渲染函数：分别处理工具调用时和结果返回时的界面展示
  renderToolUseMessage: renderCreateToolUseMessage,
  renderToolResultMessage: renderCreateResultMessage,
} satisfies ToolDef<InputSchema, CreateOutput>)
