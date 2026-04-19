/**
 * useDiffData.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 位于 UI 层的 hooks 目录下，属于 Git Diff 数据管理模块。
 * 在 Claude Code 的代码差异展示组件（如 diff 视图、文件变更统计面板）中使用，
 * 负责在组件挂载时一次性拉取当前工作区的 git diff 数据，
 * 并将原始数据转换为 UI 可直接使用的结构化格式。
 *
 * 【主要功能】
 * - 并发获取 git diff 统计信息（stats）和分块差异（hunks）
 * - 将原始 perFileStats 数据转换为包含是否为大文件、是否截断、是否为二进制等标记的 DiffFile 数组
 * - 按文件路径字母顺序排序，提供一致的展示顺序
 * - 支持取消（cancelled 标志），防止组件卸载后更新状态
 */

import type { StructuredPatchHunk } from 'diff'
import { useEffect, useMemo, useState } from 'react'
import {
  fetchGitDiff,
  fetchGitDiffHunks,
  type GitDiffResult,
  type GitDiffStats,
} from '../utils/gitDiff.js'

// 单个文件展示的最大行数限制，超过则标记为截断（isTruncated）
const MAX_LINES_PER_FILE = 400

/** 单个文件的差异信息，用于 UI 展示 */
export type DiffFile = {
  path: string          // 文件路径
  linesAdded: number    // 新增行数
  linesRemoved: number  // 删除行数
  isBinary: boolean     // 是否为二进制文件
  isLargeFile: boolean  // 是否为超大文件（无法解析 hunks）
  isTruncated: boolean  // 是否因超出行数限制而被截断展示
  isNewFile?: boolean   // 是否为新建文件
  isUntracked?: boolean // 是否为未跟踪文件
}

/** useDiffData 的完整返回类型 */
export type DiffData = {
  stats: GitDiffStats | null                  // 整体 diff 统计（总增删行数等）
  files: DiffFile[]                           // 各文件差异信息列表
  hunks: Map<string, StructuredPatchHunk[]>   // 各文件的结构化 patch 分块（按路径索引）
  loading: boolean                            // 是否仍在加载中
}

/**
 * Hook to fetch current git diff data on demand.
 * Fetches both stats and hunks when component mounts.
 *
 * 【功能说明】
 * 组件挂载时并发请求 git diff 统计与分块数据，并将其整合为结构化的 DiffData：
 * 1. 使用 Promise.all 并发拉取 stats 和 hunks，减少总等待时间
 * 2. 遍历 perFileStats，为每个文件计算 isLargeFile、isTruncated 等标记
 * 3. 使用 useMemo 缓存计算结果，避免不必要的重复计算
 * 4. 支持组件卸载时取消状态更新（cancelled 标志），防止内存泄漏
 *
 * @returns DiffData 对象，包含统计信息、文件列表、分块数据和加载状态
 */
export function useDiffData(): DiffData {
  // 存储从 fetchGitDiff 获取的原始 diff 结果（含 stats 和 perFileStats）
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null)
  // 存储从 fetchGitDiffHunks 获取的各文件结构化 patch 分块，以文件路径为 key
  const [hunks, setHunks] = useState<Map<string, StructuredPatchHunk[]>>(
    new Map(),
  )
  // 是否正在加载数据，初始为 true
  const [loading, setLoading] = useState(true)

  // Fetch diff data on mount
  // 组件挂载时触发一次数据加载
  useEffect(() => {
    // 用于在组件卸载时取消异步回调的标志
    let cancelled = false

    async function loadDiffData() {
      try {
        // Fetch both stats and hunks
        // 并发拉取 diff 统计信息和 patch 分块数据，提升加载效率
        const [statsResult, hunksResult] = await Promise.all([
          fetchGitDiff(),
          fetchGitDiffHunks(),
        ])

        // 若组件已卸载，则放弃状态更新
        if (!cancelled) {
          setDiffResult(statsResult)
          setHunks(hunksResult)
          setLoading(false)
        }
      } catch (_error) {
        // 加载失败时将数据重置为空，并结束 loading 状态
        if (!cancelled) {
          setDiffResult(null)
          setHunks(new Map())
          setLoading(false)
        }
      }
    }

    // 触发异步数据加载（void 表示有意忽略 Promise 返回值）
    void loadDiffData()

    // 清理函数：组件卸载时设置 cancelled，防止异步回调更新已卸载组件的状态
    return () => {
      cancelled = true
    }
  }, [])

  // 使用 useMemo 缓存对 diffResult 和 hunks 的处理结果，
  // 仅在 diffResult、hunks 或 loading 发生变化时重新计算
  return useMemo(() => {
    // 若尚未获取到数据，返回空的初始状态
    if (!diffResult) {
      return { stats: null, files: [], hunks: new Map(), loading }
    }

    const { stats, perFileStats } = diffResult
    const files: DiffFile[] = []

    // Iterate over perFileStats to get all files including large/skipped ones
    // 遍历每个文件的统计信息，构建 UI 需要的 DiffFile 对象
    for (const [path, fileStats] of perFileStats) {
      // 从 hunks Map 中查找该文件对应的 patch 分块
      const fileHunks = hunks.get(path)
      // 是否为未跟踪文件，默认 false
      const isUntracked = fileStats.isUntracked ?? false

      // Detect large file (in perFileStats but not in hunks, and not binary/untracked)
      // 大文件判断：在统计中存在但 hunks 中不存在，且非二进制、非未跟踪
      const isLargeFile = !fileStats.isBinary && !isUntracked && !fileHunks

      // Detect truncated file (total > limit means we truncated)
      // 截断判断：总变更行数超过单文件最大行数限制，且非大文件、非二进制
      const totalLines = fileStats.added + fileStats.removed
      const isTruncated =
        !isLargeFile && !fileStats.isBinary && totalLines > MAX_LINES_PER_FILE

      // 将计算后的文件信息加入结果数组
      files.push({
        path,
        linesAdded: fileStats.added,
        linesRemoved: fileStats.removed,
        isBinary: fileStats.isBinary,
        isLargeFile,
        isTruncated,
        isUntracked,
      })
    }

    // 按文件路径字母顺序排序，确保展示顺序一致
    files.sort((a, b) => a.path.localeCompare(b.path))

    // 返回完整的 DiffData，loading 固定为 false（数据已加载完成）
    return { stats, files, hunks, loading: false }
  }, [diffResult, hunks, loading])
}
