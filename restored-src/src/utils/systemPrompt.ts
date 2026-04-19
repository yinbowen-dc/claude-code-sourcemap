/**
 * 系统提示词构建模块（systemPrompt.ts）
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本模块处于 Claude Code 对话引擎的核心路径上，在每次主循环（main loop）
 * 初始化时被调用，负责将多个潜在的系统提示词来源按优先级合并为最终送给
 * Claude API 的 system prompt 数组（SystemPrompt 品牌类型）。
 *
 * 【优先级体系（从高到低）】
 * 0. 覆盖提示词（overrideSystemPrompt）：完全替换其他所有来源，用于循环模式（loop mode）；
 * 1. 协调者提示词（coordinator）：当 COORDINATOR_MODE 特性开启且没有自定义 Agent 时使用；
 * 2. Agent 提示词（agentSystemPrompt）：由 mainThreadAgentDefinition 提供；
 *    - 在 Proactive/Kairos 模式下：附加到默认提示词末尾（而非替换）；
 *    - 否则：完全替换默认提示词；
 * 3. 自定义提示词（customSystemPrompt）：通过 --system-prompt CLI 参数指定；
 * 4. 默认提示词（defaultSystemPrompt）：标准 Claude Code 系统提示词。
 *
 * 无论使用哪个来源，appendSystemPrompt 始终附加到最终数组末尾（override 模式除外）。
 */

import { feature } from 'bun:bundle'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { isBuiltInAgent } from '../tools/AgentTool/loadAgentsDir.js'
import { isEnvTruthy } from './envUtils.js'
import { asSystemPrompt, type SystemPrompt } from './systemPromptType.js'

// 重导出 SystemPrompt 类型和 asSystemPrompt，方便上层模块统一从本模块引入
export { asSystemPrompt, type SystemPrompt } from './systemPromptType.js'

// 死码消除：通过条件导入实现 proactive 模块的懒加载。
// 与 prompts.ts 保持相同的模式——避免将 proactive 模块引入非 proactive 构建。
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('../proactive/index.js') as typeof import('../proactive/index.js'))
    : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 安全地检测 proactive 模式是否激活（可在任意位置调用）。
 * 若 proactiveModule 未加载则返回 false，不会抛出错误。
 */
function isProactiveActive_SAFE_TO_CALL_ANYWHERE(): boolean {
  return proactiveModule?.isProactiveActive() ?? false
}

/**
 * 根据优先级规则构建最终生效的系统提示词数组。
 *
 * 【执行流程】
 * 1. 若存在 overrideSystemPrompt，立即返回，忽略所有其他来源；
 * 2. 若处于 Coordinator 模式（特性开关已开启 + 环境变量已设置 + 无 Agent 定义），
 *    使用 coordinatorSystemPrompt 并附加 appendSystemPrompt 后返回；
 * 3. 根据 mainThreadAgentDefinition 是否存在，决定是否调用 getSystemPrompt()
 *    获取 agentSystemPrompt；
 * 4. 若 Agent 有内存字段，发送 tengu_agent_memory_loaded 分析事件（仅限内部用户）；
 * 5. 在 Proactive/Kairos 模式下，将 agentSystemPrompt 附加到 defaultSystemPrompt 末尾；
 * 6. 否则按优先顺序选择：agentSystemPrompt > customSystemPrompt > defaultSystemPrompt，
 *    并在末尾追加 appendSystemPrompt（若有）。
 *
 * @param params.mainThreadAgentDefinition - 当前主线程 Agent 定义（可为 undefined）
 * @param params.toolUseContext            - 包含工具使用选项的上下文
 * @param params.customSystemPrompt        - 通过 --system-prompt 指定的自定义提示词
 * @param params.defaultSystemPrompt       - 标准 Claude Code 默认系统提示词数组
 * @param params.appendSystemPrompt        - 始终追加到末尾的附加提示词（可选）
 * @param params.overrideSystemPrompt      - 完全覆盖所有来源的覆盖提示词（可选）
 * @returns 最终生效的 SystemPrompt（品牌类型，readonly string[]）
 */
export function buildEffectiveSystemPrompt({
  mainThreadAgentDefinition,
  toolUseContext,
  customSystemPrompt,
  defaultSystemPrompt,
  appendSystemPrompt,
  overrideSystemPrompt,
}: {
  mainThreadAgentDefinition: AgentDefinition | undefined
  toolUseContext: Pick<ToolUseContext, 'options'>
  customSystemPrompt: string | undefined
  defaultSystemPrompt: string[]
  appendSystemPrompt: string | undefined
  overrideSystemPrompt?: string | null
}): SystemPrompt {
  // 优先级 0：覆盖提示词存在时，完全忽略其他所有来源
  if (overrideSystemPrompt) {
    return asSystemPrompt([overrideSystemPrompt])
  }

  // 优先级 1：Coordinator 模式（特性开关 + 环境变量 + 无主线程 Agent 定义）
  // 使用 inline env check 而非 coordinatorModule 以避免测试模块加载时的循环依赖
  if (
    feature('COORDINATOR_MODE') &&
    isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE) &&
    !mainThreadAgentDefinition
  ) {
    // 延迟加载以规避模块初始化阶段的循环依赖问题
    const { getCoordinatorSystemPrompt } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js')
    return asSystemPrompt([
      getCoordinatorSystemPrompt(),
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])
  }

  // 优先级 2：Agent 提示词——根据 Agent 类型选择正确的 getSystemPrompt 调用方式
  const agentSystemPrompt = mainThreadAgentDefinition
    ? isBuiltInAgent(mainThreadAgentDefinition)
      ? mainThreadAgentDefinition.getSystemPrompt({
          toolUseContext: { options: toolUseContext.options },
        })
      : mainThreadAgentDefinition.getSystemPrompt()
    : undefined

  // 若 Agent 定义包含内存字段，记录分析事件（仅对 Anthropic 内部用户记录 agent_type）
  if (mainThreadAgentDefinition?.memory) {
    logEvent('tengu_agent_memory_loaded', {
      ...(process.env.USER_TYPE === 'ant' && {
        agent_type:
          mainThreadAgentDefinition.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      scope:
        mainThreadAgentDefinition.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      source:
        'main-thread' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // Proactive/Kairos 模式：Agent 指令附加到默认提示词末尾（而非替换）
  // proactive 默认提示词已精简（自主 Agent 身份 + 内存 + 环境 + proactive 段落），
  // Agent 在此基础上叠加领域特定行为——与 teammate 的附加方式相同
  if (
    agentSystemPrompt &&
    (feature('PROACTIVE') || feature('KAIROS')) &&
    isProactiveActive_SAFE_TO_CALL_ANYWHERE()
  ) {
    return asSystemPrompt([
      ...defaultSystemPrompt,
      `\n# Custom Agent Instructions\n${agentSystemPrompt}`,
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])
  }

  // 标准优先级链：agentSystemPrompt > customSystemPrompt > defaultSystemPrompt
  // 三者互斥：选中优先级最高的那个，appendSystemPrompt 始终追加到末尾
  return asSystemPrompt([
    ...(agentSystemPrompt
      ? [agentSystemPrompt]
      : customSystemPrompt
        ? [customSystemPrompt]
        : defaultSystemPrompt),
    ...(appendSystemPrompt ? [appendSystemPrompt] : []),
  ])
}
