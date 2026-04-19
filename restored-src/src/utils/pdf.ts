/**
 * 【文件定位】PDF 文件读取与渲染模块 — Claude Code 文件处理层的 PDF 支持组件
 *
 * 在 Claude Code 的系统架构中，本文件处于\"工具结果处理\"环节：
 *   ReadFileTool / 文件拖入 → [本模块：读取/渲染 PDF] → API 消息构建 → Anthropic API
 *
 * 主要职责：
 *   1. readPDF：验证 PDF 文件合法性（大小、魔术字节），将文件内容转为 base64 供 API 直接发送
 *   2. extractPDFPages：调用 pdftoppm（poppler-utils）将 PDF 页面渲染为 JPEG 图像，
 *      适用于大文件或 API 不原生支持 PDF 的场景
 *   3. getPDFPageCount：使用 pdfinfo 获取 PDF 总页数
 *   4. isPdftoppmAvailable：检测 pdftoppm 是否可用（结果缓存，进程级有效）
 *   5. resetPdftoppmCache：测试用缓存清除接口
 *
 * 错误处理：
 *   所有函数返回 PDFResult<T> 判别联合类型（{ success: true; data: T } | { success: false; error: PDFError }）
 *   error.reason 区分：empty、too_large、password_protected、corrupted、unknown、unavailable
 *
 * 关键限制：
 *   - readPDF：文件大小不超过 PDF_TARGET_RAW_SIZE（约 20MB，base64 后约 27MB，留出 API 上下文空间）
 *   - extractPDFPages：文件大小不超过 PDF_MAX_EXTRACT_SIZE
 *   - readPDF：必须以 %PDF- 魔术字节开头（防止伪装 PDF 进入对话历史后导致不可恢复的 400 错误）
 */

import { randomUUID } from 'crypto'
import { mkdir, readdir, readFile } from 'fs/promises'
import { join } from 'path'
import {
  PDF_MAX_EXTRACT_SIZE,
  PDF_TARGET_RAW_SIZE,
} from '../constants/apiLimits.js'
import { errorMessage } from './errors.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { formatFileSize } from './format.js'
import { getFsImplementation } from './fsOperations.js'
import { getToolResultsDir } from './toolResultStorage.js'

/**
 * PDF 处理错误的结构化描述
 * reason 字段用于上层根据错误类型展示不同的用户提示
 */
export type PDFError = {
  reason:
    | 'empty'              // 文件为空（0 字节）
    | 'too_large'          // 超过允许的最大文件大小
    | 'password_protected' // PDF 有密码保护
    | 'corrupted'          // 文件损坏或非有效 PDF
    | 'unknown'            // 未知错误（含原始错误信息）
    | 'unavailable'        // 所需外部工具（如 pdftoppm）不可用
  message: string
}

/**
 * PDF 操作结果的判别联合类型
 * 成功时包含 data，失败时包含结构化 error，强制调用方显式处理两种情况
 */
export type PDFResult<T> =
  | { success: true; data: T }
  | { success: false; error: PDFError }

/**
 * 读取 PDF 文件并返回 base64 编码数据（供 API 直接使用的原生 PDF 模式）。
 *
 * 流程：
 *   1. stat 获取文件大小，检查空文件和超大文件
 *   2. 读取文件内容，验证 %PDF- 魔术字节（防止非 PDF 文件误入对话历史）
 *   3. 转换为 base64 字符串，包装为结构化返回值
 *
 * 魔术字节验证的重要性：
 *   一旦无效 PDF 进入消息历史，每次后续 API 调用都会返回 400 错误，
 *   会话将无法继续（需要 /clear 才能恢复），因此必须在此处提前拦截。
 *
 * @param filePath - PDF 文件路径
 * @returns PDFResult，成功时包含 type:'pdf'、base64 数据和原始大小
 */
export async function readPDF(filePath: string): Promise<
  PDFResult<{
    type: 'pdf'
    file: {
      filePath: string
      base64: string
      originalSize: number
    }
  }>
> {
  try {
    const fs = getFsImplementation()
    const stats = await fs.stat(filePath)
    const originalSize = stats.size

    // 空文件检查
    if (originalSize === 0) {
      return {
        success: false,
        error: { reason: 'empty', message: `PDF file is empty: ${filePath}` },
      }
    }

    // 大文件检查：API 总请求限制约 32MB，base64 编码后约增大 33%
    // PDF 需控制在约 20MB 以下，为对话上下文留出空间
    if (originalSize > PDF_TARGET_RAW_SIZE) {
      return {
        success: false,
        error: {
          reason: 'too_large',
          message: `PDF file exceeds maximum allowed size of ${formatFileSize(PDF_TARGET_RAW_SIZE)}.`,
        },
      }
    }

    const fileBuffer = await readFile(filePath)

    // 验证 PDF 魔术字节：合法 PDF 文件必须以 '%PDF-' 开头
    // 拒绝 HTML、文本等被错误命名为 .pdf 的文件进入对话历史
    const header = fileBuffer.subarray(0, 5).toString('ascii')
    if (!header.startsWith('%PDF-')) {
      return {
        success: false,
        error: {
          reason: 'corrupted',
          message: `File is not a valid PDF (missing %PDF- header): ${filePath}`,
        },
      }
    }

    // 转换为 base64（API 要求的格式）
    const base64 = fileBuffer.toString('base64')

    // 注意：无法在此处检测页数，需要解析 PDF 结构
    // API 会在超过 100 页时返回错误

    return {
      success: true,
      data: {
        type: 'pdf',
        file: {
          filePath,
          base64,
          originalSize,
        },
      },
    }
  } catch (e: unknown) {
    return {
      success: false,
      error: {
        reason: 'unknown',
        message: errorMessage(e),
      },
    }
  }
}

/**
 * 使用 pdfinfo（poppler-utils 组件）获取 PDF 文件的总页数。
 *
 * pdfinfo 输出格式中包含 "Pages: N" 行，本函数使用正则提取该数值。
 * 若 pdfinfo 不可用或输出不包含页数信息，返回 null（调用方降级处理）。
 *
 * @param filePath - PDF 文件路径
 * @returns 总页数，或 null（无法获取时）
 */
export async function getPDFPageCount(
  filePath: string,
): Promise<number | null> {
  const { code, stdout } = await execFileNoThrow('pdfinfo', [filePath], {
    timeout: 10_000,
    useCwd: false,
  })
  if (code !== 0) {
    return null
  }
  // 匹配 "Pages:  N" 格式（支持多个空格）
  const match = /^Pages:\s+(\d+)/m.exec(stdout)
  if (!match) {
    return null
  }
  const count = parseInt(match[1]!, 10)
  return isNaN(count) ? null : count
}

/**
 * pdftoppm 渲染结果的数据结构
 * type: 'parts' 与 readPDF 的 type: 'pdf' 区分，供调用方识别数据类型
 */
export type PDFExtractPagesResult = {
  type: 'parts'
  file: {
    filePath: string    // 原始 PDF 路径
    originalSize: number // 原始文件大小
    count: number       // 成功渲染的页数
    outputDir: string   // 渲染图像的输出目录
  }
}

// pdftoppm 可用性缓存变量（undefined = 未检测，true/false = 已检测结果）
let pdftoppmAvailable: boolean | undefined

/**
 * 重置 pdftoppm 可用性缓存（仅供测试使用）。
 * 在测试环境中需要在不同用例间切换 pdftoppm 的可用状态时调用。
 */
export function resetPdftoppmCache(): void {
  pdftoppmAvailable = undefined
}

/**
 * 检测 pdftoppm（poppler-utils 组件）是否可用（结果缓存，进程级有效）。
 *
 * 检测方式：运行 pdftoppm -v 并检查退出码和 stderr 输出。
 * pdftoppm 的特殊性：版本信息输出到 stderr，退出码在不同版本可能为 0 或 99，
 * 因此只要 stderr 有输出就认为该工具可用。
 *
 * @returns pdftoppm 可用返回 true
 */
export async function isPdftoppmAvailable(): Promise<boolean> {
  // 命中缓存直接返回（避免重复子进程调用）
  if (pdftoppmAvailable !== undefined) return pdftoppmAvailable
  const { code, stderr } = await execFileNoThrow('pdftoppm', ['-v'], {
    timeout: 5000,
    useCwd: false,
  })
  // 退出码为 0 或 stderr 有输出（包含版本信息）均视为可用
  pdftoppmAvailable = code === 0 || stderr.length > 0
  return pdftoppmAvailable
}

/**
 * 使用 pdftoppm 将 PDF 页面渲染为 JPEG 图像（适用于大文件或 API 不原生支持 PDF 的场景）。
 *
 * 适用场景：
 *   - 文件超过 API 直接传输的大小限制（readPDF 无法使用）
 *   - claude-3-haiku 等早期模型不支持原生 PDF 格式
 *   - 需要精确控制页面范围的场景
 *
 * 流程：
 *   1. 检查文件大小（空文件、超大文件）
 *   2. 检查 pdftoppm 是否可用
 *   3. 创建唯一输出目录（UUID 命名，避免并发冲突）
 *   4. 执行 pdftoppm 渲染：-jpeg（JPEG 格式）-r 100（100 DPI 分辨率）
 *      可选 -f/-l 参数控制页面范围
 *   5. 根据 stderr 内容判断错误类型（password、damaged/corrupt/invalid）
 *   6. 统计实际生成的图像文件数量
 *
 * @param filePath - PDF 文件路径
 * @param options - 可选的页面范围（firstPage/lastPage，1-indexed）
 * @returns PDFResult，成功时包含输出目录路径和图像数量
 */
export async function extractPDFPages(
  filePath: string,
  options?: { firstPage?: number; lastPage?: number },
): Promise<PDFResult<PDFExtractPagesResult>> {
  try {
    const fs = getFsImplementation()
    const stats = await fs.stat(filePath)
    const originalSize = stats.size

    // 空文件检查
    if (originalSize === 0) {
      return {
        success: false,
        error: { reason: 'empty', message: `PDF file is empty: ${filePath}` },
      }
    }

    // 渲染模式有专用的大小限制（可能比直接传输限制更大）
    if (originalSize > PDF_MAX_EXTRACT_SIZE) {
      return {
        success: false,
        error: {
          reason: 'too_large',
          message: `PDF file exceeds maximum allowed size for text extraction (${formatFileSize(PDF_MAX_EXTRACT_SIZE)}).`,
        },
      }
    }

    // 检查渲染工具是否可用
    const available = await isPdftoppmAvailable()
    if (!available) {
      return {
        success: false,
        error: {
          reason: 'unavailable',
          message:
            'pdftoppm is not installed. Install poppler-utils (e.g. `brew install poppler` or `apt-get install poppler-utils`) to enable PDF page rendering.',
        },
      }
    }

    // 使用 UUID 创建唯一输出目录，防止并发渲染任务之间互相干扰
    const uuid = randomUUID()
    const outputDir = join(getToolResultsDir(), `pdf-${uuid}`)
    await mkdir(outputDir, { recursive: true })

    // pdftoppm 产生的文件格式：<prefix>-01.jpg、<prefix>-02.jpg 等
    const prefix = join(outputDir, 'page')
    const args = [
      '-jpeg',     // 输出 JPEG 格式（比 PPM 更紧凑）
      '-r', '100', // 100 DPI 分辨率（在清晰度和文件大小之间取平衡）
    ]
    // 可选：添加页面范围参数（1-indexed）
    if (options?.firstPage) {
      args.push('-f', String(options.firstPage))
    }
    if (options?.lastPage && options.lastPage !== Infinity) {
      args.push('-l', String(options.lastPage))
    }
    args.push(filePath, prefix)
    const { code, stderr } = await execFileNoThrow('pdftoppm', args, {
      timeout: 120_000, // 大型 PDF 渲染可能需要较长时间，设置 2 分钟超时
      useCwd: false,
    })

    if (code !== 0) {
      // 根据 stderr 中的关键词判断具体错误类型
      if (/password/i.test(stderr)) {
        return {
          success: false,
          error: {
            reason: 'password_protected',
            message:
              'PDF is password-protected. Please provide an unprotected version.',
          },
        }
      }
      if (/damaged|corrupt|invalid/i.test(stderr)) {
        return {
          success: false,
          error: {
            reason: 'corrupted',
            message: 'PDF file is corrupted or invalid.',
          },
        }
      }
      // 其他未知错误，包含原始 stderr 信息供用户排查
      return {
        success: false,
        error: { reason: 'unknown', message: `pdftoppm failed: ${stderr}` },
      }
    }

    // 读取输出目录中的 JPEG 文件并自然排序（确保页面顺序正确）
    const entries = await readdir(outputDir)
    const imageFiles = entries.filter(f => f.endsWith('.jpg')).sort()
    const pageCount = imageFiles.length

    // 渲染成功但无输出文件 → PDF 本身可能有问题
    if (pageCount === 0) {
      return {
        success: false,
        error: {
          reason: 'corrupted',
          message: 'pdftoppm produced no output pages. The PDF may be invalid.',
        },
      }
    }

    const count = imageFiles.length

    return {
      success: true,
      data: {
        type: 'parts',
        file: {
          filePath,
          originalSize,
          outputDir,
          count,
        },
      },
    }
  } catch (e: unknown) {
    return {
      success: false,
      error: {
        reason: 'unknown',
        message: errorMessage(e),
      },
    }
  }
}
