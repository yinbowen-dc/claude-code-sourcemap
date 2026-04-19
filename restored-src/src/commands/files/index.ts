/**
 * files 命令入口模块
 *
 * 在 Claude Code 命令体系中，本文件是 `/files` 命令的注册描述符。
 * 系统启动时，commands 注册表会动态加载该描述符，当用户输入 `/files` 时
 * 按需懒加载 `files.js` 实现模块，从而列出当前会话上下文中涉及的所有文件。
 *
 * 该命令仅对 Anthropic 内部员工（USER_TYPE === 'ant'）开放，属于内部调试工具。
 */
import type { Command } from '../../commands.js'

/**
 * files 命令描述符对象
 *
 * 通过 `satisfies Command` 确保类型安全，各字段含义：
 * - type: 'local' 表示命令在本地执行，无需渲染 JSX 组件
 * - isEnabled: 根据环境变量检查当前用户是否为 Anthropic 内部员工，非 ant 用户不可见
 * - supportsNonInteractive: 允许在非交互式（批处理/脚本）模式下运行
 * - load: 懒加载实际实现，避免启动时全量导入，提升冷启动速度
 */
const files = {
  type: 'local',
  name: 'files',
  description: 'List all files currently in context',
  // 仅 Anthropic 内部用户（ant）可使用此命令
  isEnabled: () => process.env.USER_TYPE === 'ant',
  supportsNonInteractive: true,
  // 实现模块懒加载，只在命令被触发时才导入
  load: () => import('./files.js'),
} satisfies Command

export default files
