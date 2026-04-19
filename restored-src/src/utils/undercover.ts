/**
 * 隐身模式（Undercover Mode）安全工具模块。
 *
 * 在 Claude Code 系统流程中的位置：
 * 此模块是提交/PR 安全层，在 commit 和 PR 创建流程中被调用，
 * 用于检测是否需要隐藏 Anthropic 内部信息，防止向公共仓库泄漏
 * 内部模型代号、项目名称等敏感信息。
 *
 * 主要功能：
 * - isUndercover：判断当前是否处于隐身模式
 * - getUndercoverInstructions：返回提示模型保持隐身的指令文本
 * - shouldShowUndercoverAutoNotice：判断是否显示一次性自动隐身说明弹窗
 *
 * 激活方式：
 * - CLAUDE_CODE_UNDERCOVER=1：强制开启（即使在内部仓库）
 * - 自动检测（AUTO）：除非仓库远端匹配内部白名单，否则默认开启
 * - 无强制关闭选项：若不确定是否在内部仓库，始终保持隐身状态
 *
 * 构建时优化：
 * - 所有代码路径均通过 process.env.USER_TYPE === 'ant' 进行门控
 * - USER_TYPE 是构建时 --define 常量，打包工具会将其常量折叠
 * - 对于外部构建，此文件中的所有函数都会被死代码消除，返回平凡值
 */

import { getRepoClassCached } from './commitAttribution.js'
import { getGlobalConfig } from './config.js'
import { isEnvTruthy } from './envUtils.js'

/**
 * 判断当前是否处于隐身模式。
 *
 * 流程（仅对 ant 用户执行，外部用户直接返回 false）：
 * 1. 检查 CLAUDE_CODE_UNDERCOVER 环境变量，若为真值则强制开启
 * 2. 自动检测：仓库类型非 'internal' 时开启
 *    （'external'、'none' 和 null 均解析为开启）
 * 3. 外部构建：打包器将此函数常量折叠为 return false
 *
 * @returns ant 用户且满足激活条件时返回 true，否则返回 false
 */
export function isUndercover(): boolean {
  if (process.env.USER_TYPE === 'ant') {
    // 环境变量强制开启
    if (isEnvTruthy(process.env.CLAUDE_CODE_UNDERCOVER)) return true
    // 自动检测：仅当确认为内部仓库时关闭，其他情况保持隐身
    // getRepoClassCached() 在 setup.ts 中预热；null 表示检查尚未运行
    return getRepoClassCached() !== 'internal'
  }
  // 外部用户：隐身模式无意义，直接返回 false
  return false
}

/**
 * 获取隐身模式下提示模型保持隐身的指令文本。
 *
 * 流程：
 * 1. 仅对 ant 用户返回指令（外部用户返回空字符串）
 * 2. 指令明确禁止在提交信息和 PR 描述中包含任何 Anthropic 内部信息
 *
 * @returns 隐身指令文本（ant 用户）或空字符串（外部用户）
 */
export function getUndercoverInstructions(): string {
  if (process.env.USER_TYPE === 'ant') {
    return `## UNDERCOVER MODE — CRITICAL

You are operating UNDERCOVER in a PUBLIC/OPEN-SOURCE repository. Your commit
messages, PR titles, and PR bodies MUST NOT contain ANY Anthropic-internal
information. Do not blow your cover.

NEVER include in commit messages or PR descriptions:
- Internal model codenames (animal names like Capybara, Tengu, etc.)
- Unreleased model version numbers (e.g., opus-4-7, sonnet-4-8)
- Internal repo or project names (e.g., claude-cli-internal, anthropics/…)
- Internal tooling, Slack channels, or short links (e.g., go/cc, #claude-code-…)
- The phrase "Claude Code" or any mention that you are an AI
- Any hint of what model or version you are
- Co-Authored-By lines or any other attribution

Write commit messages as a human developer would — describe only what the code
change does.

GOOD:
- "Fix race condition in file watcher initialization"
- "Add support for custom key bindings"
- "Refactor parser for better error messages"

BAD (never write these):
- "Fix bug found while testing with Claude Capybara"
- "1-shotted by claude-opus-4-6"
- "Generated with Claude Code"
- "Co-Authored-By: Claude Opus 4.6 <…>"
`
  }
  // 外部构建：返回空字符串（打包器会对此进行死代码消除）
  return ''
}

/**
 * 判断是否应显示一次性的自动隐身说明弹窗。
 *
 * 条件（全部满足时返回 true）：
 * - ant 用户
 * - 隐身模式由自动检测触发（非环境变量强制开启）
 * - 当前确实处于隐身状态
 * - 用户尚未看过该说明（hasSeenUndercoverAutoNotice 为 false）
 *
 * 注意：此函数为纯函数，UI 组件在挂载时负责设置已读标志。
 *
 * @returns 需要显示说明弹窗时返回 true
 */
export function shouldShowUndercoverAutoNotice(): boolean {
  if (process.env.USER_TYPE === 'ant') {
    // 若通过环境变量强制开启，用户已知晓，不需要提示
    if (isEnvTruthy(process.env.CLAUDE_CODE_UNDERCOVER)) return false
    // 若当前不在隐身模式，无需提示
    if (!isUndercover()) return false
    // 若用户已看过说明，不再重复显示
    if (getGlobalConfig().hasSeenUndercoverAutoNotice) return false
    return true
  }
  // 外部用户：始终返回 false
  return false
}
