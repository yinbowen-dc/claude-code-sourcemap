/**
 * 市场协调器（reconciler）— Claude Code 插件系统的第二层物化同步模块
 *
 * Claude Code 插件系统三层模型中的第二层：
 *   Layer 1：意图层（settings.json 中声明的市场）
 *   Layer 2：物化层（known_marketplaces.json + ~/.claude/plugins/ 目录）← 本文件
 *   Layer 3：活跃组件层（AppState 中加载的插件命令/代理/hooks）← refresh.ts
 *
 * 职责：
 *   - diffMarketplaces()：纯函数，比较声明意图（settings）与已物化状态（JSON）的差异
 *     返回 missing（缺失）、sourceChanged（来源变更）、upToDate（最新）三类
 *   - reconcileMarketplaces()：根据 diff 结果执行安装/更新操作，使物化状态与意图一致
 *     幂等（多次执行安全）、只增不减（永不删除已有市场）
 *
 * 路径规范化：
 *   project 作用域的设置可能使用相对路径（./foo），known_marketplaces.json 存储绝对路径。
 *   比较前需要规范化，且针对 git worktree 需使用主仓库的 canonical root
 *   而非当前 worktree 的工作目录（避免每个 worktree 覆盖共享条目）。
 */

import isEqual from 'lodash-es/isEqual.js'
import { isAbsolute, resolve } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { pathExists } from '../file.js'
import { findCanonicalGitRoot } from '../git.js'
import { logError } from '../log.js'
import {
  addMarketplaceSource,
  type DeclaredMarketplace,
  getDeclaredMarketplaces,
  loadKnownMarketplacesConfig,
} from './marketplaceManager.js'
import {
  isLocalMarketplaceSource,
  type KnownMarketplacesFile,
  type MarketplaceSource,
} from './schemas.js'

/**
 * 市场差异比较结果类型。
 * 描述声明意图（settings）与已物化状态（known_marketplaces.json）之间的差异。
 */
export type MarketplaceDiff = {
  /** 在 settings 中声明但 known_marketplaces.json 中不存在的市场名称 */
  missing: string[]
  /** 在两者中均存在，但 settings 来源与 JSON 来源不一致（settings 胜出） */
  sourceChanged: Array<{
    name: string
    declaredSource: MarketplaceSource    // settings 中声明的来源
    materializedSource: MarketplaceSource // JSON 中已物化的来源
  }>
  /** 在两者中均存在且来源一致，无需操作 */
  upToDate: string[]
}

/**
 * 比较声明意图（settings）与已物化状态（JSON），返回差异分析结果。
 *
 * 比较流程：
 *   1. 遍历 settings 中每个声明的市场
 *   2. 规范化声明来源中的相对路径（./path → 绝对路径）
 *   3. 若 JSON 中不存在该市场 → missing
 *   4. 若声明来源是 fallback（兜底默认值）→ 不比较来源，直接视为 upToDate
 *      （防止覆盖已通过 seed/mirror 物化的有效内容）
 *   5. 若来源不一致（deep equal 比较）→ sourceChanged
 *   6. 否则 → upToDate
 *
 * 注意：此函数是纯函数（不做 I/O），路径规范化会读取 .git 但被 memoize 缓存。
 *
 * @param declared - settings 中声明的市场映射（名称 → DeclaredMarketplace）
 * @param materialized - known_marketplaces.json 中已物化的市场状态
 * @param opts.projectRoot - 项目根目录（用于相对路径解析）
 * @returns 差异分析结果
 */
export function diffMarketplaces(
  declared: Record<string, DeclaredMarketplace>,
  materialized: KnownMarketplacesFile,
  opts?: { projectRoot?: string },
): MarketplaceDiff {
  const missing: string[] = []
  const sourceChanged: MarketplaceDiff['sourceChanged'] = []
  const upToDate: string[] = []

  for (const [name, intent] of Object.entries(declared)) {
    const state = materialized[name]
    // 规范化声明来源（处理相对路径，适配 git worktree）
    const normalizedIntent = normalizeSource(intent.source, opts?.projectRoot)

    if (!state) {
      // 场景 1：JSON 中不存在该市场，需要安装
      missing.push(name)
    } else if (intent.sourceIsFallback) {
      // 场景 2：声明来源仅为兜底默认值，不做来源比较
      // 若 seed/prior-install/mirror 已用任意来源物化了此市场，保持原状
      // 如果比较来源，会触发 sourceChanged → 重新克隆 → 覆盖已有内容
      upToDate.push(name)
    } else if (!isEqual(normalizedIntent, state.source)) {
      // 场景 3：来源发生变更（settings 胜出，需要更新）
      sourceChanged.push({
        name,
        declaredSource: normalizedIntent,
        materializedSource: state.source,
      })
    } else {
      // 场景 4：来源完全一致，无需操作
      upToDate.push(name)
    }
  }

  return { missing, sourceChanged, upToDate }
}

/** 协调操作选项 */
export type ReconcileOptions = {
  /** 跳过某个声明市场的回调（用于 zip-cache 模式跳过不支持的来源类型） */
  skip?: (name: string, source: MarketplaceSource) => boolean
  /** 安装进度事件回调 */
  onProgress?: (event: ReconcileProgressEvent) => void
}

/** 安装进度事件类型联合 */
export type ReconcileProgressEvent =
  | {
      type: 'installing'   // 正在安装/更新
      name: string
      action: 'install' | 'update'
      index: number        // 当前序号（1-based）
      total: number        // 总任务数
    }
  | { type: 'installed'; name: string; alreadyMaterialized: boolean }  // 安装完成
  | { type: 'failed'; name: string; error: string }                     // 安装失败

/** 协调操作结果 */
export type ReconcileResult = {
  installed: string[]                                  // 新安装的市场名称列表
  updated: string[]                                    // 更新的市场名称列表
  failed: Array<{ name: string; error: string }>       // 失败的市场及错误信息
  upToDate: string[]                                   // 已是最新的市场名称列表
  skipped: string[]                                    // 跳过的市场名称列表
}

/**
 * 使 known_marketplaces.json 与 settings 中声明的意图保持一致。
 * 幂等（多次执行安全），只增不减（永不删除已有市场），不修改 AppState。
 *
 * 执行流程：
 *   1. 读取所有声明的市场（getDeclaredMarketplaces）
 *   2. 加载当前已物化状态（known_marketplaces.json）
 *   3. 计算 diff（调用 diffMarketplaces）
 *   4. 构建工作列表（missing → install，sourceChanged → update）
 *   5. 按 skip 回调和路径存在性过滤工作列表
 *   6. 串行执行安装/更新，收集结果，触发进度回调
 *
 * @param opts - 可选的跳过回调和进度回调
 * @returns 安装结果汇总
 */
export async function reconcileMarketplaces(
  opts?: ReconcileOptions,
): Promise<ReconcileResult> {
  // 读取 settings 中声明的所有市场
  const declared = getDeclaredMarketplaces()
  if (Object.keys(declared).length === 0) {
    // 无声明市场，直接返回空结果
    return { installed: [], updated: [], failed: [], upToDate: [], skipped: [] }
  }

  // 加载当前已物化的市场状态
  let materialized: KnownMarketplacesFile
  try {
    materialized = await loadKnownMarketplacesConfig()
  } catch (e) {
    // 加载失败时，将物化状态视为空（触发全量重新安装）
    logError(e)
    materialized = {}
  }

  // 计算差异（使用 getOriginalCwd 作为项目根目录）
  const diff = diffMarketplaces(declared, materialized, {
    projectRoot: getOriginalCwd(),
  })

  // 构建工作列表（missing → install，sourceChanged → update）
  type WorkItem = {
    name: string
    source: MarketplaceSource
    action: 'install' | 'update'
  }
  const work: WorkItem[] = [
    ...diff.missing.map(
      (name): WorkItem => ({
        name,
        source: normalizeSource(declared[name]!.source),
        action: 'install',
      }),
    ),
    ...diff.sourceChanged.map(
      ({ name, declaredSource }): WorkItem => ({
        name,
        source: declaredSource,
        action: 'update',
      }),
    ),
  ]

  // 过滤工作列表：应用 skip 回调，并跳过本地路径不存在的 update 操作
  const skipped: string[] = []
  const toProcess: WorkItem[] = []
  for (const item of work) {
    if (opts?.skip?.(item.name, item.source)) {
      // 调用方要求跳过（如 zip-cache 模式不支持此来源类型）
      skipped.push(item.name)
      continue
    }
    // sourceChanged 且来源为本地路径但路径不存在：跳过而非报错
    // 多工作树场景下 normalizeSource 可能产生无效路径，已物化条目仍然有效
    // missing 条目不跳过（没有可保留的内容，用户应看到错误）
    if (
      item.action === 'update' &&
      isLocalMarketplaceSource(item.source) &&
      !(await pathExists(item.source.path))
    ) {
      logForDebugging(
        `[reconcile] '${item.name}' declared path does not exist; keeping materialized entry`,
      )
      skipped.push(item.name)
      continue
    }
    toProcess.push(item)
  }

  if (toProcess.length === 0) {
    // 无需处理，直接返回
    return {
      installed: [],
      updated: [],
      failed: [],
      upToDate: diff.upToDate,
      skipped,
    }
  }

  logForDebugging(
    `[reconcile] ${toProcess.length} marketplace(s): ${toProcess.map(w => `${w.name}(${w.action})`).join(', ')}`,
  )

  const installed: string[] = []
  const updated: string[] = []
  const failed: ReconcileResult['failed'] = []

  // 串行执行安装/更新（避免并发 git clone 竞争）
  for (let i = 0; i < toProcess.length; i++) {
    const { name, source, action } = toProcess[i]!
    // 触发进度事件（正在安装）
    opts?.onProgress?.({
      type: 'installing',
      name,
      action,
      index: i + 1,
      total: toProcess.length,
    })

    try {
      // addMarketplaceSource 是来源幂等的：相同来源返回 alreadyMaterialized:true
      // 对于 'update'（来源已变更），新来源不匹配现有条目 → 执行克隆并覆盖 JSON 条目
      const result = await addMarketplaceSource(source)

      if (action === 'install') installed.push(name)
      else updated.push(name)
      // 触发进度事件（安装完成）
      opts?.onProgress?.({
        type: 'installed',
        name,
        alreadyMaterialized: result.alreadyMaterialized,
      })
    } catch (e) {
      const error = errorMessage(e)
      failed.push({ name, error })
      // 触发进度事件（安装失败）
      opts?.onProgress?.({ type: 'failed', name, error })
      logError(e)
    }
  }

  return { installed, updated, failed, upToDate: diff.upToDate, skipped }
}

/**
 * 规范化市场来源中的相对路径，用于稳定比较。
 *
 * 背景：
 *   - project 作用域的 settings 可能使用项目相对路径（./foo）
 *   - known_marketplaces.json 存储绝对路径
 *   - 比较前必须将相对路径解析为绝对路径
 *
 * git worktree 处理：
 *   针对 git worktree，使用主仓库的 canonical root 而非 worktree 的 cwd。
 *   原因：project settings 提交到 git，./foo 含义是"相对于此仓库"。
 *   若用 worktree cwd 解析，每个 worktree 会覆盖共享条目为自己的绝对路径，
 *   删除 worktree 后会留下死链的 installLocation。
 *
 * @param source - 市场来源配置
 * @param projectRoot - 可选的项目根目录（默认使用 getOriginalCwd()）
 * @returns 路径已规范化的来源配置
 */
function normalizeSource(
  source: MarketplaceSource,
  projectRoot?: string,
): MarketplaceSource {
  if (
    (source.source === 'directory' || source.source === 'file') &&
    !isAbsolute(source.path)  // 只处理相对路径
  ) {
    const base = projectRoot ?? getOriginalCwd()
    // 读取 canonical git root（处理 git worktree 场景）
    const canonicalRoot = findCanonicalGitRoot(base)
    return {
      ...source,
      path: resolve(canonicalRoot ?? base, source.path),
    }
  }
  // 绝对路径或非本地来源，直接返回
  return source
}
