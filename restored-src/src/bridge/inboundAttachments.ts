/**
 * inboundAttachments.ts — 解析 Bridge 入站用户消息中的文件附件
 *
 * 在 Claude Code 系统流程中的位置：
 *   Bridge 消息处理层（bridgeMain.ts / replBridge.ts）
 *     └─> 消息解析阶段
 *           └─> inboundAttachments.ts（本文件）——将 web 端附件下载到本地，生成 @path 引用
 *
 * 背景：
 *   用户在 claude.ai Web Composer 上传文件时，后端通过 cookie 认证的
 *   /api/{org}/upload 接口存储文件，并将 file_uuid 附在消息中发送到 Bridge。
 *   本文件负责将这些 file_uuid 通过 OAuth 认证的
 *   GET /api/oauth/files/{uuid}/content 接口下载，写入本地
 *   ~/.claude/uploads/{sessionId}/ 目录，并生成 @path 引用供 Claude Read 工具读取。
 *
 * 设计原则（Best-effort）：
 *   任何失败（无 token、网络错误、非 2xx 响应、磁盘写入失败）均只记录调试日志并跳过该附件。
 *   消息仍正常传递给 Claude，只是缺少对应的 @path 引用。
 *
 * Resolve file_uuid attachments on inbound bridge user messages.
 *
 * Web composer uploads via cookie-authed /api/{org}/upload, sends file_uuid
 * alongside the message. Here we fetch each via GET /api/oauth/files/{uuid}/content
 * (oauth-authed, same store), write to ~/.claude/uploads/{sessionId}/, and
 * return @path refs to prepend. Claude's Read tool takes it from there.
 *
 * Best-effort: any failure (no token, network, non-2xx, disk) logs debug and
 * skips that attachment. The message still reaches Claude, just without @path.
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import axios from 'axios'
import { randomUUID } from 'crypto'
import { mkdir, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { z } from 'zod/v4'
import { getSessionId } from '../bootstrap/state.js'
import { logForDebugging } from '../utils/debug.js'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { lazySchema } from '../utils/lazySchema.js'
import { getBridgeAccessToken, getBridgeBaseUrl } from './bridgeConfig.js'

/** 附件下载的最大超时时间（30 秒） */
const DOWNLOAD_TIMEOUT_MS = 30_000

/** 调试日志前缀标识器 */
function debug(msg: string): void {
  logForDebugging(`[bridge:inbound-attach] ${msg}`)
}

/** 单个附件对象的 Zod Schema（懒加载，避免启动时过早初始化） */
const attachmentSchema = lazySchema(() =>
  z.object({
    file_uuid: z.string(),   // 附件在云端存储的唯一标识符
    file_name: z.string(),   // 原始文件名（来自网络，需要脱敏处理）
  }),
)
/** 附件数组的 Zod Schema（懒加载） */
const attachmentsArraySchema = lazySchema(() => z.array(attachmentSchema()))

/** 入站附件的 TypeScript 类型（由 Zod Schema 推导） */
export type InboundAttachment = z.infer<ReturnType<typeof attachmentSchema>>

/**
 * 从松散类型的入站消息中提取 file_attachments 数组。
 *
 * 使用 Zod Schema 安全解析 msg.file_attachments 字段：
 * - 消息无 file_attachments 字段 → 返回空数组（快速路径）
 * - 解析失败（格式不符） → 返回空数组（容错）
 */
export function extractInboundAttachments(msg: unknown): InboundAttachment[] {
  if (typeof msg !== 'object' || msg === null || !('file_attachments' in msg)) {
    return []
  }
  const parsed = attachmentsArraySchema().safeParse(msg.file_attachments)
  return parsed.success ? parsed.data : []
}

/**
 * 净化文件名，移除路径分隔符，仅保留文件名安全字符。
 *
 * file_name 来源于网络（web composer），视为不可信输入：
 * - basename() 剥离路径前缀（防止路径穿越攻击）
 * - 非 [a-zA-Z0-9._-] 字符替换为 '_'
 * - 空结果降级为 'attachment'
 *
 * Strip path components and keep only filename-safe chars. file_name comes
 * from the network (web composer), so treat it as untrusted even though the
 * composer controls it.
 */
function sanitizeFileName(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_') // 替换不安全字符
  return base || 'attachment' // 空名降级为 'attachment'
}

/** 返回当前会话的本地附件上传目录（~/.claude/uploads/{sessionId}/） */
function uploadsDir(): string {
  return join(getClaudeConfigHomeDir(), 'uploads', getSessionId())
}

/**
 * 下载单个附件文件并写入本地，返回绝对路径。
 *
 * 流程：
 *   1. 获取 OAuth 访问令牌（无令牌则跳过）
 *   2. 构造下载 URL（getBridgeBaseUrl 可能因非白名单 URL 抛出异常，在 try 内调用以降级处理）
 *   3. GET /api/oauth/files/{uuid}/content（响应格式：arraybuffer）
 *   4. 净化文件名，添加 uuid 前缀避免同名冲突
 *   5. 确保目录存在，写入文件
 *
 * 任何步骤失败均返回 undefined（best-effort 策略）。
 *
 * Fetch + write one attachment. Returns the absolute path on success,
 * undefined on any failure.
 */
async function resolveOne(att: InboundAttachment): Promise<string | undefined> {
  const token = getBridgeAccessToken()
  if (!token) {
    debug('skip: no oauth token') // 无 OAuth 令牌，跳过此附件
    return undefined
  }

  let data: Buffer
  try {
    // getBridgeBaseUrl() 对非白名单的 CLAUDE_CODE_CUSTOM_OAUTH_URL 会抛出异常，
    // 放在 try 内确保异常降级为"无 @path"而非崩溃 print.ts 的读取循环（该循环无 catch）
    const url = `${getBridgeBaseUrl()}/api/oauth/files/${encodeURIComponent(att.file_uuid)}/content`
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }, // OAuth Bearer 认证
      responseType: 'arraybuffer', // 以二进制缓冲区接收文件内容
      timeout: DOWNLOAD_TIMEOUT_MS,
      validateStatus: () => true, // 所有状态码均不抛出 axios 异常，由后续检查处理
    })
    if (response.status !== 200) {
      debug(`fetch ${att.file_uuid} failed: status=${response.status}`) // 非 200 响应，跳过
      return undefined
    }
    data = Buffer.from(response.data) // 将 arraybuffer 转为 Node.js Buffer
  } catch (e) {
    debug(`fetch ${att.file_uuid} threw: ${e}`) // 网络异常或 URL 构造失败
    return undefined
  }

  // UUID 前缀防止同一消息内多个同名文件冲突，也防止跨消息冲突
  // 8 个字符已足够（这里不涉及安全性要求）
  const safeName = sanitizeFileName(att.file_name)
  const prefix = (
    att.file_uuid.slice(0, 8) || randomUUID().slice(0, 8) // file_uuid 空时回退为随机 UUID 前 8 位
  ).replace(/[^a-zA-Z0-9_-]/g, '_') // 替换前缀中的非安全字符
  const dir = uploadsDir()
  const outPath = join(dir, `${prefix}-${safeName}`) // 最终路径：{dir}/{prefix}-{safeName}

  try {
    await mkdir(dir, { recursive: true }) // 递归创建目录（已存在时不报错）
    await writeFile(outPath, data) // 写入文件内容
  } catch (e) {
    debug(`write ${outPath} failed: ${e}`) // 磁盘写入失败
    return undefined
  }

  debug(`resolved ${att.file_uuid} → ${outPath} (${data.length} bytes)`) // 记录成功路径
  return outPath
}

/**
 * 并发解析所有附件，返回 @path 引用前缀字符串。
 *
 * 所有附件并发下载（Promise.all），成功的路径拼接为带引号的 @path 形式：
 *   @"/absolute/path/to/file" （引号防止路径中的空格截断引用）
 * 尾部附加空格作为与消息正文的分隔符。
 * 没有成功解析的附件时返回空字符串。
 *
 * Resolve all attachments on an inbound message to a prefix string of
 * @path refs. Empty string if none resolved.
 */
export async function resolveInboundAttachments(
  attachments: InboundAttachment[],
): Promise<string> {
  if (attachments.length === 0) return ''
  debug(`resolving ${attachments.length} attachment(s)`)
  const paths = await Promise.all(attachments.map(resolveOne)) // 并发下载所有附件
  const ok = paths.filter((p): p is string => p !== undefined) // 过滤失败项
  if (ok.length === 0) return ''
  // 使用带引号的 @"path" 格式——extractAtMentionedFiles 对不带引号的引用
  // 在第一个空格处截断，导致包含空格的路径（如 /Users/John Smith/）无法解析
  return ok.map(p => `@"${p}"`).join(' ') + ' '
}

/**
 * 将 @path 引用前缀插入消息内容的最后一个文本块中。
 *
 * 注意：必须插入「最后一个文本块」而非第一个：
 *   processUserInputBase 从 processedBlocks[processedBlocks.length - 1] 读取 inputString，
 *   若放在 block[0]（如 [text, image] 内容中），@path 引用会被静默忽略。
 *
 * 三种内容形态处理：
 *   - string：直接前缀拼接
 *   - ContentBlockParam[]（有文本块）：找到最后一个 text 块，在其 text 前插入前缀
 *   - ContentBlockParam[]（无文本块）：追加新的 text 块（确保位于末尾）
 *
 * Prepend @path refs to content, whichever form it's in.
 * Targets the LAST text block — processUserInputBase reads inputString
 * from processedBlocks[processedBlocks.length - 1], so putting refs in
 * block[0] means they're silently ignored for [text, image] content.
 */
export function prependPathRefs(
  content: string | Array<ContentBlockParam>,
  prefix: string,
): string | Array<ContentBlockParam> {
  if (!prefix) return content // 无前缀则直接返回原内容（快速路径）
  if (typeof content === 'string') return prefix + content // 字符串形式直接前缀拼接
  const i = content.findLastIndex(b => b.type === 'text') // 找最后一个 text 块的索引
  if (i !== -1) {
    const b = content[i]!
    if (b.type === 'text') {
      return [
        ...content.slice(0, i),
        { ...b, text: prefix + b.text }, // 在最后一个 text 块前插入 @path 前缀
        ...content.slice(i + 1),
      ]
    }
  }
  // 无文本块——追加新文本块（位于末尾，确保被 processUserInputBase 读取）
  return [...content, { type: 'text', text: prefix.trimEnd() }]
}

/**
 * 便捷入口：提取附件 → 解析下载 → 插入 @path 引用，一步完成。
 *
 * 消息没有 file_attachments 字段时快速返回（不发起任何网络请求，返回原 content 引用）。
 * 有附件时：
 *   1. extractInboundAttachments：从消息提取附件列表
 *   2. resolveInboundAttachments：并发下载并生成 @path 前缀
 *   3. prependPathRefs：将前缀插入消息内容最后一个文本块
 *
 * Convenience: extract + resolve + prepend. No-op when the message has no
 * file_attachments field (fast path — no network, returns same reference).
 */
export async function resolveAndPrepend(
  msg: unknown,
  content: string | Array<ContentBlockParam>,
): Promise<string | Array<ContentBlockParam>> {
  const attachments = extractInboundAttachments(msg) // 提取附件列表
  if (attachments.length === 0) return content // 无附件，快速返回
  const prefix = await resolveInboundAttachments(attachments) // 下载并生成 @path 前缀
  return prependPathRefs(content, prefix) // 插入前缀到内容
}
