/**
 * Shell 配置文件管理模块。
 *
 * 在 Claude Code 系统中，该模块负责管理用户 Shell 配置文件
 * （如 .bashrc、.zshrc、fish config.fish）中的 claude alias 条目，
 * 用于安装/卸载时的 alias 写入、删除和验证。
 *
 * 主要导出：
 * - `CLAUDE_ALIAS_REGEX`：匹配 claude alias 行的正则表达式
 * - `getShellConfigPaths()`：获取 zsh/bash/fish 配置文件路径，支持 ZDOTDIR
 * - `filterClaudeAliases()`：过滤安装器创建的 claude alias，保留用户自定义 alias
 * - `readFileLines()`：读取文件行数组，不可访问时返回 null
 * - `writeFileLines()`：将行数组写回文件（带 datasync）
 * - `findClaudeAlias()`：在所有配置文件中查找 claude alias 目标
 * - `findValidClaudeAlias()`：查找指向有效可执行文件的 claude alias
 */

import { open, readFile, stat } from 'fs/promises'
import { homedir as osHomedir } from 'os'
import { join } from 'path'
import { isFsInaccessible } from './errors.js'
import { getLocalClaudePath } from './localInstaller.js'

/** 匹配 claude alias 行的正则表达式（如 `alias claude=...`） */
export const CLAUDE_ALIAS_REGEX = /^\s*alias\s+claude\s*=/

/** 类似 process.env 的环境变量对象类型（允许 undefined 值） */
type EnvLike = Record<string, string | undefined>

/** Shell 配置选项：支持在测试中覆盖 env 和 homedir */
type ShellConfigOptions = {
  env?: EnvLike
  homedir?: string
}

/**
 * 获取各 Shell 配置文件的路径。
 *
 * - zsh：遵循 ZDOTDIR 环境变量（若未设置则使用 HOME）
 * - bash：固定使用 HOME/.bashrc
 * - fish：固定使用 HOME/.config/fish/config.fish
 *
 * @param options 可选测试覆盖项（env、homedir）
 * @returns 以 shell 名为键、配置文件路径为值的映射
 */
export function getShellConfigPaths(
  options?: ShellConfigOptions,
): Record<string, string> {
  const home = options?.homedir ?? osHomedir()
  const env = options?.env ?? process.env
  // zsh 支持 ZDOTDIR 自定义配置目录，未设置时回退到 HOME
  const zshConfigDir = env.ZDOTDIR || home
  return {
    zsh: join(zshConfigDir, '.zshrc'),
    bash: join(home, '.bashrc'),
    fish: join(home, '.config/fish/config.fish'),
  }
}

/**
 * 从行数组中过滤出安装器创建的 claude alias。
 *
 * 仅移除指向 `$HOME/.claude/local/claude`（安装器默认路径）的 alias，
 * 保留用户自定义的、指向其他位置的 alias。
 *
 * @param lines 文件内容行数组
 * @returns 过滤后的行数组及是否找到了默认安装器 alias 的标志
 */
export function filterClaudeAliases(lines: string[]): {
  filtered: string[]
  hadAlias: boolean
} {
  let hadAlias = false
  const filtered = lines.filter(line => {
    // 检查当前行是否为 claude alias
    if (CLAUDE_ALIAS_REGEX.test(line)) {
      // 提取 alias 目标：先尝试带引号格式，再尝试不带引号格式
      let match = line.match(/alias\s+claude\s*=\s*["']([^"']+)["']/)
      if (!match) {
        // 不带引号：捕获到行尾或注释符号前
        match = line.match(/alias\s+claude\s*=\s*([^#\n]+)/)
      }

      if (match && match[1]) {
        const target = match[1].trim()
        // 仅移除指向安装器默认路径的 alias（完整展开路径）
        if (target === getLocalClaudePath()) {
          hadAlias = true
          return false // 移除此行
        }
      }
      // 非安装器路径的自定义 alias，保留
    }
    return true
  })
  return { filtered, hadAlias }
}

/**
 * 读取文件并按行分割，返回行数组。
 * 若文件不存在或无访问权限（ENOENT/EACCES），返回 null。
 *
 * @param filePath 文件路径
 * @returns 行数组，或 null（文件不可访问时）
 */
export async function readFileLines(
  filePath: string,
): Promise<string[] | null> {
  try {
    const content = await readFile(filePath, { encoding: 'utf8' })
    // 按换行符拆分（最后一行可能为空字符串，保留以便原样写回）
    return content.split('\n')
  } catch (e: unknown) {
    // 文件不存在或权限不足时返回 null，其他错误继续抛出
    if (isFsInaccessible(e)) return null
    throw e
  }
}

/**
 * 将行数组写回文件（UTF-8 编码，带 datasync 确保持久化）。
 *
 * 使用 datasync() 而非 sync()，仅刷新数据内容，
 * 在大多数 FS 上比 sync() 更快，且足以防止数据丢失。
 *
 * @param filePath 目标文件路径
 * @param lines 要写入的行数组
 */
export async function writeFileLines(
  filePath: string,
  lines: string[],
): Promise<void> {
  const fh = await open(filePath, 'w')
  try {
    // 将行数组重新连接为字符串并写入
    await fh.writeFile(lines.join('\n'), { encoding: 'utf8' })
    // 强制将数据刷入磁盘，防止断电丢失
    await fh.datasync()
  } finally {
    await fh.close()
  }
}

/**
 * 在所有 Shell 配置文件中查找 claude alias。
 *
 * 遍历 zsh/bash/fish 配置文件，找到第一个匹配的 claude alias 并返回其目标值。
 *
 * @param options 可选测试覆盖项（env、homedir）
 * @returns alias 目标字符串，未找到时返回 null
 */
export async function findClaudeAlias(
  options?: ShellConfigOptions,
): Promise<string | null> {
  const configs = getShellConfigPaths(options)

  for (const configPath of Object.values(configs)) {
    const lines = await readFileLines(configPath)
    if (!lines) continue

    for (const line of lines) {
      if (CLAUDE_ALIAS_REGEX.test(line)) {
        // 提取 alias 目标（不带引号的简单格式）
        const match = line.match(/alias\s+claude=["']?([^"'\s]+)/)
        if (match && match[1]) {
          return match[1]
        }
      }
    }
  }

  return null
}

/**
 * 在所有 Shell 配置文件中查找指向有效可执行文件的 claude alias。
 *
 * 在 findClaudeAlias() 基础上，额外校验 alias 目标文件是否存在
 * 且为普通文件或符号链接（即可执行的二进制或脚本）。
 *
 * @param options 可选测试覆盖项（env、homedir）
 * @returns 有效的 alias 目标字符串，未找到或目标无效时返回 null
 */
export async function findValidClaudeAlias(
  options?: ShellConfigOptions,
): Promise<string | null> {
  const aliasTarget = await findClaudeAlias(options)
  if (!aliasTarget) return null

  const home = options?.homedir ?? osHomedir()

  // 展开 ~ 为实际 home 目录路径
  const expandedPath = aliasTarget.startsWith('~')
    ? aliasTarget.replace('~', home)
    : aliasTarget

  // 检查目标是否存在且为文件/符号链接（即可执行文件）
  try {
    const stats = await stat(expandedPath)
    // 普通文件或符号链接均视为有效可执行目标
    if (stats.isFile() || stats.isSymbolicLink()) {
      return aliasTarget
    }
  } catch {
    // 目标不存在或无法访问，返回 null
  }

  return null
}
