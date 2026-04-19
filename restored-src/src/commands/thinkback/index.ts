/**
 * thinkback（/think-back）命令注册入口
 *
 * 本文件在 Claude Code 命令系统中扮演"年度回顾"功能的声明层。
 * 它将 `/think-back` 注册为一条对用户可见的 JSX 渲染命令，
 * 负责展示用户的 2025 年 Claude Code 使用回顾（类似 Spotify Wrapped）。
 *
 * 调用链路：
 *   用户输入 /think-back
 *     → 命令框架通过本文件的 `load` 懒加载 thinkback.ts
 *     → thinkback.ts 生成年度回顾内容并渲染动画
 *     → 动画播放也可通过 thinkback-play/index.ts 单独重触发
 *
 * 功能开关：由 Statsig Feature Gate `tengu_thinkback` 控制，
 * 未命中实验的用户不会看到此命令，也无法执行。
 * 命令类型为 local-jsx，意味着其输出由 React 组件渲染到终端 UI。
 */
import type { Command } from '../../commands.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'

const thinkback = {
  // local-jsx 类型：命令结果通过 React 组件渲染，支持富文本终端 UI
  type: 'local-jsx',
  // 用户可见的命令名称，/think-back（带连字符与 thinkback-play 区分）
  name: 'think-back',
  // 简短描述，展示在 /help 列表中
  description: 'Your 2025 Claude Code Year in Review',
  // 通过缓存版 Feature Gate 检查控制命令可见性，避免频繁网络请求
  isEnabled: () =>
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_thinkback'),
  // 懒加载：仅在用户实际执行命令时才引入实现模块，减少启动开销
  load: () => import('./thinkback.js'),
} satisfies Command

export default thinkback
