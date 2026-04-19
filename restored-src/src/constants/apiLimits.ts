/**
 * Anthropic API 限制常量
 *
 * 本文件定义 Anthropic API 服务端强制执行的硬性限制常量。
 * 这些限制分为三大类：图片限制、PDF 限制和媒体总数限制。
 * Claude Code 在向 API 发送请求前会根据这些常量进行客户端预校验，
 * 以便在超限时提供清晰的错误信息，而不是让 API 返回晦涩的错误。
 *
 * 保持本文件无外部依赖，以防止循环导入。
 *
 * Last verified: 2025-12-22
 * Source: api/api/schemas/messages/blocks/ and api/api/config.py
 *
 * Future: See issue #13240 for dynamic limits fetching from server.
 */

// =============================================================================
// 图片限制
// =============================================================================

/**
 * API 允许的最大 base64 编码图片大小（API 服务端强制限制）。
 * API 会拒绝 base64 字符串长度超过此值的图片请求。
 * 注意：这是 base64 编码后的长度，不是原始字节数。Base64 编码会使大小增加约 33%。
 */
export const API_IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024 // 5 MB（base64 编码后）

/**
 * 目标原始图片大小上限，用于确保 base64 编码后不超过 API 限制。
 * Base64 编码将大小增加 4/3 倍，因此推导出最大原始大小：
 * raw_size * 4/3 = base64_size → raw_size = base64_size * 3/4
 * 客户端在上传图片前会将原始文件缩减至此大小以内。
 */
export const IMAGE_TARGET_RAW_SIZE = (API_IMAGE_MAX_BASE64_SIZE * 3) / 4 // 3.75 MB（原始字节）

/**
 * 客户端图片尺寸（宽高像素）调整上限。
 *
 * 说明：API 内部会将超过 1568px 的图片重新调整大小（参见 encoding/full_encoding.py），
 * 但该操作在服务端完成，不会导致客户端报错。
 * 这里的客户端限制（2000px）略大于服务端限制，以便在有益时保留更高画质。
 *
 * 真正会导致 API 错误的硬性限制是 API_IMAGE_MAX_BASE64_SIZE（5MB）。
 */
export const IMAGE_MAX_WIDTH = 2000  // 最大宽度（像素）
export const IMAGE_MAX_HEIGHT = 2000 // 最大高度（像素）

// =============================================================================
// PDF 限制
// =============================================================================

/**
 * PDF 原始文件大小的目标上限，确保 base64 编码后不超过 API 请求总大小限制。
 * API 的请求总大小上限为 32MB。Base64 编码增加约 33%（4/3 倍），
 * 因此 20MB 原始 → 约 27MB base64，留出会话上下文所需空间。
 */
export const PDF_TARGET_RAW_SIZE = 20 * 1024 * 1024 // 20 MB（原始字节）

/**
 * API 接受的 PDF 最大页数。
 */
export const API_PDF_MAX_PAGES = 100 // 最多 100 页

/**
 * PDF 大小超过此阈值时，改为提取为页面图片发送，而不是作为 base64 文档块发送。
 * 此规则仅适用于第一方 API；非第一方 API 始终使用提取方式。
 */
export const PDF_EXTRACT_SIZE_THRESHOLD = 3 * 1024 * 1024 // 3 MB，超过则转为图片提取

/**
 * 页面提取路径下的 PDF 最大文件大小。
 * 超过此大小的 PDF 将被拒绝，以避免处理超大文件。
 */
export const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024 // 100 MB，提取路径的绝对上限

/**
 * Read 工具单次调用时（使用 pages 参数）最多提取的页数。
 */
export const PDF_MAX_PAGES_PER_READ = 20 // 每次读取最多 20 页

/**
 * 页数超过此阈值的 PDF 在 @ 提及时不会内联到上下文，
 * 而是以引用方式处理，避免消耗过多上下文窗口空间。
 */
export const PDF_AT_MENTION_INLINE_THRESHOLD = 10 // 超过 10 页则改为引用方式

// =============================================================================
// 媒体总数限制
// =============================================================================

/**
 * 每个 API 请求中允许的最大媒体项数（图片 + PDF 合计）。
 * API 超出此限制时会返回令人困惑的错误信息。
 * 我们在客户端预先校验并提供清晰的错误提示。
 */
export const API_MAX_MEDIA_PER_REQUEST = 100 // 每次请求最多 100 个媒体项
