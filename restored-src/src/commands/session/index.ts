/**
 * session 命令注册入口（commands/session/index.ts）
 *
 * 本文件将 /session（及别名 /remote）命令注册到 Claude Code 全局命令系统。
 * 该命令专为"远程模式"（Remote Mode）设计：当 Claude Code 通过浏览器或远程终端
 * 连接时，此命令显示当前远程会话的访问 URL 和二维码，方便用户扫码连接或分享链接。
 *
 * 在系统流程中的位置：
 *   远程模式下用户输入 /session → 命令注册表匹配 → load() 懒加载 session.js
 *   → 渲染 URL + QR 码组件 → 用户扫码或复制链接连接到当前会话。
 *
 * 可见性控制：isEnabled 和 isHidden 均依赖 getIsRemoteMode() 动态判断，
 * 非远程模式下命令完全隐藏，不出现在命令列表中。
 */

import { getIsRemoteMode } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

/**
 * session 命令描述对象。
 * - aliases: ['remote'] 提供 /remote 作为语义更直观的别名。
 * - isEnabled: 非远程模式时禁用命令，防止本地模式下误触发。
 * - isHidden: 非远程模式时隐藏命令，保持命令列表整洁。
 * - 两者均为运行时动态求值，确保模式切换后立即生效。
 */
const session = {
  type: 'local-jsx',
  name: 'session',
  aliases: ['remote'],              // /remote 别名，强调远程会话语义
  description: 'Show remote session URL and QR code',
  isEnabled: () => getIsRemoteMode(),  // 仅远程模式下启用
  get isHidden() {
    return !getIsRemoteMode()          // 非远程模式时从命令列表中隐藏
  },
  load: () => import('./session.js'),
} satisfies Command

export default session
