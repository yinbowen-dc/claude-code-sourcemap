/**
 * 【EnterPlanModeTool 主模块】
 *
 * 在 Claude Code 系统流程中的位置：
 *   EnterPlanModeTool 是计划模式（plan mode）的入口工具。
 *   AI 在遇到非平凡实现任务时调用此工具，请求用户批准进入计划模式；
 *   进入后 AI 只能进行探索（Glob/Grep/Read），禁止写操作，
 *   直到调用 ExitPlanModeTool 展示方案并请求批准后才能恢复执行权限。
 *
 * 主要功能：
 *   - isEnabled()：在 --channels（KAIROS 频道）激活时禁用，防止模型进入无法退出的计划模式陷阱
 *   - call()：通过 handlePlanModeTransition + applyPermissionUpdate 切换至 plan 权限模式
 *   - mapToolResultToToolResultBlockParam()：根据是否处于面试阶段（interview phase）
 *     返回不同的操作指引，告知 AI 当前阶段的规则和步骤
 */

import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import {
  getAllowedChannels,
  handlePlanModeTransition,
} from '../../bootstrap/state.js'
import type { Tool } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { applyPermissionUpdate } from '../../utils/permissions/PermissionUpdate.js'
import { prepareContextForPlanMode } from '../../utils/permissions/permissionSetup.js'
import { isPlanModeInterviewPhaseEnabled } from '../../utils/planModeV2.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from './constants.js'
import { getEnterPlanModeToolPrompt } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

// 输入 Schema：EnterPlanMode 无需任何参数
const inputSchema = lazySchema(() =>
  z.strictObject({
    // No parameters needed
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

// 输出 Schema：仅包含确认消息字符串
const outputSchema = lazySchema(() =>
  z.object({
    message: z.string().describe('Confirmation that plan mode was entered'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const EnterPlanModeTool: Tool<InputSchema, Output> = buildTool({
  name: ENTER_PLAN_MODE_TOOL_NAME,
  searchHint: 'switch to plan mode to design an approach before coding',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Requests permission to enter plan mode for complex tasks requiring exploration and design'
  },
  async prompt() {
    // 动态生成工具提示词（外部版 vs 内部 ant 版）
    return getEnterPlanModeToolPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    // 工具名称在 UI 中不显示（返回空字符串）
    return ''
  },
  shouldDefer: true,  // 进入计划模式需要用户批准
  isEnabled() {
    // 当 --channels（KAIROS 频道）激活时，ExitPlanMode 的审批对话框需要终端，
    // 无法正常展示；为防止 AI 进入计划模式后无法退出（形成陷阱），此处同步禁用入口。
    if (
      (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
      getAllowedChannels().length > 0
    ) {
      return false
    }
    return true
  },
  isConcurrencySafe() {
    return true  // 模式切换本身是并发安全的
  },
  isReadOnly() {
    return true  // EnterPlanMode 不写入任何数据，是只读工具
  },
  renderToolUseMessage,
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  /**
   * 执行计划模式切换
   *
   * 流程：
   * 1. 若在 agent 子上下文中调用则抛错（计划模式不适用于子 agent）
   * 2. 通过 handlePlanModeTransition 记录模式转换日志/事件
   * 3. 调用 prepareContextForPlanMode 准备权限上下文（处理 auto 模式的分类器副作用）
   * 4. 调用 applyPermissionUpdate 将 toolPermissionContext.mode 设置为 'plan'
   * 5. 返回确认消息
   */
  async call(_input, context) {
    // 计划模式工具不允许在 agent 子上下文中使用
    if (context.agentId) {
      throw new Error('EnterPlanMode tool cannot be used in agent contexts')
    }

    const appState = context.getAppState()
    // 记录从当前模式到 plan 模式的转换（用于日志/分析）
    handlePlanModeTransition(appState.toolPermissionContext.mode, 'plan')

    // 更新权限模式为 'plan'。
    // prepareContextForPlanMode 在用户 defaultMode 为 'auto' 时触发分类器激活副作用——
    // 完整生命周期参见 permissionSetup.ts。
    context.setAppState(prev => ({
      ...prev,
      toolPermissionContext: applyPermissionUpdate(
        prepareContextForPlanMode(prev.toolPermissionContext),
        { type: 'setMode', mode: 'plan', destination: 'session' },
      ),
    }))

    return {
      data: {
        message:
          'Entered plan mode. You should now focus on exploring the codebase and designing an implementation approach.',
      },
    }
  },
  /**
   * 将结构化输出转换为 API tool_result 格式，并附加计划模式操作指引。
   *
   * 两种指引版本：
   * - 面试阶段（interview phase）已启用：精简指引，详细工作流由附件（plan_mode attachment）提供
   * - 普通计划模式：完整六步指引，包括探索代码库→识别模式→考虑方案→确认方法→设计策略→调用 ExitPlanMode
   */
  mapToolResultToToolResultBlockParam({ message }, toolUseID) {
    const instructions = isPlanModeInterviewPhaseEnabled()
      ? `${message}

DO NOT write or edit any files except the plan file. Detailed workflow instructions will follow.`
      : `${message}

In plan mode, you should:
1. Thoroughly explore the codebase to understand existing patterns
2. Identify similar features and architectural approaches
3. Consider multiple approaches and their trade-offs
4. Use AskUserQuestion if you need to clarify the approach
5. Design a concrete implementation strategy
6. When ready, use ExitPlanMode to present your plan for approval

Remember: DO NOT write or edit any files yet. This is a read-only exploration and planning phase.`

    return {
      type: 'tool_result',
      content: instructions,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
