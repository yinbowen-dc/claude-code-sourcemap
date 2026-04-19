/**
 * remote-env 命令入口 —— Claude Code 命令注册层
 *
 * 在整体流程中的位置：
 *   用户输入 `/remote-env` → commands 注册表检查 isEnabled 和 isHidden
 *   → 双重门控通过后懒加载 remote-env.js → 渲染远程环境配置 JSX 界面
 *
 * 主要功能：
 *   为 Claude Code Teleport（远程会话传送）功能提供默认远程环境的配置入口。
 *   受两个条件联合门控：
 *     1. isClaudeAISubscriber() —— 需为 claude.ai 付费订阅用户
 *     2. isPolicyAllowed('allow_remote_sessions') —— 组织策略允许远程会话
 *   isEnabled 与 isHidden 使用相同条件，确保未满足条件时命令既不可用
 *   也不出现在帮助列表中，避免给无权限用户造成困惑。
 */
import type { Command } from '../../commands.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'

export default {
  type: 'local-jsx',                                   // 本地进程内渲染 React 组件
  name: 'remote-env',
  description: 'Configure the default remote environment for teleport sessions',
  /**
   * isEnabled —— 命令可用性门控
   * 需同时满足：claude.ai 订阅 + 策略允许远程会话
   */
  isEnabled: () =>
    isClaudeAISubscriber() && isPolicyAllowed('allow_remote_sessions'),
  /**
   * isHidden getter —— 与 isEnabled 条件镜像，不满足时从帮助列表隐藏
   * 使用 getter 确保每次访问都实时读取策略状态，避免启动后策略变更失效
   */
  get isHidden() {
    return !isClaudeAISubscriber() || !isPolicyAllowed('allow_remote_sessions')
  },
  load: () => import('./remote-env.js'),               // 懒加载远程环境配置 UI
} satisfies Command
