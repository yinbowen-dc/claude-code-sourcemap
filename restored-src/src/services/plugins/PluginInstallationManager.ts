/**
 * 后台插件与市场安装管理器
 *
 * 在 Claude Code 系统流程中的位置：
 * 本文件是插件子系统的后台初始化层，在 Claude Code 启动时异步执行市场（marketplace）
 * 的协调（reconcile）逻辑，无需阻塞主进程启动。它位于以下层次结构中：
 *   - 调用方：REPL 启动流程，在用户界面初始化后异步调用
 *   - 本模块：编排 diff → 初始化 AppState → reconcile → 刷新/通知 的完整流程
 *   - 下层：marketplaceManager（声明/加载配置）、reconciler（diff/reconcile）、
 *           pluginLoader（缓存清除）、refresh（插件重载）
 *
 * 主要功能：
 * - updateMarketplaceStatus：更新单个市场的安装状态到 AppState（pending/installing/installed/failed）
 * - performBackgroundPluginInstallations：完整的后台插件安装编排流程：
 *   1. getDeclaredMarketplaces + loadKnownMarketplacesConfig → diffMarketplaces 计算待处理列表
 *   2. 用 pending spinners 初始化 AppState（UI 进度显示）
 *   3. reconcileMarketplaces 并将 onProgress 事件映射为 AppState 更新
 *   4. 新安装（installed.length > 0）→ 自动刷新（refreshActivePlugins）；失败则降级为 needsRefresh
 *   5. 仅更新（updated.length > 0）→ 清除缓存 + 设置 needsRefresh（由用户手动 /reload-plugins）
 *   6. 记录 tengu_marketplace_background_install 分析事件（含 installed/updated/failed/up_to_date 计数）
 *
 * 设计说明：
 * - 整个函数包裹在 try-catch 中，任何错误仅记录日志，不影响主 REPL 流程
 * - 无 per-plugin pending 状态：插件加载快（缓存命中或本地副本），市场克隆才是需要显示进度的慢操作
 * - 新安装自动刷新修复了「首次安装后需要重启」的问题（market cache 为空时）
 */

/**
 * Background plugin and marketplace installation manager
 *
 * This module handles automatic installation of plugins and marketplaces
 * from trusted sources (repository and user settings) without blocking startup.
 */

import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../../utils/debug.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { logError } from '../../utils/log.js'
import {
  clearMarketplacesCache,
  getDeclaredMarketplaces,
  loadKnownMarketplacesConfig,
} from '../../utils/plugins/marketplaceManager.js'
import { clearPluginCache } from '../../utils/plugins/pluginLoader.js'
import {
  diffMarketplaces,
  reconcileMarketplaces,
} from '../../utils/plugins/reconciler.js'
import { refreshActivePlugins } from '../../utils/plugins/refresh.js'
import { logEvent } from '../analytics/index.js'

// SetAppState 类型别名：接受状态更新函数，与 React 的 setState 模式兼容
type SetAppState = (f: (prevState: AppState) => AppState) => void

/**
 * 更新单个市场的安装状态到 AppState
 *
 * 通过 setAppState 将指定市场（按 name 匹配）的 status 字段更新为新状态，
 * 可选附带错误信息（failed 状态时使用）。
 * 采用不可变更新模式：仅修改 installationStatus.marketplaces 中的目标项。
 *
 * @param setAppState AppState 更新函数
 * @param name 市场名称（唯一标识符）
 * @param status 新的安装状态（pending/installing/installed/failed）
 * @param error 可选的错误描述（仅 failed 状态时传入）
 */
function updateMarketplaceStatus(
  setAppState: SetAppState,
  name: string,
  status: 'pending' | 'installing' | 'installed' | 'failed',
  error?: string,
): void {
  setAppState(prevState => ({
    ...prevState,
    plugins: {
      ...prevState.plugins,
      installationStatus: {
        ...prevState.plugins.installationStatus,
        // 遍历市场列表，仅更新匹配 name 的项，其他项原样保留
        marketplaces: prevState.plugins.installationStatus.marketplaces.map(
          m => (m.name === name ? { ...m, status, error } : m),
        ),
      },
    },
  }))
}

/**
 * Perform background plugin startup checks and installations.
 *
 * This is a thin wrapper around reconcileMarketplaces() that maps onProgress
 * events to AppState updates for the REPL UI. After marketplaces are
 * reconciled:
 * - New installs → auto-refresh plugins (fixes "plugin-not-found" errors
 *   from the initial cache-only load on fresh homespace/cleared cache)
 * - Updates only → set needsRefresh, show notification for /reload-plugins
 *
 * 执行后台插件启动检查与安装
 *
 * 完整流程：
 * 1. 计算 diff：getDeclaredMarketplaces（声明配置）+ loadKnownMarketplacesConfig（已知配置）
 *    → diffMarketplaces → pendingNames（需安装或源发生变化的市场列表）
 * 2. 初始化 AppState：为每个 pendingName 设置 status:'pending'（UI 显示 spinner）
 * 3. pendingNames 为空时提前返回
 * 4. reconcileMarketplaces 并将 onProgress 事件（installing/installed/failed）映射为 AppState 更新
 * 5. 记录分析事件（installed/updated/failed/up_to_date 计数）
 * 6. 若有新安装（result.installed.length > 0）：
 *    - clearMarketplacesCache → refreshActivePlugins（自动刷新，修复缓存为空的问题）
 *    - refreshActivePlugins 失败：降级为 clearPluginCache + needsRefresh=true
 * 7. 若仅有更新（result.updated.length > 0）：
 *    - clearMarketplacesCache + clearPluginCache + needsRefresh=true（用户手动 /reload-plugins）
 */
export async function performBackgroundPluginInstallations(
  setAppState: SetAppState,
): Promise<void> {
  logForDebugging('performBackgroundPluginInstallations called')

  try {
    // Compute diff upfront for initial UI status (pending spinners)
    // 获取声明的市场配置（来自仓库或用户设置）
    const declared = getDeclaredMarketplaces()
    // 加载已知市场配置（本地已安装的市场信息），失败时降级为空对象
    const materialized = await loadKnownMarketplacesConfig().catch(() => ({}))
    // 计算 diff：找出需要安装（missing）和源发生变化（sourceChanged）的市场
    const diff = diffMarketplaces(declared, materialized)

    // 合并待处理列表：新增市场 + 源变更市场（两者均需重新安装/更新）
    const pendingNames = [
      ...diff.missing,
      ...diff.sourceChanged.map(c => c.name),
    ]

    // Initialize AppState with pending status. No per-plugin pending status —
    // plugin load is fast (cache hit or local copy); marketplace clone is the
    // slow part worth showing progress for.
    // 用 pending spinners 初始化 AppState，为每个待处理市场创建进度条
    setAppState(prev => ({
      ...prev,
      plugins: {
        ...prev.plugins,
        installationStatus: {
          // 每个 pending 市场初始化为 'pending' 状态（UI 显示加载动画）
          marketplaces: pendingNames.map(name => ({
            name,
            status: 'pending' as const,
          })),
          plugins: [],
        },
      },
    }))

    // 无待处理市场时提前返回，避免不必要的 reconcile 调用
    if (pendingNames.length === 0) {
      return
    }

    logForDebugging(
      `Installing ${pendingNames.length} marketplace(s) in background`,
    )

    // 执行市场协调（reconcile），通过 onProgress 回调实时更新 AppState
    const result = await reconcileMarketplaces({
      onProgress: event => {
        switch (event.type) {
          case 'installing':
            // 开始安装：更新该市场状态为 'installing'（UI 显示进行中）
            updateMarketplaceStatus(setAppState, event.name, 'installing')
            break
          case 'installed':
            // 安装完成：更新状态为 'installed'（UI 显示完成）
            updateMarketplaceStatus(setAppState, event.name, 'installed')
            break
          case 'failed':
            // 安装失败：更新状态为 'failed' 并附带错误描述
            updateMarketplaceStatus(
              setAppState,
              event.name,
              'failed',
              event.error,
            )
            break
        }
      },
    })

    // 收集指标用于分析事件和诊断日志
    const metrics = {
      installed_count: result.installed.length,
      updated_count: result.updated.length,
      failed_count: result.failed.length,
      up_to_date_count: result.upToDate.length,
    }
    logEvent('tengu_marketplace_background_install', metrics)
    logForDiagnosticsNoPII(
      'info',
      'tengu_marketplace_background_install',
      metrics,
    )

    if (result.installed.length > 0) {
      // New marketplaces were installed — auto-refresh plugins. This fixes
      // "Plugin not found in marketplace" errors from the initial cache-only
      // load (e.g., fresh homespace where marketplace cache was empty).
      // refreshActivePlugins clears all caches, reloads plugins, and bumps
      // pluginReconnectKey so MCP connections are re-established.
      // 有新安装的市场：清除旧缓存后自动刷新，修复首次安装后插件找不到的问题
      clearMarketplacesCache()
      logForDebugging(
        `Auto-refreshing plugins after ${result.installed.length} new marketplace(s) installed`,
      )
      try {
        // refreshActivePlugins：清除所有缓存、重载插件、递增 pluginReconnectKey 触发 MCP 重连
        await refreshActivePlugins(setAppState)
      } catch (refreshError) {
        // If auto-refresh fails, fall back to needsRefresh notification so
        // the user can manually run /reload-plugins to recover.
        // 自动刷新失败：降级方案 — 清除缓存并设置 needsRefresh，由用户手动 /reload-plugins
        logError(refreshError)
        logForDebugging(
          `Auto-refresh failed, falling back to needsRefresh: ${refreshError}`,
          { level: 'warn' },
        )
        clearPluginCache(
          'performBackgroundPluginInstallations: auto-refresh failed',
        )
        setAppState(prev => {
          // 幂等检查：needsRefresh 已为 true 时不重复触发状态更新
          if (prev.plugins.needsRefresh) return prev
          return {
            ...prev,
            plugins: { ...prev.plugins, needsRefresh: true },
          }
        })
      }
    } else if (result.updated.length > 0) {
      // Existing marketplaces updated — notify user to run /reload-plugins.
      // Updates are less urgent and the user should choose when to apply them.
      // 仅有更新的市场（无新安装）：清除缓存并通知用户手动刷新（更新不如新安装紧急）
      clearMarketplacesCache()
      clearPluginCache(
        'performBackgroundPluginInstallations: marketplaces reconciled',
      )
      setAppState(prev => {
        // 幂等检查：needsRefresh 已为 true 时不重复更新
        if (prev.plugins.needsRefresh) return prev
        return {
          ...prev,
          plugins: { ...prev.plugins, needsRefresh: true },
        }
      })
    }
  } catch (error) {
    // 顶层异常捕获：任何未预期错误均记录日志，不影响主 REPL 流程
    logError(error)
  }
}
