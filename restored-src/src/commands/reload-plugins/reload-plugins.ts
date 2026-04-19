/**
 * reload-plugins/reload-plugins.ts —— /reload-plugins 命令的核心执行逻辑
 *
 * 在整体流程中的位置：
 *   /reload-plugins 命令触发 → 懒加载本模块 → 调用 call(args, context)
 *   → （可选）重新下载用户设置 → 刷新活跃插件列表 → 返回刷新摘要文本
 *
 * 主要流程：
 *   1. 若运行于 CCR（Cloud Code Remote）远程模式且功能开关启用，
 *      重新拉取用户设置（enabledPlugins / extraKnownMarketplaces），
 *      确保 CLI 本地写入的 settingsSync 变更能及时生效。
 *      注意：受管理的 org 设置不在此重拉，由定时轮询负责。
 *   2. 调用 refreshActivePlugins 扫描并重新加载所有启用的插件，
 *      更新 app state 中的命令、Agent、MCP/LSP 服务器列表。
 *   3. 构造人类可读的摘要字符串，包含插件数、技能数、Agent 数、
 *      Hook 数、MCP 服务器数、LSP 服务器数及加载错误数。
 */
import { feature } from 'bun:bundle'
import { getIsRemoteMode } from '../../bootstrap/state.js'
import { redownloadUserSettings } from '../../services/settingsSync/index.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { refreshActivePlugins } from '../../utils/plugins/refresh.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { plural } from '../../utils/stringUtils.js'

/**
 * call —— /reload-plugins 命令的执行入口
 *
 * 流程：
 *   1. 远程模式（CCR）下重新下载用户设置，并触发 settingsChangeDetector
 *      的 notifyChange，使 applySettingsChange 在会话中途也能感知变更
 *   2. 调用 refreshActivePlugins 完成插件的完整重载周期（扫描→校验→注册）
 *   3. 将刷新结果的各项计数格式化为可读摘要，有错误时追加诊断提示
 *
 * @param _args   用户传入的参数（本命令忽略）
 * @param context 命令执行上下文，包含 setAppState 用于更新全局 app 状态
 */
export const call: LocalCommandCall = async (_args, context) => {
  // CCR: re-pull user settings before the cache sweep so enabledPlugins /
  // extraKnownMarketplaces pushed from the user's local CLI (settingsSync)
  // take effect. Non-CCR headless (e.g. vscode SDK subprocess) shares disk
  // with whoever writes settings — the file watcher delivers changes, no
  // re-pull needed there.
  //
  // Managed settings intentionally NOT re-fetched: it already polls hourly
  // (POLLING_INTERVAL_MS), and policy enforcement is eventually-consistent
  // by design (stale-cache fallback on fetch failure). Interactive
  // /reload-plugins has never re-fetched it either.
  //
  // No retries: user-initiated command, one attempt + fail-open. The user
  // can re-run /reload-plugins to retry. Startup path keeps its retries.
  if (
    feature('DOWNLOAD_USER_SETTINGS') && // 功能开关：是否启用用户设置下载
    (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) || getIsRemoteMode()) // 仅 CCR 远程模式触发
  ) {
    const applied = await redownloadUserSettings() // 从服务端拉取最新用户设置
    // applyRemoteEntriesToLocal uses markInternalWrite to suppress the
    // file watcher (correct for startup, nothing listening yet); fire
    // notifyChange here so mid-session applySettingsChange runs.
    // 启动阶段 applyRemoteEntriesToLocal 使用 markInternalWrite 抑制文件监听器；
    // 此处手动触发 notifyChange，使会话中途的设置变更检测器正常感知到更新
    if (applied) {
      settingsChangeDetector.notifyChange('userSettings')
    }
  }

  // 执行插件完整重载：扫描启用插件 → 校验 → 注册命令/Agent/MCP/LSP
  const r = await refreshActivePlugins(context.setAppState)

  // 构造各维度计数的摘要字符串，以" · "连接各项
  const parts = [
    n(r.enabled_count, 'plugin'),
    n(r.command_count, 'skill'),
    n(r.agent_count, 'agent'),
    n(r.hook_count, 'hook'),
    // "plugin MCP/LSP" disambiguates from user-config/built-in servers,
    // which /reload-plugins doesn't touch. Commands/hooks are plugin-only;
    // agent_count is total agents (incl. built-ins). (gh-31321)
    // 用 "plugin MCP/LSP server" 区分插件提供的与用户配置/内置的 MCP/LSP 服务器
    n(r.mcp_count, 'plugin MCP server'),
    n(r.lsp_count, 'plugin LSP server'),
  ]
  let msg = `Reloaded: ${parts.join(' · ')}`

  // 若有插件加载失败，追加错误计数并引导用户运行 /doctor 查看详情
  if (r.error_count > 0) {
    msg += `\n${n(r.error_count, 'error')} during load. Run /doctor for details.`
  }

  return { type: 'text', value: msg }
}

/**
 * n —— 生成"数量 + 单复数名词"的格式化字符串
 *
 * @param count  数量
 * @param noun   名词（singular form），plural 工具函数自动处理复数形式
 * @returns       例："3 plugins"、"1 skill"
 */
function n(count: number, noun: string): string {
  return `${count} ${plural(count, noun)}`
}
