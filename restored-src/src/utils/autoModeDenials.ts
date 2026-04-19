/**
 * Auto 模式拒绝记录模块。
 *
 * 在 Claude Code 系统中，该模块追踪被 Auto 模式分类器最近拒绝的命令列表，
 * 供 /permissions 页面的 RecentDenialsTab 展示。
 * 由 useCanUseTool.ts 写入，最多保留最近 20 条记录。
 *
 * Tracks commands recently denied by the auto mode classifier.
 */

import { feature } from 'bun:bundle'

export type AutoModeDenial = {
  toolName: string
  /** Human-readable description of the denied command (e.g. bash command string) */
  display: string
  reason: string
  timestamp: number
}

let DENIALS: readonly AutoModeDenial[] = []
const MAX_DENIALS = 20

/** 记录一条 Auto 模式拒绝事件（最多保留 20 条，超出时丢弃最旧条目）。仅在 TRANSCRIPT_CLASSIFIER 功能开启时生效。 */
export function recordAutoModeDenial(denial: AutoModeDenial): void {
  if (!feature('TRANSCRIPT_CLASSIFIER')) return
  DENIALS = [denial, ...DENIALS.slice(0, MAX_DENIALS - 1)]
}

/** 返回当前内存中的所有 Auto 模式拒绝记录。 */
export function getAutoModeDenials(): readonly AutoModeDenial[] {
  return DENIALS
}
