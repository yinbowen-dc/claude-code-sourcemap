/**
 * Swarm 跨后端通用 spawn 工具函数（spawnUtils.ts）
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本模块属于 Swarm 多智能体架构的底层工具层，被 tmux 后端、iTerm2 后端等
 * 所有 pane 型 spawn 路径共同使用。它抽象了"如何启动一个 teammate 进程"的
 * 公共逻辑，包括可执行文件路径选择、CLI 参数继承以及环境变量透传。
 *
 * 【主要职责】
 * 1. 确定 teammate 进程的可执行文件路径（支持环境变量覆盖）；
 * 2. 构建需要从 leader 进程透传给 teammate 进程的 CLI 标志；
 * 3. 构建需要显式转发给 tmux 等外部终端会话的环境变量字符串。
 */

import {
  getChromeFlagOverride,
  getFlagSettingsPath,
  getInlinePlugins,
  getMainLoopModelOverride,
  getSessionBypassPermissionsMode,
} from '../../bootstrap/state.js'
import { quote } from '../bash/shellQuote.js'
import { isInBundledMode } from '../bundledMode.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { getTeammateModeFromSnapshot } from './backends/teammateModeSnapshot.js'
import { TEAMMATE_COMMAND_ENV_VAR } from './constants.js'

/**
 * 获取用于 spawn teammate 进程的可执行文件路径。
 *
 * 【执行流程】
 * 1. 优先读取环境变量 TEAMMATE_COMMAND_ENV_VAR，允许外部（如测试环境）覆盖；
 * 2. 若为 bundled 模式（打包后的二进制），使用 process.execPath（Node 可执行文件本身）；
 * 3. 否则使用 process.argv[1]（当前脚本路径，适用于开发模式）。
 *
 * @returns 可执行文件的完整路径字符串
 */
export function getTeammateCommand(): string {
  // 若外部通过环境变量指定了命令，优先使用（方便测试和自定义部署）
  if (process.env[TEAMMATE_COMMAND_ENV_VAR]) {
    return process.env[TEAMMATE_COMMAND_ENV_VAR]
  }
  // bundled 模式用 execPath，开发模式用脚本路径
  return isInBundledMode() ? process.execPath : process.argv[1]!
}

/**
 * 构建需要从当前会话（leader）透传给 teammate 进程的 CLI 标志字符串。
 *
 * 【执行流程】
 * 1. 根据 planModeRequired 和 permissionMode 决定是否透传 --dangerously-skip-permissions
 *    或 --permission-mode acceptEdits；
 * 2. 若 leader 通过 --model 指定了模型，透传给 teammate；
 * 3. 若 leader 通过 --settings 指定了配置文件路径，透传给 teammate；
 * 4. 透传每个 --plugin-dir 内联插件目录；
 * 5. 透传 --teammate-mode 保证 tmux teammate 使用与 leader 相同的模式；
 * 6. 若 leader 显式指定了 --chrome / --no-chrome，也一并透传。
 *
 * @param options.planModeRequired - 若为 true，则不继承 bypass permissions（计划模式优先）
 * @param options.permissionMode   - 要透传的权限模式
 * @returns 由空格拼接的 CLI 标志字符串
 */
export function buildInheritedCliFlags(options?: {
  planModeRequired?: boolean
  permissionMode?: PermissionMode
}): string {
  const flags: string[] = []
  const { planModeRequired, permissionMode } = options || {}

  // 权限模式透传：计划模式优先于 bypassPermissions（安全考虑）
  if (planModeRequired) {
    // 若要求计划模式，则不继承 bypass permissions
  } else if (
    permissionMode === 'bypassPermissions' ||
    getSessionBypassPermissionsMode()
  ) {
    // 透传危险的跳过权限标志
    flags.push('--dangerously-skip-permissions')
  } else if (permissionMode === 'acceptEdits') {
    // 透传接受编辑权限模式
    flags.push('--permission-mode acceptEdits')
  }

  // 若 leader 通过 --model 显式指定了模型，透传给 teammate
  const modelOverride = getMainLoopModelOverride()
  if (modelOverride) {
    flags.push(`--model ${quote([modelOverride])}`)
  }

  // 若通过 --settings 指定了配置文件路径，透传给 teammate
  const settingsPath = getFlagSettingsPath()
  if (settingsPath) {
    flags.push(`--settings ${quote([settingsPath])}`)
  }

  // 透传每个内联插件目录（每个插件单独一个 --plugin-dir 标志）
  const inlinePlugins = getInlinePlugins()
  for (const pluginDir of inlinePlugins) {
    flags.push(`--plugin-dir ${quote([pluginDir])}`)
  }

  // 透传 --teammate-mode，确保 tmux teammate 与 leader 使用相同的模式
  const sessionMode = getTeammateModeFromSnapshot()
  flags.push(`--teammate-mode ${sessionMode}`)

  // 若 leader 显式设置了 --chrome 或 --no-chrome，同步给 teammate
  const chromeFlagOverride = getChromeFlagOverride()
  if (chromeFlagOverride === true) {
    flags.push('--chrome')
  } else if (chromeFlagOverride === false) {
    flags.push('--no-chrome')
  }

  // 将所有标志用空格拼接为单一字符串
  return flags.join(' ')
}

/**
 * 需要显式转发给 tmux spawn 命令的环境变量列表。
 *
 * 【背景说明】
 * tmux 可能启动一个新的 login shell，该 shell 不会继承父进程的环境变量，
 * 因此凡是 leader 进程中已设置的关键环境变量都需要在 spawn 命令中显式透传。
 */
const TEAMMATE_ENV_VARS = [
  // API 提供商选择——缺少这些变量时，teammate 会默认走 firstParty 路径（GitHub issue #23561）
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  // 自定义 API 端点
  'ANTHROPIC_BASE_URL',
  // 配置目录覆盖
  'CLAUDE_CONFIG_DIR',
  // CCR（远程执行）标记——teammate 需要此标记以走 CCR 感知代码路径
  'CLAUDE_CODE_REMOTE',
  // 自动内存开关：REMOTE && !MEMORY_DIR 会禁用临时文件系统上的内存，需同步透传
  'CLAUDE_CODE_REMOTE_MEMORY_DIR',
  // 上游代理——父进程的 MITM 中继可被 teammate 访问（同一容器网络），透传代理变量以保证流量路由正确
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const

/**
 * 构建用于 teammate spawn 命令的 `env KEY=VALUE ...` 字符串。
 *
 * 【执行流程】
 * 1. 始终包含 CLAUDECODE=1 和 CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1；
 * 2. 遍历 TEAMMATE_ENV_VARS 列表，将当前进程中已设置的变量追加到结果中；
 * 3. 所有值经过 shell 转义（quote）以防止注入。
 *
 * @returns 形如 "CLAUDECODE=1 KEY1=val1 KEY2=val2 ..." 的字符串
 */
export function buildInheritedEnvVars(): string {
  // 始终包含 Claude Code 标识和实验性团队特性标记
  const envVars = ['CLAUDECODE=1', 'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1']

  // 遍历需要透传的环境变量列表，仅添加当前进程中已设置且非空的变量
  for (const key of TEAMMATE_ENV_VARS) {
    const value = process.env[key]
    if (value !== undefined && value !== '') {
      // 对变量值进行 shell 转义，防止特殊字符导致命令解析错误
      envVars.push(`${key}=${quote([value])}`)
    }
  }

  // 用空格拼接为单一字符串，直接插入 spawn 命令中
  return envVars.join(' ')
}
