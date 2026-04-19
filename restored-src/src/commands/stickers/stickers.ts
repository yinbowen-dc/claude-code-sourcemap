/**
 * stickers 命令核心实现（commands/stickers/stickers.ts）
 *
 * 本文件实现 /stickers 命令的执行逻辑：通过调用系统默认浏览器打开
 * Claude Code 官方贴纸订购页面（Sticker Mule 商城）。
 *
 * 在 Claude Code 整体流程中的位置：
 *   /stickers 触发 → stickers/index.ts 注册项 → 本文件 call()
 *   → openBrowser(url) 调用系统浏览器 → 返回文字反馈给用户。
 *
 * 容错设计：若浏览器打开失败（无头环境、权限问题等），
 * 会降级为直接输出 URL，让用户手动访问。
 */

import type { LocalCommandResult } from '../../types/command.js'
import { openBrowser } from '../../utils/browser.js'

/**
 * /stickers 命令的主执行函数。
 *
 * 执行流程：
 *   1. 定义目标贴纸商城 URL；
 *   2. 调用 openBrowser() 尝试用系统默认浏览器打开该 URL；
 *   3. 成功时返回"正在打开..."提示；
 *   4. 失败时降级为直接输出 URL 文本，让用户手动复制访问。
 */
export async function call(): Promise<LocalCommandResult> {
  const url = 'https://www.stickermule.com/claudecode'  // Claude Code 官方贴纸商城地址
  const success = await openBrowser(url)

  if (success) {
    // 浏览器成功打开，给出正在跳转的友好提示
    return { type: 'text', value: 'Opening sticker page in browser…' }
  } else {
    // 浏览器打开失败（如 SSH 无头环境），降级输出 URL 供用户手动访问
    return {
      type: 'text',
      value: `Failed to open browser. Visit: ${url}`,
    }
  }
}
