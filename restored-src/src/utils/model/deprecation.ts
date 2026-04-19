/**
 * 模型废弃信息工具模块（Model Deprecation Utilities）
 *
 * 【在 Claude Code 系统流中的位置】
 * 本文件是模型废弃告警体系的数据层和逻辑层，向用户展示所选模型的退役日期警告。
 *
 * 调用链路：
 *   渲染层（REPL 模型警告 / /model 命令输出）
 *     → getModelDeprecationWarning(modelId)
 *     → getDeprecatedModelInfo(modelId)
 *     → DEPRECATED_MODELS（静态数据源）+ getAPIProvider()（确定当前提供商）
 *
 * 【废弃模型数据结构】
 * DEPRECATED_MODELS 以模型 ID 子串为键（大小写不敏感匹配），值为：
 *   - modelName      : 人类可读的模型名称（用于告警消息）
 *   - retirementDates: 按提供商区分的退役日期（null 表示该提供商暂未废弃）
 *
 * 【主要导出】
 * - getModelDeprecationWarning : 获取指定模型 ID 的废弃警告字符串（或 null）
 */

import { type APIProvider, getAPIProvider } from './providers.js'

/** 已废弃模型的详细信息（isDeprecated 为 true 时的分支） */
type DeprecatedModelInfo = {
  isDeprecated: true
  modelName: string      // 模型人类可读名称
  retirementDate: string // 当前提供商的退役日期字符串
}

/** 非废弃状态信息 */
type NotDeprecatedInfo = {
  isDeprecated: false
}

/** 废弃检测结果的判别联合类型 */
type DeprecationInfo = DeprecatedModelInfo | NotDeprecatedInfo

/** DEPRECATED_MODELS 注册表中每条废弃记录的结构 */
type DeprecationEntry = {
  /** 模型的人类可读名称 */
  modelName: string
  /** 按提供商区分的退役日期映射（null 表示该提供商不废弃此模型） */
  retirementDates: Record<APIProvider, string | null>
}

/**
 * 废弃模型注册表：包含当前已知所有废弃 Claude 模型的退役日期信息。
 *
 * 【匹配规则】
 * 键为模型 ID 的子串（大小写不敏感），只要 modelId.toLowerCase().includes(key) 即匹配。
 * 例如键 'claude-3-opus' 可匹配 'claude-3-opus-20240229'、'us.anthropic.claude-3-opus-…' 等。
 *
 * 【新增废弃模型】
 * 在此对象中添加新条目，填写各提供商的退役日期（不废弃的提供商填 null）。
 */
const DEPRECATED_MODELS: Record<string, DeprecationEntry> = {
  'claude-3-opus': {
    modelName: 'Claude 3 Opus',
    retirementDates: {
      firstParty: 'January 5, 2026',
      bedrock: 'January 15, 2026',
      vertex: 'January 5, 2026',
      foundry: 'January 5, 2026',
    },
  },
  'claude-3-7-sonnet': {
    modelName: 'Claude 3.7 Sonnet',
    retirementDates: {
      firstParty: 'February 19, 2026',
      bedrock: 'April 28, 2026',
      vertex: 'May 11, 2026',
      foundry: 'February 19, 2026',
    },
  },
  'claude-3-5-haiku': {
    modelName: 'Claude 3.5 Haiku',
    retirementDates: {
      firstParty: 'February 19, 2026',
      // Bedrock 和 Vertex 暂未设置退役日期（null = 该提供商不显示废弃警告）
      bedrock: null,
      vertex: null,
      foundry: null,
    },
  },
}

/**
 * 检测指定模型 ID 是否已废弃，并返回废弃详情。
 *
 * 【检测流程】
 * 1. 将 modelId 转小写后逐一与 DEPRECATED_MODELS 的键进行子串匹配
 * 2. 匹配到键后，读取当前提供商（getAPIProvider()）对应的退役日期
 * 3. 若退役日期为 null，视为当前提供商不废弃此模型，继续检查下一条
 * 4. 找到匹配且有退役日期时，返回 DeprecatedModelInfo
 * 5. 无匹配时返回 { isDeprecated: false }
 *
 * @param modelId 要检测的模型 ID 字符串
 * @returns DeprecationInfo 判别联合对象
 */
function getDeprecatedModelInfo(modelId: string): DeprecationInfo {
  const lowercaseModelId = modelId.toLowerCase()
  // 获取当前运行环境的 API 提供商，用于查找对应退役日期
  const provider = getAPIProvider()

  for (const [key, value] of Object.entries(DEPRECATED_MODELS)) {
    const retirementDate = value.retirementDates[provider]
    // 子串不匹配，或当前提供商退役日期为 null，跳过此条
    if (!lowercaseModelId.includes(key) || !retirementDate) {
      continue
    }
    return {
      isDeprecated: true,
      modelName: value.modelName,
      retirementDate,
    }
  }

  // 未命中任何废弃记录
  return { isDeprecated: false }
}

/**
 * 获取指定模型 ID 的废弃警告消息。
 *
 * @param modelId 模型 ID（可为 null，null 时直接返回 null）
 * @returns 格式化的废弃警告字符串，如模型未废弃则返回 null
 *          示例："⚠ Claude 3.7 Sonnet will be retired on February 19, 2026. Consider switching to a newer model."
 */
export function getModelDeprecationWarning(
  modelId: string | null,
): string | null {
  // null 模型 ID 无需检测，直接返回
  if (!modelId) {
    return null
  }

  const info = getDeprecatedModelInfo(modelId)
  // 模型未废弃，无需展示警告
  if (!info.isDeprecated) {
    return null
  }

  // 返回带有退役日期的警告消息，引导用户切换到新版模型
  return `⚠ ${info.modelName} will be retired on ${info.retirementDate}. Consider switching to a newer model.`
}
