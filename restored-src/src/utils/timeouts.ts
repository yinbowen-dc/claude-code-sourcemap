/**
 * 【文件定位】通用工具层 — Bash 工具超时配置
 *
 * 在 Claude Code 系统流程中的位置：
 *   BashTool 执行 shell 命令时需要超时上限，避免命令挂起阻塞 Claude Code 进程。
 *     → 本模块提供 getDefaultBashTimeoutMs() 和 getMaxBashTimeoutMs()
 *     → BashTool 用 default 作为不指定 timeout 时的默认值
 *     → BashTool 用 max 作为用户指定 timeout 时的上限验证
 *
 * 主要职责：
 *   1. 定义硬编码默认值：DEFAULT_TIMEOUT_MS = 120s，MAX_TIMEOUT_MS = 600s
 *   2. getDefaultBashTimeoutMs() — 读取 BASH_DEFAULT_TIMEOUT_MS 环境变量，
 *      支持运维人员在部署时调整（如 CI 环境需要更长时间）
 *   3. getMaxBashTimeoutMs()    — 读取 BASH_MAX_TIMEOUT_MS 环境变量，
 *      并强制保证 max ≥ default，避免配置逻辑错误
 *
 * 设计原则：
 *   - 函数接受可注入的 env 参数（默认 process.env），便于单元测试
 *   - 环境变量解析失败（NaN / ≤0）时静默回退到硬编码默认值
 */

// 默认超时：120 秒（2 分钟），适用于普通 bash 命令
const DEFAULT_TIMEOUT_MS = 120_000 // 2 minutes
// 最大超时：600 秒（10 分钟），用于构建等长时间操作的上限
const MAX_TIMEOUT_MS = 600_000 // 10 minutes

// 允许注入任意键值对作为 env（便于测试时传入自定义环境变量）
type EnvLike = Record<string, string | undefined>

/**
 * 获取 Bash 操作的默认超时时间（毫秒）。
 *
 * 流程：
 *   1. 读取 BASH_DEFAULT_TIMEOUT_MS 环境变量
 *   2. 若值存在且为有效正整数，返回该值
 *   3. 否则返回硬编码的 DEFAULT_TIMEOUT_MS（120_000）
 *
 * @param env 环境变量对象，默认为 process.env（生产用途）
 * @returns 超时毫秒数
 */
export function getDefaultBashTimeoutMs(env: EnvLike = process.env): number {
  const envValue = env.BASH_DEFAULT_TIMEOUT_MS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    // 只接受有效正整数；NaN 或 ≤0 视为无效配置，回退到默认值
    if (!isNaN(parsed) && parsed > 0) {
      return parsed
    }
  }
  return DEFAULT_TIMEOUT_MS
}

/**
 * 获取 Bash 操作的最大超时时间（毫秒）。
 *
 * 流程：
 *   1. 读取 BASH_MAX_TIMEOUT_MS 环境变量
 *   2. 若值存在且为有效正整数，返回 max(parsed, defaultTimeout) 确保不小于默认值
 *   3. 否则返回 max(MAX_TIMEOUT_MS, defaultTimeout)（防止 default 被环境变量调得更大）
 *
 * 约束：max 始终 ≥ default，避免配置矛盾导致所有命令立即超时。
 *
 * @param env 环境变量对象，默认为 process.env（生产用途）
 * @returns 最大超时毫秒数
 */
export function getMaxBashTimeoutMs(env: EnvLike = process.env): number {
  const envValue = env.BASH_MAX_TIMEOUT_MS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (!isNaN(parsed) && parsed > 0) {
      // 确保 max 至少与 default 一样大，避免配置不一致
      return Math.max(parsed, getDefaultBashTimeoutMs(env))
    }
  }
  // Always ensure max is at least as large as default
  // （即使 default 被环境变量调高到超过 MAX_TIMEOUT_MS，max 也要跟上）
  return Math.max(MAX_TIMEOUT_MS, getDefaultBashTimeoutMs(env))
}
