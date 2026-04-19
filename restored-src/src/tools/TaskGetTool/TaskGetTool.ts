/**
 * TaskGetTool/TaskGetTool.ts — 任务查询工具主体定义
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具层（Tools Layer）→ TaskGetTool 子模块 → 工具执行层
 *
 * 主要功能：
 *   - 根据任务 ID 从 TodoV2 任务列表中查询完整任务信息
 *   - 返回任务标题、描述、状态及依赖关系（blocks / blockedBy）
 *   - 任务不存在时返回 null，由 mapToolResultToToolResultBlockParam 转换为友好提示
 *
 * 设计说明：
 *   - 只读工具（isReadOnly = true），不修改任何状态
 *   - 并发安全（isConcurrencySafe = true），可与其他工具同时调用
 *   - 由 isTodoV2Enabled() 控制工具是否启用
 */

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  getTask,
  getTaskListId,
  isTodoV2Enabled,
  TaskStatusSchema,
} from '../../utils/tasks.js'
import { TASK_GET_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

// 输入 Schema：仅需提供任务 ID 字符串
const inputSchema = lazySchema(() =>
  z.strictObject({
    taskId: z.string().describe('The ID of the task to retrieve'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 输出 Schema：返回完整任务对象（可为 null，表示任务不存在）
const outputSchema = lazySchema(() =>
  z.object({
    task: z
      .object({
        id: z.string(),           // 任务唯一标识符
        subject: z.string(),      // 任务标题（简短可执行描述）
        description: z.string(),  // 任务详细需求描述
        status: TaskStatusSchema(), // 任务状态：pending / in_progress / completed
        blocks: z.array(z.string()),     // 当前任务阻塞的下游任务 ID 列表
        blockedBy: z.array(z.string()), // 阻塞当前任务的上游任务 ID 列表
      })
      .nullable(), // 任务不存在时为 null
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/**
 * TaskGetTool — 任务查询工具的主体定义
 *
 * 整体流程：
 *   1. 接收 taskId 参数，调用 getTaskListId() 获取当前任务列表 ID
 *   2. 调用 getTask() 从存储中查询任务
 *   3. 任务不存在时返回 { task: null }
 *   4. 任务存在时返回完整任务对象（含依赖关系）
 *   5. mapToolResultToToolResultBlockParam 将结果格式化为多行文本返回给模型
 */
export const TaskGetTool = buildTool({
  // 工具注册名，供模型调用时识别
  name: TASK_GET_TOOL_NAME,
  // 自动分类器使用的搜索提示
  searchHint: 'retrieve a task by ID',
  // 单次工具调用结果的最大字符数
  maxResultSizeChars: 100_000,
  /**
   * 返回工具的功能简介（静态常量）
   */
  async description() {
    return DESCRIPTION
  },
  /**
   * 返回系统提示词中工具的使用说明（静态常量）
   */
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  /**
   * 用户界面展示名称（固定为 'TaskGet'）
   */
  userFacingName() {
    return 'TaskGet'
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
   * 标记为只读：不会修改任何文件或状态，无需写权限
   */
  isReadOnly() {
    return true
  },
  /**
   * 自动分类器输入：使用 taskId 作为分类特征
   */
  toAutoClassifierInput(input) {
    return input.taskId
  },
  /**
   * 工具调用时不展示 UI 消息（返回 null 表示静默）
   */
  renderToolUseMessage() {
    return null
  },
  /**
   * 工具执行逻辑：
   *   1. 获取当前会话的任务列表 ID
   *   2. 根据 taskId 查询任务详情
   *   3. 任务不存在时返回 { task: null }
   *   4. 任务存在时返回 id/subject/description/status/blocks/blockedBy
   */
  async call({ taskId }) {
    // 获取当前会话的任务列表标识符
    const taskListId = getTaskListId()

    // 从任务存储中查询指定 ID 的任务
    const task = await getTask(taskListId, taskId)

    // 任务不存在时返回 null，避免抛出异常
    if (!task) {
      return {
        data: {
          task: null,
        },
      }
    }

    // 返回任务的完整信息（含依赖关系）
    return {
      data: {
        task: {
          id: task.id,
          subject: task.subject,
          description: task.description,
          status: task.status,
          blocks: task.blocks,
          blockedBy: task.blockedBy,
        },
      },
    }
  },
  /**
   * 将工具输出映射为 Anthropic API 格式的 tool_result 块
   *
   * 整体流程：
   *   1. 任务为 null 时返回"Task not found"提示
   *   2. 任务存在时，逐行构建：任务编号+标题、状态、描述
   *   3. blockedBy 非空时追加"Blocked by"行
   *   4. blocks 非空时追加"Blocks"行
   *   5. 所有行以换行符连接后返回
   */
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { task } = content as Output
    // 任务不存在时直接返回提示信息
    if (!task) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: 'Task not found',
      }
    }

    // 构建任务详情的多行文本
    const lines = [
      `Task #${task.id}: ${task.subject}`,   // 第一行：任务编号与标题
      `Status: ${task.status}`,               // 第二行：当前状态
      `Description: ${task.description}`,    // 第三行：详细描述
    ]

    // 仅在有上游依赖时追加 blockedBy 行
    if (task.blockedBy.length > 0) {
      lines.push(`Blocked by: ${task.blockedBy.map(id => `#${id}`).join(', ')}`)
    }
    // 仅在有下游依赖时追加 blocks 行
    if (task.blocks.length > 0) {
      lines.push(`Blocks: ${task.blocks.map(id => `#${id}`).join(', ')}`)
    }

    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: lines.join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
