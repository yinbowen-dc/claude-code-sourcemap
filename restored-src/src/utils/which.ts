/**
 * 跨平台命令查找工具（which）。
 *
 * 在 Claude Code 系统流程中的位置：
 * 此模块是进程执行层的底层工具，被需要定位系统可执行文件路径的
 * 各类模块调用（如 git、npm、node 等工具的路径查找）。
 *
 * 主要功能：
 * - which（异步）：Bun.which → Windows where.exe → POSIX which
 * - whichSync（同步）：与 which 相同的策略链，但为同步版本
 * - 在 Bun 运行时优先使用 Bun.which（快速，无进程衍生）
 * - 在 Node.js 运行时通过 execa/execSync 衍生平台对应命令
 */

import { execa } from 'execa'
import { execSync_DEPRECATED } from './execSyncWrapper.js'

/**
 * 在 Node.js 运行时异步查找命令路径（Bun 不使用此函数）。
 *
 * 流程：
 * 1. Windows：执行 where.exe 命令，取第一行结果（多结果按换行分隔）
 * 2. POSIX（macOS/Linux/WSL）：执行 which 命令取结果
 * 3. 命令不存在或执行失败时返回 null
 *
 * @param command 要查找的命令名称
 * @returns 命令的完整路径，未找到时返回 null
 */
async function whichNodeAsync(command: string): Promise<string | null> {
  if (process.platform === 'win32') {
    // Windows 环境：使用 where.exe 查找，返回第一个结果
    const result = await execa(`where.exe ${command}`, {
      shell: true,
      stderr: 'ignore',
      reject: false,
    })
    if (result.exitCode !== 0 || !result.stdout) {
      return null
    }
    // where.exe 返回多个路径（每行一个），取第一个
    return result.stdout.trim().split(/\r?\n/)[0] || null
  }

  // POSIX 系统（macOS、Linux、WSL）：使用 which 命令
  // Windows 已在上方处理，此处对跨平台是安全的
  // eslint-disable-next-line custom-rules/no-cross-platform-process-issues
  const result = await execa(`which ${command}`, {
    shell: true,
    stderr: 'ignore',
    reject: false,
  })
  if (result.exitCode !== 0 || !result.stdout) {
    return null
  }
  return result.stdout.trim()
}

/**
 * 在 Node.js 运行时同步查找命令路径（Bun 不使用此函数）。
 *
 * 流程：
 * 1. Windows：execSync 调用 where.exe，取第一行结果
 * 2. POSIX：execSync 调用 which，取结果
 * 3. 任何异常均被捕获，返回 null
 *
 * @param command 要查找的命令名称
 * @returns 命令的完整路径，未找到时返回 null
 */
function whichNodeSync(command: string): string | null {
  if (process.platform === 'win32') {
    try {
      const result = execSync_DEPRECATED(`where.exe ${command}`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const output = result.toString().trim()
      // where.exe 可能返回多行，只取第一行
      return output.split(/\r?\n/)[0] || null
    } catch {
      return null
    }
  }

  try {
    const result = execSync_DEPRECATED(`which ${command}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    // 去除首尾空白，空结果时返回 null
    return result.toString().trim() || null
  } catch {
    return null
  }
}

// 检测 Bun 运行时：若 Bun.which 存在则优先使用（快速，无进程衍生开销）
const bunWhich =
  typeof Bun !== 'undefined' && typeof Bun.which === 'function'
    ? Bun.which
    : null

/**
 * 异步查找命令可执行文件的完整路径。
 * 在 Bun 运行时使用 Bun.which（快速，无进程衍生）；
 * 在 Node.js 运行时衍生平台对应的查找命令。
 *
 * @param command 要查找的命令名称
 * @returns 命令的完整路径，未找到时返回 null
 */
export const which: (command: string) => Promise<string | null> = bunWhich
  ? async command => bunWhich(command) // Bun：直接调用内置 which
  : whichNodeAsync                     // Node.js：衍生进程查找

/**
 * 同步版本的 which。
 * 在 Bun 运行时使用 Bun.which；在 Node.js 运行时使用 execSync 查找。
 *
 * @param command 要查找的命令名称
 * @returns 命令的完整路径，未找到时返回 null
 */
export const whichSync: (command: string) => string | null =
  bunWhich ?? whichNodeSync // Bun.which 存在时优先使用，否则回退到同步 Node 实现
