/**
 * Claude Desktop 配置集成模块。
 *
 * 在 Claude Code 系统中，该模块提供读取 Claude Desktop 配置文件并导入其 MCP 服务端配置的能力：
 * - getClaudeDesktopConfigPath()：返回当前平台（macOS / WSL）下 Claude Desktop 配置文件路径，
 *   WSL 环境下先尝试 USERPROFILE 环境变量，再遍历 /mnt/c/Users/ 查找
 * - readClaudeDesktopMcpServers()：读取配置文件并解析 mcpServers 字段，
 *   使用 McpStdioServerConfigSchema 校验每项配置，返回合法的服务端配置映射
 *
 * 仅支持 macOS 和 WSL（SUPPORTED_PLATFORMS），其他平台抛出错误。
 */
import { readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import {
  type McpServerConfig,
  McpStdioServerConfigSchema,
} from '../services/mcp/types.js'
import { getErrnoCode } from './errors.js'
import { safeParseJSON } from './json.js'
import { logError } from './log.js'
import { getPlatform, SUPPORTED_PLATFORMS } from './platform.js'

/**
 * 返回当前平台（macOS 或 WSL）下 Claude Desktop 配置文件的绝对路径。
 *
 * 路径解析策略：
 * 1. macOS：直接返回 ~/Library/Application Support/Claude/claude_desktop_config.json
 * 2. WSL：
 *    a. 优先读取 USERPROFILE 环境变量，将 Windows 路径转换为 WSL 挂载路径并验证文件存在
 *    b. 若 USERPROFILE 不可用或文件不存在，遍历 /mnt/c/Users/ 下各用户目录（跳过系统目录）寻找配置
 * 3. 不支持的平台（非 macOS / WSL）直接抛出错误
 *
 * @throws 若在 WSL 下无法找到配置文件，或平台不受支持，则抛出 Error
 */
export async function getClaudeDesktopConfigPath(): Promise<string> {
  // 获取当前运行平台标识
  const platform = getPlatform()

  // 不在支持平台列表（macOS / WSL）内则抛错
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    throw new Error(
      `Unsupported platform: ${platform} - Claude Desktop integration only works on macOS and WSL.`,
    )
  }

  if (platform === 'macos') {
    // macOS 路径固定：~/Library/Application Support/Claude/claude_desktop_config.json
    return join(
      homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    )
  }

  // First, try using USERPROFILE environment variable if available
  // 优先使用 USERPROFILE 环境变量（WSL 中由 Windows 侧注入）构建路径
  const windowsHome = process.env.USERPROFILE
    ? process.env.USERPROFILE.replace(/\\/g, '/') // Convert Windows backslashes to forward slashes
    : null

  if (windowsHome) {
    // Remove drive letter and convert to WSL path format
    // 去掉驱动器字母（如 C:），组装 /mnt/c 前缀的 WSL 路径
    const wslPath = windowsHome.replace(/^[A-Z]:/, '')
    const configPath = `/mnt/c${wslPath}/AppData/Roaming/Claude/claude_desktop_config.json`

    // Check if the file exists
    // 验证该路径下文件是否真实存在，避免返回无效路径
    try {
      await stat(configPath)
      return configPath
    } catch {
      // File doesn't exist, continue
      // 文件不存在，继续尝试遍历用户目录
    }
  }

  // Alternative approach - try to construct path based on typical Windows user location
  // 备用方案：遍历 /mnt/c/Users/ 目录，逐一查找 Claude Desktop 配置
  try {
    // List the /mnt/c/Users directory to find potential user directories
    // 扫描 Windows 用户目录挂载点
    const usersDir = '/mnt/c/Users'

    try {
      const userDirs = await readdir(usersDir, { withFileTypes: true })

      // Look for Claude Desktop config in each user directory
      // 逐一检查每个用户子目录
      for (const user of userDirs) {
        if (
          user.name === 'Public' ||
          user.name === 'Default' ||
          user.name === 'Default User' ||
          user.name === 'All Users'
        ) {
          continue // Skip system directories
          // 跳过 Windows 系统预置的非个人用户目录
        }

        const potentialConfigPath = join(
          usersDir,
          user.name,
          'AppData',
          'Roaming',
          'Claude',
          'claude_desktop_config.json',
        )

        try {
          // 检查该用户目录下是否存在配置文件
          await stat(potentialConfigPath)
          return potentialConfigPath
        } catch {
          // File doesn't exist, continue
          // 该用户目录下没有配置，继续下一个
        }
      }
    } catch {
      // usersDir doesn't exist or can't be read
      // /mnt/c/Users 不存在或无权访问，跳过
    }
  } catch (dirError) {
    // 记录意外错误，但不中断整体流程
    logError(dirError)
  }

  // 所有路径均未找到配置文件，抛出明确错误提示用户安装 Claude Desktop
  throw new Error(
    'Could not find Claude Desktop config file in Windows. Make sure Claude Desktop is installed on Windows.',
  )
}

/**
 * 读取 Claude Desktop 配置文件并解析其中的 MCP 服务端配置。
 *
 * 流程：
 * 1. 检查平台支持性（macOS / WSL），否则抛错
 * 2. 调用 getClaudeDesktopConfigPath() 获取配置文件路径
 * 3. 以 UTF-8 读取文件；ENOENT（文件不存在）时静默返回空对象
 * 4. 用 safeParseJSON 解析内容，提取 mcpServers 字段
 * 5. 遍历每个服务端配置项，用 McpStdioServerConfigSchema 校验 schema 合法性
 * 6. 仅将校验通过的配置写入结果映射，跳过不合法的项
 *
 * @returns 合法 MCP 服务端配置的 name → config 映射；任何错误均静默返回 {}
 */
export async function readClaudeDesktopMcpServers(): Promise<
  Record<string, McpServerConfig>
> {
  // 不支持的平台直接抛错，避免后续无意义操作
  if (!SUPPORTED_PLATFORMS.includes(getPlatform())) {
    throw new Error(
      'Unsupported platform - Claude Desktop integration only works on macOS and WSL.',
    )
  }
  try {
    // 获取平台对应的配置文件路径
    const configPath = await getClaudeDesktopConfigPath()

    let configContent: string
    try {
      // 以 UTF-8 编码读取配置文件
      configContent = await readFile(configPath, { encoding: 'utf8' })
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        // 文件不存在属于正常情况（用户未安装 Claude Desktop），返回空对象
        return {}
      }
      throw e
    }

    // 安全解析 JSON，避免格式错误时抛出异常
    const config = safeParseJSON(configContent)

    // 配置文件内容为空或非对象时返回空配置
    if (!config || typeof config !== 'object') {
      return {}
    }

    // 提取 mcpServers 字段，不存在或类型不符则返回空配置
    const mcpServers = (config as Record<string, unknown>).mcpServers
    if (!mcpServers || typeof mcpServers !== 'object') {
      return {}
    }

    const servers: Record<string, McpServerConfig> = {}

    // 遍历所有服务端配置项，逐一用 Zod Schema 校验
    for (const [name, serverConfig] of Object.entries(
      mcpServers as Record<string, unknown>,
    )) {
      // 跳过非对象类型的配置项
      if (!serverConfig || typeof serverConfig !== 'object') {
        continue
      }

      // 用 McpStdioServerConfigSchema 进行 schema 校验（safeParse 不抛错）
      const result = McpStdioServerConfigSchema().safeParse(serverConfig)

      if (result.success) {
        // 校验通过则写入结果
        servers[name] = result.data
      }
      // 校验失败的项静默丢弃，不中断整体解析
    }

    return servers
  } catch (error) {
    // 将未预期错误记录日志，但不向上抛，保持调用方稳定性
    logError(error)
    return {}
  }
}
