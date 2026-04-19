/**
 * GrowthBook 功能开关 SDK 密钥
 *
 * 本文件提供获取 GrowthBook A/B 测试平台 SDK 客户端密钥的函数。
 * GrowthBook 用于向不同用户群（Anthropic 内部员工 vs 外部用户）
 * 分发不同的功能开关（feature flags）和实验配置。
 *
 * 密钥路由逻辑：
 * - USER_TYPE === 'ant'（Anthropic 员工）：
 *   - ENABLE_GROWTHBOOK_DEV=true → 开发环境密钥（实验性功能）
 *   - 默认 → 内部生产密钥
 * - 其他（外部用户）：外部生产密钥
 *
 * 使用延迟读取（lazy read）而非模块级常量，确保在模块加载后
 * 由 globalSettings.env 设置的 ENABLE_GROWTHBOOK_DEV 能被正确读取。
 * USER_TYPE 是构建时定义（build-time define），可安全地在模块加载时使用。
 */
import { isEnvTruthy } from '../utils/envUtils.js'

/**
 * 获取当前用户环境对应的 GrowthBook SDK 客户端密钥。
 *
 * 工作流程：
 * 1. 检查 USER_TYPE 是否为 'ant'（Anthropic 内部员工标识）
 * 2. 若是员工，进一步检查 ENABLE_GROWTHBOOK_DEV 是否为真值
 * 3. 根据上述判断返回对应的 SDK 密钥字符串
 *
 * 注意：此函数使用延迟读取，每次调用时重新读取环境变量，
 * 以确保 globalSettings.env 应用后的值能被感知到。
 */
export function getGrowthBookClientKey(): string {
  return process.env.USER_TYPE === 'ant'
    ? isEnvTruthy(process.env.ENABLE_GROWTHBOOK_DEV)
      ? 'sdk-yZQvlplybuXjYh6L'  // ant 用户的开发环境密钥
      : 'sdk-xRVcrliHIlrg4og4'  // ant 用户的生产环境密钥
    : 'sdk-zAZezfDKGoZuXXKe'    // 外部用户的生产密钥
}
