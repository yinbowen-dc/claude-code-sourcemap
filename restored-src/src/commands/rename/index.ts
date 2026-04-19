/**
 * rename 命令的入口描述文件。
 *
 * 在 Claude Code 命令体系中，本文件作为 /rename 命令的静态元数据声明，
 * 由 commands 注册系统统一加载，通过懒加载（load）将实际执行逻辑延迟到
 * rename.ts 中，避免启动时不必要的模块初始化开销。
 *
 * 用户在终端输入 /rename [name] 时，该命令描述符会被匹配并触发，
 * immediate: true 表示用户输入后不等待 AI 回复即立即执行。
 */
import type { Command } from '../../commands.js'

// 定义 rename 命令的元数据，满足 Command 接口约束
const rename = {
  type: 'local-jsx',       // 本地 JSX 命令类型，支持渲染 React 组件作为输出
  name: 'rename',          // 命令名称，对应用户输入的 /rename 指令
  description: 'Rename the current conversation',
  immediate: true,         // 立即执行模式：无需等待模型响应，输入后直接运行
  argumentHint: '[name]',  // 命令行提示：参数为可选的新会话名称
  load: () => import('./rename.js'), // 懒加载真正的执行逻辑，减少启动耗时
} satisfies Command

export default rename
