/**
 * export 命令的注册入口。
 *
 * 在 Claude Code 的命令体系中，/export 命令允许用户将当前完整对话
 * 导出为外部文件或复制到系统剪贴板，便于归档、分享或后续分析。
 * 支持可选的文件名参数：
 *  - /export          → 导出到默认文件名或剪贴板
 *  - /export foo.md   → 导出到指定文件 foo.md
 *
 * 本文件仅声明命令元数据，实际的序列化与文件写入逻辑在 export.js 中，
 * 通过懒加载方式引入以减少启动耗时。
 */
import type { Command } from '../../commands.js'

const exportCommand = {
  // local-jsx 类型：使用 Ink React 组件渲染导出进度或确认界面
  type: 'local-jsx',
  name: 'export',
  description: 'Export the current conversation to a file or clipboard',
  // 可选的文件名参数提示
  argumentHint: '[filename]',
  load: () => import('./export.js'),
} satisfies Command

export default exportCommand
