/**
 * rewind 命令的入口描述文件。
 *
 * 在 Claude Code 历史回溯体系中，本文件声明了 /rewind（及别名 /checkpoint）命令，
 * 为用户提供将代码和/或对话恢复到历史某个检查点的能力。
 * 与 /resume 恢复整个历史会话不同，rewind 聚焦于在当前对话内回退到特定消息节点，
 * 属于 local 类型命令（非 JSX），直接返回文本结果；
 * supportsNonInteractive: false 限制其只能在交互模式下使用。
 */
import type { Command } from '../../commands.js'

// 定义 rewind 命令描述符，满足 Command 接口约束
const rewind = {
  description: `Restore the code and/or conversation to a previous point`,
  name: 'rewind',                    // 主命令名，对应 /rewind 指令
  aliases: ['checkpoint'],           // 别名 /checkpoint，语义更贴近"检查点"概念
  argumentHint: '',                  // 无需参数，交互界面会引导用户选择目标节点
  type: 'local',                     // 本地命令类型，直接返回命令结果而非渲染 JSX
  supportsNonInteractive: false,     // 必须在交互模式下运行，禁止无头/脚本调用
  load: () => import('./rewind.js'), // 懒加载 rewind 的实际执行逻辑
} satisfies Command

export default rewind
