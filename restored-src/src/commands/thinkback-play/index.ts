/**
 * thinkback-play 命令注册入口
 *
 * 在 Claude Code 命令体系中，本文件是"年度回顾动画单独播放"功能的声明层。
 * 它将 thinkback-play 注册为一条对用户隐藏的内部命令，不出现在 /help 列表中。
 *
 * 调用链路：
 *   用户执行 /think-back（thinkback/index.ts）
 *     → thinkback skill 生成年度回顾内容
 *     → 内部调用 /thinkback-play（本命令）
 *     → thinkback-play.ts#call() 定位插件目录并播放动画
 *
 * 与 thinkback/index.ts 的关系：thinkback 负责生成+播放一体化流程，
 * thinkback-play 则将"播放"拆分出来，允许在内容已生成的情况下单独重播动画。
 *
 * 可用性受 Statsig Feature Gate `tengu_thinkback` 控制，门控关闭时命令不可用。
 */
import type { Command } from '../../commands.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

// 隐藏命令：由 thinkback skill 在内容生成完成后内部调用，不对用户直接暴露
const thinkbackPlay = {
  // 纯本地命令，执行时不需要向 Claude API 发起请求
  type: 'local',
  // 命令名称，与 thinkback（/think-back）区分，专职动画播放
  name: 'thinkback-play',
  description: 'Play the thinkback animation',
  // 使用缓存版本的特性门控检查，避免每次调用发起网络请求
  isEnabled: () =>
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_thinkback'),
  // 对用户隐藏：不在 /help 或命令补全中显示，仅供内部调用
  isHidden: true,
  // 动画播放依赖交互式终端（TTY），在管道/CI 等非交互场景下无意义
  supportsNonInteractive: false,
  // 懒加载执行模块，仅在命令实际被调用时才引入，减少冷启动开销
  load: () => import('./thinkback-play.js'),
} satisfies Command

export default thinkbackPlay
