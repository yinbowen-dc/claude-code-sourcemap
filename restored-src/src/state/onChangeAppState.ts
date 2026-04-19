/**
 * AppState 变更副作用处理模块
 *
 * 在 Claude Code 的状态管理体系中，本文件处于"状态同步"层：
 * - 上层：AppState.tsx 中的 createStore 将本模块的 onChangeAppState 注册为
 *         onChange 回调，每次 AppState 发生变化时自动触发
 * - 本层：通过对比 newState / oldState 的差异，将关键字段同步到外部系统
 *         （CCR 元数据、SDK 权限流、用户设置文件、全局配置文件）
 * - 依赖层：sessionState.ts 提供 CCR/SDK 通知；settings.ts 提供设置持久化；
 *           config.ts 提供全局配置读写；auth.ts 提供凭证缓存清理
 *
 * 同步的字段：
 * 1. toolPermissionContext.mode → CCR external_metadata + SDK 权限流
 * 2. mainLoopModel → 用户设置文件 (model 字段)
 * 3. expandedView → globalConfig (showExpandedTodos / showSpinnerTree)
 * 4. verbose → globalConfig (verbose)
 * 5. tungstenPanelVisible → globalConfig（仅 ant 内部构建）
 * 6. settings → 清除认证缓存 + 重新应用环境变量
 */

import { setMainLoopModelOverride } from '../bootstrap/state.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
} from '../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { applyConfigEnvironmentVariables } from '../utils/managedEnv.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../utils/permissions/PermissionMode.js'
import {
  notifyPermissionModeChanged,
  notifySessionMetadataChanged,
  type SessionExternalMetadata,
} from '../utils/sessionState.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import type { AppState } from './AppStateStore.js'

/**
 * 将外部会话元数据还原为 AppState 更新函数（externalMetadata → AppState）。
 *
 * 与 onChangeAppState 中的"推送"方向相反，本函数用于 worker 重启时
 * 从持久化的 CCR external_metadata 中恢复 AppState（"拉取"方向）。
 *
 * 只还原有明确值的字段：
 * - permission_mode（字符串类型时）→ toolPermissionContext.mode
 * - is_ultraplan_mode（布尔类型时）→ isUltraplanMode
 *
 * @param metadata CCR 存储的会话外部元数据
 * @returns        (prev: AppState) => AppState 状态更新函数
 */
export function externalMetadataToAppState(
  metadata: SessionExternalMetadata,
): (prev: AppState) => AppState {
  return prev => ({
    ...prev,
    // 若元数据中包含 permission_mode 字符串，则还原到工具权限上下文
    ...(typeof metadata.permission_mode === 'string'
      ? {
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            mode: permissionModeFromString(metadata.permission_mode),
          },
        }
      : {}),
    // 若元数据中包含 is_ultraplan_mode 布尔值，则还原 ultraplan 模式标志
    ...(typeof metadata.is_ultraplan_mode === 'boolean'
      ? { isUltraplanMode: metadata.is_ultraplan_mode }
      : {}),
  })
}

/**
 * AppState 变更时的副作用处理函数（createStore 的 onChange 回调）。
 *
 * 通过 diff（newState vs oldState）精准触发副作用，避免重复通知：
 *
 * 1. toolPermissionContext.mode 变化：
 *    - 外部模式（toExternalPermissionMode）变化时：通知 CCR（notifySessionMetadataChanged）
 *    - 内部模式（raw mode）变化时：通知 SDK 权限流（notifyPermissionModeChanged）
 *    - ultraplan 初次进入 plan 模式时，同时上报 is_ultraplan_mode=true
 *
 * 2. mainLoopModel 变化：
 *    - 置为 null：从用户设置中移除 model 字段，清除运行时覆盖
 *    - 置为非 null：写入用户设置，同时更新运行时覆盖
 *
 * 3. expandedView 变化：
 *    - 转换为 showExpandedTodos / showSpinnerTree 布尔值并持久化到 globalConfig
 *      （保持与旧版配置字段的向后兼容）
 *
 * 4. verbose 变化：持久化到 globalConfig.verbose
 *
 * 5. tungstenPanelVisible 变化（仅 ant 构建）：持久化到 globalConfig
 *
 * 6. settings 对象引用变化：
 *    - 清除 apiKeyHelper / AWS / GCP 凭证缓存，使新设置立即生效
 *    - 若 settings.env 变化，重新应用托管环境变量（additive-only）
 *
 * @param newState 变化后的 AppState
 * @param oldState 变化前的 AppState
 */
export function onChangeAppState({
  newState,
  oldState,
}: {
  newState: AppState
  oldState: AppState
}) {
  // ── 1. toolPermissionContext.mode 同步 ────────────────────────────────────
  //
  // 此处是权限模式变更的唯一通知出口。
  // 历史上模式变更路径分散（print.ts、set_permission_mode、Shift+Tab 等），
  // 各自独立通知，容易遗漏导致 CCR external_metadata 与 CLI 实际模式不同步。
  // 统一在此 diff 点拦截，任意路径的 setAppState 均能触发通知，无需修改散落的调用方。
  const prevMode = oldState.toolPermissionContext.mode
  const newMode = newState.toolPermissionContext.mode
  if (prevMode !== newMode) {
    // CCR external_metadata 只接受外部模式名（不含 bubble、ungated auto 等内部模式）。
    // 若外部化后模式相同（如 default→bubble→default），则跳过 CCR 通知（避免噪音）。
    // SDK 渠道（notifyPermissionModeChanged）直接传递原始模式，由其监听器自行过滤。
    const prevExternal = toExternalPermissionMode(prevMode)
    const newExternal = toExternalPermissionMode(newMode)
    if (prevExternal !== newExternal) {
      // ultraplan 模式：仅在首次进入 plan 模式（isUltraplanMode 从 false→true）时上报 true；
      // null 按 RFC 7396 语义表示"删除该键"
      const isUltraplan =
        newExternal === 'plan' &&
        newState.isUltraplanMode &&
        !oldState.isUltraplanMode
          ? true
          : null
      notifySessionMetadataChanged({
        permission_mode: newExternal,
        is_ultraplan_mode: isUltraplan,
      })
    }
    notifyPermissionModeChanged(newMode) // SDK 权限流通知（无过滤，由监听器决定处理逻辑）
  }

  // ── 2. mainLoopModel 持久化 ───────────────────────────────────────────────
  if (
    newState.mainLoopModel !== oldState.mainLoopModel &&
    newState.mainLoopModel === null
  ) {
    // 模型置空：从用户设置中移除 model 字段，并清除运行时覆盖
    updateSettingsForSource('userSettings', { model: undefined })
    setMainLoopModelOverride(null)
  }

  if (
    newState.mainLoopModel !== oldState.mainLoopModel &&
    newState.mainLoopModel !== null
  ) {
    // 模型更新：写入用户设置，同步运行时覆盖
    updateSettingsForSource('userSettings', { model: newState.mainLoopModel })
    setMainLoopModelOverride(newState.mainLoopModel)
  }

  // ── 3. expandedView 持久化（向后兼容旧配置字段） ──────────────────────────
  if (newState.expandedView !== oldState.expandedView) {
    const showExpandedTodos = newState.expandedView === 'tasks'     // 任务展开视图
    const showSpinnerTree = newState.expandedView === 'teammates'   // 队友展开视图
    // 仅在实际值发生变化时写文件，避免不必要的 I/O
    if (
      getGlobalConfig().showExpandedTodos !== showExpandedTodos ||
      getGlobalConfig().showSpinnerTree !== showSpinnerTree
    ) {
      saveGlobalConfig(current => ({
        ...current,
        showExpandedTodos,
        showSpinnerTree,
      }))
    }
  }

  // ── 4. verbose 持久化 ─────────────────────────────────────────────────────
  if (
    newState.verbose !== oldState.verbose &&
    getGlobalConfig().verbose !== newState.verbose
  ) {
    const verbose = newState.verbose
    saveGlobalConfig(current => ({
      ...current,
      verbose,
    }))
  }

  // ── 5. tungstenPanelVisible 持久化（仅 ant 内部构建） ─────────────────────
  if (process.env.USER_TYPE === 'ant') {
    if (
      newState.tungstenPanelVisible !== oldState.tungstenPanelVisible &&
      newState.tungstenPanelVisible !== undefined &&
      getGlobalConfig().tungstenPanelVisible !== newState.tungstenPanelVisible
    ) {
      const tungstenPanelVisible = newState.tungstenPanelVisible
      saveGlobalConfig(current => ({ ...current, tungstenPanelVisible }))
    }
  }

  // ── 6. settings 变更：清除认证缓存 + 重新应用环境变量 ────────────────────
  // settings 对象引用变化意味着用户修改了配置文件（apiKeyHelper、AWS/GCP 凭证等），
  // 需立即使新设置生效，避免旧凭证被缓存继续使用
  if (newState.settings !== oldState.settings) {
    try {
      clearApiKeyHelperCache()      // 清除 API Key 助手缓存
      clearAwsCredentialsCache()    // 清除 AWS 凭证缓存
      clearGcpCredentialsCache()    // 清除 GCP 凭证缓存

      // 仅在 env 字段变化时重新应用托管环境变量
      // （additive-only：新变量添加、现有变量可覆盖，但不删除任何已设置的变量）
      if (newState.settings.env !== oldState.settings.env) {
        applyConfigEnvironmentVariables()
      }
    } catch (error) {
      logError(toError(error)) // 非致命错误：记录日志但不中断状态同步
    }
  }
}
