/**
 * prompt.ts — ListMcpResourcesTool 的工具名称与提示词常量
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件为 ListMcpResourcesTool 提供工具名称和两段提示词字符串。
 * ListMcpResourcesTool.ts 在注册工具时使用 LIST_MCP_RESOURCES_TOOL_NAME，
 * 并分别在 description() 和 prompt() 方法中使用 DESCRIPTION 和 PROMPT。
 *
 * 【主要功能】
 * - 导出 LIST_MCP_RESOURCES_TOOL_NAME（工具名称 "ListMcpResourcesTool"）
 * - 导出 DESCRIPTION：面向用户的简短工具描述，含使用示例
 * - 导出 PROMPT：详细的工具使用说明，含参数说明，供模型理解工具行为
 */

/** 工具名称常量，供全局引用 */
export const LIST_MCP_RESOURCES_TOOL_NAME = 'ListMcpResourcesTool'

/**
 * 工具简短描述（用于 Claude API tool definition 的 description 字段）。
 * 说明工具的核心能力：列出所有已配置 MCP 服务器的可用资源，
 * 每个资源对象包含 server 字段标识来源服务器。
 * 提供基本使用示例。
 */
export const DESCRIPTION = `
Lists available resources from configured MCP servers.
Each resource object includes a 'server' field indicating which server it's from.

Usage examples:
- List all resources from all servers: \`listMcpResources\`
- List resources from a specific server: \`listMcpResources({ server: "myserver" })\`
`

/**
 * 工具详细提示词（用于 prompt() 方法），供模型理解工具的完整行为。
 * 包含：
 * - 工具功能说明：列出 MCP 服务器的可用资源，附加 server 字段标识来源
 * - 参数说明：server（可选，不提供则返回所有服务器的资源）
 */
export const PROMPT = `
List available resources from configured MCP servers.
Each returned resource will include all standard MCP resource fields plus a 'server' field
indicating which server the resource belongs to.

Parameters:
- server (optional): The name of a specific MCP server to get resources from. If not provided,
  resources from all servers will be returned.
`
