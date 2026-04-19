/**
 * it2 CLI 工具安装与验证模块
 *
 * 在 Claude Code 系统流程中的位置：
 * 该模块是 ITermBackend（iTerm2 后端）的依赖准备层。
 * 当 registry.ts 检测到当前环境为 iTerm2 但 it2 CLI 尚未安装时，
 * It2SetupPrompt.tsx 组件会引导用户交互式安装，并调用本模块完成安装与验证。
 *
 * 主要功能：
 * 1. detectPythonPackageManager：检测系统中可用的 Python 包管理器（uvx > pipx > pip）
 * 2. installIt2：使用检测到的包管理器安装 it2 CLI
 * 3. verifyIt2Setup：验证 it2 是否能正常连接 iTerm2 Python API
 * 4. getPythonApiInstructions：返回启用 iTerm2 Python API 的操作说明
 * 5. markIt2SetupComplete：在全局配置中标记安装已完成
 * 6. setPreferTmuxOverIterm2 / getPreferTmuxOverIterm2：管理用户的终端后端偏好
 *
 * 安全考量：
 * - installIt2 在用户 home 目录执行安装，避免读取项目级 pip.conf/uv.toml，
 *   防止恶意配置将 PyPI 重定向到攻击者服务器。
 */

import { homedir } from 'os'
import { getGlobalConfig, saveGlobalConfig } from '../../../utils/config.js'
import { logForDebugging } from '../../../utils/debug.js'
import {
  execFileNoThrow,
  execFileNoThrowWithCwd,
} from '../../../utils/execFileNoThrow.js'
import { logError } from '../../../utils/log.js'

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/**
 * 支持的 Python 包管理器类型，按偏好顺序排列。
 * - uvx：基于 uv，使用隔离环境，速度快（最优先）
 * - pipx：隔离环境安装，避免污染系统 Python
 * - pip：通用回退，使用 --user 安装
 */
export type PythonPackageManager = 'uvx' | 'pipx' | 'pip'

/**
 * it2 安装结果类型。
 * success=false 时 error 字段说明失败原因，packageManager 指示使用的包管理器。
 */
export type It2InstallResult = {
  success: boolean
  error?: string
  packageManager?: PythonPackageManager
}

/**
 * it2 验证结果类型。
 * needsPythonApiEnabled=true 时说明 it2 已安装但 iTerm2 Python API 未启用。
 */
export type It2VerifyResult = {
  success: boolean
  error?: string
  needsPythonApiEnabled?: boolean
}

// ─── 核心函数 ─────────────────────────────────────────────────────────────────

/**
 * 检测系统中可用的 Python 包管理器。
 *
 * 检测顺序（优先级从高到低）：
 * 1. uv — 现代 Python 包管理器，使用 `uv tool install` 安装到隔离环境
 * 2. pipx — 专为 CLI 工具设计的隔离安装工具
 * 3. pip — 通用包管理器（包括 pip3）
 *
 * 通过 `which` 命令检测各工具是否在 PATH 中。
 * 注意：返回类型名为 'uvx' 是为了兼容性，实际命令是 `uv tool install`。
 *
 * @returns 可用的包管理器类型，若均不存在则返回 null
 */
export async function detectPythonPackageManager(): Promise<PythonPackageManager | null> {
  // 首选 uv（`uv tool install` 安装到隔离环境，速度最快）
  const uvResult = await execFileNoThrow('which', ['uv'])
  if (uvResult.code === 0) {
    logForDebugging('[it2Setup] Found uv (will use uv tool install)')
    return 'uvx' // 保留 'uvx' 类型名称以保持兼容性
  }

  // 次选 pipx（专为 CLI 工具设计的隔离安装）
  const pipxResult = await execFileNoThrow('which', ['pipx'])
  if (pipxResult.code === 0) {
    logForDebugging('[it2Setup] Found pipx package manager')
    return 'pipx'
  }

  // 回退到 pip
  const pipResult = await execFileNoThrow('which', ['pip'])
  if (pipResult.code === 0) {
    logForDebugging('[it2Setup] Found pip package manager')
    return 'pip'
  }

  // 也检查 pip3（某些系统只有 pip3 而没有 pip）
  const pip3Result = await execFileNoThrow('which', ['pip3'])
  if (pip3Result.code === 0) {
    logForDebugging('[it2Setup] Found pip3 package manager')
    return 'pip' // 统一用 'pip' 类型，安装时会尝试 pip3
  }

  logForDebugging('[it2Setup] No Python package manager found')
  return null
}

/**
 * 检测 it2 CLI 是否已安装并在 PATH 中可访问。
 *
 * @returns true 表示 it2 已在 PATH 中
 */
export async function isIt2CliAvailable(): Promise<boolean> {
  const result = await execFileNoThrow('which', ['it2'])
  return result.code === 0
}

/**
 * 使用指定的包管理器安装 it2 CLI。
 *
 * 安全设计：在用户 home 目录执行安装命令（通过 execFileNoThrowWithCwd 设置 cwd），
 * 避免读取项目目录中可能被恶意篡改的 pip.conf 或 uv.toml，
 * 防止依赖混淆攻击将安装来源重定向到攻击者控制的 PyPI 服务器。
 *
 * 各包管理器的安装命令：
 * - uvx：`uv tool install it2`（安装到 uv 管理的全局隔离环境）
 * - pipx：`pipx install it2`（安装到 pipx 管理的隔离环境）
 * - pip：`pip install --user it2`（用户级安装，若失败则尝试 pip3）
 *
 * @param packageManager 要使用的包管理器
 * @returns 安装结果，包含 success 标志和可能的错误信息
 */
export async function installIt2(
  packageManager: PythonPackageManager,
): Promise<It2InstallResult> {
  logForDebugging(`[it2Setup] Installing it2 using ${packageManager}`)

  // 在 home 目录执行安装，避免读取项目级配置文件（安全防护）
  let result
  switch (packageManager) {
    case 'uvx':
      // uv tool install 将 it2 安装到全局隔离环境
      // （uvx 是运行工具的命令，uv tool install 是安装命令）
      result = await execFileNoThrowWithCwd('uv', ['tool', 'install', 'it2'], {
        cwd: homedir(),
      })
      break
    case 'pipx':
      // pipx install 将 it2 安装到独立隔离环境
      result = await execFileNoThrowWithCwd('pipx', ['install', 'it2'], {
        cwd: homedir(),
      })
      break
    case 'pip':
      // --user 标志避免需要 sudo 权限
      result = await execFileNoThrowWithCwd(
        'pip',
        ['install', '--user', 'it2'],
        { cwd: homedir() },
      )
      if (result.code !== 0) {
        // pip 失败时尝试 pip3（某些系统 pip 指向 Python 2）
        result = await execFileNoThrowWithCwd(
          'pip3',
          ['install', '--user', 'it2'],
          { cwd: homedir() },
        )
      }
      break
  }

  // 安装失败：记录错误日志并返回失败结果
  if (result.code !== 0) {
    const error = result.stderr || 'Unknown installation error'
    logError(new Error(`[it2Setup] Failed to install it2: ${error}`))
    return {
      success: false,
      error,
      packageManager,
    }
  }

  logForDebugging('[it2Setup] it2 installed successfully')
  return {
    success: true,
    packageManager,
  }
}

/**
 * 验证 it2 CLI 是否正确配置且能与 iTerm2 通信。
 *
 * 验证流程：
 * 1. 先检查 it2 是否在 PATH 中（isIt2CliAvailable）。
 * 2. 运行 `it2 session list` 测试 Python API 连接性。
 *    - 命令成功：验证通过。
 *    - 命令失败：分析 stderr 内容，若含 API/Python/connection refused/not enabled
 *      等关键词，判定为 Python API 未启用，设置 needsPythonApiEnabled=true。
 *
 * 注意：使用 'session list' 而非 '--version'，
 * 因为 '--version' 即使 Python API 未启用也会成功，无法真实反映可用性。
 *
 * @returns 验证结果，包含 success 标志、错误信息和 Python API 是否需要启用
 */
export async function verifyIt2Setup(): Promise<It2VerifyResult> {
  logForDebugging('[it2Setup] Verifying it2 setup...')

  // 第一步：检查 it2 是否安装
  const installed = await isIt2CliAvailable()
  if (!installed) {
    return {
      success: false,
      error: 'it2 CLI is not installed or not in PATH',
    }
  }

  // 第二步：通过 session list 测试 Python API 连接性
  const result = await execFileNoThrow('it2', ['session', 'list'])

  if (result.code !== 0) {
    const stderr = result.stderr.toLowerCase()

    // 分析失败原因：是否为 Python API 未启用
    if (
      stderr.includes('api') ||
      stderr.includes('python') ||
      stderr.includes('connection refused') ||
      stderr.includes('not enabled')
    ) {
      logForDebugging('[it2Setup] Python API not enabled in iTerm2')
      return {
        success: false,
        error: 'Python API not enabled in iTerm2 preferences',
        // 标记需要用户手动在 iTerm2 设置中启用 Python API
        needsPythonApiEnabled: true,
      }
    }

    // 其他未知错误
    return {
      success: false,
      error: result.stderr || 'Failed to communicate with iTerm2',
    }
  }

  logForDebugging('[it2Setup] it2 setup verified successfully')
  return {
    success: true,
  }
}

/**
 * 返回在 iTerm2 中启用 Python API 的操作说明文本。
 * It2SetupPrompt.tsx 在需要用户启用 Python API 时调用此函数显示说明。
 *
 * @returns 说明文本行数组
 */
export function getPythonApiInstructions(): string[] {
  return [
    'Almost done! Enable the Python API in iTerm2:',
    '',
    '  iTerm2 → Settings → General → Magic → Enable Python API',
    '',
    'After enabling, you may need to restart iTerm2.',
  ]
}

/**
 * 在全局配置中标记 it2 设置已完成。
 * 避免下次启动时再次显示安装提示。
 * 只有当配置项尚未设置时才写入，减少不必要的文件 I/O。
 */
export function markIt2SetupComplete(): void {
  const config = getGlobalConfig()
  // 幂等写入：已经为 true 时跳过
  if (config.iterm2It2SetupComplete !== true) {
    saveGlobalConfig(current => ({
      ...current,
      iterm2It2SetupComplete: true,
    }))
    logForDebugging('[it2Setup] Marked it2 setup as complete')
  }
}

/**
 * 设置用户是否偏好使用 tmux 而非 iTerm2 分割窗格。
 * 当用户在 iTerm2 环境中选择使用 tmux 时，保存此偏好以避免再次出现 iTerm2 设置提示。
 *
 * @param prefer true 表示偏好 tmux，false 表示偏好 iTerm2
 */
export function setPreferTmuxOverIterm2(prefer: boolean): void {
  const config = getGlobalConfig()
  // 仅在值发生变化时写入，减少文件 I/O
  if (config.preferTmuxOverIterm2 !== prefer) {
    saveGlobalConfig(current => ({
      ...current,
      preferTmuxOverIterm2: prefer,
    }))
    logForDebugging(`[it2Setup] Set preferTmuxOverIterm2 = ${prefer}`)
  }
}

/**
 * 读取用户是否偏好 tmux 而非 iTerm2 分割窗格的配置。
 * registry.ts 在选择后端时会查询此偏好。
 *
 * @returns true 表示用户偏好 tmux
 */
export function getPreferTmuxOverIterm2(): boolean {
  return getGlobalConfig().preferTmuxOverIterm2 === true
}
