/**
 * feedback 命令入口模块
 *
 * 本文件是 /feedback（别名 /bug）斜杠命令的元数据声明层。
 * /feedback 命令允许用户直接在 Claude Code 会话中向 Anthropic 提交产品反馈或 Bug 报告，
 * 是产品团队收集用户反馈的重要渠道。
 *
 * 命令在以下任一条件满足时被禁用，涵盖了多种不应收集反馈的场景：
 * - Bedrock / Vertex / Foundry 企业接入：通过第三方云厂商接入，反馈渠道不适用
 * - DISABLE_FEEDBACK_COMMAND / DISABLE_BUG_COMMAND：运维层面的强制禁用
 * - isEssentialTrafficOnly()：隐私限制模式，禁止非必要的外部数据传输
 * - USER_TYPE === 'ant'：内部员工有专用反馈渠道，不走此命令
 * - !isPolicyAllowed('allow_product_feedback')：企业策略明确禁止产品反馈
 *
 * 流程位置：用户输入 /feedback 或 /bug → isEnabled 多条件检查
 *           → 通过后懒加载 feedback.js → 渲染反馈表单 UI
 */
import type { Command } from '../../commands.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'

// feedback 命令元数据声明
const feedback = {
  // /bug 是一个直觉友好的别名，方便用户遭遇问题时快速上报
  aliases: ['bug'],
  // local-jsx 类型：反馈表单需要多步骤的交互式 React 组件
  type: 'local-jsx',
  name: 'feedback',
  description: `Submit feedback about Claude Code`,
  argumentHint: '[report]',
  // 多条件 isEnabled：只要任一禁用条件成立，命令就不可用
  isEnabled: () =>
    !(
      isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||   // 企业级 AWS Bedrock 接入
      isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||    // 企业级 Google Vertex 接入
      isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY) ||   // 企业级 Foundry 接入
      isEnvTruthy(process.env.DISABLE_FEEDBACK_COMMAND) ||  // 管理员禁用反馈命令
      isEnvTruthy(process.env.DISABLE_BUG_COMMAND) ||       // 管理员禁用 bug 命令（旧名）
      isEssentialTrafficOnly() ||                           // 隐私严格模式，禁止非必要外部请求
      process.env.USER_TYPE === 'ant' ||                    // 内部员工走内部反馈系统
      !isPolicyAllowed('allow_product_feedback')            // 企业策略禁止产品反馈
    ),
  load: () => import('./feedback.js'),
} satisfies Command

export default feedback
