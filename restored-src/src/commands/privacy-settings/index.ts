/**
 * privacy-settings 命令入口 —— Claude Code 命令注册层
 *
 * 在整体流程中的位置：
 *   用户输入 `/privacy-settings` → commands 注册表路由到本模块
 *   → isEnabled 检查是否为消费者订阅用户
 *   → 通过检查后懒加载 privacy-settings.js → 渲染隐私设置 JSX 界面
 *
 * 主要功能：
 *   将隐私设置界面限定为消费者订阅用户（Consumer Subscriber）专属命令。
 *   企业/团队计划用户不会在命令列表中看到此项，因为其隐私设置通常
 *   由管理员策略统一管控，而非用户自行配置。
 */
import type { Command } from '../../commands.js'
import { isConsumerSubscriber } from '../../utils/auth.js'

const privacySettings = {
  type: 'local-jsx',                                 // 本地进程内渲染 React 组件
  name: 'privacy-settings',                          // 斜杠命令名称
  description: 'View and update your privacy settings',
  /**
   * isEnabled —— 命令可用性门控
   * 仅允许消费者订阅用户访问隐私设置界面；
   * 非消费者账户（如企业账号）调用此命令时会被系统拦截。
   */
  isEnabled: () => {
    return isConsumerSubscriber() // 检查当前用户是否为 claude.ai 个人订阅用户
  },
  load: () => import('./privacy-settings.js'),       // 懒加载隐私设置 UI
} satisfies Command

export default privacySettings
