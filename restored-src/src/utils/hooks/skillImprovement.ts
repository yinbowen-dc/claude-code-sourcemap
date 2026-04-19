/**
 * 【技能改进检测模块】
 *
 * 本文件在 Claude Code 系统流中的位置：
 *   模型采样完成 → executePostSamplingHooks → skillImprovement（当前文件）
 *                                                 → applySkillImprovement（侧通道 LLM 改写 SKILL.md）
 *
 * 主要职责：
 * 1. 定义 SkillUpdate 类型：描述一次技能改进的结构（section、change、reason）
 * 2. formatRecentMessages：将消息历史格式化为人类可读文本（每条截断至 500 字符）
 * 3. findProjectSkill：查找当前 agent 调用的 projectSettings 级别技能
 * 4. createSkillImprovementHook：创建采样后 Hook，每 TURN_BATCH_SIZE=5 轮触发一次
 *    使用小型快速模型分析对话，检测用户偏好变化
 * 5. initSkillImprovement：在 feature flag + GrowthBook gate 通过时注册 Hook
 * 6. applySkillImprovement：通过侧通道 LLM 重写 SKILL.md 文件，fire-and-forget
 *
 * 触发条件：
 * - feature('SKILL_IMPROVEMENT') 为真（编译期 bundle 特性标志）
 * - GrowthBook feature 'tengu_copper_panda' 为真（运行时开关，默认 false）
 * - querySource === 'repl_main_thread'（非 agent 子线程）
 * - 项目存在 projectSettings 级别的技能
 * - 累计用户消息数 ≥ TURN_BATCH_SIZE 的倍数
 */

import { feature } from 'bun:bundle'
import { getInvokedSkillsForAgent } from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../../services/analytics/index.js'
import { queryModelWithoutStreaming } from '../../services/api/claude.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { createAbortController } from '../abortController.js'
import { count } from '../array.js'
import { getCwd } from '../cwd.js'
import { toError } from '../errors.js'
import { logError } from '../log.js'
import {
  createUserMessage,
  extractTag,
  extractTextContent,
} from '../messages.js'
import { getSmallFastModel } from '../model/model.js'
import { jsonParse } from '../slowOperations.js'
import { asSystemPrompt } from '../systemPromptType.js'
import {
  type ApiQueryHookConfig,
  createApiQueryHook,
} from './apiQueryHookHelper.js'
import { registerPostSamplingHook } from './postSamplingHooks.js'

// 每 TURN_BATCH_SIZE 轮用户消息触发一次技能改进分析
const TURN_BATCH_SIZE = 5

/**
 * 技能改进建议的数据类型。
 * 由小型 LLM 分析对话后输出，每项描述一个具体的改进点。
 */
export type SkillUpdate = {
  section: string  // 要修改的步骤/章节名称，或 'new step'
  change: string   // 具体的修改内容
  reason: string   // 触发此改进的用户消息
}

/**
 * 将消息历史格式化为可读文本，供小型 LLM 分析。
 * 只保留 user 和 assistant 类型的消息，每条截断至 500 字符，避免超出 token 限制。
 *
 * @param messages  完整消息历史数组
 * @returns         格式化后的对话文本（每轮以 "User:" / "Assistant:" 标记）
 */
function formatRecentMessages(messages: Message[]): string {
  return messages
    .filter(m => m.type === 'user' || m.type === 'assistant')
    .map(m => {
      const role = m.type === 'user' ? 'User' : 'Assistant'
      const content = m.message.content
      // 处理纯字符串内容
      if (typeof content === 'string')
        return `${role}: ${content.slice(0, 500)}`
      // 处理结构化内容（content block 数组），提取 text 类型后拼接
      const text = content
        .filter(
          (b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text',
        )
        .map(b => b.text)
        .join('\n')
      return `${role}: ${text.slice(0, 500)}`
    })
    .join('\n\n')
}

/**
 * 在当前 agent 调用的技能列表中查找 projectSettings 级别的技能。
 * 技能改进只对项目级技能有效（路径以 'projectSettings:' 开头）。
 *
 * @returns  找到的技能信息对象，若无 projectSettings 级技能则返回 undefined
 */
function findProjectSkill() {
  // 获取当前 agent（null 表示主 agent）的已调用技能映射
  const skills = getInvokedSkillsForAgent(null)
  for (const [, info] of skills) {
    // 检查技能路径是否来自 projectSettings（项目级）
    if (info.skillPath.startsWith('projectSettings:')) {
      return info
    }
  }
  return undefined
}

/**
 * 创建技能改进采样后 Hook。
 * 该 Hook 在每次模型采样后检查是否需要分析对话，
 * 每 TURN_BATCH_SIZE 轮用户消息执行一次分析（避免频繁调用 LLM）。
 *
 * Hook 内部使用闭包维护状态：
 * - lastAnalyzedCount：上次分析时的用户消息数（防止重复分析）
 * - lastAnalyzedIndex：上次分析时的消息索引（只分析新增消息）
 *
 * @returns  实现了 ApiQueryHookConfig 的采样后 Hook 函数
 */
function createSkillImprovementHook() {
  // 闭包状态：记录上次分析的用户消息计数（用于批次判断）
  let lastAnalyzedCount = 0
  // 闭包状态：记录上次分析时消息数组的索引（只发送新消息给 LLM）
  let lastAnalyzedIndex = 0

  const config: ApiQueryHookConfig<SkillUpdate[]> = {
    name: 'skill_improvement',

    /**
     * 判断是否需要运行技能改进分析。
     * 触发条件：主线程、存在项目级技能、新用户消息数 ≥ TURN_BATCH_SIZE。
     */
    async shouldRun(context) {
      // 只在主线程（repl_main_thread）运行，避免 agent 子线程干扰
      if (context.querySource !== 'repl_main_thread') {
        return false
      }

      // 若无项目级技能，无需改进
      if (!findProjectSkill()) {
        return false
      }

      // 计算新增用户消息数，每 TURN_BATCH_SIZE 轮触发一次
      const userCount = count(context.messages, m => m.type === 'user')
      if (userCount - lastAnalyzedCount < TURN_BATCH_SIZE) {
        return false
      }

      // 更新已分析计数，触发本次分析
      lastAnalyzedCount = userCount
      return true
    },

    /**
     * 构建发给小型 LLM 的分析请求消息。
     * 只包含上次分析后的新消息，减少 token 消耗。
     */
    buildMessages(context) {
      const projectSkill = findProjectSkill()!
      // 只分析自上次检查后的新消息（lastAnalyzedIndex 之后的部分）
      const newMessages = context.messages.slice(lastAnalyzedIndex)
      // 更新索引，下次从当前末尾继续
      lastAnalyzedIndex = context.messages.length

      return [
        createUserMessage({
          content: `You are analyzing a conversation where a user is executing a skill (a repeatable process).
Your job: identify if the user's recent messages contain preferences, requests, or corrections that should be permanently added to the skill definition for future runs.

<skill_definition>
${projectSkill.content}
</skill_definition>

<recent_messages>
${formatRecentMessages(newMessages)}
</recent_messages>

Look for:
- Requests to add, change, or remove steps: "can you also ask me X", "please do Y too", "don't do Z"
- Preferences about how steps should work: "ask me about energy levels", "note the time", "use a casual tone"
- Corrections: "no, do X instead", "always use Y", "make sure to..."

Ignore:
- Routine conversation that doesn't generalize (one-time answers, chitchat)
- Things the skill already does

Output a JSON array inside <updates> tags. Each item: {"section": "which step/section to modify or 'new step'", "change": "what to add/modify", "reason": "which user message prompted this"}.
Output <updates>[]</updates> if no updates are needed.`,
        }),
      ]
    },

    // 小型 LLM 的系统提示：专注于检测用户偏好和流程改进
    systemPrompt:
      'You detect user preferences and process improvements during skill execution. Flag anything the user asks for that should be remembered for next time.',

    // 不使用工具（纯文本分析）
    useTools: false,

    /**
     * 解析 LLM 响应，提取 <updates> 标签内的 JSON 数组。
     * 若无标签或解析失败，返回空数组（不影响主流程）。
     */
    parseResponse(content) {
      // 提取 <updates>...</updates> 标签内容
      const updatesStr = extractTag(content, 'updates')
      if (!updatesStr) {
        return []
      }
      try {
        return jsonParse(updatesStr) as SkillUpdate[]
      } catch {
        // JSON 解析失败时静默返回空数组
        return []
      }
    },

    /**
     * 记录分析结果：若发现改进建议，上报分析事件并更新应用状态。
     * 通过 setAppState 写入 skillImprovement 状态，触发 UI 提示用户。
     */
    logResult(result, context) {
      if (result.type === 'success' && result.result.length > 0) {
        const projectSkill = findProjectSkill()
        const skillName = projectSkill?.skillName ?? 'unknown'

        // 上报技能改进检测事件（包含更新数量和 UUID，不含代码/路径）
        logEvent('tengu_skill_improvement_detected', {
          updateCount: result.result
            .length as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          uuid: result.uuid as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          // _PROTO_skill_name 路由到 BigQuery 中受保护的 skill_name 列（PII 标记）
          _PROTO_skill_name:
            skillName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
        })

        // 写入应用状态，通知 UI 显示技能改进建议
        context.toolUseContext.setAppState(prev => ({
          ...prev,
          skillImprovement: {
            suggestion: { skillName, updates: result.result },
          },
        }))
      }
    },

    // 使用小型快速模型（节省成本，不需要高智能）
    getModel: getSmallFastModel,
  }

  return createApiQueryHook(config)
}

/**
 * 初始化技能改进功能（在应用启动时调用）。
 * 仅在编译期特性标志和 GrowthBook 运行时开关均启用时注册 Hook。
 *
 * 两层守卫：
 * 1. feature('SKILL_IMPROVEMENT')：编译期 bundle 特性标志（tree-shaking 支持）
 * 2. getFeatureValue_CACHED_MAY_BE_STALE('tengu_copper_panda', false)：
 *    GrowthBook 运行时开关（kill switch，默认 false）
 */
export function initSkillImprovement(): void {
  if (
    feature('SKILL_IMPROVEMENT') &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_copper_panda', false)
  ) {
    // 注册采样后 Hook，每次模型输出后执行技能改进检测
    registerPostSamplingHook(createSkillImprovementHook())
  }
}

/**
 * 应用技能改进：通过侧通道 LLM 重写 SKILL.md 文件。
 * Fire-and-forget 模式——不阻塞主对话流程。
 *
 * 流程：
 * 1. 读取当前 SKILL.md 文件内容
 * 2. 构建包含当前内容和改进建议的 prompt
 * 3. 调用小型 LLM，要求其输出更新后的完整文件
 * 4. 提取 <updated_file> 标签内的内容，写回磁盘
 *
 * @param skillName  技能名称（对应 .claude/skills/<name>/ 目录）
 * @param updates    要应用的改进建议列表
 */
export async function applySkillImprovement(
  skillName: string,
  updates: SkillUpdate[],
): Promise<void> {
  // 若技能名称为空，直接返回
  if (!skillName) return

  const { join } = await import('path')
  const fs = await import('fs/promises')

  // 技能文件路径：<CWD>/.claude/skills/<skillName>/SKILL.md
  const filePath = join(getCwd(), '.claude', 'skills', skillName, 'SKILL.md')

  let currentContent: string
  try {
    // 读取现有的技能定义文件
    currentContent = await fs.readFile(filePath, 'utf-8')
  } catch {
    logError(
      new Error(`Failed to read skill file for improvement: ${filePath}`),
    )
    return
  }

  // 格式化改进列表为可读文本
  const updateList = updates.map(u => `- ${u.section}: ${u.change}`).join('\n')

  // 调用小型 LLM，要求其按规则重写技能文件
  const response = await queryModelWithoutStreaming({
    messages: [
      createUserMessage({
        content: `You are editing a skill definition file. Apply the following improvements to the skill.

<current_skill_file>
${currentContent}
</current_skill_file>

<improvements>
${updateList}
</improvements>

Rules:
- Integrate the improvements naturally into the existing structure
- Preserve frontmatter (--- block) exactly as-is
- Preserve the overall format and style
- Do not remove existing content unless an improvement explicitly replaces it
- Output the complete updated file inside <updated_file> tags`,
      }),
    ],
    systemPrompt: asSystemPrompt([
      'You edit skill definition files to incorporate user preferences. Output only the updated file content.',
    ]),
    thinkingConfig: { type: 'disabled' as const },
    tools: [],
    signal: createAbortController().signal,
    options: {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      model: getSmallFastModel(),
      toolChoice: undefined,
      isNonInteractiveSession: false,
      hasAppendSystemPrompt: false,
      temperatureOverride: 0,  // 温度设为 0，确保输出稳定
      agents: [],
      querySource: 'skill_improvement_apply',
      mcpTools: [],
    },
  })

  // 提取 LLM 响应文本
  const responseText = extractTextContent(response.message.content).trim()

  // 从响应中提取 <updated_file> 标签内的内容
  const updatedContent = extractTag(responseText, 'updated_file')
  if (!updatedContent) {
    logError(
      new Error('Skill improvement apply: no updated_file tag in response'),
    )
    return
  }

  // 将更新后的内容写回 SKILL.md 文件
  try {
    await fs.writeFile(filePath, updatedContent, 'utf-8')
  } catch (e) {
    logError(toError(e))
  }
}
