/**
 * DXT ZIP 包解压模块（dxt/zip.ts）
 *
 * 【在系统流程中的位置】
 * 该模块属于 DXT 扩展包处理子系统，被插件安装流程和扩展加载器调用。
 * 负责安全地解压 .dxt 扩展包（标准 ZIP 格式），并提供多层安全防护。
 *
 * 【主要功能】
 * - isPathSafe()：检测文件路径是否包含路径遍历攻击或绝对路径
 * - validateZipFile()：逐文件校验 ZIP 内容（文件数、大小、压缩比）
 * - unzipFile()：延迟加载 fflate 解压 ZIP 字节数据
 * - parseZipModes()：从 PKZIP 中央目录解析 Unix 文件权限位
 * - readAndUnzipFile()：从磁盘异步读取并解压 ZIP 文件
 *
 * 【安全防护】
 * - 路径遍历攻击防御（.. / 绝对路径检测）
 * - ZIP 炸弹检测（压缩比上限 50:1）
 * - 文件数量限制（10 万个）
 * - 单文件大小限制（512MB）
 * - 总解压大小限制（1GB）
 */
import { isAbsolute, normalize } from 'path'
import { logForDebugging } from '../debug.js'
import { isENOENT } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import { containsPathTraversal } from '../path.js'

/** ZIP 解压安全限制常量 */
const LIMITS = {
  MAX_FILE_SIZE: 512 * 1024 * 1024,  // 单文件最大 512MB
  MAX_TOTAL_SIZE: 1024 * 1024 * 1024, // 总解压大小最大 1GB
  MAX_FILE_COUNT: 100000,              // 最多 10 万个文件
  MAX_COMPRESSION_RATIO: 50,           // 压缩比上限 50:1（超出则疑似 ZIP 炸弹）
  MIN_COMPRESSION_RATIO: 0.5,          // 压缩比下限 0.5:1（低于此值可能已是压缩内容）
}

/**
 * ZIP 解压过程中的安全校验状态追踪器。
 * 在 fflate filter 回调中逐文件累积统计数据。
 */
type ZipValidationState = {
  /** 已处理的文件数量 */
  fileCount: number
  /** 累计解压后总大小（字节） */
  totalUncompressedSize: number
  /** ZIP 压缩包本身的大小（字节），用于计算压缩比 */
  compressedSize: number
  /** 校验过程中收集的错误信息列表 */
  errors: string[]
}

/**
 * fflate filter 回调传入的单个文件元数据。
 */
type ZipFileMetadata = {
  /** 文件在 ZIP 内的相对路径 */
  name: string
  /** 文件解压后的原始大小（字节），可能不存在 */
  originalSize?: number
}

/**
 * 单文件校验结果：通过时 isValid=true，失败时附带错误信息。
 */
type FileValidationResult = {
  isValid: boolean
  error?: string
}

/**
 * 检测文件路径是否安全（无路径遍历、无绝对路径）。
 *
 * 【流程说明】
 * 1. 调用 containsPathTraversal() 检测 `..` 等路径遍历特征
 * 2. 使用 path.normalize 规范化路径（解析 `.` 片段）
 * 3. 检测规范化后路径是否为绝对路径（ZIP 包内只允许相对路径）
 *
 * @param filePath  ZIP 内条目的文件路径
 * @returns         安全返回 true，存在攻击风险返回 false
 */
export function isPathSafe(filePath: string): boolean {
  // 检测路径遍历特征（如 ../、..\）
  if (containsPathTraversal(filePath)) {
    return false
  }

  // 规范化路径以解析 '.' 片段
  const normalized = normalize(filePath)

  // ZIP 包内只允许相对路径，绝对路径视为不安全
  if (isAbsolute(normalized)) {
    return false
  }

  return true
}

/**
 * 在 ZIP 解压过程中对单个文件进行安全校验。
 *
 * 【流程说明】
 * 1. 递增 state.fileCount，检测文件总数是否超限
 * 2. 调用 isPathSafe() 检测路径安全
 * 3. 检测单文件大小是否超过 512MB
 * 4. 累加至 state.totalUncompressedSize，检测总解压大小是否超过 1GB
 * 5. 计算当前压缩比，检测是否超过 50:1（ZIP 炸弹防御）
 * 6. 任意检测失败时返回 { isValid: false, error }
 *
 * @param file   fflate 提供的文件元数据
 * @param state  当前解压过程的累积校验状态（会被修改）
 */
export function validateZipFile(
  file: ZipFileMetadata,
  state: ZipValidationState,
): FileValidationResult {
  // 递增文件计数
  state.fileCount++

  let error: string | undefined

  // 检测文件总数是否超过 10 万个
  if (state.fileCount > LIMITS.MAX_FILE_COUNT) {
    error = `Archive contains too many files: ${state.fileCount} (max: ${LIMITS.MAX_FILE_COUNT})`
  }

  // 检测路径是否存在路径遍历或绝对路径
  if (!isPathSafe(file.name)) {
    error = `Unsafe file path detected: "${file.name}". Path traversal or absolute paths are not allowed.`
  }

  // 检测单文件解压大小是否超过 512MB
  const fileSize = file.originalSize || 0
  if (fileSize > LIMITS.MAX_FILE_SIZE) {
    error = `File "${file.name}" is too large: ${Math.round(fileSize / 1024 / 1024)}MB (max: ${Math.round(LIMITS.MAX_FILE_SIZE / 1024 / 1024)}MB)`
  }

  // 累加当前文件大小至总解压大小
  state.totalUncompressedSize += fileSize

  // 检测累计总解压大小是否超过 1GB
  if (state.totalUncompressedSize > LIMITS.MAX_TOTAL_SIZE) {
    error = `Archive total size is too large: ${Math.round(state.totalUncompressedSize / 1024 / 1024)}MB (max: ${Math.round(LIMITS.MAX_TOTAL_SIZE / 1024 / 1024)}MB)`
  }

  // 计算当前压缩比（总解压大小 / ZIP 包大小），超过 50:1 疑似 ZIP 炸弹
  const currentRatio = state.totalUncompressedSize / state.compressedSize
  if (currentRatio > LIMITS.MAX_COMPRESSION_RATIO) {
    error = `Suspicious compression ratio detected: ${currentRatio.toFixed(1)}:1 (max: ${LIMITS.MAX_COMPRESSION_RATIO}:1). This may be a zip bomb.`
  }

  return error ? { isValid: false, error } : { isValid: true }
}

/**
 * 解压 ZIP 字节数据，返回文件路径到内容的映射。
 *
 * 【流程说明】
 * 1. 动态 import fflate，避免其约 196KB 的顶层查找表（revfd/rev 数组）在启动时占用堆
 * 2. 初始化 ZipValidationState，记录压缩包原始大小作为压缩比计算基准
 * 3. 调用 unzipSync 同步解压（避免 Bun 中 fflate worker 被意外终止的崩溃问题）
 * 4. filter 回调中对每个文件调用 validateZipFile()，失败时立即抛出
 * 5. 解压完成后记录调试日志（文件数 + 总大小）
 *
 * @param zipData  ZIP 文件的原始字节（Buffer）
 * @returns        文件路径 → Uint8Array 内容的映射
 */
export async function unzipFile(
  zipData: Buffer,
): Promise<Record<string, Uint8Array>> {
  // 延迟加载 fflate，避免其约 196KB 的顶层数组（revfd/rev 等）在启动时占堆
  const { unzipSync } = await import('fflate')
  const compressedSize = zipData.length

  // 初始化校验状态，以 ZIP 包自身大小作为压缩比计算基准
  const state: ZipValidationState = {
    fileCount: 0,
    totalUncompressedSize: 0,
    compressedSize: compressedSize,
    errors: [],
  }

  // 同步解压（Bun 中异步 worker 可能崩溃，使用同步版本更安全）
  const result = unzipSync(new Uint8Array(zipData), {
    filter: file => {
      // 每个文件在解压前先经过安全校验，失败时立即抛出终止解压
      const validationResult = validateZipFile(file, state)
      if (!validationResult.isValid) {
        throw new Error(validationResult.error!)
      }
      return true
    },
  })

  // 解压完成，记录文件数和总大小供调试
  logForDebugging(
    `Zip extraction completed: ${state.fileCount} files, ${Math.round(state.totalUncompressedSize / 1024)}KB uncompressed`,
  )

  return result
}

/**
 * 从 ZIP 中央目录解析 Unix 文件权限位（st_mode）。
 *
 * 【背景说明】
 * fflate 的 unzipSync 只返回 Record<string, Uint8Array>，不暴露
 * 中央目录中存储的外部文件属性（external file attributes）。
 * 这导致所有文件的权限位丢失（统一变为 0644），可执行位（+x）也会丢失。
 * git clone 路径天然保留 +x，但 GCS/ZIP 安装路径需要此函数恢复权限一致性。
 *
 * 【流程说明】
 * 1. 从 ZIP 数据末部向前扫描，定位 EOCD 签名（0x06054b50）
 * 2. 从 EOCD 读取中央目录条目数量和起始偏移
 * 3. 遍历每个中央目录条目（签名 0x02014b50）：
 *    - 读取 versionMadeBy 高字节判断操作系统（3 = Unix）
 *    - 从 externalAttr 高 16 位提取 st_mode（文件类型 + 权限位）
 *    - 非 Unix 条目或 mode 为 0 的条目跳过
 * 4. 返回 name → mode 映射，调用方对缺失 key 应使用默认权限
 *
 * 注意：不处理 ZIP64 格式（>4GB 或 >65535 条目），此类 ZIP 返回空对象。
 * 对市场包（~3.5MB）和 MCPB 包来说足够。
 *
 * @param data  ZIP 文件的完整字节数据（Uint8Array）
 * @returns     文件路径 → Unix mode 值的映射
 */
export function parseZipModes(data: Uint8Array): Record<string, number> {
  // 创建 Buffer 视图（共享内存，无拷贝），使用 readUInt* 方法
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const modes: Record<string, number> = {}

  // 1. 从 ZIP 末尾向前扫描 EOCD 签名（0x06054b50）
  //    EOCD 固定大小为 22 字节，注释区最大 65535 字节，因此扫描范围为末尾 22+65535 字节
  const minEocd = Math.max(0, buf.length - 22 - 0xffff)
  let eocd = -1
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  // 找不到 EOCD 签名，ZIP 格式损坏，交由 fflate 报错处理
  if (eocd < 0) return modes

  // 从 EOCD 偏移 +10 读取中央目录条目数，偏移 +16 读取中央目录起始偏移
  const entryCount = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16) // 中央目录起始偏移

  // 2. 遍历中央目录条目（每条目签名 0x02014b50，固定头部 46 字节）
  for (let i = 0; i < entryCount; i++) {
    // 越界或签名不匹配时终止遍历
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break
    // 偏移 +4：versionMadeBy（高字节 = 制作平台，3 = Unix）
    const versionMadeBy = buf.readUInt16LE(off + 4)
    // 偏移 +28/+30/+32：文件名/扩展字段/注释长度（用于跳过可变部分）
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    // 偏移 +38：外部文件属性（Unix 下高 16 位为 st_mode）
    const externalAttr = buf.readUInt32LE(off + 38)
    // 偏移 +46 开始是 UTF-8 编码的文件名
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen)

    // 仅处理 Unix 宿主创建的条目（versionMadeBy 高字节 === 3）
    if (versionMadeBy >> 8 === 3) {
      // externalAttr 高 16 位即为 st_mode（文件类型 + 权限位）
      const mode = (externalAttr >>> 16) & 0xffff
      // mode 为 0 表示未设置权限位，跳过
      if (mode) modes[name] = mode
    }

    // 跳过固定头部（46 字节）+ 可变长度字段（文件名 + 扩展字段 + 注释）
    off += 46 + nameLen + extraLen + commentLen
  }

  return modes
}

/**
 * 从磁盘异步读取 ZIP 文件并解压，返回文件路径到内容的映射。
 *
 * 【流程说明】
 * 1. 通过 getFsImplementation().readFileBytes() 异步读取文件字节
 * 2. 调用 unzipFile() 解压（注意必须 await，否则异步拒绝会跳过 catch）
 * 3. ENOENT 错误（文件不存在）直接重新抛出，其余错误包装为更友好的消息
 *
 * @param filePath  磁盘上 ZIP 文件的路径
 * @returns         文件路径 → Uint8Array 内容的映射
 */
export async function readAndUnzipFile(
  filePath: string,
): Promise<Record<string, Uint8Array>> {
  const fs = getFsImplementation()

  try {
    // 异步读取 ZIP 文件字节
    const zipData = await fs.readFileBytes(filePath)
    // 必须 await：不 await 的话，unzipFile() 内部的 async 拒绝会逃逸 try/catch
    return await unzipFile(zipData)
  } catch (error) {
    // ENOENT 错误（文件不存在）直接透传，由调用方决定如何处理
    if (isENOENT(error)) {
      throw error
    }
    // 其他错误包装为更具可读性的错误消息
    const errorMessage = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read or unzip file: ${errorMessage}`)
  }
}
