/**
 * 费用摘要钩子模块（React Hook）
 *
 * 在 Claude Code 系统流程中的位置：
 * - 本文件是费用追踪与 React UI 层之间的桥接，挂载在顶层 UI 组件（App/REPL）上。
 * - 调用链：App/REPL 组件 mount → useCostSummary() → 注册 process 'exit' 监听器
 * - 进程退出时自动触发两件事：
 *     1. 若用户有 Console 计费权限，向 stdout 打印格式化的费用摘要（如 /cost 命令的输出）
 *     2. 将当前会话费用数据持久化到项目配置文件（供下次会话恢复时使用）
 * - useEffect 的清理函数会在组件卸载时移除监听器，防止内存泄漏和重复注册
 */
import { useEffect } from 'react'
import { formatTotalCost, saveCurrentSessionCosts } from './cost-tracker.js'
import { hasConsoleBillingAccess } from './utils/billing.js'
import type { FpsMetrics } from './utils/fpsTracker.js'

/**
 * 费用摘要 React Hook
 *
 * 在组件挂载时注册一个 process 'exit' 监听器，在进程退出时执行以下操作：
 * 1. 若当前用户有 Console 计费权限（hasConsoleBillingAccess），则向 stdout 输出本次会话的费用摘要，
 *    包含总费用、API 耗时、代码行数变更、各模型 token 用量等信息。
 * 2. 无论是否有计费权限，都将本次会话的费用数据（包含 FPS 帧率指标）保存到项目配置文件，
 *    以便下次 /resume 时恢复历史费用累计。
 *
 * 使用 useEffect 的依赖数组为空（[]），确保监听器只在组件挂载时注册一次，
 * 清理函数在组件卸载时移除监听器，防止内存泄漏。
 *
 * @param getFpsMetrics 可选的 FPS 指标获取函数，在保存费用时一并持久化帧率性能数据
 */
export function useCostSummary(
  getFpsMetrics?: () => FpsMetrics | undefined,
): void {
  useEffect(() => {
    // 定义退出时执行的费用摘要处理函数
    const f = () => {
      // 仅对有 Console 计费权限的用户打印费用摘要（避免对无计费需求的用户干扰输出）
      if (hasConsoleBillingAccess()) {
        process.stdout.write('\n' + formatTotalCost() + '\n') // 打印格式化的总费用摘要
      }

      // 将当前会话费用及 FPS 指标持久化到项目配置，供 /resume 恢复使用
      saveCurrentSessionCosts(getFpsMetrics?.())
    }
    // 注册进程退出监听器（同步退出，确保费用数据在进程关闭前写入）
    process.on('exit', f)
    // 清理函数：组件卸载时移除监听器，防止重复注册或内存泄漏
    return () => {
      process.off('exit', f)
    }
  }, []) // 空依赖数组：只在组件挂载/卸载时执行，不随任何状态变化重新注册
}
