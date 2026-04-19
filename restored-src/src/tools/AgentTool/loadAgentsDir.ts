/**
 * Agent 定义加载与管理模块
 *
 * 在 Claude Code AgentTool 层中，该模块是 Agent 类型系统的核心——
 * 负责定义 Agent 类型层次结构、加载并解析自定义 Agent 定义文件，
 * 以及通过优先级去重机制组装当前会话中可用的完整 Agent 列表。
 *
 * 核心职责：
 * 1. 类型定义：`AgentMcpServerSpec`、`BaseAgentDefinition`、`BuiltInAgentDefinition`、
 *    `CustomAgentDefinition`、`PluginAgentDefinition`、`AgentDefinition`、`AgentDefinitionsResult`
 * 2. 类型守卫：`isBuiltInAgent()`、`isCustomAgent()`、`isPluginAgent()`
 * 3. `getActiveAgentsFromList()` — 基于优先级 Map 的 Agent 去重合并
 * 4. MCP 服务器需求检查：`hasRequiredMcpServers()`、`filterAgentsByMcpRequirements()`
 * 5. `initializeAgentMemorySnapshots()` — Agent 记忆快照的检查与初始化
 * 6. `getAgentDefinitionsWithOverrides` — memoize 缓存的主入口，加载并组装完整 Agent 列表
 * 7. `parseAgentFromMarkdown()` / `parseAgentFromJson()` — 自定义 Agent 解析
 *
 * 设计说明：
 * - `AgentJsonSchema` / `AgentsJsonSchema` 使用 lazySchema 包装，
 *   打破 AppState → loadAgentsDir → settings/types 的循环依赖链
 * - `getAgentDefinitionsWithOverrides` 按 cwd 缓存，避免重复加载
 * - 优先级顺序（后者覆盖前者）：builtIn → plugin → user → project → flag → managed
 */

import { feature } from 'bun:bundle'
import memoize from 'lodash-es/memoize.js'
import { basename } from 'path'
import type { SettingSource } from 'src/utils/settings/constants.js'
import { z } from 'zod/v4'
import { isAutoMemoryEnabled } from '../../memdir/paths.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import {
  type McpServerConfig,
  McpServerConfigSchema,
} from '../../services/mcp/types.js'
import type { ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  EFFORT_LEVELS,
  type EffortValue,
  parseEffortValue,
} from '../../utils/effort.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { parsePositiveIntFromFrontmatter } from '../../utils/frontmatterParser.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { logError } from '../../utils/log.js'
import {
  loadMarkdownFilesForSubdir,
  parseAgentToolsFromFrontmatter,
  parseSlashCommandToolsFromFrontmatter,
} from '../../utils/markdownConfigLoader.js'
import {
  PERMISSION_MODES,
  type PermissionMode,
} from '../../utils/permissions/PermissionMode.js'
import {
  clearPluginAgentCache,
  loadPluginAgents,
} from '../../utils/plugins/loadPluginAgents.js'
import { HooksSchema, type HooksSettings } from '../../utils/settings/types.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import {
  AGENT_COLORS,
  type AgentColorName,
  setAgentColor,
} from './agentColorManager.js'
import { type AgentMemoryScope, loadAgentMemoryPrompt } from './agentMemory.js'
import {
  checkAgentMemorySnapshot,
  initializeFromSnapshot,
} from './agentMemorySnapshot.js'
import { getBuiltInAgents } from './builtInAgents.js'

// Agent 定义中 MCP 服务器规格的类型
// 可以是字符串引用（现有服务器名称），或内联定义 { [name]: config }
export type AgentMcpServerSpec =
  | string // 按名称引用已有服务器（如 "slack"）
  | { [name: string]: McpServerConfig } // 内联定义：{ name: config }

// Agent MCP 服务器规格的 Zod schema
const AgentMcpServerSpecSchema = lazySchema(() =>
  z.union([
    z.string(), // 按名称引用
    z.record(z.string(), McpServerConfigSchema()), // 内联定义：{ name: config }
  ]),
)

// JSON Agent 验证的 Zod schema
// 注意：HooksSchema 使用 lazy 包装，打破 AppState → loadAgentsDir → settings/types
// 的循环依赖链（模块加载时不会触发循环）
const AgentJsonSchema = lazySchema(() =>
  z.object({
    description: z.string().min(1, 'Description cannot be empty'),
    tools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    prompt: z.string().min(1, 'Prompt cannot be empty'),
    model: z
      .string()
      .trim()
      .min(1, 'Model cannot be empty')
      .transform(m => (m.toLowerCase() === 'inherit' ? 'inherit' : m))  // 'inherit' 统一小写处理
      .optional(),
    effort: z.union([z.enum(EFFORT_LEVELS), z.number().int()]).optional(),
    permissionMode: z.enum(PERMISSION_MODES).optional(),
    mcpServers: z.array(AgentMcpServerSpecSchema()).optional(),
    hooks: HooksSchema().optional(),
    maxTurns: z.number().int().positive().optional(),
    skills: z.array(z.string()).optional(),
    initialPrompt: z.string().optional(),
    memory: z.enum(['user', 'project', 'local']).optional(),
    background: z.boolean().optional(),
    // isolation 字段：ant 用户支持 'worktree' 和 'remote'，外部构建只支持 'worktree'
    isolation: (process.env.USER_TYPE === 'ant'
      ? z.enum(['worktree', 'remote'])
      : z.enum(['worktree'])
    ).optional(),
  }),
)

// 多 Agent JSON 的 Zod schema（记录类型：agentType → AgentJsonSchema）
const AgentsJsonSchema = lazySchema(() =>
  z.record(z.string(), AgentJsonSchema()),
)

// 所有 Agent 类型共用的基础字段定义
export type BaseAgentDefinition = {
  agentType: string
  whenToUse: string
  tools?: string[]
  disallowedTools?: string[]
  skills?: string[] // 预加载的技能名称列表（从逗号分隔的 frontmatter 解析）
  mcpServers?: AgentMcpServerSpec[] // 该 Agent 专属的 MCP 服务器列表
  hooks?: HooksSettings // Agent 启动时注册的会话级 hooks
  color?: AgentColorName
  model?: string
  effort?: EffortValue
  permissionMode?: PermissionMode
  maxTurns?: number // 最大 agentic 轮数，超过后停止
  filename?: string // 原始文件名（不含 .md 扩展名，用于 user/project/managed agent）
  baseDir?: string
  criticalSystemReminder_EXPERIMENTAL?: string // 每次用户轮次都会重新注入的简短提醒
  requiredMcpServers?: string[] // 必须配置的 MCP 服务器名称模式，未满足则 Agent 不可用
  background?: boolean // 始终以后台任务模式启动
  initialPrompt?: string // 追加到第一个用户轮次前（支持斜杠命令）
  memory?: AgentMemoryScope // 持久记忆作用域
  isolation?: 'worktree' | 'remote' // 在独立 git worktree 或远程（仅 ant）中运行
  pendingSnapshotUpdate?: { snapshotTimestamp: string }
  /** 从 Agent 的 userContext 中省略 CLAUDE.md 层级。
   * 只读 Agent（Explore、Plan）不需要提交/PR/lint 规范——
   * 主 Agent 拥有完整的 CLAUDE.md 并解释其输出。
   * 可为 3400 万+ 次 Explore 生成节省约 5-15 Gtok/week。
   * 杀死开关：tengu_slim_subagent_claudemd。 */
  omitClaudeMd?: boolean
}

// 内置 Agent：仅使用动态提示，没有静态 systemPrompt 字段
export type BuiltInAgentDefinition = BaseAgentDefinition & {
  source: 'built-in'
  baseDir: 'built-in'
  callback?: () => void
  // 动态系统提示生成函数，接收工具使用上下文参数
  getSystemPrompt: (params: {
    toolUseContext: Pick<ToolUseContext, 'options'>
  }) => string
}

// 自定义 Agent：来自 user/project/policy 设置，提示通过闭包存储
export type CustomAgentDefinition = BaseAgentDefinition & {
  getSystemPrompt: () => string  // 无参数，提示内容通过闭包捕获
  source: SettingSource
  filename?: string
  baseDir?: string
}

// 插件 Agent：类似自定义 Agent，但包含插件元数据，提示通过闭包存储
export type PluginAgentDefinition = BaseAgentDefinition & {
  getSystemPrompt: () => string
  source: 'plugin'
  filename?: string
  plugin: string  // 所属插件名称
}

// 所有 Agent 类型的联合类型
export type AgentDefinition =
  | BuiltInAgentDefinition
  | CustomAgentDefinition
  | PluginAgentDefinition

// 运行时类型守卫，用于区分不同 Agent 类型
/** 判断是否为内置 Agent（source === 'built-in'） */
export function isBuiltInAgent(
  agent: AgentDefinition,
): agent is BuiltInAgentDefinition {
  return agent.source === 'built-in'
}

/** 判断是否为自定义 Agent（非 built-in 且非 plugin） */
export function isCustomAgent(
  agent: AgentDefinition,
): agent is CustomAgentDefinition {
  return agent.source !== 'built-in' && agent.source !== 'plugin'
}

/** 判断是否为插件 Agent（source === 'plugin'） */
export function isPluginAgent(
  agent: AgentDefinition,
): agent is PluginAgentDefinition {
  return agent.source === 'plugin'
}

// Agent 定义加载结果类型
export type AgentDefinitionsResult = {
  activeAgents: AgentDefinition[]   // 去重后的活跃 Agent 列表
  allAgents: AgentDefinition[]      // 包含所有来源的完整 Agent 列表（含重复）
  failedFiles?: Array<{ path: string; error: string }>  // 解析失败的文件记录
  allowedAgentTypes?: string[]      // 允许的 Agent 类型白名单
}

/**
 * 基于优先级 Map 从完整列表中提取活跃 Agent 列表。
 *
 * 优先级顺序（后者覆盖前者，按 agentType 去重）：
 * builtIn → plugin → user → project → flag → managed
 *
 * 实现方式：遍历各来源分组，按顺序将 agentType → agent 写入 Map，
 * 后写入的同类型 Agent 覆盖先写入的，最终 Map 值即为活跃 Agent。
 *
 * @param allAgents 包含所有来源的完整 Agent 列表
 * @returns 去重后按优先级合并的活跃 Agent 数组
 */
export function getActiveAgentsFromList(
  allAgents: AgentDefinition[],
): AgentDefinition[] {
  // 按来源分组
  const builtInAgents = allAgents.filter(a => a.source === 'built-in')
  const pluginAgents = allAgents.filter(a => a.source === 'plugin')
  const userAgents = allAgents.filter(a => a.source === 'userSettings')
  const projectAgents = allAgents.filter(a => a.source === 'projectSettings')
  const managedAgents = allAgents.filter(a => a.source === 'policySettings')
  const flagAgents = allAgents.filter(a => a.source === 'flagSettings')

  // 优先级从低到高排列各组（后面的组会覆盖前面同类型的 Agent）
  const agentGroups = [
    builtInAgents,
    pluginAgents,
    userAgents,
    projectAgents,
    flagAgents,
    managedAgents,
  ]

  // 使用 Map 按 agentType 去重，后写入的覆盖先写入的
  const agentMap = new Map<string, AgentDefinition>()

  for (const agents of agentGroups) {
    for (const agent of agents) {
      agentMap.set(agent.agentType, agent)  // 同 agentType 后者覆盖前者
    }
  }

  return Array.from(agentMap.values())
}

/**
 * 检查 Agent 的必需 MCP 服务器是否全部可用。
 *
 * 若 Agent 没有 requiredMcpServers 字段，或字段为空，则直接返回 true。
 * 否则对每个必需模式（case-insensitive）检查是否有可用服务器名称包含该模式。
 *
 * @param agent 待检查的 Agent 定义
 * @param availableServers 当前可用的 MCP 服务器名称列表（如 mcp.clients）
 * @returns 所有必需服务器均已配置则返回 true，否则返回 false
 */
export function hasRequiredMcpServers(
  agent: AgentDefinition,
  availableServers: string[],
): boolean {
  // 无必需服务器：直接通过
  if (!agent.requiredMcpServers || agent.requiredMcpServers.length === 0) {
    return true
  }
  // 每个必需模式必须至少匹配一个可用服务器（不区分大小写）
  return agent.requiredMcpServers.every(pattern =>
    availableServers.some(server =>
      server.toLowerCase().includes(pattern.toLowerCase()),
    ),
  )
}

/**
 * 按 MCP 服务器需求过滤 Agent 列表。
 *
 * 仅返回其必需 MCP 服务器全部可用的 Agent。
 *
 * @param agents 待过滤的 Agent 列表
 * @param availableServers 当前可用的 MCP 服务器名称列表
 * @returns 满足 MCP 服务器需求的 Agent 数组
 */
export function filterAgentsByMcpRequirements(
  agents: AgentDefinition[],
  availableServers: string[],
): AgentDefinition[] {
  return agents.filter(agent => hasRequiredMcpServers(agent, availableServers))
}

/**
 * 检查并初始化 Agent 的项目记忆快照。
 *
 * 针对启用了记忆功能的自定义 Agent，执行以下操作：
 * - 若本地记忆不存在：从快照复制初始化（'initialize' 动作）
 * - 若快照较本地更新：记录 pendingSnapshotUpdate，等待用户确认更新（'prompt-update' 动作）
 * - 其他情况：无需操作，静默跳过
 *
 * @param agents 已解析的自定义 Agent 列表
 */
async function initializeAgentMemorySnapshots(
  agents: CustomAgentDefinition[],
): Promise<void> {
  // 并行检查所有 user 作用域 Agent 的记忆快照状态
  await Promise.all(
    agents.map(async agent => {
      // 仅处理 user 作用域的记忆 Agent
      if (agent.memory !== 'user') return
      const result = await checkAgentMemorySnapshot(
        agent.agentType,
        agent.memory,
      )
      switch (result.action) {
        case 'initialize':
          // 本地记忆不存在：从快照初始化
          logForDebugging(
            `Initializing ${agent.agentType} memory from project snapshot`,
          )
          await initializeFromSnapshot(
            agent.agentType,
            agent.memory,
            result.snapshotTimestamp!,
          )
          break
        case 'prompt-update':
          // 快照比本地更新：记录 pending，等待用户交互时提示更新
          agent.pendingSnapshotUpdate = {
            snapshotTimestamp: result.snapshotTimestamp!,
          }
          logForDebugging(
            `Newer snapshot available for ${agent.agentType} memory (snapshot: ${result.snapshotTimestamp})`,
          )
          break
        // 'none' 或其他：无需操作，不处理
      }
    }),
  )
}

/**
 * 获取当前 cwd 下完整的 Agent 定义列表（含覆盖规则）。
 *
 * 该函数以 cwd 为缓存键进行 memoize，避免重复加载磁盘文件。
 *
 * 加载流程：
 * 1. CLAUDE_CODE_SIMPLE 环境变量快速路径：仅返回内置 Agent
 * 2. 加载 markdown Agent 文件（user/project/policy 目录）
 * 3. 并发加载插件 Agent + 初始化记忆快照（若 AGENT_MEMORY_SNAPSHOT 已启用）
 * 4. 调用 getActiveAgentsFromList() 按优先级去重合并
 * 5. 为所有活跃 Agent 初始化颜色
 * 6. 返回 AgentDefinitionsResult（错误时降级返回内置 Agent）
 *
 * @param cwd 当前工作目录（作为缓存键）
 * @returns AgentDefinitionsResult（含 activeAgents、allAgents、failedFiles）
 */
export const getAgentDefinitionsWithOverrides = memoize(
  async (cwd: string): Promise<AgentDefinitionsResult> => {
    // 简单模式：跳过自定义 Agent，仅返回内置 Agent
    if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
      const builtInAgents = getBuiltInAgents()
      return {
        activeAgents: builtInAgents,
        allAgents: builtInAgents,
      }
    }

    try {
      // 加载 'agents' 子目录下的所有 markdown Agent 文件
      const markdownFiles = await loadMarkdownFilesForSubdir('agents', cwd)

      const failedFiles: Array<{ path: string; error: string }> = []
      // 解析每个 markdown 文件为 CustomAgentDefinition
      const customAgents = markdownFiles
        .map(({ filePath, baseDir, frontmatter, content, source }) => {
          const agent = parseAgentFromMarkdown(
            filePath,
            baseDir,
            frontmatter,
            content,
            source,
          )
          if (!agent) {
            // 静默跳过没有 'name' frontmatter 的 markdown 文件
            // （可能是与 Agent 定义共存的参考文档）
            // 仅对看起来像 Agent 尝试（含 'name' 字段）的文件报告错误
            if (!frontmatter['name']) {
              return null
            }
            const errorMsg = getParseError(frontmatter)
            failedFiles.push({ path: filePath, error: errorMsg })
            logForDebugging(
              `Failed to parse agent from ${filePath}: ${errorMsg}`,
            )
            logEvent('tengu_agent_parse_error', {
              error:
                errorMsg as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              location:
                source as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            return null
          }
          return agent
        })
        .filter(agent => agent !== null)

      // 并发启动插件 Agent 加载和记忆快照初始化——
      // loadPluginAgents 已 memoize 且无参数，两者相互独立。
      // 使用 Promise.all 确保任一方抛出时，另一方不成为悬空 Promise。
      let pluginAgentsPromise = loadPluginAgents()
      if (feature('AGENT_MEMORY_SNAPSHOT') && isAutoMemoryEnabled()) {
        // 同时等待插件 Agent 加载和记忆快照初始化
        const [pluginAgents_] = await Promise.all([
          pluginAgentsPromise,
          initializeAgentMemorySnapshots(customAgents),
        ])
        pluginAgentsPromise = Promise.resolve(pluginAgents_)
      }
      const pluginAgents = await pluginAgentsPromise

      // 获取内置 Agent 列表
      const builtInAgents = getBuiltInAgents()

      // 组装完整 Agent 列表（含重复，按优先级排列）
      const allAgentsList: AgentDefinition[] = [
        ...builtInAgents,
        ...pluginAgents,
        ...customAgents,
      ]

      // 按优先级去重，获取活跃 Agent 列表
      const activeAgents = getActiveAgentsFromList(allAgentsList)

      // 为所有活跃 Agent 初始化颜色（若定义了颜色）
      for (const agent of activeAgents) {
        if (agent.color) {
          setAgentColor(agent.agentType, agent.color)
        }
      }

      return {
        activeAgents,
        allAgents: allAgentsList,
        failedFiles: failedFiles.length > 0 ? failedFiles : undefined,
      }
    } catch (error) {
      // 加载失败时降级：仍返回内置 Agent，避免完全不可用
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logForDebugging(`Error loading agent definitions: ${errorMessage}`)
      logError(error)
      const builtInAgents = getBuiltInAgents()
      return {
        activeAgents: builtInAgents,
        allAgents: builtInAgents,
        failedFiles: [{ path: 'unknown', error: errorMessage }],
      }
    }
  },
)

/**
 * 清除 Agent 定义缓存。
 *
 * 清除 memoize 缓存（按 cwd）和插件 Agent 缓存，
 * 下次调用 getAgentDefinitionsWithOverrides 时将重新从磁盘加载。
 */
export function clearAgentDefinitionsCache(): void {
  getAgentDefinitionsWithOverrides.cache.clear?.()  // 清除 memoize 缓存
  clearPluginAgentCache()                           // 清除插件 Agent 缓存
}

/**
 * 辅助函数：根据 frontmatter 内容确定具体的解析错误原因。
 *
 * @param frontmatter Agent 文件的 frontmatter 对象
 * @returns 描述解析失败原因的错误消息字符串
 */
function getParseError(frontmatter: Record<string, unknown>): string {
  const agentType = frontmatter['name']
  const description = frontmatter['description']

  // 缺少 'name' 字段
  if (!agentType || typeof agentType !== 'string') {
    return 'Missing required "name" field in frontmatter'
  }

  // 缺少 'description' 字段
  if (!description || typeof description !== 'string') {
    return 'Missing required "description" field in frontmatter'
  }

  return 'Unknown parsing error'
}

/**
 * 从 frontmatter 中解析 hooks 配置，使用 HooksSchema 进行验证。
 *
 * @param frontmatter 包含潜在 hooks 的 frontmatter 对象
 * @param agentType Agent 类型名称（用于日志记录）
 * @returns 已解析的 HooksSettings，若无效或缺失则返回 undefined
 */
function parseHooksFromFrontmatter(
  frontmatter: Record<string, unknown>,
  agentType: string,
): HooksSettings | undefined {
  // 无 hooks 字段：直接返回 undefined
  if (!frontmatter.hooks) {
    return undefined
  }

  // 使用 HooksSchema 进行 Zod 验证
  const result = HooksSchema().safeParse(frontmatter.hooks)
  if (!result.success) {
    logForDebugging(
      `Invalid hooks in agent '${agentType}': ${result.error.message}`,
    )
    return undefined
  }
  return result.data
}

/**
 * 从 JSON 数据解析 Agent 定义。
 *
 * 解析流程：
 * 1. Zod 验证 JSON 结构（AgentJsonSchema）
 * 2. 解析工具列表；若启用记忆，注入 Write/Edit/Read 工具
 * 3. 解析 disallowedTools
 * 4. 构建 CustomAgentDefinition，getSystemPrompt 通过闭包捕获
 *    （若启用记忆，在系统提示末尾追加记忆内容）
 * 5. 条件散布各可选字段
 *
 * @param name Agent 类型名称（来自 JSON 键名）
 * @param definition 待解析的 JSON 对象
 * @param source 来源标识（默认 'flagSettings'）
 * @returns 解析成功返回 CustomAgentDefinition，失败返回 null
 */
export function parseAgentFromJson(
  name: string,
  definition: unknown,
  source: SettingSource = 'flagSettings',
): CustomAgentDefinition | null {
  try {
    // Zod 验证 JSON 结构
    const parsed = AgentJsonSchema().parse(definition)

    // 解析工具列表
    let tools = parseAgentToolsFromFrontmatter(parsed.tools)

    // 若启用记忆且有 memory 字段，注入 Write/Edit/Read 工具以支持记忆访问
    if (isAutoMemoryEnabled() && parsed.memory && tools !== undefined) {
      const toolSet = new Set(tools)
      for (const tool of [
        FILE_WRITE_TOOL_NAME,
        FILE_EDIT_TOOL_NAME,
        FILE_READ_TOOL_NAME,
      ]) {
        // 避免重复注入
        if (!toolSet.has(tool)) {
          tools = [...tools, tool]
        }
      }
    }

    // 解析禁用工具列表
    const disallowedTools =
      parsed.disallowedTools !== undefined
        ? parseAgentToolsFromFrontmatter(parsed.disallowedTools)
        : undefined

    // 捕获系统提示字符串（供 getSystemPrompt 闭包使用）
    const systemPrompt = parsed.prompt

    const agent: CustomAgentDefinition = {
      agentType: name,
      whenToUse: parsed.description,
      ...(tools !== undefined ? { tools } : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
      // getSystemPrompt 通过闭包捕获 systemPrompt 和 memory 信息
      getSystemPrompt: () => {
        if (isAutoMemoryEnabled() && parsed.memory) {
          // 若启用记忆，在系统提示末尾追加记忆内容
          return (
            systemPrompt + '\n\n' + loadAgentMemoryPrompt(name, parsed.memory)
          )
        }
        return systemPrompt
      },
      source,
      ...(parsed.model ? { model: parsed.model } : {}),
      ...(parsed.effort !== undefined ? { effort: parsed.effort } : {}),
      ...(parsed.permissionMode
        ? { permissionMode: parsed.permissionMode }
        : {}),
      ...(parsed.mcpServers && parsed.mcpServers.length > 0
        ? { mcpServers: parsed.mcpServers }
        : {}),
      ...(parsed.hooks ? { hooks: parsed.hooks } : {}),
      ...(parsed.maxTurns !== undefined ? { maxTurns: parsed.maxTurns } : {}),
      ...(parsed.skills && parsed.skills.length > 0
        ? { skills: parsed.skills }
        : {}),
      ...(parsed.initialPrompt ? { initialPrompt: parsed.initialPrompt } : {}),
      ...(parsed.background ? { background: parsed.background } : {}),
      ...(parsed.memory ? { memory: parsed.memory } : {}),
      ...(parsed.isolation ? { isolation: parsed.isolation } : {}),
    }

    return agent
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`Error parsing agent '${name}' from JSON: ${errorMessage}`)
    logError(error)
    return null
  }
}

/**
 * 从 JSON 对象中解析多个 Agent 定义。
 *
 * 使用 AgentsJsonSchema 验证整体结构（record 类型），
 * 然后对每个条目调用 parseAgentFromJson。
 *
 * @param agentsJson 待解析的 JSON 对象（{ agentType: definition }）
 * @param source 来源标识（默认 'flagSettings'）
 * @returns 解析成功的 AgentDefinition 数组（失败条目被过滤掉）
 */
export function parseAgentsFromJson(
  agentsJson: unknown,
  source: SettingSource = 'flagSettings',
): AgentDefinition[] {
  try {
    // 验证整体 JSON 结构
    const parsed = AgentsJsonSchema().parse(agentsJson)
    return Object.entries(parsed)
      .map(([name, def]) => parseAgentFromJson(name, def, source))
      .filter((agent): agent is CustomAgentDefinition => agent !== null)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`Error parsing agents from JSON: ${errorMessage}`)
    logError(error)
    return []
  }
}

/**
 * 从 markdown 文件数据解析 Agent 定义。
 *
 * 解析流程：
 * 1. 验证必需字段（name、description）
 * 2. 解析可选字段：color、model、background、memory、isolation、
 *    effort、permissionMode、maxTurns、tools、disallowedTools、skills、
 *    initialPrompt、mcpServers、hooks
 * 3. 构建 CustomAgentDefinition，getSystemPrompt 通过闭包捕获
 *    （若启用记忆，在系统提示末尾追加记忆内容）
 *
 * 特殊处理：
 * - isolation 字段：ant 用户支持 'worktree' | 'remote'；外部构建仅支持 'worktree'
 * - 颜色值须在 AGENT_COLORS 列表中才会生效
 * - whenToUse 中的 \\n 转义序列还原为真实换行符
 *
 * @param filePath 文件路径（用于日志和 filename 提取）
 * @param baseDir 基础目录（用于相对路径解析）
 * @param frontmatter 解析后的 frontmatter 键值对
 * @param content markdown 正文（作为系统提示内容）
 * @param source 来源标识（userSettings / projectSettings 等）
 * @returns 解析成功返回 CustomAgentDefinition，失败返回 null
 */
export function parseAgentFromMarkdown(
  filePath: string,
  baseDir: string,
  frontmatter: Record<string, unknown>,
  content: string,
  source: SettingSource,
): CustomAgentDefinition | null {
  try {
    const agentType = frontmatter['name']
    let whenToUse = frontmatter['description'] as string

    // 验证必需字段——静默跳过无 Agent frontmatter 的文件
    // （它们可能是与 Agent 定义共存的参考文档）
    if (!agentType || typeof agentType !== 'string') {
      return null
    }
    if (!whenToUse || typeof whenToUse !== 'string') {
      logForDebugging(
        `Agent file ${filePath} is missing required 'description' in frontmatter`,
      )
      return null
    }

    // 将 YAML 解析时转义的换行符还原为真实换行
    whenToUse = whenToUse.replace(/\\n/g, '\n')

    // 解析颜色字段
    const color = frontmatter['color'] as AgentColorName | undefined

    // 解析模型字段：'inherit' 统一小写处理
    const modelRaw = frontmatter['model']
    let model: string | undefined
    if (typeof modelRaw === 'string' && modelRaw.trim().length > 0) {
      const trimmed = modelRaw.trim()
      model = trimmed.toLowerCase() === 'inherit' ? 'inherit' : trimmed
    }

    // 解析 background 标志
    const backgroundRaw = frontmatter['background']

    if (
      backgroundRaw !== undefined &&
      backgroundRaw !== 'true' &&
      backgroundRaw !== 'false' &&
      backgroundRaw !== true &&
      backgroundRaw !== false
    ) {
      logForDebugging(
        `Agent file ${filePath} has invalid background value '${backgroundRaw}'. Must be 'true', 'false', or omitted.`,
      )
    }

    // 只有明确为 true 时才设置 background，其他情况为 undefined
    const background =
      backgroundRaw === 'true' || backgroundRaw === true ? true : undefined

    // 解析记忆作用域
    const VALID_MEMORY_SCOPES: AgentMemoryScope[] = ['user', 'project', 'local']
    const memoryRaw = frontmatter['memory'] as string | undefined
    let memory: AgentMemoryScope | undefined
    if (memoryRaw !== undefined) {
      if (VALID_MEMORY_SCOPES.includes(memoryRaw as AgentMemoryScope)) {
        memory = memoryRaw as AgentMemoryScope
      } else {
        logForDebugging(
          `Agent file ${filePath} has invalid memory value '${memoryRaw}'. Valid options: ${VALID_MEMORY_SCOPES.join(', ')}`,
        )
      }
    }

    // 解析隔离模式：'remote' 仅限 ant 用户；外部构建在解析时拒绝该值
    type IsolationMode = 'worktree' | 'remote'
    const VALID_ISOLATION_MODES: readonly IsolationMode[] =
      process.env.USER_TYPE === 'ant' ? ['worktree', 'remote'] : ['worktree']
    const isolationRaw = frontmatter['isolation'] as string | undefined
    let isolation: IsolationMode | undefined
    if (isolationRaw !== undefined) {
      if (VALID_ISOLATION_MODES.includes(isolationRaw as IsolationMode)) {
        isolation = isolationRaw as IsolationMode
      } else {
        logForDebugging(
          `Agent file ${filePath} has invalid isolation value '${isolationRaw}'. Valid options: ${VALID_ISOLATION_MODES.join(', ')}`,
        )
      }
    }

    // 解析 effort 字段（支持字符串级别和整数）
    const effortRaw = frontmatter['effort']
    const parsedEffort =
      effortRaw !== undefined ? parseEffortValue(effortRaw) : undefined

    if (effortRaw !== undefined && parsedEffort === undefined) {
      logForDebugging(
        `Agent file ${filePath} has invalid effort '${effortRaw}'. Valid options: ${EFFORT_LEVELS.join(', ')} or an integer`,
      )
    }

    // 解析 permissionMode 字段
    const permissionModeRaw = frontmatter['permissionMode'] as
      | string
      | undefined
    const isValidPermissionMode =
      permissionModeRaw &&
      (PERMISSION_MODES as readonly string[]).includes(permissionModeRaw)

    if (permissionModeRaw && !isValidPermissionMode) {
      const errorMsg = `Agent file ${filePath} has invalid permissionMode '${permissionModeRaw}'. Valid options: ${PERMISSION_MODES.join(', ')}`
      logForDebugging(errorMsg)
    }

    // 解析 maxTurns 字段（必须为正整数）
    const maxTurnsRaw = frontmatter['maxTurns']
    const maxTurns = parsePositiveIntFromFrontmatter(maxTurnsRaw)
    if (maxTurnsRaw !== undefined && maxTurns === undefined) {
      logForDebugging(
        `Agent file ${filePath} has invalid maxTurns '${maxTurnsRaw}'. Must be a positive integer.`,
      )
    }

    // 提取不含扩展名的文件名
    const filename = basename(filePath, '.md')

    // 解析工具列表
    let tools = parseAgentToolsFromFrontmatter(frontmatter['tools'])

    // 若启用记忆且有 memory 字段，注入 Write/Edit/Read 工具以支持记忆访问
    if (isAutoMemoryEnabled() && memory && tools !== undefined) {
      const toolSet = new Set(tools)
      for (const tool of [
        FILE_WRITE_TOOL_NAME,
        FILE_EDIT_TOOL_NAME,
        FILE_READ_TOOL_NAME,
      ]) {
        // 避免重复注入
        if (!toolSet.has(tool)) {
          tools = [...tools, tool]
        }
      }
    }

    // 解析禁用工具列表
    const disallowedToolsRaw = frontmatter['disallowedTools']
    const disallowedTools =
      disallowedToolsRaw !== undefined
        ? parseAgentToolsFromFrontmatter(disallowedToolsRaw)
        : undefined

    // 解析技能列表（斜杠命令格式）
    const skills = parseSlashCommandToolsFromFrontmatter(frontmatter['skills'])

    // 解析初始提示（仅接受非空字符串）
    const initialPromptRaw = frontmatter['initialPrompt']
    const initialPrompt =
      typeof initialPromptRaw === 'string' && initialPromptRaw.trim()
        ? initialPromptRaw
        : undefined

    // 从 frontmatter 中解析 mcpServers（使用与 JSON Agent 相同的 Zod 验证）
    const mcpServersRaw = frontmatter['mcpServers']
    let mcpServers: AgentMcpServerSpec[] | undefined
    if (Array.isArray(mcpServersRaw)) {
      mcpServers = mcpServersRaw
        .map(item => {
          const result = AgentMcpServerSpecSchema().safeParse(item)
          if (result.success) {
            return result.data
          }
          logForDebugging(
            `Agent file ${filePath} has invalid mcpServers item: ${jsonStringify(item)}. Error: ${result.error.message}`,
          )
          return null
        })
        .filter((item): item is AgentMcpServerSpec => item !== null)
    }

    // 解析 hooks 配置
    const hooks = parseHooksFromFrontmatter(frontmatter, agentType)

    // markdown 正文去除首尾空白作为系统提示内容
    const systemPrompt = content.trim()
    const agentDef: CustomAgentDefinition = {
      baseDir,
      agentType: agentType,
      whenToUse: whenToUse,
      ...(tools !== undefined ? { tools } : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
      ...(skills !== undefined ? { skills } : {}),
      ...(initialPrompt !== undefined ? { initialPrompt } : {}),
      ...(mcpServers !== undefined && mcpServers.length > 0
        ? { mcpServers }
        : {}),
      ...(hooks !== undefined ? { hooks } : {}),
      // getSystemPrompt 通过闭包捕获 systemPrompt、agentType 和 memory
      getSystemPrompt: () => {
        if (isAutoMemoryEnabled() && memory) {
          // 若启用记忆，在系统提示末尾追加记忆提示内容
          const memoryPrompt = loadAgentMemoryPrompt(agentType, memory)
          return systemPrompt + '\n\n' + memoryPrompt
        }
        return systemPrompt
      },
      source,
      filename,
      // 颜色：必须为有效的 AgentColorName 才写入
      ...(color && typeof color === 'string' && AGENT_COLORS.includes(color)
        ? { color }
        : {}),
      ...(model !== undefined ? { model } : {}),
      ...(parsedEffort !== undefined ? { effort: parsedEffort } : {}),
      // permissionMode：仅在通过验证时写入
      ...(isValidPermissionMode
        ? { permissionMode: permissionModeRaw as PermissionMode }
        : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(background ? { background } : {}),
      ...(memory ? { memory } : {}),
      ...(isolation ? { isolation } : {}),
    }
    return agentDef
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    logForDebugging(`Error parsing agent from ${filePath}: ${errorMessage}`)
    logError(error)
    return null
  }
}
