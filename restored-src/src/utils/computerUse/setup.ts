/**
 * Computer Use MCP 动态配置模块。
 *
 * 在 Claude Code 系统中，该模块负责构建 Computer Use MCP 服务器的动态配置与工具名称白名单：
 * - setupComputerUseMCP()：使用 `@ant/computer-use-mcp` 构建工具列表，
 *   生成 MCP 服务器配置（配置键 'computer-use'，scope: 'dynamic'）
 *   及允许使用的工具名称集合，供 client.ts 挂载 Computer Use 功能
 */
import { buildComputerUseTools } from '@ant/computer-use-mcp'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { buildMcpToolName } from '../../services/mcp/mcpStringUtils.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'

import { isInBundledMode } from '../bundledMode.js'
import { CLI_CU_CAPABILITIES, COMPUTER_USE_MCP_SERVER_NAME } from './common.js'
import { getChicagoCoordinateMode } from './gates.js'

/**
 * 构建 Computer Use MCP 服务器的动态配置和允许工具名称列表。
 *
 * 与 setupClaudeInChrome 结构相同。`mcp__computer-use__*` 工具被加入 allowedTools，
 * 使其绕过普通权限提示——包的 `request_access` 工具负责整个会话的统一审批。
 *
 * 使用 MCP 工具名称（非内置工具名）是有意为之：
 * API 后端通过检测 `mcp__computer-use__*` 名称模式，
 * 在系统提示中注入 CU 可用性提示（COMPUTER_USE_MCP_AVAILABILITY_HINT）。
 * Cowork 出于同样原因使用相同命名（apps/desktop/src/main/local-agent-mode/systemPrompt.ts:314）。
 */
export function setupComputerUseMCP(): {
  mcpConfig: Record<string, ScopedMcpServerConfig>
  allowedTools: string[]
} {
  // 构建工具列表并转换为 MCP 工具全名（含服务器名前缀）
  const allowedTools = buildComputerUseTools(
    CLI_CU_CAPABILITIES,
    getChicagoCoordinateMode(),
  ).map(t => buildMcpToolName(COMPUTER_USE_MCP_SERVER_NAME, t.name))

  // command/args 实际上不会被 spawn：client.ts 按名称拦截并使用进程内服务器。
  // 配置只需存在且 type 为 'stdio' 以命中正确分支。镜像 Chrome 的 setup。
  const args = isInBundledMode()
    ? ['--computer-use-mcp']
    : [
        join(fileURLToPath(import.meta.url), '..', 'cli.js'),
        '--computer-use-mcp',
      ]

  return {
    mcpConfig: {
      // 键名即为 MCP 服务器名称，供 client.ts 路由
      [COMPUTER_USE_MCP_SERVER_NAME]: {
        type: 'stdio',
        command: process.execPath,
        args,
        scope: 'dynamic',
      } as const,
    },
    allowedTools,
  }
}
