/**
 * desktop 命令的注册入口。
 *
 * 在 Claude Code 的命令体系中，/desktop（别名 /app）命令允许用户将当前
 * CLI 会话无缝切换到 Claude Desktop 应用中继续进行。该命令仅在
 * claude.ai 渠道下可用（availability: ['claude-ai']），且受平台限制：
 *  - macOS（darwin）：完整支持
 *  - Windows x64（win32/x64）：支持
 *  - 其他平台（Linux、ARM Windows 等）：不支持，命令被禁用并隐藏
 *
 * 具体的会话迁移逻辑（深链接生成、本地 socket 通信等）在 desktop.js 中实现，
 * 通过懒加载方式引入以降低启动耗时。
 */
import type { Command } from '../../commands.js'

/**
 * 检测当前平台是否支持 Claude Desktop 集成。
 *
 * 目前仅 macOS 和 Windows x64 有对应的 Desktop 客户端，
 * 其他平台返回 false，命令将被禁用并对用户隐藏。
 */
function isSupportedPlatform(): boolean {
  // macOS 平台（intel 和 Apple Silicon 均支持）
  if (process.platform === 'darwin') {
    return true
  }
  // 仅支持 Windows x64，暂不支持 ARM Windows
  if (process.platform === 'win32' && process.arch === 'x64') {
    return true
  }
  return false
}

const desktop = {
  // local-jsx 类型：使用 Ink React 组件渲染迁移过程中的终端 UI
  type: 'local-jsx',
  name: 'desktop',
  // /app 是 /desktop 的别名，方便用户记忆
  aliases: ['app'],
  description: 'Continue the current session in Claude Desktop',
  // 仅在 claude.ai 渠道可用（非 Bedrock/Vertex 等部署）
  availability: ['claude-ai'],
  // 不支持的平台上禁用该命令
  isEnabled: isSupportedPlatform,
  // 不支持的平台上同时隐藏该命令，避免在 /help 中显示灰色条目
  get isHidden() {
    return !isSupportedPlatform()
  },
  load: () => import('./desktop.js'),
} satisfies Command

export default desktop
