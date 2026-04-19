/**
 * 查询上下文构建辅助模块
 *
 * 本文件在 Claude Code 系统流程中的位置：
 * - 为所有 query() 调用构建 API 缓存键前缀（systemPrompt、userContext、systemContext）
 * - 位于依赖图的高层，单独抽离以避免循环依赖
 * - 仅被入口层文件导入（QueryEngine.ts、cli/print.ts）
 *
 * 主要功能：
 * - fetchSystemPromptParts：并行获取系统提示词、用户上下文、系统上下文三个缓存键组成部分
 * - buildSideQuestionFallbackParams：在无 stopHooks 快照时为侧边问题构建 CacheSafeParams
 *
 * 独立存在的原因：如将这些导入放入 systemPrompt.ts 或 sideQuestion.ts，
 * 会因 commands.ts 可访问这两个文件而形成循环依赖。
 */

import type { Command } from '../commands.js'
import { getSystemPrompt } from '../constants/prompts.js'
import { getSystemContext, getUserContext } from '../context.js'
import type { MCPServerConnection } from '../services/mcp/types.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Tools, ToolUseContext } from '../Tool.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { Message } from '../types/message.js'
import { createAbortController } from './abortController.js'
import type { FileStateCache } from './fileStateCache.js'
import type { CacheSafeParams } from './forkedAgent.js'
import { getMainLoopModel } from './model/model.js'
import { asSystemPrompt } from './systemPromptType.js'
import {
  shouldEnableThinkingByDefault,
  type ThinkingConfig,
} from './thinking.js'

/**
 * 获取构成 API 缓存键前缀的三个上下文片段：systemPrompt 各部分、userContext、systemContext。
 *
 * 当设置了 customSystemPrompt 时，跳过默认的 getSystemPrompt 构建和 getSystemContext——
 * 自定义提示词完全替换默认内容，systemContext 不应附加到未使用的默认提示词上。
 *
 * 调用方从 defaultSystemPrompt（或 customSystemPrompt）+ 可选扩展 + appendSystemPrompt
 * 组装最终 systemPrompt。QueryEngine 在此基础上注入协调器 userContext 和记忆机制提示词；
 * sideQuestion 的回退路径直接使用本函数的基础结果。
 */
export async function fetchSystemPromptParts({
  tools,
  mainLoopModel,
  additionalWorkingDirectories,
  mcpClients,
  customSystemPrompt,
}: {
  tools: Tools
  mainLoopModel: string
  additionalWorkingDirectories: string[]
  mcpClients: MCPServerConnection[]
  customSystemPrompt: string | undefined
}): Promise<{
  defaultSystemPrompt: string[]
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
}> {
  const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
    customSystemPrompt !== undefined
      ? Promise.resolve([])
      : getSystemPrompt(
          tools,
          mainLoopModel,
          additionalWorkingDirectories,
          mcpClients,
        ),
    getUserContext(),
    customSystemPrompt !== undefined ? Promise.resolve({}) : getSystemContext(),
  ])
  return { defaultSystemPrompt, userContext, systemContext }
}

/**
 * 当 getLastCacheSafeParams() 返回 null 时，从原始输入构建 CacheSafeParams。
 *
 * 用于 SDK side_question 处理器（print.ts）在某轮完成前恢复时——此时尚无 stopHooks 快照。
 * 镜像 QueryEngine.ts:ask() 中的系统提示词组装逻辑，使重建的前缀与主循环发送的内容匹配，
 * 在常规情况下保留缓存命中。
 *
 * 若主循环应用了本路径未知的额外内容（协调器模式、记忆机制提示词），仍可能错过缓存。
 * 这是可接受的——替代方案是返回 null 并导致侧边问题完全失败。
 */
export async function buildSideQuestionFallbackParams({
  tools,
  commands,
  mcpClients,
  messages,
  readFileState,
  getAppState,
  setAppState,
  customSystemPrompt,
  appendSystemPrompt,
  thinkingConfig,
  agents,
}: {
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  messages: Message[]
  readFileState: FileStateCache
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  customSystemPrompt: string | undefined
  appendSystemPrompt: string | undefined
  thinkingConfig: ThinkingConfig | undefined
  agents: AgentDefinition[]
}): Promise<CacheSafeParams> {
  const mainLoopModel = getMainLoopModel()
  const appState = getAppState()

  const { defaultSystemPrompt, userContext, systemContext } =
    await fetchSystemPromptParts({
      tools,
      mainLoopModel,
      additionalWorkingDirectories: Array.from(
        appState.toolPermissionContext.additionalWorkingDirectories.keys(),
      ),
      mcpClients,
      customSystemPrompt,
    })

  const systemPrompt = asSystemPrompt([
    ...(customSystemPrompt !== undefined
      ? [customSystemPrompt]
      : defaultSystemPrompt),
    ...(appendSystemPrompt ? [appendSystemPrompt] : []),
  ])

  // 去除进行中的助手消息（stop_reason === null）——与 btw.tsx 相同的保护逻辑。
  // SDK 可能在一轮对话进行中触发 side_question。
  const last = messages.at(-1)
  const forkContextMessages =
    last?.type === 'assistant' && last.message.stop_reason === null
      ? messages.slice(0, -1)
      : messages

  const toolUseContext: ToolUseContext = {
    options: {
      commands,
      debug: false,
      mainLoopModel,
      tools,
      verbose: false,
      thinkingConfig:
        thinkingConfig ??
        (shouldEnableThinkingByDefault() !== false
          ? { type: 'adaptive' }
          : { type: 'disabled' }),
      mcpClients,
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: agents, allAgents: [] },
      customSystemPrompt,
      appendSystemPrompt,
    },
    abortController: createAbortController(),
    readFileState,
    getAppState,
    setAppState,
    messages: forkContextMessages,
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  }

  return {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    forkContextMessages,
  }
}
