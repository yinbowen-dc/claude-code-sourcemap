/**
 * BriefTool/attachments.ts
 *
 * 【在 Claude Code 系统中的位置】
 * 本文件属于 BriefTool 工具模块，为 SendUserMessage 和 SendUserFile 工具
 * 提供共用的附件验证与解析逻辑。
 * 放置于 BriefTool/ 目录的原因：`./upload.js` 的动态 import 保持相对路径可解析，
 * 同时使 upload.ts（含 axios、crypto、auth 工具等重依赖）在非 BRIDGE_MODE 构建中
 * 能被 tree-shaking 完全消除。
 *
 * 【主要功能】
 * - ResolvedAttachment：解析后的附件数据类型（路径、大小、是否图像、可选 file_uuid）。
 * - validateAttachmentPaths：校验附件路径是否存在且为普通文件，返回 ValidationResult。
 * - resolveAttachments：串行 stat 获取附件元数据，并在 BRIDGE_MODE 下并行上传，
 *   返回含 file_uuid（若可用）的 ResolvedAttachment 数组。
 *
 * Shared attachment validation + resolution for SendUserMessage and
 * SendUserFile. Lives in BriefTool/ so the dynamic `./upload.js` import
 * inside the feature('BRIDGE_MODE') guard stays relative and upload.ts
 * (axios, crypto, auth utils) remains tree-shakeable from non-bridge builds.
 */

import { feature } from 'bun:bundle'
import { stat } from 'fs/promises'

import type { ValidationResult } from '../../Tool.js'

import { getCwd } from '../../utils/cwd.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getErrnoCode } from '../../utils/errors.js'
import { IMAGE_EXTENSION_REGEX } from '../../utils/imagePaste.js'
import { expandPath } from '../../utils/path.js'

export type ResolvedAttachment = {
  path: string
  size: number
  isImage: boolean
  file_uuid?: string
}

/**
 * validateAttachmentPaths
 *
 * 【函数作用】
 * 校验附件路径列表中的每个路径是否合法可用。
 * 对每个路径执行以下检查：
 *   1. 路径必须存在（ENOENT → 返回含当前 cwd 的错误消息，帮助调试相对路径问题）
 *   2. 必须为普通文件（非目录、非设备文件等）
 *   3. 必须可访问（EACCES/EPERM → 权限拒绝错误）
 * 首个不合法路径触发 errorCode=1 的 ValidationResult，全部通过则返回 { result: true }。
 *
 * @param rawPaths - 用户提供的原始路径列表（可含 ~ 等需展开的形式）
 */
export async function validateAttachmentPaths(
  rawPaths: string[],
): Promise<ValidationResult> {
  const cwd = getCwd()
  for (const rawPath of rawPaths) {
    const fullPath = expandPath(rawPath)
    try {
      const stats = await stat(fullPath)
      if (!stats.isFile()) {
        return {
          result: false,
          message: `Attachment "${rawPath}" is not a regular file.`,
          errorCode: 1,
        }
      }
    } catch (e) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        return {
          result: false,
          message: `Attachment "${rawPath}" does not exist. Current working directory: ${cwd}.`,
          errorCode: 1,
        }
      }
      if (code === 'EACCES' || code === 'EPERM') {
        return {
          result: false,
          message: `Attachment "${rawPath}" is not accessible (permission denied).`,
          errorCode: 1,
        }
      }
      throw e
    }
  }
  return { result: true }
}

/**
 * resolveAttachments
 *
 * 【函数作用】
 * 将原始路径列表解析为完整的 ResolvedAttachment 数组，并在 BRIDGE_MODE 下执行云端上传。
 *
 * 【执行流程】
 *   1. 串行 stat 各路径（本地操作，速度快），构建含 path/size/isImage 的基础结构；
 *      串行而非并行，以保证输出顺序确定性。
 *   2. 若 feature('BRIDGE_MODE') 为 true（仅在 bridge 构建中启用），则：
 *      a. 判断是否需要上传（replBridgeEnabled=true 或 CLAUDE_CODE_BRIEF_UPLOAD=true）
 *      b. 动态 import './upload.js'（tree-shaking 优化，非 bridge 构建不引入）
 *      c. Promise.all 并行上传（网络操作，速度慢）；上传失败 resolve undefined，
 *         附件仍保留本地元数据（供本地渲染器使用）
 *      d. 合并 file_uuid 到结果中
 *   3. 非 BRIDGE_MODE：直接返回本地元数据数组
 *
 * 【TOCTOU 说明】
 * validateInput 在调用此函数前已校验路径，但文件在校验后、stat 前可能被移动，
 * 若发生此情况，stat 错误将向上传播，让模型感知到问题。
 *
 * @param rawPaths - 用户提供的原始路径列表
 * @param uploadCtx - 上传上下文（replBridgeEnabled、AbortSignal）
 */
export async function resolveAttachments(
  rawPaths: string[],
  uploadCtx: { replBridgeEnabled: boolean; signal?: AbortSignal },
): Promise<ResolvedAttachment[]> {
  // Stat serially (local, fast) to keep ordering deterministic, then upload
  // in parallel (network, slow). Upload failures resolve undefined — the
  // attachment still carries {path, size, isImage} for local renderers.
  const stated: ResolvedAttachment[] = []
  for (const rawPath of rawPaths) {
    const fullPath = expandPath(rawPath)
    // Single stat — we need size, so this is the operation, not a guard.
    // validateInput ran before us, but the file could have moved since
    // (TOCTOU); if it did, let the error propagate so the model sees it.
    const stats = await stat(fullPath)
    stated.push({
      path: fullPath,
      size: stats.size,
      isImage: IMAGE_EXTENSION_REGEX.test(fullPath),
    })
  }
  // Dynamic import inside the feature() guard so upload.ts (axios, crypto,
  // zod, auth utils, MIME map) is fully eliminated from non-BRIDGE_MODE
  // builds. A static import would force module-scope evaluation regardless
  // of the guard inside uploadBriefAttachment — CLAUDE.md: "helpers defined
  // outside remain in the build even if never called".
  if (feature('BRIDGE_MODE')) {
    // Headless/SDK callers never set appState.replBridgeEnabled (only the TTY
    // REPL does, at main.tsx init). CLAUDE_CODE_BRIEF_UPLOAD lets a host that
    // runs the CLI as a subprocess opt in — e.g. the cowork desktop bridge,
    // which already passes CLAUDE_CODE_OAUTH_TOKEN for auth.
    const shouldUpload =
      uploadCtx.replBridgeEnabled ||
      isEnvTruthy(process.env.CLAUDE_CODE_BRIEF_UPLOAD)
    const { uploadBriefAttachment } = await import('./upload.js')
    const uuids = await Promise.all(
      stated.map(a =>
        uploadBriefAttachment(a.path, a.size, {
          replBridgeEnabled: shouldUpload,
          signal: uploadCtx.signal,
        }),
      ),
    )
    return stated.map((a, i) =>
      uuids[i] === undefined ? a : { ...a, file_uuid: uuids[i] },
    )
  }
  return stated
}
