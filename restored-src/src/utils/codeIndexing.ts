/**
 * 代码索引工具使用检测模块。
 *
 * 在 Claude Code 系统中，该模块识别用户是否在通过 CLI 命令或 MCP 服务器集成
 * 使用常见代码索引工具（如 Sourcegraph、Cody、Cursor 等），用于分析统计：
 * - detectCodeIndexingFromCommand()：从 bash 命令的首个词检测代码索引 CLI 工具
 * - detectCodeIndexingFromMcpTool()：从 mcp__serverName__toolName 格式检测代码索引 MCP 工具
 * - detectCodeIndexingFromMcpServerName()：根据 MCP 服务器名称检测代码索引工具
 */

/**
 * 已知代码索引工具的规范化标识符枚举类型。
 * 用于遥测事件上报，统一各检测路径（CLI/MCP）产生的工具名称。
 */
export type CodeIndexingTool =
  // 代码搜索引擎
  | 'sourcegraph'
  | 'hound'
  | 'seagoat'
  | 'bloop'
  | 'gitloop'
  // 带索引能力的 AI 编码助手
  | 'cody'
  | 'aider'
  | 'continue'
  | 'github-copilot'
  | 'cursor'
  | 'tabby'
  | 'codeium'
  | 'tabnine'
  | 'augment'
  | 'windsurf'
  | 'aide'
  | 'pieces'
  | 'qodo'
  | 'amazon-q'
  | 'gemini'
  // MCP 代码索引服务器
  | 'claude-context'
  | 'code-index-mcp'
  | 'local-code-search'
  | 'autodev-codebase'
  // 上下文提供者
  | 'openctx'

/**
 * CLI 命令首词到代码索引工具名的映射表。
 * 用于 detectCodeIndexingFromCommand() 的直接查表匹配。
 */
const CLI_COMMAND_MAPPING: Record<string, CodeIndexingTool> = {
  // Sourcegraph 生态
  src: 'sourcegraph',
  cody: 'cody',
  // AI 编码助手
  aider: 'aider',
  tabby: 'tabby',
  tabnine: 'tabnine',
  augment: 'augment',
  pieces: 'pieces',
  qodo: 'qodo',
  aide: 'aide',
  // 代码搜索工具
  hound: 'hound',
  seagoat: 'seagoat',
  bloop: 'bloop',
  gitloop: 'gitloop',
  // 云服务商 AI 助手
  q: 'amazon-q',
  gemini: 'gemini',
}

/**
 * MCP 服务器名称正则模式到代码索引工具名的映射数组。
 * 顺序匹配，第一个命中的模式决定结果，大小写不敏感。
 * 用于 detectCodeIndexingFromMcpTool() 和 detectCodeIndexingFromMcpServerName()。
 */
const MCP_SERVER_PATTERNS: Array<{
  pattern: RegExp
  tool: CodeIndexingTool
}> = [
  // Sourcegraph 生态
  { pattern: /^sourcegraph$/i, tool: 'sourcegraph' },
  { pattern: /^cody$/i, tool: 'cody' },
  { pattern: /^openctx$/i, tool: 'openctx' },
  // AI 编码助手
  { pattern: /^aider$/i, tool: 'aider' },
  { pattern: /^continue$/i, tool: 'continue' },
  { pattern: /^github[-_]?copilot$/i, tool: 'github-copilot' },
  { pattern: /^copilot$/i, tool: 'github-copilot' },
  { pattern: /^cursor$/i, tool: 'cursor' },
  { pattern: /^tabby$/i, tool: 'tabby' },
  { pattern: /^codeium$/i, tool: 'codeium' },
  { pattern: /^tabnine$/i, tool: 'tabnine' },
  { pattern: /^augment[-_]?code$/i, tool: 'augment' },
  { pattern: /^augment$/i, tool: 'augment' },
  { pattern: /^windsurf$/i, tool: 'windsurf' },
  { pattern: /^aide$/i, tool: 'aide' },
  { pattern: /^codestory$/i, tool: 'aide' },
  { pattern: /^pieces$/i, tool: 'pieces' },
  { pattern: /^qodo$/i, tool: 'qodo' },
  { pattern: /^amazon[-_]?q$/i, tool: 'amazon-q' },
  { pattern: /^gemini[-_]?code[-_]?assist$/i, tool: 'gemini' },
  { pattern: /^gemini$/i, tool: 'gemini' },
  // 代码搜索工具
  { pattern: /^hound$/i, tool: 'hound' },
  { pattern: /^seagoat$/i, tool: 'seagoat' },
  { pattern: /^bloop$/i, tool: 'bloop' },
  { pattern: /^gitloop$/i, tool: 'gitloop' },
  // MCP 代码索引服务器
  { pattern: /^claude[-_]?context$/i, tool: 'claude-context' },
  { pattern: /^code[-_]?index[-_]?mcp$/i, tool: 'code-index-mcp' },
  { pattern: /^code[-_]?index$/i, tool: 'code-index-mcp' },
  { pattern: /^local[-_]?code[-_]?search$/i, tool: 'local-code-search' },
  { pattern: /^codebase$/i, tool: 'autodev-codebase' },
  { pattern: /^autodev[-_]?codebase$/i, tool: 'autodev-codebase' },
  { pattern: /^code[-_]?context$/i, tool: 'claude-context' },
]

/**
 * 检测 bash 命令是否调用了已知的代码索引 CLI 工具。
 * 取命令行首词（去除首尾空白后按空格分割）进行查表；
 * 对 npx/bunx 前缀命令则取第二个词进行匹配，覆盖 "npx cody ..." 等用法。
 *
 * @param command - 完整的 bash 命令字符串
 * @returns 代码索引工具标识符，非代码索引命令时返回 undefined
 *
 * @example
 * detectCodeIndexingFromCommand('src search "pattern"') // returns 'sourcegraph'
 * detectCodeIndexingFromCommand('cody chat --message "help"') // returns 'cody'
 * detectCodeIndexingFromCommand('ls -la') // returns undefined
 */
export function detectCodeIndexingFromCommand(
  command: string,
): CodeIndexingTool | undefined {
  // 去除首尾空白后提取第一个词（转为小写进行大小写不敏感匹配）
  const trimmed = command.trim()
  const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase()

  if (!firstWord) {
    return undefined
  }

  // npx/bunx 是包运行器前缀，实际工具名为第二个词
  if (firstWord === 'npx' || firstWord === 'bunx') {
    const secondWord = trimmed.split(/\s+/)[1]?.toLowerCase()
    if (secondWord && secondWord in CLI_COMMAND_MAPPING) {
      return CLI_COMMAND_MAPPING[secondWord]
    }
  }

  // 直接查表：命令名精确匹配
  return CLI_COMMAND_MAPPING[firstWord]
}

/**
 * 检测 MCP 工具名是否来自代码索引服务器。
 * MCP 工具名格式为 mcp__serverName__toolName，
 * 提取中间的 serverName 后逐一匹配 MCP_SERVER_PATTERNS。
 *
 * @param toolName - MCP 工具名称（格式：mcp__serverName__toolName）
 * @returns 代码索引工具标识符，非代码索引工具时返回 undefined
 */
export function detectCodeIndexingFromMcpTool(
  toolName: string,
): CodeIndexingTool | undefined {
  // MCP 工具名格式为 mcp__serverName__toolName，非此格式直接返回
  if (!toolName.startsWith('mcp__')) {
    return undefined
  }

  const parts = toolName.split('__')
  if (parts.length < 3) {
    return undefined
  }

  const serverName = parts[1]
  if (!serverName) {
    return undefined
  }

  for (const { pattern, tool } of MCP_SERVER_PATTERNS) {
    if (pattern.test(serverName)) {
      return tool
    }
  }

  return undefined
}

/**
 * 检测 MCP 服务器名称是否对应代码索引工具。
 * 直接将服务器名称与 MCP_SERVER_PATTERNS 中的正则逐一匹配。
 *
 * @param serverName - MCP 服务器名称
 * @returns 代码索引工具标识符，非代码索引服务器时返回 undefined
 */
export function detectCodeIndexingFromMcpServerName(
  serverName: string,
): CodeIndexingTool | undefined {
  for (const { pattern, tool } of MCP_SERVER_PATTERNS) {
    if (pattern.test(serverName)) {
      return tool
    }
  }

  return undefined
}
