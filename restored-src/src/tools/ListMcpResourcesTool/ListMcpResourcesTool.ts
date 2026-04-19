/**
 * ListMcpResourcesTool.ts — MCP 资源列表工具实现
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件实现了 Claude Code 的 MCP 资源列举工具，工具名称为 "ListMcpResourcesTool"。
 * 它是 MCP（Model Context Protocol）工具生态的补充，与 MCPTool（执行 MCP 工具）
 * 共同构成 MCP 访问体系。
 * 本工具允许模型发现并列出所有已连接 MCP 服务器提供的资源（URI 资源，非工具）。
 *
 * 【主要功能】
 * 1. 输入：
 *    - server（可选）：指定要查询的 MCP 服务器名称；若不提供则查询所有服务器
 * 2. 权限与特性：
 *    - shouldDefer: true（工具启动时延迟初始化）
 *    - isConcurrencySafe: true（只读，可并发）
 *    - isReadOnly: true（不修改状态）
 * 3. call() 执行流程：
 *    - 若提供 server 参数，过滤出指定服务器的客户端；未找到时抛错
 *    - 对每个 connected 状态的客户端，先调用 ensureConnectedClient（重连保障），
 *      再调用 fetchResourcesForClient（LRU 缓存，启动时预热）
 *    - 使用 Promise.all 并发处理多个服务器，单个失败不影响整体结果
 *    - 将所有服务器的资源列表展平合并后返回
 * 4. 结果映射（mapToolResultToToolResultBlockParam）：
 *    - 无资源时返回友好提示（提示 MCP 服务器仍可能提供工具）
 *    - 有资源时返回 JSON 序列化的资源列表
 */

import { z } from 'zod/v4'
import {
  ensureConnectedClient,
  fetchResourcesForClient,
} from '../../services/mcp/client.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { errorMessage } from '../../utils/errors.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logMCPError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { DESCRIPTION, LIST_MCP_RESOURCES_TOOL_NAME, PROMPT } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

/**
 * 输入 Schema（懒加载）：
 * - server：可选的服务器名称过滤参数
 */
const inputSchema = lazySchema(() =>
  z.object({
    server: z
      .string()
      .optional()
      .describe('Optional server name to filter resources by'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

/**
 * 输出 Schema（懒加载）：MCP 资源对象数组。
 * 每个资源对象包含：
 * - uri：资源 URI（必填）
 * - name：资源名称（必填）
 * - mimeType：MIME 类型（可选）
 * - description：资源描述（可选）
 * - server：提供该资源的服务器名称（必填，额外附加字段）
 */
const outputSchema = lazySchema(() =>
  z.array(
    z.object({
      uri: z.string().describe('Resource URI'),
      name: z.string().describe('Resource name'),
      mimeType: z.string().optional().describe('MIME type of the resource'),
      description: z.string().optional().describe('Resource description'),
      server: z.string().describe('Server that provides this resource'),
    }),
  ),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

/**
 * ListMcpResourcesTool 工具定义。
 *
 * 通过 buildTool() 构建后注册到 Claude Code 工具系统，
 * 模型可通过名称 "ListMcpResourcesTool" 调用本工具列出 MCP 服务器提供的资源。
 */
export const ListMcpResourcesTool = buildTool({
  /** 只读操作，支持并发调用 */
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  /** 供自动分类器使用：返回 server 参数或空字符串 */
  toAutoClassifierInput(input) {
    return input.server ?? ''
  },
  /** 延迟初始化：等待 MCP 连接建立后再使用 */
  shouldDefer: true,
  name: LIST_MCP_RESOURCES_TOOL_NAME,
  searchHint: 'list resources from connected MCP servers',
  maxResultSizeChars: 100_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  /** 懒加载输入 Schema */
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  /** 懒加载输出 Schema */
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  /**
   * 执行资源列举的核心逻辑。
   *
   * 流程：
   * 1. 若提供 server 参数，过滤出对应客户端；未找到时抛出错误（含可用服务器列表）
   * 2. 对每个 connected 状态的客户端：
   *    - ensureConnectedClient：健康时直接返回（memoize 命中），断连后重新建立连接
   *    - fetchResourcesForClient：LRU 缓存查询，启动时已预热，
   *      onclose 和 resources/list_changed 通知时自动失效
   * 3. Promise.all 并发处理所有客户端，单个失败记录日志后返回空数组（不阻断整体）
   * 4. 将所有结果展平合并后返回
   */
  async call(input, { options: { mcpClients } }) {
    const { server: targetServer } = input

    // 若指定了服务器名称，过滤出对应客户端；否则处理所有客户端
    const clientsToProcess = targetServer
      ? mcpClients.filter(client => client.name === targetServer)
      : mcpClients

    // 指定了服务器但未找到对应客户端时，抛出错误并列出可用服务器
    if (targetServer && clientsToProcess.length === 0) {
      throw new Error(
        `Server "${targetServer}" not found. Available servers: ${mcpClients.map(c => c.name).join(', ')}`,
      )
    }

    // fetchResourcesForClient is LRU-cached (by server name) and already
    // warm from startup prefetch. Cache is invalidated on onclose and on
    // resources/list_changed notifications, so results are never stale.
    // ensureConnectedClient is a no-op when healthy (memoize hit), but after
    // onclose it returns a fresh connection so the re-fetch succeeds.
    // 并发查询所有客户端的资源，单个失败不影响整体结果
    const results = await Promise.all(
      clientsToProcess.map(async client => {
        // 跳过非 connected 状态的客户端
        if (client.type !== 'connected') return []
        try {
          // 确保客户端已连接（重连保障），然后获取资源列表（LRU 缓存）
          const fresh = await ensureConnectedClient(client)
          return await fetchResourcesForClient(fresh)
        } catch (error) {
          // One server's reconnect failure shouldn't sink the whole result.
          // 单个服务器重连失败时记录日志，返回空数组，不影响其他服务器的结果
          logMCPError(client.name, errorMessage(error))
          return []
        }
      }),
    )

    return {
      data: results.flat(),  // 将多个服务器的资源列表展平合并
    }
  },
  renderToolUseMessage,
  userFacingName: () => 'listMcpResources',
  renderToolResultMessage,
  /** 检查输出是否被截断（基于行数判断） */
  isResultTruncated(output: Output): boolean {
    return isOutputLineTruncated(jsonStringify(output))
  },
  /**
   * 将工具结果映射为 Anthropic API 的 tool_result 消息格式。
   * - 无资源：返回友好提示，说明服务器仍可能提供工具
   * - 有资源：返回 JSON 序列化的资源列表
   */
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    if (!content || content.length === 0) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content:
          'No resources found. MCP servers may still provide tools even if they have no resources.',
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(content),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
