/**
 * compact 命令的注册入口。
 *
 * 在 Claude Code 的命令系统中，每个斜杠命令（slash command）均由一个轻量级的
 * 注册描述对象和一个延迟加载的实现模块两部分组成。本文件只负责注册描述对象，
 * 实际的压缩逻辑在 compact.ts 中，通过 `load()` 懒加载以降低启动耗时。
 *
 * /compact 命令的作用：清空会话历史消息，但在上下文中保留一份摘要，
 * 从而在不丢失关键信息的前提下释放大量 token 空间。
 * 支持传入自定义摘要指令，例如：/compact 聚焦于最新的代码变更
 */
import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const compact = {
  type: 'local',
  name: 'compact',
  description:
    'Clear conversation history but keep a summary in context. Optional: /compact [instructions for summarization]',
  // 若环境变量 DISABLE_COMPACT 为真值，则禁用该命令
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_COMPACT),
  // 支持非交互式（headless/SDK）会话，可在管道中调用
  supportsNonInteractive: true,
  argumentHint: '<optional custom summarization instructions>',
  // 懒加载实现模块，仅在命令被实际执行时才引入，减少冷启动开销
  load: () => import('./compact.js'),
} satisfies Command

export default compact
