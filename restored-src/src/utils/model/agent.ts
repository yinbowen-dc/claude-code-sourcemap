/**
 * Subagent 模型选择模块（Agent Model Selection）
 *
 * 【在 Claude Code 系统流中的位置】
 * 本文件处于多 Agent 调度体系的关键路径上，负责为子 Agent 选取正确的模型字符串。
 * 当 Agent Tool（子 Agent 调用）执行时，QueryEngine 会通过本模块决定子 Agent
 * 实际使用哪个模型，确保 Bedrock 跨区域推理前缀的一致性，以及 `inherit`/别名
 * 语义的正确解析。
 *
 * 【主要功能】
 * 1. getDefaultSubagentModel  — 返回默认子 Agent 模型设置（'inherit'）
 * 2. getAgentModel            — 综合环境变量、工具指定、父模型信息，解析子 Agent 模型
 * 3. aliasMatchesParentTier   — 判断裸家族别名是否与父模型同级（防止意外降级）
 * 4. getAgentModelDisplay     — 生成 Agent 模型的人类可读显示字符串
 * 5. getAgentModelOptions     — 返回 Agent 模型选项列表（供 UI 选择器使用）
 */

import type { PermissionMode } from '../permissions/PermissionMode.js'
import { capitalize } from '../stringUtils.js'
import { MODEL_ALIASES, type ModelAlias } from './aliases.js'
import { applyBedrockRegionPrefix, getBedrockRegionPrefix } from './bedrock.js'
import {
  getCanonicalName,
  getRuntimeMainLoopModel,
  parseUserSpecifiedModel,
} from './model.js'
import { getAPIProvider } from './providers.js'

// 所有模型别名 + 'inherit'（继承父模型）构成完整的 Agent 模型选项集
export const AGENT_MODEL_OPTIONS = [...MODEL_ALIASES, 'inherit'] as const
export type AgentModelAlias = (typeof AGENT_MODEL_OPTIONS)[number]

export type AgentModelOption = {
  value: AgentModelAlias
  label: string
  description: string
}

/**
 * 获取子 Agent 默认使用的模型。
 * 默认返回 'inherit'，表示继承父线程（主循环）的模型。
 */
export function getDefaultSubagentModel(): string {
  return 'inherit'
}

/**
 * 解析子 Agent 实际使用的模型字符串。
 *
 * 【优先级顺序】（高 → 低）
 * 1. CLAUDE_CODE_SUBAGENT_MODEL 环境变量 — 最高优先级，覆盖所有其他设置
 * 2. toolSpecifiedModel — Agent Tool 调用时工具 schema 中指定的模型
 * 3. agentModel 参数（来自用户配置）— 可为 'inherit' 或具体别名/ID
 * 4. 默认值 'inherit' — 若未提供 agentModel 参数则退化为继承父模型
 *
 * 【Bedrock 跨区域前缀继承逻辑】
 * 若父模型携带跨区域推理前缀（如 "eu."、"us."），子 Agent 在解析别名后
 * 也会继承该前缀，确保子 Agent 路由到相同数据驻留区域，避免跨区域 IAM 权限问题。
 * 例外：若子 Agent 原始配置中已包含显式前缀，则保留子 Agent 自己的前缀，
 * 防止无声覆盖管理员有意设置的数据驻留策略。
 *
 * @param agentModel      用户配置的子 Agent 模型（可为别名、完整 ID 或 'inherit'）
 * @param parentModel     父线程当前使用的模型字符串（用于提取 Bedrock 区域前缀）
 * @param toolSpecifiedModel  工具 schema 中指定的模型别名（优先级高于 agentModel）
 * @param permissionMode  当前权限模式（影响 opusplan 在 inherit 场景下的解析）
 */
export function getAgentModel(
  agentModel: string | undefined,
  parentModel: string,
  toolSpecifiedModel?: ModelAlias,
  permissionMode?: PermissionMode,
): string {
  // 环境变量优先：CLAUDE_CODE_SUBAGENT_MODEL 完全覆盖所有其他设置
  if (process.env.CLAUDE_CODE_SUBAGENT_MODEL) {
    return parseUserSpecifiedModel(process.env.CLAUDE_CODE_SUBAGENT_MODEL)
  }

  // 从父模型中提取 Bedrock 跨区域推理前缀（如 'eu'、'us'、'apac'、'global'）
  // 子 Agent 使用别名时需要继承此前缀以满足 IAM 权限范围限制
  const parentRegionPrefix = getBedrockRegionPrefix(parentModel)

  // 辅助函数：将父模型区域前缀应用到已解析的子 Agent 模型 ID 上
  // originalSpec 是解析前的原始字符串（别名或完整 ID）
  // 若 originalSpec 本身已包含区域前缀（如 "eu.anthropic.…"），则不覆盖，
  // 防止管理员有意将子 Agent 固定在不同区域时被静默覆盖
  const applyParentRegionPrefix = (
    resolvedModel: string,
    originalSpec: string,
  ): string => {
    if (parentRegionPrefix && getAPIProvider() === 'bedrock') {
      // 若原始规格已有前缀，保留 resolvedModel 不变
      if (getBedrockRegionPrefix(originalSpec)) return resolvedModel
      // 否则将父模型前缀应用到解析后的模型 ID 上
      return applyBedrockRegionPrefix(resolvedModel, parentRegionPrefix)
    }
    return resolvedModel
  }

  // 工具指定模型的优先级高于用户配置
  if (toolSpecifiedModel) {
    // 裸家族别名（opus/sonnet/haiku）且与父模型同级时，直接继承父模型字符串，
    // 避免因 getDefaultOpusModel() 返回较旧的 3P 版本而意外降级
    if (aliasMatchesParentTier(toolSpecifiedModel, parentModel)) {
      return parentModel
    }
    // 将别名解析为完整模型 ID，再应用父模型区域前缀
    const model = parseUserSpecifiedModel(toolSpecifiedModel)
    return applyParentRegionPrefix(model, toolSpecifiedModel)
  }

  // 若未传入 agentModel 参数，退化为默认值 'inherit'
  const agentModelWithExp = agentModel ?? getDefaultSubagentModel()

  if (agentModelWithExp === 'inherit') {
    // 'inherit' 语义：通过 getRuntimeMainLoopModel 解析父模型运行时版本，
    // 确保 opusplan → Opus（plan 模式下）的语义被正确传递给子 Agent
    return getRuntimeMainLoopModel({
      permissionMode: permissionMode ?? 'default',
      mainLoopModel: parentModel,
      exceeds200kTokens: false,
    })
  }

  // 用户配置了具体别名，同样检查是否与父模型同级（防止降级）
  if (aliasMatchesParentTier(agentModelWithExp, parentModel)) {
    return parentModel
  }
  // 解析别名/ID，并应用父模型区域前缀
  const model = parseUserSpecifiedModel(agentModelWithExp)
  return applyParentRegionPrefix(model, agentModelWithExp)
}

/**
 * 判断裸家族别名（opus/sonnet/haiku）是否与父模型属于同一家族层级。
 * 若匹配，子 Agent 直接继承父模型的完整字符串（含版本号），
 * 而不是解析别名后可能得到的较旧 3P 默认版本。
 *
 * 【动机】
 * Vertex 用户通过 /model 切换到 Opus 4.6 后，spawn 子 Agent 时指定 `model: opus`，
 * 应该获得 Opus 4.6 而非 getDefaultOpusModel() 可能返回的 3P 旧版本。
 * 参见：https://github.com/anthropics/claude-code/issues/30815
 *
 * 【注意】
 * 仅裸家族别名（opus/sonnet/haiku）触发此逻辑；
 * opus[1m]、best、opusplan 等含有额外语义的别名不触发（走正常解析流程）。
 */
function aliasMatchesParentTier(alias: string, parentModel: string): boolean {
  // 获取父模型的规范化短名，用于家族判断
  const canonical = getCanonicalName(parentModel)
  switch (alias.toLowerCase()) {
    case 'opus':
      // 父模型为 Opus 家族时匹配
      return canonical.includes('opus')
    case 'sonnet':
      // 父模型为 Sonnet 家族时匹配
      return canonical.includes('sonnet')
    case 'haiku':
      // 父模型为 Haiku 家族时匹配
      return canonical.includes('haiku')
    default:
      // 非裸家族别名，不触发继承逻辑
      return false
  }
}

/**
 * 生成 Agent 模型的可读显示字符串，用于 UI 展示。
 * - 未设置时显示默认提示（'Inherit from parent (default)'）
 * - 'inherit' 显示 'Inherit from parent'
 * - 其他别名/ID 首字母大写后直接显示
 */
export function getAgentModelDisplay(model: string | undefined): string {
  // 未配置时，运行时 getDefaultSubagentModel() 返回 'inherit'
  if (!model) return 'Inherit from parent (default)'
  if (model === 'inherit') return 'Inherit from parent'
  return capitalize(model)
}

/**
 * 返回 Agent 可用的模型选项列表，供 UI 模型选择器渲染。
 * 包含 sonnet / opus / haiku / inherit（继承父模型）四个选项。
 */
export function getAgentModelOptions(): AgentModelOption[] {
  return [
    {
      value: 'sonnet',
      label: 'Sonnet',
      description: 'Balanced performance - best for most agents',
    },
    {
      value: 'opus',
      label: 'Opus',
      description: 'Most capable for complex reasoning tasks',
    },
    {
      value: 'haiku',
      label: 'Haiku',
      description: 'Fast and efficient for simple tasks',
    },
    {
      value: 'inherit',
      label: 'Inherit from parent',
      description: 'Use the same model as the main conversation',
    },
  ]
}
