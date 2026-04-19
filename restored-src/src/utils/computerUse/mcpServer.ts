/**
 * Computer Use MCP 服务器模块。
 *
 * 在 Claude Code 系统中，该模块创建并启动 Computer Use MCP 服务器进程：
 * - createComputerUseMcpServerForCli()：创建 MCP 服务器实例，重写 ListTools 处理器，
 *   在 `request_access` 工具描述中注入已安装应用名称列表（超时 APP_ENUM_TIMEOUT_MS = 1000ms）
 * - runComputerUseMcpServer()：通过 StdioServerTransport 启动 MCP 服务器
 */
import {
  buildComputerUseTools,
  createComputerUseMcpServer,
} from '@ant/computer-use-mcp'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { homedir } from 'os'

import { shutdownDatadog } from '../../services/analytics/datadog.js'
import { shutdown1PEventLogging } from '../../services/analytics/firstPartyEventLogger.js'
import { initializeAnalyticsSink } from '../../services/analytics/sink.js'
import { enableConfigs } from '../config.js'
import { logForDebugging } from '../debug.js'
import { filterAppsForDescription } from './appNames.js'
import { getChicagoCoordinateMode } from './gates.js'
import { getComputerUseHostAdapter } from './hostAdapter.js'

// 枚举已安装应用的超时时间（Spotlight 可能较慢）
const APP_ENUM_TIMEOUT_MS = 1000

/**
 * 枚举已安装应用列表（带超时限制），失败时软降级。
 *
 * 若 Spotlight 响应慢或 claude-swift 抛出异常，工具描述中仅省略应用列表，
 * 不影响工具本身的调用（模型在调用时仍可分辨应用）。
 * 超时后后台枚举继续运行，其最终的 rejection 被静默吞掉。
 */
async function tryGetInstalledAppNames(): Promise<string[] | undefined> {
  const adapter = getComputerUseHostAdapter()
  const enumP = adapter.executor.listInstalledApps()
  let timer: ReturnType<typeof setTimeout> | undefined
  // 构造超时 Promise，1000ms 后解析为 undefined
  const timeoutP = new Promise<undefined>(resolve => {
    timer = setTimeout(resolve, APP_ENUM_TIMEOUT_MS, undefined)
  })
  // 枚举与超时竞速，任意一方先完成即采用其结果
  const installed = await Promise.race([enumP, timeoutP])
    .catch(() => undefined)
    .finally(() => clearTimeout(timer))
  if (!installed) {
    // 超时后枚举可能仍在后台运行，静默吞掉其最终 rejection
    void enumP.catch(() => {})
    logForDebugging(
      `[Computer Use MCP] app enumeration exceeded ${APP_ENUM_TIMEOUT_MS}ms or failed; tool description omits list`,
    )
    return undefined
  }
  // 过滤应用列表，仅保留适合放入工具描述的条目
  return filterAppsForDescription(installed, homedir())
}

/**
 * 创建 CLI 版 Computer Use MCP 服务器实例（进程内）。
 *
 * 委托给包的 createComputerUseMcpServer 创建基础 Server 对象和 CallTool 桩处理器，
 * 然后替换 ListTools 处理器，在 `request_access` 工具描述中注入已安装应用名称。
 * （包的工厂函数不接受 installedAppNames，Cowork 同样在 serverDef.ts 自建工具数组。）
 *
 * 异步设计：1s 应用枚举超时不阻塞 MCP 连接启动。
 * 由 client.ts 在首次 CU 连接时通过 `await import()` 调用，而非在 main.tsx 启动时执行。
 * 实际工具调用仍通过 wrapper.tsx 的 .call() 覆盖分发；此服务器仅负责响应 ListTools。
 */
export async function createComputerUseMcpServerForCli(): Promise<
  ReturnType<typeof createComputerUseMcpServer>
> {
  const adapter = getComputerUseHostAdapter()
  const coordinateMode = getChicagoCoordinateMode()
  // 创建基础服务器（含 CallTool 桩处理器）
  const server = createComputerUseMcpServer(adapter, coordinateMode)

  // 枚举已安装应用（超时 1s 软降级）
  const installedAppNames = await tryGetInstalledAppNames()
  // 构建含应用列表的工具描述
  const tools = buildComputerUseTools(
    adapter.executor.capabilities,
    coordinateMode,
    installedAppNames,
  )
  // 替换 ListTools 处理器：功能关闭时返回空列表，否则返回含应用提示的工具描述
  server.setRequestHandler(ListToolsRequestSchema, async () =>
    adapter.isDisabled() ? { tools: [] } : { tools },
  )

  return server
}

/**
 * `--computer-use-mcp` 子进程入口点，启动 Computer Use MCP 服务器。
 *
 * 使用 StdioServerTransport 与父进程通信；stdin 关闭时退出进程，
 * 退出前刷新分析数据（1P 事件日志 + Datadog）。
 * 镜像 runClaudeInChromeMcpServer 的结构。
 */
export async function runComputerUseMcpServer(): Promise<void> {
  // 初始化配置和分析数据收集
  enableConfigs()
  initializeAnalyticsSink()

  const server = await createComputerUseMcpServerForCli()
  // Stdio 传输：通过标准输入/输出与父进程（client.ts）通信
  const transport = new StdioServerTransport()

  let exiting = false
  const shutdownAndExit = async (): Promise<void> => {
    // 防止重复触发（stdin end 和 error 可能同时触发）
    if (exiting) return
    exiting = true
    // 退出前确保分析数据已刷新
    await Promise.all([shutdown1PEventLogging(), shutdownDatadog()])
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  }
  // stdin 关闭（父进程退出）或出错时优雅关闭
  process.stdin.on('end', () => void shutdownAndExit())
  process.stdin.on('error', () => void shutdownAndExit())

  logForDebugging('[Computer Use MCP] Starting MCP server')
  await server.connect(transport)
  logForDebugging('[Computer Use MCP] MCP server started')
}
