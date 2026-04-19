/**
 * effort 命令的注册入口。
 *
 * 在 Claude Code 的命令体系中，/effort 命令允许用户动态调整模型的
 * "思考努力程度"（effort level），对应 Anthropic API 中扩展思考
 * （extended thinking）的预算令牌数量控制：
 *  - low    → 最少思考步骤，响应最快
 *  - medium → 均衡模式
 *  - high   → 深度思考，响应较慢
 *  - max    → 最大思考预算
 *  - auto   → 由模型自动决定
 *
 * 本文件仅声明命令元数据，具体的 effort 调整 UI 和逻辑在 effort.js 中，
 * 通过懒加载方式引入。
 *
 * immediate 属性由 shouldInferenceConfigCommandBeImmediate() 动态决定：
 * 若当前配置允许"立即生效"（不需要下一轮对话），则设为 true。
 */
import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'

export default {
  // local-jsx 类型：使用 Ink React 组件渲染 effort 选择 UI
  type: 'local-jsx',
  name: 'effort',
  description: 'Set effort level for model usage',
  // 参数提示，告知用户可选的合法值
  argumentHint: '[low|medium|high|max|auto]',
  // 动态计算是否应立即生效，避免用户输入命令后还需等待下一轮
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./effort.js'),
} satisfies Command
