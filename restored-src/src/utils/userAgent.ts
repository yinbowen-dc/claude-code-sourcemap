/**
 * User-Agent 字符串生成工具模块。
 *
 * 在 Claude Code 系统流程中的位置：
 * 此模块是 HTTP 客户端标识层的基础工具，被所有向 Anthropic API
 * 和其他外部服务发起 HTTP 请求的代码路径调用，用于设置
 * User-Agent 请求头以标识客户端身份和版本。
 *
 * 主要功能：
 * - 返回格式为 "claude-code/<VERSION>" 的 User-Agent 字符串
 * - 保持零依赖，SDK 打包代码（bridge、cli/transports）可直接导入
 *   而无需引入 auth.ts 及其传递依赖树
 *
 * 版本注入：
 * - MACRO.VERSION 在构建时由构建器（如 esbuild define）替换为实际版本号
 */

/**
 * 获取 Claude Code 的 User-Agent 字符串。
 *
 * 流程：
 * 1. 直接返回格式化的 User-Agent 字符串
 * 2. MACRO.VERSION 为构建时注入的版本号宏
 *
 * @returns 格式为 "claude-code/<VERSION>" 的字符串
 */
export function getClaudeCodeUserAgent(): string {
  // MACRO.VERSION 在构建阶段被替换为实际版本号（如 "1.2.3"）
  return `claude-code/${MACRO.VERSION}`
}
