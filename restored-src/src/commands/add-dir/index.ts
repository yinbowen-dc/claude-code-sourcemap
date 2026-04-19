/**
 * add-dir 命令的入口模块。
 *
 * 在 Claude Code 命令系统中，此文件作为 /add-dir 命令的注册描述符，
 * 通过 `load` 字段实现懒加载，仅在用户实际执行命令时才载入具体实现（add-dir.js）。
 * 该命令允许用户在运行时动态添加新的工作目录，扩展 Claude 可访问的文件系统范围。
 */
import type { Command } from '../../commands.js'

// 命令描述对象：满足 Command 类型约束，由命令注册中心统一管理
const addDir = {
  // 类型为本地 JSX 命令，支持渲染 React 组件作为输出
  type: 'local-jsx',
  name: 'add-dir',
  description: 'Add a new working directory',
  // 提示用户需要提供路径参数
  argumentHint: '<path>',
  // 懒加载实现文件，避免启动时加载不必要的依赖
  load: () => import('./add-dir.js'),
} satisfies Command

export default addDir
