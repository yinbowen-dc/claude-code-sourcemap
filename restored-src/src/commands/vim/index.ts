/**
 * vim（/vim）命令注册入口
 *
 * 本文件在 Claude Code 命令系统中负责注册编辑器模式切换命令。
 * 用户执行 /vim 后，可在 Vim 模式（模态编辑，Escape 切换 INSERT/NORMAL）
 * 与 Normal 模式（标准 readline 键绑定）之间来回切换。
 *
 * 命令类型为 local（非 JSX），执行结果为纯文本，
 * 不依赖 React 渲染层，可用于任何终端环境。
 * 实际切换逻辑（读写全局配置、上报分析事件）由 vim.ts 实现。
 *
 * 注意：本命令不支持非交互模式（supportsNonInteractive: false），
 * 因为编辑器模式切换只对交互式会话有意义。
 */
import type { Command } from '../../commands.js'

const command = {
  // 用户可见的命令名称
  name: 'vim',
  description: 'Toggle between Vim and Normal editing modes',
  // 编辑器模式切换仅对交互式终端有意义，不支持管道/脚本等非交互场景
  supportsNonInteractive: false,
  // 纯本地命令，执行时不调用 Claude API
  type: 'local',
  // 懒加载执行模块，仅在命令被触发时才引入 vim.ts
  load: () => import('./vim.js'),
} satisfies Command

export default command
