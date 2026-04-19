/**
 * 文件系统底层操作模块（FsOperations）。
 *
 * 【在 Claude Code 系统中的位置】
 * 该模块封装 Node.js fs 模块的核心操作，提供可替换的 fs 实现接口，
 * 是 fileRead.ts、file.ts 等工具执行层的共同依赖，处于依赖链末端，
 * 无循环引入风险。支持在测试/沙箱环境中替换为虚拟实现。
 * - getFsImplementation()：获取当前 fs 实现（真实 fs 或测试替代）
 * - safeResolvePath()：安全解析路径，防止路径遍历攻击
 * - 封装 mkdir/open/readdir 等异步操作，统一错误处理
 * - 提供文件范围读取（readFileRange）、反向行读取（readLinesReverse）等高级操作
 */
import * as fs from 'fs'
import {
  mkdir as mkdirPromise,
  open,
  readdir as readdirPromise,
  readFile as readFilePromise,
  rename as renamePromise,
  rmdir as rmdirPromise,
  rm as rmPromise,
  stat as statPromise,
  unlink as unlinkPromise,
} from 'fs/promises'
import { homedir } from 'os'
import * as nodePath from 'path'
import { getErrnoCode } from './errors.js'
import { slowLogging } from './slowOperations.js'

/**
 * 文件系统操作接口，基于 Node.js fs 模块的简化子集。
 * 提供带类型安全的常用同步/异步操作，允许替换为模拟实现（如测试用虚拟 fs）。
 */
export type FsOperations = {
  // 文件访问与信息操作
  /** 获取当前工作目录 */
  cwd(): string
  /** 检查文件或目录是否存在 */
  existsSync(path: string): boolean
  /** 异步获取文件状态 */
  stat(path: string): Promise<fs.Stats>
  /** 异步列出目录内容（含文件类型信息） */
  readdir(path: string): Promise<fs.Dirent[]>
  /** 异步删除文件 */
  unlink(path: string): Promise<void>
  /** 异步删除空目录 */
  rmdir(path: string): Promise<void>
  /** 异步删除文件或目录（支持递归） */
  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void>
  /** 异步递归创建目录 */
  mkdir(path: string, options?: { mode?: number }): Promise<void>
  /** 异步读取文件内容为字符串 */
  readFile(path: string, options: { encoding: BufferEncoding }): Promise<string>
  /** 异步重命名/移动文件 */
  rename(oldPath: string, newPath: string): Promise<void>
  /** 同步获取文件状态 */
  statSync(path: string): fs.Stats
  /** 同步获取文件状态（不跟随符号链接） */
  lstatSync(path: string): fs.Stats

  // 文件内容操作
  /** 同步读取文件内容为字符串（指定编码） */
  readFileSync(
    path: string,
    options: {
      encoding: BufferEncoding
    },
  ): string
  /** 同步读取文件原始字节为 Buffer */
  readFileBytesSync(path: string): Buffer
  /** 同步从文件头读取指定字节数 */
  readSync(
    path: string,
    options: {
      length: number
    },
  ): {
    buffer: Buffer
    bytesRead: number
  }
  /** 同步追加字符串到文件 */
  appendFileSync(path: string, data: string, options?: { mode?: number }): void
  /** 同步复制文件 */
  copyFileSync(src: string, dest: string): void
  /** 同步删除文件 */
  unlinkSync(path: string): void
  /** 同步重命名/移动文件 */
  renameSync(oldPath: string, newPath: string): void
  /** 同步创建硬链接 */
  linkSync(target: string, path: string): void
  /** 同步创建符号链接 */
  symlinkSync(
    target: string,
    path: string,
    type?: 'dir' | 'file' | 'junction',
  ): void
  /** 同步读取符号链接目标 */
  readlinkSync(path: string): string
  /** 同步解析符号链接，返回规范路径 */
  realpathSync(path: string): string

  // 目录操作
  /** 同步递归创建目录（mode 默认为 0o777 & ~umask） */
  mkdirSync(
    path: string,
    options?: {
      mode?: number
    },
  ): void
  /** 同步列出目录内容（含文件类型信息） */
  readdirSync(path: string): fs.Dirent[]
  /** 同步列出目录内容（返回字符串数组） */
  readdirStringSync(path: string): string[]
  /** 同步检查目录是否为空 */
  isDirEmptySync(path: string): boolean
  /** 同步删除空目录 */
  rmdirSync(path: string): void
  /** 同步删除文件或目录（支持递归） */
  rmSync(
    path: string,
    options?: {
      recursive?: boolean
      force?: boolean
    },
  ): void
  /** 创建可写流，用于流式写入数据到文件 */
  createWriteStream(path: string): fs.WriteStream
  /** 异步读取文件原始字节为 Buffer（可限制最大读取字节数） */
  readFileBytes(path: string, maxBytes?: number): Promise<Buffer>
}

/**
 * 安全解析文件路径，处理符号链接并优雅地处理各类错误。
 *
 * 【错误处理策略】
 * - 文件不存在（ENOENT）：返回原始路径（允许后续创建文件）
 * - 符号链接解析失败（断裂链接、权限拒绝、循环链接）：返回原始路径，标记为非符号链接
 * - 特殊文件类型（FIFO、Socket、字符设备、块设备）：返回原始路径，不调用 realpathSync
 *   （避免 realpathSync 在 FIFO 上阻塞等待写入者）
 * - UNC 路径（// 或 \\\\）：直接返回，避免触发 Windows 网络请求（DNS/SMB）
 *
 * @param fs - 要使用的文件系统实现
 * @param filePath - 要解析的路径
 * @returns 包含解析路径、是否为符号链接、是否为规范路径的对象
 */
export function safeResolvePath(
  fs: FsOperations,
  filePath: string,
): { resolvedPath: string; isSymlink: boolean; isCanonical: boolean } {
  // 拦截 UNC 路径，防止在 Windows 上触发网络请求（DNS/SMB）
  if (filePath.startsWith('//') || filePath.startsWith('\\\\')) {
    return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
  }

  try {
    // 先用 lstatSync 检查特殊文件类型，避免 realpathSync 在 FIFO 上阻塞
    // 若文件不存在，lstatSync 抛出 ENOENT，由 catch 处理（允许文件创建）
    const stats = fs.lstatSync(filePath)
    if (
      stats.isFIFO() ||
      stats.isSocket() ||
      stats.isCharacterDevice() ||
      stats.isBlockDevice()
    ) {
      // 特殊文件类型：不调用 realpathSync，直接返回原始路径
      return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
    }

    const resolvedPath = fs.realpathSync(filePath) // 解析所有路径组件中的符号链接
    return {
      resolvedPath,
      isSymlink: resolvedPath !== filePath, // 解析后路径与原始路径不同 → 是符号链接
      // realpathSync 返回：resolvedPath 是规范路径（所有路径组件的符号链接均已解析）
      // 调用方可跳过对该路径的进一步符号链接解析
      isCanonical: true,
    }
  } catch (_error) {
    // lstat/realpath 因任何原因失败（ENOENT、断裂链接、EACCES、ELOOP 等）
    // 返回原始路径，允许后续操作继续进行
    return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
  }
}

/**
 * 判断文件路径是否重复（指向同一物理文件），并维护已加载路径集合。
 * 通过解析符号链接检测指向同一文件的不同路径。
 * 若不重复，则将解析后的路径加入 loadedPaths 集合。
 *
 * @param fs - 文件系统实现
 * @param filePath - 要检查的路径
 * @param loadedPaths - 已加载路径的集合（会被修改）
 * @returns 若文件应被跳过（重复）则返回 true
 */
export function isDuplicatePath(
  fs: FsOperations,
  filePath: string,
  loadedPaths: Set<string>,
): boolean {
  const { resolvedPath } = safeResolvePath(fs, filePath) // 解析符号链接
  if (loadedPaths.has(resolvedPath)) {
    return true // 已加载过该物理文件
  }
  loadedPaths.add(resolvedPath) // 记录已加载
  return false
}

/**
 * 通过逐级向上 lstat 找到路径中最深的已存在祖先，并用 realpathSync 解析其中的符号链接。
 * 能检测悬空符号链接（链接条目存在但目标不存在），通过 readlink 处理。
 *
 * 【使用场景】
 * 当输入路径可能不存在（如新文件写入）时，用于确定写入操作实际落地位置。
 *
 * 【返回规则】
 * - 若路径中存在符号链接，返回解析后的绝对路径（含非存在的尾部段）
 * - 若所有已存在祖先均解析为自身（无符号链接），返回 undefined
 *
 * 处理情况：活跃父目录符号链接、悬空文件符号链接、悬空父目录符号链接。
 *
 * @param fs - 文件系统实现
 * @param absolutePath - 要解析的绝对路径
 * @returns 解析后的路径（含不存在的尾部），或 undefined（无符号链接）
 */
export function resolveDeepestExistingAncestorSync(
  fs: FsOperations,
  absolutePath: string,
): string | undefined {
  let dir = absolutePath
  const segments: string[] = []
  // 逐级向上：用 lstat（轻量，O(1)）找到第一个已存在的路径组件
  // lstat 不跟随符号链接，因此可检测悬空符号链接
  // 最终只调用一次 realpathSync（代价较高，O(深度)）
  while (dir !== nodePath.dirname(dir)) {
    let st: fs.Stats
    try {
      st = fs.lstatSync(dir) // 不跟随符号链接，检测链接本身的存在
    } catch {
      // lstat 失败：路径真正不存在，继续向上
      segments.unshift(nodePath.basename(dir))
      dir = nodePath.dirname(dir)
      continue
    }
    if (st.isSymbolicLink()) {
      // 找到符号链接（可能活跃或悬空）
      // 先尝试 realpath（可解析链式符号链接），悬空时退回 readlink
      try {
        const resolved = fs.realpathSync(dir) // 尝试完整解析
        return segments.length === 0
          ? resolved
          : nodePath.join(resolved, ...segments) // 拼接不存在的尾部段
      } catch {
        // 悬空链接：realpath 失败但 lstat 看到了链接条目
        const target = fs.readlinkSync(dir) // 读取链接目标
        const absTarget = nodePath.isAbsolute(target)
          ? target
          : nodePath.resolve(nodePath.dirname(dir), target) // 相对路径转绝对路径
        return segments.length === 0
          ? absTarget
          : nodePath.join(absTarget, ...segments)
      }
    }
    // 已存在的非符号链接组件：调用一次 realpath 解析其祖先中的符号链接
    // 若无符号链接，返回 undefined
    try {
      const resolved = fs.realpathSync(dir)
      if (resolved !== dir) {
        // 祖先中有符号链接
        return segments.length === 0
          ? resolved
          : nodePath.join(resolved, ...segments)
      }
    } catch {
      // realpath 失败（如 EACCES），返回 undefined（无法解析，调用方已记录逻辑路径）
    }
    return undefined // 所有已存在祖先均无符号链接
  }
  return undefined
}

/**
 * 获取需要进行权限检查的所有路径（含符号链接链上的所有中间目标）。
 *
 * 【动机】
 * 安全检查必须覆盖符号链接链上的每一个路径，例如：
 * test.txt → /etc/passwd → /private/etc/passwd
 * 若 /etc/passwd 有拒绝规则，即使实际文件在 /private/etc/passwd 也应被拦截。
 *
 * 【流程】
 * 1. 展开 ~ 前缀（防御性处理，工具层应已展开）；
 * 2. 拦截 UNC 路径；
 * 3. 沿符号链接链向前，收集每个中间目标路径（含悬空符号链接处理）；
 * 4. 最后用 safeResolvePath 补充最终解析路径。
 *
 * @param inputPath - 要检查的路径（将转换为绝对路径）
 * @returns 需要进行权限检查的绝对路径数组
 */
export function getPathsForPermissionCheck(inputPath: string): string[] {
  // 防御性展开 ~ 前缀（工具层应在 getPath() 中处理，此处作为纵深防御）
  let path = inputPath
  if (path === '~') {
    path = homedir().normalize('NFC')
  } else if (path.startsWith('~/')) {
    path = nodePath.join(homedir().normalize('NFC'), path.slice(2))
  }

  const pathSet = new Set<string>()
  const fsImpl = getFsImplementation()

  // 始终检查原始路径
  pathSet.add(path)

  // 拦截 UNC 路径，防止 Windows 上触发网络请求（DNS/SMB）
  if (path.startsWith('//') || path.startsWith('\\\\')) {
    return Array.from(pathSet)
  }

  // 沿符号链接链收集所有中间目标
  // 处理 test.txt → /etc/passwd → /private/etc/passwd 的情况
  // 需要检查全部三个路径，而非仅首尾
  try {
    let currentPath = path
    const visited = new Set<string>()
    const maxDepth = 40 // 防止循环符号链接死循环，匹配典型 SYMLOOP_MAX

    for (let depth = 0; depth < maxDepth; depth++) {
      // 防止循环符号链接无限循环
      if (visited.has(currentPath)) {
        break
      }
      visited.add(currentPath)

      if (!fsImpl.existsSync(currentPath)) {
        // 路径不存在（新文件情况）。existsSync 跟随符号链接，
        // 因此悬空符号链接（链接条目存在但目标不存在）也会到达此分支。
        // 解析路径中的符号链接和祖先路径，确保权限检查看到真实目标。
        // 若不处理，`./data -> /etc/cron.d/`（活跃父目录符号链接）或
        // `./evil.txt -> ~/.ssh/authorized_keys2`（悬空文件符号链接）
        // 会导致写入逃逸出工作目录。
        if (currentPath === path) {
          const resolved = resolveDeepestExistingAncestorSync(fsImpl, path)
          if (resolved !== undefined) {
            pathSet.add(resolved)
          }
        }
        break
      }

      const stats = fsImpl.lstatSync(currentPath)

      // 跳过可能导致问题的特殊文件类型
      if (
        stats.isFIFO() ||
        stats.isSocket() ||
        stats.isCharacterDevice() ||
        stats.isBlockDevice()
      ) {
        break
      }

      if (!stats.isSymbolicLink()) {
        break // 非符号链接，停止链追踪
      }

      // 读取直接符号链接目标
      const target = fsImpl.readlinkSync(currentPath)

      // 若目标是相对路径，相对于符号链接所在目录解析
      const absoluteTarget = nodePath.isAbsolute(target)
        ? target
        : nodePath.resolve(nodePath.dirname(currentPath), target)

      // 将中间目标加入检查集合
      pathSet.add(absoluteTarget)
      currentPath = absoluteTarget // 继续追踪下一级
    }
  } catch {
    // 链追踪过程中任何错误，保留已收集的路径继续检查
  }

  // 用 realpathSync 补充最终解析路径，处理路径组件中剩余的符号链接
  const { resolvedPath, isSymlink } = safeResolvePath(fsImpl, path)
  if (isSymlink && resolvedPath !== path) {
    pathSet.add(resolvedPath)
  }

  return Array.from(pathSet)
}

/**
 * 基于 Node.js fs 模块的默认文件系统操作实现。
 * 所有同步操作均集成 slowLogging（慢操作记录），用于性能监控。
 */
export const NodeFsOperations: FsOperations = {
  cwd() {
    return process.cwd() // 返回 Node.js 进程的当前工作目录
  },

  existsSync(fsPath) {
    using _ = slowLogging`fs.existsSync(${fsPath})`
    return fs.existsSync(fsPath)
  },

  async stat(fsPath) {
    return statPromise(fsPath)
  },

  async readdir(fsPath) {
    return readdirPromise(fsPath, { withFileTypes: true }) // 返回含文件类型信息的 Dirent 数组
  },

  async unlink(fsPath) {
    return unlinkPromise(fsPath)
  },

  async rmdir(fsPath) {
    return rmdirPromise(fsPath)
  },

  async rm(fsPath, options) {
    return rmPromise(fsPath, options)
  },

  async mkdir(dirPath, options) {
    try {
      await mkdirPromise(dirPath, { recursive: true, ...options }) // 递归创建目录
    } catch (e) {
      // Bun/Windows 特殊情况：recursive:true 在带 FILE_ATTRIBUTE_READONLY 的目录上
      // 会抛出 EEXIST（组策略、OneDrive、desktop.ini 等场景）。
      // Bun 的 directoryExistsAt 错误地将 DIRECTORY+READONLY 判断为非目录
      // （bun 内部 src/sys.zig existsAtType）。目录实际存在，忽略此错误。
      // https://github.com/anthropics/claude-code/issues/30924
      if (getErrnoCode(e) !== 'EEXIST') throw e
    }
  },

  async readFile(fsPath, options) {
    return readFilePromise(fsPath, { encoding: options.encoding })
  },

  async rename(oldPath, newPath) {
    return renamePromise(oldPath, newPath)
  },

  statSync(fsPath) {
    using _ = slowLogging`fs.statSync(${fsPath})`
    return fs.statSync(fsPath)
  },

  lstatSync(fsPath) {
    using _ = slowLogging`fs.lstatSync(${fsPath})`
    return fs.lstatSync(fsPath) // 不跟随符号链接
  },

  readFileSync(fsPath, options) {
    using _ = slowLogging`fs.readFileSync(${fsPath})`
    return fs.readFileSync(fsPath, { encoding: options.encoding })
  },

  readFileBytesSync(fsPath) {
    using _ = slowLogging`fs.readFileBytesSync(${fsPath})`
    return fs.readFileSync(fsPath) // 返回 Buffer（无编码）
  },

  readSync(fsPath, options) {
    using _ = slowLogging`fs.readSync(${fsPath}, ${options.length} bytes)`
    let fd: number | undefined = undefined
    try {
      fd = fs.openSync(fsPath, 'r') // 以只读模式打开文件
      const buffer = Buffer.alloc(options.length)
      const bytesRead = fs.readSync(fd, buffer, 0, options.length, 0) // 从头读取
      return { buffer, bytesRead }
    } finally {
      if (fd) fs.closeSync(fd) // 确保文件描述符被关闭
    }
  },

  appendFileSync(path, data, options) {
    using _ = slowLogging`fs.appendFileSync(${path}, ${data.length} chars)`
    // 若指定了 mode，使用 'ax' 标志原子性创建文件（避免存在性检查与打开之间的 TOCTOU 竞争）
    // 若文件已存在（EEXIST），退回到普通 append
    if (options?.mode !== undefined) {
      try {
        const fd = fs.openSync(path, 'ax', options.mode) // 'ax'：原子性创建，文件已存在则失败
        try {
          fs.appendFileSync(fd, data)
        } finally {
          fs.closeSync(fd)
        }
        return
      } catch (e) {
        if (getErrnoCode(e) !== 'EEXIST') throw e
        // 文件已存在，退回到普通 append
      }
    }
    fs.appendFileSync(path, data)
  },

  copyFileSync(src, dest) {
    using _ = slowLogging`fs.copyFileSync(${src} → ${dest})`
    fs.copyFileSync(src, dest)
  },

  unlinkSync(path: string) {
    using _ = slowLogging`fs.unlinkSync(${path})`
    fs.unlinkSync(path)
  },

  renameSync(oldPath: string, newPath: string) {
    using _ = slowLogging`fs.renameSync(${oldPath} → ${newPath})`
    fs.renameSync(oldPath, newPath)
  },

  linkSync(target: string, path: string) {
    using _ = slowLogging`fs.linkSync(${target} → ${path})`
    fs.linkSync(target, path)
  },

  symlinkSync(
    target: string,
    path: string,
    type?: 'dir' | 'file' | 'junction',
  ) {
    using _ = slowLogging`fs.symlinkSync(${target} → ${path})`
    fs.symlinkSync(target, path, type)
  },

  readlinkSync(path: string) {
    using _ = slowLogging`fs.readlinkSync(${path})`
    return fs.readlinkSync(path)
  },

  realpathSync(path: string) {
    using _ = slowLogging`fs.realpathSync(${path})`
    return fs.realpathSync(path).normalize('NFC') // NFC 规范化，处理 macOS HFS+ 路径分解
  },

  mkdirSync(dirPath, options) {
    using _ = slowLogging`fs.mkdirSync(${dirPath})`
    const mkdirOptions: { recursive: boolean; mode?: number } = {
      recursive: true, // 始终使用递归模式
    }
    if (options?.mode !== undefined) {
      mkdirOptions.mode = options.mode
    }
    try {
      fs.mkdirSync(dirPath, mkdirOptions)
    } catch (e) {
      // 同 mkdir 的 EEXIST 处理：Bun/Windows 只读目录目录问题
      if (getErrnoCode(e) !== 'EEXIST') throw e
    }
  },

  readdirSync(dirPath) {
    using _ = slowLogging`fs.readdirSync(${dirPath})`
    return fs.readdirSync(dirPath, { withFileTypes: true }) // 返回含类型信息的 Dirent 数组
  },

  readdirStringSync(dirPath) {
    using _ = slowLogging`fs.readdirStringSync(${dirPath})`
    return fs.readdirSync(dirPath) // 返回字符串数组（不含类型信息）
  },

  isDirEmptySync(dirPath) {
    using _ = slowLogging`fs.isDirEmptySync(${dirPath})`
    const files = this.readdirSync(dirPath)
    return files.length === 0 // 无条目则目录为空
  },

  rmdirSync(dirPath) {
    using _ = slowLogging`fs.rmdirSync(${dirPath})`
    fs.rmdirSync(dirPath)
  },

  rmSync(path, options) {
    using _ = slowLogging`fs.rmSync(${path})`
    fs.rmSync(path, options)
  },

  createWriteStream(path: string) {
    return fs.createWriteStream(path) // 创建可写流（不记录 slowLogging，流操作自身管理）
  },

  async readFileBytes(fsPath: string, maxBytes?: number) {
    if (maxBytes === undefined) {
      return readFilePromise(fsPath) // 无限制：读取整个文件
    }
    // 有限制：通过 FileHandle 只读指定字节数，避免加载整个文件到内存
    const handle = await open(fsPath, 'r')
    try {
      const { size } = await handle.stat()
      const readSize = Math.min(size, maxBytes) // 实际读取量不超过文件大小
      const buffer = Buffer.allocUnsafe(readSize)
      let offset = 0
      while (offset < readSize) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          readSize - offset,
          offset,
        )
        if (bytesRead === 0) break // 文件提前结束
        offset += bytesRead
      }
      return offset < readSize ? buffer.subarray(0, offset) : buffer
    } finally {
      await handle.close() // 确保文件句柄被关闭
    }
  },
}

/** 当前活跃的文件系统实现，默认为 NodeFsOperations */
let activeFs: FsOperations = NodeFsOperations

/**
 * 替换当前使用的文件系统实现（测试/沙箱场景）。
 * 注意：不自动更新 cwd。
 *
 * @param implementation - 要使用的文件系统实现
 */
export function setFsImplementation(implementation: FsOperations): void {
  activeFs = implementation
}

/**
 * 获取当前活跃的文件系统实现。
 *
 * @returns 当前活跃的文件系统实现
 */
export function getFsImplementation(): FsOperations {
  return activeFs
}

/**
 * 将文件系统实现重置为默认 Node.js 实现。
 * 注意：不自动更新 cwd。
 */
export function setOriginalFsImplementation(): void {
  activeFs = NodeFsOperations
}

/**
 * 文件范围读取的结果类型。
 */
export type ReadFileRangeResult = {
  content: string    // 读取到的文件内容（UTF-8 字符串）
  bytesRead: number  // 实际读取的字节数
  bytesTotal: number // 文件总字节数
}

/**
 * 从文件的指定偏移位置读取最多 maxBytes 字节。
 * 返回独立分配的 Buffer 转字符串，不持有对更大 parent Buffer 的引用。
 * 若文件大小不超过 offset，返回 null。
 *
 * @param path - 文件路径
 * @param offset - 读取起始位置（字节偏移）
 * @param maxBytes - 最大读取字节数
 * @returns 读取结果，或 null（文件小于 offset）
 */
export async function readFileRange(
  path: string,
  offset: number,
  maxBytes: number,
): Promise<ReadFileRangeResult | null> {
  await using fh = await open(path, 'r') // 使用 await using 确保文件句柄自动关闭
  const size = (await fh.stat()).size
  if (size <= offset) {
    return null // 文件大小不超过偏移量，无内容可读
  }
  const bytesToRead = Math.min(size - offset, maxBytes) // 实际可读字节数
  const buffer = Buffer.allocUnsafe(bytesToRead)

  let totalRead = 0
  while (totalRead < bytesToRead) {
    const { bytesRead } = await fh.read(
      buffer,
      totalRead,
      bytesToRead - totalRead,
      offset + totalRead, // 文件中的读取位置
    )
    if (bytesRead === 0) {
      break // 读到文件末尾
    }
    totalRead += bytesRead
  }

  return {
    content: buffer.toString('utf8', 0, totalRead), // 转换为 UTF-8 字符串
    bytesRead: totalRead,
    bytesTotal: size,
  }
}

/**
 * 读取文件的最后 maxBytes 字节。
 * 若文件小于 maxBytes，返回整个文件内容。
 *
 * @param path - 文件路径
 * @param maxBytes - 最大读取字节数（从文件末尾）
 * @returns 读取结果（含内容、读取字节数、文件总字节数）
 */
export async function tailFile(
  path: string,
  maxBytes: number,
): Promise<ReadFileRangeResult> {
  await using fh = await open(path, 'r')
  const size = (await fh.stat()).size
  if (size === 0) {
    return { content: '', bytesRead: 0, bytesTotal: 0 } // 空文件
  }
  const offset = Math.max(0, size - maxBytes) // 计算读取起始位置（不小于 0）
  const bytesToRead = size - offset
  const buffer = Buffer.allocUnsafe(bytesToRead)

  let totalRead = 0
  while (totalRead < bytesToRead) {
    const { bytesRead } = await fh.read(
      buffer,
      totalRead,
      bytesToRead - totalRead,
      offset + totalRead,
    )
    if (bytesRead === 0) {
      break // 读到文件末尾
    }
    totalRead += bytesRead
  }

  return {
    content: buffer.toString('utf8', 0, totalRead),
    bytesRead: totalRead,
    bytesTotal: size,
  }
}

/**
 * 异步生成器：以反向顺序（从末尾到开头）逐行 yield 文件内容。
 * 以分块方式从文件末尾向前读取，避免将整个文件加载到内存。
 *
 * 【跨块边界的 UTF-8 处理】
 * remainder 保存原始字节（非解码字符串），确保跨 4KB 边界的多字节 UTF-8 序列
 * 不被损坏（否则两侧都会出现 U+FFFD，导致 history.jsonl 的 JSON.parse 失败）。
 *
 * @param path - 要读取的文件路径
 * @yields 文件中的每一行（从最后一行到第一行）
 */
export async function* readLinesReverse(
  path: string,
): AsyncGenerator<string, void, undefined> {
  const CHUNK_SIZE = 1024 * 4 // 每次读取 4KB
  const fileHandle = await open(path, 'r')
  try {
    const stats = await fileHandle.stat()
    let position = stats.size // 从文件末尾开始
    // remainder 保存跨块边界的原始字节，避免 UTF-8 多字节序列被截断
    let remainder = Buffer.alloc(0)
    const buffer = Buffer.alloc(CHUNK_SIZE)

    while (position > 0) {
      const currentChunkSize = Math.min(CHUNK_SIZE, position)
      position -= currentChunkSize // 向前移动读取位置

      await fileHandle.read(buffer, 0, currentChunkSize, position) // 读取当前块
      // 将当前块与上次的 remainder 合并（remainder 是前面块的字节）
      const combined = Buffer.concat([
        buffer.subarray(0, currentChunkSize),
        remainder,
      ])

      // 查找第一个换行符，区分已完整的行和跨块边界的不完整行
      const firstNewline = combined.indexOf(0x0a)
      if (firstNewline === -1) {
        // 没有换行符：整个合并内容是一个不完整的行，继续向前读
        remainder = combined
        continue
      }

      // firstNewline 之前的字节是不完整行的剩余部分（留待下次合并）
      remainder = Buffer.from(combined.subarray(0, firstNewline))
      // firstNewline 之后是完整的行，转为字符串并按换行分割
      const lines = combined.toString('utf8', firstNewline + 1).split('\n')

      // 从后向前 yield 各行（维持反向顺序）
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!
        if (line) {
          yield line // 跳过空行
        }
      }
    }

    // 处理文件开头剩余的不完整行（第一行）
    if (remainder.length > 0) {
      yield remainder.toString('utf8')
    }
  } finally {
    await fileHandle.close() // 确保文件句柄被关闭
  }
}
