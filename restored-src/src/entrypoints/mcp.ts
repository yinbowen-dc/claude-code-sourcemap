/**
 * MCP 服务器入口（mcp.ts）
 *
 * 【在系统中的位置】
 * 本文件实现了 Claude Code 的 MCP（Model Context Protocol）服务器模式入口。
 * 当用户以 `--claude-in-chrome-mcp` 或其他 MCP 模式启动时，cli.tsx 会路由到此处。
 * 调用链：cli.tsx（快速路径） → startMCPServer() → MCP Server（stdio 传输）
 *
 * 【主要职责】
 * 将 Claude Code 内置的全部工具（BashTool、ReadTool、EditTool 等）暴露为
 * 标准 MCP 工具，供任何支持 MCP 协议的 LLM 客户端（如 Claude Desktop）调用。
 *
 * 【MCP 协议概述】
 * - 通过 stdio 传输：子进程的 stdin/stdout 作为 JSON-RPC 通道
 * - 服务器标识：`claude/tengu`（Tengu 是系统内部代号）
 * - 支持能力：仅工具调用（tools），暂不支持 resources / prompts
 *
 * 【实现要点】
 * - 使用带大小限制（100 文件，~25MB）的 LRU 缓存管理文件读取状态，防止内存无限增长
 * - ListTools 响应会将 Zod outputSchema 转换为 JSON Schema，但仅保留根类型为 object 的 schema
 * - CallTool 构造最小化的 ToolUseContext（非交互式会话，无 MCP 客户端）
 * - 命令集 MCP_COMMANDS 目前仅包含 `review` 命令
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type ListToolsResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { getDefaultAppState } from 'src/state/AppStateStore.js'
import review from '../commands/review.js'
import type { Command } from '../commands.js'
import {
  findToolByName,
  getEmptyToolPermissionContext,
  type ToolUseContext,
} from '../Tool.js'
import { getTools } from '../tools.js'
import { createAbortController } from '../utils/abortController.js'
import { createFileStateCacheWithSizeLimit } from '../utils/fileStateCache.js'
import { logError } from '../utils/log.js'
import { createAssistantMessage } from '../utils/messages.js'
import { getMainLoopModel } from '../utils/model/model.js'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions.js'
import { setCwd } from '../utils/Shell.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { getErrorParts } from '../utils/toolErrors.js'
import { zodToJsonSchema } from '../utils/zodToJsonSchema.js'

// MCP SDK 中工具输入/输出 schema 的类型别名
type ToolInput = Tool['inputSchema']
type ToolOutput = Tool['outputSchema']

// 当前 MCP 模式下暴露的命令集合（目前仅 review 命令）
// 未来可扩展为更多 Claude Code 命令
const MCP_COMMANDS: Command[] = [review]

/**
 * 启动 MCP 服务器
 *
 * 【总体流程】
 * 1. 创建带大小限制的文件状态缓存（用于 Read/Edit 工具的状态跟踪）
 * 2. 设置当前工作目录（影响所有文件系统工具的相对路径解析）
 * 3. 创建 MCP Server 实例，声明 tools 能力
 * 4. 注册 ListTools 请求处理器（枚举所有可用工具及其 schema）
 * 5. 注册 CallTool 请求处理器（执行具体工具调用）
 * 6. 连接 stdio 传输并进入服务循环（阻塞直到进程退出）
 *
 * @param cwd - 工具调用时使用的工作目录（通常为用户当前目录）
 * @param debug - 是否启用调试输出
 * @param verbose - 是否启用详细日志
 */
export async function startMCPServer(
  cwd: string,
  debug: boolean,
  verbose: boolean,
): Promise<void> {
  // 创建 LRU 文件状态缓存：限制最多缓存 100 个文件，约 25MB
  // 防止长时间运行的 MCP 服务器因缓存无限增长而耗尽内存
  const READ_FILE_STATE_CACHE_SIZE = 100
  const readFileStateCache = createFileStateCacheWithSizeLimit(
    READ_FILE_STATE_CACHE_SIZE,
  )
  // 设置全局工作目录，所有文件路径均相对于此目录解析
  setCwd(cwd)
  // 创建 MCP Server 实例，声明服务器名称（claude/tengu）和版本
  const server = new Server(
    {
      name: 'claude/tengu',
      version: MACRO.VERSION, // 构建时内联的版本号
    },
    {
      capabilities: {
        tools: {}, // 声明支持工具调用能力
      },
    },
  )

  /**
   * ListTools 请求处理器
   *
   * 将 Claude Code 的全部内置工具转换为 MCP 协议格式并返回。
   * 转换过程包括：
   * - 将 inputSchema（Zod 类型）转为 JSON Schema
   * - 将 outputSchema（若存在且根类型为 object）转为 JSON Schema
   * - 通过 tool.prompt() 获取工具的自然语言描述
   */
  server.setRequestHandler(
    ListToolsRequestSchema,
    async (): Promise<ListToolsResult> => {
      // TODO: 同时暴露已连接的 MCP 工具（当前仅暴露内置工具）
      const toolPermissionContext = getEmptyToolPermissionContext()
      // 获取当前权限上下文下可用的全部工具
      const tools = getTools(toolPermissionContext)
      return {
        tools: await Promise.all(
          tools.map(async tool => {
            let outputSchema: ToolOutput | undefined
            if (tool.outputSchema) {
              const convertedSchema = zodToJsonSchema(tool.outputSchema)
              // MCP SDK 要求 outputSchema 根级别的类型必须为 "object"
              // 对于 z.union / z.discriminatedUnion 等产生 anyOf/oneOf 的 schema，
              // 根类型不满足要求，需要跳过（参见 issue #8014）
              if (
                typeof convertedSchema === 'object' &&
                convertedSchema !== null &&
                'type' in convertedSchema &&
                convertedSchema.type === 'object'
              ) {
                outputSchema = convertedSchema as ToolOutput
              }
            }
            return {
              ...tool,
              // 通过 tool.prompt() 获取工具的自然语言描述（异步，可能依赖上下文）
              description: await tool.prompt({
                getToolPermissionContext: async () => toolPermissionContext,
                tools,
                agents: [],
              }),
              // 将 Zod inputSchema 转换为标准 JSON Schema 格式
              inputSchema: zodToJsonSchema(tool.inputSchema) as ToolInput,
              outputSchema,
            }
          }),
        ),
      }
    },
  )

  /**
   * CallTool 请求处理器
   *
   * 接收工具调用请求，构造最小化的 ToolUseContext，并执行工具逻辑。
   * 返回标准 MCP CallToolResult，包括成功结果或错误信息。
   *
   * 【ToolUseContext 说明】
   * MCP 场景下构造的上下文与交互式 CLI 有几点不同：
   * - messages: [] （无历史消息上下文）
   * - isNonInteractiveSession: true（非交互模式）
   * - mcpClients: []（不复用其他 MCP 客户端）
   * - thinkingConfig: { type: 'disabled' }（禁用扩展思考）
   */
  server.setRequestHandler(
    CallToolRequestSchema,
    async ({ params: { name, arguments: args } }): Promise<CallToolResult> => {
      const toolPermissionContext = getEmptyToolPermissionContext()
      // TODO: 同时暴露已连接的 MCP 工具
      const tools = getTools(toolPermissionContext)
      // 按名称查找对应工具，找不到则抛出错误
      const tool = findToolByName(tools, name)
      if (!tool) {
        throw new Error(`Tool ${name} not found`)
      }

      // MCP 调用方通过参数传递所有输入，不依赖历史消息上下文
      // 构造最小化的 ToolUseContext（仅提供 MCP 场景必需的字段）
      const toolUseContext: ToolUseContext = {
        abortController: createAbortController(), // 用于取消正在执行的工具
        options: {
          commands: MCP_COMMANDS,        // 当前可用的命令集（仅 review）
          tools,                          // 所有可用工具（用于工具间相互调用）
          mainLoopModel: getMainLoopModel(), // 主循环使用的 AI 模型
          thinkingConfig: { type: 'disabled' }, // MCP 模式下禁用扩展思考
          mcpClients: [],                 // 不复用其他 MCP 客户端
          mcpResources: {},               // 暂无 MCP 资源
          isNonInteractiveSession: true,  // 标记为非交互式会话
          debug,
          verbose,
          agentDefinitions: { activeAgents: [], allAgents: [] }, // 无 agent 定义
        },
        getAppState: () => getDefaultAppState(), // 使用默认应用状态
        setAppState: () => {},              // MCP 模式下不需要更新应用状态
        messages: [],                       // 无历史消息上下文
        readFileState: readFileStateCache,  // 文件读取状态缓存（带大小限制）
        setInProgressToolUseIDs: () => {},  // 不跟踪进行中的工具使用 ID
        setResponseLength: () => {},        // 不跟踪响应长度
        updateFileHistoryState: () => {},   // 不更新文件历史状态
        updateAttributionState: () => {},   // 不更新归因状态
      }

      // TODO: 使用 zod 验证输入类型（当前跳过，直接调用工具）
      try {
        // 检查工具是否在当前环境下可用
        if (!tool.isEnabled()) {
          throw new Error(`Tool ${name} is not enabled`)
        }
        // 执行工具的输入校验（可选，某些工具没有此方法）
        const validationResult = await tool.validateInput?.(
          (args as never) ?? {},
          toolUseContext,
        )
        if (validationResult && !validationResult.result) {
          throw new Error(
            `Tool ${name} input is invalid: ${validationResult.message}`,
          )
        }
        // 执行工具调用，传入权限检查函数和虚拟 assistant 消息
        const finalResult = await tool.call(
          (args ?? {}) as never,
          toolUseContext,
          hasPermissionsToUseTool,
          createAssistantMessage({
            content: [], // MCP 模式下 assistant 消息内容为空
          }),
        )

        // 将工具调用结果转换为 MCP 文本内容格式
        return {
          content: [
            {
              type: 'text' as const,
              text:
                // 字符串结果直接使用；对象结果序列化为 JSON
                typeof finalResult === 'string'
                  ? finalResult
                  : jsonStringify(finalResult.data),
            },
          ],
        }
      } catch (error) {
        // 记录错误日志（供调试使用）
        logError(error)

        // 将错误转换为可读的文本格式（getErrorParts 会提取错误的各个组成部分）
        const parts =
          error instanceof Error ? getErrorParts(error) : [String(error)]
        const errorText = parts.filter(Boolean).join('\n').trim() || 'Error'

        // 返回带 isError 标志的 MCP 结果，客户端可据此区分成功和失败
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: errorText,
            },
          ],
        }
      }
    },
  )

  /**
   * 启动 stdio 传输并连接服务器
   *
   * StdioServerTransport 使用 process.stdin/stdout 作为 JSON-RPC 通道，
   * server.connect() 调用后进入事件循环，阻塞直到连接断开。
   */
  async function runServer() {
    const transport = new StdioServerTransport()
    await server.connect(transport)
  }

  return await runServer()
}
