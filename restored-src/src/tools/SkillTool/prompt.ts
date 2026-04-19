/**
 * SkillTool/prompt.ts — Skill 工具的预算控制与提示词构建
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具层（Tools Layer）→ SkillTool 子模块 → 提示词层
 *
 * 主要功能：
 *   1. 预算控制：计算 Skill 工具描述列表可用的字符预算（上下文窗口的 1%）
 *   2. 格式化：将每条命令格式化为"- name: description"格式的列表项
 *   3. 截断策略：在超出预算时，优先保留 bundled 技能的完整描述，截断其他技能描述
 *   4. 提示词：导出 getPrompt()（memoize 缓存）和静态信息查询函数
 *
 * 设计说明：
 *   - SKILL_BUDGET_CONTEXT_PERCENT：技能列表占上下文窗口的比例（1%）
 *   - MAX_LISTING_DESC_CHARS：单条技能描述的最大字符数（250），防止 whenToUse 过长
 *   - getPrompt 使用 lodash memoize 以 cwd 为 key 缓存，避免重复构建
 *   - bundled 技能（内置技能）永远不被截断，以保证核心功能可发现性
 */

import { memoize } from 'lodash-es'
import type { Command } from 'src/commands.js'
import {
  getCommandName,
  getSkillToolCommands,
  getSlashCommandToolSkills,
} from 'src/commands.js'
import { COMMAND_NAME_TAG } from '../../constants/xml.js'
import { stringWidth } from '../../ink/stringWidth.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { count } from '../../utils/array.js'
import { logForDebugging } from '../../utils/debug.js'
import { toError } from '../../utils/errors.js'
import { truncate } from '../../utils/format.js'
import { logError } from '../../utils/log.js'

// Skill listing gets 1% of the context window (in characters)
// 技能列表占上下文窗口的比例（1%），用于计算最大字符预算
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
// 每个 token 对应的平均字符数（用于将 token 数转换为字符数）
export const CHARS_PER_TOKEN = 4
// 默认字符预算：1% × 200k token × 4 字符/token = 8000 字符（兜底值）
export const DEFAULT_CHAR_BUDGET = 8_000 // Fallback: 1% of 200k × 4

// Per-entry hard cap. The listing is for discovery only — the Skill tool loads
// full content on invoke, so verbose whenToUse strings waste turn-1 cache_creation
// tokens without improving match rate. Applies to all entries, including bundled,
// since the cap is generous enough to preserve the core use case.
// 每条技能描述的最大字符数（发现阶段无需完整文本，调用时才加载全内容）
export const MAX_LISTING_DESC_CHARS = 250

/**
 * 计算技能列表可用的字符预算
 *
 * 优先级：
 *   1. 环境变量 SLASH_COMMAND_TOOL_CHAR_BUDGET（开发/测试覆盖）
 *   2. 上下文窗口 token 数 × CHARS_PER_TOKEN × SKILL_BUDGET_CONTEXT_PERCENT
 *   3. DEFAULT_CHAR_BUDGET（兜底默认值）
 *
 * @param contextWindowTokens 可选的上下文窗口 token 数
 * @returns 技能列表可用的字符数上限
 */
export function getCharBudget(contextWindowTokens?: number): number {
  // 环境变量覆盖优先（开发/测试场景）
  if (Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)) {
    return Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)
  }
  // 根据上下文窗口大小动态计算预算
  if (contextWindowTokens) {
    return Math.floor(
      contextWindowTokens * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT,
    )
  }
  // 兜底默认值
  return DEFAULT_CHAR_BUDGET
}

/**
 * 获取单条命令的展示描述文本
 *
 * 规则：
 *   - 若命令有 whenToUse，则拼接为 "description - whenToUse"
 *   - 超过 MAX_LISTING_DESC_CHARS 时截断并追加省略号（…）
 *
 * @param cmd 命令对象
 * @returns 处理后的描述字符串
 */
function getCommandDescription(cmd: Command): string {
  const desc = cmd.whenToUse
    ? `${cmd.description} - ${cmd.whenToUse}`
    : cmd.description
  return desc.length > MAX_LISTING_DESC_CHARS
    ? desc.slice(0, MAX_LISTING_DESC_CHARS - 1) + '\u2026' // Unicode 省略号
    : desc
}

/**
 * 将单条命令格式化为列表项字符串
 *
 * 格式："- name: description"
 *
 * 注意：若 plugin 技能的 userFacingName 与 cmd.name 不同，会记录调试日志
 *
 * @param cmd 命令对象
 * @returns 格式化后的列表项字符串
 */
function formatCommandDescription(cmd: Command): string {
  // Debug: log if userFacingName differs from cmd.name for plugin skills
  // 调试：记录 plugin 技能的 userFacingName 与 cmd.name 不一致的情况
  const displayName = getCommandName(cmd)
  if (
    cmd.name !== displayName &&
    cmd.type === 'prompt' &&
    cmd.source === 'plugin'
  ) {
    logForDebugging(
      `Skill prompt: showing "${cmd.name}" (userFacingName="${displayName}")`,
    )
  }

  return `- ${cmd.name}: ${getCommandDescription(cmd)}`
}

// 非 bundled 技能描述的最小长度阈值（低于此阈值时退化为仅显示名称）
const MIN_DESC_LENGTH = 20

/**
 * 在字符预算内格式化技能命令列表
 *
 * 整体流程：
 *   1. 命令列表为空时直接返回空字符串
 *   2. 计算字符预算（getCharBudget）
 *   3. 尝试以完整描述格式输出所有命令；若总字符数不超过预算，直接返回
 *   4. 预算不足时，将命令分为 bundled（始终保留完整描述）和 rest（可截断）
 *   5. 计算 rest 命令的最大描述长度（maxDescLen）
 *   6. maxDescLen 过小（< MIN_DESC_LENGTH）时：rest 退化为仅显示名称，bundled 保留完整描述
 *   7. 否则：rest 按 maxDescLen 截断描述，bundled 保留完整描述
 *   8. 每次截断时（仅 USER_TYPE=ant）上报 analytics 事件
 *
 * @param commands 命令列表
 * @param contextWindowTokens 可选的上下文窗口 token 数（用于动态计算预算）
 * @returns 格式化后的技能列表字符串（多行，每行一条技能）
 */
export function formatCommandsWithinBudget(
  commands: Command[],
  contextWindowTokens?: number,
): string {
  // 无命令时直接返回空字符串
  if (commands.length === 0) return ''

  const budget = getCharBudget(contextWindowTokens)

  // Try full descriptions first
  // 尝试以完整描述格式计算所有命令的总字符数
  const fullEntries = commands.map(cmd => ({
    cmd,
    full: formatCommandDescription(cmd),
  }))
  // join('\n') produces N-1 newlines for N entries
  // 计算所有条目的总宽度（含条目间换行符）
  const fullTotal =
    fullEntries.reduce((sum, e) => sum + stringWidth(e.full), 0) +
    (fullEntries.length - 1)

  // 总字符数在预算内，直接返回完整描述列表
  if (fullTotal <= budget) {
    return fullEntries.map(e => e.full).join('\n')
  }

  // Partition into bundled (never truncated) and rest
  // 将命令分为 bundled（内置，始终保留完整描述）和 rest（可截断）
  const bundledIndices = new Set<number>()
  const restCommands: Command[] = []
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i]!
    if (cmd.type === 'prompt' && cmd.source === 'bundled') {
      bundledIndices.add(i)
    } else {
      restCommands.push(cmd)
    }
  }

  // Compute space used by bundled skills (full descriptions, always preserved)
  // 计算 bundled 技能占用的字符数（含每条末尾的换行符）
  const bundledChars = fullEntries.reduce(
    (sum, e, i) =>
      bundledIndices.has(i) ? sum + stringWidth(e.full) + 1 : sum,
    0,
  )
  // 剩余预算分配给非 bundled 命令
  const remainingBudget = budget - bundledChars

  // Calculate max description length for non-bundled commands
  // 无非 bundled 命令时，直接返回全部条目（均为 bundled）
  if (restCommands.length === 0) {
    return fullEntries.map(e => e.full).join('\n')
  }

  // 计算非 bundled 命令名称的固定开销（"- name: " 格式 + 条目间换行）
  const restNameOverhead =
    restCommands.reduce((sum, cmd) => sum + stringWidth(cmd.name) + 4, 0) +
    (restCommands.length - 1)
  // 剩余预算减去名称开销后，分配给描述文本
  const availableForDescs = remainingBudget - restNameOverhead
  // 每条非 bundled 命令可用的最大描述字符数
  const maxDescLen = Math.floor(availableForDescs / restCommands.length)

  if (maxDescLen < MIN_DESC_LENGTH) {
    // Extreme case: non-bundled go names-only, bundled keep descriptions
    // 极端情况：描述空间不足，非 bundled 技能退化为仅显示名称
    if (process.env.USER_TYPE === 'ant') {
      // 仅内部用户上报 analytics 事件，防止泄露用户技能信息
      logEvent('tengu_skill_descriptions_truncated', {
        skill_count: commands.length,
        budget,
        full_total: fullTotal,
        truncation_mode:
          'names_only' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        max_desc_length: maxDescLen,
        bundled_count: bundledIndices.size,
        bundled_chars: bundledChars,
      })
    }
    // bundled 保留完整描述，非 bundled 仅显示名称
    return commands
      .map((cmd, i) =>
        bundledIndices.has(i) ? fullEntries[i]!.full : `- ${cmd.name}`,
      )
      .join('\n')
  }

  // Truncate non-bundled descriptions to fit within budget
  // 计算需要截断的非 bundled 技能数量（用于 analytics）
  const truncatedCount = count(
    restCommands,
    cmd => stringWidth(getCommandDescription(cmd)) > maxDescLen,
  )
  if (process.env.USER_TYPE === 'ant') {
    logEvent('tengu_skill_descriptions_truncated', {
      skill_count: commands.length,
      budget,
      full_total: fullTotal,
      truncation_mode:
        'description_rimmed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      max_desc_length: maxDescLen,
      truncated_count: truncatedCount,
      // Count of bundled skills included in this prompt (excludes skills with disableModelInvocation)
      // bundled 技能数量（排除了 disableModelInvocation 的技能）
      bundled_count: bundledIndices.size,
      bundled_chars: bundledChars,
    })
  }
  // 非 bundled 技能按 maxDescLen 截断描述，bundled 技能保留完整描述
  return commands
    .map((cmd, i) => {
      // Bundled skills always get full descriptions
      // bundled 技能始终保留完整描述
      if (bundledIndices.has(i)) return fullEntries[i]!.full
      const description = getCommandDescription(cmd)
      return `- ${cmd.name}: ${truncate(description, maxDescLen)}`
    })
    .join('\n')
}

/**
 * 获取 Skill 工具的系统提示词（memoize 缓存，以 cwd 为 key）
 *
 * 整体流程：
 *   - 返回完整的 Markdown 提示词，指导模型何时及如何调用 Skill 工具
 *   - 包含调用示例、全限定名格式、COMMAND_NAME_TAG 检测说明等
 *   - 以 cwd 为 memoize key，同一工作目录只构建一次
 *
 * @param _cwd 当前工作目录（作为 memoize 缓存 key，不直接使用）
 * @returns 完整的提示词字符串（Promise）
 */
export const getPrompt = memoize(async (_cwd: string): Promise<string> => {
  return `Execute a skill within the main conversation

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Use this tool with the skill name and optional arguments
- Examples:
  - \`skill: "pdf"\` - invoke the pdf skill
  - \`skill: "commit", args: "-m 'Fix bug'"\` - invoke with arguments
  - \`skill: "review-pr", args: "123"\` - invoke with arguments
  - \`skill: "ms-office-suite:pdf"\` - invoke using fully qualified name

Important:
- Available skills are listed in system-reminder messages in the conversation
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)
- If you see a <${COMMAND_NAME_TAG}> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again
`
})

/**
 * 获取 Skill 工具的统计信息（总命令数 / 包含命令数）
 *
 * @param cwd 当前工作目录
 * @returns { totalCommands, includedCommands }（目前两者相同，所有命令都包含）
 */
export async function getSkillToolInfo(cwd: string): Promise<{
  totalCommands: number
  includedCommands: number
}> {
  const agentCommands = await getSkillToolCommands(cwd)

  return {
    totalCommands: agentCommands.length,
    includedCommands: agentCommands.length,
  }
}

// Returns the commands included in the SkillTool prompt.
// All commands are always included (descriptions may be truncated to fit budget).
// Used by analyzeContext to count skill tokens.
/**
 * 获取 Skill 工具提示词中包含的命令列表
 *
 * 所有命令都会被包含（描述可能被截断以适应预算）。
 * 供 analyzeContext 计算技能 token 使用。
 *
 * @param cwd 当前工作目录
 * @returns 包含的命令列表（Promise）
 */
export function getLimitedSkillToolCommands(cwd: string): Promise<Command[]> {
  return getSkillToolCommands(cwd)
}

/**
 * 清除 getPrompt 的 memoize 缓存
 *
 * 在工作目录切换或技能列表变更时调用，强制下次重新构建提示词
 */
export function clearPromptCache(): void {
  getPrompt.cache?.clear?.()
}

/**
 * 获取技能（slash command skills）的统计信息
 *
 * 整体流程：
 *   1. 调用 getSlashCommandToolSkills 获取所有技能
 *   2. 返回总数和包含数（目前两者相同）
 *   3. 出错时记录错误日志并返回 { 0, 0 }，不向上抛出异常
 *
 * @param cwd 当前工作目录
 * @returns { totalSkills, includedSkills }
 */
export async function getSkillInfo(cwd: string): Promise<{
  totalSkills: number
  includedSkills: number
}> {
  try {
    const skills = await getSlashCommandToolSkills(cwd)

    return {
      totalSkills: skills.length,
      includedSkills: skills.length,
    }
  } catch (error) {
    // 记录错误日志，向调用方返回零值而非抛出异常
    logError(toError(error))

    // Return zeros rather than throwing - let caller decide how to handle
    return {
      totalSkills: 0,
      includedSkills: 0,
    }
  }
}
