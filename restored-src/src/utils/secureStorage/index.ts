/**
 * 安全存储入口模块 (secureStorage/index.ts)
 *
 * 在 Claude Code 系统流程中的位置：
 *   认证层 → 【本模块：平台派发】→ macOS Keychain / 明文文件存储
 *
 * 主要职责：
 *   1. 根据当前操作系统选择合适的安全存储后端
 *   2. macOS（darwin）：使用 Keychain 作为主存储，明文文件作为降级备份
 *   3. 其他平台（Linux / Windows）：直接使用明文文件存储
 *
 * 与其他模块的关系：
 *   - 被认证模块（auth.ts 等）调用，获取 SecureStorage 实例
 *   - macOS 路径通过 createFallbackStorage 构建双层降级链：keychain → plaintext
 */

import { createFallbackStorage } from './fallbackStorage.js'
import { macOsKeychainStorage } from './macOsKeychainStorage.js'
import { plainTextStorage } from './plainTextStorage.js'
import type { SecureStorage } from './types.js'

/**
 * 返回当前平台对应的安全存储实现。
 *
 * 平台派发策略：
 *   - darwin（macOS）：
 *       createFallbackStorage(macOsKeychainStorage, plainTextStorage)
 *       主存储：系统 Keychain（安全，进程监控不可见）
 *       备用：明文 JSON 文件（~/.claude/.credentials.json）
 *   - 其他平台（Linux / Windows）：
 *       plainTextStorage（仅明文 JSON 文件）
 *       TODO：后续计划为 Linux 添加 libsecret 支持
 *
 * @returns SecureStorage 接口实现
 */
export function getSecureStorage(): SecureStorage {
  if (process.platform === 'darwin') {
    // macOS：Keychain 优先，plaintext 作为降级备份
    return createFallbackStorage(macOsKeychainStorage, plainTextStorage)
  }

  // TODO: 为 Linux 添加 libsecret 支持
  // 非 macOS 平台：直接使用明文存储
  return plainTextStorage
}
