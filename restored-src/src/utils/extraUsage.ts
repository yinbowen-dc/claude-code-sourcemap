/**
 * 额外用量计费判断模块。
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本模块位于计费与订阅判断层，被 UI 组件和费用提示逻辑调用，
 * 决定是否需要向用户显示"额外用量"账单提示（如 claude.ai 订阅下
 * 使用高算力模型时触发额外用量计费）。
 *
 * 【主要功能】
 * - isBilledAsExtraUsage()：判断当前模型与会话状态是否触发额外计费
 *   - 条件1：用户是 ClaudeAI 订阅用户
 *   - 条件2：处于 Fast Mode（企鹅模式），或使用带 1M 上下文的 Opus/Sonnet 4.6 模型
 * - isOpus1mMerged 标志用于处理 Opus 1M 合并场景（合并后不再额外计费）
 */
import { isClaudeAISubscriber } from './auth.js'
import { has1mContext } from './context.js'

/**
 * 判断当前模型使用是否应计为订阅的额外用量。
 *
 * 【判断逻辑】
 * 1. 若非 ClaudeAI 订阅用户，直接返回 false（不计费）
 * 2. 若处于 Fast Mode，直接返回 true（Fast Mode 本身即为额外用量）
 * 3. 若模型为 null 或不支持 1M 上下文，返回 false
 * 4. 对模型名称进行规范化（去除 [1m] 后缀、转小写）
 * 5. 检测是否为 Opus 4.6 或 Sonnet 4.6 模型：
 *    - 若为 Opus 4.6 且 isOpus1mMerged=true（1M 已合入基础配额），返回 false
 *    - 否则，Opus 4.6 或 Sonnet 4.6 均视为额外用量
 *
 * @param model          - 当前使用的模型标识字符串，null 表示未指定
 * @param isFastMode     - 是否处于 Fast Mode（企鹅模式）
 * @param isOpus1mMerged - Opus 1M 上下文是否已合入基础配额（合并后不单独计费）
 * @returns 若当前用量应计为额外用量则返回 true，否则返回 false
 */
export function isBilledAsExtraUsage(
  model: string | null,
  isFastMode: boolean,
  isOpus1mMerged: boolean,
): boolean {
  // 非订阅用户不存在"额外用量"概念，直接返回 false
  if (!isClaudeAISubscriber()) return false
  // Fast Mode（企鹅模式）本身即为额外用量，直接返回 true
  if (isFastMode) return true
  // 模型未指定或不支持 1M 上下文时，不触发额外计费
  if (model === null || !has1mContext(model)) return false

  // 规范化模型名称：转小写并去除 [1m] 后缀（如 "opus[1m]" → "opus"）
  const m = model
    .toLowerCase()
    .replace(/\[1m\]$/, '')
    .trim()
  // 判断是否为 Opus 4.6 系列（直接别名"opus"或包含"opus-4-6"）
  const isOpus46 = m === 'opus' || m.includes('opus-4-6')
  // 判断是否为 Sonnet 4.6 系列（直接别名"sonnet"或包含"sonnet-4-6"）
  const isSonnet46 = m === 'sonnet' || m.includes('sonnet-4-6')

  // Opus 4.6 在 1M 已合并时，不再单独计费
  if (isOpus46 && isOpus1mMerged) return false

  // Opus 4.6 或 Sonnet 4.6 触发额外用量计费
  return isOpus46 || isSonnet46
}
