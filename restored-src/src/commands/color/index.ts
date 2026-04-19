/**
 * /color 命令的入口注册模块。
 *
 * 在 Claude Code 的 Agent 身份管理流程中，此文件将 /color 命令注册到命令中心。
 * /color 命令允许用户为当前会话的提示栏设置显示颜色，
 * 在多 Agent 并行运行的 Swarm 场景中用于区分不同 Agent 的视觉标识。
 *
 * immediate=true：颜色设置立即生效，无需等待当前 AI 轮次完成。
 * 实际实现通过懒加载从 color.js 按需引入。
 */
import type { Command } from '../../commands.js'

// /color 命令描述符：元数据最小化，实现懒加载
const color = {
  // local-jsx 类型：命令可在输出中渲染 React 组件（如颜色预览）
  type: 'local-jsx',
  name: 'color',
  description: 'Set the prompt bar color for this session',
  // 立即执行：颜色切换无需等待 AI 响应
  immediate: true,
  // 提示用户可输入颜色名或 'default' 关键字
  argumentHint: '<color|default>',
  // 懒加载颜色设置逻辑，减少启动开销
  load: () => import('./color.js'),
} satisfies Command

export default color
