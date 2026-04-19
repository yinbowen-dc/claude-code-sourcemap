/**
 * remote-setup 命令入口 —— Claude Code 命令注册层
 *
 * 在整体流程中的位置：
 *   用户输入 `/web-setup` → commands 注册表检查 isEnabled 和 isHidden
 *   → 双重门控通过后懒加载 remote-setup.js → 渲染 Web 端 Claude Code
 *   设置向导（连接 GitHub 账号 → 导入 PAT → 创建默认环境）的 JSX 界面
 *
 * 主要功能：
 *   为 claude.ai/code（Web 端 Claude Code）提供首次配置入口，
 *   引导用户完成 GitHub 账号绑定，使 Web 端可以访问私有仓库并执行
 *   代码操作。受两个条件联合门控：
 *     1. GrowthBook 功能开关 'tengu_cobalt_lantern' 为 true
 *        （渐进式发布，控制哪些用户可见此命令）
 *     2. isPolicyAllowed('allow_remote_sessions')
 *        （组织策略允许远程会话）
 *
 * availability: ['claude-ai'] 表明此命令仅在 claude.ai 平台上下文中有意义，
 * 独立 CLI 模式下不需要此配置流程。
 */
import type { Command } from '../../commands.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'

const web = {
  type: 'local-jsx',                                   // 本地进程内渲染 React 组件
  name: 'web-setup',                                   // 斜杠命令名称
  description:
    'Setup Claude Code on the web (requires connecting your GitHub account)',
  availability: ['claude-ai'],                         // 仅在 claude.ai 平台下有意义
  /**
   * isEnabled —— 命令可用性门控（缓存值，启动时确定）
   * 需同时满足：功能开关开启 + 策略允许远程会话
   * 注意：getFeatureValue_CACHED_MAY_BE_STALE 使用缓存值，可能有轻微延迟
   */
  isEnabled: () =>
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_cobalt_lantern', false) &&
    isPolicyAllowed('allow_remote_sessions'),
  /**
   * isHidden getter —— 策略不允许时从帮助列表隐藏
   * 使用 getter 实时读取策略，确保策略变更能即时反映（不受 GrowthBook 缓存影响）
   */
  get isHidden() {
    return !isPolicyAllowed('allow_remote_sessions')
  },
  load: () => import('./remote-setup.js'),             // 懒加载 Web 设置向导 UI
} satisfies Command

export default web
