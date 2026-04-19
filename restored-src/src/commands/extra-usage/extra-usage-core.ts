/**
 * extra-usage 命令核心逻辑模块（extra-usage-core.ts）
 *
 * 本文件包含 /extra-usage 命令的核心业务逻辑，同时被交互式（extra-usage.jsx）
 * 和非交互式（extra-usage-noninteractive.ts）两个适配层共用。
 *
 * "Extra Usage"（超额用量）是 Claude.ai 的一项付费增值功能：
 * 当用户的订阅配额耗尽后，可通过额外付费继续使用。
 * 本模块根据用户的订阅类型和计费权限，走不同的处理路径：
 *
 * 路径 A：Team/Enterprise 订阅 + 无直接计费权限（非管理员成员）
 *   → 查询当前 overage 状态 → 检查申请资格 → 检查重复申请 → 创建管理员申请
 *   → 返回文本消息（管理员审批流程）
 *
 * 路径 B：个人订阅 或 Team/Enterprise 管理员（有计费权限）
 *   → 直接打开浏览器跳转至 claude.ai 的用量管理页面
 *   → 返回 browser-opened 结果（由调用层展示跳转状态）
 *
 * 流程位置：用户触发 /extra-usage → interactive/noninteractive 适配层调用 runExtraUsage()
 *           → 返回 ExtraUsageResult → 适配层将结果渲染为用户可见的反馈
 */
import {
  checkAdminRequestEligibility,
  createAdminRequest,
  getMyAdminRequests,
} from '../../services/api/adminRequests.js'
import { invalidateOverageCreditGrantCache } from '../../services/api/overageCreditGrant.js'
import { type ExtraUsage, fetchUtilization } from '../../services/api/usage.js'
import { getSubscriptionType } from '../../utils/auth.js'
import { hasClaudeAiBillingAccess } from '../../utils/billing.js'
import { openBrowser } from '../../utils/browser.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logError } from '../../utils/log.js'

/**
 * runExtraUsage 的返回类型
 *
 * - `message`：返回纯文本消息，供适配层直接展示给用户
 * - `browser-opened`：表示已尝试打开浏览器，携带 URL 和是否成功打开的状态
 */
type ExtraUsageResult =
  | { type: 'message'; value: string }
  | { type: 'browser-opened'; url: string; opened: boolean }

/**
 * /extra-usage 命令的核心执行逻辑
 *
 * 按以下步骤处理：
 * 1. 标记用户已访问过 extra-usage 页面（用于引导流程）
 * 2. 使 overage credit grant 缓存失效，确保后续读取到最新授权状态
 * 3. 根据订阅类型和计费权限选择路径 A 或路径 B
 *
 * 路径 A（Team/Enterprise 非管理员）的多级降级策略：
 *   - 若已是无限额度 → 直接提示无需申请
 *   - 若无申请资格 → 提示联系管理员
 *   - 若已有待处理/已驳回的申请 → 提示已申请
 *   - 否则 → 创建新的 limit_increase 申请
 *   - 任何步骤失败 → 降级到下一步或通用提示
 */
export async function runExtraUsage(): Promise<ExtraUsageResult> {
  // 首次访问时记录标志，供引导流程（onboarding）判断是否已看过此页面
  if (!getGlobalConfig().hasVisitedExtraUsage) {
    saveGlobalConfig(prev => ({ ...prev, hasVisitedExtraUsage: true }))
  }
  // 单独失效 overage credit grant 缓存：用户可能多次运行 /extra-usage
  // 来跟进申请流程，每次都需要获取最新的授权状态，不能依赖缓存
  invalidateOverageCreditGrantCache()

  const subscriptionType = getSubscriptionType()
  // Team 和 Enterprise 用户有管理员审批流程，个人用户直接走计费设置
  const isTeamOrEnterprise =
    subscriptionType === 'team' || subscriptionType === 'enterprise'
  // 判断当前用户是否有直接操作计费的权限（管理员或个人账号）
  const hasBillingAccess = hasClaudeAiBillingAccess()

  if (!hasBillingAccess && isTeamOrEnterprise) {
    // 路径 A：Team/Enterprise 普通成员（无计费权限），走管理员申请流程

    // 查询当前组织的 overage 配置，对标 web 端 useHasUnlimitedOverage() 的逻辑：
    // 若已启用且无月度上限（unlimited），则无需申请，直接提示
    // 若查询失败，err toward show——宁可让用户继续尝试申请
    let extraUsage: ExtraUsage | null | undefined
    try {
      const utilization = await fetchUtilization()
      extraUsage = utilization?.extra_usage
    } catch (error) {
      logError(error as Error)
      // 查询失败时静默跳过，继续后续流程
    }

    if (extraUsage?.is_enabled && extraUsage.monthly_limit === null) {
      // 组织已启用无限额度，不需要提交申请
      return {
        type: 'message',
        value:
          'Your organization already has unlimited extra usage. No request needed.',
      }
    }

    try {
      const eligibility = await checkAdminRequestEligibility('limit_increase')
      if (eligibility?.is_allowed === false) {
        // 不具备申请资格（如已被组织策略禁止），引导用户联系管理员
        return {
          type: 'message',
          value: 'Please contact your admin to manage extra usage settings.',
        }
      }
    } catch (error) {
      logError(error as Error)
      // 资格检查失败时继续，由后端 create 接口兜底校验
    }

    try {
      // 检查是否已有处于 pending 或 dismissed 状态的历史申请，避免重复提交
      const pendingOrDismissedRequests = await getMyAdminRequests(
        'limit_increase',
        ['pending', 'dismissed'],
      )
      if (pendingOrDismissedRequests && pendingOrDismissedRequests.length > 0) {
        return {
          type: 'message',
          value:
            'You have already submitted a request for extra usage to your admin.',
        }
      }
    } catch (error) {
      logError(error as Error)
      // 查询历史申请失败时继续，尝试创建新申请（后端会防重）
    }

    try {
      // 创建新的 limit_increase 管理员申请
      await createAdminRequest({
        request_type: 'limit_increase',
        details: null,
      })
      return {
        type: 'message',
        // 根据 overage 当前状态选择不同措辞：已启用但有上限 vs 尚未启用
        value: extraUsage?.is_enabled
          ? 'Request sent to your admin to increase extra usage.'
          : 'Request sent to your admin to enable extra usage.',
      }
    } catch (error) {
      logError(error as Error)
      // 创建申请失败时降级到通用提示
    }

    // 所有 API 调用均失败时的最终兜底提示
    return {
      type: 'message',
      value: 'Please contact your admin to manage extra usage settings.',
    }
  }

  // 路径 B：个人用户 或 Team/Enterprise 管理员 → 直接跳转至计费设置页面
  // Team/Enterprise 使用管理员设置页；个人用户使用个人设置页
  const url = isTeamOrEnterprise
    ? 'https://claude.ai/admin-settings/usage'
    : 'https://claude.ai/settings/usage'

  try {
    const opened = await openBrowser(url)
    // 返回打开结果，调用层据此决定是否显示"请手动访问"的 fallback 提示
    return { type: 'browser-opened', url, opened }
  } catch (error) {
    logError(error as Error)
    // 浏览器打开失败时，降级为文本提示，引导用户手动访问 URL
    return {
      type: 'message',
      value: `Failed to open browser. Please visit ${url} to manage extra usage.`,
    }
  }
}
