/**
 * 编辑上下文读取模块 (readEditContext.ts)
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具调用层 → 文件编辑工具 → 【本模块：上下文定位器】 → 返回包含目标行的上下文片段
 *
 * 主要职责：
 *   1. 在文件中高效查找目标字符串（needle），返回其前后 contextLines 行的上下文窗口
 *   2. 以 8KB 为单位进行分块扫描，通过"跨块重叠"技术处理跨越块边界的匹配
 *   3. 支持 LF 和 CRLF 两种换行格式的匹配
 *   4. 为文件编辑工具的多编辑路径提供完整文件读取（readCapped）
 *
 * 与其他模块的关系：
 *   - 被 FileEditTool/FileEditToolDiff 等工具调用，为 AI 生成的编辑定位上下文
 *   - React 调用方可将结果包装为 useState 懒初始化 + Suspense 模式
 */

import { type FileHandle, open } from 'fs/promises'
import { isENOENT } from './errors.js'

// 每次从磁盘读取的块大小：8KB，兼顾内存占用与 I/O 次数
export const CHUNK_SIZE = 8 * 1024
// 扫描上限：超过 10MB 仍未找到目标则截断，避免大文件 OOM
export const MAX_SCAN_BYTES = 10 * 1024 * 1024
// ASCII 换行符字节值
const NL = 0x0a

// 编辑上下文的返回类型
export type EditContext = {
  /** 文件切片内容：匹配行前后各 contextLines 行，保持行边界对齐 */
  content: string
  /** content 第一行在原文件中的 1-based 行号 */
  lineOffset: number
  /** 若在 MAX_SCAN_BYTES 内未找到目标字符串则为 true */
  truncated: boolean
}

/**
 * 在 path 指向的文件中查找 needle，返回包含匹配内容及其前后各 contextLines 行的上下文切片。
 *
 * 算法流程：
 *   1. 打开文件句柄（openForScan），文件不存在时返回 null
 *   2. 委托 scanForContext 进行分块扫描与上下文提取
 *   3. finally 块确保句柄始终被关闭，防止文件描述符泄漏
 *
 * 性能策略：
 *   - 8KB 分块 + 重叠缓冲，避免一次性加载整个大文件
 *   - 上限 MAX_SCAN_BYTES（10MB），超限时返回 truncated:true
 *   - 不调用 stat，通过 bytesRead===0 检测 EOF
 *
 * React 使用建议：用 useState 懒初始化 + use() + Suspense 包装；
 * 避免在 useMemo 中传入新建数组字面量导致不必要的重新执行。
 *
 * @param path 要扫描的文件路径
 * @param needle 需要查找的目标字符串
 * @param contextLines 匹配行前后各保留的行数，默认为 3
 * @returns 编辑上下文，文件不存在返回 null，超限返回 truncated:true
 */
export async function readEditContext(
  path: string,
  needle: string,
  contextLines = 3,
): Promise<EditContext | null> {
  // 打开文件，ENOENT 时短路返回 null
  const handle = await openForScan(path)
  if (handle === null) return null
  try {
    // 核心扫描逻辑，句柄由本函数管理
    return await scanForContext(handle, needle, contextLines)
  } finally {
    // 无论成功还是异常，都必须关闭句柄
    await handle.close()
  }
}

/**
 * 以只读方式打开文件，文件不存在（ENOENT）时返回 null，其他错误向上抛出。
 * 调用方负责在使用完毕后调用 handle.close()。
 */
export async function openForScan(path: string): Promise<FileHandle | null> {
  try {
    return await open(path, 'r')
  } catch (e) {
    // ENOENT 不是错误，正常返回 null；其余错误（权限不足等）继续抛出
    if (isENOENT(e)) return null
    throw e
  }
}

/**
 * readEditContext 的核心实现（接受已打开的句柄）。
 * 调用方负责句柄的打开与关闭，便于在 multi-edit 路径中复用同一句柄。
 *
 * 分块扫描算法：
 *   1. 将 needle 编码为 UTF-8 Buffer（LF 版本），并计算跨块重叠长度
 *   2. 在循环中每次读取 CHUNK_SIZE 字节，与上一轮留存的 prevTail 前缀拼接
 *   3. 在当前视图中搜索 LF 版本；未命中且含换行时再尝试 CRLF 版本（延迟编码）
 *   4. 找到匹配后调用 sliceContext 提取上下文行并返回
 *   5. 未找到则将末尾 overlap 字节复制到缓冲区头部（跨块连续性），更新已跳过行数
 *
 * @param handle 已打开的文件句柄
 * @param needle 目标字符串（UTF-8）
 * @param contextLines 前后各保留的上下文行数
 */
export async function scanForContext(
  handle: FileHandle,
  needle: string,
  contextLines: number,
): Promise<EditContext> {
  // needle 为空字符串时直接返回空内容
  if (needle === '') return { content: '', lineOffset: 1, truncated: false }

  // 将 needle 编码为 LF 格式的 Buffer（模型输出使用 LF，文件可能是 CRLF）
  const needleLF = Buffer.from(needle, 'utf8')
  // 统计 needle 中换行符数量，用于计算 CRLF 版本的膨胀量
  // CRLF 版本延迟编码：只有当 LF 版本匹配失败且 needle 含换行时才创建
  let nlCount = 0
  for (let i = 0; i < needleLF.length; i++) if (needleLF[i] === NL) nlCount++
  let needleCRLF: Buffer | undefined
  // 重叠长度 = needle 字节长 + 换行数 - 1，保证跨块的 CRLF 版本不被截断
  const overlap = needleLF.length + nlCount - 1

  // 分配扫描缓冲区：块大小 + 重叠区域，避免每块重新分配
  const buf = Buffer.allocUnsafe(CHUNK_SIZE + overlap)
  let pos = 0              // 当前文件读取位置（字节偏移）
  let linesBeforePos = 0   // 已丢弃字节中的换行数（用于计算行号）
  let prevTail = 0         // 上一块末尾保留到缓冲区头部的字节数

  while (pos < MAX_SCAN_BYTES) {
    // 从 pos 读取 CHUNK_SIZE 字节，写入 buf[prevTail..] 以追加在上轮尾部之后
    const { bytesRead } = await handle.read(buf, prevTail, CHUNK_SIZE, pos)
    if (bytesRead === 0) break // EOF
    const viewLen = prevTail + bytesRead // 当前视图的有效字节长度

    // 在当前视图中搜索 LF 版本的 needle
    let matchAt = indexOfWithin(buf, needleLF, viewLen)
    let matchLen = needleLF.length
    // LF 版本未命中且 needle 含换行 → 尝试 CRLF 版本（延迟编码，只编码一次）
    if (matchAt === -1 && nlCount > 0) {
      needleCRLF ??= Buffer.from(needle.replaceAll('\n', '\r\n'), 'utf8')
      matchAt = indexOfWithin(buf, needleCRLF, viewLen)
      matchLen = needleCRLF.length
    }
    if (matchAt !== -1) {
      // 将视图内偏移转换为文件绝对偏移
      const absMatch = pos - prevTail + matchAt
      // 提取前后 contextLines 行的上下文切片
      return await sliceContext(
        handle,
        buf,
        absMatch,
        matchLen,
        contextLines,
        linesBeforePos + countNewlines(buf, 0, matchAt),
      )
    }

    pos += bytesRead
    // 跨块连续性：将当前视图末尾 overlap 字节复制到缓冲区头部
    // linesBeforePos 只累加即将被覆盖（丢弃）部分的换行数，不含重叠区
    const nextTail = Math.min(overlap, viewLen)
    linesBeforePos += countNewlines(buf, 0, viewLen - nextTail)
    prevTail = nextTail
    buf.copyWithin(0, viewLen - prevTail, viewLen)
  }

  // 遍历完 MAX_SCAN_BYTES 仍未找到：返回截断标记
  return { content: '', lineOffset: 1, truncated: pos >= MAX_SCAN_BYTES }
}

/**
 * 通过句柄读取整个文件内容（最多 MAX_SCAN_BYTES）。
 * 超过上限时返回 null。
 *
 * 用于 FileEditToolDiff 的多编辑路径（sequential replacements 需要完整字符串）。
 *
 * 内存优化策略：
 *   - 单缓冲区，满时翻倍扩容（~log₂(size/8KB) 次分配，而非 O(n) 块合并）
 *   - 直接写入正确偏移，无中间拷贝
 */
export async function readCapped(handle: FileHandle): Promise<string | null> {
  let buf = Buffer.allocUnsafe(CHUNK_SIZE)
  let total = 0
  for (;;) {
    // 缓冲区已满时翻倍扩容，但不超过 MAX_SCAN_BYTES + CHUNK_SIZE
    if (total === buf.length) {
      const grown = Buffer.allocUnsafe(
        Math.min(buf.length * 2, MAX_SCAN_BYTES + CHUNK_SIZE),
      )
      buf.copy(grown, 0, 0, total) // 将旧数据复制到新缓冲区
      buf = grown
    }
    // 从当前偏移继续读取，填满剩余空间
    const { bytesRead } = await handle.read(
      buf,
      total,
      buf.length - total,
      total,
    )
    if (bytesRead === 0) break // EOF
    total += bytesRead
    // 超过上限：拒绝返回，避免 OOM
    if (total > MAX_SCAN_BYTES) return null
  }
  // 解码并统一换行符
  return normalizeCRLF(buf, total)
}

/**
 * 在 buf[0..end) 范围内搜索 needle，不分配新的子视图 Buffer。
 * 若找到但匹配末尾超出 end 则视为未命中（跨块的不完整匹配）。
 */
function indexOfWithin(buf: Buffer, needle: Buffer, end: number): number {
  const at = buf.indexOf(needle)
  // 匹配必须完全落在 [0, end) 范围内
  return at === -1 || at + needle.length > end ? -1 : at
}

/**
 * 统计 buf[start..end) 范围内的换行符（0x0A）数量。
 * 用于追踪已扫描字节对应的行号偏移。
 */
function countNewlines(buf: Buffer, start: number, end: number): number {
  let n = 0
  for (let i = start; i < end; i++) if (buf[i] === NL) n++
  return n
}

/**
 * 将 buf[0..len) 解码为 UTF-8 字符串，仅在包含 CR 时才进行 CRLF → LF 的统一化。
 * 避免在纯 LF 文件上执行无意义的 replaceAll，保持性能。
 */
function normalizeCRLF(buf: Buffer, len: number): string {
  const s = buf.toString('utf8', 0, len)
  return s.includes('\r') ? s.replaceAll('\r\n', '\n') : s
}

/**
 * 给定匹配的绝对文件偏移，向前/向后各扫描 contextLines 行，
 * 返回解码后的上下文切片及其起始行号。
 *
 * 内存优化：复用调用方的 scratch 缓冲区进行前向/后向读取和最终输出读取，
 * 仅当上下文长度超过缓冲区大小时才分配新 Buffer（通常不会）。
 *
 * @param handle     文件句柄（复用）
 * @param scratch    调用方的扫描缓冲区（用于临时读取）
 * @param matchStart 匹配起始位置的文件绝对偏移
 * @param matchLen   匹配内容的字节长度
 * @param contextLines 前后各保留的行数
 * @param linesBeforeMatch matchStart 之前文件中的总换行数
 */
async function sliceContext(
  handle: FileHandle,
  scratch: Buffer,
  matchStart: number,
  matchLen: number,
  contextLines: number,
  linesBeforeMatch: number,
): Promise<EditContext> {
  // === 向后扫描：找到 matchStart 之前 contextLines 个换行符的位置 ===
  const backChunk = Math.min(matchStart, CHUNK_SIZE)
  const { bytesRead: backRead } = await handle.read(
    scratch,
    0,
    backChunk,
    matchStart - backChunk, // 从 matchStart 前最多 CHUNK_SIZE 字节处开始读
  )
  let ctxStart = matchStart
  let nlSeen = 0
  // 从后向前扫描，累计换行数，直到找到第 contextLines 个换行
  for (let i = backRead - 1; i >= 0 && nlSeen <= contextLines; i--) {
    if (scratch[i] === NL) {
      nlSeen++
      if (nlSeen > contextLines) break // 已超过所需行数，停止
    }
    ctxStart-- // 上下文起始位置向前移动
  }
  // 在 scratch 被后续读取覆盖前计算 lineOffset
  const walkedBack = matchStart - ctxStart
  const lineOffset =
    linesBeforeMatch -
    countNewlines(scratch, backRead - walkedBack, backRead) +
    1 // 1-based 行号

  // === 向前扫描：找到 matchEnd 之后 contextLines 个换行符的位置 ===
  const matchEnd = matchStart + matchLen
  const { bytesRead: fwdRead } = await handle.read(
    scratch,
    0,
    CHUNK_SIZE,
    matchEnd, // 从匹配结束位置开始向后读
  )
  let ctxEnd = matchEnd
  nlSeen = 0
  for (let i = 0; i < fwdRead; i++) {
    ctxEnd++
    if (scratch[i] === NL) {
      nlSeen++
      // 需要 contextLines+1 个换行（包含最后一行的结尾换行）
      if (nlSeen >= contextLines + 1) break
    }
  }

  // === 读取最终上下文范围并解码 ===
  const len = ctxEnd - ctxStart
  // 若上下文长度不超过 scratch 大小则复用，否则按需分配（避免额外 alloc）
  const out = len <= scratch.length ? scratch : Buffer.allocUnsafe(len)
  const { bytesRead: outRead } = await handle.read(out, 0, len, ctxStart)

  return { content: normalizeCRLF(out, outRead), lineOffset, truncated: false }
}
