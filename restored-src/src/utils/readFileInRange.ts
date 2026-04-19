// ---------------------------------------------------------------------------
// readFileInRange — 面向行范围的文件读取模块（双路径实现）
// ---------------------------------------------------------------------------
//
// 【在系统流程中的位置】
// 本模块是 FileReadTool（文件读取工具）的底层 I/O 引擎：
//   FileReadTool 接收 AI 的读文件请求
//     → readFileInRange() 按 [offset, offset+maxLines) 行范围读取文件
//     → 将结果（content、行数统计、字节统计、mtime）返回给工具层
//
// 【双路径设计】
//
// 快速路径（适用于 < 10 MB 的普通文件）：
//   打开文件 → fstat 确认大小 → readFile 一次性读入内存 → 字符串 split 切行
//   省去 createReadStream 的逐块异步开销，对典型源码文件约快 2×。
//
// 流式路径（适用于大文件 / 管道 / 设备等）：
//   createReadStream + 手动 indexOf('\n') 逐块扫描。
//   只为目标行范围内的内容分配内存，范围外的行仅计数后丢弃，
//   避免读取 100GB 单行文件时 RSS 爆炸。
//   所有事件处理函数（streamOnOpen/Data/End）提升为模块级命名函数，
//   通过 bind(state) 绑定 StreamState 对象，零闭包捕获。
//
// 【共同处理】
//   两条路径均会剥离 UTF-8 BOM 和 \r（CRLF → LF）。
//   mtime 来自已打开 fd 的 fstat，无需额外 open()。
//
// 【maxBytes 行为（由 truncateOnByteLimit 控制）】
//   false（默认）：传统语义——若文件大小（快速路径）或累计流字节数
//                  （流式路径）超出 maxBytes，抛出 FileTooLargeError。
//   true：截断模式——将已选输出限制在 maxBytes 以内，在最后一个完整行处截止；
//         在结果中设置 truncatedByBytes 字段，永不抛异常。
// ---------------------------------------------------------------------------

import { createReadStream, fstat } from 'fs'
import { stat as fsStat, readFile } from 'fs/promises'
import { formatFileSize } from './format.js'

// 快速路径的文件大小上限：10 MB，超出此值改走流式路径
const FAST_PATH_MAX_SIZE = 10 * 1024 * 1024 // 10 MB

// 读取结果的完整结构
export type ReadFileRangeResult = {
  content: string        // 所选行的拼接文本（\n 分隔）
  lineCount: number      // 实际返回的行数
  totalLines: number     // 文件总行数
  totalBytes: number     // 文件总字节数（UTF-8 编码）
  readBytes: number      // content 的字节数（UTF-8 编码）
  mtimeMs: number        // 文件最后修改时间（Unix 毫秒）
  /** 在截断模式下，若输出因字节上限被截断则为 true */
  truncatedByBytes?: boolean
}

/**
 * 文件过大错误：文件超出 maxBytes 时（非截断模式下）抛出。
 * 错误信息引导用户使用 offset/limit 参数或内容搜索代替全量读取。
 */
export class FileTooLargeError extends Error {
  constructor(
    public sizeInBytes: number,    // 实际文件大小（字节）
    public maxSizeBytes: number,   // 配置的上限（字节）
  ) {
    super(
      `File content (${formatFileSize(sizeInBytes)}) exceeds maximum allowed size (${formatFileSize(maxSizeBytes)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    )
    this.name = 'FileTooLargeError'
  }
}

// ---------------------------------------------------------------------------
// 公开入口
// ---------------------------------------------------------------------------

/**
 * 读取文件 [offset, offset+maxLines) 行范围的内容，自动选择快速或流式路径。
 *
 * 【流程】
 * 1. 检查 AbortSignal，若已中止立即抛出。
 * 2. fsStat 获取文件元数据，若为目录则抛错。
 * 3. 普通文件且 < 10MB：走快速路径（readFileInRangeFast）。
 *    - 非截断模式下先检查 maxBytes 上限，超出则抛 FileTooLargeError。
 * 4. 其他情况（大文件 / FIFO / 设备）：走流式路径（readFileInRangeStreaming）。
 *
 * @param filePath           文件路径
 * @param offset             起始行索引（0-based），默认 0
 * @param maxLines           最多读取行数，undefined 表示读至文件末尾
 * @param maxBytes           字节上限（行为取决于 truncateOnByteLimit）
 * @param signal             AbortSignal，用于取消正在进行的读取
 * @param options.truncateOnByteLimit  true = 截断模式；false = 抛错模式（默认）
 */
export async function readFileInRange(
  filePath: string,
  offset = 0,
  maxLines?: number,
  maxBytes?: number,
  signal?: AbortSignal,
  options?: { truncateOnByteLimit?: boolean },
): Promise<ReadFileRangeResult> {
  // 立即响应已中止的信号，避免启动无谓的 I/O
  signal?.throwIfAborted()
  const truncateOnByteLimit = options?.truncateOnByteLimit ?? false

  // stat 决定走哪条路径，同时防止 OOM（大文件提前拦截）
  const stats = await fsStat(filePath)

  // 目录不可读取：提前抛出 EISDIR 错误
  if (stats.isDirectory()) {
    throw new Error(
      `EISDIR: illegal operation on a directory, read '${filePath}'`,
    )
  }

  // 普通文件且 < 10MB：走内存快速路径
  if (stats.isFile() && stats.size < FAST_PATH_MAX_SIZE) {
    // 非截断模式：检查文件大小是否超出 maxBytes
    if (
      !truncateOnByteLimit &&
      maxBytes !== undefined &&
      stats.size > maxBytes
    ) {
      throw new FileTooLargeError(stats.size, maxBytes)
    }

    // 一次性读入文件内容
    const text = await readFile(filePath, { encoding: 'utf8', signal })
    return readFileInRangeFast(
      text,
      stats.mtimeMs,
      offset,
      maxLines,
      // 截断模式才向快速路径传递字节上限；非截断模式已在上方抛错处理
      truncateOnByteLimit ? maxBytes : undefined,
    )
  }

  // 大文件或特殊文件：走流式路径
  return readFileInRangeStreaming(
    filePath,
    offset,
    maxLines,
    maxBytes,
    truncateOnByteLimit,
    signal,
  )
}

// ---------------------------------------------------------------------------
// 快速路径 — readFile + 内存 split
// ---------------------------------------------------------------------------

/**
 * 在已读入内存的字符串上执行行范围切片。
 *
 * 【流程】
 * 1. 剥离 UTF-8 BOM（若有）。
 * 2. 逐字符 indexOf('\n') 扫描，逐行判断是否在 [offset, endLine) 范围内。
 * 3. 使用内嵌 tryPush 函数在截断模式下检查字节上限。
 * 4. 处理末尾无换行的最后一行片段。
 * 5. 拼接所选行并计算统计信息。
 *
 * @param raw            readFile 返回的原始 UTF-8 字符串
 * @param mtimeMs        文件 mtime（来自 stat）
 * @param offset         起始行索引（0-based）
 * @param maxLines       最多读取行数
 * @param truncateAtBytes 截断模式下的字节上限（undefined = 不截断）
 */
function readFileInRangeFast(
  raw: string,
  mtimeMs: number,
  offset: number,
  maxLines: number | undefined,
  truncateAtBytes: number | undefined,
): ReadFileRangeResult {
  // 计算结束行索引（不含）
  const endLine = maxLines !== undefined ? offset + maxLines : Infinity

  // 剥离 UTF-8 BOM（U+FEFF）
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw

  // 存储已选行、行索引、扫描位置等状态
  const selectedLines: string[] = []
  let lineIndex = 0
  let startPos = 0
  let newlinePos: number
  let selectedBytes = 0        // 已选内容的字节数（含分隔符）
  let truncatedByBytes = false // 是否因字节上限被截断

  /**
   * tryPush：在截断模式下检查字节预算后决定是否追加行。
   * 返回 true 表示已成功追加，false 表示超出字节上限触发截断。
   */
  function tryPush(line: string): boolean {
    if (truncateAtBytes !== undefined) {
      // 行间分隔符：第一行无 \n，后续行各加 1 字节
      const sep = selectedLines.length > 0 ? 1 : 0
      const nextBytes = selectedBytes + sep + Buffer.byteLength(line)
      if (nextBytes > truncateAtBytes) {
        // 当前行会导致超出上限，触发截断标志并拒绝追加
        truncatedByBytes = true
        return false
      }
      selectedBytes = nextBytes
    }
    selectedLines.push(line)
    return true
  }

  // 逐行扫描
  while ((newlinePos = text.indexOf('\n', startPos)) !== -1) {
    if (lineIndex >= offset && lineIndex < endLine && !truncatedByBytes) {
      // 当前行在目标范围内：剥除行尾 \r（CRLF → LF）后尝试追加
      let line = text.slice(startPos, newlinePos)
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      tryPush(line)
    }
    lineIndex++
    startPos = newlinePos + 1
  }

  // 处理末尾无换行符的最后一行片段
  if (lineIndex >= offset && lineIndex < endLine && !truncatedByBytes) {
    let line = text.slice(startPos)
    if (line.endsWith('\r')) {
      line = line.slice(0, -1)
    }
    tryPush(line)
  }
  lineIndex++ // 最后一行也计入总行数

  const content = selectedLines.join('\n')
  return {
    content,
    lineCount: selectedLines.length,
    totalLines: lineIndex,
    totalBytes: Buffer.byteLength(text, 'utf8'),  // 整个文件的字节数
    readBytes: Buffer.byteLength(content, 'utf8'), // 已选内容的字节数
    mtimeMs,
    ...(truncatedByBytes ? { truncatedByBytes: true } : {}),
  }
}

// ---------------------------------------------------------------------------
// 流式路径 — createReadStream + 事件处理函数
// ---------------------------------------------------------------------------

/**
 * 流式读取的共享状态对象。
 * 所有事件处理函数通过 bind(state) 以 this 访问，零闭包捕获，
 * 便于 GC 在流销毁后回收整个状态图。
 */
type StreamState = {
  stream: ReturnType<typeof createReadStream> // 底层 ReadStream 实例
  offset: number                               // 起始行索引
  endLine: number                              // 结束行索引（不含）
  maxBytes: number | undefined                 // 字节上限
  truncateOnByteLimit: boolean                 // 是否为截断模式
  resolve: (value: ReadFileRangeResult) => void // Promise resolve 回调
  totalBytesRead: number                       // 已读取的总字节数
  selectedBytes: number                        // 已选内容的字节数
  truncatedByBytes: boolean                    // 是否已触发截断
  currentLineIndex: number                     // 当前行索引
  selectedLines: string[]                      // 已选行内容
  partial: string                              // 跨 chunk 的行尾残片
  isFirstChunk: boolean                        // 是否为第一个 chunk（用于 BOM 检测）
  resolveMtime: (ms: number) => void           // mtime Promise 的 resolve
  mtimeReady: Promise<number>                  // mtime 异步结果
}

/**
 * streamOnOpen — 'open' 事件处理函数。
 * 在流打开后立即异步 fstat，将 mtime 写入 state.mtimeReady，
 * 避免额外的 stat() 系统调用。
 */
function streamOnOpen(this: StreamState, fd: number): void {
  // 通过已打开的 fd 获取 mtime，无需再次 open 文件
  fstat(fd, (err, stats) => {
    // 若 fstat 失败则以 0 作为 mtime（降级处理）
    this.resolveMtime(err ? 0 : stats.mtimeMs)
  })
}

/**
 * streamOnData — 'data' 事件处理函数，每个 chunk 触发一次。
 *
 * 【流程】
 * 1. 首个 chunk：检测并剥离 UTF-8 BOM。
 * 2. 累加 totalBytesRead；非截断模式下若超出 maxBytes，销毁流并抛 FileTooLargeError。
 * 3. 将 partial（上一 chunk 的行尾残片）拼接到当前 chunk 头部。
 * 4. 逐行 indexOf('\n') 扫描：
 *    - 处于目标范围内：截断模式下检查字节预算，否则直接追加。
 *    - 超出截断预算：更新 endLine 使后续行不再追加（但流继续以计算 totalLines）。
 * 5. 若有跨 chunk 的行尾残片：在截断模式下提前检查残片字节，防止无界增长。
 */
function streamOnData(this: StreamState, chunk: string): void {
  // 首个 chunk：检测并剥离 BOM
  if (this.isFirstChunk) {
    this.isFirstChunk = false
    if (chunk.charCodeAt(0) === 0xfeff) {
      chunk = chunk.slice(1)
    }
  }

  // 累计总读取字节数
  this.totalBytesRead += Buffer.byteLength(chunk)

  // 非截断模式：字节超出上限则销毁流并抛错（传统 FileTooLargeError 语义）
  if (
    !this.truncateOnByteLimit &&
    this.maxBytes !== undefined &&
    this.totalBytesRead > this.maxBytes
  ) {
    this.stream.destroy(
      new FileTooLargeError(this.totalBytesRead, this.maxBytes),
    )
    return
  }

  // 拼接上一 chunk 的残片（若有），再扫描完整行
  const data = this.partial.length > 0 ? this.partial + chunk : chunk
  this.partial = ''

  let startPos = 0
  let newlinePos: number
  while ((newlinePos = data.indexOf('\n', startPos)) !== -1) {
    if (
      this.currentLineIndex >= this.offset &&
      this.currentLineIndex < this.endLine
    ) {
      // 当前行在目标范围内：剥除 \r 并检查字节预算
      let line = data.slice(startPos, newlinePos)
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
        const sep = this.selectedLines.length > 0 ? 1 : 0
        const nextBytes = this.selectedBytes + sep + Buffer.byteLength(line)
        if (nextBytes > this.maxBytes) {
          // 超出字节上限：折叠选择范围（停止追加），流继续以统计 totalLines
          this.truncatedByBytes = true
          this.endLine = this.currentLineIndex
        } else {
          this.selectedBytes = nextBytes
          this.selectedLines.push(line)
        }
      } else {
        // 非截断模式：直接追加
        this.selectedLines.push(line)
      }
    }
    this.currentLineIndex++
    startPos = newlinePos + 1
  }

  // 处理 chunk 末尾的不完整行（跨 chunk 残片）
  // 范围外的残片直接丢弃，防止超大单行文件（无换行）导致内存爆炸
  if (startPos < data.length) {
    if (
      this.currentLineIndex >= this.offset &&
      this.currentLineIndex < this.endLine
    ) {
      const fragment = data.slice(startPos)
      // 截断模式：若残片本身已超出剩余字节预算，提前触发截断并丢弃
      if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
        const sep = this.selectedLines.length > 0 ? 1 : 0
        const fragBytes = this.selectedBytes + sep + Buffer.byteLength(fragment)
        if (fragBytes > this.maxBytes) {
          // 残片即将超限：触发截断，折叠选择范围，丢弃此残片
          this.truncatedByBytes = true
          this.endLine = this.currentLineIndex
          return
        }
      }
      // 残片在预算内：保存供下一 chunk 拼接
      this.partial = fragment
    }
  }
}

/**
 * streamOnEnd — 'end' 事件处理函数，流读取完毕时触发一次。
 *
 * 【流程】
 * 1. 处理 partial 中的最后一行（末尾无 \n 的情况）。
 * 2. 等待 mtime Promise 解析，然后 resolve 最终结果。
 */
function streamOnEnd(this: StreamState): void {
  // 处理末尾残片（末尾无换行符的最后一行）
  let line = this.partial
  if (line.endsWith('\r')) {
    line = line.slice(0, -1)
  }
  if (
    this.currentLineIndex >= this.offset &&
    this.currentLineIndex < this.endLine
  ) {
    if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
      // 截断模式下的最后一行也需检查字节预算
      const sep = this.selectedLines.length > 0 ? 1 : 0
      const nextBytes = this.selectedBytes + sep + Buffer.byteLength(line)
      if (nextBytes > this.maxBytes) {
        this.truncatedByBytes = true
      } else {
        this.selectedLines.push(line)
      }
    } else {
      this.selectedLines.push(line)
    }
  }
  this.currentLineIndex++ // 最后一行也计入总行数

  const content = this.selectedLines.join('\n')
  const truncated = this.truncatedByBytes
  // 等待 mtime 异步获取完成后，再 resolve Promise
  this.mtimeReady.then(mtimeMs => {
    this.resolve({
      content,
      lineCount: this.selectedLines.length,
      totalLines: this.currentLineIndex,
      totalBytes: this.totalBytesRead,
      readBytes: Buffer.byteLength(content, 'utf8'),
      mtimeMs,
      ...(truncated ? { truncatedByBytes: true } : {}),
    })
  })
}

/**
 * readFileInRangeStreaming — 创建 ReadStream 并绑定事件处理函数。
 *
 * 【生命周期】
 * - 'open'：一次（.once），获取 fd 并 fstat mtime。
 * - 'data'：多次（.on），每 512KB chunk 触发一次。
 * - 'end'：一次（.once），拼接最终结果后 resolve。
 * - 'error'：一次（.once），直接 reject（含 FileTooLargeError 和 AbortError）。
 */
function readFileInRangeStreaming(
  filePath: string,
  offset: number,
  maxLines: number | undefined,
  maxBytes: number | undefined,
  truncateOnByteLimit: boolean,
  signal?: AbortSignal,
): Promise<ReadFileRangeResult> {
  return new Promise((resolve, reject) => {
    // 构建流状态对象（所有事件处理函数通过 bind(state) 共享此对象）
    const state: StreamState = {
      stream: createReadStream(filePath, {
        encoding: 'utf8',
        highWaterMark: 512 * 1024, // 每次读取 512KB，平衡 I/O 次数与内存
        ...(signal ? { signal } : undefined), // 支持 AbortSignal 取消
      }),
      offset,
      endLine: maxLines !== undefined ? offset + maxLines : Infinity,
      maxBytes,
      truncateOnByteLimit,
      resolve,
      totalBytesRead: 0,
      selectedBytes: 0,
      truncatedByBytes: false,
      currentLineIndex: 0,
      selectedLines: [],
      partial: '',
      isFirstChunk: true,
      resolveMtime: () => {},
      mtimeReady: null as unknown as Promise<number>,
    }
    // 创建独立的 mtime Promise，由 'open' 事件中的 fstat 回调来 resolve
    state.mtimeReady = new Promise<number>(r => {
      state.resolveMtime = r
    })

    // 注册事件处理函数（所有函数通过 bind 访问 state，零闭包）
    state.stream.once('open', streamOnOpen.bind(state))   // fd 就绪后获取 mtime
    state.stream.on('data', streamOnData.bind(state))     // 处理每个数据块
    state.stream.once('end', streamOnEnd.bind(state))     // 流结束后汇总结果
    state.stream.once('error', reject)                    // 错误直接 reject
  })
}
