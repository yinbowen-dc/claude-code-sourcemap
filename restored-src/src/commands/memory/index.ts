/**
 * commands/memory/index.ts
 *
 * 【在系统流程中的位置】
 * 命令注册层 — Claude Code 斜杠命令系统的入口描述符之一。
 * 在启动阶段由命令加载器（commands.ts）扫描并收集，之后被挂载到
 * 主交互循环（REPL）中，供用户以 /memory 触发。
 *
 * 【主要功能】
 * 声明 `memory` 命令的元数据对象，通过懒加载（dynamic import）
 * 延迟引入实际的 JSX 实现，以减少冷启动时的模块解析开销。
 * 该命令的 UI 实现位于同目录下的 memory.js，
 * 允许用户查看并编辑 Claude 的记忆文件（CLAUDE.md 等）。
 */

import type { Command } from '../../commands.js'

// 命令描述符：声明 /memory 命令的类型、名称、描述及懒加载入口
const memory: Command = {
  // 'local-jsx'：在本地进程中渲染 React/Ink 组件，而非返回纯文本
  type: 'local-jsx',
  name: 'memory',
  description: 'Edit Claude memory files',
  // 懒加载：仅在用户实际触发命令时才动态导入 memory.js 的组件模块
  load: () => import('./memory.js'),
}

export default memory
