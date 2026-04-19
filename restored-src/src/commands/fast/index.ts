/**
 * fast 命令入口模块
 *
 * 本文件是 /fast 斜杠命令的元数据声明层。
 * "Fast Mode"（快速模式）是 Claude Code 针对特定模型提供的速度优先选项，
 * 启用后会切换到更快（但能力可能略有差异）的模型变体。
 *
 * 关键设计：
 * - `description` 使用 getter 动态引入 FAST_MODE_MODEL_DISPLAY，
 *   确保描述文本始终反映当前配置中的目标模型名称。
 * - `isEnabled` 和 `isHidden` 均依赖 `isFastModeEnabled()`：
 *   只有在支持快速模式的渠道/账号中，命令才会出现。
 * - `immediate` 为 getter 而非静态值，允许运行时根据会话状态
 *   决定命令是否立即执行（避免打断正在进行的对话）。
 * - 仅对 claude-ai 和 console 渠道可用，Bedrock/Vertex 等不支持。
 *
 * 流程位置：用户输入 /fast [on|off] → immediate 决定执行时机
 *           → 懒加载 fast.js → 切换会话模型配置
 */
import type { Command } from '../../commands.js'
import {
  FAST_MODE_MODEL_DISPLAY,
  isFastModeEnabled,
} from '../../utils/fastMode.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

// fast 命令元数据声明
const fast = {
  // local-jsx 类型：需要 React 组件展示当前模式状态和切换反馈
  type: 'local-jsx',
  name: 'fast',
  // 动态描述：将当前快速模式的目标模型名称嵌入描述，让用户知道切换到哪个模型
  get description() {
    return `Toggle fast mode (${FAST_MODE_MODEL_DISPLAY} only)`
  },
  // 仅对支持快速模式的接入渠道可用
  availability: ['claude-ai', 'console'],
  // 功能开关：运行时检查是否满足快速模式的启用条件
  isEnabled: () => isFastModeEnabled(),
  // 不支持快速模式时隐藏命令，避免显示用户无法使用的选项
  get isHidden() {
    return !isFastModeEnabled()
  },
  argumentHint: '[on|off]',
  // 动态 immediate 属性：根据当前会话状态决定是否立即切换模型
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./fast.js'),
} satisfies Command

export default fast
