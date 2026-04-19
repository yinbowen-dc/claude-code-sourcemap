/**
 * 市场来源输入解析模块。
 *
 * 在 Claude Code 插件系统流程中，本文件处于"市场添加"入口层：
 *   - 当用户在 /plugins marketplace 界面中输入市场地址时，
 *     本模块将用户输入的字符串解析为 MarketplaceSource 对象；
 *   - marketplaceManager.ts 的 addMarketplaceSource() 会将解析结果用于
 *     实际的 git clone / URL 拉取 / 本地挂载操作；
 *   - 支持多种输入格式：SSH URL、HTTPS/HTTP URL、GitHub 简写（owner/repo）、
 *     本地文件路径（.json）、本地目录路径。
 *
 * 主要导出：
 *   - parseMarketplaceInput(input)：将用户输入字符串解析为 MarketplaceSource
 */

import { homedir } from 'os'
import { resolve } from 'path'
import { getErrnoCode } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import type { MarketplaceSource } from './schemas.js'

/**
 * 将市场来源输入字符串解析为对应的 MarketplaceSource 类型。
 *
 * 支持以下输入格式（按优先级顺序检测）：
 *
 * 1. **Git SSH URL**：`user@host:path[.git][#ref]`
 *    - 标准格式：`git@github.com:owner/repo.git`
 *    - GitHub Enterprise SSH 证书：`org-123456@github.com:owner/repo.git`
 *    - 自定义用户名：`deploy@gitlab.com:group/project.git`
 *    - 自托管：`user@192.168.10.123:path/to/repo`
 *    → 返回 `{ source: 'git', url, ref? }`
 *
 * 2. **HTTP/HTTPS URL**：`http://` 或 `https://` 开头
 *    - `.git` 后缀 或 `/_git/`（Azure DevOps）路径 → `{ source: 'git', url, ref? }`
 *    - github.com 主机名 → 规范化为带 .git 后缀的 git 源
 *    - 其他 URL → `{ source: 'url', url }`
 *
 * 3. **本地路径**：`./`、`../`、`/`、`~` 开头，或 Windows 特定格式
 *    - stat 路径：文件（.json）→ `{ source: 'file', path }`；目录 → `{ source: 'directory', path }`
 *    - 路径不存在或无法访问 → `{ error: string }`
 *
 * 4. **GitHub 简写**：`owner/repo[#ref|@ref]`（不以 @ 开头，含 /，不含 :）
 *    → 返回 `{ source: 'github', repo, ref? }`
 *
 * 5. **无法识别的格式**（含 NPM 包名等）→ 返回 `null`
 *
 * @param input 用户输入的市场来源字符串
 * @returns MarketplaceSource 对象、包含错误信息的对象，或 null（格式无法识别）
 */
export async function parseMarketplaceInput(
  input: string,
): Promise<MarketplaceSource | { error: string } | null> {
  // 去除首尾空白，以防用户粘贴时带有多余空格
  const trimmed = input.trim()
  const fs = getFsImplementation()

  // ── 第一步：检测 Git SSH URL ──
  // 格式：user@host:path[.git][#ref]
  // 用户名可包含：字母、数字、点、下划线、连字符
  // 支持 GitHub Enterprise SSH 证书（如 org-123456@github.com）
  const sshMatch = trimmed.match(
    /^([a-zA-Z0-9._-]+@[^:]+:.+?(?:\.git)?)(#(.+))?$/,
  )
  if (sshMatch?.[1]) {
    const url = sshMatch[1] // SSH URL 主体（不含 #ref）
    const ref = sshMatch[3] // 可选的分支/标签/提交（# 后的部分）
    // 有 ref 时包含 ref 字段，否则省略
    return ref ? { source: 'git', url, ref } : { source: 'git', url }
  }

  // ── 第二步：检测 HTTP/HTTPS URL ──
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    // 提取 URL 中的片段（ref），格式：http://...#ref
    const fragmentMatch = trimmed.match(/^([^#]+)(#(.+))?$/)
    const urlWithoutFragment = fragmentMatch?.[1] || trimmed // 不含 # 片段的 URL
    const ref = fragmentMatch?.[3] // 可选的 ref（# 后的部分）

    // 显式 HTTPS/HTTP URL 若以 .git 结尾或包含 /_git/ 路径，则视为 git 仓库来源。
    // .git 后缀是 GitHub/GitLab/Bitbucket 的约定；
    // /_git/ 是 Azure DevOps 的路径格式（追加 .git 会导致 TF401019 错误，
    // 因此必须单独识别，而不是依赖 .git 后缀检测）。
    if (
      urlWithoutFragment.endsWith('.git') ||
      urlWithoutFragment.includes('/_git/')
    ) {
      return ref
        ? { source: 'git', url: urlWithoutFragment, ref }
        : { source: 'git', url: urlWithoutFragment }
    }

    // 尝试解析 URL 对象以检查主机名
    let url: URL
    try {
      url = new URL(urlWithoutFragment)
    } catch (_err) {
      // URL 解析失败（格式非法）：作为通用 URL 来源处理
      return { source: 'url', url: urlWithoutFragment }
    }

    // github.com 的 HTTPS URL：转换为 git 来源并确保有 .git 后缀
    if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
      const match = url.pathname.match(/^\/([^/]+\/[^/]+?)(\/|\.git|$)/)
      if (match?.[1]) {
        // 用户明确提供了 HTTPS URL，保持 HTTPS 形式（通过 'git' 类型克隆）
        // 若无 .git 后缀则追加，以确保 git clone 可正常工作
        const gitUrl = urlWithoutFragment.endsWith('.git')
          ? urlWithoutFragment
          : `${urlWithoutFragment}.git`
        return ref
          ? { source: 'git', url: gitUrl, ref }
          : { source: 'git', url: gitUrl }
      }
    }

    // 其他 HTTPS/HTTP URL：作为 marketplace.json 的直接 URL 来源（fetch 而非 clone）
    return { source: 'url', url: urlWithoutFragment }
  }

  // ── 第三步：检测本地路径 ──
  // 在 Windows 上同时识别反斜杠相对路径（.\, ..\）和驱动器字母路径（C:\）
  // 注意：反斜杠在 Unix 上是合法文件名字符，因此只在 Windows 上特殊处理
  const isWindows = process.platform === 'win32'
  const isWindowsPath =
    isWindows &&
    (trimmed.startsWith('.\\') ||
      trimmed.startsWith('..\\') ||
      /^[a-zA-Z]:[/\\]/.test(trimmed)) // Windows 驱动器字母格式（如 C:\...）
  if (
    trimmed.startsWith('./') || // Unix 相对路径（当前目录）
    trimmed.startsWith('../') || // Unix 相对路径（父目录）
    trimmed.startsWith('/') || // Unix 绝对路径
    trimmed.startsWith('~') || // 波浪号展开的 home 目录
    isWindowsPath // Windows 特定路径格式
  ) {
    // 解析为绝对路径，处理波浪号展开（~ → homedir）
    const resolvedPath = resolve(
      trimmed.startsWith('~') ? trimmed.replace(/^~/, homedir()) : trimmed,
    )

    // 对路径执行 stat 以判断是文件还是目录。
    // 捕获所有 stat 错误（ENOENT、EACCES、EPERM 等），返回错误对象而非抛出，
    // 与旧版 existsSync 的行为一致（existsSync 从不抛出异常）。
    let stats
    try {
      stats = await fs.stat(resolvedPath)
    } catch (e: unknown) {
      const code = getErrnoCode(e) // 提取 errno 错误码（如 'ENOENT'）
      return {
        error:
          code === 'ENOENT'
            ? `Path does not exist: ${resolvedPath}` // 路径不存在
            : `Cannot access path: ${resolvedPath} (${code ?? e})`, // 无法访问
      }
    }

    if (stats.isFile()) {
      // 文件类型：只接受 .json 格式（marketplace.json）
      if (resolvedPath.endsWith('.json')) {
        return { source: 'file', path: resolvedPath }
      } else {
        // 非 .json 文件：返回错误（用户可能误传了错误文件）
        return {
          error: `File path must point to a .json file (marketplace.json), but got: ${resolvedPath}`,
        }
      }
    } else if (stats.isDirectory()) {
      // 目录类型：作为本地目录市场来源
      return { source: 'directory', path: resolvedPath }
    } else {
      // 既非文件也非目录（如符号链接指向的特殊设备文件）
      return {
        error: `Path is neither a file nor a directory: ${resolvedPath}`,
      }
    }
  }

  // ── 第四步：检测 GitHub 简写格式 ──
  // 格式：owner/repo[#ref] 或 owner/repo[@ref]
  // 同时接受 # 和 @ 作为 ref 分隔符：
  //   # 是 Git 传统约定；
  //   @ 是本插件显示格式，用户从错误信息或托管设置中复制时可能使用 @。
  if (trimmed.includes('/') && !trimmed.startsWith('@')) {
    // 含冒号的格式不是 GitHub 简写（可能是未识别的其他协议）
    if (trimmed.includes(':')) {
      return null
    }
    // 提取 ref 部分（支持 #ref 或 @ref 两种格式）
    const fragmentMatch = trimmed.match(/^([^#@]+)(?:[#@](.+))?$/)
    const repo = fragmentMatch?.[1] || trimmed // owner/repo 部分
    const ref = fragmentMatch?.[2] // 可选的分支/标签/提交
    // 假设为 GitHub 仓库（owner/repo 格式），生成 github 来源
    return ref ? { source: 'github', repo, ref } : { source: 'github', repo }
  }

  // ── 第五步：无法识别的格式 ──
  // NPM 包名等尚未实现的格式，返回 null 让调用方决定如何处理
  return null
}
