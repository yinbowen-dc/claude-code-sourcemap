/**
 * immediateCommand.ts — 推理配置命令"立即生效"开关模块
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于工具层（utils），负责控制推理配置命令
 * （/model、/fast、/effort 等）是否在查询执行过程中立即生效。
 *
 * 默认行为：用户在模型推理进行时发出配置命令，需等待当前轮次完成后才生效。
 * "立即生效"行为：配置命令在推理过程中即时应用，无需等待当前轮次结束。
 *
 * 控制逻辑：
 *   - 内部用户（ant）：始终启用立即生效，用于快速测试新功能；
 *   - 外部用户：通过 GrowthBook 实验特性标志（feature flag）控制，
 *               支持灰度发布，避免一次性影响所有用户。
 *
 * 调用方：REPL 命令处理器（处理 /model、/fast 等命令时检查此标志）。
 */

import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'

/**
 * 判断推理配置命令（/model、/fast、/effort 等）是否应当立即生效。
 *
 * 决策优先级：
 *   1. 若为内部用户（USER_TYPE === 'ant'），直接返回 true（始终立即生效）；
 *   2. 否则查询 GrowthBook 缓存的实验特性标志
 *      'tengu_immediate_model_command'，默认值为 false。
 *
 * 注意：使用 _CACHED_MAY_BE_STALE 版本，意味着特性标志值可能不是最新的，
 * 但避免了每次命令处理时进行同步 I/O，性能更优。
 *
 * @returns true 表示命令应立即生效，false 表示等待当前轮次结束后生效
 */
export function shouldInferenceConfigCommandBeImmediate(): boolean {
  return (
    // 内部用户（ant）始终启用，用于快速迭代和测试
    process.env.USER_TYPE === 'ant' ||
    // 外部用户通过 GrowthBook 实验控制（缓存值，可能稍有延迟）
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_immediate_model_command', false)
  )
}
