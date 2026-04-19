/**
 * 插件系统启动检查入口模块。
 *
 * 在 Claude Code 插件系统流程中，本文件处于"REPL 启动初始化"层：
 *   - 由 REPL.tsx 在用户通过"信任当前目录"对话框后立即调用；
 *   - 确保 seed 市场（CLAUDE_CODE_PLUGIN_SEED_DIR）在后台安装任务开始前已注册；
 *   - 若 seed 状态发生变化，清除陈旧缓存并通知 UI 刷新插件列表；
 *   - 最终调用 performBackgroundPluginInstallations() 异步安装所有声明的插件。
 *
 * 安全注意：
 *   本函数仅在用户显式信任当前目录后调用（cli.tsx 的信任对话框会阻断所有执行，
 *   直到用户明确授权），从而防止恶意仓库自动安装插件。
 *
 * 主要导出：
 *   - performStartupChecks(setAppState)：插件启动检查的总入口
 */

import { performBackgroundPluginInstallations } from '../../services/plugins/PluginInstallationManager.js'
import type { AppState } from '../../state/AppState.js'
import { checkHasTrustDialogAccepted } from '../config.js'
import { logForDebugging } from '../debug.js'
import {
  clearMarketplacesCache,
  registerSeedMarketplaces,
} from './marketplaceManager.js'
import { clearPluginCache } from './pluginLoader.js'

// setAppState 函数类型：接收一个"前一状态 → 新状态"的转换函数
type SetAppState = (f: (prevState: AppState) => AppState) => void

/**
 * 执行插件启动检查，并触发后台安装流程。
 *
 * 执行流程：
 *   1. 检查当前目录是否已通过信任对话框授权，若未授权则直接返回；
 *   2. 调用 registerSeedMarketplaces()，将 CLAUDE_CODE_PLUGIN_SEED_DIR 中的
 *      市场注册到 known_marketplaces.json（幂等操作）；
 *   3. 若注册导致状态变化，清除市场缓存和插件缓存，并设置 needsRefresh 标志
 *      通知 useManagePlugins 提示用户运行 /reload-plugins；
 *   4. 调用 performBackgroundPluginInstallations() 后台安装所有声明的插件；
 *   5. 捕获所有异常并记录日志，确保任何错误都不阻断 REPL 启动。
 *
 * 安全说明：仅在 REPL.tsx 确认信任后调用，防止恶意仓库自动植入插件。
 *
 * @param setAppState 用于更新应用状态（安装进度、刷新标志等）的函数
 */
export async function performStartupChecks(
  setAppState: SetAppState,
): Promise<void> {
  logForDebugging('performStartupChecks called')

  // 检查当前工作目录是否已被用户明确信任
  if (!checkHasTrustDialogAccepted()) {
    // 未信任则跳过所有插件安装，防止恶意仓库利用插件系统
    logForDebugging(
      'Trust not accepted for current directory - skipping plugin installations',
    )
    return
  }

  try {
    logForDebugging('Starting background plugin installations')

    // 在执行后台安装之前，先注册 seed 市场（CLAUDE_CODE_PLUGIN_SEED_DIR）。
    // 幂等操作：若未配置 seed 目录则为空操作。
    // 若不执行此步骤，后台安装会将 seed 市场视为缺失并重新克隆，
    // 完全违背 seed 目录的初衷（节省网络和磁盘操作）。
    //
    // 若注册改变了已知市场状态，则需清除缓存：
    // 早期的插件加载（如 REPL 初始化时的 getAllMcpConfigs）可能已缓存了
    // "市场未找到"的陈旧结果，清除缓存可让后续调用重新解析。
    const seedChanged = await registerSeedMarketplaces()
    if (seedChanged) {
      // 清除市场元数据缓存（getMarketplace 等的 memoize 缓存）
      clearMarketplacesCache()
      // 清除插件加载缓存（pluginLoader 的内存缓存）
      clearPluginCache('performStartupChecks: seed marketplaces changed')
      // 设置 needsRefresh 标志，让 useManagePlugins 提示用户执行 /reload-plugins。
      // 若不设此标志，早期已缓存"市场未找到"结果的插件加载轮次会持续生效，
      // 直到用户手动重新加载。
      setAppState(prev => {
        // 若已设置 needsRefresh，直接返回原状态，避免不必要的重渲染
        if (prev.plugins.needsRefresh) return prev
        return {
          ...prev,
          plugins: {
            ...prev.plugins,
            needsRefresh: true, // 通知 UI 提示用户刷新
          },
        }
      })
    }

    // 启动后台安装任务（异步，不阻塞 REPL）
    // 安装进度和错误会通过 setAppState 更新到应用状态，由通知组件展示
    await performBackgroundPluginInstallations(setAppState)
  } catch (error) {
    // 即使此处发生任何错误，也不应阻断 REPL 启动
    logForDebugging(
      `Error initiating background plugin installations: ${error}`,
    )
  }
}
