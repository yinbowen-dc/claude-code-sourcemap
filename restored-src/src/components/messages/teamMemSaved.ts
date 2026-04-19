/**
 * teamMemSaved.ts
 *
 * 在 Claude Code 系统流程中的位置：
 * 该模块是团队记忆（TEAMMEM）功能链路上的辅助工具函数层，
 * 专门用于为"记忆已保存"（memory_saved）UI 消息提供团队记忆部分的文案片段。
 * 仅在 feature('TEAMMEM') 为 true 时才会被加载，外部构建中会被 DCE 删除。
 *
 * 主要功能：
 * - 从 SystemMemorySavedMessage 中提取 teamCount 字段
 * - 生成格式化的文案片段（如 "2 team memories"）
 * - 同时返回计数值，让调用方无需再次访问 teamCount 即可推导私有记忆数量
 *
 * 设计说明：
 * 故意设计为普通函数而非 React 组件，以避免 React Compiler 对
 * teamCount 属性访问进行提升（hoist）记忆化，防止出现不必要的缓存行为。
 */
import type { SystemMemorySavedMessage } from '../../types/message.js'

/**
 * teamMemSavedPart
 *
 * 流程说明：
 * 1. 读取 message.teamCount，若未定义则默认为 0
 * 2. 若计数为 0，表示没有团队记忆被保存，返回 null（调用方跳过团队部分）
 * 3. 否则根据计数是否为 1 决定单复数（memory / memories），
 *    构建格式化片段字符串，如 "1 team memory" 或 "3 team memories"
 * 4. 同时返回 count，让调用方通过总数减去 count 即可得到私有记忆数量
 *
 * 在系统流程中的角色：
 * 被 memory_saved 消息的渲染组件调用，仅在团队记忆功能启用时才有意义。
 */
export function teamMemSavedPart(
  message: SystemMemorySavedMessage,
): { segment: string; count: number } | null {
  // 若 teamCount 未定义则默认为 0，避免 undefined 引发 NaN 计算
  const count = message.teamCount ?? 0
  // 计数为 0 时无团队记忆被保存，返回 null 让调用方跳过团队记忆部分
  if (count === 0) return null
  return {
    // 根据单复数规则格式化文案片段
    segment: `${count} team ${count === 1 ? 'memory' : 'memories'}`,
    // 同时返回计数，让调用方无需再次访问 message.teamCount 即可推导私有记忆数量
    count,
  }
}
