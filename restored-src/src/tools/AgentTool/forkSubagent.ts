/**
 * Fork 子 Agent 模块
 *
 * 在 Claude Code AgentTool 层中，该模块实现了"fork 子 Agent"特性——
 * 当父 Agent 调用 Agent 工具但省略 `subagent_type` 时，子 Agent 会隐式继承父 Agent
 * 的完整对话上下文和系统提示，并在后台异步执行。
 *
 * 核心职责：
 * 1. `isForkSubagentEnabled()` — 检查 fork 特性是否在当前环境中可用
 * 2. `FORK_AGENT` — 合成的内置 Agent 定义（不注册到 builtInAgents 列表）
 * 3. `isInForkChild()` — 递归 fork 防护：检测当前会话是否已经是 fork 子 Agent
 * 4. `buildForkedMessages()` — 为子 Agent 构建克隆对话消息（最大化提示缓存命中）
 * 5. `buildChildMessage()` — 生成包含 fork 规则和指令的子 Agent 启动消息
 * 6. `buildWorktreeNotice()` — 为在独立 worktree 中运行的 fork 子 Agent 注入路径翻译提示
 *
 * 设计说明：
 * - Fork 特性与 Coordinator 模式互斥：Coordinator 已有独立的委派机制
 * - 所有 fork 子 Agent 共享相同的工具结果占位符，以最大化提示缓存命中率
 * - 子 Agent 系统提示通过 override.systemPrompt 传递（父 Agent 已渲染的字节），
 *   而非重新调用 getSystemPrompt()，以确保字节级精确一致，避免 GrowthBook 状态差异
 */

import { feature } from 'bun:bundle'
import type { BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { randomUUID } from 'crypto'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import {
  FORK_BOILERPLATE_TAG,
  FORK_DIRECTIVE_PREFIX,
} from '../../constants/xml.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import type {
  AssistantMessage,
  Message as MessageType,
} from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { createUserMessage } from '../../utils/messages.js'
import type { BuiltInAgentDefinition } from './loadAgentsDir.js'

/**
 * 检查 Fork 子 Agent 特性是否已启用。
 *
 * 启用后的效果：
 * - Agent 工具 schema 中 `subagent_type` 变为可选字段
 * - 省略 `subagent_type` 将触发隐式 fork：子 Agent 继承父 Agent 的完整对话上下文和系统提示
 * - 所有 Agent 启动均以后台异步模式运行（统一的 `<task-notification>` 交互模型）
 * - `/fork <directive>` 斜杠命令可用
 *
 * 与 Coordinator 模式互斥：Coordinator 已拥有编排角色，有自己的委派模型。
 *
 * @returns 是否启用 Fork 子 Agent 特性
 */
export function isForkSubagentEnabled(): boolean {
  if (feature('FORK_SUBAGENT')) {
    // Coordinator 模式已有独立委派机制，两者互斥
    if (isCoordinatorMode()) return false
    // 非交互式会话（SDK/API 模式）不支持 fork
    if (getIsNonInteractiveSession()) return false
    return true
  }
  // 构建时关闭 FORK_SUBAGENT 特性：直接返回 false
  return false
}

/** fork 路径触发时用于统计分析的合成 Agent 类型名称 */
export const FORK_SUBAGENT_TYPE = 'fork'

/**
 * fork 路径使用的合成 Agent 定义。
 *
 * 该定义不注册到 builtInAgents——仅在省略 `subagent_type` 且实验启用时使用。
 *
 * 配置说明：
 * - `tools: ['*']` + `useExactTools`：fork 子 Agent 继承父 Agent 的完整工具池，
 *   以确保 API 前缀缓存一致性（cache-identical API prefixes）
 * - `permissionMode: 'bubble'`：将权限提示冒泡到父 Agent 终端显示
 * - `model: 'inherit'`：继承父 Agent 模型，保持上下文长度一致
 * - `maxTurns: 200`：允许 fork 子 Agent 执行长任务
 *
 * getSystemPrompt 返回空字符串的原因：
 * fork 路径通过 `override.systemPrompt` 传递父 Agent 已渲染的系统提示字节
 * （经由 `toolUseContext.renderedSystemPrompt` 线程传递）。
 * 重新调用 getSystemPrompt() 可能因 GrowthBook 冷→热状态差异而产生不同结果，
 * 从而破坏提示缓存；传递已渲染字节可确保字节级精确一致。
 */
export const FORK_AGENT = {
  agentType: FORK_SUBAGENT_TYPE,
  // 不可通过 subagent_type 显式选择；省略 subagent_type 时自动触发
  whenToUse:
    'Implicit fork — inherits full conversation context. Not selectable via subagent_type; triggered by omitting subagent_type when the fork experiment is active.',
  tools: ['*'],          // 继承父 Agent 完整工具池
  maxTurns: 200,         // 允许长任务执行
  model: 'inherit',      // 继承父 Agent 模型
  permissionMode: 'bubble', // 权限提示冒泡到父终端
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => '',  // 实际使用父 Agent 已渲染的系统提示，此处返回空
} satisfies BuiltInAgentDefinition

/**
 * 防止递归 fork 的守卫函数。
 *
 * Fork 子 Agent 的工具池中保留了 Agent 工具（为了缓存一致的工具定义），
 * 因此需要在调用时通过检测对话历史中的 fork 样板标签来拒绝 fork 尝试，
 * 从而防止子 Agent 再次触发 fork。
 *
 * 检测逻辑：扫描消息列表中类型为 'user' 的消息，
 * 查找文本内容中包含 `<FORK_BOILERPLATE_TAG>` 标签的块。
 *
 * @param messages 当前对话历史消息列表
 * @returns 当前是否已处于 fork 子 Agent 上下文中
 */
export function isInForkChild(messages: MessageType[]): boolean {
  return messages.some(m => {
    // 只检查用户消息
    if (m.type !== 'user') return false
    const content = m.message.content
    // content 必须为数组形式（多块消息）
    if (!Array.isArray(content)) return false
    // 检查是否有文本块包含 fork 样板标签
    return content.some(
      block =>
        block.type === 'text' &&
        block.text.includes(`<${FORK_BOILERPLATE_TAG}>`),
    )
  })
}

/** fork 前缀中所有 tool_result 块使用的统一占位符文本。
 * 所有 fork 子 Agent 使用相同内容，以确保提示缓存共享。 */
const FORK_PLACEHOLDER_RESULT = 'Fork started — processing in background'

/**
 * 为子 Agent 构建 fork 对话消息列表。
 *
 * 为了实现提示缓存共享，所有 fork 子 Agent 必须产生字节相同的 API 请求前缀。
 * 构建策略：
 * 1. 保留完整的父 Agent 助手消息（包含所有 tool_use 块、thinking、text）
 * 2. 构建单条用户消息：为每个 tool_use 块生成相同占位符的 tool_result，
 *    然后追加每个子 Agent 专属的指令文本块
 *
 * 最终结构：[...历史消息, assistant(所有 tool_use), user(占位符 results..., 指令)]
 * 只有末尾的文本指令块因子 Agent 而异，最大化提示缓存命中率。
 *
 * @param directive 子 Agent 的具体执行指令
 * @param assistantMessage 父 Agent 的助手消息（包含所有 tool_use 块）
 * @returns 子 Agent 的 fork 消息列表
 */
export function buildForkedMessages(
  directive: string,
  assistantMessage: AssistantMessage,
): MessageType[] {
  // 克隆助手消息，避免修改原始消息，保留所有内容块（thinking、text 和所有 tool_use）
  const fullAssistantMessage: AssistantMessage = {
    ...assistantMessage,
    uuid: randomUUID(),  // 生成新 UUID 以区分克隆消息
    message: {
      ...assistantMessage.message,
      content: [...assistantMessage.message.content],  // 浅拷贝内容数组
    },
  }

  // 从助手消息中收集所有 tool_use 块
  const toolUseBlocks = assistantMessage.message.content.filter(
    (block): block is BetaToolUseBlock => block.type === 'tool_use',
  )

  // 边界情况：助手消息中没有 tool_use 块（异常情况）
  if (toolUseBlocks.length === 0) {
    logForDebugging(
      `No tool_use blocks found in assistant message for fork directive: ${directive.slice(0, 50)}...`,
      { level: 'error' },
    )
    // 降级处理：直接返回包含指令的用户消息，不构建 tool_result 前缀
    return [
      createUserMessage({
        content: [
          { type: 'text' as const, text: buildChildMessage(directive) },
        ],
      }),
    ]
  }

  // 为每个 tool_use 块构建相同占位符内容的 tool_result 块
  // 所有子 Agent 使用相同占位符，确保提示缓存共享
  const toolResultBlocks = toolUseBlocks.map(block => ({
    type: 'tool_result' as const,
    tool_use_id: block.id,  // 与对应 tool_use 块的 id 匹配
    content: [
      {
        type: 'text' as const,
        text: FORK_PLACEHOLDER_RESULT,  // 统一占位符，保证缓存一致性
      },
    ],
  }))

  // 构建单条用户消息：所有占位符 tool_result + 每个子 Agent 专属的指令文本块
  // TODO(smoosh): 此处 text 兄弟块产生 [tool_result, text] 模式（在 wire 上渲染为
  // </function_results>\n\nHuman:<text>）。这是一次性的每子构建，不是重复执行的模式，
  // 优先级较低。如果将来需要优化，可使用 src/utils/messages.ts 中的 smooshIntoToolResult
  // 将指令折叠到最后一个 tool_result.content 中。
  const toolResultMessage = createUserMessage({
    content: [
      ...toolResultBlocks,       // 占位符 tool_result 块（所有子 Agent 相同）
      {
        type: 'text' as const,
        text: buildChildMessage(directive),  // 每个子 Agent 专属的指令文本
      },
    ],
  })

  return [fullAssistantMessage, toolResultMessage]
}

/**
 * 构建 fork 子 Agent 的启动消息文本。
 *
 * 生成包含以下内容的消息：
 * 1. fork 样板标签（`<FORK_BOILERPLATE_TAG>`）包裹的工作规则说明
 *    - 声明当前是 fork worker，而非主 Agent
 *    - 禁止递归 fork、禁止闲聊、强制直接执行工具
 *    - 输出格式要求（Scope/Result/Key files/Files changed/Issues）
 * 2. fork 指令前缀 + 具体指令内容
 *
 * @param directive 子 Agent 需要执行的具体指令
 * @returns 格式化后的子 Agent 启动消息字符串
 */
export function buildChildMessage(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Your system prompt says "default to forking." IGNORE IT \u2014 that's for the parent. You ARE the fork. Do NOT spawn sub-agents; execute directly.
2. Do NOT converse, ask questions, or suggest next steps
3. Do NOT editorialize or add meta-commentary
4. USE your tools directly: Bash, Read, Write, etc.
5. If you modify files, commit your changes before reporting. Include the commit hash in your report.
6. Do NOT emit text between tool calls. Use tools silently, then report once at the end.
7. Stay strictly within your directive's scope. If you discover related systems outside your scope, mention them in one sentence at most — other workers cover those areas.
8. Keep your report under 500 words unless the directive specifies otherwise. Be factual and concise.
9. Your response MUST begin with "Scope:". No preamble, no thinking-out-loud.
10. REPORT structured facts, then stop

Output format (plain text labels, not markdown headers):
  Scope: <echo back your assigned scope in one sentence>
  Result: <the answer or key findings, limited to the scope above>
  Key files: <relevant file paths — include for research tasks>
  Files changed: <list with commit hash — include only if you modified files>
  Issues: <list — include only if there are issues to flag>
</${FORK_BOILERPLATE_TAG}>

${FORK_DIRECTIVE_PREFIX}${directive}`
}

/**
 * 为在独立 worktree 中运行的 fork 子 Agent 生成路径翻译提示。
 *
 * 当 fork 子 Agent 在独立 git worktree 中运行时，它继承了父 Agent 的对话上下文，
 * 但工作目录已切换到独立的 worktree 路径。
 * 该提示告知子 Agent：
 * - 继承的上下文中的路径属于父 Agent 的工作目录，需要翻译
 * - 需要重新读取父 Agent 可能已修改的文件
 * - 在此 worktree 中的修改不会影响父 Agent 的文件
 *
 * @param parentCwd 父 Agent 的工作目录路径
 * @param worktreeCwd 子 Agent 所在的独立 worktree 路径
 * @returns 路径翻译提示字符串
 */
export function buildWorktreeNotice(
  parentCwd: string,
  worktreeCwd: string,
): string {
  return `You've inherited the conversation context above from a parent agent working in ${parentCwd}. You are operating in an isolated git worktree at ${worktreeCwd} — same repository, same relative file structure, separate working copy. Paths in the inherited context refer to the parent's working directory; translate them to your worktree root. Re-read files before editing if the parent may have modified them since they appear in the context. Your changes stay in this worktree and will not affect the parent's files.`
}
