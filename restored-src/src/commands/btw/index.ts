/**
 * /btw 命令的入口注册模块。
 *
 * 在 Claude Code 的对话管理流程中，/btw（"by the way"）命令允许用户在
 * 不打断主对话线的情况下向 Claude 提出一个快速的旁路问题。与普通消息不同，
 * /btw 触发的是一次独立的轻量级查询，结果不会插入到主对话历史中，
 * 适合快速确认事实、查询定义等不需要上下文延续的场景。
 *
 * immediate=true 表示命令输入后立即执行，无需等待当前 AI 轮次结束。
 */
import type { Command } from '../../commands.js'

// /btw 命令描述符：以懒加载方式绑定旁路查询的实现逻辑
const btw = {
  // local-jsx 类型：允许渲染 React 组件展示旁路查询的结果
  type: 'local-jsx',
  name: 'btw',
  description:
    'Ask a quick side question without interrupting the main conversation',
  // 立即执行：无需等待当前对话轮次完成
  immediate: true,
  // 提示用户需要提供问题文本
  argumentHint: '<question>',
  // 懒加载实现，减少启动时的依赖加载开销
  load: () => import('./btw.js'),
} satisfies Command

export default btw
