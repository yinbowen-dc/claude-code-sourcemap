/**
 * MCP add CLI subcommand
 *
 * 在 Claude Code 命令体系中，本文件实现 `claude mcp add` 子命令，
 * 是 MCP（Model Context Protocol）服务器管理模块的核心入口之一。
 *
 * 该命令支持三种传输协议的 MCP 服务器注册：
 *   - stdio：通过子进程标准输入输出通信（默认协议）
 *   - sse：通过 Server-Sent Events 连接远程服务器
 *   - http：通过 HTTP Streamable 协议连接远程服务器
 *
 * 还支持 XAA（SEP-990）OAuth 认证扩展，用于需要企业 IdP 认证的 MCP 服务器。
 * 注册成功后配置写入对应作用域（local/user/project）的配置文件。
 *
 * Extracted from main.tsx to enable direct testing.
 */
import { type Command, Option } from '@commander-js/extra-typings'
import { cliError, cliOk } from '../../cli/exit.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  readClientSecret,
  saveMcpClientSecret,
} from '../../services/mcp/auth.js'
import { addMcpConfig } from '../../services/mcp/config.js'
import {
  describeMcpConfigFilePath,
  ensureConfigScope,
  ensureTransport,
  parseHeaders,
} from '../../services/mcp/utils.js'
import {
  getXaaIdpSettings,
  isXaaEnabled,
} from '../../services/mcp/xaaIdpLogin.js'
import { parseEnvVars } from '../../utils/envUtils.js'
import { jsonStringify } from '../../utils/slowOperations.js'

/**
 * registerMcpAddCommand — 注册 `mcp add` 子命令
 *
 * 将 `add` 子命令挂载到父级 mcp Commander 命令上，定义所有选项和执行逻辑：
 *   1. 解析命令行参数（name、commandOrUrl、args、各种选项）
 *   2. 校验必填参数（name、commandOrUrl 均不可缺失）
 *   3. 处理 XAA 模式的前置校验（需要 --client-id、--client-secret 及 IdP 配置）
 *   4. 根据传输协议分支处理：
 *      - sse/http：构造 URL 类型配置，处理 headers、OAuth 参数和 client secret
 *      - stdio：构造进程命令配置，处理环境变量，并对疑似 URL 的命令发出警告
 *   5. 调用 addMcpConfig 写入配置文件，输出操作结果
 *
 * @param mcp  父级 Commander 命令对象（由 mcp 命令模块传入）
 */
export function registerMcpAddCommand(mcp: Command): void {
  mcp
    .command('add <name> <commandOrUrl> [args...]')
    .description(
      'Add an MCP server to Claude Code.\n\n' +
        'Examples:\n' +
        '  # Add HTTP server:\n' +
        '  claude mcp add --transport http sentry https://mcp.sentry.dev/mcp\n\n' +
        '  # Add HTTP server with headers:\n' +
        '  claude mcp add --transport http corridor https://app.corridor.dev/api/mcp --header "Authorization: Bearer ..."\n\n' +
        '  # Add stdio server with environment variables:\n' +
        '  claude mcp add -e API_KEY=xxx my-server -- npx my-mcp-server\n\n' +
        '  # Add stdio server with subprocess flags:\n' +
        '  claude mcp add my-server -- my-command --some-flag arg1',
    )
    .option(
      '-s, --scope <scope>',
      'Configuration scope (local, user, or project)',
      'local',
    )
    .option(
      '-t, --transport <transport>',
      'Transport type (stdio, sse, http). Defaults to stdio if not specified.',
    )
    .option(
      '-e, --env <env...>',
      'Set environment variables (e.g. -e KEY=value)',
    )
    .option(
      '-H, --header <header...>',
      'Set WebSocket headers (e.g. -H "X-Api-Key: abc123" -H "X-Custom: value")',
    )
    .option('--client-id <clientId>', 'OAuth client ID for HTTP/SSE servers')
    .option(
      '--client-secret',
      'Prompt for OAuth client secret (or set MCP_CLIENT_SECRET env var)',
    )
    .option(
      '--callback-port <port>',
      'Fixed port for OAuth callback (for servers requiring pre-registered redirect URIs)',
    )
    .helpOption('-h, --help', 'Display help for command')
    .addOption(
      new Option(
        '--xaa',
        "Enable XAA (SEP-990) for this server. Requires 'claude mcp xaa setup' first. Also requires --client-id and --client-secret (for the MCP server's AS).",
      ).hideHelp(!isXaaEnabled()),
      // XAA 选项仅在 CLAUDE_CODE_ENABLE_XAA=1 时对用户可见
    )
    .action(async (name, commandOrUrl, args, options) => {
      // Commander.js 会自动处理 -- 分隔符：-- 之前的参数赋给 commandOrUrl，之后的赋给 args
      const actualCommand = commandOrUrl
      const actualArgs = args

      // 必填参数校验：name 和 command 都不能缺失
      if (!name) {
        cliError(
          'Error: Server name is required.\n' +
            'Usage: claude mcp add <name> <command> [args...]',
        )
      } else if (!actualCommand) {
        cliError(
          'Error: Command is required when server name is provided.\n' +
            'Usage: claude mcp add <name> <command> [args...]',
        )
      }

      try {
        // 校验并标准化 scope（local/user/project）和 transport（stdio/sse/http）
        const scope = ensureConfigScope(options.scope)
        const transport = ensureTransport(options.transport)

        // XAA 快速失败校验：在注册时而非认证时检测配置完整性，提前暴露问题
        if (options.xaa && !isXaaEnabled()) {
          cliError(
            'Error: --xaa requires CLAUDE_CODE_ENABLE_XAA=1 in your environment',
          )
        }
        const xaa = Boolean(options.xaa)
        if (xaa) {
          // XAA 模式需要：--client-id、--client-secret 和已配置的 IdP 设置
          const missing: string[] = []
          if (!options.clientId) missing.push('--client-id')
          if (!options.clientSecret) missing.push('--client-secret')
          if (!getXaaIdpSettings()) {
            missing.push(
              "'claude mcp xaa setup' (settings.xaaIdp not configured)",
            )
          }
          if (missing.length) {
            cliError(`Error: --xaa requires: ${missing.join(', ')}`)
          }
        }

        // 检查用户是否显式指定了 --transport（用于后续的 URL 误用警告判断）
        const transportExplicit = options.transport !== undefined

        // 启发式检测：命令参数是否看起来像 URL（可能是用户忘记指定 --transport）
        const looksLikeUrl =
          actualCommand.startsWith('http://') ||
          actualCommand.startsWith('https://') ||
          actualCommand.startsWith('localhost') ||
          actualCommand.endsWith('/sse') ||
          actualCommand.endsWith('/mcp')

        // 上报埋点：记录 MCP 服务器添加的协议类型、作用域和 URL 误用情况
        logEvent('tengu_mcp_add', {
          type: transport as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          scope:
            scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          source:
            'command' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          transport:
            transport as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          transportExplicit: transportExplicit,
          looksLikeUrl: looksLikeUrl,
        })

        if (transport === 'sse') {
          // SSE 协议：commandOrUrl 必须是 HTTP URL
          if (!actualCommand) {
            cliError('Error: URL is required for SSE transport.')
          }

          // 解析可选的自定义请求头（格式："Key: Value"）
          const headers = options.header
            ? parseHeaders(options.header)
            : undefined

          // 解析可选的 OAuth 回调固定端口（某些 IdP 要求预注册 redirect URI 端口）
          const callbackPort = options.callbackPort
            ? parseInt(options.callbackPort, 10)
            : undefined
          // 仅在提供了 OAuth 相关参数时才构造 oauth 配置对象
          const oauth =
            options.clientId || callbackPort || xaa
              ? {
                  ...(options.clientId ? { clientId: options.clientId } : {}),
                  ...(callbackPort ? { callbackPort } : {}),
                  ...(xaa ? { xaa: true } : {}),
                }
              : undefined

          // 读取 OAuth client secret（从环境变量 MCP_CLIENT_SECRET 或交互式提示）
          const clientSecret =
            options.clientSecret && options.clientId
              ? await readClientSecret()
              : undefined

          const serverConfig = {
            type: 'sse' as const,
            url: actualCommand,
            headers,
            oauth,
          }
          // 将服务器配置写入指定作用域的配置文件
          await addMcpConfig(name, serverConfig, scope)

          // 将 client secret 单独存入系统密钥链，不与普通配置混存
          if (clientSecret) {
            saveMcpClientSecret(name, serverConfig, clientSecret)
          }

          process.stdout.write(
            `Added SSE MCP server ${name} with URL: ${actualCommand} to ${scope} config\n`,
          )
          if (headers) {
            process.stdout.write(
              `Headers: ${jsonStringify(headers, null, 2)}\n`,
            )
          }
        } else if (transport === 'http') {
          // HTTP Streamable 协议：与 SSE 类似，但使用不同的连接机制
          if (!actualCommand) {
            cliError('Error: URL is required for HTTP transport.')
          }

          const headers = options.header
            ? parseHeaders(options.header)
            : undefined

          const callbackPort = options.callbackPort
            ? parseInt(options.callbackPort, 10)
            : undefined
          const oauth =
            options.clientId || callbackPort || xaa
              ? {
                  ...(options.clientId ? { clientId: options.clientId } : {}),
                  ...(callbackPort ? { callbackPort } : {}),
                  ...(xaa ? { xaa: true } : {}),
                }
              : undefined

          const clientSecret =
            options.clientSecret && options.clientId
              ? await readClientSecret()
              : undefined

          const serverConfig = {
            type: 'http' as const,
            url: actualCommand,
            headers,
            oauth,
          }
          await addMcpConfig(name, serverConfig, scope)

          if (clientSecret) {
            saveMcpClientSecret(name, serverConfig, clientSecret)
          }

          process.stdout.write(
            `Added HTTP MCP server ${name} with URL: ${actualCommand} to ${scope} config\n`,
          )
          if (headers) {
            process.stdout.write(
              `Headers: ${jsonStringify(headers, null, 2)}\n`,
            )
          }
        } else {
          // stdio 协议（默认）：通过子进程标准输入输出与 MCP 服务器通信
          if (
            options.clientId ||
            options.clientSecret ||
            options.callbackPort ||
            options.xaa
          ) {
            // 警告：OAuth 相关参数对 stdio 协议无效，提前告知用户避免困惑
            process.stderr.write(
              `Warning: --client-id, --client-secret, --callback-port, and --xaa are only supported for HTTP/SSE transports and will be ignored for stdio.\n`,
            )
          }

          // 用户可能误将 URL 当作 stdio 命令（忘记加 --transport），发出诊断警告
          if (!transportExplicit && looksLikeUrl) {
            process.stderr.write(
              `\nWarning: The command "${actualCommand}" looks like a URL, but is being interpreted as a stdio server as --transport was not specified.\n`,
            )
            process.stderr.write(
              `If this is an HTTP server, use: claude mcp add --transport http ${name} ${actualCommand}\n`,
            )
            process.stderr.write(
              `If this is an SSE server, use: claude mcp add --transport sse ${name} ${actualCommand}\n`,
            )
          }

          // 解析 -e KEY=VALUE 形式的环境变量，注入到子进程环境
          const env = parseEnvVars(options.env)
          await addMcpConfig(
            name,
            { type: 'stdio', command: actualCommand, args: actualArgs, env },
            scope,
          )

          process.stdout.write(
            `Added stdio MCP server ${name} with command: ${actualCommand} ${actualArgs.join(' ')} to ${scope} config\n`,
          )
        }
        // 操作成功：输出实际修改的配置文件路径
        cliOk(`File modified: ${describeMcpConfigFilePath(scope)}`)
      } catch (error) {
        cliError((error as Error).message)
      }
    })
}
  mcp
    .command('add <name> <commandOrUrl> [args...]')
    .description(
      'Add an MCP server to Claude Code.\n\n' +
        'Examples:\n' +
        '  # Add HTTP server:\n' +
        '  claude mcp add --transport http sentry https://mcp.sentry.dev/mcp\n\n' +
        '  # Add HTTP server with headers:\n' +
        '  claude mcp add --transport http corridor https://app.corridor.dev/api/mcp --header "Authorization: Bearer ..."\n\n' +
        '  # Add stdio server with environment variables:\n' +
        '  claude mcp add -e API_KEY=xxx my-server -- npx my-mcp-server\n\n' +
        '  # Add stdio server with subprocess flags:\n' +
        '  claude mcp add my-server -- my-command --some-flag arg1',
    )
    .option(
      '-s, --scope <scope>',
      'Configuration scope (local, user, or project)',
      'local',
    )
    .option(
      '-t, --transport <transport>',
      'Transport type (stdio, sse, http). Defaults to stdio if not specified.',
    )
    .option(
      '-e, --env <env...>',
      'Set environment variables (e.g. -e KEY=value)',
    )
    .option(
      '-H, --header <header...>',
      'Set WebSocket headers (e.g. -H "X-Api-Key: abc123" -H "X-Custom: value")',
    )
    .option('--client-id <clientId>', 'OAuth client ID for HTTP/SSE servers')
    .option(
      '--client-secret',
      'Prompt for OAuth client secret (or set MCP_CLIENT_SECRET env var)',
    )
    .option(
      '--callback-port <port>',
      'Fixed port for OAuth callback (for servers requiring pre-registered redirect URIs)',
    )
    .helpOption('-h, --help', 'Display help for command')
    .addOption(
      new Option(
        '--xaa',
        "Enable XAA (SEP-990) for this server. Requires 'claude mcp xaa setup' first. Also requires --client-id and --client-secret (for the MCP server's AS).",
      ).hideHelp(!isXaaEnabled()),
    )
    .action(async (name, commandOrUrl, args, options) => {
      // Commander.js handles -- natively: it consumes -- and everything after becomes args
      const actualCommand = commandOrUrl
      const actualArgs = args

      // If no name is provided, error
      if (!name) {
        cliError(
          'Error: Server name is required.\n' +
            'Usage: claude mcp add <name> <command> [args...]',
        )
      } else if (!actualCommand) {
        cliError(
          'Error: Command is required when server name is provided.\n' +
            'Usage: claude mcp add <name> <command> [args...]',
        )
      }

      try {
        const scope = ensureConfigScope(options.scope)
        const transport = ensureTransport(options.transport)

        // XAA fail-fast: validate at add-time, not auth-time.
        if (options.xaa && !isXaaEnabled()) {
          cliError(
            'Error: --xaa requires CLAUDE_CODE_ENABLE_XAA=1 in your environment',
          )
        }
        const xaa = Boolean(options.xaa)
        if (xaa) {
          const missing: string[] = []
          if (!options.clientId) missing.push('--client-id')
          if (!options.clientSecret) missing.push('--client-secret')
          if (!getXaaIdpSettings()) {
            missing.push(
              "'claude mcp xaa setup' (settings.xaaIdp not configured)",
            )
          }
          if (missing.length) {
            cliError(`Error: --xaa requires: ${missing.join(', ')}`)
          }
        }

        // Check if transport was explicitly provided
        const transportExplicit = options.transport !== undefined

        // Check if the command looks like a URL (likely incorrect usage)
        const looksLikeUrl =
          actualCommand.startsWith('http://') ||
          actualCommand.startsWith('https://') ||
          actualCommand.startsWith('localhost') ||
          actualCommand.endsWith('/sse') ||
          actualCommand.endsWith('/mcp')

        logEvent('tengu_mcp_add', {
          type: transport as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          scope:
            scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          source:
            'command' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          transport:
            transport as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          transportExplicit: transportExplicit,
          looksLikeUrl: looksLikeUrl,
        })

        if (transport === 'sse') {
          if (!actualCommand) {
            cliError('Error: URL is required for SSE transport.')
          }

          const headers = options.header
            ? parseHeaders(options.header)
            : undefined

          const callbackPort = options.callbackPort
            ? parseInt(options.callbackPort, 10)
            : undefined
          const oauth =
            options.clientId || callbackPort || xaa
              ? {
                  ...(options.clientId ? { clientId: options.clientId } : {}),
                  ...(callbackPort ? { callbackPort } : {}),
                  ...(xaa ? { xaa: true } : {}),
                }
              : undefined

          const clientSecret =
            options.clientSecret && options.clientId
              ? await readClientSecret()
              : undefined

          const serverConfig = {
            type: 'sse' as const,
            url: actualCommand,
            headers,
            oauth,
          }
          await addMcpConfig(name, serverConfig, scope)

          if (clientSecret) {
            saveMcpClientSecret(name, serverConfig, clientSecret)
          }

          process.stdout.write(
            `Added SSE MCP server ${name} with URL: ${actualCommand} to ${scope} config\n`,
          )
          if (headers) {
            process.stdout.write(
              `Headers: ${jsonStringify(headers, null, 2)}\n`,
            )
          }
        } else if (transport === 'http') {
          if (!actualCommand) {
            cliError('Error: URL is required for HTTP transport.')
          }

          const headers = options.header
            ? parseHeaders(options.header)
            : undefined

          const callbackPort = options.callbackPort
            ? parseInt(options.callbackPort, 10)
            : undefined
          const oauth =
            options.clientId || callbackPort || xaa
              ? {
                  ...(options.clientId ? { clientId: options.clientId } : {}),
                  ...(callbackPort ? { callbackPort } : {}),
                  ...(xaa ? { xaa: true } : {}),
                }
              : undefined

          const clientSecret =
            options.clientSecret && options.clientId
              ? await readClientSecret()
              : undefined

          const serverConfig = {
            type: 'http' as const,
            url: actualCommand,
            headers,
            oauth,
          }
          await addMcpConfig(name, serverConfig, scope)

          if (clientSecret) {
            saveMcpClientSecret(name, serverConfig, clientSecret)
          }

          process.stdout.write(
            `Added HTTP MCP server ${name} with URL: ${actualCommand} to ${scope} config\n`,
          )
          if (headers) {
            process.stdout.write(
              `Headers: ${jsonStringify(headers, null, 2)}\n`,
            )
          }
        } else {
          if (
            options.clientId ||
            options.clientSecret ||
            options.callbackPort ||
            options.xaa
          ) {
            process.stderr.write(
              `Warning: --client-id, --client-secret, --callback-port, and --xaa are only supported for HTTP/SSE transports and will be ignored for stdio.\n`,
            )
          }

          // Warn if this looks like a URL but transport wasn't explicitly specified
          if (!transportExplicit && looksLikeUrl) {
            process.stderr.write(
              `\nWarning: The command "${actualCommand}" looks like a URL, but is being interpreted as a stdio server as --transport was not specified.\n`,
            )
            process.stderr.write(
              `If this is an HTTP server, use: claude mcp add --transport http ${name} ${actualCommand}\n`,
            )
            process.stderr.write(
              `If this is an SSE server, use: claude mcp add --transport sse ${name} ${actualCommand}\n`,
            )
          }

          const env = parseEnvVars(options.env)
          await addMcpConfig(
            name,
            { type: 'stdio', command: actualCommand, args: actualArgs, env },
            scope,
          )

          process.stdout.write(
            `Added stdio MCP server ${name} with command: ${actualCommand} ${actualArgs.join(' ')} to ${scope} config\n`,
          )
        }
        cliOk(`File modified: ${describeMcpConfigFilePath(scope)}`)
      } catch (error) {
        cliError((error as Error).message)
      }
    })
}
