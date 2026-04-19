/**
 * 【文件定位】路径处理工具模块 — Claude Code 文件系统操作的核心路径规范化层
 *
 * 在 Claude Code 的系统架构中，本文件处于\"文件系统交互\"环节：
 *   工具调用（BashTool、ReadFileTool 等）→ [本模块：解析/规范化路径] → 实际文件系统操作
 *
 * 主要职责：
 *   1. expandPath：将含 ~ 的路径、POSIX 格式路径（Windows）、相对路径扩展为绝对路径
 *   2. toRelativePath：将绝对路径转换为相对 cwd 的路径（节省 token）
 *   3. getDirectoryForPath：获取文件或目录的父目录路径
 *   4. containsPathTraversal：检测路径是否包含 ../（目录遍历安全检查）
 *   5. normalizePathForConfigKey：规范化路径作为 JSON 配置 key（统一使用正斜杠）
 *   6. 重新导出 sanitizePath 供其他模块统一使用
 *
 * 安全注意：
 *   - expandPath 会拒绝包含 null 字节的路径（防止 null 字节注入攻击）
 *   - getDirectoryForPath 跳过 UNC 路径的文件系统操作（防止 NTLM 凭证泄露）
 *   - containsPathTraversal 检测 ../ 模式，供调用方做访问控制
 */

import { homedir } from 'os'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'path'
import { getCwd } from './cwd.js'
import { getFsImplementation } from './fsOperations.js'
import { getPlatform } from './platform.js'
import { posixPathToWindowsPath } from './windowsPaths.js'

/**
 * 将路径展开为绝对路径（支持 ~、POSIX 格式、相对路径）。
 *
 * 处理流程（按顺序）：
 *   1. 参数类型校验（必须为字符串）
 *   2. 安全检查：拒绝包含 null 字节的路径（防止注入攻击）
 *   3. 空路径 → 返回规范化后的 baseDir
 *   4. '~' → 用户 home 目录
 *   5. '~/' 开头 → home 目录 + 后续路径
 *   6. Windows 上的 POSIX 格式路径（如 /c/Users/...）→ 转换为 C:\Users\...
 *   7. 绝对路径 → 规范化后返回
 *   8. 相对路径 → resolve(baseDir, path)
 *
 * 所有返回值都经过 NFC Unicode 规范化（macOS HFS+ 使用 NFD，需转换为 NFC）。
 *
 * @param path - 要展开的路径（支持 ~、相对路径、绝对路径）
 * @param baseDir - 相对路径的基准目录（默认为当前工作目录）
 * @returns 规范化后的绝对路径
 * @throws TypeError 参数类型不对时
 * @throws Error 路径包含 null 字节时
 */
export function expandPath(path: string, baseDir?: string): string {
  // 若未提供 baseDir，依次尝试 getCwd()、getFsImplementation().cwd()
  const actualBaseDir = baseDir ?? getCwd() ?? getFsImplementation().cwd()

  // 类型校验（防止运行时传入非字符串值）
  if (typeof path !== 'string') {
    throw new TypeError(`Path must be a string, received ${typeof path}`)
  }

  if (typeof actualBaseDir !== 'string') {
    throw new TypeError(
      `Base directory must be a string, received ${typeof actualBaseDir}`,
    )
  }

  // 安全检查：null 字节在文件系统路径中非法，可用于绕过路径验证
  if (path.includes('\0') || actualBaseDir.includes('\0')) {
    throw new Error('Path contains null bytes')
  }

  // 空路径或纯空白路径 → 返回规范化的 baseDir
  const trimmedPath = path.trim()
  if (!trimmedPath) {
    return normalize(actualBaseDir).normalize('NFC')
  }

  // 单独的 '~' → home 目录
  if (trimmedPath === '~') {
    return homedir().normalize('NFC')
  }

  // '~/' 开头 → home 目录 + 后续路径（去掉 '~/' 前缀）
  if (trimmedPath.startsWith('~/')) {
    return join(homedir(), trimmedPath.slice(2)).normalize('NFC')
  }

  // Windows 平台：将 POSIX 风格的路径（/c/Users/...）转换为 Windows 格式（C:\Users\...）
  let processedPath = trimmedPath
  if (getPlatform() === 'windows' && trimmedPath.match(/^\/[a-z]\//i)) {
    try {
      processedPath = posixPathToWindowsPath(trimmedPath)
    } catch {
      // 转换失败时使用原始路径（保守处理）
      processedPath = trimmedPath
    }
  }

  // 绝对路径：规范化（解析 . 和 ..）后返回
  if (isAbsolute(processedPath)) {
    return normalize(processedPath).normalize('NFC')
  }

  // 相对路径：相对于 baseDir 解析为绝对路径
  return resolve(actualBaseDir, processedPath).normalize('NFC')
}

/**
 * 将绝对路径转换为相对于当前工作目录的路径（用于减少工具输出中的 token 数）。
 *
 * 规则：
 *   - 若相对路径以 '..' 开头（路径在 cwd 之外），保留原始绝对路径（保证明确性）
 *   - 否则返回相对路径（更简洁，节省 token）
 *
 * @param absolutePath - 要转换的绝对路径
 * @returns cwd 下的相对路径，或原始绝对路径（在 cwd 外部时）
 */
export function toRelativePath(absolutePath: string): string {
  const relativePath = relative(getCwd(), absolutePath)
  // 相对路径以 '..' 开头 → 在 cwd 之外，保留绝对路径避免歧义
  return relativePath.startsWith('..') ? absolutePath : relativePath
}

/**
 * 获取指定路径所在的目录路径。
 *
 * 逻辑：
 *   - 若路径指向一个目录 → 直接返回该路径
 *   - 若路径指向一个文件或不存在 → 返回其父目录
 *
 * 安全：跳过 UNC 路径（\\server\share 或 //server/share）的文件系统访问，
 *   防止 Windows 上访问 UNC 路径时泄露 NTLM 凭证（SMB 认证请求）。
 *
 * @param path - 目标路径（文件或目录）
 * @returns 目录路径
 */
export function getDirectoryForPath(path: string): string {
  const absolutePath = expandPath(path)
  // 安全：UNC 路径跳过 stat 调用，直接返回 dirname
  if (absolutePath.startsWith('\\\\') || absolutePath.startsWith('//')) {
    return dirname(absolutePath)
  }
  try {
    const stats = getFsImplementation().statSync(absolutePath)
    if (stats.isDirectory()) {
      return absolutePath
    }
  } catch {
    // 路径不存在或无法访问时，降级到 dirname
  }
  // 非目录或不存在时，返回父目录
  return dirname(absolutePath)
}

/**
 * 检测路径是否包含目录遍历模式（../）。
 *
 * 匹配规则：
 *   - 路径开头的 '..'（如 '../secret'）
 *   - 路径中间的 '/..' 或 '\..'（如 '/foo/../secret'）
 *   - 路径末尾的 '/..' 或 '\..'（如 '/foo/..'）
 *
 * 用途：供工具调用层进行访问控制检查，防止用户通过 ../.. 访问受限目录之外的路径。
 *
 * @param path - 要检查的路径字符串
 * @returns 包含目录遍历模式返回 true
 */
export function containsPathTraversal(path: string): boolean {
  return /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(path)
}

// 从零依赖的 sessionStoragePortable 模块重新导出 sanitizePath
// 供其他模块统一从本文件导入，无需了解底层模块结构
export { sanitizePath } from './sessionStoragePortable.js'

/**
 * 将路径规范化为适合作为 JSON 配置 key 的格式。
 *
 * 问题背景：
 *   Windows 路径中的分隔符可能是反斜杠（C:\path）也可能是正斜杠（C:/path），
 *   来自 git、Node.js API 和用户输入的路径格式不一致，导致 JSON key 不匹配。
 *
 * 处理流程：
 *   1. 使用 Node.js path.normalize 解析 . 和 .. 片段
 *   2. 将所有反斜杠替换为正斜杠，统一序列化格式
 *
 * 注意：正斜杠在 Windows 大多数操作中同样有效，此转换不影响路径可用性。
 *
 * @param path - 要规范化的路径
 * @returns 使用正斜杠的规范化路径字符串
 */
export function normalizePathForConfigKey(path: string): string {
  // 首先用 Node.js normalize 解析 . 和 .. 片段，使路径结构一致
  const normalized = normalize(path)
  // 将反斜杠统一替换为正斜杠，确保跨平台 JSON key 一致性
  return normalized.replace(/\\/g, '/')
}
