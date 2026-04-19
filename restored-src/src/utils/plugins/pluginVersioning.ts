/**
 * 插件版本计算模块 — Claude Code 插件缓存版本管理层
 *
 * 在 Claude Code 插件系统中，此文件负责为插件计算版本字符串，版本用于：
 *   - 构建版本化缓存路径（~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/）
 *   - 检测插件是否需要更新
 *   - 区分同一仓库不同子目录的 git-subdir 插件
 *
 * 版本来源优先级（从高到低）：
 *   1. plugin.json 中的 version 字段（最高优先级）
 *   2. 调用方提供的 providedVersion（通常来自市场条目）
 *   3. 预解析的 gitCommitSha（git-subdir 类型会编码子目录路径哈希）
 *   4. 从安装路径读取 git HEAD SHA
 *   5. 'unknown'（最终兜底）
 *
 * git-subdir 特殊处理：
 *   同一仓库的不同子目录在同一 commit 下会有相同 SHA，需要附加子目录路径的 sha256 前 8 位
 *   以区分缓存键（与 squashfs 构建脚本的路径规范化规则保持字节对齐）。
 */

import { createHash } from 'crypto'
import { logForDebugging } from '../debug.js'
import { getHeadForDir } from '../git/gitFilesystem.js'
import type { PluginManifest, PluginSource } from './schemas.js'

/**
 * 根据插件来源计算版本字符串。
 *
 * 版本计算流程：
 *   1. 优先使用 plugin.json 中的 manifest.version
 *   2. 其次使用调用方提供的 providedVersion（通常来自市场条目）
 *   3. 若有预解析的 gitCommitSha：
 *      - git-subdir 类型：版本 = shortSha(12位) + '-' + pathHash(8位)
 *        其中 pathHash 是规范化子目录路径的 sha256 前 8 位
 *      - 其他类型：版本 = shortSha(12位)
 *   4. 若有 installPath，尝试读取其 git HEAD SHA
 *   5. 以上均无效时，返回 'unknown'
 *
 * @param pluginId - 插件标识符（如 "plugin@marketplace"）
 * @param source - 插件来源配置（git-subdir 类型需要此参数做路径哈希）
 * @param manifest - 可选的插件清单（含 version 字段）
 * @param installPath - 可选的安装路径（用于从 .git 读取 HEAD SHA）
 * @param providedVersion - 可选的预提供版本（来自市场条目或调用方）
 * @param gitCommitSha - 可选的预解析 git SHA（用于 git-subdir 等克隆后丢弃的场景）
 * @returns 版本字符串（semver、short SHA 或 'unknown'）
 */
export async function calculatePluginVersion(
  pluginId: string,
  source: PluginSource,
  manifest?: PluginManifest,
  installPath?: string,
  providedVersion?: string,
  gitCommitSha?: string,
): Promise<string> {
  // 优先级 1：使用 plugin.json 中声明的明确版本
  if (manifest?.version) {
    logForDebugging(
      `Using manifest version for ${pluginId}: ${manifest.version}`,
    )
    return manifest.version
  }

  // 优先级 2：使用调用方提供的版本（通常来自市场条目）
  if (providedVersion) {
    logForDebugging(
      `Using provided version for ${pluginId}: ${providedVersion}`,
    )
    return providedVersion
  }

  // 优先级 3：使用预解析的 git SHA（克隆已被丢弃，installPath 无 .git）
  if (gitCommitSha) {
    // 取 SHA 前 12 位作为短版本
    const shortSha = gitCommitSha.substring(0, 12)
    if (typeof source === 'object' && source.source === 'git-subdir') {
      // git-subdir 类型：同一仓库不同子目录会有相同 SHA，需要编码子目录路径
      // 以确保缓存键唯一。路径规范化规则必须与 squashfs 构建脚本字节对齐：
      //   1. 反斜杠 → 正斜杠
      //   2. 去掉开头的 './'
      //   3. 去掉结尾的所有 '/'
      //   4. UTF-8 sha256，取前 8 位十六进制
      const normPath = source.path
        .replace(/\\/g, '/')   // 统一路径分隔符
        .replace(/^\.\//, '')  // 去掉 './' 前缀
        .replace(/\/+$/, '')   // 去掉尾部斜杠
      const pathHash = createHash('sha256')
        .update(normPath)
        .digest('hex')
        .substring(0, 8)   // 取前 8 位十六进制
      const v = `${shortSha}-${pathHash}`
      logForDebugging(
        `Using git-subdir SHA+path version for ${pluginId}: ${v} (path=${normPath})`,
      )
      return v
    }
    // 非 git-subdir 类型：直接使用 12 位短 SHA
    logForDebugging(`Using pre-resolved git SHA for ${pluginId}: ${shortSha}`)
    return shortSha
  }

  // 优先级 4：从安装路径读取 git HEAD SHA
  if (installPath) {
    const sha = await getGitCommitSha(installPath)
    if (sha) {
      const shortSha = sha.substring(0, 12)
      logForDebugging(`Using git SHA for ${pluginId}: ${shortSha}`)
      return shortSha
    }
  }

  // 优先级 5（兜底）：无法确定版本，使用 'unknown'
  logForDebugging(`No version found for ${pluginId}, using 'unknown'`)
  return 'unknown'
}

/**
 * 获取指定目录的 git commit SHA。
 *
 * 委托给 getHeadForDir（git/gitFilesystem.ts），读取目录的 .git/HEAD 引用。
 *
 * @param dirPath - 目录路径（应为 git 仓库根目录或其子目录）
 * @returns 完整的 commit SHA 字符串，若非 git 仓库则返回 null
 */
export function getGitCommitSha(dirPath: string): Promise<string | null> {
  return getHeadForDir(dirPath)
}

/**
 * 从版本化缓存路径中提取版本字符串。
 *
 * 版本化路径格式：~/.claude/plugins/cache/{marketplace}/{plugin}/{version}/
 * 例如：/home/user/.claude/plugins/cache/official/my-plugin/1.0.0
 * 返回：'1.0.0'
 *
 * @param installPath - 插件安装的完整路径
 * @returns 从路径中提取的版本字符串，若非版本化路径则返回 null
 */
export function getVersionFromPath(installPath: string): string | null {
  // 按路径分隔符拆分，过滤空段
  const parts = installPath.split('/').filter(Boolean)

  // 找到 'cache' 段的位置（其父段必须为 'plugins'）
  const cacheIndex = parts.findIndex(
    (part, i) => part === 'cache' && parts[i - 1] === 'plugins',
  )

  if (cacheIndex === -1) {
    // 未找到 'plugins/cache' 结构，非版本化路径
    return null
  }

  // cache 之后有 3 个部分：marketplace/plugin/version
  const componentsAfterCache = parts.slice(cacheIndex + 1)
  if (componentsAfterCache.length >= 3) {
    // 第三个部分（索引 2）即为版本字符串
    return componentsAfterCache[2] || null
  }

  return null
}

/**
 * 检查路径是否为版本化插件路径。
 *
 * @param path - 待检查的路径
 * @returns 若符合版本化路径结构则返回 true
 */
export function isVersionedPath(path: string): boolean {
  return getVersionFromPath(path) !== null
}
