/**
 * 超额信用授权（Overage Credit Grant）缓存模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   用户达到配额限制时 → UI 展示超额用量提示 → 调用 getCachedOverageCreditGrant() 获取授权信息
 *   → 缓存为空则触发 refreshOverageCreditGrantCache() 后台拉取
 *
 * 主要功能：
 *  - getCachedOverageCreditGrant         — 同步读取缓存的授权信息（过期则返回 null）
 *  - invalidateOverageCreditGrantCache   — 使当前组织的缓存条目失效
 *  - refreshOverageCreditGrantCache      — 异步拉取并写入缓存（fire-and-forget）
 *  - formatGrantAmount                   — 将 minor_units 格式化为可读金额字符串
 *
 * 缓存设计：
 *  - 缓存 TTL：1 小时（CACHE_TTL_MS）
 *  - 按组织 UUID（orgId）分隔缓存条目，多组织账号互不干扰
 *  - 写入时使用 saveGlobalConfig 的锁机制，从 prev 读取最新值（乐观并发控制）
 *  - 若数据未变且时间戳仍新鲜，跳过写入（避免频繁磁盘 IO）
 */

import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logError } from '../../utils/log.js'
import { isEssentialTrafficOnly } from '../../utils/privacyLevel.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'

/** 超额信用授权信息结构 */
export type OverageCreditGrantInfo = {
  available: boolean         // 授权功能是否对该账号可用
  eligible: boolean          // 账号是否有资格申请授权
  granted: boolean           // 授权是否已被领取
  amount_minor_units: number | null // 授权金额（最小货币单位，如美分），null 表示不适用
  currency: string | null    // 货币类型（如 'USD'），null 表示不适用
}

/** 磁盘缓存条目结构：包含授权信息和写入时间戳 */
type CachedGrantEntry = {
  info: OverageCreditGrantInfo
  timestamp: number // 写入时间（Unix ms）
}

// 缓存有效期：1 小时
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

/**
 * 从后端获取当前用户的超额信用授权资格信息（内部函数）。
 *
 * 后端负责解析特定席位等级的金额和基于角色的领取权限，
 * 客户端仅读取响应结果，无需复制该逻辑。
 *
 * @returns 授权信息，API 调用失败时返回 null
 */
async function fetchOverageCreditGrant(): Promise<OverageCreditGrantInfo | null> {
  try {
    // 准备 OAuth 认证信息（访问令牌 + 组织 UUID）
    const { accessToken, orgUUID } = await prepareApiRequest()
    const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/overage_credit_grant`
    const response = await axios.get<OverageCreditGrantInfo>(url, {
      headers: getOAuthHeaders(accessToken), // OAuth Bearer 认证头
    })
    return response.data
  } catch (err) {
    logError(err) // 记录错误，静默失败（不影响 UI 渲染）
    return null
  }
}

/**
 * 同步读取当前组织的超额信用授权缓存信息。
 *
 * 缓存为空或已过期时返回 null，调用方应以非阻塞方式处理
 * （不展示相关 UI，同时触发后台刷新）。
 *
 * @returns 缓存中的授权信息，无缓存或过期则返回 null
 */
export function getCachedOverageCreditGrant(): OverageCreditGrantInfo | null {
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return null // 未登录或无组织信息
  const cached = getGlobalConfig().overageCreditGrantCache?.[orgId]
  if (!cached) return null  // 无缓存条目
  if (Date.now() - cached.timestamp > CACHE_TTL_MS) return null // 缓存已过期
  return cached.info
}

/**
 * 使当前组织的超额信用授权缓存失效。
 *
 * 仅删除当前组织的缓存条目，其他组织的缓存保持不变。
 * 常见触发场景：用户刚领取了授权，需要立即刷新状态。
 */
export function invalidateOverageCreditGrantCache(): void {
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return
  const cache = getGlobalConfig().overageCreditGrantCache
  if (!cache || !(orgId in cache)) return // 缓存不存在，无需操作
  // 从全局配置中删除该组织的缓存条目（保留其他组织的数据）
  saveGlobalConfig(prev => {
    const next = { ...prev.overageCreditGrantCache }
    delete next[orgId]
    return { ...prev, overageCreditGrantCache: next }
  })
}

/**
 * 拉取并缓存超额信用授权信息（供 upsell UI 组件挂载时触发）。
 *
 * 使用场景：
 *  - UI 组件即将渲染且缓存为空时，以 fire-and-forget 模式调用
 *  - 调用方不等待此函数完成
 *
 * 写入优化（乐观并发控制）：
 *  - 从 saveGlobalConfig 的 prev 参数（加锁后最新值）读取当前缓存
 *  - 若数据未变且时间戳仍新鲜，跳过写入（避免频繁磁盘 IO 和并发写冲突）
 *  - 数据未变但时间戳过期时：仅更新时间戳，不替换 info 对象（保持引用不变）
 */
export async function refreshOverageCreditGrantCache(): Promise<void> {
  if (isEssentialTrafficOnly()) return // 仅基础流量模式下不发起 API 请求
  const orgId = getOauthAccountInfo()?.organizationUuid
  if (!orgId) return // 未登录或无组织信息
  const info = await fetchOverageCreditGrant()
  if (!info) return // API 失败，不更新缓存
  // Skip rewriting info if grant data is unchanged — avoids config write
  // amplification (inc-4552 pattern). Still refresh the timestamp so the
  // TTL-based staleness check in getCachedOverageCreditGrant doesn't keep
  // re-triggering API calls on every component mount.
  saveGlobalConfig(prev => {
    // Derive from prev (lock-fresh) rather than a pre-lock getGlobalConfig()
    // read — saveConfigWithLock re-reads config from disk under the file lock,
    // so another CLI instance may have written between any outer read and lock
    // acquire.
    // 从 prev（加锁后的最新磁盘值）读取缓存，避免并发写入导致的脏读
    const prevCached = prev.overageCreditGrantCache?.[orgId]
    const existing = prevCached?.info
    // 逐字段比较，判断数据是否真的发生了变化
    const dataUnchanged =
      existing &&
      existing.available === info.available &&
      existing.eligible === info.eligible &&
      existing.granted === info.granted &&
      existing.amount_minor_units === info.amount_minor_units &&
      existing.currency === info.currency
    // When data is unchanged and timestamp is still fresh, skip the write entirely
    // 数据未变且时间戳仍在有效期内：完全跳过写入
    if (
      dataUnchanged &&
      prevCached &&
      Date.now() - prevCached.timestamp <= CACHE_TTL_MS
    ) {
      return prev // 返回 prev 表示不修改配置
    }
    // 构造新缓存条目：数据未变时复用原 info 对象（避免不必要的对象创建），更新时间戳
    const entry: CachedGrantEntry = {
      info: dataUnchanged ? existing : info,
      timestamp: Date.now(),
    }
    return {
      ...prev,
      overageCreditGrantCache: {
        ...prev.overageCreditGrantCache,
        [orgId]: entry, // 仅更新当前组织的缓存条目
      },
    }
  })
}

/**
 * 将授权金额格式化为可读字符串（如 "$5" 或 "$5.50"）。
 *
 * 当前支持的货币：USD（后端未来可能扩展）。
 * 金额为整数时省略小数点（如 "$5"），否则保留两位小数（如 "$5.50"）。
 *
 * @param info - 超额信用授权信息
 * @returns 格式化后的金额字符串，不适用时返回 null
 */
export function formatGrantAmount(info: OverageCreditGrantInfo): string | null {
  if (info.amount_minor_units == null || !info.currency) return null // 金额或货币未设置
  // For now only USD; backend may expand later
  if (info.currency.toUpperCase() === 'USD') {
    const dollars = info.amount_minor_units / 100 // 美分转美元
    // 整数金额不显示小数（如 $5），非整数保留两位（如 $5.50）
    return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
  }
  return null // 不支持的货币类型
}

// 导出缓存条目类型（供外部类型声明使用）
export type { CachedGrantEntry as OverageCreditGrantCacheEntry }
