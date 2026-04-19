/**
 * Auto mode 子命令处理器 — 打印/合并分类器规则并对用户自定义规则进行 AI 评审。
 *
 * 在整个 Claude Code 系统中的位置：
 * 本文件在用户执行 `claude auto-mode ...` 时被动态导入，是 CLI 层与
 * yoloClassifier（自动模式 AI 分类器）之间的适配层。它提供三个子命令：
 *   - `claude auto-mode defaults`  — 打印内置默认分类器规则（JSON 格式）
 *   - `claude auto-mode config`    — 打印用户配置与默认规则合并后的有效规则
 *   - `claude auto-mode critique`  — 调用 LLM 对用户自定义规则进行批判性分析
 *
 * 分类器规则分三个部分：allow（自动放行）、soft_deny（需用户确认）、environment（上下文描述）。
 */

import { errorMessage } from '../../utils/errors.js'
import {
  getMainLoopModel,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import {
  type AutoModeRules,
  buildDefaultExternalSystemPrompt,
  getDefaultExternalAutoModeRules,
} from '../../utils/permissions/yoloClassifier.js'
import { getAutoModeConfig } from '../../utils/settings/settings.js'
import { sideQuery } from '../../utils/sideQuery.js'
import { jsonStringify } from '../../utils/slowOperations.js'

/**
 * 将 AutoModeRules 对象以格式化 JSON 输出到 stdout。
 * 用于 defaults 和 config 子命令的统一输出入口。
 */
function writeRules(rules: AutoModeRules): void {
  // 使用 2 空格缩进的 JSON 格式，便于用户阅读和复制粘贴
  process.stdout.write(jsonStringify(rules, null, 2) + '\n')
}

/**
 * `claude auto-mode defaults` 子命令处理函数。
 *
 * 流程：直接获取内置默认分类器规则（不考虑用户配置）并输出 JSON。
 * 可作为用户自定义规则的参考基准。
 */
export function autoModeDefaultsHandler(): void {
  writeRules(getDefaultExternalAutoModeRules())
}

/**
 * `claude auto-mode config` 子命令处理函数。
 *
 * 流程：
 * 1. 读取用户在 settings 中配置的 autoMode 规则。
 * 2. 读取内置默认规则。
 * 3. 对每个部分（allow / soft_deny / environment）分别应用覆盖语义：
 *    用户非空则完全替换对应部分的默认规则，为空则回退到默认规则。
 * 4. 打印合并后的有效规则 JSON。
 *
 * 注意：每个部分是整体替换（REPLACE），不是逐条追加，
 * 与 buildYoloSystemPrompt 解析外部模板的行为保持一致。
 */
export function autoModeConfigHandler(): void {
  // 读取用户在 settings 中配置的 autoMode 规则（可能为 undefined）
  const config = getAutoModeConfig()
  // 读取内置默认规则作为各部分的回退值
  const defaults = getDefaultExternalAutoModeRules()
  writeRules({
    // 用户 allow 非空则使用用户规则，否则使用默认规则
    allow: config?.allow?.length ? config.allow : defaults.allow,
    // 用户 soft_deny 非空则使用用户规则，否则使用默认规则
    soft_deny: config?.soft_deny?.length
      ? config.soft_deny
      : defaults.soft_deny,
    // 用户 environment 非空则使用用户规则，否则使用默认规则
    environment: config?.environment?.length
      ? config.environment
      : defaults.environment,
  })
}

// 评审 LLM 的系统提示词：指导模型从清晰度、完整性、冲突和可操作性四个维度
// 对用户自定义的 auto mode 分类器规则进行批判性评审
const CRITIQUE_SYSTEM_PROMPT =
  'You are an expert reviewer of auto mode classifier rules for Claude Code.\n' +
  '\n' +
  'Claude Code has an "auto mode" that uses an AI classifier to decide whether ' +
  'tool calls should be auto-approved or require user confirmation. Users can ' +
  'write custom rules in three categories:\n' +
  '\n' +
  '- **allow**: Actions the classifier should auto-approve\n' +
  '- **soft_deny**: Actions the classifier should block (require user confirmation)\n' +
  "- **environment**: Context about the user's setup that helps the classifier make decisions\n" +
  '\n' +
  "Your job is to critique the user's custom rules for clarity, completeness, " +
  'and potential issues. The classifier is an LLM that reads these rules as ' +
  'part of its system prompt.\n' +
  '\n' +
  'For each rule, evaluate:\n' +
  '1. **Clarity**: Is the rule unambiguous? Could the classifier misinterpret it?\n' +
  "2. **Completeness**: Are there gaps or edge cases the rule doesn't cover?\n" +
  '3. **Conflicts**: Do any of the rules conflict with each other?\n' +
  '4. **Actionability**: Is the rule specific enough for the classifier to act on?\n' +
  '\n' +
  'Be concise and constructive. Only comment on rules that could be improved. ' +
  'If all rules look good, say so.'

/**
 * `claude auto-mode critique` 子命令处理函数。
 *
 * 流程：
 * 1. 检查用户是否有任何自定义规则；若无，打印引导提示后直接返回。
 * 2. 解析目标模型（--model 参数或主循环默认模型）。
 * 3. 构建分类器完整系统提示词和各部分的规则对比摘要。
 * 4. 调用 sideQuery 向 LLM 发起评审请求（max_tokens=4096）。
 * 5. 提取 text 类型的响应块并输出；无响应时打印提示。
 * 6. 调用失败时将错误写入 stderr，并设置退出码 1（不直接 exit 以允许清理）。
 */
export async function autoModeCritiqueHandler(options: {
  model?: string
}): Promise<void> {
  const config = getAutoModeConfig()
  // 检查三个部分中是否有任意一个包含用户自定义规则
  const hasCustomRules =
    (config?.allow?.length ?? 0) > 0 ||
    (config?.soft_deny?.length ?? 0) > 0 ||
    (config?.environment?.length ?? 0) > 0

  if (!hasCustomRules) {
    // 无自定义规则时给出操作引导，不发起 LLM 请求
    process.stdout.write(
      'No custom auto mode rules found.\n\n' +
        'Add rules to your settings file under autoMode.{allow, soft_deny, environment}.\n' +
        'Run `claude auto-mode defaults` to see the default rules for reference.\n',
    )
    return
  }

  // 若用户通过 --model 指定了模型，则解析之；否则使用主循环配置的默认模型
  const model = options.model
    ? parseUserSpecifiedModel(options.model)
    : getMainLoopModel()

  const defaults = getDefaultExternalAutoModeRules()
  // 获取分类器完整系统提示词（用于给 LLM 提供上下文）
  const classifierPrompt = buildDefaultExternalSystemPrompt()

  // 为三个规则部分分别生成对比摘要（用户规则 vs 被替换的默认规则）
  const userRulesSummary =
    formatRulesForCritique('allow', config?.allow ?? [], defaults.allow) +
    formatRulesForCritique(
      'soft_deny',
      config?.soft_deny ?? [],
      defaults.soft_deny,
    ) +
    formatRulesForCritique(
      'environment',
      config?.environment ?? [],
      defaults.environment,
    )

  process.stdout.write('Analyzing your auto mode rules…\n\n')

  let response
  try {
    // 发起侧边查询（side query），使用 CRITIQUE_SYSTEM_PROMPT 和用户规则摘要
    response = await sideQuery({
      querySource: 'auto_mode_critique',
      model,
      system: CRITIQUE_SYSTEM_PROMPT,
      skipSystemPromptPrefix: true,  // 不添加 Claude Code 默认系统提示前缀
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content:
            'Here is the full classifier system prompt that the auto mode classifier receives:\n\n' +
            '<classifier_system_prompt>\n' +
            classifierPrompt +
            '\n</classifier_system_prompt>\n\n' +
            "Here are the user's custom rules that REPLACE the corresponding default sections:\n\n" +
            userRulesSummary +
            '\nPlease critique these custom rules.',
        },
      ],
    })
  } catch (error) {
    // LLM 调用失败：写入 stderr 并设置退出码，不直接 exit 以允许资源清理
    process.stderr.write(
      'Failed to analyze rules: ' + errorMessage(error) + '\n',
    )
    process.exitCode = 1
    return
  }

  // 从响应内容中提取第一个 text 块并输出
  const textBlock = response.content.find(block => block.type === 'text')
  if (textBlock?.type === 'text') {
    process.stdout.write(textBlock.text + '\n')
  } else {
    // LLM 未返回文本内容时给出提示
    process.stdout.write('No critique was generated. Please try again.\n')
  }
}

/**
 * 为 critique 请求格式化单个规则部分的对比摘要。
 *
 * 流程：若用户规则为空则返回空字符串；否则构建 Markdown 格式的对比文本，
 * 包含自定义规则列表和被替换的默认规则列表，用于 LLM 的上下文理解。
 */
function formatRulesForCritique(
  section: string,
  userRules: string[],
  defaultRules: string[],
): string {
  // 该部分无自定义规则时不输出任何内容（避免 LLM 分析空规则）
  if (userRules.length === 0) return ''
  // 将规则数组格式化为 Markdown 无序列表
  const customLines = userRules.map(r => '- ' + r).join('\n')
  const defaultLines = defaultRules.map(r => '- ' + r).join('\n')
  return (
    '## ' +
    section +
    ' (custom rules replacing defaults)\n' +
    'Custom:\n' +
    customLines +
    '\n\n' +
    'Defaults being replaced:\n' +
    defaultLines +
    '\n\n'
  )
}
