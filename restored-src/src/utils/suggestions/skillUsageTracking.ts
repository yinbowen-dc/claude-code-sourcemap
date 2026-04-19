/**
 * MCP 技能使用量追踪模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 该模块属于提示输入（PromptInput）补全建议排序子系统。
 * 当 UI 层展示 MCP 工具/技能（skill）的候选建议时，
 * 本模块提供基于「使用频率 + 时间衰减」的评分，
 * 使最近常用的技能排在建议列表的前面。
 *
 * 主要功能：
 * 1. recordSkillUsage：记录一次技能使用，更新全局配置中的 usageCount 和 lastUsedAt。
 *    - 使用 60 秒防抖（lastWriteBySkill Map），避免高频调用时的锁竞争与文件 I/O。
 * 2. getSkillUsageScore：计算技能的综合得分。
 *    - 采用指数衰减，7 天半衰期：score = usageCount × max(0.5^(days/7), 0.1)
 *    - 最小衰减因子 0.1，保证重度使用但较久未用的技能仍有一定权重。
 *
 * 数据存储：全局配置文件（~/.claude/config.json）中的 skillUsage 字段。
 */

import { getGlobalConfig, saveGlobalConfig } from '../config.js'

// 防抖阈值：同一技能 60 秒内重复调用 recordSkillUsage 不触发文件写入
const SKILL_USAGE_DEBOUNCE_MS = 60_000

/**
 * 进程级防抖缓存：记录每个技能上次写入配置文件的时间戳（毫秒）。
 * 与 config.ts 中 lastConfigStatTime / globalConfigWriteCount 模式相同，
 * 避免在防抖期间触发锁 + 文件读写。
 */
const lastWriteBySkill = new Map<string, number>()

/**
 * 记录一次技能使用，并将统计数据持久化到全局配置。
 *
 * 流程：
 * 1. 获取当前时间戳，与上次写入时间比较。
 * 2. 若距上次写入不足 60 秒（DEBOUNCE），直接返回，跳过 I/O 操作。
 *    - 排名算法使用 7 天半衰期，亚分钟级精度没有意义，可安全跳过。
 * 3. 更新防抖缓存的时间戳。
 * 4. 通过 saveGlobalConfig 原子更新配置：
 *    - usageCount 累加 1
 *    - lastUsedAt 更新为当前时间戳
 *
 * @param skillName MCP 技能/工具的名称（作为配置中的键）
 */
export function recordSkillUsage(skillName: string): void {
  const now = Date.now()
  const lastWrite = lastWriteBySkill.get(skillName)
  // 防抖检查：7 天半衰期下，亚分钟精度不影响排名，安全跳过
  if (lastWrite !== undefined && now - lastWrite < SKILL_USAGE_DEBOUNCE_MS) {
    return
  }
  // 更新防抖时间戳
  lastWriteBySkill.set(skillName, now)
  // 原子更新配置文件中的使用统计
  saveGlobalConfig(current => {
    const existing = current.skillUsage?.[skillName]
    return {
      ...current,
      skillUsage: {
        ...current.skillUsage,
        [skillName]: {
          // 使用次数累加 1（若不存在则从 0 开始）
          usageCount: (existing?.usageCount ?? 0) + 1,
          // 记录本次使用时间
          lastUsedAt: now,
        },
      },
    }
  })
}

/**
 * 计算指定技能的使用得分，用于排序候选建议。
 *
 * 评分公式（指数衰减 + 最低权重保障）：
 *   score = usageCount × max(0.5^(daysSinceUse / 7), 0.1)
 *
 * - 7 天半衰期：7 天前的使用权重是今天的一半。
 * - 最小衰减因子 0.1：防止大量使用但长期未用的技能权重归零，
 *   保留其历史重要性的 10%。
 *
 * @param skillName MCP 技能/工具的名称
 * @returns 综合得分（越高越应排前），若无历史记录返回 0
 */
export function getSkillUsageScore(skillName: string): number {
  const config = getGlobalConfig()
  const usage = config.skillUsage?.[skillName]
  // 无历史记录，得分为 0
  if (!usage) return 0

  // 计算距上次使用的天数
  const daysSinceUse = (Date.now() - usage.lastUsedAt) / (1000 * 60 * 60 * 24)
  // 7 天半衰期的衰减因子
  const recencyFactor = Math.pow(0.5, daysSinceUse / 7)

  // 使用次数乘以衰减因子，最低衰减因子为 0.1
  return usage.usageCount * Math.max(recencyFactor, 0.1)
}
