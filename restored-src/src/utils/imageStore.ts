/**
 * imageStore.ts — 会话图像持久化与内存缓存模块
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于工具层（utils），负责将用户粘贴的图像（PastedContent）
 * 持久化到本地磁盘，并维护一个内存中的"图像 ID → 文件路径"映射缓存。
 *
 * 数据流：
 *   用户粘贴图像 → imageStore.storeImage()
 *     → ~/.claude/image-cache/<sessionId>/<imageId>.<ext>
 *     → 内存缓存 storedImagePaths
 *
 * FileReadTool 和其他工具在需要引用图像文件路径时，
 * 通过 getStoredImagePath(imageId) 从内存缓存中快速获取，
 * 而不必重新解码 base64 数据或读取磁盘。
 *
 * 主要功能：
 *   1. storeImage / storeImages  — 将图像写入磁盘（0600 权限，防止其他用户读取）；
 *   2. cacheImagePath            — 仅更新内存缓存（不写磁盘，适用于已存在文件的情形）；
 *   3. getStoredImagePath        — 按 ID 查询内存缓存；
 *   4. clearStoredImagePaths     — 清空内存缓存（测试或会话重置时使用）；
 *   5. cleanupOldImageCaches     — 清理其他旧会话遗留的磁盘缓存目录，释放空间。
 */

import { mkdir, open } from 'fs/promises'
import { join } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import type { PastedContent } from './config.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { getFsImplementation } from './fsOperations.js'

// 磁盘缓存目录名（位于 ~/.claude/ 下）
const IMAGE_STORE_DIR = 'image-cache'
// 内存缓存最多保存 200 条记录，超出时淘汰最早的条目，防止内存无限增长
const MAX_STORED_IMAGE_PATHS = 200

// 内存缓存：imageId → 磁盘文件路径（Map 保留插入顺序，方便 LRU 淘汰）
const storedImagePaths = new Map<number, string>()

/**
 * 获取当前会话的图像缓存目录路径。
 * 路径格式：~/.claude/image-cache/<sessionId>/
 * 按会话隔离，防止不同会话的图像互相污染。
 */
function getImageStoreDir(): string {
  return join(getClaudeConfigHomeDir(), IMAGE_STORE_DIR, getSessionId())
}

/**
 * 确保图像缓存目录存在。
 * 使用 recursive: true，若目录已存在不会报错（幂等操作）。
 */
async function ensureImageStoreDir(): Promise<void> {
  const dir = getImageStoreDir()
  await mkdir(dir, { recursive: true })
}

/**
 * 根据图像 ID 和媒体类型生成磁盘文件路径。
 * 路径格式：~/.claude/image-cache/<sessionId>/<imageId>.<ext>
 *
 * @param imageId   - 图像的唯一 ID（来自 PastedContent）
 * @param mediaType - MIME 类型（如 'image/png'），用于确定扩展名
 */
function getImagePath(imageId: number, mediaType: string): string {
  // 从 MIME 类型中提取扩展名（如 'image/png' → 'png'）
  const extension = mediaType.split('/')[1] || 'png'
  return join(getImageStoreDir(), `${imageId}.${extension}`)
}

/**
 * 立即将图像路径写入内存缓存（无磁盘 I/O，速度快）。
 * 适用于图像文件已存在于磁盘但尚未写入缓存的场景。
 *
 * @param content - 粘贴内容对象
 * @returns 图像文件路径，若内容非图像类型则返回 null
 */
export function cacheImagePath(content: PastedContent): string | null {
  if (content.type !== 'image') {
    return null // 仅处理图像类型
  }
  const imagePath = getImagePath(content.id, content.mediaType || 'image/png')
  // 若缓存已满，先淘汰最旧的条目
  evictOldestIfAtCap()
  storedImagePaths.set(content.id, imagePath)
  return imagePath
}

/**
 * 将单个图像持久化到磁盘，并更新内存缓存。
 *
 * 写入流程：
 *   1. 确保目录存在；
 *   2. 以独占写入模式（'w'）打开文件，权限 0o600（仅所有者可读写）；
 *   3. 将 base64 内容解码后写入文件，调用 datasync 确保数据落盘；
 *   4. 更新内存缓存。
 *
 * @param content - 粘贴内容对象（必须是 image 类型）
 * @returns 存储的文件路径，失败时返回 null
 */
export async function storeImage(
  content: PastedContent,
): Promise<string | null> {
  if (content.type !== 'image') {
    return null // 非图像类型直接跳过
  }

  try {
    await ensureImageStoreDir()
    const imagePath = getImagePath(content.id, content.mediaType || 'image/png')
    // 以写入模式打开文件，设置 0600 权限防止其他用户读取
    const fh = await open(imagePath, 'w', 0o600)
    try {
      // 将 base64 编码的图像内容写入文件
      await fh.writeFile(content.content, { encoding: 'base64' })
      // datasync 确保数据真正写入磁盘（比 fsync 更轻量）
      await fh.datasync()
    } finally {
      // 无论成功与否都关闭文件句柄，防止句柄泄漏
      await fh.close()
    }
    // 写入成功，更新内存缓存
    evictOldestIfAtCap()
    storedImagePaths.set(content.id, imagePath)
    logForDebugging(`Stored image ${content.id} to ${imagePath}`)
    return imagePath
  } catch (error) {
    // 写入失败时静默降级（不影响主流程，图像可能无法通过路径访问）
    logForDebugging(`Failed to store image: ${error}`)
    return null
  }
}

/**
 * 批量将多个图像持久化到磁盘。
 * 顺序处理（非并行），避免同时大量写入磁盘导致 I/O 竞争。
 *
 * @param pastedContents - 以 ID 为键的粘贴内容字典
 * @returns 成功写入的 imageId → filePath 映射
 */
export async function storeImages(
  pastedContents: Record<number, PastedContent>,
): Promise<Map<number, string>> {
  const pathMap = new Map<number, string>()

  for (const [id, content] of Object.entries(pastedContents)) {
    if (content.type === 'image') {
      const path = await storeImage(content)
      if (path) {
        // Number(id) 是因为 Object.entries 将数字键转为字符串
        pathMap.set(Number(id), path)
      }
    }
  }

  return pathMap
}

/**
 * 根据图像 ID 从内存缓存中查询已存储的文件路径。
 * 供 FileReadTool 等工具在无需重新写盘的情况下快速获取路径。
 *
 * @param imageId - 图像唯一 ID
 * @returns 文件路径，若不存在则返回 null
 */
export function getStoredImagePath(imageId: number): string | null {
  return storedImagePaths.get(imageId) ?? null
}

/**
 * 清空内存中的图像路径缓存。
 * 通常在测试重置或会话结束时调用。
 */
export function clearStoredImagePaths(): void {
  storedImagePaths.clear()
}

/**
 * 若内存缓存已达到上限（MAX_STORED_IMAGE_PATHS），则不断淘汰最旧的条目，
 * 直到腾出至少一个空位。
 * Map 的迭代顺序与插入顺序一致，因此 keys().next() 返回最旧的键。
 */
function evictOldestIfAtCap(): void {
  while (storedImagePaths.size >= MAX_STORED_IMAGE_PATHS) {
    // 获取插入最早的键（Map 按插入顺序迭代）
    const oldest = storedImagePaths.keys().next().value
    if (oldest !== undefined) {
      storedImagePaths.delete(oldest)
    } else {
      break // 不应发生，但防御性保护
    }
  }
}

/**
 * 清理旧会话遗留在磁盘上的图像缓存目录，释放磁盘空间。
 *
 * 逻辑：
 *   1. 读取 ~/.claude/image-cache/ 下所有子目录（每个对应一个历史会话）；
 *   2. 跳过当前会话的目录；
 *   3. 删除其余目录（递归强制删除）；
 *   4. 若基础目录已为空，也一并删除。
 *
 * 所有错误均被忽略，避免影响主流程。
 */
export async function cleanupOldImageCaches(): Promise<void> {
  const fsImpl = getFsImplementation()
  const baseDir = join(getClaudeConfigHomeDir(), IMAGE_STORE_DIR)
  const currentSessionId = getSessionId()

  try {
    let sessionDirs
    try {
      // 读取基础目录中的所有会话子目录
      sessionDirs = await fsImpl.readdir(baseDir)
    } catch {
      // 基础目录不存在，直接返回
      return
    }

    for (const sessionDir of sessionDirs) {
      // 跳过当前会话的目录（正在使用中）
      if (sessionDir.name === currentSessionId) {
        continue
      }

      const sessionPath = join(baseDir, sessionDir.name)
      try {
        // 递归强制删除旧会话目录
        await fsImpl.rm(sessionPath, { recursive: true, force: true })
        logForDebugging(`Cleaned up old image cache: ${sessionPath}`)
      } catch {
        // 单个目录删除失败时继续处理其余目录
      }
    }

    try {
      // 若基础目录已完全清空，也删除它（保持 ~/.claude 整洁）
      const remaining = await fsImpl.readdir(baseDir)
      if (remaining.length === 0) {
        await fsImpl.rmdir(baseDir)
      }
    } catch {
      // 忽略最终清理错误
    }
  } catch {
    // 忽略读取基础目录时的错误
  }
}
