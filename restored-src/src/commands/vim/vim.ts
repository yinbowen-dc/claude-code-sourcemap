/**
 * vim 命令的执行逻辑
 *
 * 本文件是 /vim 命令的实现层，在 Claude Code 编辑器模式切换流程中负责：
 *   1. 从全局配置中读取当前编辑器模式（vim / normal / emacs 历史兼容值）；
 *   2. 将当前模式取反（normal → vim 或 vim → normal）；
 *   3. 将新模式持久化写入全局配置文件；
 *   4. 向分析服务上报模式切换事件；
 *   5. 返回对用户友好的文本提示，说明新模式的操作方式。
 *
 * 历史兼容说明：早期版本支持 'emacs' 模式，现已统一归并为 'normal'，
 * 读取到 'emacs' 时直接视为 'normal' 处理，避免旧配置导致异常。
 */
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

/**
 * vim 命令的执行函数，负责读取当前模式、取反并持久化，最后返回提示文本。
 *
 * 执行流程：
 *   1. 读取全局配置中的 editorMode 字段，默认为 'normal'；
 *   2. 将历史遗留的 'emacs' 值标准化为 'normal'（向后兼容）；
 *   3. 计算新模式：normal ↔ vim 互切；
 *   4. 保存新模式到全局配置（不覆盖其他配置项）；
 *   5. 上报 tengu_editor_mode_changed 分析事件（记录新模式和触发来源）；
 *   6. 返回描述新模式操作方式的文本提示。
 */
export const call: LocalCommandCall = async () => {
  // 读取全局配置，若 editorMode 未设置则默认为 'normal'
  const config = getGlobalConfig()
  let currentMode = config.editorMode || 'normal'

  // 向后兼容处理：早期版本存在 'emacs' 模式，现统一视为 'normal'
  if (currentMode === 'emacs') {
    currentMode = 'normal'
  }

  // 计算切换后的目标模式：normal → vim，vim → normal
  const newMode = currentMode === 'normal' ? 'vim' : 'normal'

  // 使用 updater 函数更新全局配置，保留其他配置项不变
  saveGlobalConfig(current => ({
    ...current,
    editorMode: newMode,
  }))

  // 上报编辑器模式切换事件，记录新模式值和触发来源（命令触发）
  logEvent('tengu_editor_mode_changed', {
    mode: newMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    // source 标识本次切换由用户主动执行 /vim 命令触发（而非配置文件变更等其他来源）
    source:
      'command' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  // 根据切换结果返回对应的操作说明：vim 模式提示 Escape 用法，normal 模式提示 readline 键位
  return {
    type: 'text',
    value: `Editor mode set to ${newMode}. ${
      newMode === 'vim'
        ? 'Use Escape key to toggle between INSERT and NORMAL modes.'
        : 'Using standard (readline) keyboard bindings.'
    }`,
  }
}
