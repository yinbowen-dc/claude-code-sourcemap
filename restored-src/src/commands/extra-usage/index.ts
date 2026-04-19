/**
 * extra-usage 命令入口模块（index.ts）
 *
 * 本文件导出 /extra-usage 命令的两个变体，与 context/index.ts 的模式相同：
 * 按当前会话是否为交互式，互斥地启用对应实现。
 *
 * 两个变体均通过 isExtraUsageAllowed() 进行统一的功能开关检查：
 * - DISABLE_EXTRA_USAGE_COMMAND 环境变量可强制关闭（企业管控场景）
 * - isOverageProvisioningAllowed() 检查账号是否有 overage 配置权限
 *   （如 Free 计划用户无法配置 extra usage）
 *
 * 命令体系位置：extra-usage-core.ts（业务逻辑）
 *              ↑ 被 extra-usage.jsx（交互式）和 extra-usage-noninteractive.ts（非交互式）调用
 *              ↑ 由本文件注册到全局命令表
 */
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import { isOverageProvisioningAllowed } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

/**
 * 检查当前用户是否允许使用 extra-usage 命令
 *
 * 双重检查：
 * 1. 环境变量开关 DISABLE_EXTRA_USAGE_COMMAND（运维级别强制禁用）
 * 2. 账号级别的 overage 配置权限（Free 计划等无权限账号返回 false）
 */
function isExtraUsageAllowed(): boolean {
  // 运维层面的强制禁用开关，优先级最高
  if (isEnvTruthy(process.env.DISABLE_EXTRA_USAGE_COMMAND)) {
    return false
  }
  // 检查账号是否具备配置 overage 的权限
  return isOverageProvisioningAllowed()
}

/**
 * 交互式 extra-usage 命令
 *
 * 在 TTY 会话中展示带进度动画和交互界面的 React 组件版本，
 * 仅在允许使用且为交互式会话时启用。
 */
export const extraUsage = {
  // local-jsx 类型：React 组件可展示加载状态和丰富的操作反馈
  type: 'local-jsx',
  name: 'extra-usage',
  description: 'Configure extra usage to keep working when limits are hit',
  // 功能开关 + 排除非交互式会话（非交互式由 extraUsageNonInteractive 处理）
  isEnabled: () => isExtraUsageAllowed() && !getIsNonInteractiveSession(),
  load: () => import('./extra-usage.js'),
} satisfies Command

/**
 * 非交互式 extra-usage 命令
 *
 * 在 SDK/管道场景中返回纯文本结果，
 * 在交互式会话中隐藏，避免与上方的交互式版本产生重复。
 */
export const extraUsageNonInteractive = {
  // local 类型：直接返回文本，不依赖 React 渲染
  type: 'local',
  name: 'extra-usage',
  // 声明支持非交互式，使 SDK 路由层能找到此变体
  supportsNonInteractive: true,
  description: 'Configure extra usage to keep working when limits are hit',
  // 仅在非交互式会话中启用，与交互式版本互斥
  isEnabled: () => isExtraUsageAllowed() && getIsNonInteractiveSession(),
  // 在交互式会话中隐藏，保持 /help 列表整洁
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  load: () => import('./extra-usage-noninteractive.js'),
} satisfies Command
