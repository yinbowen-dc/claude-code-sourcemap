/**
 * Claude in Chrome MCP 服务端进程模块。
 *
 * 在 Claude Code 系统中，该模块启动 Claude for Chrome MCP 服务端进程，
 * 建立 stdio 传输层并处理认证、遥测初始化和许可权限模式：
 * - 读取 OAuth tokens 并配置 ClaudeForChromeContext
 * - 初始化 analytics sink 和 Datadog/1P 事件日志
 * - 通过 StdioServerTransport 连接 MCP server
 * - 退出时优雅关闭遥测
 */
import {
  type ClaudeForChromeContext,
  createClaudeForChromeMcpServer,
  type Logger,
  type PermissionMode,
} from '@ant/claude-for-chrome-mcp'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { format } from 'util'
import { shutdownDatadog } from '../../services/analytics/datadog.js'
import { shutdown1PEventLogging } from '../../services/analytics/firstPartyEventLogger.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { initializeAnalyticsSink } from '../../services/analytics/sink.js'
import { getClaudeAIOAuthTokens } from '../auth.js'
import { enableConfigs, getGlobalConfig, saveGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { sideQuery } from '../sideQuery.js'
import { getAllSocketPaths, getSecureSocketPath } from './common.js'

const EXTENSION_DOWNLOAD_URL = 'https://claude.ai/chrome'
const BUG_REPORT_URL =
  'https://github.com/anthropics/claude-code/issues/new?labels=bug,claude-in-chrome'

// String metadata keys safe to forward to analytics. Keys like error_message
// are excluded because they could contain page content or user data.
const SAFE_BRIDGE_STRING_KEYS = new Set([
  'bridge_status',
  'error_type',
  'tool_name',
])

const PERMISSION_MODES: readonly PermissionMode[] = [
  'ask',
  'skip_all_permission_checks',
  'follow_a_plan',
]

/**
 * 判断给定字符串是否为合法的 PermissionMode 枚举值。
 * 用于在读取环境变量 CLAUDE_CHROME_PERMISSION_MODE 时进行类型收窄。
 *
 * @param raw 从环境变量读取的原始字符串
 * @returns 若为合法 PermissionMode 则返回 true，否则 false
 */
function isPermissionMode(raw: string): raw is PermissionMode {
  return PERMISSION_MODES.some(m => m === raw)
}

/**
 * 根据环境变量和功能开关解析 Chrome bridge WebSocket URL。
 *
 * 优先级（从高到低）：
 * 1. ant 内部用户（USER_TYPE=ant）始终启用 bridge
 * 2. GrowthBook 功能开关 tengu_copper_bridge 为 true 时启用
 * 3. 未启用时返回 undefined，退回使用 native messaging socket
 *
 * URL 选择：
 * - USE_LOCAL_OAUTH 或 LOCAL_BRIDGE 为真 → ws://localhost:8765（本地开发）
 * - USE_STAGING_OAUTH 为真 → wss://bridge-staging.claudeusercontent.com（Staging 环境）
 * - 默认 → wss://bridge.claudeusercontent.com（生产环境）
 *
 * @returns bridge WebSocket URL，或 undefined（不使用 bridge）
 */
function getChromeBridgeUrl(): string | undefined {
  // ant 内部用户或功能开关开启时启用 bridge
  const bridgeEnabled =
    process.env.USER_TYPE === 'ant' ||
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_copper_bridge', false)

  if (!bridgeEnabled) {
    return undefined
  }

  // 本地开发或 LOCAL_BRIDGE 环境变量强制使用本地 WebSocket
  if (
    isEnvTruthy(process.env.USE_LOCAL_OAUTH) ||
    isEnvTruthy(process.env.LOCAL_BRIDGE)
  ) {
    return 'ws://localhost:8765'
  }

  // Staging 环境
  if (isEnvTruthy(process.env.USE_STAGING_OAUTH)) {
    return 'wss://bridge-staging.claudeusercontent.com'
  }

  // 生产环境 bridge 地址
  return 'wss://bridge.claudeusercontent.com'
}

/**
 * 判断当前是否使用本地 bridge（用于开发调试）。
 *
 * @returns USE_LOCAL_OAUTH 或 LOCAL_BRIDGE 环境变量任一为真时返回 true
 */
function isLocalBridge(): boolean {
  return (
    isEnvTruthy(process.env.USE_LOCAL_OAUTH) ||
    isEnvTruthy(process.env.LOCAL_BRIDGE)
  )
}

/**
 * 构建 ClaudeForChromeContext 配置对象，供 MCP 服务端进程和进程内路径共用。
 *
 * 配置内容包括：
 * - 服务端名称、日志器、socket 路径
 * - 认证错误 / 工具调用断连回调
 * - 扩展配对回调（写入全局配置）
 * - bridge 配置（含 OAuth token 获取和用户 ID）
 * - 许可模式（从环境变量 CLAUDE_CHROME_PERMISSION_MODE 读取）
 * - callAnthropicMessages（仅 ant 内部用户）：通过 sideQuery 执行 lightning 模式推理
 * - trackEvent：将 chrome-mcp 内部事件透传到 Claude Code 的 analytics 系统
 *
 * @param env 可选的环境变量覆盖映射（子进程传入时使用）
 * @returns 完整的 ClaudeForChromeContext 对象
 */
export function createChromeContext(
  env?: Record<string, string>,
): ClaudeForChromeContext {
  const logger = new DebugLogger()
  // 解析 bridge URL，决定使用 WebSocket bridge 还是 native socket
  const chromeBridgeUrl = getChromeBridgeUrl()
  logger.info(`Bridge URL: ${chromeBridgeUrl ?? 'none (using native socket)'}`)

  // 从 env 参数或 process.env 中读取权限模式配置
  const rawPermissionMode =
    env?.CLAUDE_CHROME_PERMISSION_MODE ??
    process.env.CLAUDE_CHROME_PERMISSION_MODE
  let initialPermissionMode: PermissionMode | undefined
  if (rawPermissionMode) {
    if (isPermissionMode(rawPermissionMode)) {
      initialPermissionMode = rawPermissionMode
    } else {
      // 非法权限模式值记录警告，不中断启动流程
      logger.warn(
        `Invalid CLAUDE_CHROME_PERMISSION_MODE "${rawPermissionMode}". Valid values: ${PERMISSION_MODES.join(', ')}`,
      )
    }
  }
  return {
    serverName: 'Claude in Chrome',
    logger,
    // 当前进程专属 socket 路径（供 chrome-mcp 绑定监听用）
    socketPath: getSecureSocketPath(),
    // 所有可能的 socket 路径（含旧版）供 MCP 客户端扫描连接用
    getSocketPaths: getAllSocketPaths,
    clientTypeId: 'claude-code',
    onAuthenticationError: () => {
      // 认证失败时提示用户检查账号一致性
      logger.warn(
        'Authentication error occurred. Please ensure you are logged into the Claude browser extension with the same claude.ai account as Claude Code.',
      )
    },
    onToolCallDisconnected: () => {
      // 工具调用时扩展未连接，返回用户可读的错误提示
      return `Browser extension is not connected. Please ensure the Claude browser extension is installed and running (${EXTENSION_DOWNLOAD_URL}), and that you are logged into claude.ai with the same account as Claude Code. If this is your first time connecting to Chrome, you may need to restart Chrome for the installation to take effect. If you continue to experience issues, please report a bug: ${BUG_REPORT_URL}`
    },
    onExtensionPaired: (deviceId: string, name: string) => {
      // 扩展配对成功：将配对设备 ID 和名称写入全局配置（幂等）
      saveGlobalConfig(config => {
        if (
          config.chromeExtension?.pairedDeviceId === deviceId &&
          config.chromeExtension?.pairedDeviceName === name
        ) {
          // 配置未变化，直接返回原对象，不触发写入
          return config
        }
        return {
          ...config,
          chromeExtension: {
            pairedDeviceId: deviceId,
            pairedDeviceName: name,
          },
        }
      })
      logger.info(`Paired with "${name}" (${deviceId.slice(0, 8)})`)
    },
    getPersistedDeviceId: () => {
      // 从全局配置中读取已持久化的配对设备 ID
      return getGlobalConfig().chromeExtension?.pairedDeviceId
    },
    // 仅在 bridge 启用时注入 bridgeConfig
    ...(chromeBridgeUrl && {
      bridgeConfig: {
        url: chromeBridgeUrl,
        // 获取当前 OAuth 账号的用户 UUID（用于 bridge 身份验证）
        getUserId: async () => {
          return getGlobalConfig().oauthAccount?.accountUuid
        },
        // 获取当前 OAuth access token（用于 bridge 鉴权头）
        getOAuthToken: async () => {
          return getClaudeAIOAuthTokens()?.accessToken ?? ''
        },
        // 本地开发模式下注入固定 dev 用户 ID，跳过真实身份验证
        ...(isLocalBridge() && { devUserId: 'dev_user_local' }),
      },
    }),
    // 仅在读取到合法权限模式时注入
    ...(initialPermissionMode && { initialPermissionMode }),
    // Wire inference for the browser_task tool — the chrome-mcp server runs
    // a lightning-mode agent loop in Node and calls the extension's
    // lightning_turn tool once per iteration for execution.
    //
    // Ant-only: the extension's lightning_turn is build-time-gated via
    // import.meta.env.ANT_ONLY_BUILD — the whole lightning/ module graph is
    // tree-shaken from the public extension build (build:prod greps for a
    // marker to verify). Without this injection, the Node MCP server's
    // ListTools also filters browser_task + lightning_turn out, so external
    // users never see the tools advertised. Three independent gates.
    //
    // Types inlined: AnthropicMessagesRequest/Response live in
    // @ant/claude-for-chrome-mcp@0.4.0 which isn't published yet. CI installs
    // 0.3.0. The callAnthropicMessages field is also 0.4.0-only, but spreading
    // an extra property into ClaudeForChromeContext is fine against either
    // version — 0.3.0 sees an unknown field (allowed in spread), 0.4.0 sees a
    // structurally-matching one. Once 0.4.0 is published, this can switch to
    // the package's exported types and the dep can be bumped.
    //
    // 仅 ant 内部用户注入 callAnthropicMessages（lightning 推理通道）
    ...(process.env.USER_TYPE === 'ant' && {
      callAnthropicMessages: async (req: {
        model: string
        max_tokens: number
        system: string
        messages: Parameters<typeof sideQuery>[0]['messages']
        stop_sequences?: string[]
        signal?: AbortSignal
      }): Promise<{
        content: Array<{ type: 'text'; text: string }>
        stop_reason: string | null
        usage?: { input_tokens: number; output_tokens: number }
      }> => {
        // sideQuery handles OAuth attribution fingerprint, proxy, model betas.
        // skipSystemPromptPrefix: the lightning prompt is complete on its own;
        // the CLI prefix would dilute the batching instructions.
        // tools: [] is load-bearing — without it Sonnet emits
        // <function_calls> XML before the text commands. Original
        // lightning-harness.js (apps repo) does the same.
        //
        // sideQuery 处理 OAuth 签名、代理、模型 beta 版本等；
        // skipSystemPromptPrefix 避免 CLI 前缀污染 lightning 系统提示；
        // tools: [] 是必须的——否则 Sonnet 会输出 XML 格式工具调用
        const response = await sideQuery({
          model: req.model,
          system: req.system,
          messages: req.messages,
          max_tokens: req.max_tokens,
          stop_sequences: req.stop_sequences,
          signal: req.signal,
          skipSystemPromptPrefix: true,
          tools: [],
          querySource: 'chrome_mcp',
        })
        // BetaContentBlock is TextBlock | ThinkingBlock | ToolUseBlock | ...
        // Only text blocks carry the model's command output.
        // 仅提取 text 类型 block，忽略 thinking/tool_use 等其他类型
        const textBlocks: Array<{ type: 'text'; text: string }> = []
        for (const b of response.content) {
          if (b.type === 'text') {
            textBlocks.push({ type: 'text', text: b.text })
          }
        }
        return {
          content: textBlocks,
          stop_reason: response.stop_reason,
          usage: {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
          },
        }
      },
    }),
    trackEvent: (eventName, metadata) => {
      // 将 chrome-mcp 内部事件转发到 Claude Code analytics，过滤非安全字段
      const safeMetadata: {
        [key: string]:
          | boolean
          | number
          | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          | undefined
      } = {}
      if (metadata) {
        for (const [key, value] of Object.entries(metadata)) {
          // Rename 'status' to 'bridge_status' to avoid Datadog's reserved field
          // 'status' 是 Datadog 保留字段名，重命名为 bridge_status 避免冲突
          const safeKey = key === 'status' ? 'bridge_status' : key
          if (typeof value === 'boolean' || typeof value === 'number') {
            // 布尔和数值类型安全无条件转发
            safeMetadata[safeKey] = value
          } else if (
            typeof value === 'string' &&
            SAFE_BRIDGE_STRING_KEYS.has(safeKey)
          ) {
            // Only forward allowlisted string keys — fields like error_message
            // could contain page content or user data
            // 字符串类型仅转发白名单字段，防止页面内容或用户数据泄露到 analytics
            safeMetadata[safeKey] =
              value as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          }
        }
      }
      logEvent(eventName, safeMetadata)
    },
  }
}

/**
 * Claude in Chrome MCP 服务端进程主入口函数。
 *
 * 执行流程：
 * 1. 启用全局配置读写（enableConfigs）
 * 2. 初始化 analytics sink（Datadog / 1P 事件日志）
 * 3. 构建 ClaudeForChromeContext 并创建 MCP 服务端实例
 * 4. 创建 StdioServerTransport，通过 stdio 与 MCP 客户端通信
 * 5. 订阅 stdin end/error 事件：父进程退出时优雅刷新 analytics 并退出
 * 6. 连接 transport，启动 MCP 服务端开始处理请求
 */
export async function runClaudeInChromeMcpServer(): Promise<void> {
  // 启用全局配置持久化（允许读写 ~/.claude/config.json）
  enableConfigs()
  // 初始化 analytics sink，后续事件将通过此 sink 上报
  initializeAnalyticsSink()
  // 构建 Chrome 上下文配置，包含 socket/bridge/认证/事件追踪等
  const context = createChromeContext()

  const server = createClaudeForChromeMcpServer(context)
  const transport = new StdioServerTransport()

  // Exit when parent process dies (stdin pipe closes).
  // Flush analytics before exiting so final-batch events (e.g. disconnect) aren't lost.
  // 父进程退出（stdin 关闭）时优雅刷新 analytics 再退出，确保最后一批事件不丢失
  let exiting = false
  const shutdownAndExit = async (): Promise<void> => {
    if (exiting) {
      return
    }
    exiting = true
    // 按顺序刷新 1P 事件日志和 Datadog，确保全部上报完成
    await shutdown1PEventLogging()
    await shutdownDatadog()
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  }
  // stdin 正常关闭或出错时均触发优雅退出
  process.stdin.on('end', () => void shutdownAndExit())
  process.stdin.on('error', () => void shutdownAndExit())

  logForDebugging('[Claude in Chrome] Starting MCP server')
  // 连接 transport，开始通过 stdio 处理 MCP 协议消息
  await server.connect(transport)
  logForDebugging('[Claude in Chrome] MCP server started')
}

/**
 * 调试日志器：实现 @ant/claude-for-chrome-mcp 的 Logger 接口，
 * 将所有日志级别统一转发给 Claude Code 的 logForDebugging 工具函数。
 *
 * 各方法使用 util.format 将 printf 风格参数格式化为字符串，
 * 再附带对应的 level 标签写入调试日志文件。
 */
class DebugLogger implements Logger {
  /** 最详细的 silly 级别调试日志 */
  silly(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'debug' })
  }
  /** 调试级别日志 */
  debug(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'debug' })
  }
  /** 信息级别日志 */
  info(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'info' })
  }
  /** 警告级别日志 */
  warn(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'warn' })
  }
  /** 错误级别日志 */
  error(message: string, ...args: unknown[]): void {
    logForDebugging(format(message, ...args), { level: 'error' })
  }
}
