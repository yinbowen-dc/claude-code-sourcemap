/**
 * logoV2Utils.ts — LogoV2 启动画面工具模块
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于工具层（utils），是 Claude Code 启动画面（LogoV2 组件）的
 * 数据处理和布局计算中心。LogoV2 是 Claude Code 启动时显示的顶部面板，
 * 展示版本信息、当前目录、账单类型、近期会话和发布说明等内容。
 *
 * 本模块将 UI 逻辑与数据处理解耦，所有计算密集型操作（路径截断、宽度计算、
 * 布局尺寸推导、数据预加载等）均在此实现，使 React 组件保持轻量。
 *
 * 【主要功能】
 * 1. getLayoutMode/calculateLayoutDimensions — 根据终端宽度决定水平/紧凑布局及尺寸；
 * 2. calculateOptimalLeftWidth              — 基于内容宽度推算左侧面板最优宽度；
 * 3. formatWelcomeMessage                  — 格式化欢迎消息（含长度限制）；
 * 4. truncatePath                          — 智能路径截断（保留首尾部分，中间用省略号）；
 * 5. getRecentActivity/Sync                — 异步/同步获取近期会话列表（带缓存）；
 * 6. formatReleaseNoteForDisplay           — 格式化发布说明（截断至最大宽度）；
 * 7. getLogoDisplayData                    — 获取 Logo 展示所需的核心数据；
 * 8. formatModelAndBilling                 — 智能格式化模型名和账单信息（自动换行）；
 * 9. getRecentReleaseNotesSync             — 同步获取近期发布说明（内外用户来源不同）。
 */

import { getDirectConnectServerUrl, getSessionId } from '../bootstrap/state.js'
import { stringWidth } from '../ink/stringWidth.js'
import type { LogOption } from '../types/logs.js'
import { getSubscriptionName, isClaudeAISubscriber } from './auth.js'
import { getCwd } from './cwd.js'
import { getDisplayPath } from './file.js'
import {
  truncate,
  truncateToWidth,
  truncateToWidthNoEllipsis,
} from './format.js'
import { getStoredChangelogFromMemory, parseChangelog } from './releaseNotes.js'
import { gt } from './semver.js'
import { loadMessageLogs } from './sessionStorage.js'
import { getInitialSettings } from './settings/settings.js'

// ── 布局常量 ──────────────────────────────────────────────────────────────

/** 左侧面板最大宽度（字符列数）。 */
const MAX_LEFT_WIDTH = 50
/** 用户名最大显示长度，超出则显示通用欢迎语。 */
const MAX_USERNAME_LENGTH = 20
/** 边框和外边距占用的宽度（左右各 2 列，共 4 列）。 */
const BORDER_PADDING = 4
/** 分隔线宽度（1 列）。 */
const DIVIDER_WIDTH = 1
/** 内容区域内边距（2 列）。 */
const CONTENT_PADDING = 2

/**
 * 布局模式：水平（左右双栏）或紧凑（单栏，垂直堆叠）。
 * - 'horizontal'：终端宽度 ≥ 70 列时使用，左侧显示 CLAWD ASCII 艺术和状态信息，
 *                右侧显示近期会话和发布说明；
 * - 'compact'：终端较窄时使用，所有内容垂直堆叠。
 */
export type LayoutMode = 'horizontal' | 'compact'

/**
 * 布局尺寸计算结果，供 LogoV2 组件使用。
 */
export type LayoutDimensions = {
  leftWidth: number   // 左侧面板宽度（字符列数）
  rightWidth: number  // 右侧面板宽度（字符列数）
  totalWidth: number  // 总宽度（字符列数）
}

/**
 * 根据终端宽度决定布局模式。
 * 宽度 ≥ 70 列时使用水平双栏布局，否则使用紧凑单栏布局。
 */
export function getLayoutMode(columns: number): LayoutMode {
  if (columns >= 70) return 'horizontal'
  return 'compact'
}

/**
 * 根据终端宽度、布局模式和最优左栏宽度，计算具体的布局尺寸。
 *
 * 水平模式：
 *   右栏宽度 = 终端宽度 - 边框 - 内边距 - 分隔线 - 左栏宽度；
 *   若总宽度超出终端，则按比例缩小右栏，确保不溢出。
 *
 * 紧凑模式：
 *   左右栏同宽，总宽度取终端宽度和最大宽度（MAX_LEFT_WIDTH + 20）的较小值。
 */
export function calculateLayoutDimensions(
  columns: number,
  layoutMode: LayoutMode,
  optimalLeftWidth: number,
): LayoutDimensions {
  if (layoutMode === 'horizontal') {
    const leftWidth = optimalLeftWidth
    // 计算右栏可用宽度：终端宽度减去已用空间
    const usedSpace =
      BORDER_PADDING + CONTENT_PADDING + DIVIDER_WIDTH + leftWidth
    const availableForRight = columns - usedSpace

    let rightWidth = Math.max(30, availableForRight)  // 右栏最小 30 列
    const totalWidth = Math.min(
      leftWidth + rightWidth + DIVIDER_WIDTH + CONTENT_PADDING,
      columns - BORDER_PADDING,  // 总宽度不超过终端可用区域
    )

    // 若总宽度被限制，按比例缩小右栏
    if (totalWidth < leftWidth + rightWidth + DIVIDER_WIDTH + CONTENT_PADDING) {
      rightWidth = totalWidth - leftWidth - DIVIDER_WIDTH - CONTENT_PADDING
    }

    return { leftWidth, rightWidth, totalWidth }
  }

  // 紧凑模式：左右同宽
  const totalWidth = Math.min(columns - BORDER_PADDING, MAX_LEFT_WIDTH + 20)
  return {
    leftWidth: totalWidth,
    rightWidth: totalWidth,
    totalWidth,
  }
}

/**
 * 基于左侧面板实际内容的视觉宽度推算最优左栏宽度。
 * 取欢迎消息、当前目录和模型行三者中最宽的一项，
 * 加 4 列内边距，并不超过 MAX_LEFT_WIDTH。
 *
 * @param welcomeMessage - 格式化后的欢迎消息
 * @param truncatedCwd   - 已截断的工作目录路径
 * @param modelLine      - 模型名称行文本
 * @returns 最优左栏宽度（列数）
 */
export function calculateOptimalLeftWidth(
  welcomeMessage: string,
  truncatedCwd: string,
  modelLine: string,
): number {
  const contentWidth = Math.max(
    stringWidth(welcomeMessage),
    stringWidth(truncatedCwd),
    stringWidth(modelLine),
    20,  // 最小宽度（确保 CLAWD ASCII 艺术可以完整显示）
  )
  return Math.min(contentWidth + 4, MAX_LEFT_WIDTH)  // +4 列内边距
}

/**
 * 根据用户名格式化欢迎消息。
 * 若用户名超过最大长度或为空，显示通用欢迎语；
 * 否则在欢迎语中包含用户名。
 */
export function formatWelcomeMessage(username: string | null): string {
  if (!username || username.length > MAX_USERNAME_LENGTH) {
    return 'Welcome back!'
  }
  return `Welcome back ${username}!`
}

/**
 * 中间截断路径：若路径超过最大宽度，保留首尾部分，中间用省略号（…）替代。
 * 宽度感知：使用 stringWidth() 正确处理 CJK 字符（占 2 列）和 emoji。
 *
 * 截断策略（按优先级）：
 *   1. 若路径未超长，原样返回；
 *   2. 单段路径（无 /），直接从末尾截断；
 *   3. Unix 根路径（first 为空）且末段已填满，仅显示 "/" + 截断末段；
 *   4. 有首段且末段已填满，显示 "…/" + 截断末段；
 *   5. 仅两段，截断首段 + "…/" + 末段；
 *   6. 多段：逐步移除中间部分，尽量保留更多中间路径段。
 */
export function truncatePath(path: string, maxLength: number): string {
  if (stringWidth(path) <= maxLength) return path  // 无需截断

  const separator = '/'
  const ellipsis = '…'
  const ellipsisWidth = 1   // '…' 固定为 1 列宽
  const separatorWidth = 1  // '/' 固定为 1 列宽

  const parts = path.split(separator)
  const first = parts[0] || ''
  const last = parts[parts.length - 1] || ''
  const firstWidth = stringWidth(first)
  const lastWidth = stringWidth(last)

  // 情况 1：单段路径（无分隔符），直接截断
  if (parts.length === 1) {
    return truncateToWidth(path, maxLength)
  }

  // 情况 2：Unix 根路径（first 为空），末段本身就超长
  if (first === '' && ellipsisWidth + separatorWidth + lastWidth >= maxLength) {
    return `${separator}${truncateToWidth(last, Math.max(1, maxLength - separatorWidth))}`
  }

  // 情况 3：有首段，末段超长，截断末段（显示 "…/截断末段"）
  if (
    first !== '' &&
    ellipsisWidth * 2 + separatorWidth + lastWidth >= maxLength
  ) {
    return `${ellipsis}${separator}${truncateToWidth(last, Math.max(1, maxLength - ellipsisWidth - separatorWidth))}`
  }

  // 情况 4：仅两段，截断首段（保留末段完整）
  if (parts.length === 2) {
    const availableForFirst =
      maxLength - ellipsisWidth - separatorWidth - lastWidth
    return `${truncateToWidthNoEllipsis(first, availableForFirst)}${ellipsis}${separator}${last}`
  }

  // 情况 5+：多段路径，尝试移除中间部分
  let available =
    maxLength - firstWidth - lastWidth - ellipsisWidth - 2 * separatorWidth

  // 首尾两段已超出限制，截断首段
  if (available <= 0) {
    const availableForFirst = Math.max(
      0,
      maxLength - lastWidth - ellipsisWidth - 2 * separatorWidth,
    )
    const truncatedFirst = truncateToWidthNoEllipsis(first, availableForFirst)
    return `${truncatedFirst}${separator}${ellipsis}${separator}${last}`
  }

  // 从右到左尽量保留更多中间路径段（贪心算法）
  const middleParts = []
  for (let i = parts.length - 2; i > 0; i--) {
    const part = parts[i]
    if (part && stringWidth(part) + separatorWidth <= available) {
      middleParts.unshift(part)
      available -= stringWidth(part) + separatorWidth
    } else {
      break  // 剩余空间不足，停止添加中间段
    }
  }

  if (middleParts.length === 0) {
    // 没有中间段能放下，显示 "首/…/尾"
    return `${first}${separator}${ellipsis}${separator}${last}`
  }

  return `${first}${separator}${ellipsis}${separator}${middleParts.join(separator)}${separator}${last}`
}

// ── 近期活动缓存 ──────────────────────────────────────────────────────────

/** 已加载的近期会话缓存（供同步访问）。 */
let cachedActivity: LogOption[] = []
/** 正在进行的加载 Promise（防止并发重复请求）。 */
let cachePromise: Promise<LogOption[]> | null = null

/**
 * 异步获取近期会话列表（供 Logo v2 展示最近 3 条）。
 * 若已有加载 Promise（缓存命中），直接返回；否则触发加载。
 *
 * 过滤规则：
 *   - 排除 sidechain 会话（辅助流）；
 *   - 排除当前会话（正在进行中）；
 *   - 排除摘要中含 "I apologize" 的错误会话；
 *   - 要求至少有 summary 或 firstPrompt（非 "No prompt"）。
 *
 * @returns 最多 3 条近期有效会话
 */
export async function getRecentActivity(): Promise<LogOption[]> {
  // 已有 Promise 时复用，避免并发触发多次文件系统读取
  if (cachePromise) {
    return cachePromise
  }

  const currentSessionId = getSessionId()
  cachePromise = loadMessageLogs(10)
    .then(logs => {
      cachedActivity = logs
        .filter(log => {
          if (log.isSidechain) return false              // 排除辅助流
          if (log.sessionId === currentSessionId) return false  // 排除当前会话
          if (log.summary?.includes('I apologize')) return false  // 排除错误会话

          // 要求有实质性的摘要或首条提示（非占位符文本）
          const hasSummary = log.summary && log.summary !== 'No prompt'
          const hasFirstPrompt =
            log.firstPrompt && log.firstPrompt !== 'No prompt'
          return hasSummary || hasFirstPrompt
        })
        .slice(0, 3)  // 仅保留最近 3 条
      return cachedActivity
    })
    .catch(() => {
      cachedActivity = []
      return cachedActivity
    })

  return cachePromise
}

/**
 * 同步获取近期会话缓存（仅返回已加载的结果，若尚未加载则返回空数组）。
 * 适用于 Ink 组件的同步渲染路径。
 */
export function getRecentActivitySync(): LogOption[] {
  return cachedActivity
}

/**
 * 格式化发布说明以供显示，若超出最大宽度则截断。
 *
 * @param note     - 原始发布说明文本
 * @param maxWidth - 允许的最大显示宽度（列数）
 * @returns 截断后的文本
 */
export function formatReleaseNoteForDisplay(
  note: string,
  maxWidth: number,
): string {
  // 使用 truncate 函数，与"近期活动"描述的截断逻辑保持一致
  return truncate(note, maxWidth)
}

/**
 * 获取 LogoV2 和 CondensedLogo 两个组件共用的展示数据。
 *
 * 数据来源：
 *   - version：环境变量 DEMO_VERSION（演示模式）或编译时宏 MACRO.VERSION；
 *   - cwd：当前工作目录（Direct Connect 模式下拼接服务器地址）；
 *   - billingType：订阅用户显示订阅名称，API 用户显示 "API Usage Billing"；
 *   - agentName：初始设置中的代理名称（可能为 undefined）。
 */
export function getLogoDisplayData(): {
  version: string
  cwd: string
  billingType: string
  agentName: string | undefined
} {
  const version = process.env.DEMO_VERSION ?? MACRO.VERSION
  const serverUrl = getDirectConnectServerUrl()
  const displayPath = process.env.DEMO_VERSION
    ? '/code/claude'                // 演示模式使用固定路径
    : getDisplayPath(getCwd())      // 正常模式使用实际路径
  // Direct Connect 模式下，在路径后拼接服务器地址
  const cwd = serverUrl
    ? `${displayPath} in ${serverUrl.replace(/^https?:\/\//, '')}`
    : displayPath
  const billingType = isClaudeAISubscriber()
    ? getSubscriptionName()
    : 'API Usage Billing'
  const agentName = getInitialSettings().agent

  return {
    version,
    cwd,
    billingType,
    agentName,
  }
}

/**
 * 根据可用宽度决定模型名和账单信息的展示方式。
 *
 * 若合并显示（"模型名 · 账单类型"）超过可用宽度，则分两行显示并分别截断；
 * 否则合并显示，在剩余空间中截断模型名（账单信息优先完整显示）。
 *
 * @param modelName      - 模型名称字符串
 * @param billingType    - 账单类型字符串
 * @param availableWidth - 可用的显示宽度（列数）
 * @returns 是否分行、截断后的模型名和账单类型
 */
export function formatModelAndBilling(
  modelName: string,
  billingType: string,
  availableWidth: number,
): {
  shouldSplit: boolean
  truncatedModel: string
  truncatedBilling: string
} {
  const separator = ' · '
  // 计算合并后的总视觉宽度
  const combinedWidth =
    stringWidth(modelName) + separator.length + stringWidth(billingType)
  const shouldSplit = combinedWidth > availableWidth

  if (shouldSplit) {
    // 分行显示：各自截断至可用宽度
    return {
      shouldSplit: true,
      truncatedModel: truncate(modelName, availableWidth),
      truncatedBilling: truncate(billingType, availableWidth),
    }
  }

  // 合并显示：账单信息完整展示，模型名在剩余空间中截断（最少保留 10 列）
  return {
    shouldSplit: false,
    truncatedModel: truncate(
      modelName,
      Math.max(
        availableWidth - stringWidth(billingType) - separator.length,
        10,
      ),
    ),
    truncatedBilling: billingType,
  }
}

/**
 * 同步获取近期发布说明（供 LogoV2 组件使用）。
 *
 * 来源区分：
 *   - 内部 ant 用户：使用编译时打包的 MACRO.VERSION_CHANGELOG（git commit 日志）；
 *   - 外部用户：使用存储在内存中的公开 changelog 文件，解析后取最近 3 个版本的说明。
 *
 * @param maxItems - 最多返回的发布说明条数
 * @returns 发布说明字符串数组（原始文本，不做预截断）
 */
export function getRecentReleaseNotesSync(maxItems: number): string[] {
  if (process.env.USER_TYPE === 'ant') {
    // 内部用户：使用编译时打包的 changelog（git commit 格式）
    const changelog = MACRO.VERSION_CHANGELOG
    if (changelog) {
      const commits = changelog.trim().split('\n').filter(Boolean)
      return commits.slice(0, maxItems)
    }
    return []
  }

  // 外部用户：从内存中读取已缓存的公开 changelog
  const changelog = getStoredChangelogFromMemory()
  if (!changelog) {
    return []
  }

  let parsed
  try {
    parsed = parseChangelog(changelog)
  } catch {
    return []
  }

  // 取最近 3 个版本的发布说明并合并
  const allNotes: string[] = []
  const versions = Object.keys(parsed)
    .sort((a, b) => (gt(a, b) ? -1 : 1))  // 按语义版本降序排列
    .slice(0, 3)                            // 仅取最近 3 个版本

  for (const version of versions) {
    const notes = parsed[version]
    if (notes) {
      allNotes.push(...notes)
    }
  }

  // 返回原始说明，不在此处截断（由调用方决定显示宽度）
  return allNotes.slice(0, maxItems)
}
