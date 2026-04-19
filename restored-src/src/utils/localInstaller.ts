/**
 * localInstaller.ts — Claude CLI 本地安装管理模块
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于工具层（utils），管理 Claude CLI 在用户本地目录（~/.claude/local/）
 * 的安装和更新流程。这是 Claude Code 自更新机制的核心组件：
 * 当用户使用自管理安装方式时，Claude Code 通过 npm 在本地目录安装自身，
 * 避免依赖全局 npm 权限，同时支持稳定版和最新版的选择性安装。
 *
 * 【目录结构】
 *   ~/.claude/local/
 *   ├── package.json            — npm 包描述文件（名称: claude-local）
 *   ├── claude                  — 可执行包装脚本（调用 node_modules/.bin/claude）
 *   └── node_modules/
 *       └── .bin/
 *           └── claude          — 实际的 Claude CLI 可执行文件
 *
 * 【主要功能】
 * 1. getLocalInstallDir/getLocalClaudePath — 获取本地安装目录和可执行路径（懒加载）；
 * 2. isRunningFromLocalInstallation        — 检测当前是否运行于本地安装版本；
 * 3. ensureLocalPackageEnvironment         — 初始化本地包环境（目录、package.json、包装脚本）；
 * 4. installOrUpdateClaudePackage          — 执行 npm install 安装/更新 Claude 包；
 * 5. localInstallationExists               — 检测本地安装是否存在；
 * 6. getShellType                          — 检测当前 shell 类型（用于 PATH 配置提示）。
 */

import { access, chmod, writeFile } from 'fs/promises'
import { join } from 'path'
import { type ReleaseChannel, saveGlobalConfig } from './config.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { getErrnoCode } from './errors.js'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import { logError } from './log.js'
import { jsonStringify } from './slowOperations.js'

// 使用懒加载 getter 而非模块级常量的原因：
// getClaudeConfigHomeDir() 已记忆化并读取 process.env。
// 若在模块加载时求值，会在 hfi.tsx 等入口点的 main() 设置 CLAUDE_CONFIG_DIR
// 之前捕获到过时的值，并将这个过时值写入所有 150+ 个调用方共享的记忆化缓存。

/**
 * 获取 Claude 本地安装目录路径（懒加载，跟随 CLAUDE_CONFIG_DIR 动态变化）。
 * 路径：<CLAUDE_CONFIG_HOME>/local
 */
function getLocalInstallDir(): string {
  return join(getClaudeConfigHomeDir(), 'local')
}

/**
 * 获取本地安装的 Claude 包装脚本路径。
 * 路径：<CLAUDE_CONFIG_HOME>/local/claude
 */
export function getLocalClaudePath(): string {
  return join(getLocalInstallDir(), 'claude')
}

/**
 * 检测 Claude Code 当前是否运行于本地安装版本。
 * 通过检查 process.argv[1] 是否包含 '/.claude/local/node_modules/' 路径段来判断。
 * 用于决定是否应通过本地安装路径进行自更新。
 */
export function isRunningFromLocalInstallation(): boolean {
  const execPath = process.argv[1] || ''
  return execPath.includes('/.claude/local/node_modules/')
}

/**
 * 仅在文件不存在时写入内容（原子性创建，不覆盖已有文件）。
 * 使用 O_EXCL 标志（'wx'）实现原子性的"若不存在则创建"语义，
 * 防止多进程并发安装时覆盖对方写入的文件。
 *
 * @param path    - 目标文件路径
 * @param content - 要写入的内容
 * @param mode    - 文件权限位（可选）
 * @returns true 表示文件被成功创建，false 表示文件已存在（未写入）
 */
async function writeIfMissing(
  path: string,
  content: string,
  mode?: number,
): Promise<boolean> {
  try {
    // 'wx' 标志：若文件已存在则失败（O_EXCL 语义）
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx', mode })
    return true
  } catch (e) {
    if (getErrnoCode(e) === 'EEXIST') return false  // 文件已存在，跳过
    throw e  // 其他错误（如权限不足），向上抛出
  }
}

/**
 * 确保本地包环境已正确初始化。
 * 幂等操作：安全地多次调用，已存在的文件不会被覆盖。
 *
 * 初始化步骤：
 *   1. 创建本地安装目录（递归，已存在时忽略）；
 *   2. 若 package.json 不存在，创建基础包描述文件；
 *   3. 若包装脚本（claude）不存在，创建可执行脚本并确保可执行位正确。
 *
 * @returns true 表示环境就绪，false 表示初始化失败（错误已记录）
 */
export async function ensureLocalPackageEnvironment(): Promise<boolean> {
  try {
    const localInstallDir = getLocalInstallDir()

    // 创建安装目录（recursive: true 确保幂等性）
    await getFsImplementation().mkdir(localInstallDir)

    // 若 package.json 不存在，创建最小化包描述文件
    await writeIfMissing(
      join(localInstallDir, 'package.json'),
      jsonStringify(
        { name: 'claude-local', version: '0.0.1', private: true },
        null,
        2,
      ),
    )

    // 若包装脚本不存在，创建 sh 脚本委托给 node_modules/.bin/claude
    const wrapperPath = join(localInstallDir, 'claude')
    const created = await writeIfMissing(
      wrapperPath,
      `#!/bin/sh\nexec "${localInstallDir}/node_modules/.bin/claude" "$@"`,
      0o755,  // rwxr-xr-x
    )
    if (created) {
      // writeFile 的 mode 受 umask 掩码影响，显式 chmod 确保可执行位正确设置
      await chmod(wrapperPath, 0o755)
    }

    return true
  } catch (error) {
    logError(error)
    return false  // 初始化失败
  }
}

/**
 * 在本地目录安装或更新 Claude CLI 包。
 *
 * 流程：
 *   1. 确保本地包环境就绪（调用 ensureLocalPackageEnvironment）；
 *   2. 根据 channel 和 specificVersion 确定版本规范；
 *   3. 执行 npm install <package>@<version>；
 *   4. 成功后将 installMethod 更新为 'local'，抑制 npm 权限警告。
 *
 * @param channel         - 发布渠道（'latest' 或 'stable'）
 * @param specificVersion - 可选的指定版本号（覆盖 channel）
 * @returns 'success' | 'install_failed' | 'in_progress'（退出码 190 表示安装进行中）
 */
export async function installOrUpdateClaudePackage(
  channel: ReleaseChannel,
  specificVersion?: string | null,
): Promise<'in_progress' | 'success' | 'install_failed'> {
  try {
    // 前置条件：确保目录结构和配置文件就绪
    if (!(await ensureLocalPackageEnvironment())) {
      return 'install_failed'
    }

    // 版本规范：specificVersion 优先，否则使用渠道标签（'stable' 或 'latest'）
    const versionSpec = specificVersion
      ? specificVersion
      : channel === 'stable'
        ? 'stable'
        : 'latest'

    const result = await execFileNoThrowWithCwd(
      'npm',
      ['install', `${MACRO.PACKAGE_URL}@${versionSpec}`],
      { cwd: getLocalInstallDir(), maxBuffer: 1000000 },
    )

    if (result.code !== 0) {
      const error = new Error(
        `Failed to install Claude CLI package: ${result.stderr}`,
      )
      logError(error)
      // 退出码 190：安装进行中（另一个实例正在运行）
      return result.code === 190 ? 'in_progress' : 'install_failed'
    }

    // 安装成功：将 installMethod 更新为 'local'，防止 npm 权限警告
    saveGlobalConfig(current => ({
      ...current,
      installMethod: 'local',
    }))

    return 'success'
  } catch (error) {
    logError(error)
    return 'install_failed'
  }
}

/**
 * 检测本地 Claude CLI 安装是否存在。
 * 仅做存在性探测（access 调用），不验证版本或可执行性。
 * 调用方根据此结果决定更新路径或显示安装提示。
 *
 * @returns true 表示本地安装的 Claude 可执行文件存在
 */
export async function localInstallationExists(): Promise<boolean> {
  try {
    // 检查 node_modules/.bin/claude 是否可访问（存在且可读）
    await access(join(getLocalInstallDir(), 'node_modules', '.bin', 'claude'))
    return true
  } catch {
    return false
  }
}

/**
 * 检测当前 shell 类型，用于生成正确的 PATH 配置指令。
 * 通过读取 SHELL 环境变量的路径来判断 shell 类型。
 *
 * @returns 'zsh' | 'bash' | 'fish' | 'unknown'
 */
export function getShellType(): string {
  const shellPath = process.env.SHELL || ''
  if (shellPath.includes('zsh')) return 'zsh'
  if (shellPath.includes('bash')) return 'bash'
  if (shellPath.includes('fish')) return 'fish'
  return 'unknown'
}
