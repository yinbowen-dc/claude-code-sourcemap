/**
 * TaskCreateTool/TaskCreateTool.ts — 任务创建工具主体定义
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具层（Tools Layer）→ TaskCreateTool 子模块 → 工具执行层
 *
 * 主要功能：
 *   - 在 TodoV2 任务列表中创建新任务
 *   - 创建成功后触发 TaskCreated 钩子（如外部监听器校验），遇到阻断性错误时自动回滚
 *   - 自动展开任务列表 UI 视图（expandedView = 'tasks'）
 *
 * 设计说明：
 *   - 并发安全（isConcurrencySafe = true）
 *   - 由 isTodoV2Enabled() 控制工具是否启用
 *   - 钩子（executeTaskCreatedHooks）为异步生成器，支持多钩子串行执行
 *   - 钩子返回 blockingError 时立即删除刚创建的任务并抛出错误（事务性回滚）
 */

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import {
  executeTaskCreatedHooks,
  getTaskCreatedHookMessage,
} from '../../utils/hooks.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  createTask,
  deleteTask,
  getTaskListId,
  isTodoV2Enabled,
} from '../../utils/tasks.js'
import { getAgentName, getTeamName } from '../../utils/teammate.js'
import { TASK_CREATE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

// 输入 Schema：任务标题（必填）、描述（必填）、进行时态（可选）、元数据（可选）
const inputSchema = lazySchema(() =>
  z.strictObject({
    subject: z.string().describe('A brief title for the task'),
    description: z.string().describe('What needs to be done'),
    activeForm: z
      .string()
      .optional()
      .describe(
        'Present continuous form shown in spinner when in_progress (e.g., "Running tests")',
      ),
    metadata: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Arbitrary metadata to attach to the task'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 输出 Schema：仅返回新建任务的 ID 和标题（供模型后续引用）
const outputSchema = lazySchema(() =>
  z.object({
    task: z.object({
      id: z.string(),      // 新建任务的唯一标识符
      subject: z.string(), // 新建任务的标题
    }),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/**
 * TaskCreateTool — 任务创建工具的主体定义
 *
 * 整体流程：
 *   1. 接收 subject/description/activeForm/metadata 参数
 *   2. 调用 createTask() 在任务列表中写入新任务（初始状态为 pending）
 *   3. 以异步生成器形式执行所有 TaskCreated 钩子
 *   4. 若任一钩子返回 blockingError，收集错误信息后删除任务并抛出异常（回滚）
 *   5. 无错误时，自动将 UI expandedView 切换为 'tasks'
 *   6. 返回新建任务的 ID 和标题
 */
export const TaskCreateTool = buildTool({
  // 工具注册名，供模型调用时识别
  name: TASK_CREATE_TOOL_NAME,
  // 自动分类器使用的搜索提示
  searchHint: 'create a task in the task list',
  // 单次工具调用结果的最大字符数
  maxResultSizeChars: 100_000,
  /**
   * 返回工具的功能简介（静态常量）
   */
  async description() {
    return DESCRIPTION
  },
  /**
   * 返回系统提示词中工具的使用说明（动态构建，根据是否启用 agent swarms 调整内容）
   */
  async prompt() {
    return getPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  /**
   * 用户界面展示名称（固定为 'TaskCreate'）
   */
  userFacingName() {
    return 'TaskCreate'
  },
  // 允许此工具在 UI 中延迟渲染
  shouldDefer: true,
  /**
   * 工具启用条件：需通过 TodoV2 功能开关
   */
  isEnabled() {
    return isTodoV2Enabled()
  },
  /**
   * 标记为并发安全：可与其他工具同时调用，不存在竞态条件风险
   */
  isConcurrencySafe() {
    return true
  },
  /**
   * 自动分类器输入：使用任务标题作为分类特征
   */
  toAutoClassifierInput(input) {
    return input.subject
  },
  /**
   * 工具调用时不展示 UI 消息（返回 null 表示静默）
   */
  renderToolUseMessage() {
    return null
  },
  /**
   * 工具执行逻辑：
   *   1. 调用 createTask() 创建新任务（初始状态 pending，无 owner/依赖）
   *   2. 通过异步生成器执行所有 TaskCreated 钩子，收集阻断性错误
   *   3. 若有阻断性错误，删除刚创建的任务（回滚）并抛出包含所有错误信息的异常
   *   4. 无错误时，展开任务列表 UI 视图
   *   5. 返回 { task: { id, subject } }
   */
  async call({ subject, description, activeForm, metadata }, context) {
    // 在任务存储中创建新任务，初始状态为 pending，无所有者和依赖关系
    const taskId = await createTask(getTaskListId(), {
      subject,
      description,
      activeForm,
      status: 'pending',
      owner: undefined,
      blocks: [],
      blockedBy: [],
      metadata,
    })

    // 收集所有阻断性错误（钩子校验失败时填入）
    const blockingErrors: string[] = []
    // 执行所有 TaskCreated 钩子（异步生成器，支持串行多钩子）
    const generator = executeTaskCreatedHooks(
      taskId,
      subject,
      description,
      getAgentName(),    // 当前智能体名称
      getTeamName(),     // 当前团队名称
      undefined,
      context?.abortController?.signal, // 支持外部取消信号
      undefined,
      context,
    )
    // 遍历生成器，收集所有阻断性错误消息
    for await (const result of generator) {
      if (result.blockingError) {
        blockingErrors.push(getTaskCreatedHookMessage(result.blockingError))
      }
    }

    // 若有阻断性错误，删除刚创建的任务（事务性回滚），并抛出聚合错误
    if (blockingErrors.length > 0) {
      await deleteTask(getTaskListId(), taskId)
      throw new Error(blockingErrors.join('\n'))
    }

    // Auto-expand task list when creating tasks
    // 创建任务后自动展开任务列表视图（仅在当前不是 tasks 视图时切换）
    context.setAppState(prev => {
      if (prev.expandedView === 'tasks') return prev
      return { ...prev, expandedView: 'tasks' as const }
    })

    return {
      data: {
        task: {
          id: taskId,
          subject,
        },
      },
    }
  },
  /**
   * 将工具输出映射为 Anthropic API 格式的 tool_result 块
   * 返回简洁的成功消息：任务编号 + 标题
   */
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { task } = content as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Task #${task.id} created successfully: ${task.subject}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
