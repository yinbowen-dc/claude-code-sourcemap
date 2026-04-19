/**
 * filesApi.ts — Anthropic 公共文件 API 客户端
 *
 * 在 Claude Code 系统流程中的位置：
 *   会话启动时，Claude Code agent 通过此模块从 Anthropic Files API 下载
 *   用户通过 CLI 参数 `--file=<file_id>:<relative_path>` 传入的文件附件；
 *   在 BYOC（Bring Your Own Context）模式下，也负责将本地文件上传至 Files API；
 *   在 1P/Cloud 模式下，还提供列举指定时间戳之后创建的文件的能力。
 *
 * 主要功能：
 *   - 下载单个文件（downloadFile）/ 批量并发下载（downloadSessionFiles）
 *   - 上传单个文件（uploadFile）/ 批量并发上传（uploadSessionFiles）
 *   - 列举文件（listFilesCreatedAfter），支持分页游标
 *   - 解析 CLI 传入的文件描述符（parseFileSpecs）
 *   - 内置指数退避重试（retryWithBackoff）、并发控制（parallelWithLimit）
 *
 * API 参考：https://docs.anthropic.com/en/api/files-content
 */

import axios from 'axios'
import { randomUUID } from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import { count } from '../../utils/array.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { sleep } from '../../utils/sleep.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'

// Files API 目前处于 Beta 阶段；oauth-2025-04-20 用于在公共 API 路由上启用 Bearer OAuth
// （auth.py: "oauth_auth" not in beta_versions → 404）
const FILES_API_BETA_HEADER = 'files-api-2025-04-14,oauth-2025-04-20'
// Anthropic API 版本号，用于请求头
const ANTHROPIC_VERSION = '2023-06-01'

/**
 * 获取默认的 API Base URL。
 * 优先读取 ANTHROPIC_BASE_URL，其次 CLAUDE_CODE_API_BASE_URL，
 * 最后回退到公共 API 地址，以便独立使用时也能正常工作。
 */
function getDefaultApiBaseUrl(): string {
  return (
    process.env.ANTHROPIC_BASE_URL ||
    process.env.CLAUDE_CODE_API_BASE_URL ||
    'https://api.anthropic.com'
  )
}

/** 将错误信息以 error 级别写入调试日志，前缀为 [files-api] */
function logDebugError(message: string): void {
  logForDebugging(`[files-api] ${message}`, { level: 'error' })
}

/** 将普通信息写入调试日志，前缀为 [files-api] */
function logDebug(message: string): void {
  logForDebugging(`[files-api] ${message}`)
}

/**
 * 从 CLI 参数解析出的文件描述符。
 * 格式：--file=<file_id>:<relative_path>
 */
export type File = {
  fileId: string      // Anthropic Files API 中的文件 ID
  relativePath: string // 文件在本地工作区中的相对路径
}

/**
 * Files API 客户端配置，包含鉴权信息与基础 URL。
 */
export type FilesApiConfig = {
  /** OAuth 令牌，用于 Bearer 鉴权（来自会话 JWT） */
  oauthToken: string
  /** API Base URL（默认：https://api.anthropic.com） */
  baseUrl?: string
  /** 用于构造会话特定目录的会话 ID */
  sessionId: string
}

/**
 * 单次文件下载操作的结果。
 */
export type DownloadResult = {
  fileId: string         // 文件 ID
  path: string           // 本地写入路径
  success: boolean       // 是否成功
  error?: string         // 失败时的错误信息
  bytesWritten?: number  // 成功时写入的字节数
}

// 最大重试次数
const MAX_RETRIES = 3
// 重试基础延迟（毫秒），每次以指数方式增长
const BASE_DELAY_MS = 500
// 单文件最大尺寸 500MB，超出则拒绝上传
const MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024 // 500MB

/**
 * 重试操作的结果类型：
 *   - done: true  → 操作成功，携带返回值
 *   - done: false → 操作失败，可选携带错误信息，等待下次重试
 */
type RetryResult<T> = { done: true; value: T } | { done: false; error?: string }

/**
 * 带指数退避的重试执行器。
 *
 * 流程：
 *   1. 循环调用 attemptFn，最多执行 MAX_RETRIES 次
 *   2. 若 attemptFn 返回 { done: true }，立即返回其 value
 *   3. 若返回 { done: false }，记录错误、等待退避时间后重试
 *   4. 全部重试耗尽后抛出包含最后一次错误信息的 Error
 *
 * @param operation  操作名称，用于日志记录
 * @param attemptFn  每次尝试执行的异步函数，返回 RetryResult
 * @returns 操作成功时的返回值
 * @throws  全部重试失败后抛出 Error
 */
async function retryWithBackoff<T>(
  operation: string,
  attemptFn: (attempt: number) => Promise<RetryResult<T>>,
): Promise<T> {
  let lastError = ''

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    // 执行本次尝试
    const result = await attemptFn(attempt)

    if (result.done) {
      // 操作成功，直接返回值
      return result.value
    }

    // 记录失败信息
    lastError = result.error || `${operation} failed`
    logDebug(
      `${operation} attempt ${attempt}/${MAX_RETRIES} failed: ${lastError}`,
    )

    // 若还有剩余重试次数，等待指数退避时间后继续
    if (attempt < MAX_RETRIES) {
      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1) // 指数退避：500ms, 1000ms, ...
      logDebug(`Retrying ${operation} in ${delayMs}ms...`)
      await sleep(delayMs)
    }
  }

  // 所有重试耗尽，抛出最终错误
  throw new Error(`${lastError} after ${MAX_RETRIES} attempts`)
}

/**
 * 从 Anthropic 公共 Files API 下载单个文件内容。
 *
 * 流程：
 *   1. 构造下载 URL：{baseUrl}/v1/files/{fileId}/content
 *   2. 带 Bearer OAuth 与 Beta Header 发起 GET 请求
 *   3. 对非 5xx 响应直接处理：200 返回 Buffer；404/401/403 立即抛出不可重试错误
 *   4. 对网络层错误通过 retryWithBackoff 重试
 *
 * @param fileId  文件 ID（如 "file_011CNha8iCJcU1wXNR6q4V8w"）
 * @param config  Files API 配置
 * @returns       文件内容 Buffer
 */
export async function downloadFile(
  fileId: string,
  config: FilesApiConfig,
): Promise<Buffer> {
  const baseUrl = config.baseUrl || getDefaultApiBaseUrl()
  // 构造文件内容下载端点 URL
  const url = `${baseUrl}/v1/files/${fileId}/content`

  // 构造请求头：Bearer Token + API 版本 + Beta 功能标识
  const headers = {
    Authorization: `Bearer ${config.oauthToken}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': FILES_API_BETA_HEADER,
  }

  logDebug(`Downloading file ${fileId} from ${url}`)

  return retryWithBackoff(`Download file ${fileId}`, async () => {
    try {
      const response = await axios.get(url, {
        headers,
        responseType: 'arraybuffer',   // 以二进制 Buffer 形式接收响应
        timeout: 60000,                // 大文件下载最长等待 60 秒
        validateStatus: status => status < 500, // 5xx 才视为 Axios 错误，其余由代码处理
      })

      if (response.status === 200) {
        logDebug(`Downloaded file ${fileId} (${response.data.length} bytes)`)
        return { done: true, value: Buffer.from(response.data) }
      }

      // 以下为不可重试的错误，直接抛出以跳出重试循环
      if (response.status === 404) {
        throw new Error(`File not found: ${fileId}`)
      }
      if (response.status === 401) {
        throw new Error('Authentication failed: invalid or missing API key')
      }
      if (response.status === 403) {
        throw new Error(`Access denied to file: ${fileId}`)
      }

      // 其他状态码（如 5xx 被 validateStatus 过滤后的剩余情况）可以重试
      return { done: false, error: `status ${response.status}` }
    } catch (error) {
      if (!axios.isAxiosError(error)) {
        // 非 Axios 错误（即上面手动 throw 的不可重试错误）直接向上传播
        throw error
      }
      // 网络层错误（如超时、连接失败）可以重试
      return { done: false, error: error.message }
    }
  })
}

/**
 * 规范化相对路径，去除冗余前缀，并拼接出完整的下载目标路径。
 * 路径格式：{basePath}/{sessionId}/uploads/{cleanPath}
 * 若路径包含路径穿越（".."开头），返回 null 以拒绝。
 *
 * @param basePath     工作区根目录
 * @param sessionId    当前会话 ID
 * @param relativePath 文件的相对路径
 * @returns            完整的本地文件路径；若路径非法则返回 null
 */
export function buildDownloadPath(
  basePath: string,
  sessionId: string,
  relativePath: string,
): string | null {
  // 规范化路径，消除 ./ 等冗余部分
  const normalized = path.normalize(relativePath)
  // 防止路径穿越攻击
  if (normalized.startsWith('..')) {
    logDebugError(
      `Invalid file path: ${relativePath}. Path must not traverse above workspace`,
    )
    return null
  }

  // 上传文件存储在 {basePath}/{sessionId}/uploads/ 目录下
  const uploadsBase = path.join(basePath, sessionId, 'uploads')
  // 需要去除的冗余前缀列表（避免路径重复拼接）
  const redundantPrefixes = [
    path.join(basePath, sessionId, 'uploads') + path.sep,
    path.sep + 'uploads' + path.sep,
  ]
  const matchedPrefix = redundantPrefixes.find(p => normalized.startsWith(p))
  // 剥除冗余前缀，得到清洁的相对路径部分
  const cleanPath = matchedPrefix
    ? normalized.slice(matchedPrefix.length)
    : normalized
  return path.join(uploadsBase, cleanPath)
}

/**
 * 下载单个文件并保存到会话专属的工作区目录。
 *
 * 流程：
 *   1. 调用 buildDownloadPath 计算本地保存路径
 *   2. 调用 downloadFile 获取文件内容
 *   3. 递归创建父目录（若不存在）
 *   4. 将内容写入本地文件
 *
 * @param attachment  待下载的文件描述符
 * @param config      Files API 配置
 * @returns           下载结果（成功/失败及相关信息）
 */
export async function downloadAndSaveFile(
  attachment: File,
  config: FilesApiConfig,
): Promise<DownloadResult> {
  const { fileId, relativePath } = attachment
  // 根据当前工作目录和会话 ID 构造完整的本地保存路径
  const fullPath = buildDownloadPath(getCwd(), config.sessionId, relativePath)

  // 路径非法时直接返回失败结果
  if (!fullPath) {
    return {
      fileId,
      path: '',
      success: false,
      error: `Invalid file path: ${relativePath}`,
    }
  }

  try {
    // 步骤 1：从 Files API 下载文件内容
    const content = await downloadFile(fileId, config)

    // 步骤 2：确保父目录存在（递归创建）
    const parentDir = path.dirname(fullPath)
    await fs.mkdir(parentDir, { recursive: true })

    // 步骤 3：将文件内容写入本地路径
    await fs.writeFile(fullPath, content)

    logDebug(`Saved file ${fileId} to ${fullPath} (${content.length} bytes)`)

    return {
      fileId,
      path: fullPath,
      success: true,
      bytesWritten: content.length,
    }
  } catch (error) {
    logDebugError(`Failed to download file ${fileId}: ${errorMessage(error)}`)
    if (error instanceof Error) {
      logError(error)
    }

    return {
      fileId,
      path: fullPath,
      success: false,
      error: errorMessage(error),
    }
  }
}

// 并发下载/上传的默认最大并发数
const DEFAULT_CONCURRENCY = 5

/**
 * 带并发限制的并行执行器。
 *
 * 原理：启动最多 concurrency 个 worker 协程，每个 worker 依次从共享索引中
 * 取出下一个待处理项，直到全部项目处理完毕，保证同时运行的 worker 不超过限制数。
 *
 * @param items        待处理的项目列表
 * @param fn           对每个项目执行的异步函数
 * @param concurrency  最大并发数
 * @returns            与输入顺序一一对应的结果数组
 */
async function parallelWithLimit<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let currentIndex = 0 // 共享的"下一个待处理"索引，由各 worker 竞争读取

  // 单个 worker 的执行逻辑：循环取项并处理，直到全部完成
  async function worker(): Promise<void> {
    while (currentIndex < items.length) {
      const index = currentIndex++ // 原子性取出当前索引（JS 单线程，无竞态）
      const item = items[index]
      if (item !== undefined) {
        results[index] = await fn(item, index)
      }
    }
  }

  // 启动不超过 concurrency 和 items.length 中较小值的 worker 数
  const workers: Promise<void>[] = []
  const workerCount = Math.min(concurrency, items.length)
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker())
  }

  // 等待所有 worker 完成
  await Promise.all(workers)
  return results
}

/**
 * 并发下载会话的所有文件附件。
 *
 * 流程：
 *   1. 若文件列表为空，直接返回空数组
 *   2. 通过 parallelWithLimit 以有限并发数并行调用 downloadAndSaveFile
 *   3. 记录总耗时和成功数量
 *
 * @param files       待下载的文件列表
 * @param config      Files API 配置
 * @param concurrency 最大并发下载数（默认 5）
 * @returns           与输入顺序一一对应的下载结果数组
 */
export async function downloadSessionFiles(
  files: File[],
  config: FilesApiConfig,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<DownloadResult[]> {
  if (files.length === 0) {
    return []
  }

  logDebug(
    `Downloading ${files.length} file(s) for session ${config.sessionId}`,
  )
  const startTime = Date.now()

  // 并发下载，由 parallelWithLimit 控制并发上限
  const results = await parallelWithLimit(
    files,
    file => downloadAndSaveFile(file, config),
    concurrency,
  )

  const elapsedMs = Date.now() - startTime
  const successCount = count(results, r => r.success)
  logDebug(
    `Downloaded ${successCount}/${files.length} file(s) in ${elapsedMs}ms`,
  )

  return results
}

// ============================================================================
// 上传相关函数（BYOC 模式）
// ============================================================================

/**
 * 单次文件上传操作的结果（联合类型：成功/失败）。
 */
export type UploadResult =
  | {
      path: string    // 文件的相对路径
      fileId: string  // API 返回的文件 ID
      size: number    // 上传的文件字节数
      success: true
    }
  | {
      path: string    // 文件的相对路径
      error: string   // 错误信息
      success: false
    }

/**
 * 将本地文件上传至 Files API（BYOC 模式）。
 *
 * 流程：
 *   1. 读取文件内容（在重试循环外，避免 TOCTOU 竞态）
 *   2. 校验文件大小是否超过 MAX_FILE_SIZE_BYTES
 *   3. 构造 multipart/form-data 请求体（文件内容 + purpose 字段）
 *   4. 带指数退避重试 POST 请求；401/403/413 为不可重试错误
 *
 * @param filePath     本地文件的绝对路径
 * @param relativePath 文件的相对路径（作为 API 中的文件名）
 * @param config       Files API 配置
 * @param opts         可选参数，包含 AbortSignal 以支持中止上传
 * @returns            上传结果（成功含 fileId，失败含错误信息）
 */
export async function uploadFile(
  filePath: string,
  relativePath: string,
  config: FilesApiConfig,
  opts?: { signal?: AbortSignal },
): Promise<UploadResult> {
  const baseUrl = config.baseUrl || getDefaultApiBaseUrl()
  // 上传端点：POST /v1/files
  const url = `${baseUrl}/v1/files`

  const headers = {
    Authorization: `Bearer ${config.oauthToken}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': FILES_API_BETA_HEADER,
  }

  logDebug(`Uploading file ${filePath} as ${relativePath}`)

  // 在重试循环外预先读取文件内容，避免多次 I/O 和 TOCTOU 竞态
  let content: Buffer
  try {
    content = await fs.readFile(filePath)
  } catch (error) {
    // 文件读取失败，记录分析事件并直接返回失败
    logEvent('tengu_file_upload_failed', {
      error_type:
        'file_read' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return {
      path: relativePath,
      error: errorMessage(error),
      success: false,
    }
  }

  const fileSize = content.length

  // 校验文件大小，超出 500MB 则拒绝
  if (fileSize > MAX_FILE_SIZE_BYTES) {
    logEvent('tengu_file_upload_failed', {
      error_type:
        'file_too_large' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return {
      path: relativePath,
      error: `File exceeds maximum size of ${MAX_FILE_SIZE_BYTES} bytes (actual: ${fileSize})`,
      success: false,
    }
  }

  // 使用 crypto.randomUUID 生成 boundary，避免同毫秒内多次上传时发生碰撞
  const boundary = `----FormBoundary${randomUUID()}`
  const filename = path.basename(relativePath)

  // 手动构造 multipart/form-data 请求体
  const bodyParts: Buffer[] = []

  // --- 文件内容 part ---
  bodyParts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
    ),
  )
  bodyParts.push(content) // 文件的二进制内容
  bodyParts.push(Buffer.from('\r\n'))

  // --- purpose 字段 part ---
  bodyParts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="purpose"\r\n\r\n` +
        `user_data\r\n`,
    ),
  )

  // --- 结束边界 ---
  bodyParts.push(Buffer.from(`--${boundary}--\r\n`))

  // 将所有 part 拼接成最终的请求体 Buffer
  const body = Buffer.concat(bodyParts)

  try {
    return await retryWithBackoff(`Upload file ${relativePath}`, async () => {
      try {
        const response = await axios.post(url, body, {
          headers: {
            ...headers,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length.toString(),
          },
          timeout: 120000, // 上传最长等待 2 分钟
          signal: opts?.signal, // 支持外部中止
          validateStatus: status => status < 500, // 5xx 触发 Axios 错误
        })

        if (response.status === 200 || response.status === 201) {
          const fileId = response.data?.id
          if (!fileId) {
            // API 返回成功但没有文件 ID，视为可重试的异常
            return {
              done: false,
              error: 'Upload succeeded but no file ID returned',
            }
          }
          logDebug(`Uploaded file ${filePath} -> ${fileId} (${fileSize} bytes)`)
          return {
            done: true,
            value: {
              path: relativePath,
              fileId,
              size: fileSize,
              success: true as const,
            },
          }
        }

        // 以下为不可重试的错误，抛出 UploadNonRetriableError 以跳出重试循环
        if (response.status === 401) {
          logEvent('tengu_file_upload_failed', {
            error_type:
              'auth' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          throw new UploadNonRetriableError(
            'Authentication failed: invalid or missing API key',
          )
        }

        if (response.status === 403) {
          logEvent('tengu_file_upload_failed', {
            error_type:
              'forbidden' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          throw new UploadNonRetriableError('Access denied for upload')
        }

        if (response.status === 413) {
          logEvent('tengu_file_upload_failed', {
            error_type:
              'size' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          throw new UploadNonRetriableError('File too large for upload')
        }

        // 其他状态码（如 429）视为可重试
        return { done: false, error: `status ${response.status}` }
      } catch (error) {
        // 不可重试错误向上传播，跳出 retryWithBackoff
        if (error instanceof UploadNonRetriableError) {
          throw error
        }
        // 用户主动取消时，包装为不可重试错误
        if (axios.isCancel(error)) {
          throw new UploadNonRetriableError('Upload canceled')
        }
        // 网络层错误（超时、连接失败等）视为可重试
        if (axios.isAxiosError(error)) {
          return { done: false, error: error.message }
        }
        throw error
      }
    })
  } catch (error) {
    // 捕获 retryWithBackoff 抛出的 UploadNonRetriableError，转换为失败结果
    if (error instanceof UploadNonRetriableError) {
      return {
        path: relativePath,
        error: error.message,
        success: false,
      }
    }
    // 其余错误（网络重试耗尽）记录分析事件并返回失败
    logEvent('tengu_file_upload_failed', {
      error_type:
        'network' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return {
      path: relativePath,
      error: errorMessage(error),
      success: false,
    }
  }
}

/** 不可重试的上传错误类，用于在重试循环中立即终止 */
class UploadNonRetriableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadNonRetriableError'
  }
}

/**
 * 并发上传多个文件（BYOC 模式）。
 *
 * 流程与 downloadSessionFiles 对称：
 *   通过 parallelWithLimit 以有限并发数并行调用 uploadFile，
 *   记录总耗时和成功数量后返回结果数组。
 *
 * @param files       待上传的文件列表（每项包含 path 和 relativePath）
 * @param config      Files API 配置
 * @param concurrency 最大并发上传数（默认 5）
 * @returns           与输入顺序一一对应的上传结果数组
 */
export async function uploadSessionFiles(
  files: Array<{ path: string; relativePath: string }>,
  config: FilesApiConfig,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<UploadResult[]> {
  if (files.length === 0) {
    return []
  }

  logDebug(`Uploading ${files.length} file(s) for session ${config.sessionId}`)
  const startTime = Date.now()

  const results = await parallelWithLimit(
    files,
    file => uploadFile(file.path, file.relativePath, config),
    concurrency,
  )

  const elapsedMs = Date.now() - startTime
  const successCount = count(results, r => r.success)
  logDebug(`Uploaded ${successCount}/${files.length} file(s) in ${elapsedMs}ms`)

  return results
}

// ============================================================================
// 文件列举相关函数（1P/Cloud 模式）
// ============================================================================

/**
 * listFilesCreatedAfter 返回的文件元信息。
 */
export type FileMetadata = {
  filename: string // 文件名
  fileId: string   // Files API 中的文件 ID
  size: number     // 文件字节数
}

/**
 * 列举在指定时间戳之后创建的所有文件（1P/Cloud 模式）。
 *
 * 流程：
 *   1. 调用 GET /v1/files?after_created_at=<ISO8601>
 *   2. 通过 after_id 游标实现分页，直到 has_more 为 false
 *   3. 将所有页面的结果合并后返回
 *
 * @param afterCreatedAt  ISO 8601 格式的时间戳，仅返回此时间之后创建的文件
 * @param config          Files API 配置
 * @returns               文件元信息数组
 */
export async function listFilesCreatedAfter(
  afterCreatedAt: string,
  config: FilesApiConfig,
): Promise<FileMetadata[]> {
  const baseUrl = config.baseUrl || getDefaultApiBaseUrl()
  const headers = {
    Authorization: `Bearer ${config.oauthToken}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': FILES_API_BETA_HEADER,
  }

  logDebug(`Listing files created after ${afterCreatedAt}`)

  const allFiles: FileMetadata[] = []
  let afterId: string | undefined // 分页游标，指向上一页最后一个文件的 ID

  // 分页循环，直到没有更多数据
  while (true) {
    const params: Record<string, string> = {
      after_created_at: afterCreatedAt,
    }
    // 若有分页游标，附加到请求参数中
    if (afterId) {
      params.after_id = afterId
    }

    // 带重试地获取当前页数据
    const page = await retryWithBackoff(
      `List files after ${afterCreatedAt}`,
      async () => {
        try {
          const response = await axios.get(`${baseUrl}/v1/files`, {
            headers,
            params,
            timeout: 60000,
            validateStatus: status => status < 500,
          })

          if (response.status === 200) {
            return { done: true, value: response.data }
          }

          // 鉴权失败，不可重试
          if (response.status === 401) {
            logEvent('tengu_file_list_failed', {
              error_type:
                'auth' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            throw new Error('Authentication failed: invalid or missing API key')
          }
          if (response.status === 403) {
            logEvent('tengu_file_list_failed', {
              error_type:
                'forbidden' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
            })
            throw new Error('Access denied to list files')
          }

          return { done: false, error: `status ${response.status}` }
        } catch (error) {
          if (!axios.isAxiosError(error)) {
            throw error // 非网络错误（即上面手动 throw 的）直接向上传播
          }
          // 记录网络错误并允许重试
          logEvent('tengu_file_list_failed', {
            error_type:
              'network' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          })
          return { done: false, error: error.message }
        }
      },
    )

    // 将当前页文件追加到结果集
    const files = page.data || []
    for (const f of files) {
      allFiles.push({
        filename: f.filename,
        fileId: f.id,
        size: f.size_bytes,
      })
    }

    // 若没有更多页面，退出循环
    if (!page.has_more) {
      break
    }

    // 以当前页最后一个文件的 ID 作为下一页游标
    const lastFile = files.at(-1)
    if (!lastFile?.id) {
      break // 无法获取游标，安全退出
    }
    afterId = lastFile.id
  }

  logDebug(`Listed ${allFiles.length} files created after ${afterCreatedAt}`)
  return allFiles
}

// ============================================================================
// 解析相关函数
// ============================================================================

/**
 * 从 CLI 参数字符串数组中解析文件描述符。
 * 格式：<file_id>:<relative_path>
 * 注意：sandbox-gateway 可能将多个描述符以空格分隔后作为单个字符串传入。
 *
 * @param fileSpecs  CLI 传入的文件描述符字符串数组
 * @returns          解析后的 File 对象数组
 */
export function parseFileSpecs(fileSpecs: string[]): File[] {
  const files: File[] = []

  // sandbox-gateway 可能将多个 spec 以空格连接成一个字符串，这里先展开
  const expandedSpecs = fileSpecs.flatMap(s => s.split(' ').filter(Boolean))

  for (const spec of expandedSpecs) {
    // 以第一个冒号为分隔符，左侧为文件 ID，右侧为路径
    const colonIndex = spec.indexOf(':')
    if (colonIndex === -1) {
      continue // 格式不合法，跳过
    }

    const fileId = spec.substring(0, colonIndex)
    const relativePath = spec.substring(colonIndex + 1)

    // 文件 ID 和路径均不能为空
    if (!fileId || !relativePath) {
      logDebugError(
        `Invalid file spec: ${spec}. Both file_id and path are required`,
      )
      continue
    }

    files.push({ fileId, relativePath })
  }

  return files
}
