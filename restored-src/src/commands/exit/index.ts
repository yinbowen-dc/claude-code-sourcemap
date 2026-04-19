/**
 * exit 命令的注册入口。
 *
 * 在 Claude Code 的命令体系中，/exit（别名 /quit）命令用于退出
 * 交互式 REPL 会话，等价于用户按下 Ctrl+C 或 Ctrl+D。
 *
 * 关键属性：
 *  - immediate: true —— 命令被触发后立即执行退出流程，不会进入
 *    下一个对话轮次，确保用户输入 /exit 后即刻退出，无任何延迟；
 *  - aliases: ['quit'] —— 支持 /quit 作为别名，兼容用户习惯。
 *
 * 实际的退出逻辑（如清理临时文件、保存会话状态等）在 exit.js 中实现。
 */
import type { Command } from '../../commands.js'

const exit = {
  // local-jsx 类型：可渲染退出确认或过渡动画（如有）
  type: 'local-jsx',
  name: 'exit',
  // /quit 是 /exit 的别名，两者等价
  aliases: ['quit'],
  description: 'Exit the REPL',
  // 立即执行模式：触发后无需等待当前对话轮次完成
  immediate: true,
  load: () => import('./exit.js'),
} satisfies Command

export default exit
