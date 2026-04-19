/**
 * Computer Use 功能开关模块（GrowthBook）。
 *
 * 在 Claude Code 系统中，该模块通过 GrowthBook 动态配置控制 Computer Use（Chicago）功能的启用状态：
 * - getChicagoEnabled()：检查功能总开关（配置键 `tengu_malort_pedway`），
 *   结合订阅类型和环境变量决定是否启用 Computer Use
 * - getChicagoSubGates()：获取子功能开关（CuSubGates），如鼠标动画、动作前隐藏等
 * - getChicagoCoordinateMode()：获取坐标模式（CoordinateMode），控制截图坐标系
 */
import type { CoordinateMode, CuSubGates } from '@ant/computer-use-mcp/types'

import { getDynamicConfig_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getSubscriptionType } from '../auth.js'
import { isEnvTruthy } from '../envUtils.js'

type ChicagoConfig = CuSubGates & {
  enabled: boolean
  coordinateMode: CoordinateMode
}

const DEFAULTS: ChicagoConfig = {
  enabled: false,
  pixelValidation: false,
  clipboardPasteMultiline: true,
  mouseAnimation: true,
  hideBeforeAction: true,
  autoTargetDisplay: true,
  clipboardGuard: true,
  coordinateMode: 'pixels',
}

// 各子功能开关和坐标模式的默认值；GrowthBook 返回部分配置时其余字段继承此默认值
const DEFAULTS: ChicagoConfig = {
  enabled: false,
  pixelValidation: false,
  clipboardPasteMultiline: true,
  mouseAnimation: true,
  hideBeforeAction: true,
  autoTargetDisplay: true,
  clipboardGuard: true,
  coordinateMode: 'pixels',
}

/**
 * 从 GrowthBook 读取 Chicago 完整配置，将远端配置覆盖到默认值上。
 *
 * getDynamicConfig 的泛型参数仅为类型断言，不做运行时校验；
 * 使用 spread 确保 GB 仅返回部分字段时，未出现的字段仍有合理默认值。
 */
function readConfig(): ChicagoConfig {
  return {
    ...DEFAULTS,
    // GrowthBook 配置键 'tengu_malort_pedway'，可能返回部分字段
    ...getDynamicConfig_CACHED_MAY_BE_STALE<Partial<ChicagoConfig>>(
      'tengu_malort_pedway',
      DEFAULTS,
    ),
  }
}

/**
 * 检查当前用户是否满足订阅要求（Max/Pro）。
 *
 * Ant 员工账号不受订阅层级限制（USER_TYPE === 'ant' 直接放行），
 * 因为 Ant 员工不一定有 Max/Pro，但需要能够进行 dogfooding 测试。
 * 详见 CLAUDE.md:281：USER_TYPE !== 'ant' 的分支获得零 antfooding。
 */
function hasRequiredSubscription(): boolean {
  // Ant 员工绕过订阅检查，确保内部测试不受层级影响
  if (process.env.USER_TYPE === 'ant') return true
  const tier = getSubscriptionType()
  // 仅 Max 和 Pro 订阅可使用 Computer Use
  return tier === 'max' || tier === 'pro'
}

/**
 * 检查 Computer Use（Chicago）功能总开关是否开启。
 *
 * 逻辑：
 * 1. Ant 员工且存在 MONOREPO_ROOT_DIR（表明在 monorepo 开发环境）时禁用，
 *    防止 shell 继承的 monorepo 开发配置影响 CLI 行为；
 *    可通过 ALLOW_ANT_COMPUTER_USE_MCP=1 强制启用。
 * 2. 其他情况下检查订阅层级 AND GrowthBook 配置的 enabled 字段。
 */
export function getChicagoEnabled(): boolean {
  // Ant 员工在 monorepo 开发环境中禁用，MONOREPO_ROOT_DIR 是廉价代理指标
  // 表示"拥有 monorepo 访问权限"，由 laptop-setup.sh 注入 ~/.zshrc
  if (
    process.env.USER_TYPE === 'ant' &&
    process.env.MONOREPO_ROOT_DIR &&
    !isEnvTruthy(process.env.ALLOW_ANT_COMPUTER_USE_MCP)
  ) {
    return false
  }
  // 同时满足订阅要求和 GrowthBook 配置启用才开放
  return hasRequiredSubscription() && readConfig().enabled
}

/**
 * 获取 Computer Use 子功能开关（排除顶层 enabled 和 coordinateMode）。
 *
 * 返回 CuSubGates 对象，供 createCliExecutor 和 MCP 服务器读取具体子功能状态。
 */
export function getChicagoSubGates(): CuSubGates {
  // 解构排除非子功能字段，返回纯子功能开关对象
  const { enabled: _e, coordinateMode: _c, ...subGates } = readConfig()
  return subGates
}

// 坐标模式在首次读取时冻结：setup.ts 构建工具描述和 executor.ts 缩放坐标使用同一值。
// 若允许实时读取，会话中途 GrowthBook 翻转可能导致模型看到 "pixels" 但点击按 normalized 处理。
let frozenCoordinateMode: CoordinateMode | undefined

/**
 * 获取坐标模式（CoordinateMode），首次调用后冻结，避免会话中 GrowthBook 动态翻转引发坐标不一致。
 */
export function getChicagoCoordinateMode(): CoordinateMode {
  // 懒初始化并冻结：首次读取后不再更新
  frozenCoordinateMode ??= readConfig().coordinateMode
  return frozenCoordinateMode
}
