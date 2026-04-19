/**
 * bridgeStatusUtil.ts — Bridge 状态显示工具函数集合
 *
 * 在 Claude Code 系统流程中的位置：
 *   Bridge UI 渲染层（bridgeUI.ts / bridge.tsx）
 *     └─> bridgeStatusUtil.ts（本文件）——提供状态栏/底栏渲染所需的纯计算函数
 *           ├─ 时间戳与持续时间格式化
 *           ├─ Bridge 连接 URL 构建（idle 状态 / 会话激活状态）
 *           ├─ 状态标签和颜色推导（StatusState → BridgeStatusInfo）
 *           ├─ Shimmer 动画计算（光晕效果的字符分段）
 *           └─ OSC 8 终端超链接包装
 *
 * 设计原则：
 *   本文件中所有函数均为纯函数，不持有状态，便于在 CLI（chalk）和
 *   React/Ink（bridge.tsx）两个渲染上下文中复用。
 *   Shimmer 分段计算（computeShimmerSegments）使用字素分割（grapheme segmentation）
 *   和 stringWidth 处理多字节字符、Emoji 和 CJK 字形，确保光标定位正确。
 */
import {
  getClaudeAiBaseUrl,
  getRemoteSessionUrl,
} from '../constants/product.js'
import { stringWidth } from '../ink/stringWidth.js'
import { formatDuration, truncateToWidth } from '../utils/format.js'
import { getGraphemeSegmenter } from '../utils/intl.js'

/**
 * Bridge 连接状态机的状态枚举。
 *
 *   idle        — Bridge 已注册但无用户连接（等待 claude.ai 扫码连接）；
 *   attached    — 用户已连接（WebSocket 建立），会话尚未有标题；
 *   titled      — 会话有了用户消息（标题已设置）；
 *   reconnecting— 连接中断，正在重试；
 *   failed      — 连接失败（不可恢复，需要用户干预）。
 *
 * Bridge status state machine states.
 */
export type StatusState =
  | 'idle'
  | 'attached'
  | 'titled'
  | 'reconnecting'
  | 'failed'

/** 工具活动行在最后一次 tool_start 后的可见时长（毫秒） */
/** How long a tool activity line stays visible after last tool_start (ms). */
export const TOOL_DISPLAY_EXPIRY_MS = 30_000

/** Shimmer 光晕动画的每帧间隔（毫秒） */
/** Interval for the shimmer animation tick (ms). */
export const SHIMMER_INTERVAL_MS = 150

/**
 * 返回当前本地时间的 HH:MM:SS 格式字符串，用于调试日志和状态栏显示。
 */
export function timestamp(): string {
  const now = new Date()
  const h = String(now.getHours()).padStart(2, '0')
  const m = String(now.getMinutes()).padStart(2, '0')
  const s = String(now.getSeconds()).padStart(2, '0')
  return `${h}:${m}:${s}`
}

export { formatDuration, truncateToWidth as truncatePrompt }

/**
 * 截断工具活动摘要文本，使其不超过 30 个视觉列宽（用于状态栏显示）。
 * Abbreviate a tool activity summary for the trail display.
 */
export function abbreviateActivity(summary: string): string {
  return truncateToWidth(summary, 30)
}

/**
 * 构建 Bridge 空闲状态（等待连接）时显示的 URL。
 * 格式：{claudeAiBaseUrl}/code?bridge={environmentId}
 *
 * Build the connect URL shown when the bridge is idle.
 */
export function buildBridgeConnectUrl(
  environmentId: string,
  ingressUrl?: string,
): string {
  const baseUrl = getClaudeAiBaseUrl(undefined, ingressUrl)
  return `${baseUrl}/code?bridge=${environmentId}`
}

/**
 * 构建会话激活时显示的会话 URL。
 *
 * 委托给 getRemoteSessionUrl 处理 cse_→session_ 前缀转换，
 * 然后追加 v1 特定的 ?bridge={environmentId} 查询参数。
 *
 * Build the session URL shown when a session is attached. Delegates to
 * getRemoteSessionUrl for the cse_→session_ prefix translation, then appends
 * the v1-specific ?bridge={environmentId} query.
 */
export function buildBridgeSessionUrl(
  sessionId: string,
  environmentId: string,
  ingressUrl?: string,
): string {
  return `${getRemoteSessionUrl(sessionId, ingressUrl)}?bridge=${environmentId}`
}

/**
 * 计算反向扫描 Shimmer 动画的当前高亮列（光晕索引）。
 *
 * 动画以 messageWidth + 20 为周期循环，高亮点从右向左移动，
 * 超出文本范围时光晕在屏幕外（不可见）。
 *
 * Compute the glimmer index for a reverse-sweep shimmer animation.
 */
export function computeGlimmerIndex(
  tick: number,
  messageWidth: number,
): number {
  const cycleLength = messageWidth + 20
  return messageWidth + 10 - (tick % cycleLength)
}

/**
 * 将文本按视觉列位置拆分为三段，用于 Shimmer 光晕渲染。
 *
 * 使用字素分割（grapheme segmentation）和 stringWidth 确保多字节字符、
 * Emoji 和 CJK 字形的视觉列位置计算正确。
 *
 * 返回 { before, shimmer, after } 三段字符串；
 * chalk（bridgeUI.ts）和 React/Ink（bridge.tsx）两个渲染器各自对这些段着色。
 *
 * Split text into three segments by visual column position for shimmer rendering.
 *
 * Uses grapheme segmentation and `stringWidth` so the split is correct for
 * multi-byte characters, emoji, and CJK glyphs.
 *
 * Returns `{ before, shimmer, after }` strings. Both renderers (chalk in
 * bridgeUI.ts and React/Ink in bridge.tsx) apply their own coloring to
 * these segments.
 */
export function computeShimmerSegments(
  text: string,
  glimmerIndex: number,
): { before: string; shimmer: string; after: string } {
  const messageWidth = stringWidth(text)
  const shimmerStart = glimmerIndex - 1
  const shimmerEnd = glimmerIndex + 1

  // 光晕超出文本范围，返回全部文本作为 before 段（不可见）
  // When shimmer is offscreen, return all text as "before"
  if (shimmerStart >= messageWidth || shimmerEnd < 0) {
    return { before: text, shimmer: '', after: '' }
  }

  // 按视觉列位置拆分为至多 3 段
  // Split into at most 3 segments by visual column position
  const clampedStart = Math.max(0, shimmerStart)
  let colPos = 0
  let before = ''
  let shimmer = ''
  let after = ''
  for (const { segment } of getGraphemeSegmenter().segment(text)) {
    const segWidth = stringWidth(segment)
    if (colPos + segWidth <= clampedStart) {
      before += segment          // 光晕左侧
    } else if (colPos > shimmerEnd) {
      after += segment           // 光晕右侧
    } else {
      shimmer += segment         // 光晕高亮区域
    }
    colPos += segWidth
  }

  return { before, shimmer, after }
}

/**
 * Bridge 状态标签和颜色的计算结果类型。
 * 由 getBridgeStatus 根据连接状态推导，用于状态栏渲染。
 *
 * Computed bridge status label and color from connection state.
 */
export type BridgeStatusInfo = {
  label:
    | 'Remote Control failed'
    | 'Remote Control reconnecting'
    | 'Remote Control active'
    | 'Remote Control connecting\u2026'
  color: 'error' | 'warning' | 'success'
}

/**
 * 根据 Bridge 连接状态推导状态标签和颜色。
 *
 * 优先级：error > reconnecting > active（sessionActive || connected）> connecting
 *
 * Derive a status label and color from the bridge connection state.
 */
export function getBridgeStatus({
  error,
  connected,
  sessionActive,
  reconnecting,
}: {
  error: string | undefined
  connected: boolean
  sessionActive: boolean
  reconnecting: boolean
}): BridgeStatusInfo {
  if (error) return { label: 'Remote Control failed', color: 'error' }
  if (reconnecting)
    return { label: 'Remote Control reconnecting', color: 'warning' }
  if (sessionActive || connected)
    return { label: 'Remote Control active', color: 'success' }
  return { label: 'Remote Control connecting\u2026', color: 'warning' }
}

/** Bridge 空闲（Ready）状态时底栏显示的文本 */
/** Footer text shown when bridge is idle (Ready state). */
export function buildIdleFooterText(url: string): string {
  return `Code everywhere with the Claude app or ${url}`
}

/** Bridge 会话激活（Connected）状态时底栏显示的文本 */
/** Footer text shown when a session is active (Connected state). */
export function buildActiveFooterText(url: string): string {
  return `Continue coding in the Claude app or ${url}`
}

/** Bridge 失败状态时底栏显示的固定文本 */
/** Footer text shown when the bridge has failed. */
export const FAILED_FOOTER_TEXT = 'Something went wrong, please try again'

/**
 * 将文本包装在 OSC 8 终端超链接转义序列中，使终端中的文本可点击跳转。
 *
 * 视觉宽度为零（布局计算不受影响）。
 * strip-ansi（stringWidth 的依赖）能正确剥离 OSC 8 序列，
 * 确保 bridgeUI.ts 中的 countVisualLines 保持准确。
 *
 * Wrap text in an OSC 8 terminal hyperlink. Zero visual width for layout purposes.
 * strip-ansi (used by stringWidth) correctly strips these sequences, so
 * countVisualLines in bridgeUI.ts remains accurate.
 */
export function wrapWithOsc8Link(text: string, url: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`
}
