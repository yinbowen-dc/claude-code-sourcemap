/**
 * 【CCR 种子包（Seed Bundle）创建与上传模块】
 *
 * 在 Claude Code 系统流程中的位置：
 *   用户触发 Web Session（CCR/Teleport）
 *     → 本模块将本地 Git 仓库打包为 bundle 文件，上传到 Files API
 *     → 上传成功后返回 file_id，由调用方写入 SessionContext.seed_bundle_file_id
 *     → 远端 CCR 环境启动时读取该 file_id，解包仓库，还原用户的代码工作区
 *
 * 完整流程（五步）：
 *   1. git stash create           → 生成一个"悬空提交"保存未提交的改动（WIP）
 *   2. update-ref refs/seed/stash → 使 stash 提交可被 --all 抓取
 *   3. git bundle create --all    → 打包所有引用（含 stash）为 .bundle 文件
 *      （超大时降级：仅打 HEAD → 再降级：squash 成单提交）
 *   4. uploadFile()               → 上传 bundle 到 /v1/files
 *   5. 清理 refs/seed/stash 等临时引用，删除本地临时文件
 *
 * 注意：仅追踪文件（tracked）的未提交改动会被捕获；未追踪文件不包含在内。
 */

import { stat, unlink } from 'fs/promises'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { type FilesApiConfig, uploadFile } from '../../services/api/filesApi.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { execFileNoThrowWithCwd } from '../execFileNoThrow.js'
import { findGitRoot, gitExe } from '../git.js'
import { generateTempFilePath } from '../tempfile.js'

// 默认 bundle 大小上限：100 MB，可通过 GrowthBook 标志 tengu_ccr_bundle_max_bytes 调整
const DEFAULT_BUNDLE_MAX_BYTES = 100 * 1024 * 1024

// bundle 的打包范围类型：
//   'all'      — 包含所有分支和标签的完整历史
//   'head'     — 仅包含当前分支的历史
//   'squashed' — 压缩为单个无父提交（最后兜底，无历史记录）
type BundleScope = 'all' | 'head' | 'squashed'

/**
 * createAndUploadGitBundle 的最终返回类型。
 * 成功时包含远端文件 ID、bundle 大小、打包范围及是否含 WIP。
 * 失败时包含错误信息和可选的失败原因。
 */
export type BundleUploadResult =
  | {
      success: true
      fileId: string
      bundleSizeBytes: number
      scope: BundleScope
      hasWip: boolean
    }
  | { success: false; error: string; failReason?: BundleFailReason }

// 失败原因枚举：git 命令失败 / 仓库过大 / 空仓库（无提交）
type BundleFailReason = 'git_error' | 'too_large' | 'empty_repo'

/**
 * _bundleWithFallback 内部创建结果类型。
 * 成功时包含 bundle 文件大小和打包范围；失败时包含错误信息。
 */
type BundleCreateResult =
  | { ok: true; size: number; scope: BundleScope }
  | { ok: false; error: string; failReason: BundleFailReason }

/**
 * 带三级降级策略的 bundle 创建函数。
 *
 * 策略顺序（从优到劣）：
 *   1. git bundle create --all   → 全量打包（含所有分支/标签/stash）
 *   2. git bundle create HEAD    → 仅打当前分支历史（丢弃旁支和标签）
 *   3. squash + git bundle create refs/seed/root → 无历史快照（最小体积）
 *
 * 每一级超过 maxBytes 限制时自动降级到下一级。
 * 若 squashed 仍超限，则返回"仓库过大"错误，引导用户配置 GitHub。
 *
 * @param gitRoot   Git 仓库根目录
 * @param bundlePath 临时 bundle 文件路径（覆盖写入）
 * @param maxBytes  bundle 体积上限（字节）
 * @param hasStash  是否存在 WIP stash（决定 squash 时使用哪个 tree）
 * @param signal    AbortSignal，用于中止长时间运行的 git 操作
 */
async function _bundleWithFallback(
  gitRoot: string,
  bundlePath: string,
  maxBytes: number,
  hasStash: boolean,
  signal: AbortSignal | undefined,
): Promise<BundleCreateResult> {
  // 若存在 stash，追加 refs/seed/stash 引用让 HEAD 模式也能抓到 WIP
  const extra = hasStash ? ['refs/seed/stash'] : []
  // 工厂函数：根据不同的 base 参数执行 git bundle create
  const mkBundle = (base: string) =>
    execFileNoThrowWithCwd(
      gitExe(),
      ['bundle', 'create', bundlePath, base, ...extra],
      { cwd: gitRoot, abortSignal: signal },
    )

  // ── 第一级：--all 全量打包 ──────────────────────────────────────────
  const allResult = await mkBundle('--all')
  if (allResult.code !== 0) {
    // git bundle create 失败（如空仓库会返回 128）
    return {
      ok: false,
      error: `git bundle create --all failed (${allResult.code}): ${allResult.stderr.slice(0, 200)}`,
      failReason: 'git_error',
    }
  }

  const { size: allSize } = await stat(bundlePath)
  if (allSize <= maxBytes) {
    // 全量 bundle 在限制内，直接返回
    return { ok: true, size: allSize, scope: 'all' }
  }

  // 全量超限，降级到 HEAD 模式
  logForDebugging(
    `[gitBundle] --all bundle is ${(allSize / 1024 / 1024).toFixed(1)}MB (> ${(maxBytes / 1024 / 1024).toFixed(0)}MB), retrying HEAD-only`,
  )

  // ── 第二级：仅打 HEAD 当前分支 ─────────────────────────────────────
  const headResult = await mkBundle('HEAD')
  if (headResult.code !== 0) {
    return {
      ok: false,
      error: `git bundle create HEAD failed (${headResult.code}): ${headResult.stderr.slice(0, 200)}`,
      failReason: 'git_error',
    }
  }

  const { size: headSize } = await stat(bundlePath)
  if (headSize <= maxBytes) {
    return { ok: true, size: headSize, scope: 'head' }
  }

  // HEAD 仍超限，降级到 squash 快照
  logForDebugging(
    `[gitBundle] HEAD bundle is ${(headSize / 1024 / 1024).toFixed(1)}MB, retrying squashed-root`,
  )

  // ── 第三级：squash 为单个无父提交（最终兜底）────────────────────────
  // 若有 WIP stash，使用 stash 的 tree（含未提交改动）；否则使用 HEAD^{tree}
  const treeRef = hasStash ? 'refs/seed/stash^{tree}' : 'HEAD^{tree}'
  // 创建无父提交，标题为 "seed"，生成新 SHA
  const commitTree = await execFileNoThrowWithCwd(
    gitExe(),
    ['commit-tree', treeRef, '-m', 'seed'],
    { cwd: gitRoot, abortSignal: signal },
  )
  if (commitTree.code !== 0) {
    return {
      ok: false,
      error: `git commit-tree failed (${commitTree.code}): ${commitTree.stderr.slice(0, 200)}`,
      failReason: 'git_error',
    }
  }
  // 将 squash 提交挂到 refs/seed/root 引用上，让 bundle create 能找到它
  const squashedSha = commitTree.stdout.trim()
  await execFileNoThrowWithCwd(
    gitExe(),
    ['update-ref', 'refs/seed/root', squashedSha],
    { cwd: gitRoot },
  )
  // 仅打包 refs/seed/root 这一个引用
  const squashResult = await execFileNoThrowWithCwd(
    gitExe(),
    ['bundle', 'create', bundlePath, 'refs/seed/root'],
    { cwd: gitRoot, abortSignal: signal },
  )
  if (squashResult.code !== 0) {
    return {
      ok: false,
      error: `git bundle create refs/seed/root failed (${squashResult.code}): ${squashResult.stderr.slice(0, 200)}`,
      failReason: 'git_error',
    }
  }
  const { size: squashSize } = await stat(bundlePath)
  if (squashSize <= maxBytes) {
    return { ok: true, size: squashSize, scope: 'squashed' }
  }

  // 三级全部超限，引导用户手动配置 GitHub
  return {
    ok: false,
    error:
      'Repo is too large to bundle. Please setup GitHub on https://claude.ai/code',
    failReason: 'too_large',
  }
}

/**
 * 打包本地 Git 仓库并上传到 Files API，返回可供 CCR 使用的 file_id。
 *
 * 完整执行流程：
 *   1. 定位 Git 仓库根目录（findGitRoot）；非 git 仓库直接返回失败
 *   2. 清理上次崩溃遗留的 refs/seed/stash 和 refs/seed/root（幂等）
 *   3. 检查仓库是否有任何提交（空仓库无法创建 bundle）
 *   4. 执行 git stash create 捕获 WIP（只影响已追踪文件，不修改工作区）
 *   5. 若有 WIP，将 stash SHA 写入 refs/seed/stash 使其可被 bundle 抓到
 *   6. 生成临时 bundle 文件路径，调用 _bundleWithFallback 创建 bundle
 *   7. 调用 uploadFile() 上传 bundle 到 Files API
 *   8. finally 块：始终删除本地临时 bundle 文件和临时 git 引用
 *
 * @param config  Files API 配置（端点、认证等）
 * @param opts    可选的工作目录和 AbortSignal
 * @returns BundleUploadResult — 成功时含 fileId，失败时含 error
 */
export async function createAndUploadGitBundle(
  config: FilesApiConfig,
  opts?: { cwd?: string; signal?: AbortSignal },
): Promise<BundleUploadResult> {
  // 使用传入的 cwd 或当前全局工作目录
  const workdir = opts?.cwd ?? getCwd()
  // 向上查找 .git 目录，确定仓库根
  const gitRoot = findGitRoot(workdir)
  if (!gitRoot) {
    return { success: false, error: 'Not in a git repository' }
  }

  // 清理上次崩溃或意外中断留下的临时引用，避免被 --all 误打包
  for (const ref of ['refs/seed/stash', 'refs/seed/root']) {
    await execFileNoThrowWithCwd(gitExe(), ['update-ref', '-d', ref], {
      cwd: gitRoot,
    })
  }

  // git bundle create 拒绝创建空 bundle（退出码 128）
  // 使用 for-each-ref 检查是否存在任意一个引用（而非只检查 HEAD）
  // 这样孤儿分支（orphan branch）也能正常打包
  const refCheck = await execFileNoThrowWithCwd(
    gitExe(),
    ['for-each-ref', '--count=1', 'refs/'],
    { cwd: gitRoot },
  )
  if (refCheck.code === 0 && refCheck.stdout.trim() === '') {
    // 无任何引用 = 空仓库，上报分析事件后返回失败
    logEvent('tengu_ccr_bundle_upload', {
      outcome:
        'empty_repo' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return {
      success: false,
      error: 'Repository has no commits yet',
      failReason: 'empty_repo',
    }
  }

  // git stash create 生成一个"悬空提交"对象（不修改 refs/stash，不影响工作区）
  // exit 0 + 空 stdout = 没有需要 stash 的改动
  const stashResult = await execFileNoThrowWithCwd(
    gitExe(),
    ['stash', 'create'],
    { cwd: gitRoot, abortSignal: opts?.signal },
  )
  // 非零退出码罕见，但不致命，继续执行（只是没有 WIP）
  const wipStashSha = stashResult.code === 0 ? stashResult.stdout.trim() : ''
  const hasWip = wipStashSha !== ''
  if (stashResult.code !== 0) {
    logForDebugging(
      `[gitBundle] git stash create failed (${stashResult.code}), proceeding without WIP: ${stashResult.stderr.slice(0, 200)}`,
    )
  } else if (hasWip) {
    logForDebugging(`[gitBundle] Captured WIP as stash ${wipStashSha}`)
    // 将悬空 stash 提交挂到 refs/seed/stash，让 bundle --all 能抓到它
    await execFileNoThrowWithCwd(
      gitExe(),
      ['update-ref', 'refs/seed/stash', wipStashSha],
      { cwd: gitRoot },
    )
  }

  // 生成临时 bundle 文件路径（进程内唯一）
  const bundlePath = generateTempFilePath('ccr-seed', '.bundle')

  // git 在非零退出时可能留下半写的临时文件，使用 finally 确保清理
  try {
    // 从 GrowthBook 读取最大 bundle 体积（null 时使用默认值 100MB）
    const maxBytes =
      getFeatureValue_CACHED_MAY_BE_STALE<number | null>(
        'tengu_ccr_bundle_max_bytes',
        null,
      ) ?? DEFAULT_BUNDLE_MAX_BYTES

    // 调用三级降级策略创建 bundle
    const bundle = await _bundleWithFallback(
      gitRoot,
      bundlePath,
      maxBytes,
      hasWip,
      opts?.signal,
    )

    if (!bundle.ok) {
      // bundle 创建失败，上报分析后返回失败结果
      logForDebugging(`[gitBundle] ${bundle.error}`)
      logEvent('tengu_ccr_bundle_upload', {
        outcome:
          bundle.failReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        max_bytes: maxBytes,
      })
      return {
        success: false,
        error: bundle.error,
        failReason: bundle.failReason,
      }
    }

    // 上传 bundle 到 Files API，使用固定的相对路径名供 CCR 端定位
    const upload = await uploadFile(bundlePath, '_source_seed.bundle', config, {
      signal: opts?.signal,
    })

    if (!upload.success) {
      // 上传失败，上报分析后返回失败结果
      logEvent('tengu_ccr_bundle_upload', {
        outcome:
          'failed' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      return { success: false, error: upload.error }
    }

    // 上传成功，记录调试日志和分析事件
    logForDebugging(
      `[gitBundle] Uploaded ${upload.size} bytes as file_id ${upload.fileId}`,
    )
    logEvent('tengu_ccr_bundle_upload', {
      outcome:
        'success' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      size_bytes: upload.size,
      scope:
        bundle.scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      has_wip: hasWip,
    })
    return {
      success: true,
      fileId: upload.fileId,
      bundleSizeBytes: upload.size,
      scope: bundle.scope,
      hasWip,
    }
  } finally {
    // ── 清理阶段（无论成功/失败都执行）────────────────────────────────
    // 删除本地临时 bundle 文件（非致命错误）
    try {
      await unlink(bundlePath)
    } catch {
      logForDebugging(`[gitBundle] Could not delete ${bundlePath} (non-fatal)`)
    }
    // 删除临时 git 引用，update-ref -d 对不存在的引用退出码为 0，安全幂等
    for (const ref of ['refs/seed/stash', 'refs/seed/root']) {
      await execFileNoThrowWithCwd(gitExe(), ['update-ref', '-d', ref], {
        cwd: gitRoot,
      })
    }
  }
}
