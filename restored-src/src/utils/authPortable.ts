/**
 * 跨平台 API Key 管理工具模块。
 *
 * 在 Claude Code 系统中，该模块提供与操作系统无关的 API key 辅助操作：
 * - maybeRemoveApiKeyFromMacOSKeychainThrows()：在 macOS 上从 Keychain 删除 API key
 * - normalizeApiKeyForConfig()：截取 API key 末 20 字符用于配置存储（避免明文存储）
 */
import { execa } from 'execa'
import { getMacOsKeychainStorageServiceName } from 'src/utils/secureStorage/macOsKeychainHelpers.js'

/** 若当前平台为 macOS，尝试从 Keychain 删除 API key；失败时抛出错误。 */
export async function maybeRemoveApiKeyFromMacOSKeychainThrows(): Promise<void> {
  if (process.platform === 'darwin') {
    const storageServiceName = getMacOsKeychainStorageServiceName()
    const result = await execa(
      `security delete-generic-password -a $USER -s "${storageServiceName}"`,
      { shell: true, reject: false },
    )
    if (result.exitCode !== 0) {
      throw new Error('Failed to delete keychain entry')
    }
  }
}

/** 截取 API key 末 20 字符，用于配置文件中的键标识（避免明文存储完整密钥）。 */
export function normalizeApiKeyForConfig(apiKey: string): string {
  return apiKey.slice(-20)
}
