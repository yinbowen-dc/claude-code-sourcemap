/**
 * 文件操作分析模块。
 *
 * 在 Claude Code 系统中，该模块为文件读写操作提供隐私安全的分析埋点，
 * 通过哈希摘要替代原始路径与内容，确保上报数据不含敏感信息：
 * - hashFilePath()：生成文件路径的 16 字符 SHA256 截断哈希，用于路径级统计
 * - hashFileContent()：生成文件内容的完整 SHA256 哈希，用于去重与变更检测
 * - 封装 logEvent 调用，统一上报 read/write/edit 等操作的分析元数据
 */
/**
 * 文件操作分析模块。
 *
 * 在 Claude Code 系统中，该模块为文件读写操作提供隐私安全的分析埋点，
 * 通过哈希摘要替代原始路径与内容，确保上报数据不含敏感信息：
 * - hashFilePath()：生成文件路径的 16 字符 SHA256 截断哈希，用于路径级统计
 * - hashFileContent()：生成文件内容的完整 SHA256 哈希，用于去重与变更检测
 * - 封装 logEvent 调用，统一上报 read/write/edit 等操作的分析元数据
 */
import { createHash } from 'crypto'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from 'src/services/analytics/index.js'
import { logEvent } from 'src/services/analytics/index.js'

/**
 * Creates a truncated SHA256 hash (16 chars) for file paths
 * Used for privacy-preserving analytics on file operations
 */
function hashFilePath(
  filePath: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return createHash('sha256')
    .update(filePath)
    .digest('hex')
    .slice(0, 16) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Creates a full SHA256 hash (64 chars) for file contents
 * Used for deduplication and change detection analytics
 */
function hashFileContent(
  content: string,
): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return createHash('sha256')
    .update(content)
    .digest('hex') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

// Maximum content size to hash (100KB)
// Prevents memory exhaustion when hashing large files (e.g., base64-encoded images)
const MAX_CONTENT_HASH_SIZE = 100 * 1024

/**
 * Logs file operation analytics to Statsig
 */
export function logFileOperation(params: {
  operation: 'read' | 'write' | 'edit'
  tool: 'FileReadTool' | 'FileWriteTool' | 'FileEditTool'
  filePath: string
  content?: string
  type?: 'create' | 'update'
}): void {
  const metadata: Record<
    string,
    | AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    | number
    | boolean
  > = {
    operation:
      params.operation as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    tool: params.tool as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    filePathHash: hashFilePath(params.filePath),
  }

  // Only hash content if it's provided and below size limit
  // This prevents memory exhaustion from hashing large files (e.g., base64-encoded images)
  if (
    params.content !== undefined &&
    params.content.length <= MAX_CONTENT_HASH_SIZE
  ) {
    metadata.contentHash = hashFileContent(params.content)
  }

  if (params.type !== undefined) {
    metadata.type =
      params.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  }

  logEvent('tengu_file_operation', metadata)
}
