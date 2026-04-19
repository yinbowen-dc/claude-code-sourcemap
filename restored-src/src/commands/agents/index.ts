/**
 * /agents 命令的入口模块。
 *
 * 在 Claude Code 的 Agent 管理流程中，此文件作为 /agents 命令的注册描述符，
 * 通过懒加载（load）将实际的 UI 渲染逻辑（agents.js）与启动时的初始化开销分离。
 * /agents 命令允许用户查看、配置和管理当前会话中注册的 Agent 定义。
 */
import type { Command } from '../../commands.js'

// 命令描述对象：以懒加载方式绑定 agents.js 中的 JSX 渲染实现
const agents = {
  // local-jsx 类型允许命令返回 React 组件，用于渲染交互式 Agent 管理界面
  type: 'local-jsx',
  name: 'agents',
  description: 'Manage agent configurations',
  // 实际的 Agent 列表 UI 在首次调用时才加载，减少启动负担
  load: () => import('./agents.js'),
} satisfies Command

export default agents
