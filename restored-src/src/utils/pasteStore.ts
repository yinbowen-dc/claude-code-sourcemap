/**
 * 【文件定位】粘贴内容持久化存储模块 — Claude Code 用户输入层的内容寻址缓存组件
 *
 * 在 Claude Code 的系统架构中，本文件处于\"用户粘贴内容处理\"环节：
 *   用户粘贴内容 → [本模块：哈希 → 存盘] → UI 层引用哈希 → 会话结束后可检索
 *
 * 主要职责：
 *   1. 为粘贴的文本内容计算 SHA-256 哈希（取前 16 位十六进制字符作为文件名）
 *   2. 将粘贴内容异步写入 ~/.config/claude/paste-cache/{hash}.txt（内容寻址存储）
 *   3. 按哈希值检索已存储的粘贴内容（ENOENT 静默处理，其他错误记录日志）
 *   4. 按修改时间清理过期粘贴文件（早于指定截止日期的文件）
 *
 * 存储位置：~/.config/claude/paste-cache/（跨会话持久化）
 * 文件权限：0o600（仅当前用户可读写，保护粘贴内容安全）
 * 哈希长度：16 位十六进制（64 位熵，碰撞概率极低）
 *
 * 内容寻址特性：相同内容产生相同哈希 → 覆盖写入安全（幂等操作）
 */

import { createHash } from 'crypto'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { isENOENT } from './errors.js'

// 粘贴缓存目录名（相对于 Claude 配置根目录）
const PASTE_STORE_DIR = 'paste-cache'

/**
 * 获取粘贴缓存目录的完整路径。
 *
 * 路径格式：~/.config/claude/paste-cache/
 * 使用 getClaudeConfigHomeDir() 以支持通过环境变量自定义配置目录。
 *
 * @returns 粘贴缓存目录的绝对路径
 */
function getPasteStoreDir(): string {
  return join(getClaudeConfigHomeDir(), PASTE_STORE_DIR)
}

/**
 * 对粘贴文本内容计算内容寻址哈希（SHA-256 前 16 位十六进制）。
 *
 * 设计决策：
 *   - 导出为公开函数，允许调用方在异步存储完成之前立即使用哈希值
 *   - 16 位（64 bit）哈希在实际使用中碰撞概率极低，同时保持文件名紧凑
 *   - 内容寻址确保相同内容始终映射到同一文件（安全幂等）
 *
 * @param content - 要哈希的粘贴文本内容
 * @returns 16 位十六进制哈希字符串（如 'a1b2c3d4e5f60123'）
 */
export function hashPastedText(content: string): string {
  // SHA-256 → 十六进制 → 截取前 16 位
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/**
 * 根据哈希值构建粘贴文件的完整路径。
 *
 * @param hash - hashPastedText() 返回的哈希字符串
 * @returns 对应粘贴文件的绝对路径
 */
function getPastePath(hash: string): string {
  return join(getPasteStoreDir(), `${hash}.txt`)
}

/**
 * 将粘贴文本内容异步写入磁盘。
 *
 * 设计决策：
 *   - hash 参数由调用方预先计算（使用 hashPastedText()），
 *     这样调用方无需等待异步写入完成即可立即使用哈希值
 *   - 内容寻址存储：相同哈希 = 相同内容，覆盖写入是安全的幂等操作
 *   - 写入失败时只记录调试日志，不向上层抛出异常（不影响用户体验）
 *
 * 安全：文件权限设为 0o600（仅当前用户可读写）
 *
 * @param hash - hashPastedText() 预计算的哈希值
 * @param content - 要存储的粘贴文本内容
 */
export async function storePastedText(
  hash: string,
  content: string,
): Promise<void> {
  try {
    const dir = getPasteStoreDir()
    // 确保缓存目录存在（recursive=true 使其在已存在时不报错）
    await mkdir(dir, { recursive: true })

    const pastePath = getPastePath(hash)

    // 写入内容，权限 0o600 确保只有当前用户可读写
    await writeFile(pastePath, content, { encoding: 'utf8', mode: 0o600 })
    logForDebugging(`Stored paste ${hash} to ${pastePath}`)
  } catch (error) {
    // 存储失败不影响用户使用（粘贴功能仍可工作，只是无法持久化）
    logForDebugging(`Failed to store paste: ${error}`)
  }
}

/**
 * 按哈希值检索已存储的粘贴文本内容。
 *
 * 流程：
 *   1. 根据哈希构建文件路径
 *   2. 读取文件内容并返回
 *   3. ENOENT（文件不存在）时静默返回 null（正常情况，如过期被清理）
 *   4. 其他错误记录调试日志后返回 null
 *
 * @param hash - hashPastedText() 返回的哈希值
 * @returns 粘贴文本内容字符串，或 null（不存在或读取失败时）
 */
export async function retrievePastedText(hash: string): Promise<string | null> {
  try {
    const pastePath = getPastePath(hash)
    return await readFile(pastePath, { encoding: 'utf8' })
  } catch (error) {
    // ENOENT 是正常情况（粘贴已过期或从未写入），不记录日志
    if (!isENOENT(error)) {
      logForDebugging(`Failed to retrieve paste ${hash}: ${error}`)
    }
    return null
  }
}

/**
 * 清理早于截止日期的过期粘贴文件（基于文件修改时间）。
 *
 * 流程：
 *   1. 列出缓存目录中所有 .txt 文件
 *   2. 对每个文件检查修改时间（mtime）是否早于截止日期
 *   3. 早于截止日期的文件予以删除
 *   4. 目录不存在时静默返回（初始状态或已被清理）
 *
 * 设计：基于修改时间而非创建时间，确保「访问过的粘贴」不会被误删
 * （如果读取文件会更新 atime，但我们检查的是 mtime）
 *
 * @param cutoffDate - 截止日期，早于此日期修改的文件将被删除
 */
export async function cleanupOldPastes(cutoffDate: Date): Promise<void> {
  const pasteDir = getPasteStoreDir()

  let files
  try {
    files = await readdir(pasteDir)
  } catch {
    // 目录不存在或无法读取：无需清理，静默返回
    return
  }

  const cutoffTime = cutoffDate.getTime()
  for (const file of files) {
    // 只处理 .txt 格式的粘贴文件，忽略其他类型的文件
    if (!file.endsWith('.txt')) {
      continue
    }

    const filePath = join(pasteDir, file)
    try {
      const stats = await stat(filePath)
      // 修改时间早于截止时间 → 视为过期，删除
      if (stats.mtimeMs < cutoffTime) {
        await unlink(filePath)
        logForDebugging(`Cleaned up old paste: ${filePath}`)
      }
    } catch {
      // 忽略单个文件的错误（如并发删除），继续处理其他文件
    }
  }
}
