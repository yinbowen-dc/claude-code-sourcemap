/**
 * SDK 控制协议 Schema 定义（sdk/controlSchemas.ts）
 *
 * 【在系统中的位置】
 * 本文件定义了 SDK 实现层（如 Python SDK）与 Claude Code CLI 进程之间的
 * "控制协议（Control Protocol）"，通过 stdin/stdout 进行 JSON-RPC 风格的通信。
 * 调用链如下：
 *
 *   SDK 实现方（Python SDK / 第三方集成商）
 *       ↓ JSON via stdin/stdout
 *   StdinMessageSchema / StdoutMessageSchema  ← 本文件（顶层聚合消息类型）
 *       ↓
 *   SDKControlRequestSchema / SDKControlResponseSchema
 *       ↓
 *   各具体控制请求 Schema（initialize、interrupt、set_model 等）
 *
 * 【主要职责】
 * 1. 定义 ~20 种控制请求类型的 Zod Schema（各携带 subtype 判别字段）
 * 2. 提供对应的响应 Schema（部分请求有专属响应体，部分只需 success/error 通用响应）
 * 3. 将所有控制请求/响应包装在带 `type` 和 `request_id` 字段的外层 Schema 中
 * 4. 定义 stdin 和 stdout 的完整消息联合类型，覆盖所有可能的消息变体
 *
 * 【控制协议消息格式】
 * 请求（SDK → CLI）：
 *   { type: 'control_request', request_id: string, request: { subtype: '...' , ...fields } }
 * 响应（CLI → SDK）：
 *   { type: 'control_response', response: { subtype: 'success'|'error', request_id: string, ... } }
 *
 * 【lazySchema 说明】
 * 所有 Schema 均用 lazySchema() 包装，以延迟 Zod 对象的实际构建时机，
 * 避免循环依赖导致的模块初始化错误。
 *
 * 【SDK 消费者 vs SDK 构建者】
 * - SDK 消费者：应使用 coreSchemas.ts 中的数据类型 Schema，无需关注本文件
 * - SDK 构建者（实现传输层/控制协议的开发者）：需要使用本文件中的控制协议 Schema
 */

import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  AccountInfoSchema,
  AgentDefinitionSchema,
  AgentInfoSchema,
  FastModeStateSchema,
  HookEventSchema,
  HookInputSchema,
  McpServerConfigForProcessTransportSchema,
  McpServerStatusSchema,
  ModelInfoSchema,
  PermissionModeSchema,
  PermissionUpdateSchema,
  SDKMessageSchema,
  SDKPostTurnSummaryMessageSchema,
  SDKStreamlinedTextMessageSchema,
  SDKStreamlinedToolUseSummaryMessageSchema,
  SDKUserMessageSchema,
  SlashCommandSchema,
} from './coreSchemas.js'

// ============================================================================
// 外部类型占位符（External Type Placeholders）
// ============================================================================

// @modelcontextprotocol/sdk 中的 JSONRPCMessage 类型——在此处用 z.unknown() 占位，
// 避免将 MCP SDK 的完整类型体系引入控制协议定义层
export const JSONRPCMessagePlaceholder = lazySchema(() => z.unknown())

// ============================================================================
// Hook 回调配置类型（Hook Callback Types）
// ============================================================================

/**
 * Hook 回调匹配器配置 Schema
 *
 * 【作用】
 * 描述单个 Hook 事件的回调路由规则：
 * - matcher：可选的事件过滤字符串（正则或工具名前缀），用于精确匹配特定触发条件
 * - hookCallbackIds：回调 ID 列表，CLI 收到匹配事件后向 SDK 侧推送对应 callback
 * - timeout：可选的回调超时时间（毫秒）
 */
export const SDKHookCallbackMatcherSchema = lazySchema(() =>
  z
    .object({
      matcher: z.string().optional(),
      hookCallbackIds: z.array(z.string()),
      timeout: z.number().optional(),
    })
    .describe('Configuration for matching and routing hook callbacks.'),
)

// ============================================================================
// 控制请求类型定义（Control Request Types）
// ============================================================================

/**
 * 初始化请求 Schema
 *
 * 【作用】
 * SDK 连接建立后发送的第一条消息，用于：
 * - 注册 Hook 回调（按事件类型和匹配规则）
 * - 声明 SDK 侧提供的 MCP 服务器（sdkMcpServers）
 * - 提供自定义 JSON Schema（用于结构化输出格式）
 * - 覆盖或追加系统提示词（systemPrompt / appendSystemPrompt）
 * - 注册自定义 Agent 定义和提示词建议功能
 */
export const SDKControlInitializeRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('initialize'),
      // hooks：按 HookEvent 类型分组的回调匹配器配置
      hooks: z
        .record(HookEventSchema(), z.array(SDKHookCallbackMatcherSchema()))
        .optional(),
      // sdkMcpServers：SDK 提供的 MCP 服务器名称列表（需预先在 SDK 侧启动）
      sdkMcpServers: z.array(z.string()).optional(),
      // jsonSchema：用于约束结构化输出的 JSON Schema 定义
      jsonSchema: z.record(z.string(), z.unknown()).optional(),
      // systemPrompt：完全替换默认系统提示词
      systemPrompt: z.string().optional(),
      // appendSystemPrompt：追加到默认系统提示词末尾
      appendSystemPrompt: z.string().optional(),
      // agents：自定义 Agent 类型定义（可通过 Agent 工具调用）
      agents: z.record(z.string(), AgentDefinitionSchema()).optional(),
      // promptSuggestions：是否在每轮结束后推送下一条建议提示词
      promptSuggestions: z.boolean().optional(),
      // agentProgressSummaries：是否推送 Agent 执行进度摘要消息
      agentProgressSummaries: z.boolean().optional(),
    })
    .describe(
      'Initializes the SDK session with hooks, MCP servers, and agent configuration.',
    ),
)

/**
 * 初始化响应 Schema
 *
 * 【作用】
 * CLI 对 initialize 请求的响应，包含会话所需的全量元数据：
 * - commands：当前可用的斜杠命令列表
 * - agents：可调用的子 Agent 类型列表
 * - models：可选模型列表（含能力描述）
 * - account：当前用户账户信息
 * - pid：CLI 进程 PID（用于 tmux socket 隔离，内部使用）
 * - fast_mode_state：快速模式当前状态
 */
export const SDKControlInitializeResponseSchema = lazySchema(() =>
  z
    .object({
      commands: z.array(SlashCommandSchema()),
      agents: z.array(AgentInfoSchema()),
      output_style: z.string(),
      available_output_styles: z.array(z.string()),
      models: z.array(ModelInfoSchema()),
      account: AccountInfoSchema(),
      pid: z
        .number()
        .optional()
        .describe('@internal CLI process PID for tmux socket isolation'),
      fast_mode_state: FastModeStateSchema().optional(),
    })
    .describe(
      'Response from session initialization with available commands, models, and account info.',
    ),
)

/**
 * 中断请求 Schema
 *
 * 【作用】
 * 向 CLI 发出中断信号，终止当前正在执行的对话轮次（turn）。
 * 等效于用户在交互式 CLI 中按 Ctrl+C。
 * CLI 接收到此请求后会向当前工具调用发送 AbortSignal。
 */
export const SDKControlInterruptRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('interrupt'),
    })
    .describe('Interrupts the currently running conversation turn.'),
)


/**
 * 工具权限请求 Schema（CLI → SDK 方向）
 *
 * 【作用】
 * CLI 在执行需要用户授权的工具时，通过此 Schema 向 SDK 请求权限决策。
 * SDK 实现方（如 Desktop 应用）收到此请求后，展示权限确认 UI，
 * 再通过 SDKControlResponseSchema 返回允许/拒绝决定。
 *
 * 字段说明：
 * - tool_name：请求权限的工具名称（如 "Bash"、"Edit"）
 * - input：工具的调用参数，用于向用户展示操作详情
 * - permission_suggestions：CLI 建议的权限更新方案（如"永久允许"）
 * - blocked_path：若操作被沙盒拒绝，提供触发阻断的路径
 * - decision_reason：CLI 内部决策理由（供 UI 层展示参考）
 * - tool_use_id：工具调用的唯一 ID，用于匹配响应
 * - agent_id：若在子 Agent 中触发，标识来源的 Agent ID
 */
export const SDKControlPermissionRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('can_use_tool'),
      tool_name: z.string(),
      input: z.record(z.string(), z.unknown()),
      permission_suggestions: z.array(PermissionUpdateSchema()).optional(),
      blocked_path: z.string().optional(),
      decision_reason: z.string().optional(),
      title: z.string().optional(),
      display_name: z.string().optional(),
      tool_use_id: z.string(),
      agent_id: z.string().optional(),
      description: z.string().optional(),
    })
    .describe('Requests permission to use a tool with the given input.'),
)

/**
 * 设置权限模式请求 Schema
 *
 * 【作用】
 * 动态切换 CLI 的全局权限处理模式，无需重启会话。
 * 例如：从 'default' 切换到 'bypassPermissions' 以跳过所有权限确认。
 * 也用于 CCR ultraplan 会话的内部标记（ultraplan 字段）。
 */
export const SDKControlSetPermissionModeRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('set_permission_mode'),
      mode: PermissionModeSchema(),
      ultraplan: z
        .boolean()
        .optional()
        .describe('@internal CCR ultraplan session marker.'),
    })
    .describe('Sets the permission mode for tool execution handling.'),
)

/**
 * 设置模型请求 Schema
 *
 * 【作用】
 * 在运行时切换当前会话使用的 AI 模型，无需重新初始化会话。
 * model 字段省略时表示恢复默认模型。
 */
export const SDKControlSetModelRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('set_model'),
      model: z.string().optional(),
    })
    .describe('Sets the model to use for subsequent conversation turns.'),
)

/**
 * 设置最大思考 Token 数请求 Schema
 *
 * 【作用】
 * 动态调整扩展思考（Extended Thinking）的 token 预算上限。
 * 传入 null 表示移除上限限制（使用模型默认值）。
 */
export const SDKControlSetMaxThinkingTokensRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('set_max_thinking_tokens'),
      max_thinking_tokens: z.number().nullable(),
    })
    .describe(
      'Sets the maximum number of thinking tokens for extended thinking.',
    ),
)

/**
 * MCP 状态查询请求 Schema
 *
 * 【作用】
 * 向 CLI 查询所有已配置的 MCP 服务器的当前连接状态。
 * 对应响应为 SDKControlMcpStatusResponseSchema。
 */
export const SDKControlMcpStatusRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('mcp_status'),
    })
    .describe('Requests the current status of all MCP server connections.'),
)

/**
 * MCP 状态查询响应 Schema
 *
 * 【作用】
 * 返回所有 MCP 服务器的连接状态数组，每个条目包含服务器名称、
 * 连接状态（connected/failed/needs-auth/pending/disabled）、
 * 错误信息（若有）及工具列表。
 */
export const SDKControlMcpStatusResponseSchema = lazySchema(() =>
  z
    .object({
      mcpServers: z.array(McpServerStatusSchema()),
    })
    .describe(
      'Response containing the current status of all MCP server connections.',
    ),
)

/**
 * 上下文使用量查询请求 Schema
 *
 * 【作用】
 * 向 CLI 请求当前上下文窗口的详细用量分解，
 * 对应响应为 SDKControlGetContextUsageResponseSchema。
 */
export const SDKControlGetContextUsageRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('get_context_usage'),
    })
    .describe(
      'Requests a breakdown of current context window usage by category.',
    ),
)

// 上下文用量中单个分类条目的 Schema（颜色、token 数、是否延迟加载）
const ContextCategorySchema = lazySchema(() =>
  z.object({
    name: z.string(),
    tokens: z.number(),
    color: z.string(),
    isDeferred: z.boolean().optional(),
  }),
)

// 上下文用量可视化网格中单个格子的 Schema（用于渲染用量热力图）
const ContextGridSquareSchema = lazySchema(() =>
  z.object({
    color: z.string(),
    isFilled: z.boolean(),
    categoryName: z.string(),
    tokens: z.number(),
    percentage: z.number(),
    squareFullness: z.number(),
  }),
)

/**
 * 上下文使用量查询响应 Schema
 *
 * 【作用】
 * 详细分解当前上下文窗口的 token 使用情况，供 UI 层渲染用量面板。
 *
 * 字段分组说明：
 * - categories / gridRows：分类用量和可视化网格数据
 * - totalTokens / maxTokens / percentage：总量统计
 * - memoryFiles / mcpTools / agents：按来源分类的 token 消耗详情
 * - messageBreakdown：工具调用、工具结果、附件、对话消息各自的 token 分布
 * - apiUsage：API 层面的 token 用量（含缓存命中/创建统计）
 */
export const SDKControlGetContextUsageResponseSchema = lazySchema(() =>
  z
    .object({
      categories: z.array(ContextCategorySchema()),
      totalTokens: z.number(),
      maxTokens: z.number(),
      rawMaxTokens: z.number(),
      percentage: z.number(),
      gridRows: z.array(z.array(ContextGridSquareSchema())),
      model: z.string(),
      memoryFiles: z.array(
        z.object({
          path: z.string(),
          type: z.string(),
          tokens: z.number(),
        }),
      ),
      mcpTools: z.array(
        z.object({
          name: z.string(),
          serverName: z.string(),
          tokens: z.number(),
          isLoaded: z.boolean().optional(),
        }),
      ),
      // 延迟加载的内置工具（仅在第一次使用时加载）
      deferredBuiltinTools: z
        .array(
          z.object({
            name: z.string(),
            tokens: z.number(),
            isLoaded: z.boolean(),
          }),
        )
        .optional(),
      // 系统工具用量（如文件读取跟踪等内部工具）
      systemTools: z
        .array(z.object({ name: z.string(), tokens: z.number() }))
        .optional(),
      // 系统提示词各段落的用量分解
      systemPromptSections: z
        .array(z.object({ name: z.string(), tokens: z.number() }))
        .optional(),
      agents: z.array(
        z.object({
          agentType: z.string(),
          source: z.string(),
          tokens: z.number(),
        }),
      ),
      // 斜杠命令的用量统计（总数、已加载数、token 总量）
      slashCommands: z
        .object({
          totalCommands: z.number(),
          includedCommands: z.number(),
          tokens: z.number(),
        })
        .optional(),
      // Skills（技能）的用量统计
      skills: z
        .object({
          totalSkills: z.number(),
          includedSkills: z.number(),
          tokens: z.number(),
          skillFrontmatter: z.array(
            z.object({
              name: z.string(),
              source: z.string(),
              tokens: z.number(),
            }),
          ),
        })
        .optional(),
      // 自动压缩的触发阈值（token 使用率百分比）
      autoCompactThreshold: z.number().optional(),
      isAutoCompactEnabled: z.boolean(),
      // 消息层面的详细 token 分解（工具调用、工具结果、附件、对话消息）
      messageBreakdown: z
        .object({
          toolCallTokens: z.number(),
          toolResultTokens: z.number(),
          attachmentTokens: z.number(),
          assistantMessageTokens: z.number(),
          userMessageTokens: z.number(),
          toolCallsByType: z.array(
            z.object({
              name: z.string(),
              callTokens: z.number(),
              resultTokens: z.number(),
            }),
          ),
          attachmentsByType: z.array(
            z.object({ name: z.string(), tokens: z.number() }),
          ),
        })
        .optional(),
      // API 层面的 token 用量（含缓存读取和缓存创建）；连接失败时为 null
      apiUsage: z
        .object({
          input_tokens: z.number(),
          output_tokens: z.number(),
          cache_creation_input_tokens: z.number(),
          cache_read_input_tokens: z.number(),
        })
        .nullable(),
    })
    .describe(
      'Breakdown of current context window usage by category (system prompt, tools, messages, etc.).',
    ),
)

/**
 * 文件回退（Rewind Files）请求 Schema
 *
 * 【作用】
 * 将自指定用户消息以来的所有文件变更回退到之前的状态。
 * dry_run 为 true 时仅预览会被回退的文件，不实际执行。
 */
export const SDKControlRewindFilesRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('rewind_files'),
      // user_message_id：回退的起始消息 UUID（从该消息之后的所有文件变更将被撤销）
      user_message_id: z.string(),
      // dry_run：仅预览而不实际执行回退操作
      dry_run: z.boolean().optional(),
    })
    .describe('Rewinds file changes made since a specific user message.'),
)

/**
 * 文件回退响应 Schema
 *
 * 【作用】
 * 返回回退操作的结果，包括是否可以回退、受影响的文件列表及变更行数统计。
 */
export const SDKControlRewindFilesResponseSchema = lazySchema(() =>
  z
    .object({
      canRewind: z.boolean(),          // 是否可以执行回退（false 时见 error 字段）
      error: z.string().optional(),    // 不可回退的原因说明
      filesChanged: z.array(z.string()).optional(), // 受影响的文件路径列表
      insertions: z.number().optional(), // 将被撤销的新增行数
      deletions: z.number().optional(), // 将被撤销的删除行数
    })
    .describe('Result of a rewindFiles operation.'),
)

/**
 * 取消异步消息请求 Schema
 *
 * 【作用】
 * 从命令队列中移除一个尚未被消费的异步用户消息（通过 UUID 定位）。
 * 若消息已经被出队执行，则此操作为空操作（no-op）。
 */
export const SDKControlCancelAsyncMessageRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('cancel_async_message'),
      message_uuid: z.string(), // 要取消的消息 UUID
    })
    .describe(
      'Drops a pending async user message from the command queue by uuid. No-op if already dequeued for execution.',
    ),
)

/**
 * 取消异步消息响应 Schema
 *
 * 【作用】
 * 告知 SDK 消息取消是否成功。
 * cancelled=false 表示消息不在队列中（已被执行或从未入队）。
 */
export const SDKControlCancelAsyncMessageResponseSchema = lazySchema(() =>
  z
    .object({
      cancelled: z.boolean(),
    })
    .describe(
      'Result of a cancel_async_message operation. cancelled=false means the message was not in the queue (already dequeued or never enqueued).',
    ),
)

/**
 * 预填充文件读取状态请求 Schema
 *
 * 【作用】
 * 向 CLI 的 readFileState 缓存注入一条文件路径+修改时间记录。
 * 应用场景：当某个 Read 工具调用结果已从上下文中被截断（snip）时，
 * Edit 工具会因为找不到之前的 Read 记录而拒绝操作。
 * 通过此请求告知 CLI "这个文件已被读取过"，绕过该限制，
 * 同时 mtime 字段仍可检测文件是否在读取后被修改。
 */
export const SDKControlSeedReadStateRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('seed_read_state'),
      path: z.string(),   // 文件的绝对路径
      mtime: z.number(), // 文件读取时的修改时间（Unix 毫秒时间戳）
    })
    .describe(
      'Seeds the readFileState cache with a path+mtime entry. Use when a prior Read was removed from context (e.g. by snip) so Edit validation would fail despite the client having observed the Read. The mtime lets the CLI detect if the file changed since the seeded Read — same staleness check as the normal path.',
    ),
)

/**
 * Hook 回调传递请求 Schema（CLI → SDK 方向）
 *
 * 【作用】
 * CLI 在 Hook 事件触发时，向 SDK 推送对应的回调数据。
 * SDK 实现方通过此消息接收 Hook 输入，执行自定义逻辑后
 * 可通过控制响应返回 Hook 输出（如修改权限决策、追加上下文等）。
 */
export const SDKHookCallbackRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('hook_callback'),
      callback_id: z.string(),       // 回调 ID，对应 initialize 时注册的 hookCallbackIds
      input: HookInputSchema(),       // 具体的 Hook 输入数据（含事件类型和相关字段）
      tool_use_id: z.string().optional(), // 关联的工具调用 ID（PreToolUse/PostToolUse 时有值）
    })
    .describe('Delivers a hook callback with its input data.'),
)

/**
 * MCP 消息转发请求 Schema（SDK → CLI 方向）
 *
 * 【作用】
 * 将 JSON-RPC 消息转发给指定名称的 MCP 服务器。
 * 用于 SDK 侧直接与 MCP 服务器进行低层通信（如发送自定义 MCP 请求）。
 */
export const SDKControlMcpMessageRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('mcp_message'),
      server_name: z.string(), // 目标 MCP 服务器名称（需已在配置中存在）
      message: JSONRPCMessagePlaceholder(), // JSON-RPC 消息体（格式由 MCP 协议定义）
    })
    .describe('Sends a JSON-RPC message to a specific MCP server.'),
)

/**
 * 动态 MCP 服务器集合替换请求 Schema
 *
 * 【作用】
 * 完整替换 CLI 当前动态管理的 MCP 服务器集合。
 * 新服务器将被启动，不再出现的服务器将被停止。
 * 注意：这是全量替换而非增量更新。
 */
export const SDKControlMcpSetServersRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('mcp_set_servers'),
      // servers：服务器名称到配置的映射（stdio/SSE/HTTP/SDK 类型均支持）
      servers: z.record(z.string(), McpServerConfigForProcessTransportSchema()),
    })
    .describe('Replaces the set of dynamically managed MCP servers.'),
)

/**
 * 动态 MCP 服务器替换响应 Schema
 *
 * 【作用】
 * 告知 SDK 本次服务器替换操作的结果：
 * 哪些服务器被新增、哪些被移除、哪些在启动时发生错误。
 */
export const SDKControlMcpSetServersResponseSchema = lazySchema(() =>
  z
    .object({
      added: z.array(z.string()),                    // 成功新增的服务器名称列表
      removed: z.array(z.string()),                  // 成功移除的服务器名称列表
      errors: z.record(z.string(), z.string()),      // 启动失败的服务器及其错误信息
    })
    .describe(
      'Result of replacing the set of dynamically managed MCP servers.',
    ),
)

/**
 * 重新加载插件请求 Schema
 *
 * 【作用】
 * 指示 CLI 从磁盘重新扫描并加载所有插件（技能、自定义命令、Agent 定义等），
 * 适用于用户在运行时修改了 CLAUDE.md 或插件文件后触发热重载。
 */
export const SDKControlReloadPluginsRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('reload_plugins'),
    })
    .describe(
      'Reloads plugins from disk and returns the refreshed session components.',
    ),
)

/**
 * 重新加载插件响应 Schema
 *
 * 【作用】
 * 返回插件重载后的最新会话组件状态：
 * - commands：更新后的可用斜杠命令列表
 * - agents：更新后的 Agent 类型列表
 * - plugins：已加载的插件详情
 * - mcpServers：MCP 服务器最新状态
 * - error_count：加载时发生的错误数量
 */
export const SDKControlReloadPluginsResponseSchema = lazySchema(() =>
  z
    .object({
      commands: z.array(SlashCommandSchema()),
      agents: z.array(AgentInfoSchema()),
      plugins: z.array(
        z.object({
          name: z.string(),
          path: z.string(),
          source: z.string().optional(),
        }),
      ),
      mcpServers: z.array(McpServerStatusSchema()),
      error_count: z.number(),
    })
    .describe(
      'Refreshed commands, agents, plugins, and MCP server status after reload.',
    ),
)

/**
 * MCP 服务器重连请求 Schema
 *
 * 【作用】
 * 主动触发指定 MCP 服务器的重连操作，
 * 适用于服务器断开连接（failed 状态）后的手动恢复场景。
 */
export const SDKControlMcpReconnectRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('mcp_reconnect'),
      serverName: z.string(), // 要重连的 MCP 服务器名称
    })
    .describe('Reconnects a disconnected or failed MCP server.'),
)

/**
 * MCP 服务器启用/禁用切换请求 Schema
 *
 * 【作用】
 * 动态启用或禁用指定的 MCP 服务器，无需重启整个 CLI 进程。
 * 禁用后该服务器的工具将从工具列表中移除。
 */
export const SDKControlMcpToggleRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('mcp_toggle'),
      serverName: z.string(), // 目标 MCP 服务器名称
      enabled: z.boolean(),   // true = 启用，false = 禁用
    })
    .describe('Enables or disables an MCP server.'),
)


/**
 * 停止任务请求 Schema
 *
 * 【作用】
 * 中止指定 task_id 对应的后台任务（Background Task）。
 * 任务将在当前操作完成后优雅退出。
 */
export const SDKControlStopTaskRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('stop_task'),
      task_id: z.string(), // 要停止的任务 ID
    })
    .describe('Stops a running task.'),
)

/**
 * 应用标志设置请求 Schema
 *
 * 【作用】
 * 将提供的键值对合并到"标志设置层（flag settings layer）"，
 * 实时更新 CLI 的活动配置而无需重启。
 * 标志设置层的优先级高于文件系统级别的设置，但低于策略设置。
 */
export const SDKControlApplyFlagSettingsRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('apply_flag_settings'),
      settings: z.record(z.string(), z.unknown()), // 要合并的键值对
    })
    .describe(
      'Merges the provided settings into the flag settings layer, updating the active configuration.',
    ),
)

/**
 * 获取设置请求 Schema
 *
 * 【作用】
 * 查询当前 CLI 进程的完整配置状态，
 * 对应响应为 SDKControlGetSettingsResponseSchema。
 */
export const SDKControlGetSettingsRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('get_settings'),
    })
    .describe(
      'Returns the effective merged settings and the raw per-source settings.',
    ),
)

/**
 * 获取设置响应 Schema
 *
 * 【作用】
 * 返回当前生效的合并配置（effective）和各来源的原始配置（sources）。
 * sources 按优先级从低到高排列（userSettings < projectSettings < localSettings < flagSettings < policySettings）。
 * applied 字段包含实际运行时生效的值（如最终使用的模型名称）。
 */
export const SDKControlGetSettingsResponseSchema = lazySchema(() =>
  z
    .object({
      // 合并后生效的完整配置（最高优先级来源的值覆盖低优先级来源）
      effective: z.record(z.string(), z.unknown()),
      sources: z
        .array(
          z.object({
            source: z.enum([
              'userSettings',
              'projectSettings',
              'localSettings',
              'flagSettings',
              'policySettings',
            ]),
            settings: z.record(z.string(), z.unknown()),
          }),
        )
        .describe(
          'Ordered low-to-high priority — later entries override earlier ones.',
        ),
      applied: z
        .object({
          model: z.string(),
          // String levels only — numeric effort is ant-only and the
          // Zod→proto generator can't emit enum∪number unions.
          effort: z.enum(['low', 'medium', 'high', 'max']).nullable(),
        })
        .optional()
        .describe(
          'Runtime-resolved values after env overrides, session state, and model-specific defaults are applied. Unlike `effective` (disk merge), these reflect what will actually be sent to the API.',
        ),
    })
    .describe(
      'Effective merged settings plus raw per-source settings in merge order.',
    ),
)

/**
 * MCP Elicitation 请求 Schema（CLI → SDK 方向）
 *
 * 【作用】
 * 当 MCP 服务器向用户请求输入（elicitation）时，CLI 通过此 Schema 转发请求给 SDK。
 * SDK 实现方负责展示对应的 UI（表单或 URL 跳转），
 * 收集用户输入后通过控制响应返回结果。
 *
 * mode 字段区分两种交互模式：
 * - form：展示表单（requested_schema 定义字段结构）
 * - url：引导用户访问指定 URL 完成操作（如 OAuth 授权）
 */
export const SDKControlElicitationRequestSchema = lazySchema(() =>
  z
    .object({
      subtype: z.literal('elicitation'),
      mcp_server_name: z.string(),        // 发起 elicitation 的 MCP 服务器名称
      message: z.string(),                 // 向用户展示的说明信息
      mode: z.enum(['form', 'url']).optional(), // 交互模式（表单/URL）
      url: z.string().optional(),          // URL 模式下的目标地址
      elicitation_id: z.string().optional(), // elicitation 的唯一标识符（用于后续关联响应）
      requested_schema: z.record(z.string(), z.unknown()).optional(), // 表单字段的 JSON Schema
    })
    .describe(
      'Requests the SDK consumer to handle an MCP elicitation (user input request).',
    ),
)

/**
 * MCP Elicitation 响应 Schema（SDK → CLI 方向）
 *
 * 【作用】
 * SDK 实现方将用户对 elicitation 请求的响应通过此 Schema 返回给 CLI，
 * CLI 再将结果转发给原始的 MCP 服务器。
 *
 * action 枚举：
 * - accept：用户确认并提交（content 包含填写的表单数据）
 * - decline：用户主动拒绝
 * - cancel：用户取消操作（通常等同于 decline）
 */
export const SDKControlElicitationResponseSchema = lazySchema(() =>
  z
    .object({
      action: z.enum(['accept', 'decline', 'cancel']),
      content: z.record(z.string(), z.unknown()).optional(), // accept 时的表单字段值
    })
    .describe('Response from the SDK consumer for an elicitation request.'),
)


// ============================================================================
// 控制请求/响应外层包装（Control Request/Response Wrappers）
// ============================================================================

/**
 * 所有控制请求内部消息类型的联合 Schema
 *
 * 【作用】
 * 将所有具体的控制请求类型合并为一个大联合，
 * 供 SDKControlRequestSchema 的 request 字段使用。
 * Zod 会按顺序尝试匹配 subtype 字面量，找到匹配项后解析。
 */
export const SDKControlRequestInnerSchema = lazySchema(() =>
  z.union([
    SDKControlInterruptRequestSchema(),
    SDKControlPermissionRequestSchema(),
    SDKControlInitializeRequestSchema(),
    SDKControlSetPermissionModeRequestSchema(),
    SDKControlSetModelRequestSchema(),
    SDKControlSetMaxThinkingTokensRequestSchema(),
    SDKControlMcpStatusRequestSchema(),
    SDKControlGetContextUsageRequestSchema(),
    SDKHookCallbackRequestSchema(),
    SDKControlMcpMessageRequestSchema(),
    SDKControlRewindFilesRequestSchema(),
    SDKControlCancelAsyncMessageRequestSchema(),
    SDKControlSeedReadStateRequestSchema(),
    SDKControlMcpSetServersRequestSchema(),
    SDKControlReloadPluginsRequestSchema(),
    SDKControlMcpReconnectRequestSchema(),
    SDKControlMcpToggleRequestSchema(),
    SDKControlStopTaskRequestSchema(),
    SDKControlApplyFlagSettingsRequestSchema(),
    SDKControlGetSettingsRequestSchema(),
    SDKControlElicitationRequestSchema(),
  ]),
)

/**
 * 控制请求外层包装 Schema
 *
 * 【作用】
 * 所有控制请求的顶层容器，包含：
 * - type: 'control_request'：消息类型标识符，用于与其他消息类型区分
 * - request_id：请求的唯一 ID，用于匹配对应的响应消息（请求-响应关联）
 * - request：具体的控制请求内容（SDKControlRequestInnerSchema 联合）
 */
export const SDKControlRequestSchema = lazySchema(() =>
  z.object({
    type: z.literal('control_request'),
    request_id: z.string(), // 请求唯一标识符，响应中必须包含相同的 request_id
    request: SDKControlRequestInnerSchema(),
  }),
)

/**
 * 控制请求成功响应 Schema
 *
 * 【作用】
 * 成功处理控制请求后的标准响应格式：
 * - subtype: 'success'：标识这是成功响应
 * - request_id：与请求中的 request_id 对应，用于客户端关联
 * - response：可选的响应数据（部分请求无需返回数据）
 */
export const ControlResponseSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('success'),
    request_id: z.string(),
    response: z.record(z.string(), z.unknown()).optional(), // 具体响应体（按请求类型各异）
  }),
)

/**
 * 控制请求错误响应 Schema
 *
 * 【作用】
 * 控制请求处理失败时的标准错误响应格式：
 * - subtype: 'error'：标识这是错误响应
 * - error：错误信息字符串
 * - pending_permission_requests：错误发生时仍在等待的权限请求列表
 *   （允许客户端在错误后继续处理未完成的权限确认）
 */
export const ControlErrorResponseSchema = lazySchema(() =>
  z.object({
    subtype: z.literal('error'),
    request_id: z.string(),
    error: z.string(),
    // 当错误发生时，若有权限请求还在等待中，一并返回（避免阻塞工具执行）
    pending_permission_requests: z
      .array(z.lazy(() => SDKControlRequestSchema()))
      .optional(),
  }),
)

/**
 * 控制响应外层包装 Schema
 *
 * 【作用】
 * 所有控制响应（成功或失败）的顶层容器：
 * - type: 'control_response'：消息类型标识符
 * - response：成功响应或错误响应（由 subtype 字段区分）
 */
export const SDKControlResponseSchema = lazySchema(() =>
  z.object({
    type: z.literal('control_response'),
    response: z.union([ControlResponseSchema(), ControlErrorResponseSchema()]),
  }),
)

/**
 * 取消控制请求 Schema
 *
 * 【作用】
 * 取消一个正在等待响应的控制请求（通过 request_id 定位）。
 * 适用于超时或客户端不再需要响应的场景。
 */
export const SDKControlCancelRequestSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('control_cancel_request'),
      request_id: z.string(), // 要取消的请求 ID
    })
    .describe('Cancels a currently open control request.'),
)

/**
 * Keep-Alive 消息 Schema
 *
 * 【作用】
 * 双向心跳消息，用于保持 WebSocket / stdio 连接活跃，
 * 防止因长时间无数据传输而被中间代理或操作系统关闭连接。
 */
export const SDKKeepAliveMessageSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('keep_alive'),
    })
    .describe('Keep-alive message to maintain WebSocket connection.'),
)

/**
 * 运行时环境变量更新消息 Schema
 *
 * 【作用】
 * 允许 SDK 在会话进行中动态更新 CLI 进程的环境变量，
 * 无需重启进程。常用于 OAuth token 刷新等动态凭证更新场景。
 */
export const SDKUpdateEnvironmentVariablesMessageSchema = lazySchema(() =>
  z
    .object({
      type: z.literal('update_environment_variables'),
      variables: z.record(z.string(), z.string()), // 要更新的环境变量键值对
    })
    .describe('Updates environment variables at runtime.'),
)

// ============================================================================
// 聚合消息类型（Aggregate Message Types）
// ============================================================================

/**
 * stdout 消息联合类型 Schema
 *
 * 【作用】
 * 枚举所有 CLI 可以通过 stdout 输出的消息类型，
 * SDK 实现方按 type/subtype 字段分发处理逻辑：
 * - SDKMessageSchema：标准 AI 消息（user/assistant/result/system 等）
 * - 流式输出相关：streamlined_text、streamlined_tool_use_summary、post_turn_summary
 * - 控制协议：control_response（CLI 对 SDK 请求的响应）
 * - 双向控制请求：control_request（CLI 主动向 SDK 发起的权限请求/Hook 回调等）
 * - 取消请求：control_cancel_request
 * - 心跳：keep_alive
 */
export const StdoutMessageSchema = lazySchema(() =>
  z.union([
    SDKMessageSchema(),
    SDKStreamlinedTextMessageSchema(),
    SDKStreamlinedToolUseSummaryMessageSchema(),
    SDKPostTurnSummaryMessageSchema(),
    SDKControlResponseSchema(),
    SDKControlRequestSchema(),
    SDKControlCancelRequestSchema(),
    SDKKeepAliveMessageSchema(),
  ]),
)

/**
 * stdin 消息联合类型 Schema
 *
 * 【作用】
 * 枚举所有 SDK 实现方可以通过 stdin 发送给 CLI 的消息类型：
 * - SDKUserMessageSchema：用户输入消息（触发新的对话轮次）
 * - SDKControlRequestSchema：SDK 向 CLI 发起的控制请求
 * - SDKControlResponseSchema：SDK 对 CLI 发起的权限请求/Hook 回调的响应
 * - SDKKeepAliveMessageSchema：心跳维持
 * - SDKUpdateEnvironmentVariablesMessageSchema：运行时更新环境变量
 */
export const StdinMessageSchema = lazySchema(() =>
  z.union([
    SDKUserMessageSchema(),
    SDKControlRequestSchema(),
    SDKControlResponseSchema(),
    SDKKeepAliveMessageSchema(),
    SDKUpdateEnvironmentVariablesMessageSchema(),
  ]),
)
