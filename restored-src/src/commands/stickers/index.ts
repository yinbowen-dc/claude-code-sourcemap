/**
 * stickers 命令注册入口（commands/stickers/index.ts）
 *
 * 本文件将 /stickers 命令注册到 Claude Code 全局命令系统。
 * 该命令是一个彩蛋式便民功能：直接在浏览器中打开 Claude Code 官方贴纸订购页面
 * （Sticker Mule 商城），让用户可以订购 Claude Code 周边贴纸。
 *
 * 在系统流程中的位置：
 *   用户输入 /stickers → 命令注册表匹配 → load() 懒加载 stickers.js
 *   → 调用 openBrowser() 打开贴纸商城页面 → 返回文本提示。
 */

import type { Command } from '../../commands.js'

/**
 * stickers 命令描述对象。
 * - type: 'local' 表示同步本地命令，直接执行并返回文本结果，无需渲染 JSX 组件。
 * - supportsNonInteractive: false 要求必须在交互式终端下使用（打开浏览器需要桌面环境）。
 */
const stickers = {
  type: 'local',
  name: 'stickers',
  description: 'Order Claude Code stickers',
  supportsNonInteractive: false,  // 依赖桌面浏览器环境，无头/CI 环境中不可用
  load: () => import('./stickers.js'),
} satisfies Command

export default stickers
