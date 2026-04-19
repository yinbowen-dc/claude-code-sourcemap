/**
 * 文件类型检测工具
 *
 * 本文件提供二进制文件检测能力，用于在文件读取、diff 对比等基于文本的操作中
 * 跳过无法有效处理的二进制文件。检测方式有两种：
 *
 * 1. 扩展名检测（hasBinaryExtension）：通过 BINARY_EXTENSIONS 集合快速匹配
 * 2. 内容检测（isBinaryContent）：通过扫描文件头部字节判断是否含有二进制特征
 *
 * 注意：PDF 虽列于 BINARY_EXTENSIONS 中，但 FileReadTool 在调用处会特殊处理，
 * 允许对 PDF 进行读取操作（使用页面提取路径）。
 */

/**
 * 需要跳过文本操作的二进制文件扩展名集合。
 * 这些文件无法有效进行文本对比，且通常体积较大。
 * 使用 Set 以确保 O(1) 查找性能。
 */
export const BINARY_EXTENSIONS = new Set([
  // 图片格式
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.tiff',
  '.tif',
  // 视频格式
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.wmv',
  '.flv',
  '.m4v',
  '.mpeg',
  '.mpg',
  // 音频格式
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.aac',
  '.m4a',
  '.wma',
  '.aiff',
  '.opus',
  // 压缩包格式
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.7z',
  '.rar',
  '.xz',
  '.z',
  '.tgz',
  '.iso',
  // 可执行文件/二进制文件
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.o',
  '.a',
  '.obj',
  '.lib',
  '.app',
  '.msi',
  '.deb',
  '.rpm',
  // 文档格式（PDF 在此列；FileReadTool 在调用处单独处理，允许读取 PDF）
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  // 字体文件
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  // 字节码 / 虚拟机产物
  '.pyc',
  '.pyo',
  '.class',
  '.jar',
  '.war',
  '.ear',
  '.node',
  '.wasm',
  '.rlib',
  // 数据库文件
  '.sqlite',
  '.sqlite3',
  '.db',
  '.mdb',
  '.idx',
  // 设计 / 3D 文件
  '.psd',
  '.ai',
  '.eps',
  '.sketch',
  '.fig',
  '.xd',
  '.blend',
  '.3ds',
  '.max',
  // Flash 文件
  '.swf',
  '.fla',
  // 锁文件 / 性能分析数据
  '.lockb',
  '.dat',
  '.data',
])

/**
 * 通过文件扩展名快速判断是否为二进制文件。
 *
 * 工作流程：从文件路径提取最后一个 "." 之后的扩展名，转小写后查询 BINARY_EXTENSIONS 集合。
 *
 * @param filePath 文件路径（可含目录前缀）
 * @returns 若扩展名属于已知二进制格式则返回 true
 */
export function hasBinaryExtension(filePath: string): boolean {
  // 从最后一个 "." 处截取扩展名，统一转小写以忽略大小写差异
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

/**
 * 用于内容检测的字节数上限（仅扫描文件头部）。
 * 扫描前 8KB 已足够识别绝大多数二进制文件，同时避免读取超大文件的全部内容。
 */
const BINARY_CHECK_SIZE = 8192

/**
 * 通过扫描缓冲区内容判断是否为二进制数据。
 *
 * 检测策略（两个判据，满足任一即判定为二进制）：
 * 1. 出现 null 字节（0x00）→ 强指示符，立即返回 true
 * 2. 非可打印、非空白字符占比超过 10% → 判定为二进制
 *
 * 可打印 ASCII 范围：32–126；允许的空白字符：Tab(9)、换行(10)、回车(13)
 *
 * @param buffer 待检测的文件内容缓冲区
 * @returns 判定为二进制内容则返回 true
 */
export function isBinaryContent(buffer: Buffer): boolean {
  // 仅检测前 BINARY_CHECK_SIZE 字节（或完整缓冲区，取较小值）
  const checkSize = Math.min(buffer.length, BINARY_CHECK_SIZE)

  let nonPrintable = 0
  for (let i = 0; i < checkSize; i++) {
    const byte = buffer[i]!
    // null 字节是二进制文件的强指示符，直接返回
    if (byte === 0) {
      return true
    }
    // 统计非可打印、非空白字节数量
    // 可打印 ASCII：32-126；常见空白：9(tab)、10(newline)、13(carriage return)
    if (
      byte < 32 &&
      byte !== 9 && // tab
      byte !== 10 && // newline
      byte !== 13 // carriage return
    ) {
      nonPrintable++
    }
  }

  // 非可打印字符占比超过 10% 则判定为二进制
  return nonPrintable / checkSize > 0.1
}
