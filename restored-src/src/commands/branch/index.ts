/**
 * /branch 命令的入口注册模块。
 *
 * 在 Claude Code 的命令注册流程中，此文件将 /branch 命令（及其 /fork 别名）
 * 注册到命令中心。当 FORK_SUBAGENT 特性标志未启用时，/fork 作为 /branch 的别名
 * 存在，避免两个独立命令同时出现造成混淆。
 * 实际的分叉逻辑通过懒加载由 branch.js 提供。
 */
import { feature } from 'bun:bundle'
import type { Command } from '../../commands.js'

// /branch 命令描述符：懒加载实现，支持条件性 /fork 别名
const branch = {
  // local-jsx 类型：命令可返回 React 节点作为输出（用于显示分叉结果）
  type: 'local-jsx',
  name: 'branch',
  // 仅当 FORK_SUBAGENT 特性未启用时，才将 'fork' 注册为别名
  // 若 FORK_SUBAGENT 已启用，则 /fork 有自己独立的命令实现
  aliases: feature('FORK_SUBAGENT') ? [] : ['fork'],
  description: 'Create a branch of the current conversation at this point',
  // 可选的分叉标题参数
  argumentHint: '[name]',
  // 懒加载分叉逻辑，只在命令被实际调用时才引入依赖
  load: () => import('./branch.js'),
} satisfies Command

export default branch
