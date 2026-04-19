/**
 * plan 命令入口 —— Claude Code 命令注册层
 *
 * 在整体流程中的位置：
 *   用户输入 `/plan [open|<description>]` → commands 注册表路由到本模块
 *   → 懒加载 plan.js → 渲染计划模式 / 当前会话计划的 JSX 界面
 *
 * 主要功能：
 *   注册 plan 命令，支持两种使用场景：
 *   1. `/plan open` —— 进入计划模式（Plan Mode），Claude 在执行操作前
 *      会先生成一份可审阅的行动计划，等待用户确认再继续。
 *   2. `/plan <description>` —— 直接为当前会话设置或更新计划描述。
 */
import type { Command } from '../../commands.js'

// 命令描述符：argumentHint 提示可选参数格式，用于终端自动补全提示
const plan = {
  type: 'local-jsx',                          // 本地进程内渲染 React 组件
  name: 'plan',                               // 斜杠命令名称
  description: 'Enable plan mode or view the current session plan',
  argumentHint: '[open|<description>]',       // 终端提示：可传 open 或自定义描述文本
  load: () => import('./plan.js'),            // 懒加载计划模式 UI 实现
} satisfies Command

export default plan
