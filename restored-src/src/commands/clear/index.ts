/**
 * /clear 命令的注册描述符模块。
 *
 * 在 Claude Code 的命令分层架构中，此文件是 /clear 命令的轻量入口：
 * - 仅包含命令元数据（名称、描述、别名、启用条件）
 * - 通过懒加载将实际的清除逻辑推迟到命令被真正调用时再导入
 *
 * 相关工具函数的导入路径：
 * - clearSessionCaches: 仅清除缓存 → import from './clear/caches.js'
 * - clearConversation: 完整会话重置 → import from './clear/conversation.js'
 */
import type { Command } from '../../commands.js'

/**
 * /clear 命令描述符。
 *
 * 支持 /reset 和 /new 作为别名，方便用户选择最直觉的词汇。
 * supportsNonInteractive: false 表示此命令不应在脚本/管道模式下使用，
 * 非交互场景下应直接创建新会话（--session 标志），而非在现有会话中执行 /clear。
 */
const clear = {
  // 'local' 类型：命令在本地执行，不发送给模型
  type: 'local',
  name: 'clear',
  description: 'Clear conversation history and free up context',
  // /reset 和 /new 作为语义等价的别名
  aliases: ['reset', 'new'],
  supportsNonInteractive: false, // 非交互模式下应直接新建会话，而非清除
  // 懒加载实际执行逻辑，减少启动时依赖加载开销
  load: () => import('./clear.js'),
} satisfies Command

export default clear
