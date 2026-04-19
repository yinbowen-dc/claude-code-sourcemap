/**
 * McpAuthTool.ts — MCP OAuth 认证伪工具实现
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件实现了 MCP OAuth 认证伪工具（pseudo-tool）。
 * 当某个 MCP 服务器已安装但尚未完成 OAuth 认证时，
 * 系统会为该服务器生成一个认证伪工具，替代其真实工具列表展示给模型。
 * 这样模型能感知到服务器的存在，并能代表用户启动 OAuth 授权流程。
 *
 * 【主要功能】
 * 1. createMcpAuthTool()：工厂函数，为指定 MCP 服务器创建认证伪工具
 *    - 工具名称格式：mcp__<serverName>__authenticate
 *    - 仅支持 sse/http 传输类型（其他类型返回 unsupported 提示）
 *    - claudeai-proxy 类型特殊处理：引导用户通过 /mcp 界面认证
 * 2. call() 核心流程：
 *    - 启动 performMCPOAuthFlow（skipBrowserOpen: true，不自动打开浏览器）
 *    - 通过 onAuthorizationUrl 回调捕获授权 URL
 *    - Promise.race：authUrlPromise vs oauthPromise（静默认证路径）
 *    - 立即返回授权 URL 给模型，由模型将 URL 转发给用户
 * 3. 后台续传（Background Continuation）：
 *    - oauthPromise 完成后：clearMcpAuthCache → reconnectMcpServerImpl
 *    - 通过 setAppState 将真实工具注入 appState.mcp.tools
 *    - 使用 prefix-based 替换（reject + prefix）自动移除认证伪工具
 * 4. getConfigUrl()：从 ScopedMcpServerConfig 提取服务器 URL（stdio 类型无 URL）
 * 5. McpAuthOutput 类型：{ status, message, authUrl? }
 */

import reject from 'lodash-es/reject.js'
import { z } from 'zod/v4'
import { performMCPOAuthFlow } from '../../services/mcp/auth.js'
import {
  clearMcpAuthCache,
  reconnectMcpServerImpl,
} from '../../services/mcp/client.js'
import {
  buildMcpToolName,
  getMcpPrefix,
} from '../../services/mcp/mcpStringUtils.js'
import type {
  McpHTTPServerConfig,
  McpSSEServerConfig,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import type { Tool } from '../../Tool.js'
import { errorMessage } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logMCPDebug, logMCPError } from '../../utils/log.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'

/** 输入 Schema（懒加载）：认证工具不需要任何参数，使用空对象 Schema */
const inputSchema = lazySchema(() => z.object({}))
type InputSchema = ReturnType<typeof inputSchema>

/**
 * MCP OAuth 认证工具的输出类型。
 * - status: 'auth_url' → 返回授权 URL；'unsupported' → 传输类型不支持；'error' → 流程失败
 * - message: 面向用户/模型的说明文字
 * - authUrl: OAuth 授权 URL（status === 'auth_url' 时存在）
 */
export type McpAuthOutput = {
  status: 'auth_url' | 'unsupported' | 'error'
  message: string
  authUrl?: string
}

/**
 * 从 ScopedMcpServerConfig 中提取服务器 URL。
 * stdio 类型的配置没有 url 字段，返回 undefined。
 *
 * @param config - MCP 服务器配置（含 scope 信息）
 * @returns 服务器 URL 字符串，或 undefined（stdio 类型）
 */
function getConfigUrl(config: ScopedMcpServerConfig): string | undefined {
  if ('url' in config) return config.url
  return undefined
}

/**
 * 为尚未完成 OAuth 认证的 MCP 服务器创建认证伪工具。
 *
 * 设计背景：
 * MCP 服务器在连接时收到 HTTP 401（UnauthorizedError）时，
 * 其状态会被标记为 needs-auth。此时系统用本伪工具替代其真实工具列表，
 * 使模型能感知到服务器存在，并能主动触发 OAuth 认证流程。
 *
 * call() 执行流程：
 * 1. claudeai-proxy 类型：返回 unsupported，引导用户通过 /mcp 界面认证
 * 2. 非 sse/http 类型：返回 unsupported（理论上不应到达，防御性处理）
 * 3. sse/http 类型：
 *    a. 启动 performMCPOAuthFlow（skipBrowserOpen: true）
 *    b. 通过 authUrlPromise 捕获授权 URL
 *    c. Promise.race(authUrlPromise, oauthPromise) 处理两种路径：
 *       - 正常路径：获取到 authUrl，返回给模型，由模型转发给用户
 *       - 静默认证路径（如 XAA 有缓存 IdP Token）：oauthPromise 先完成，直接返回成功
 * 4. 后台续传（void，不 await）：
 *    - OAuth 完成后调用 clearMcpAuthCache() + reconnectMcpServerImpl()
 *    - 通过 setAppState 将真实工具替换认证伪工具
 *
 * @param serverName - MCP 服务器名称
 * @param config - MCP 服务器配置（含传输类型和 URL）
 * @returns 认证伪工具对象（满足 Tool<InputSchema, McpAuthOutput> 接口）
 */
export function createMcpAuthTool(
  serverName: string,
  config: ScopedMcpServerConfig,
): Tool<InputSchema, McpAuthOutput> {
  const url = getConfigUrl(config)
  const transport = config.type ?? 'stdio'
  // 格式化服务器位置描述，用于工具说明文字中
  const location = url ? `${transport} at ${url}` : transport

  // 工具说明：告知模型该服务器需要认证，调用本工具可启动 OAuth 流程
  const description =
    `The \`${serverName}\` MCP server (${location}) is installed but requires authentication. ` +
    `Call this tool to start the OAuth flow — you'll receive an authorization URL to share with the user. ` +
    `Once the user completes authorization in their browser, the server's real tools will become available automatically.`

  return {
    // 工具名称格式：mcp__<serverName>__authenticate
    name: buildMcpToolName(serverName, 'authenticate'),
    isMcp: true,
    mcpInfo: { serverName, toolName: 'authenticate' },
    isEnabled: () => true,
    isConcurrencySafe: () => false,  // OAuth 流程含状态变更，不可并发
    isReadOnly: () => false,          // 认证会修改连接状态
    toAutoClassifierInput: () => serverName,
    userFacingName: () => `${serverName} - authenticate (MCP)`,
    maxResultSizeChars: 10_000,
    renderToolUseMessage: () => `Authenticate ${serverName} MCP server`,
    async description() {
      return description
    },
    async prompt() {
      return description
    },
    /** 懒加载输入 Schema（空对象） */
    get inputSchema(): InputSchema {
      return inputSchema()
    },
    /** 认证工具自动允许执行，无需额外权限检查 */
    async checkPermissions(input): Promise<PermissionDecision> {
      return { behavior: 'allow', updatedInput: input }
    },
    /**
     * 执行 OAuth 认证流程。
     *
     * 支持三种路径：
     * 1. claudeai-proxy → unsupported（引导用户使用 /mcp 界面）
     * 2. 非 sse/http 传输 → unsupported（不支持程序化 OAuth）
     * 3. sse/http → 启动 OAuth，返回授权 URL 或静默完成消息
     */
    async call(_input, context) {
      // claude.ai 连接器使用独立的认证流程（handleClaudeAIAuth），
      // 不在此处程序化调用，引导用户通过 /mcp 界面操作
      if (config.type === 'claudeai-proxy') {
        return {
          data: {
            status: 'unsupported' as const,
            message: `This is a claude.ai MCP connector. Ask the user to run /mcp and select "${serverName}" to authenticate.`,
          },
        }
      }

      // performMCPOAuthFlow 仅支持 sse/http 传输类型。
      // needs-auth 状态仅在 HTTP 401 时设置，其他传输类型理论上不会到达此处，
      // 但作防御性处理
      if (config.type !== 'sse' && config.type !== 'http') {
        return {
          data: {
            status: 'unsupported' as const,
            message: `Server "${serverName}" uses ${transport} transport which does not support OAuth from this tool. Ask the user to run /mcp and authenticate manually.`,
          },
        }
      }

      const sseOrHttpConfig = config as (
        | McpSSEServerConfig
        | McpHTTPServerConfig
      ) & { scope: ScopedMcpServerConfig['scope'] }

      // 通过 Promise + 回调捕获授权 URL。
      // onAuthorizationUrl 回调触发时 resolve authUrlPromise，
      // 不等待 OAuth 完整流程（那是后台续传的职责）。
      let resolveAuthUrl: ((url: string) => void) | undefined
      const authUrlPromise = new Promise<string>(resolve => {
        resolveAuthUrl = resolve
      })

      const controller = new AbortController()
      const { setAppState } = context

      // 启动 OAuth 流程（skipBrowserOpen: true，不自动打开浏览器）
      const oauthPromise = performMCPOAuthFlow(
        serverName,
        sseOrHttpConfig,
        u => resolveAuthUrl?.(u),  // 捕获授权 URL
        controller.signal,
        { skipBrowserOpen: true },
      )

      // 后台续传：OAuth 完成后重新连接，将真实工具替换认证伪工具
      // 使用 void（fire-and-forget），不阻塞当前 call() 的返回
      void oauthPromise
        .then(async () => {
          // 清除认证缓存，确保使用新 token
          clearMcpAuthCache()
          // 重新连接 MCP 服务器，获取真实工具列表
          const result = await reconnectMcpServerImpl(serverName, config)
          const prefix = getMcpPrefix(serverName)
          // 通过 setAppState 将真实工具注入全局状态，
          // 同时移除以 prefix 开头的认证伪工具（prefix-based 替换）
          setAppState(prev => ({
            ...prev,
            mcp: {
              ...prev.mcp,
              // 更新客户端连接状态
              clients: prev.mcp.clients.map(c =>
                c.name === serverName ? result.client : c,
              ),
              // 移除旧工具（含认证伪工具），添加新真实工具
              tools: [
                ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                ...result.tools,
              ],
              // 移除旧命令，添加新命令
              commands: [
                ...reject(prev.mcp.commands, c => c.name?.startsWith(prefix)),
                ...result.commands,
              ],
              // 更新资源列表（如果有）
              resources: result.resources
                ? { ...prev.mcp.resources, [serverName]: result.resources }
                : prev.mcp.resources,
            },
          }))
          logMCPDebug(
            serverName,
            `OAuth complete, reconnected with ${result.tools.length} tool(s)`,
          )
        })
        .catch(err => {
          logMCPError(
            serverName,
            `OAuth flow failed after tool-triggered start: ${errorMessage(err)}`,
          )
        })

      try {
        // Race 两种路径：
        // 1. authUrlPromise：获取到授权 URL → 返回给模型
        // 2. oauthPromise：静默完成（如 XAA 使用缓存 IdP Token）→ null
        const authUrl = await Promise.race([
          authUrlPromise,
          oauthPromise.then(() => null as string | null),
        ])

        if (authUrl) {
          // 正常路径：返回授权 URL，由模型将其转发给用户
          return {
            data: {
              status: 'auth_url' as const,
              authUrl,
              message: `Ask the user to open this URL in their browser to authorize the ${serverName} MCP server:\n\n${authUrl}\n\nOnce they complete the flow, the server's tools will become available automatically.`,
            },
          }
        }

        // 静默认证路径：OAuth 已完成，无需用户操作
        return {
          data: {
            status: 'auth_url' as const,
            message: `Authentication completed silently for ${serverName}. The server's tools should now be available.`,
          },
        }
      } catch (err) {
        // OAuth 流程启动失败时的错误处理
        return {
          data: {
            status: 'error' as const,
            message: `Failed to start OAuth flow for ${serverName}: ${errorMessage(err)}. Ask the user to run /mcp and authenticate manually.`,
          },
        }
      }
    },
    /**
     * 将工具结果映射为 Anthropic API 的 tool_result 消息格式。
     * 直接使用 data.message 作为内容返回给模型。
     */
    mapToolResultToToolResultBlockParam(data, toolUseID) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: data.message,
      }
    },
  } satisfies Tool<InputSchema, McpAuthOutput>
}
