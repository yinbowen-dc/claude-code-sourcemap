/**
 * 模型白名单过滤模块（Model Allowlist Filtering）
 *
 * 【在 Claude Code 系统流中的位置】
 * 本文件实现 settings.availableModels 白名单机制，用于限制用户可使用的模型范围。
 * 被以下模块调用：
 *   - model.ts           : getUserSpecifiedModelSetting — 过滤用户配置的模型
 *   - validateModel.ts   : validateModel — API 调用前先过滤
 *   - modelOptions.ts    : filterModelOptionsByAllowlist — 过滤 /model 选择器列表
 *
 * 【三级匹配规则】（优先级从高到低）
 * 1. 家族别名通配符（'opus'、'sonnet'、'haiku'）
 *    → 匹配该家族所有版本，BUT 若白名单中同时存在更具体的条目（如 'opus-4-5'），
 *      则家族通配符失效，改为只允许具体条目指定的版本
 * 2. 版本前缀匹配（'opus-4-5'、'claude-opus-4-5'）
 *    → 在段边界处匹配（'-' 或字符串结尾），避免 'opus-4-50' 误匹配 'opus-4-5'
 * 3. 精确完整模型 ID 匹配（'claude-opus-4-5-20251101'）
 *
 * 【白名单为空时的行为】
 * - 未设置 availableModels       → 所有模型均允许
 * - availableModels 为空数组 [] → 所有用户指定模型均被阻止
 *
 * 【主要导出】
 * - isModelAllowed : 判断指定模型是否在白名单中
 */

import { getSettings_DEPRECATED } from '../settings/settings.js'
import { isModelAlias, isModelFamilyAlias } from './aliases.js'
import { parseUserSpecifiedModel } from './model.js'
import { resolveOverriddenModel } from './modelStrings.js'

/**
 * 判断给定模型是否属于指定家族。
 *
 * 检查模型名本身是否包含家族标识符；若模型为别名，先解析为完整 ID 再检查。
 * 例如：modelBelongsToFamily('best', 'opus') 先将 'best' 解析为 'claude-opus-4-6'，
 * 再判断是否包含 'opus'。
 *
 * @param model  模型名或别名
 * @param family 家族标识符（如 'opus'、'sonnet'、'haiku'）
 */
function modelBelongsToFamily(model: string, family: string): boolean {
  if (model.includes(family)) {
    return true
  }
  // 将 'best' 等别名解析为完整名再判断家族归属
  if (isModelAlias(model)) {
    const resolved = parseUserSpecifiedModel(model).toLowerCase()
    return resolved.includes(family)
  }
  return false
}

/**
 * 检查模型名是否以指定前缀在段边界处开头。
 *
 * 【段边界规则】
 * 前缀必须匹配到字符串结尾，或之后紧跟 '-' 分隔符。
 * 这样 'claude-opus-4-5' 可匹配 'claude-opus-4-5-20251101'，
 * 但不会误匹配 'claude-opus-4-50'。
 *
 * @param modelName 完整模型名（已小写）
 * @param prefix    要匹配的前缀字符串
 */
function prefixMatchesModel(modelName: string, prefix: string): boolean {
  if (!modelName.startsWith(prefix)) {
    return false
  }
  // 前缀等于全名，或前缀后紧跟 '-'，才算匹配
  return modelName.length === prefix.length || modelName[prefix.length] === '-'
}

/**
 * 检查模型是否与白名单中的版本前缀条目匹配。
 *
 * 【速记格式支持】
 * 白名单可使用 'opus-4-5'（省略 'claude-' 前缀）或完整的 'claude-opus-4-5'。
 * 若条目不以 'claude-' 开头，会自动尝试补上前缀后再匹配。
 *
 * 若输入 model 本身是别名，先解析为完整 ID 再做前缀匹配。
 *
 * @param model 要检测的模型名或别名
 * @param entry 白名单中的版本前缀条目
 */
function modelMatchesVersionPrefix(model: string, entry: string): boolean {
  // 别名先解析为完整 ID
  const resolvedModel = isModelAlias(model)
    ? parseUserSpecifiedModel(model).toLowerCase()
    : model

  // 尝试条目原文（如 'claude-opus-4-5'）
  if (prefixMatchesModel(resolvedModel, entry)) {
    return true
  }
  // 尝试补 'claude-' 前缀（如 'opus-4-5' → 'claude-opus-4-5'）
  if (
    !entry.startsWith('claude-') &&
    prefixMatchesModel(resolvedModel, `claude-${entry}`)
  ) {
    return true
  }
  return false
}

/**
 * 检查指定家族是否在白名单中存在更具体的版本条目（即家族通配符是否被收窄）。
 *
 * 当白名单同时包含 'opus' 和 'opus-4-5' 时，'opus' 通配符失效，
 * 仅 'opus-4-5' 前缀的版本被允许。
 *
 * 【边界判断规则】
 * 确保 'opus' 家族不会被 'opusplan' 等条目误认为是具体版本，
 * 通过检查家族名后必须为 '-' 或字符串结尾来防止误匹配。
 *
 * @param family    家族标识符（如 'opus'）
 * @param allowlist 已规范化的白名单数组
 */
function familyHasSpecificEntries(
  family: string,
  allowlist: string[],
): boolean {
  for (const entry of allowlist) {
    // 跳过家族别名本身（如 'opus'、'sonnet'、'haiku'）
    if (isModelFamilyAlias(entry)) {
      continue
    }
    // 检查条目是否为该家族的版本限定变体（如 'opus-4-5' 或 'claude-opus-4-5-20251101'）
    const idx = entry.indexOf(family)
    if (idx === -1) {
      continue
    }
    const afterFamily = idx + family.length
    // 家族名后必须为 '-' 或字符串结尾，防止 'opusplan' 误匹配 'opus'
    if (afterFamily === entry.length || entry[afterFamily] === '-') {
      return true
    }
  }
  return false
}

/**
 * 检查指定模型是否在 settings.availableModels 白名单中。
 *
 * 【白名单未设置时】
 * 返回 true（无限制）。
 *
 * 【匹配顺序】
 * 1. 直接匹配（字符串相等），但家族别名被具体条目收窄时跳过
 * 2. 家族别名通配符（仅在无具体条目时有效）
 * 3. 双向别名解析：模型别名 → 解析后完整名；白名单别名 → 解析后完整名
 * 4. 版本前缀匹配（非家族、非别名的白名单条目）
 *
 * @param model 要检测的模型名或别名
 * @returns true 表示允许，false 表示被白名单阻止
 */
export function isModelAllowed(model: string): boolean {
  const settings = getSettings_DEPRECATED() || {}
  const { availableModels } = settings
  if (!availableModels) {
    // 未设置白名单，所有模型均允许
    return true
  }
  if (availableModels.length === 0) {
    // 空白名单阻止所有用户指定模型
    return false
  }

  // 反解 modelOverrides（Bedrock ARN 等）后规范化为小写
  const resolvedModel = resolveOverriddenModel(model)
  const normalizedModel = resolvedModel.trim().toLowerCase()
  const normalizedAllowlist = availableModels.map(m => m.trim().toLowerCase())

  // 直接字符串匹配，但若家族别名已被具体条目收窄则跳过
  // 例如：['opus', 'opus-4-5'] 中的 'opus' 通配符被 'opus-4-5' 收窄后不直接通过
  if (normalizedAllowlist.includes(normalizedModel)) {
    if (
      !isModelFamilyAlias(normalizedModel) ||
      !familyHasSpecificEntries(normalizedModel, normalizedAllowlist)
    ) {
      return true
    }
  }

  // 家族别名通配符匹配（仅在白名单中无更具体条目时生效）
  for (const entry of normalizedAllowlist) {
    if (
      isModelFamilyAlias(entry) &&
      !familyHasSpecificEntries(entry, normalizedAllowlist) &&
      modelBelongsToFamily(normalizedModel, entry)
    ) {
      return true
    }
  }

  // 双向别名解析：若输入是别名，解析后再与白名单精确比对
  if (isModelAlias(normalizedModel)) {
    const resolved = parseUserSpecifiedModel(normalizedModel).toLowerCase()
    if (normalizedAllowlist.includes(resolved)) {
      return true
    }
  }

  // 反向解析：白名单中的非家族别名解析后是否等于输入模型
  for (const entry of normalizedAllowlist) {
    if (!isModelFamilyAlias(entry) && isModelAlias(entry)) {
      const resolved = parseUserSpecifiedModel(entry).toLowerCase()
      if (resolved === normalizedModel) {
        return true
      }
    }
  }

  // 版本前缀匹配：'opus-4-5' 或 'claude-opus-4-5' 匹配含版本号的完整 ID
  for (const entry of normalizedAllowlist) {
    if (!isModelFamilyAlias(entry) && !isModelAlias(entry)) {
      if (modelMatchesVersionPrefix(normalizedModel, entry)) {
        return true
      }
    }
  }

  return false
}
