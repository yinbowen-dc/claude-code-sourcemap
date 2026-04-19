/**
 * Computer Use 公共常量与工具函数模块。
 *
 * 在 Claude Code 系统中，该模块提供 Computer Use 功能所需的共享标识符与能力检测：
 * - COMPUTER_USE_MCP_SERVER_NAME：MCP 服务名称常量（'computer-use'）
 * - CLI_HOST_BUNDLE_ID：CLI 宿主进程的哨兵 Bundle ID
 * - getTerminalBundleId()：检测当前终端模拟器的 Bundle ID（iTerm2、Terminal.app 等）
 * - CLI_CU_CAPABILITIES：CLI 宿主支持的 Computer Use 能力集
 * - isComputerUseMCPServer()：判断给定 MCP 服务名是否为 Computer Use 服务
 */
import { normalizeNameForMCP } from '../../services/mcp/normalization.js'
import { env } from '../env.js'

export const COMPUTER_USE_MCP_SERVER_NAME = 'computer-use'

/**
 * 前台门控的哨兵 Bundle ID。Claude Code 是一个终端应用 —— 它没有窗口。
 * 这个 ID 永远不会匹配真实的 `NSWorkspace.frontmostApplication`，
 * 因此该包的"宿主处于前台"分支（鼠标点击穿透豁免、键盘安全网）
 * 对我们来说是死代码。`prepareForAction` 的"豁免我们自己的窗口"
 * 同样是 no-op —— 根本没有窗口需要豁免。
 */
export const CLI_HOST_BUNDLE_ID = 'com.anthropic.claude-code.cli-no-window'

/**
 * 当 `__CFBundleIdentifier` 未设置时，`env.terminal` → bundleId 的兜底映射表。
 * 涵盖可识别的 macOS 终端 —— Linux 终端（konsole、gnome-terminal、xterm）
 * 故意不包含其中，因为 `createCliExecutor` 受 darwin 条件限制。
 */
const TERMINAL_BUNDLE_ID_FALLBACK: Readonly<Record<string, string>> = {
  'iTerm.app': 'com.googlecode.iterm2',
  Apple_Terminal: 'com.apple.Terminal',
  ghostty: 'com.mitchellh.ghostty',
  kitty: 'net.kovidgoyal.kitty',
  WarpTerminal: 'dev.warp.Warp-Stable',
  vscode: 'com.microsoft.VSCode',
}

/**
 * 当前所在终端模拟器的 Bundle ID，供 `prepareDisplay` 将其排除在隐藏范围之外，
 * `captureExcluding` 将其从截图中剔除。
 * 无法检测时（SSH 连接、环境变量已清除、未知终端）返回 null —— 调用方须处理 null 情况。
 *
 * `__CFBundleIdentifier` 由 LaunchServices 在 .app Bundle 启动进程时设置，
 * 并被子进程继承。它是精确的 Bundle ID，无需查表 —— 可处理兜底表中未知的终端。
 * 在 tmux/screen 下，该值反映的是启动服务器的终端，可能与当前连接的客户端不同。
 * 这里无影响：我们豁免的是某个终端窗口，截图无论如何都会将其排除。
 */
export function getTerminalBundleId(): string | null {
  const cfBundleId = process.env.__CFBundleIdentifier
  if (cfBundleId) return cfBundleId
  return TERMINAL_BUNDLE_ID_FALLBACK[env.terminal ?? ''] ?? null
}

/**
 * macOS CLI 的静态能力集。`hostBundleId` 不在此处 —— 它由 `executor.ts`
 * 按 `ComputerExecutor.capabilities` 添加。`buildComputerUseTools`
 * 接受此结构（不含 `hostBundleId`，不含 `teachMode`）。
 */
export const CLI_CU_CAPABILITIES = {
  screenshotFiltering: 'native' as const,
  platform: 'darwin' as const,
}

export function isComputerUseMCPServer(name: string): boolean {
  return normalizeNameForMCP(name) === COMPUTER_USE_MCP_SERVER_NAME
}
