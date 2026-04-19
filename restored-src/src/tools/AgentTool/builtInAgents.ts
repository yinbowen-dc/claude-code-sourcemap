/**
 * 内置 Agent 注册与启用控制模块
 *
 * 在 Claude Code AgentTool 层中，该模块是内置 Agent 的统一注册入口——
 * 负责根据功能特性标志（GrowthBook）、环境变量和入口点类型，
 * 动态决定哪些内置 Agent 在当前会话中可用。
 *
 * 核心职责：
 * 1. `areExplorePlanAgentsEnabled()` — 通过 GrowthBook 开关控制 Explore/Plan Agent 的启用
 * 2. `getBuiltInAgents()` — 组装并返回当前会话中可用的内置 Agent 列表
 *
 * 启用逻辑：
 * - SDK 用户可通过 CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS 环境变量完全禁用内置 Agent
 * - Coordinator 模式下返回 coordinator 专属 Agent 列表（通过 lazy require 避免循环依赖）
 * - 始终启用：GeneralPurpose（通用）、StatuslineSetup（状态栏配置）
 * - 条件启用：Explore/Plan（通过 GrowthBook tengu_amber_stoat 特性标志）
 * - 非 SDK 入口点：额外启用 ClaudeCodeGuide（文档助手）
 * - 验证 Agent：通过 GrowthBook tengu_hive_evidence 特性标志控制
 */

import { feature } from 'bun:bundle'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { CLAUDE_CODE_GUIDE_AGENT } from './built-in/claudeCodeGuideAgent.js'
import { EXPLORE_AGENT } from './built-in/exploreAgent.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import { PLAN_AGENT } from './built-in/planAgent.js'
import { STATUSLINE_SETUP_AGENT } from './built-in/statuslineSetup.js'
import { VERIFICATION_AGENT } from './built-in/verificationAgent.js'
import type { AgentDefinition } from './loadAgentsDir.js'

/**
 * 判断 Explore 和 Plan Agent 是否已启用。
 *
 * 通过 Bun bundle 特性标志 BUILTIN_EXPLORE_PLAN_AGENTS 进行构建时开关控制，
 * 在运行时通过 GrowthBook 特性值 'tengu_amber_stoat' 进行 A/B 测试控制：
 * - 3P 默认值为 true（Bedrock/Vertex 保持 Agent 启用，与实验前行为一致）
 * - A/B 测试 treatment 设为 false，用于衡量移除 Agent 的影响
 *
 * @returns 是否启用 Explore 和 Plan Agent
 */
export function areExplorePlanAgentsEnabled(): boolean {
  if (feature('BUILTIN_EXPLORE_PLAN_AGENTS')) {
    // 3P default: true — Bedrock/Vertex keep agents enabled (matches pre-experiment
    // external behavior). A/B test treatment sets false to measure impact of removal.
    // GrowthBook A/B 测试：默认启用（true），实验组可设为 false 来评估影响
    return getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_stoat', true)
  }
  // 构建时关闭：直接返回 false
  return false
}

/**
 * 获取当前会话中可用的所有内置 Agent 定义列表。
 *
 * 按以下优先级决定返回内容：
 * 1. 若 SDK 用户设置了 CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS 且处于非交互模式 → 返回空数组
 * 2. 若处于 Coordinator 模式 → 返回 coordinator 专属 Agent 列表（lazy require）
 * 3. 否则按功能特性标志和入口点类型动态组装 Agent 列表
 *
 * @returns 当前会话可用的内置 AgentDefinition 数组
 */
export function getBuiltInAgents(): AgentDefinition[] {
  // Allow disabling all built-in agents via env var (useful for SDK users who want a blank slate)
  // Only applies in noninteractive mode (SDK/API usage)
  // SDK 用户通过环境变量禁用所有内置 Agent（仅在非交互式 SDK/API 模式下生效）
  if (
    isEnvTruthy(process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS) &&
    getIsNonInteractiveSession()
  ) {
    // 非交互式 SDK 模式且明确禁用：返回空列表
    return []
  }

  // Use lazy require inside the function body to avoid circular dependency
  // issues at module init time. The coordinatorMode module depends on tools
  // which depend on AgentTool which imports this file.
  // Coordinator 模式：使用 lazy require 避免循环依赖
  // coordinatorMode 模块依赖 tools → AgentTool → 本文件，因此不能在模块顶层 import
  if (feature('COORDINATOR_MODE')) {
    if (isEnvTruthy(process.env.CLAUDE_CODE_COORDINATOR_MODE)) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      // 动态加载 coordinator 的 Agent 列表，避免循环依赖
      const { getCoordinatorAgents } =
        require('../../coordinator/workerAgent.js') as typeof import('../../coordinator/workerAgent.js')
      /* eslint-enable @typescript-eslint/no-require-imports */
      // 返回 coordinator 专属 Agent 列表（替代常规内置 Agent）
      return getCoordinatorAgents()
    }
  }

  // 基础 Agent 列表：通用目的 Agent 和状态栏配置 Agent 始终启用
  const agents: AgentDefinition[] = [
    GENERAL_PURPOSE_AGENT,    // 通用目的 Agent：处理复杂多步骤任务
    STATUSLINE_SETUP_AGENT,   // 状态栏配置 Agent：帮助用户配置终端状态栏
  ]

  // 条件启用：Explore 和 Plan Agent（通过 GrowthBook A/B 测试控制）
  if (areExplorePlanAgentsEnabled()) {
    agents.push(EXPLORE_AGENT, PLAN_AGENT)
  }

  // Include Code Guide agent for non-SDK entrypoints
  // 非 SDK 入口点检测：排除三种 SDK 入口（TypeScript SDK、Python SDK、CLI SDK）
  const isNonSdkEntrypoint =
    process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-ts' &&
    process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-py' &&
    process.env.CLAUDE_CODE_ENTRYPOINT !== 'sdk-cli'

  // 仅在非 SDK 入口点（即终端 CLI 用户）时启用文档助手 Agent
  if (isNonSdkEntrypoint) {
    agents.push(CLAUDE_CODE_GUIDE_AGENT)
  }

  // 验证 Agent：需同时满足构建时特性标志和 GrowthBook 运行时特性值
  if (
    feature('VERIFICATION_AGENT') &&                                              // 构建时开关：VERIFICATION_AGENT 特性
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_hive_evidence', false)             // GrowthBook 运行时开关（默认关闭）
  ) {
    agents.push(VERIFICATION_AGENT)  // 启用对抗性验证 Agent
  }

  // 返回最终组装的内置 Agent 列表
  return agents
}
