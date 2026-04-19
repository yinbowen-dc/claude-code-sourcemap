/**
 * review / ultrareview 命令注册入口（commands/review.ts）
 *
 * 本文件在 Claude Code 命令系统中同时注册两个命令：
 *   - /review：纯本地 PR 审查命令，通过调用 `gh` CLI 工具拉取 PR 信息后在本地执行代码评审；
 *   - /ultrareview：远程云端深度 Bug 猎手命令，将代码发送至 claude.ai/code 平台运行
 *     10~20 分钟的 bughunter 分析，结果通过任务通知回传本地会话。
 *
 * 两者的关键区别：
 *   - /review  → type: 'prompt'，直接向模型注入包含 gh CLI 指令的 prompt，全程本地执行；
 *   - /ultrareview → type: 'local-jsx'，先渲染权限/计费对话框，再通过 teleport 机制
 *     在远端 CCR 环境中启动 bughunter，属于"遥控执行"路径。
 *
 * 流程位置：用户层命令 → 此文件注册 → reviewRemote.ts（远端）/ 本地 prompt（本地）。
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.js'
import type { Command } from '../commands.js'
import { isUltrareviewEnabled } from './review/ultrareviewEnabled.js'

// Legal wants the explicit surface name plus a docs link visible before the
// user triggers, so the description carries "Claude Code on the web" + URL.
// 法务要求在用户触发前明确展示服务名称和文档链接，避免用户不知情使用付费功能
const CCR_TERMS_URL = 'https://code.claude.com/docs/en/claude-code-on-the-web'

/**
 * 本地 PR 审查的 prompt 模板工厂函数。
 * 返回一段系统指令，引导模型通过 gh CLI 完成以下步骤：
 *   1. 若无 PR 号则列出开放的 PR 列表；
 *   2. 有 PR 号则获取详情和 diff；
 *   3. 基于 diff 输出涵盖代码质量、风格、性能、测试、安全等维度的结构化评审报告。
 */
const LOCAL_REVIEW_PROMPT = (args: string) => `
      You are an expert code reviewer. Follow these steps:

      1. If no PR number is provided in the args, run \`gh pr list\` to show open PRs
      2. If a PR number is provided, run \`gh pr view <number>\` to get PR details
      3. Run \`gh pr diff <number>\` to get the diff
      4. Analyze the changes and provide a thorough code review that includes:
         - Overview of what the PR does
         - Analysis of code quality and style
         - Specific suggestions for improvements
         - Any potential issues or risks

      Keep your review concise but thorough. Focus on:
      - Code correctness
      - Following project conventions
      - Performance implications
      - Test coverage
      - Security considerations

      Format your review with clear sections and bullet points.

      PR number: ${args}
    `

/**
 * /review 命令：纯本地轻量 PR 审查。
 * 类型为 'prompt'，触发时直接将 LOCAL_REVIEW_PROMPT 作为消息内容注入对话，
 * 由模型调用本地工具（gh CLI）完成审查，无需网络请求到远端云服务。
 * contentLength: 0 表示该命令自身不消耗消息上下文长度计数。
 */
const review: Command = {
  type: 'prompt',
  name: 'review',
  description: 'Review a pull request',
  progressMessage: 'reviewing pull request',
  contentLength: 0,
  source: 'builtin',
  async getPromptForCommand(args): Promise<ContentBlockParam[]> {
    // 将用户传入的 PR 号或空字符串嵌入 prompt，返回标准内容块格式
    return [{ type: 'text', text: LOCAL_REVIEW_PROMPT(args) }]
  },
}

// /ultrareview is the ONLY entry point to the remote bughunter path —
// /review stays purely local. local-jsx type renders the overage permission
// dialog when free reviews are exhausted.
// /ultrareview 是远端 bughunter 的唯一入口；/review 始终保持本地路径，二者严格隔离
/**
 * /ultrareview 命令：远端云端深度 Bug 猎手。
 * - isEnabled: 通过 GrowthBook feature flag 控制可见性，未开启时命令不出现在列表中；
 * - type: 'local-jsx'：在本地渲染计费/权限对话框（免费额度耗尽时的超额确认界面）；
 * - load: 懒加载 ultrareviewCommand.js，该模块负责校验资格、调用 teleport 启动远端任务。
 */
const ultrareview: Command = {
  type: 'local-jsx',
  name: 'ultrareview',
  description: `~10–20 min · Finds and verifies bugs in your branch. Runs in Claude Code on the web. See ${CCR_TERMS_URL}`,
  isEnabled: () => isUltrareviewEnabled(),   // GB feature flag 动态控制命令可见性
  load: () => import('./review/ultrareviewCommand.js'),
}

export default review
export { ultrareview }
