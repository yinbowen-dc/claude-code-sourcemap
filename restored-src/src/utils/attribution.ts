/**
 * 代码归属（Attribution）文本生成模块。
 *
 * 在 Claude Code 系统中，该模块负责为 git commit 和 Pull Request 生成
 * 包含 Claude 贡献信息的归属文本。
 *
 * 主要功能：
 * 1. getAttributionTexts()：根据用户设置返回 commit 和 PR 的归属文本，
 *    处理自定义设置、远程模式（返回 Session URL）及旧版设置兼容
 * 2. getEnhancedPRAttribution()：生成包含 Claude 贡献百分比、N-shot 次数
 *    和内存访问次数的增强版 PR 归属文本
 * 3. countUserPromptsInMessages()：统计消息列表中用户实际输入的提示数量
 *    （排除工具结果块、终端输出和旁链消息）
 */
import { feature } from 'bun:bundle'
import { stat } from 'fs/promises'
import { getClientType } from '../bootstrap/state.js'
import {
  getRemoteSessionUrl,
  isRemoteSessionLocal,
  PRODUCT_URL,
} from '../constants/product.js'
import { TERMINAL_OUTPUT_TAGS } from '../constants/xml.js'
import type { AppState } from '../state/AppState.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import type { Entry } from '../types/logs.js'
import {
  type AttributionData,
  calculateCommitAttribution,
  isInternalModelRepo,
  isInternalModelRepoCached,
  sanitizeModelName,
} from './commitAttribution.js'
import { logForDebugging } from './debug.js'
import { parseJSONL } from './json.js'
import { logError } from './log.js'
import {
  getCanonicalName,
  getMainLoopModel,
  getPublicModelDisplayName,
  getPublicModelName,
} from './model/model.js'
import { isMemoryFileAccess } from './sessionFileAccessHooks.js'
import { getTranscriptPath } from './sessionStorage.js'
import { readTranscriptForLoad } from './sessionStoragePortable.js'
import { getInitialSettings } from './settings/settings.js'
import { isUndercover } from './undercover.js'

export type AttributionTexts = {
  commit: string
  pr: string
}

/**
 * 根据用户设置返回 commit 和 PR 的归属文本。
 * 处理：动态模型名、自定义归属设置、远程模式（返回 Session URL）
 * 以及旧版 includeCoAuthoredBy 设置的向后兼容。
 *
 * Returns attribution text for commits and PRs based on user settings.
 */
export function getAttributionTexts(): AttributionTexts {
  if (process.env.USER_TYPE === 'ant' && isUndercover()) {
    return { commit: '', pr: '' }
  }

  if (getClientType() === 'remote') {
    const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
    if (remoteSessionId) {
      const ingressUrl = process.env.SESSION_INGRESS_URL
      // Skip for local dev - URLs won't persist
      if (!isRemoteSessionLocal(remoteSessionId, ingressUrl)) {
        const sessionUrl = getRemoteSessionUrl(remoteSessionId, ingressUrl)
        return { commit: sessionUrl, pr: sessionUrl }
      }
    }
    return { commit: '', pr: '' }
  }

  // @[MODEL LAUNCH]: Update the hardcoded fallback model name below (guards against codename leaks).
  // For internal repos, use the real model name. For external repos,
  // fall back to "Claude Opus 4.6" for unrecognized models to avoid leaking codenames.
  const model = getMainLoopModel()
  const isKnownPublicModel = getPublicModelDisplayName(model) !== null
  const modelName =
    isInternalModelRepoCached() || isKnownPublicModel
      ? getPublicModelName(model)
      : 'Claude Opus 4.6'
  const defaultAttribution = `🤖 Generated with [Claude Code](${PRODUCT_URL})`
  const defaultCommit = `Co-Authored-By: ${modelName} <noreply@anthropic.com>`

  const settings = getInitialSettings()

  // New attribution setting takes precedence over deprecated includeCoAuthoredBy
  if (settings.attribution) {
    return {
      commit: settings.attribution.commit ?? defaultCommit,
      pr: settings.attribution.pr ?? defaultAttribution,
    }
  }

  // Backward compatibility: deprecated includeCoAuthoredBy setting
  if (settings.includeCoAuthoredBy === false) {
    return { commit: '', pr: '' }
  }

  return { commit: defaultCommit, pr: defaultAttribution }
}

/**
 * 判断消息内容字符串是否为终端输出（而非用户提示）。
 * 通过检查是否包含终端输出 XML 标签来判断。
 */
function isTerminalOutput(content: string): boolean {
  for (const tag of TERMINAL_OUTPUT_TAGS) {
    if (content.includes(`<${tag}>`)) {
      return true
    }
  }
  return false
}

/**
 * 统计消息列表中用户实际输入的提示数量。
 * 排除工具结果块、终端输出及空消息。调用方应传入已过滤旁链消息的列表。
 *
 * Count user messages with visible text content in a list of non-sidechain messages.
 */
export function countUserPromptsInMessages(
  messages: ReadonlyArray<{ type: string; message?: { content?: unknown } }>,
): number {
  let count = 0

  for (const message of messages) {
    if (message.type !== 'user') {
      continue
    }

    const content = message.message?.content
    if (!content) {
      continue
    }

    let hasUserText = false

    if (typeof content === 'string') {
      if (isTerminalOutput(content)) {
        continue
      }
      hasUserText = content.trim().length > 0
    } else if (Array.isArray(content)) {
      hasUserText = content.some(block => {
        if (!block || typeof block !== 'object' || !('type' in block)) {
          return false
        }
        return (
          (block.type === 'text' &&
            typeof block.text === 'string' &&
            !isTerminalOutput(block.text)) ||
          block.type === 'image' ||
          block.type === 'document'
        )
      })
    }

    if (hasUserText) {
      count++
    }
  }

  return count
}

/**
 * 统计 transcript 条目中非旁链用户消息中的用户提示数量。
 * 用于计算"steers"数（用户提示数 - 1）。
 */
function countUserPromptsFromEntries(entries: ReadonlyArray<Entry>): number {
  const nonSidechain = entries.filter(
    entry =>
      entry.type === 'user' && !('isSidechain' in entry && entry.isSidechain),
  )
  return countUserPromptsInMessages(nonSidechain)
}

/**
 * 从 AppState 的归属状态中获取完整的归属数据。
 * 使用所有追踪文件（而非仅暂存文件）以支持 PR 归属（文件可能尚未暂存）。
 * 无归属数据时返回 null。
 */
async function getPRAttributionData(
  appState: AppState,
): Promise<AttributionData | null> {
  const attribution = appState.attribution

  if (!attribution) {
    return null
  }

  // Handle both Map and plain object (in case of serialization)
  const fileStates = attribution.fileStates
  const isMap = fileStates instanceof Map
  const trackedFiles = isMap
    ? Array.from(fileStates.keys())
    : Object.keys(fileStates)

  if (trackedFiles.length === 0) {
    return null
  }

  try {
    return await calculateCommitAttribution([attribution], trackedFiles)
  } catch (error) {
    logError(error as Error)
    return null
  }
}

const MEMORY_ACCESS_TOOL_NAMES = new Set([
  FILE_READ_TOOL_NAME,
  GREP_TOOL_NAME,
  GLOB_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
])

/**
 * 统计 transcript 条目中对内存文件的访问次数。
 * 使用与 PostToolUse session 文件访问钩子相同的检测条件。
 */
function countMemoryFileAccessFromEntries(
  entries: ReadonlyArray<Entry>,
): number {
  let count = 0
  for (const entry of entries) {
    if (entry.type !== 'assistant') continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        block.type !== 'tool_use' ||
        !MEMORY_ACCESS_TOOL_NAMES.has(block.name)
      )
        continue
      if (isMemoryFileAccess(block.name, block.input)) count++
    }
  }
  return count
}

/**
 * 读取会话 transcript 条目并统计提示数和内存访问数。
 * 仅统计最后一次压缩边界（compact_boundary）之后的条目，
 * 反映当前对话弧而非历史累计数据。
 */
async function getTranscriptStats(): Promise<{
  promptCount: number
  memoryAccessCount: number
}> {
  try {
    const filePath = getTranscriptPath()
    const fileSize = (await stat(filePath)).size
    // Fused reader: attr-snap lines (84% of a long session by bytes) are
    // skipped at the fd level so peak scales with output, not file size. The
    // one surviving attr-snap at EOF is a no-op for the count functions
    // (neither checks type === 'attribution-snapshot'). When the last
    // boundary has preservedSegment the reader returns full (no truncate);
    // the findLastIndex below still slices to post-boundary.
    const scan = await readTranscriptForLoad(filePath, fileSize)
    const buf = scan.postBoundaryBuf
    const entries = parseJSONL<Entry>(buf)
    const lastBoundaryIdx = entries.findLastIndex(
      e =>
        e.type === 'system' &&
        'subtype' in e &&
        e.subtype === 'compact_boundary',
    )
    const postBoundary =
      lastBoundaryIdx >= 0 ? entries.slice(lastBoundaryIdx + 1) : entries
    return {
      promptCount: countUserPromptsFromEntries(postBoundary),
      memoryAccessCount: countMemoryFileAccessFromEntries(postBoundary),
    }
  } catch {
    return { promptCount: 0, memoryAccessCount: 0 }
  }
}

/**
 * 生成包含 Claude 贡献统计的增强版 PR 归属文本。
 * 格式示例："🤖 Generated with Claude Code (93% 3-shotted by claude-opus-4-5, 2 memories recalled)"
 * 规则：显示 Claude 贡献百分比、N-shot 数、短模型名称及内存访问次数。
 * 若无法计算统计数据则返回默认归属文本。
 *
 * Get enhanced PR attribution text with Claude contribution stats.
 */
export async function getEnhancedPRAttribution(
  getAppState: () => AppState,
): Promise<string> {
  if (process.env.USER_TYPE === 'ant' && isUndercover()) {
    return ''
  }

  if (getClientType() === 'remote') {
    const remoteSessionId = process.env.CLAUDE_CODE_REMOTE_SESSION_ID
    if (remoteSessionId) {
      const ingressUrl = process.env.SESSION_INGRESS_URL
      // Skip for local dev - URLs won't persist
      if (!isRemoteSessionLocal(remoteSessionId, ingressUrl)) {
        return getRemoteSessionUrl(remoteSessionId, ingressUrl)
      }
    }
    return ''
  }

  const settings = getInitialSettings()

  // If user has custom PR attribution, use that
  if (settings.attribution?.pr) {
    return settings.attribution.pr
  }

  // Backward compatibility: deprecated includeCoAuthoredBy setting
  if (settings.includeCoAuthoredBy === false) {
    return ''
  }

  const defaultAttribution = `🤖 Generated with [Claude Code](${PRODUCT_URL})`

  // Get AppState first
  const appState = getAppState()

  logForDebugging(
    `PR Attribution: appState.attribution exists: ${!!appState.attribution}`,
  )
  if (appState.attribution) {
    const fileStates = appState.attribution.fileStates
    const isMap = fileStates instanceof Map
    const fileCount = isMap ? fileStates.size : Object.keys(fileStates).length
    logForDebugging(`PR Attribution: fileStates count: ${fileCount}`)
  }

  // Get attribution stats (transcript is read once for both prompt count and memory access)
  const [attributionData, { promptCount, memoryAccessCount }, isInternal] =
    await Promise.all([
      getPRAttributionData(appState),
      getTranscriptStats(),
      isInternalModelRepo(),
    ])

  const claudePercent = attributionData?.summary.claudePercent ?? 0

  logForDebugging(
    `PR Attribution: claudePercent: ${claudePercent}, promptCount: ${promptCount}, memoryAccessCount: ${memoryAccessCount}`,
  )

  // Get short model name, sanitized for non-internal repos
  const rawModelName = getCanonicalName(getMainLoopModel())
  const shortModelName = isInternal
    ? rawModelName
    : sanitizeModelName(rawModelName)

  // If no attribution data, return default
  if (claudePercent === 0 && promptCount === 0 && memoryAccessCount === 0) {
    logForDebugging('PR Attribution: returning default (no data)')
    return defaultAttribution
  }

  // Build the enhanced attribution: "🤖 Generated with Claude Code (93% 3-shotted by claude-opus-4-5, 2 memories recalled)"
  const memSuffix =
    memoryAccessCount > 0
      ? `, ${memoryAccessCount} ${memoryAccessCount === 1 ? 'memory' : 'memories'} recalled`
      : ''
  const summary = `🤖 Generated with [Claude Code](${PRODUCT_URL}) (${claudePercent}% ${promptCount}-shotted by ${shortModelName}${memSuffix})`

  // Append trailer lines for squash-merge survival. Only for allowlisted repos
  // (INTERNAL_MODEL_REPOS) and only in builds with COMMIT_ATTRIBUTION enabled —
  // attributionTrailer.ts contains excluded strings, so reach it via dynamic
  // import behind feature(). When the repo is configured with
  // squash_merge_commit_message=PR_BODY (cli, apps), the PR body becomes the
  // squash commit body verbatim — trailer lines at the end become proper git
  // trailers on the squash commit.
  if (feature('COMMIT_ATTRIBUTION') && isInternal && attributionData) {
    const { buildPRTrailers } = await import('./attributionTrailer.js')
    const trailers = buildPRTrailers(attributionData, appState.attribution)
    const result = `${summary}\n\n${trailers.join('\n')}`
    logForDebugging(`PR Attribution: returning with trailers: ${result}`)
    return result
  }

  logForDebugging(`PR Attribution: returning summary: ${summary}`)
  return summary
}
