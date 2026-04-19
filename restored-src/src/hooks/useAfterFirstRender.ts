/**
 * useAfterFirstRender.ts
 *
 * 【在系统流程中的位置】
 * 本文件属于 Claude Code 的「启动性能测量」辅助 hook。
 * 仅在 Anthropic 内部环境（USER_TYPE === 'ant'）且设置了
 * CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER 环境变量时生效。
 *
 * 主要用途：
 * - 在 CI/性能测试环境中，测量应用从启动到首次渲染完成所需的时间；
 * - 首次渲染完成后立即将启动耗时（毫秒）输出到 stderr，然后退出进程；
 * - 通过 process.uptime() 获取进程启动至今的时间，精确到毫秒。
 */

import { useEffect } from 'react'
import { isEnvTruthy } from '../utils/envUtils.js'

/**
 * 在组件首次渲染完成后触发一次性回调。
 *
 * 当满足以下条件时，输出启动耗时并退出进程：
 * 1. 当前用户类型为 'ant'（Anthropic 内部用户）；
 * 2. 环境变量 CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER 为真值。
 *
 * 依赖数组为空（[]），确保仅在首次渲染后的 effect 中执行一次。
 */
export function useAfterFirstRender(): void {
  useEffect(() => {
    // 仅在 Anthropic 内部环境（USER_TYPE=ant）且设置了性能测量标志时触发
    if (
      process.env.USER_TYPE === 'ant' &&
      isEnvTruthy(process.env.CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER)
    ) {
      // 将启动时间输出到 stderr（避免污染 stdout 的正常输出）
      // process.uptime() 返回秒，乘以 1000 转换为毫秒并四舍五入
      process.stderr.write(
        `\nStartup time: ${Math.round(process.uptime() * 1000)}ms\n`,
      )
      // 立即退出进程（用于 CI 中的冷启动时间基准测量）
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(0)
    }
  }, [])  // 空依赖：只在首次渲染后执行一次
}
