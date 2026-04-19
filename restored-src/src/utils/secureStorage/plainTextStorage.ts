/**
 * 明文凭证存储实现 (plainTextStorage.ts)
 *
 * 在 Claude Code 系统流程中的位置：
 *   认证层 → getSecureStorage() → 【本模块：明文 JSON 文件存储】
 *
 * 主要职责：
 *   1. 将凭证以 JSON 格式存储在 ~/.claude/.credentials.json
 *   2. 写入后立即执行 chmod 0o600，确保文件仅所有者可读写
 *   3. 作为 macOS Keychain 存储的降级备份（通过 fallbackStorage 组合）
 *   4. 在 Linux / Windows 上作为唯一的安全存储实现
 *
 * 安全说明：
 *   - 相比 Keychain 安全性较低（明文文件可被有文件系统访问权限的进程读取）
 *   - update() 返回 warning 字段提示用户当前使用明文存储
 *   - chmod 600 限制其他用户读取，是可行范围内的最低保护
 *
 * 与其他模块的关系：
 *   - 被 secureStorage/index.ts 直接使用（非 macOS）或通过 createFallbackStorage 组合（macOS）
 *   - 使用 getFsImplementation() 允许测试注入虚拟文件系统
 */

import { chmodSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { getErrnoCode } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import {
  jsonParse,
  jsonStringify,
  writeFileSync_DEPRECATED,
} from '../slowOperations.js'
import type { SecureStorage, SecureStorageData } from './types.js'

/**
 * 计算凭证文件路径。
 *
 * 返回 storageDir（~/.claude 目录）和完整文件路径（~/.claude/.credentials.json）。
 * 每次调用动态计算，支持测试中修改 CLAUDE_CONFIG_DIR 环境变量。
 */
function getStoragePath(): { storageDir: string; storagePath: string } {
  const storageDir = getClaudeConfigHomeDir()
  const storageFileName = '.credentials.json'
  return { storageDir, storagePath: join(storageDir, storageFileName) }
}

/**
 * 明文 JSON 文件凭证存储，满足 SecureStorage 接口。
 */
export const plainTextStorage = {
  name: 'plaintext',

  /**
   * 同步读取凭证文件。
   *
   * 流程：
   *   1. 计算文件路径
   *   2. 同步读取文件内容（接口要求同步）
   *   3. 解析 JSON 并返回，任何错误（ENOENT、格式错误等）均返回 null
   */
  read(): SecureStorageData | null {
    // 同步 I/O：接口契约要求同步调用（SecureStorage.read 无 async）
    const { storagePath } = getStoragePath()
    try {
      const data = getFsImplementation().readFileSync(storagePath, {
        encoding: 'utf8',
      })
      return jsonParse(data)
    } catch {
      // 文件不存在（ENOENT）或 JSON 格式错误：返回 null
      return null
    }
  },

  /**
   * 异步读取凭证文件（供 readAsync 路径使用）。
   *
   * 与 read() 逻辑相同，但使用异步 I/O，避免阻塞事件循环。
   */
  async readAsync(): Promise<SecureStorageData | null> {
    const { storagePath } = getStoragePath()
    try {
      const data = await getFsImplementation().readFile(storagePath, {
        encoding: 'utf8',
      })
      return jsonParse(data)
    } catch {
      return null
    }
  },

  /**
   * 将凭证数据写入 JSON 文件，并设置文件权限为 0o600。
   *
   * 流程：
   *   1. 确保 ~/.claude 目录存在（mkdir，忽略 EEXIST）
   *   2. 序列化数据为 JSON 字符串并写入文件
   *   3. chmod 0o600：禁止 group 和 other 读写（仅所有者可访问）
   *   4. 返回 warning 字段提示明文存储的安全风险
   */
  update(data: SecureStorageData): { success: boolean; warning?: string } {
    // 同步 I/O：接口契约要求同步调用
    try {
      const { storageDir, storagePath } = getStoragePath()
      // 确保存储目录存在，已存在时静默忽略
      try {
        getFsImplementation().mkdirSync(storageDir)
      } catch (e: unknown) {
        const code = getErrnoCode(e)
        // 仅忽略 EEXIST（目录已存在），其他错误继续抛出
        if (code !== 'EEXIST') {
          throw e
        }
      }

      // 写入 JSON 文件（flush:false，由 OS 决定刷盘时机）
      writeFileSync_DEPRECATED(storagePath, jsonStringify(data), {
        encoding: 'utf8',
        flush: false,
      })
      // 设置文件权限：仅所有者可读写（rw-------）
      chmodSync(storagePath, 0o600)
      return {
        success: true,
        // 明文存储安全提示，供调用方在 UI 中展示
        warning: 'Warning: Storing credentials in plaintext.',
      }
    } catch {
      return { success: false }
    }
  },

  /**
   * 删除凭证文件。
   *
   * 流程：
   *   1. 调用 unlinkSync 删除文件
   *   2. 文件不存在（ENOENT）时视为删除成功（幂等操作）
   *   3. 其他错误（权限不足等）返回 false
   */
  delete(): boolean {
    // 同步 I/O：接口契约要求同步调用
    const { storagePath } = getStoragePath()
    try {
      getFsImplementation().unlinkSync(storagePath)
      return true
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      // ENOENT：文件本就不存在，视为删除成功（幂等）
      if (code === 'ENOENT') {
        return true
      }
      return false
    }
  },
} satisfies SecureStorage
