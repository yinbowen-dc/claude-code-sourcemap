/**
 * diff 命令的注册入口。
 *
 * 在 Claude Code 的命令体系中，/diff 命令让用户在 REPL 中直接查看两类差异：
 *  1. 未提交的工作区变更（uncommitted changes）——相当于 `git diff`；
 *  2. 每轮对话（turn）中 Claude 所做的文件修改——即逐轮增量差异视图。
 *
 * 本文件仅声明命令元数据，具体的差异计算与 Ink 渲染逻辑在 diff.js 中，
 * 通过懒加载方式引入，避免影响 Claude Code 的冷启动性能。
 */
import type { Command } from '../../commands.js'

export default {
  // local-jsx 类型：使用 Ink React 组件渲染差异视图
  type: 'local-jsx',
  name: 'diff',
  description: 'View uncommitted changes and per-turn diffs',
  // 懒加载实现模块，命令被触发时才加载差异计算和渲染逻辑
  load: () => import('./diff.js'),
} satisfies Command
