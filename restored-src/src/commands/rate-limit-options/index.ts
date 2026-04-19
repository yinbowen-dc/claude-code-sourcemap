/**
 * rate-limit-options 命令入口 —— Claude Code 命令注册层
 *
 * 在整体流程中的位置：
 *   系统内部在检测到速率限制（rate limit）时自动触发本命令，
 *   而非由用户手动输入。注册表将其标记为隐藏，不出现在 /help 列表中。
 *   触发路径：速率限制检测逻辑 → 内部调用 /rate-limit-options
 *   → 懒加载 rate-limit-options.js → 渲染可选操作面板（如切换模型、等待、升级）
 *
 * 主要功能：
 *   仅对 claude.ai 订阅用户开放（通过 isClaudeAISubscriber 门控），
 *   在触达速率上限时向用户展示可采取的应对选项，引导其做出决策而非
 *   直接报错中断对话。
 */
import type { Command } from '../../commands.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'

const rateLimitOptions = {
  type: 'local-jsx',                              // 本地进程内渲染 React 组件
  name: 'rate-limit-options',                     // 内部命令名，系统自动触发
  description: 'Show options when rate limit is reached',
  /**
   * isEnabled —— 命令可用性门控
   * 仅 claude.ai 订阅用户才能看到速率限制处置选项；
   * API Key 用户或未登录状态下返回 false，系统使用默认的限速处理逻辑。
   */
  isEnabled: () => {
    if (!isClaudeAISubscriber()) {
      return false // 非 claude.ai 订阅用户不启用此命令
    }

    return true
  },
  isHidden: true, // Hidden from help - only used internally
  // 隐藏于 /help，防止用户误以为可以手动调用；仅供系统内部在限速时自动唤起
  load: () => import('./rate-limit-options.js'),  // 懒加载速率限制选项 UI
} satisfies Command

export default rateLimitOptions
