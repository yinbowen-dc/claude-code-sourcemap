/**
 * extra-usage 命令非交互式适配层（extra-usage-noninteractive.ts）
 *
 * 本文件是 /extra-usage 命令在非交互式（管道/SDK）场景下的适配层。
 * 它调用共享的 runExtraUsage() 核心逻辑，然后将返回的 ExtraUsageResult
 * 统一转换为纯文本字符串输出，适合管道处理和 SDK 响应。
 *
 * 与交互式版本（extra-usage.jsx）的区别：
 * - 交互式版本可以展示进度动画、React 组件等富交互 UI
 * - 本非交互式版本只返回纯文本，适合脚本捕获和处理
 *
 * 流程位置：SDK/管道触发 /extra-usage → index.ts 路由到本模块
 *           → call() → runExtraUsage() → 转换为纯文本 → 返回调用方
 */
import { runExtraUsage } from './extra-usage-core.js'

/**
 * /extra-usage 命令的非交互式入口函数
 *
 * 将 runExtraUsage() 返回的 ExtraUsageResult 转换为统一的纯文本格式：
 * - `message` 类型：直接使用其文本值
 * - `browser-opened` 类型：
 *   - 浏览器成功打开 → 提示已打开并附上 fallback URL
 *   - 浏览器未能打开 → 直接提示手动访问 URL
 */
export async function call(): Promise<{ type: 'text'; value: string }> {
  // 执行核心逻辑（管理员申请流程 或 打开浏览器）
  const result = await runExtraUsage()

  if (result.type === 'message') {
    // 文本类型结果直接透传，无需转换
    return { type: 'text', value: result.value }
  }

  // browser-opened 类型：根据浏览器是否成功打开，给出不同的文本提示
  return {
    type: 'text',
    value: result.opened
      ? `Browser opened to manage extra usage. If it didn't open, visit: ${result.url}`
      : `Please visit ${result.url} to manage extra usage.`, // 浏览器打开失败时的降级提示
  }
}
