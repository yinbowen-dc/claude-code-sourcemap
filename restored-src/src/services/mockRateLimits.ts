/**
 * 模拟限流测试模块（仅限 Anthropic 内部员工使用）
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件是 Claude Code 限流子系统的内部测试辅助层，属于仅限 ANT 账户使用的调试工具。
 * 它允许 Anthropic 员工在不触发真实 API 限流的情况下，模拟各种限流场景，
 * 用于验证前端限流提示 UI、超量使用（overage）逻辑和订阅状态展示等功能。
 *
 * 主要功能：
 * - 维护模拟 HTTP 响应头状态（MockHeaders），在真实 API 响应头中注入模拟值
 * - 支持 20 种预设场景（MockScenario），覆盖从正常使用到超量耗尽的全状态矩阵
 * - 支持细粒度的单头字段设置（setMockHeader）和超量限制追踪（addExceededLimit）
 * - 管理模拟订阅类型（MockSubscriptionType）和快速模式（Fast Mode）限流
 * - 所有函数均通过 process.env.USER_TYPE !== 'ant' 守卫，非内部账户直接返回
 *
 * ⚠️ 警告：仅供内部测试/演示用途，模拟头不保证与真实 API 规范完全一致
 */

// Mock rate limits for testing [ANT-ONLY]
// This allows testing various rate limit scenarios without hitting actual limits
//
// ⚠️  WARNING: This is for internal testing/demo purposes only!
// The mock headers may not exactly match the API specification or real-world behavior.
// Always validate against actual API responses before relying on this for production features.

import type { SubscriptionType } from '../services/oauth/types.js'
import { setMockBillingAccessOverride } from '../utils/billing.js'
import type { OverageDisabledReason } from './claudeAiLimits.js'

/**
 * 模拟 HTTP 响应头字典类型
 *
 * 对应真实 API 中 Anthropic 限流相关的 HTTP 响应头，
 * 所有字段均为可选，由 setMockHeader / setMockRateLimitScenario 按需设置。
 * - anthropic-ratelimit-unified-status：整体限流状态（allowed/allowed_warning/rejected）
 * - anthropic-ratelimit-unified-overage-*：超量使用相关状态
 * - anthropic-ratelimit-unified-{5h,7d}-*：早期预警使用率指标
 * - retry-after：被拒绝时的重试等待秒数
 */
type MockHeaders = {
  'anthropic-ratelimit-unified-status'?:
    | 'allowed'
    | 'allowed_warning'
    | 'rejected'
  'anthropic-ratelimit-unified-reset'?: string
  'anthropic-ratelimit-unified-representative-claim'?:
    | 'five_hour'
    | 'seven_day'
    | 'seven_day_opus'
    | 'seven_day_sonnet'
  'anthropic-ratelimit-unified-overage-status'?:
    | 'allowed'
    | 'allowed_warning'
    | 'rejected'
  'anthropic-ratelimit-unified-overage-reset'?: string
  'anthropic-ratelimit-unified-overage-disabled-reason'?: OverageDisabledReason
  'anthropic-ratelimit-unified-fallback'?: 'available'
  'anthropic-ratelimit-unified-fallback-percentage'?: string
  'retry-after'?: string
  // Early warning utilization headers
  'anthropic-ratelimit-unified-5h-utilization'?: string
  'anthropic-ratelimit-unified-5h-reset'?: string
  'anthropic-ratelimit-unified-5h-surpassed-threshold'?: string
  'anthropic-ratelimit-unified-7d-utilization'?: string
  'anthropic-ratelimit-unified-7d-reset'?: string
  'anthropic-ratelimit-unified-7d-surpassed-threshold'?: string
  'anthropic-ratelimit-unified-overage-utilization'?: string
  'anthropic-ratelimit-unified-overage-surpassed-threshold'?: string
}

/**
 * 模拟头字段简写键名类型
 *
 * setMockHeader 的 key 参数使用此简写，内部自动加上 'anthropic-ratelimit-unified-' 前缀，
 * 'retry-after' 是特殊情况，不加前缀直接映射。
 */
export type MockHeaderKey =
  | 'status'
  | 'reset'
  | 'claim'
  | 'overage-status'
  | 'overage-reset'
  | 'overage-disabled-reason'
  | 'fallback'
  | 'fallback-percentage'
  | 'retry-after'
  | '5h-utilization'
  | '5h-reset'
  | '5h-surpassed-threshold'
  | '7d-utilization'
  | '7d-reset'
  | '7d-surpassed-threshold'

/**
 * 预设测试场景枚举
 *
 * 涵盖从正常使用到各类限流、超量、欠费、模型专属限流的全状态矩阵：
 * - normal：正常使用
 * - session-limit-reached：5小时会话限额耗尽
 * - approaching/weekly-limit-reached：7天周额度告警/耗尽
 * - overage-active/warning/exhausted：超量使用开启/告警/耗尽
 * - out-of-credits/org-zero-credit-limit/org-spend-cap-hit：计费相关禁用原因
 * - member/seat-tier-zero-credit-limit：成员/席位层级额度为零
 * - opus/sonnet-limit/warning：模型专属限流
 * - fast-mode-limit/short：快速模式限流（长/短冷却）
 * - extra-usage-required：无头 429，长上下文需要额外用量
 * - clear：清除所有模拟，恢复真实限流
 */
export type MockScenario =
  | 'normal'
  | 'session-limit-reached'
  | 'approaching-weekly-limit'
  | 'weekly-limit-reached'
  | 'overage-active'
  | 'overage-warning'
  | 'overage-exhausted'
  | 'out-of-credits'
  | 'org-zero-credit-limit'
  | 'org-spend-cap-hit'
  | 'member-zero-credit-limit'
  | 'seat-tier-zero-credit-limit'
  | 'opus-limit'
  | 'opus-warning'
  | 'sonnet-limit'
  | 'sonnet-warning'
  | 'fast-mode-limit'
  | 'fast-mode-short-limit'
  | 'extra-usage-required'
  | 'clear'

// 模块级状态：当前激活的模拟头字典
let mockHeaders: MockHeaders = {}
// 模拟是否已启用（任何 set* 函数被调用后置 true）
let mockEnabled = false
// 无头 429 的自定义错误消息（用于测试 extra-usage-required 路径）
let mockHeaderless429Message: string | null = null
// 显式设置的模拟订阅类型（null 时回退到 DEFAULT_MOCK_SUBSCRIPTION）
let mockSubscriptionType: SubscriptionType | null = null
// 快速模式限流持续时长（毫秒），null 表示未激活快速模式限流场景
let mockFastModeRateLimitDurationMs: number | null = null
// 快速模式限流到期时间戳（毫秒），在首次触发时延迟赋值
let mockFastModeRateLimitExpiresAt: number | null = null
// Default subscription type for mock testing
// 模拟测试使用的默认订阅类型：max（最高等级订阅）
const DEFAULT_MOCK_SUBSCRIPTION: SubscriptionType = 'max'

// Track individual exceeded limits with their reset times
/**
 * 单条超量限制记录类型
 *
 * 追踪已超出的限制类型及其重置时间，
 * 用于 updateRepresentativeClaim 选择"代表性声明"（最晚重置的限制）。
 */
type ExceededLimit = {
  type: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet'
  resetsAt: number // Unix timestamp
}

// 已超出的限制列表，支持多条同时超出（如同时超5小时和7天）
let exceededLimits: ExceededLimit[] = []

// New approach: Toggle individual headers
/**
 * 设置单个模拟响应头字段
 *
 * 整体流程：
 * 1. ANT 账户守卫，非内部账户直接返回
 * 2. 将简写 key 转换为完整头字段名（加前缀，retry-after 除外）
 * 3. 处理特殊逻辑：reset 字段接受"N小时"整数输入，claim 字段更新超量限制列表
 * 4. 写入 mockHeaders，并在 status 或 overage-status 变更时联动更新 retry-after
 *
 * @param key 头字段简写键名（参见 MockHeaderKey）
 * @param value 设置值；undefined 或 'clear' 表示删除该字段
 */
export function setMockHeader(
  key: MockHeaderKey,
  value: string | undefined,
): void {
  // ANT 账户守卫：仅 Anthropic 内部员工可调用
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  mockEnabled = true

  // Special case for retry-after which doesn't have the prefix
  // 将简写 key 转换为完整头字段名；retry-after 是例外，不加 anthropic-ratelimit-unified- 前缀
  const fullKey = (
    key === 'retry-after' ? 'retry-after' : `anthropic-ratelimit-unified-${key}`
  ) as keyof MockHeaders

  if (value === undefined || value === 'clear') {
    // 删除指定头字段
    delete mockHeaders[fullKey]
    // claim 清除时同步清空超量限制列表
    if (key === 'claim') {
      exceededLimits = []
    }
    // Update retry-after if status changed
    // status 或 overage-status 变更时重新计算 retry-after
    if (key === 'status' || key === 'overage-status') {
      updateRetryAfter()
    }
    return
  } else {
    // Handle special cases for reset times
    if (key === 'reset' || key === 'overage-reset') {
      // If user provides a number, treat it as hours from now
      // 用户传入数字时，解释为"N小时后"，自动转换为 Unix 时间戳
      const hours = Number(value)
      if (!isNaN(hours)) {
        value = String(Math.floor(Date.now() / 1000) + hours * 3600)
      }
    }

    // Handle claims - add to exceeded limits
    // claim 字段需要维护 exceededLimits 列表以支持代表性声明计算
    if (key === 'claim') {
      const validClaims = [
        'five_hour',
        'seven_day',
        'seven_day_opus',
        'seven_day_sonnet',
      ]
      if (validClaims.includes(value)) {
        // Determine reset time based on claim type
        // 根据声明类型推算重置时间：5小时声明 → 5h后，7天声明 → 7d后
        let resetsAt: number
        if (value === 'five_hour') {
          resetsAt = Math.floor(Date.now() / 1000) + 5 * 3600
        } else if (
          value === 'seven_day' ||
          value === 'seven_day_opus' ||
          value === 'seven_day_sonnet'
        ) {
          resetsAt = Math.floor(Date.now() / 1000) + 7 * 24 * 3600
        } else {
          resetsAt = Math.floor(Date.now() / 1000) + 3600
        }

        // Add to exceeded limits (remove if already exists)
        // 先删除同类型的已有记录，再添加新记录（幂等更新）
        exceededLimits = exceededLimits.filter(l => l.type !== value)
        exceededLimits.push({ type: value as ExceededLimit['type'], resetsAt })

        // Set the representative claim (furthest reset time)
        // 重新计算代表性声明（选重置时间最晚的限制类型）
        updateRepresentativeClaim()
        return
      }
    }
    // Widen to a string-valued record so dynamic key assignment is allowed.
    // MockHeaders values are string-literal unions; assigning a raw user-input
    // string requires widening, but this is mock/test code so it's acceptable.
    // 将 mockHeaders 临时宽化为 string 记录，以允许动态 key 赋值（测试代码可接受）
    const headers: Partial<Record<keyof MockHeaders, string>> = mockHeaders
    headers[fullKey] = value

    // Update retry-after if status changed
    if (key === 'status' || key === 'overage-status') {
      updateRetryAfter()
    }
  }

  // If all headers are cleared, disable mocking
  // 若所有头字段都被清空，则禁用模拟模式
  if (Object.keys(mockHeaders).length === 0) {
    mockEnabled = false
  }
}

/**
 * 根据当前限流状态更新 retry-after 头字段
 *
 * 逻辑规则：
 * - 主状态为 rejected 且（无超量状态 或 超量也被 rejected）且有 reset 时间时：
 *   计算距 reset 的剩余秒数写入 retry-after
 * - 否则删除 retry-after（有超量可用或未被拒绝时无需等待）
 */
function updateRetryAfter(): void {
  const status = mockHeaders['anthropic-ratelimit-unified-status']
  const overageStatus =
    mockHeaders['anthropic-ratelimit-unified-overage-status']
  const reset = mockHeaders['anthropic-ratelimit-unified-reset']

  if (
    status === 'rejected' &&
    (!overageStatus || overageStatus === 'rejected') &&
    reset
  ) {
    // Calculate seconds until reset
    // 计算距重置时间的剩余秒数（最小为0，不允许负数）
    const resetTimestamp = Number(reset)
    const secondsUntilReset = Math.max(
      0,
      resetTimestamp - Math.floor(Date.now() / 1000),
    )
    mockHeaders['retry-after'] = String(secondsUntilReset)
  } else {
    delete mockHeaders['retry-after']
  }
}

/**
 * 根据 exceededLimits 列表更新代表性声明（representative-claim）
 *
 * 代表性声明用于告知 UI 当前触发限流的主因：
 * - 从所有已超出的限制中选重置时间最晚的作为代表
 * - 同时更新 reset 头为该代表限制的重置时间
 * - 若主状态为 rejected 且无可用超量，还会自动更新 retry-after
 */
function updateRepresentativeClaim(): void {
  if (exceededLimits.length === 0) {
    // 无超出限制时清空代表性声明相关头字段
    delete mockHeaders['anthropic-ratelimit-unified-representative-claim']
    delete mockHeaders['anthropic-ratelimit-unified-reset']
    delete mockHeaders['retry-after']
    return
  }

  // Find the limit with the furthest reset time
  // 选重置时间最晚的限制作为代表性声明
  const furthest = exceededLimits.reduce((prev, curr) =>
    curr.resetsAt > prev.resetsAt ? curr : prev,
  )

  // Set the representative claim (appears for both warning and rejected)
  // 代表性声明在 allowed_warning 和 rejected 两种状态下都会出现
  mockHeaders['anthropic-ratelimit-unified-representative-claim'] =
    furthest.type
  mockHeaders['anthropic-ratelimit-unified-reset'] = String(furthest.resetsAt)

  // Add retry-after if rejected and no overage available
  // 主状态为 rejected 时：有可用超量则无需 retry-after；无超量则计算等待时间
  if (mockHeaders['anthropic-ratelimit-unified-status'] === 'rejected') {
    const overageStatus =
      mockHeaders['anthropic-ratelimit-unified-overage-status']
    if (!overageStatus || overageStatus === 'rejected') {
      // Calculate seconds until reset
      const secondsUntilReset = Math.max(
        0,
        furthest.resetsAt - Math.floor(Date.now() / 1000),
      )
      mockHeaders['retry-after'] = String(secondsUntilReset)
    } else {
      // Overage is available, no retry-after
      // 有可用超量，用户可继续使用，不需要 retry-after
      delete mockHeaders['retry-after']
    }
  } else {
    delete mockHeaders['retry-after']
  }
}

// Add function to add exceeded limit with custom reset time
/**
 * 添加一条自定义重置时间的超量限制记录
 *
 * 用途：比 setMockHeader('claim', ...) 更精细，支持指定任意重置时长。
 * 添加后自动将主状态设为 rejected，并重新计算代表性声明。
 *
 * @param type 限制类型（five_hour / seven_day / seven_day_opus / seven_day_sonnet）
 * @param hoursFromNow 距现在的重置小时数
 */
export function addExceededLimit(
  type: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet',
  hoursFromNow: number,
): void {
  // ANT 账户守卫
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  mockEnabled = true
  // 将小时数转换为 Unix 时间戳
  const resetsAt = Math.floor(Date.now() / 1000) + hoursFromNow * 3600

  // Remove existing limit of same type
  // 幂等操作：先删除同类型的已有记录，再添加新记录
  exceededLimits = exceededLimits.filter(l => l.type !== type)
  exceededLimits.push({ type, resetsAt })

  // Update status to rejected if we have exceeded limits
  // 有超出限制时，主状态必须为 rejected
  if (exceededLimits.length > 0) {
    mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
  }

  updateRepresentativeClaim()
}

// Set mock early warning utilization for time-relative thresholds
// claimAbbrev: '5h' or '7d'
// utilization: 0-1 (e.g., 0.92 for 92% used)
// hoursFromNow: hours until reset (default: 4 for 5h, 120 for 7d)
/**
 * 设置早期预警（Early Warning）使用率模拟数据
 *
 * 早期预警在用量接近限制时（但尚未达到）向用户发出提示。
 * 本函数设置 5h 或 7d 或 overage 维度的使用率和重置时间。
 *
 * 流程：
 * 1. 先清除所有现有早期预警头（避免 5h 优先级高于 7d 时的干扰）
 * 2. 根据 claimAbbrev 选择默认重置时长
 * 3. 设置 utilization、reset、surpassed-threshold 三个头字段
 * 4. 若 status 未设置，默认为 'allowed'（早期预警不阻断请求）
 *
 * @param claimAbbrev 维度简写：'5h'（5小时）| '7d'（7天）| 'overage'（超量）
 * @param utilization 使用率 0-1（例如 0.92 表示使用了 92%）
 * @param hoursFromNow 距重置的小时数（可选，有默认值）
 */
export function setMockEarlyWarning(
  claimAbbrev: '5h' | '7d' | 'overage',
  utilization: number,
  hoursFromNow?: number,
): void {
  // ANT 账户守卫
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  mockEnabled = true

  // Clear ALL early warning headers first (5h is checked before 7d, so we need
  // to clear 5h headers when testing 7d to avoid 5h taking priority)
  // 必须先清除全部早期预警头，避免测试 7d 时 5h 头残留导致逻辑优先级覆盖
  clearMockEarlyWarning()

  // Default hours based on claim type (early in window to trigger warning)
  // 5h 窗口：默认4小时后重置（处于窗口早期）；7d 窗口：默认5天后
  const defaultHours = claimAbbrev === '5h' ? 4 : 5 * 24
  const hours = hoursFromNow ?? defaultHours
  const resetsAt = Math.floor(Date.now() / 1000) + hours * 3600

  // 设置使用率、重置时间和已超出阈值三个头字段
  mockHeaders[`anthropic-ratelimit-unified-${claimAbbrev}-utilization`] =
    String(utilization)
  mockHeaders[`anthropic-ratelimit-unified-${claimAbbrev}-reset`] =
    String(resetsAt)
  // Set the surpassed-threshold header to trigger early warning
  // 设置 surpassed-threshold 头以触发前端早期预警逻辑
  mockHeaders[
    `anthropic-ratelimit-unified-${claimAbbrev}-surpassed-threshold`
  ] = String(utilization)

  // Set status to allowed so early warning logic can upgrade it
  // 确保主状态为 'allowed'，早期预警逻辑会在此基础上升级为 allowed_warning
  if (!mockHeaders['anthropic-ratelimit-unified-status']) {
    mockHeaders['anthropic-ratelimit-unified-status'] = 'allowed'
  }
}

/**
 * 清除所有早期预警相关头字段
 *
 * 清除 5h 和 7d 两个维度的 utilization、reset、surpassed-threshold 字段，
 * 用于在切换测试场景时避免旧数据干扰。
 */
export function clearMockEarlyWarning(): void {
  delete mockHeaders['anthropic-ratelimit-unified-5h-utilization']
  delete mockHeaders['anthropic-ratelimit-unified-5h-reset']
  delete mockHeaders['anthropic-ratelimit-unified-5h-surpassed-threshold']
  delete mockHeaders['anthropic-ratelimit-unified-7d-utilization']
  delete mockHeaders['anthropic-ratelimit-unified-7d-reset']
  delete mockHeaders['anthropic-ratelimit-unified-7d-surpassed-threshold']
}

/**
 * 按预设场景批量设置模拟限流状态
 *
 * 这是最常用的模拟入口，提供 20 种预设场景（MockScenario）：
 * - 每次调用都会先清空现有头字段（overage 相关场景除外，保留已超出的限制）
 * - 'clear' 场景：重置所有状态恢复真实限流
 * - 5小时/7天会话限额：设置 rejected 状态 + 对应 claim + reset 时间
 * - 超量系列：在主状态 rejected 基础上设置不同 overage-status
 * - 模型专属限流（opus/sonnet）：设置对应 seven_day_opus/sonnet claim
 * - 快速模式限流：设置 mockFastModeRateLimitDurationMs 而非响应头
 * - 无头 429：设置 mockHeaderless429Message 触发特殊错误路径
 *
 * @param scenario 预设场景名称（参见 MockScenario 注释）
 */
export function setMockRateLimitScenario(scenario: MockScenario): void {
  // ANT 账户守卫：非内部账户直接返回
  if (process.env.USER_TYPE !== 'ant') {
    return
  }

  // 'clear' 场景：完全重置，恢复真实限流
  if (scenario === 'clear') {
    mockHeaders = {}
    mockHeaderless429Message = null
    mockEnabled = false
    return
  }

  mockEnabled = true

  // Set reset times for demos
  // 预设两个常用重置时间基准：5小时后（会话限额）和7天后（周限额）
  const fiveHoursFromNow = Math.floor(Date.now() / 1000) + 5 * 3600
  const sevenDaysFromNow = Math.floor(Date.now() / 1000) + 7 * 24 * 3600

  // Clear existing headers
  // 每次切换场景都清空旧头字段，避免状态混用
  mockHeaders = {}
  mockHeaderless429Message = null

  // Only clear exceeded limits for scenarios that explicitly set them
  // Overage scenarios should preserve existing exceeded limits
  // overage 系列场景保留已超出的限制（避免覆盖用户通过 addExceededLimit 设置的状态）
  const preserveExceededLimits = [
    'overage-active',
    'overage-warning',
    'overage-exhausted',
  ].includes(scenario)
  if (!preserveExceededLimits) {
    exceededLimits = []
  }

  switch (scenario) {
    case 'normal':
      // 正常使用：allowed + 5小时后重置
      mockHeaders = {
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-reset': String(fiveHoursFromNow),
      }
      break

    case 'session-limit-reached':
      // 5小时会话限额耗尽：rejected + five_hour claim
      exceededLimits = [{ type: 'five_hour', resetsAt: fiveHoursFromNow }]
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      break

    case 'approaching-weekly-limit':
      // 接近7天周限额告警：allowed_warning + seven_day claim
      mockHeaders = {
        'anthropic-ratelimit-unified-status': 'allowed_warning',
        'anthropic-ratelimit-unified-reset': String(sevenDaysFromNow),
        'anthropic-ratelimit-unified-representative-claim': 'seven_day',
      }
      break

    case 'weekly-limit-reached':
      // 7天周限额耗尽：rejected + seven_day claim
      exceededLimits = [{ type: 'seven_day', resetsAt: sevenDaysFromNow }]
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      break

    case 'overage-active': {
      // If no limits have been exceeded yet, default to 5-hour
      // 若未设置超出限制，默认使用 5小时会话限额超出
      if (exceededLimits.length === 0) {
        exceededLimits = [{ type: 'five_hour', resetsAt: fiveHoursFromNow }]
      }
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      // 超量使用中：overage-status = allowed，主限额已耗尽但超量额度可用
      mockHeaders['anthropic-ratelimit-unified-overage-status'] = 'allowed'
      // Set overage reset time (monthly)
      // 超量额度按月重置，设为下月1日
      const endOfMonthActive = new Date()
      endOfMonthActive.setMonth(endOfMonthActive.getMonth() + 1, 1)
      endOfMonthActive.setHours(0, 0, 0, 0)
      mockHeaders['anthropic-ratelimit-unified-overage-reset'] = String(
        Math.floor(endOfMonthActive.getTime() / 1000),
      )
      break
    }

    case 'overage-warning': {
      // If no limits have been exceeded yet, default to 5-hour
      if (exceededLimits.length === 0) {
        exceededLimits = [{ type: 'five_hour', resetsAt: fiveHoursFromNow }]
      }
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      // 超量接近耗尽告警：overage-status = allowed_warning
      mockHeaders['anthropic-ratelimit-unified-overage-status'] =
        'allowed_warning'
      // Overage typically resets monthly, but for demo let's say end of month
      const endOfMonth = new Date()
      endOfMonth.setMonth(endOfMonth.getMonth() + 1, 1)
      endOfMonth.setHours(0, 0, 0, 0)
      mockHeaders['anthropic-ratelimit-unified-overage-reset'] = String(
        Math.floor(endOfMonth.getTime() / 1000),
      )
      break
    }

    case 'overage-exhausted': {
      // If no limits have been exceeded yet, default to 5-hour
      if (exceededLimits.length === 0) {
        exceededLimits = [{ type: 'five_hour', resetsAt: fiveHoursFromNow }]
      }
      updateRepresentativeClaim()
      // 主限额和超量额度均已耗尽
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-status'] = 'rejected'
      // Both subscription and overage are exhausted
      // Subscription resets based on the exceeded limit, overage resets monthly
      const endOfMonthExhausted = new Date()
      endOfMonthExhausted.setMonth(endOfMonthExhausted.getMonth() + 1, 1)
      endOfMonthExhausted.setHours(0, 0, 0, 0)
      mockHeaders['anthropic-ratelimit-unified-overage-reset'] = String(
        Math.floor(endOfMonthExhausted.getTime() / 1000),
      )
      break
    }

    case 'out-of-credits': {
      // Out of credits - subscription limit hit, overage rejected due to insufficient credits
      // (wallet is empty)
      // 余额为零：超量额度因钱包余额不足被禁用（disabled-reason = out_of_credits）
      if (exceededLimits.length === 0) {
        exceededLimits = [{ type: 'five_hour', resetsAt: fiveHoursFromNow }]
      }
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-disabled-reason'] =
        'out_of_credits'
      const endOfMonth = new Date()
      endOfMonth.setMonth(endOfMonth.getMonth() + 1, 1)
      endOfMonth.setHours(0, 0, 0, 0)
      mockHeaders['anthropic-ratelimit-unified-overage-reset'] = String(
        Math.floor(endOfMonth.getTime() / 1000),
      )
      break
    }

    case 'org-zero-credit-limit': {
      // Org service has zero credit limit - admin set org-level spend cap to $0
      // Non-admin Team/Enterprise users should not see "Request extra usage" option
      // 组织服务信用额度为零：管理员将组织级消费上限设为 $0，非管理员不显示"请求额外用量"选项
      if (exceededLimits.length === 0) {
        exceededLimits = [{ type: 'five_hour', resetsAt: fiveHoursFromNow }]
      }
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-disabled-reason'] =
        'org_service_zero_credit_limit'
      const endOfMonthZero = new Date()
      endOfMonthZero.setMonth(endOfMonthZero.getMonth() + 1, 1)
      endOfMonthZero.setHours(0, 0, 0, 0)
      mockHeaders['anthropic-ratelimit-unified-overage-reset'] = String(
        Math.floor(endOfMonthZero.getTime() / 1000),
      )
      break
    }

    case 'org-spend-cap-hit': {
      // Org spend cap hit for the month - org overages temporarily disabled
      // Non-admin Team/Enterprise users should not see "Request extra usage" option
      // 组织月度消费上限已触达：本月超量临时禁用（disabled-reason = org_level_disabled_until）
      if (exceededLimits.length === 0) {
        exceededLimits = [{ type: 'five_hour', resetsAt: fiveHoursFromNow }]
      }
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-disabled-reason'] =
        'org_level_disabled_until'
      const endOfMonthHit = new Date()
      endOfMonthHit.setMonth(endOfMonthHit.getMonth() + 1, 1)
      endOfMonthHit.setHours(0, 0, 0, 0)
      mockHeaders['anthropic-ratelimit-unified-overage-reset'] = String(
        Math.floor(endOfMonthHit.getTime() / 1000),
      )
      break
    }

    case 'member-zero-credit-limit': {
      // Member has zero credit limit - admin set this user's individual limit to $0
      // Non-admin Team/Enterprise users SHOULD see "Request extra usage" (admin can allocate more)
      // 成员个人额度为零：管理员可为其分配更多额度，因此仍显示"请求额外用量"选项
      if (exceededLimits.length === 0) {
        exceededLimits = [{ type: 'five_hour', resetsAt: fiveHoursFromNow }]
      }
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-disabled-reason'] =
        'member_zero_credit_limit'
      const endOfMonthMember = new Date()
      endOfMonthMember.setMonth(endOfMonthMember.getMonth() + 1, 1)
      endOfMonthMember.setHours(0, 0, 0, 0)
      mockHeaders['anthropic-ratelimit-unified-overage-reset'] = String(
        Math.floor(endOfMonthMember.getTime() / 1000),
      )
      break
    }

    case 'seat-tier-zero-credit-limit': {
      // Seat tier has zero credit limit - admin set this seat tier's limit to $0
      // Non-admin Team/Enterprise users SHOULD see "Request extra usage" (admin can allocate more)
      // 席位等级额度为零：管理员可调整，因此显示"请求额外用量"选项
      if (exceededLimits.length === 0) {
        exceededLimits = [{ type: 'five_hour', resetsAt: fiveHoursFromNow }]
      }
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-status'] = 'rejected'
      mockHeaders['anthropic-ratelimit-unified-overage-disabled-reason'] =
        'seat_tier_zero_credit_limit'
      const endOfMonthSeatTier = new Date()
      endOfMonthSeatTier.setMonth(endOfMonthSeatTier.getMonth() + 1, 1)
      endOfMonthSeatTier.setHours(0, 0, 0, 0)
      mockHeaders['anthropic-ratelimit-unified-overage-reset'] = String(
        Math.floor(endOfMonthSeatTier.getTime() / 1000),
      )
      break
    }

    case 'opus-limit': {
      // Opus 模型专属7天限额耗尽：seven_day_opus claim + rejected
      exceededLimits = [{ type: 'seven_day_opus', resetsAt: sevenDaysFromNow }]
      updateRepresentativeClaim()
      // Always send 429 rejected status - the error handler will decide whether
      // to show an error or return NO_RESPONSE_REQUESTED based on fallback eligibility
      // 始终发送 rejected 状态，错误处理器根据 fallback 可用性决定展示错误还是切换到备用模型
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      break
    }

    case 'opus-warning': {
      // Opus 模型接近7天限额告警：allowed_warning + seven_day_opus claim
      mockHeaders = {
        'anthropic-ratelimit-unified-status': 'allowed_warning',
        'anthropic-ratelimit-unified-reset': String(sevenDaysFromNow),
        'anthropic-ratelimit-unified-representative-claim': 'seven_day_opus',
      }
      break
    }

    case 'sonnet-limit': {
      // Sonnet 模型专属7天限额耗尽
      exceededLimits = [
        { type: 'seven_day_sonnet', resetsAt: sevenDaysFromNow },
      ]
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      break
    }

    case 'sonnet-warning': {
      // Sonnet 模型接近7天限额告警
      mockHeaders = {
        'anthropic-ratelimit-unified-status': 'allowed_warning',
        'anthropic-ratelimit-unified-reset': String(sevenDaysFromNow),
        'anthropic-ratelimit-unified-representative-claim': 'seven_day_sonnet',
      }
      break
    }

    case 'fast-mode-limit': {
      // 快速模式长时间限流（> 20s 阈值，会触发冷却提示）
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      // Duration in ms (> 20s threshold to trigger cooldown)
      // 10分钟冷却时长，超过 20s 阈值会在 UI 显示冷却倒计时
      mockFastModeRateLimitDurationMs = 10 * 60 * 1000
      break
    }

    case 'fast-mode-short-limit': {
      // 快速模式短时间限流（< 20s 阈值，不触发冷却提示）
      updateRepresentativeClaim()
      mockHeaders['anthropic-ratelimit-unified-status'] = 'rejected'
      // Duration in ms (< 20s threshold, won't trigger cooldown)
      // 10秒冷却时长，低于 20s 阈值不显示冷却提示
      mockFastModeRateLimitDurationMs = 10 * 1000
      break
    }

    case 'extra-usage-required': {
      // Headerless 429 — exercises the entitlement-rejection path in errors.ts
      // 无头 429：触发 errors.ts 中的权益拒绝路径（长上下文请求需要额外用量）
      mockHeaderless429Message =
        'Extra usage is required for long context requests.'
      break
    }

    default:
      break
  }
}

/**
 * 获取无头 429 的自定义错误消息
 *
 * 优先级：
 * 1. 环境变量 CLAUDE_MOCK_HEADERLESS_429（供 -p/SDK 测试使用，避免依赖斜杠命令）
 * 2. mockHeaderless429Message 模块变量
 * 若 mockEnabled 为 false 则返回 null（不激活无头 429 模拟）
 */
export function getMockHeaderless429Message(): string | null {
  // ANT 账户守卫
  if (process.env.USER_TYPE !== 'ant') {
    return null
  }
  // Env var path for -p / SDK testing where slash commands aren't available
  // 环境变量路径：供无法使用斜杠命令的场景（如 -p 标志或 SDK 集成测试）
  if (process.env.CLAUDE_MOCK_HEADERLESS_429) {
    return process.env.CLAUDE_MOCK_HEADERLESS_429
  }
  if (!mockEnabled) {
    return null
  }
  return mockHeaderless429Message
}

/**
 * 获取当前激活的模拟响应头字典
 *
 * 返回 null 条件（任一满足）：
 * - mockEnabled 为 false（未设置任何模拟）
 * - 非 ANT 账户
 * - mockHeaders 为空对象（所有头已被清除）
 *
 * @returns 模拟头字典或 null（表示使用真实 API 响应头）
 */
export function getMockHeaders(): MockHeaders | null {
  if (
    !mockEnabled ||
    process.env.USER_TYPE !== 'ant' ||
    Object.keys(mockHeaders).length === 0
  ) {
    return null
  }
  return mockHeaders
}

/**
 * 获取当前模拟状态的人类可读摘要字符串
 *
 * 用于 `/mock-status` 斜杠命令，展示当前激活的模拟头字段：
 * - 显示有效订阅类型（显式设置或默认值）
 * - 将 reset 时间戳格式化为本地时间字符串
 * - 列出所有超出限制记录及其重置时间
 *
 * @returns 格式化的状态摘要文本
 */
export function getMockStatus(): string {
  if (
    !mockEnabled ||
    (Object.keys(mockHeaders).length === 0 && !mockSubscriptionType)
  ) {
    return 'No mock headers active (using real limits)'
  }

  const lines: string[] = []
  lines.push('Active mock headers:')

  // Show subscription type - either explicitly set or default
  // 展示有效订阅类型（显式设置时注明，使用默认值时也标注）
  const effectiveSubscription =
    mockSubscriptionType || DEFAULT_MOCK_SUBSCRIPTION
  if (mockSubscriptionType) {
    lines.push(`  Subscription Type: ${mockSubscriptionType} (explicitly set)`)
  } else {
    lines.push(`  Subscription Type: ${effectiveSubscription} (default)`)
  }

  Object.entries(mockHeaders).forEach(([key, value]) => {
    if (value !== undefined) {
      // Format the header name nicely
      // 将头字段名格式化为可读形式：去前缀、连字符转空格、首字母大写
      const formattedKey = key
        .replace('anthropic-ratelimit-unified-', '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())

      // Format timestamps as human-readable
      // 对 reset 类字段同时显示 Unix 时间戳和本地时间字符串
      if (key.includes('reset') && value) {
        const timestamp = Number(value)
        const date = new Date(timestamp * 1000)
        lines.push(`  ${formattedKey}: ${value} (${date.toLocaleString()})`)
      } else {
        lines.push(`  ${formattedKey}: ${value}`)
      }
    }
  })

  // Show exceeded limits if any
  // 展示所有超出限制记录，辅助调试代表性声明计算逻辑
  if (exceededLimits.length > 0) {
    lines.push('\nExceeded limits (contributing to representative claim):')
    exceededLimits.forEach(limit => {
      const date = new Date(limit.resetsAt * 1000)
      lines.push(`  ${limit.type}: resets at ${date.toLocaleString()}`)
    })
  }

  return lines.join('\n')
}

/**
 * 清除所有模拟状态，恢复真实限流
 *
 * 重置所有模块级变量：mockHeaders、exceededLimits、mockSubscriptionType、
 * mockFastModeRateLimitDurationMs/ExpiresAt、mockHeaderless429Message，
 * 并通过 setMockBillingAccessOverride(null) 清除账单访问权限覆盖。
 */
export function clearMockHeaders(): void {
  mockHeaders = {}
  exceededLimits = []
  mockSubscriptionType = null
  mockFastModeRateLimitDurationMs = null
  mockFastModeRateLimitExpiresAt = null
  mockHeaderless429Message = null
  // 清除账单访问权限覆盖（admin/非admin 模拟）
  setMockBillingAccessOverride(null)
  mockEnabled = false
}

/**
 * 将模拟头注入到现有 Headers 对象中
 *
 * 用于在 HTTP 请求拦截层将模拟头覆盖到真实 API 响应头上。
 * 若当前无激活的模拟头，则原样返回传入的 headers 对象。
 *
 * @param headers 原始响应头对象
 * @returns 注入模拟头后的新 Headers 对象（或原始对象）
 */
export function applyMockHeaders(
  headers: globalThis.Headers,
): globalThis.Headers {
  const mock = getMockHeaders()
  // 无模拟头时直接返回原始 headers，不做任何修改
  if (!mock) {
    return headers
  }

  // Create a new Headers object with original headers
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  // 创建新 Headers 对象（复制原始头），避免直接修改传入对象
  const newHeaders = new globalThis.Headers(headers)

  // Apply mock headers (overwriting originals)
  // 将模拟头字段覆盖写入新对象（同名字段以模拟值为准）
  Object.entries(mock).forEach(([key, value]) => {
    if (value !== undefined) {
      newHeaders.set(key, value)
    }
  })

  return newHeaders
}

// Check if we should process rate limits even without subscription
// This is for Ant employees testing with mocks
/**
 * 检查是否应在无真实订阅的情况下处理限流逻辑
 *
 * Anthropic 内部员工可通过模拟头测试限流，即使没有真实订阅也应触发限流处理。
 * 两种激活方式：模块内 mockEnabled 标志，或环境变量 CLAUDE_MOCK_HEADERLESS_429。
 */
export function shouldProcessMockLimits(): boolean {
  // 非 ANT 账户始终不处理模拟限流
  if (process.env.USER_TYPE !== 'ant') {
    return false
  }
  return mockEnabled || Boolean(process.env.CLAUDE_MOCK_HEADERLESS_429)
}

/**
 * 从当前模拟头状态反向推断当前激活的场景
 *
 * 通过检查 status、overage、claim 三个关键头字段，
 * 反向匹配最接近的预设场景。用于 `/mock-status` 命令的场景显示。
 * 若无激活模拟或无法匹配，则返回 null。
 */
export function getCurrentMockScenario(): MockScenario | null {
  // 未激活模拟时返回 null
  if (!mockEnabled) {
    return null
  }

  // Reverse lookup the scenario from current headers
  if (!mockHeaders) return null

  const status = mockHeaders['anthropic-ratelimit-unified-status']
  const overage = mockHeaders['anthropic-ratelimit-unified-overage-status']
  const claim = mockHeaders['anthropic-ratelimit-unified-representative-claim']

  // 模型专属限流优先判断（opus/sonnet 有自己的声明类型）
  if (claim === 'seven_day_opus') {
    return status === 'rejected' ? 'opus-limit' : 'opus-warning'
  }

  if (claim === 'seven_day_sonnet') {
    return status === 'rejected' ? 'sonnet-limit' : 'sonnet-warning'
  }

  // 超量状态判断（overage 优先于主状态细分）
  if (overage === 'rejected') return 'overage-exhausted'
  if (overage === 'allowed_warning') return 'overage-warning'
  if (overage === 'allowed') return 'overage-active'

  // 主状态 rejected 细分
  if (status === 'rejected') {
    if (claim === 'five_hour') return 'session-limit-reached'
    if (claim === 'seven_day') return 'weekly-limit-reached'
  }

  if (status === 'allowed_warning') {
    if (claim === 'seven_day') return 'approaching-weekly-limit'
  }

  if (status === 'allowed') return 'normal'

  return null
}

/**
 * 获取预设场景的人类可读描述文本
 *
 * 用于 `/mock-scenarios` 斜杠命令，展示各场景的简要说明。
 *
 * @param scenario 场景名称
 * @returns 该场景的中文/英文描述字符串
 */
export function getScenarioDescription(scenario: MockScenario): string {
  switch (scenario) {
    case 'normal':
      return 'Normal usage, no limits'
    case 'session-limit-reached':
      return 'Session rate limit exceeded'
    case 'approaching-weekly-limit':
      return 'Approaching weekly aggregate limit'
    case 'weekly-limit-reached':
      return 'Weekly aggregate limit exceeded'
    case 'overage-active':
      return 'Using extra usage (overage active)'
    case 'overage-warning':
      return 'Approaching extra usage limit'
    case 'overage-exhausted':
      return 'Both subscription and extra usage limits exhausted'
    case 'out-of-credits':
      return 'Out of extra usage credits (wallet empty)'
    case 'org-zero-credit-limit':
      return 'Org spend cap is zero (no extra usage budget)'
    case 'org-spend-cap-hit':
      return 'Org spend cap hit for the month'
    case 'member-zero-credit-limit':
      return 'Member limit is zero (admin can allocate more)'
    case 'seat-tier-zero-credit-limit':
      return 'Seat tier limit is zero (admin can allocate more)'
    case 'opus-limit':
      return 'Opus limit reached'
    case 'opus-warning':
      return 'Approaching Opus limit'
    case 'sonnet-limit':
      return 'Sonnet limit reached'
    case 'sonnet-warning':
      return 'Approaching Sonnet limit'
    case 'fast-mode-limit':
      return 'Fast mode rate limit'
    case 'fast-mode-short-limit':
      return 'Fast mode rate limit (short)'
    case 'extra-usage-required':
      return 'Headerless 429: Extra usage required for 1M context'
    case 'clear':
      return 'Clear mock headers (use real limits)'
    default:
      return 'Unknown scenario'
  }
}

// Mock subscription type management
/**
 * 设置模拟订阅类型
 *
 * 用于测试不同订阅等级（max/pro/free 等）的 UI 展示差异。
 * 传入 null 会在 getMockSubscriptionType 中回退到 DEFAULT_MOCK_SUBSCRIPTION。
 *
 * @param subscriptionType 要模拟的订阅类型；null 表示使用默认值
 */
export function setMockSubscriptionType(
  subscriptionType: SubscriptionType | null,
): void {
  // ANT 账户守卫
  if (process.env.USER_TYPE !== 'ant') {
    return
  }
  mockEnabled = true
  mockSubscriptionType = subscriptionType
}

/**
 * 获取当前有效的模拟订阅类型
 *
 * 逻辑：显式设置的类型优先；未设置时回退到 DEFAULT_MOCK_SUBSCRIPTION（'max'）。
 * 若模拟未激活或非 ANT 账户，返回 null（使用真实订阅类型）。
 */
export function getMockSubscriptionType(): SubscriptionType | null {
  if (!mockEnabled || process.env.USER_TYPE !== 'ant') {
    return null
  }
  // Return the explicitly set subscription type, or default to 'max'
  // 未显式设置时回退到 DEFAULT_MOCK_SUBSCRIPTION = 'max'
  return mockSubscriptionType || DEFAULT_MOCK_SUBSCRIPTION
}

// Export a function that checks if we should use mock subscription
/**
 * 检查是否应使用模拟订阅类型（而非真实订阅）
 *
 * 仅在三个条件同时满足时返回 true：
 * 1. 模拟已激活（mockEnabled）
 * 2. 显式设置了订阅类型（mockSubscriptionType !== null）
 * 3. 当前为 ANT 账户
 */
export function shouldUseMockSubscription(): boolean {
  return (
    mockEnabled &&
    mockSubscriptionType !== null &&
    process.env.USER_TYPE === 'ant'
  )
}

// Mock billing access (admin vs non-admin)
/**
 * 设置模拟账单访问权限（管理员 vs 非管理员）
 *
 * 通过 setMockBillingAccessOverride 覆盖真实的账单权限检查，
 * 用于测试管理员独有 UI 元素（如超量配置入口）的显示/隐藏逻辑。
 *
 * @param hasAccess true = 模拟管理员权限；false = 模拟非管理员；null = 清除覆盖
 */
export function setMockBillingAccess(hasAccess: boolean | null): void {
  if (process.env.USER_TYPE !== 'ant') {
    return
  }
  mockEnabled = true
  setMockBillingAccessOverride(hasAccess)
}

// Mock fast mode rate limit handling
/**
 * 检查当前是否处于快速模式限流场景
 *
 * 仅根据 mockFastModeRateLimitDurationMs 判断，
 * 不区分长时间（10min）和短时间（10s）两种场景。
 */
export function isMockFastModeRateLimitScenario(): boolean {
  return mockFastModeRateLimitDurationMs !== null
}

/**
 * 检查快速模式限流状态并返回动态响应头
 *
 * 逻辑流程：
 * 1. 若未设置快速模式限流场景（mockFastModeRateLimitDurationMs = null），返回 null
 * 2. 若快速模式未激活（isFastModeActive = false），返回 null（只在快速模式下触发）
 * 3. 若限流已到期（当前时间 >= expiresAt），清除模拟并返回 null
 * 4. 首次触发时延迟赋值 mockFastModeRateLimitExpiresAt（从此时开始计时）
 * 5. 计算动态 retry-after（基于剩余毫秒数），注入到头字段后返回
 *
 * @param isFastModeActive 当前是否处于快速模式（由调用方传入）
 * @returns 含动态 retry-after 的模拟头字典，或 null（不触发限流）
 */
export function checkMockFastModeRateLimit(
  isFastModeActive?: boolean,
): MockHeaders | null {
  // 未激活快速模式限流场景
  if (mockFastModeRateLimitDurationMs === null) {
    return null
  }

  // Only throw when fast mode is active
  // 仅在快速模式激活时触发限流，普通模式下跳过
  if (!isFastModeActive) {
    return null
  }

  // Check if the rate limit has expired
  // 检查限流是否已到期（首次未设置时跳过此检查）
  if (
    mockFastModeRateLimitExpiresAt !== null &&
    Date.now() >= mockFastModeRateLimitExpiresAt
  ) {
    // 到期后自动清除所有模拟状态
    clearMockHeaders()
    return null
  }

  // Set expiry on first error (not when scenario is configured)
  // 延迟赋值：在首次真正触发错误时才开始计时（而非场景配置时）
  if (mockFastModeRateLimitExpiresAt === null) {
    mockFastModeRateLimitExpiresAt =
      Date.now() + mockFastModeRateLimitDurationMs
  }

  // Compute dynamic retry-after based on remaining time
  // 基于剩余时间动态计算 retry-after 秒数（最小为1秒，避免为零）
  const remainingMs = mockFastModeRateLimitExpiresAt - Date.now()
  const headersToSend = { ...mockHeaders }
  headersToSend['retry-after'] = String(
    Math.max(1, Math.ceil(remainingMs / 1000)),
  )

  return headersToSend
}
