/**
 * copy 命令的注册入口。
 * Implementation is lazy-loaded from copy.tsx to reduce startup time.
 *
 * 在 Claude Code 的命令体系中，/copy 命令负责将 Claude 最近一次回复的内容
 * 复制到系统剪贴板。用户也可以通过 /copy N 指定复制第 N 条历史回复。
 * 本文件只声明命令元数据，渲染逻辑和剪贴板操作在 copy.tsx 中通过懒加载引入。
 */
import type { Command } from '../../commands.js'

const copy = {
  // local-jsx 类型：借助 Ink React 组件实现交互式终端 UI（如复制成功提示）
  type: 'local-jsx',
  name: 'copy',
  description:
    "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)",
  // 懒加载实现模块，减少 Claude Code 冷启动耗时
  load: () => import('./copy.js'),
} satisfies Command

export default copy
