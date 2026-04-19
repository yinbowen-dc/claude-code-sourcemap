/**
 * passes 命令入口 —— Claude Code 命令注册层
 *
 * 在整体流程中的位置：
 *   用户输入 `/passes` → commands 注册表路由到本模块 → 懒加载 passes.js
 *   → 渲染 Pass 分享与推荐奖励的 JSX 界面
 *
 * 主要功能：
 *   管理"免费周 Pass"分享功能的命令元数据。该命令只在用户有资格
 *   （eligible 且缓存有效）时才对外可见——通过 isHidden getter 实现动态显隐。
 *   当用户存在推荐奖励（referrer reward）时，description 会额外说明"可获得
 *   额外使用量"，起到激励引导作用。
 */
import type { Command } from '../../commands.js'
import {
  checkCachedPassesEligibility,
  getCachedReferrerReward,
} from '../../services/api/referral.js'

export default {
  type: 'local-jsx', // 本地进程内渲染 React 组件
  name: 'passes',    // 斜杠命令名称
  /**
   * description getter：根据当前用户是否有推荐奖励，动态返回不同的描述文本。
   * 有奖励时追加"earn extra usage"以提升分享意愿。
   */
  get description() {
    const reward = getCachedReferrerReward() // 读取本地缓存中的推荐奖励信息
    if (reward) {
      // 用户有待领取的推荐奖励时，显示带有激励性文案的描述
      return 'Share a free week of Claude Code with friends and earn extra usage'
    }
    // 无奖励时显示基础描述
    return 'Share a free week of Claude Code with friends'
  },
  /**
   * isHidden getter：仅当用户具备资格（eligible）且本地存在有效缓存时
   * 才显示命令。未登录或不符合条件的用户不会在帮助列表中看到此命令。
   */
  get isHidden() {
    const { eligible, hasCache } = checkCachedPassesEligibility()
    // 两个条件都满足才显示：有资格 + 缓存存在（避免冷启动时误判）
    return !eligible || !hasCache
  },
  load: () => import('./passes.js'), // 懒加载 Pass 分享界面实现
} satisfies Command
