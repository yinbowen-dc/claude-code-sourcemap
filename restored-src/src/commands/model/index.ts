/**
 * model 命令入口 —— Claude Code 命令注册层
 *
 * 在整体流程中的位置：
 *   用户输入 `/model [model]` → commands 注册表路由到本模块 → 判断是否立即执行
 *   → 懒加载 model.js → 渲染模型选择/切换的 JSX 界面
 *
 * 主要职责：
 *   动态暴露当前使用的模型名称（写入 description 的 getter），并根据运行环境
 *   决定是否将本命令标记为"immediate"（即无需额外确认、直接生效）。
 */
import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'
import { getMainLoopModel, renderModelName } from '../../utils/model/model.js'

export default {
  type: 'local-jsx', // 本地进程内渲染 React 组件
  name: 'model',     // 斜杠命令名称
  /**
   * description getter：每次访问时实时读取当前主循环所用的模型名称，
   * 确保帮助列表中展示的信息始终与实际配置一致。
   */
  get description() {
    // renderModelName 将内部模型 ID 转换为对用户友好的展示名称
    return `Set the AI model for Claude Code (currently ${renderModelName(getMainLoopModel())})`
  },
  argumentHint: '[model]', // CLI 提示：可选传入目标模型名
  /**
   * immediate getter：若当前上下文（如推理配置模式）支持立即生效，
   * 返回 true，使命令跳过交互确认步骤。
   */
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./model.js'), // 懒加载实际 UI 和切换逻辑
} satisfies Command
