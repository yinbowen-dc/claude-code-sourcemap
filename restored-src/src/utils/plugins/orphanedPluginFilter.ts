/**
 * 孤立插件版本目录过滤模块。
 *
 * 在 Claude Code 插件系统流程中，本文件处于"搜索安全过滤"层：
 *   - 插件更新后，旧版本目录不会立即删除（并发会话可能仍在引用），
 *     而是打上 .orphaned_at 标记文件，7 天后由 GC 清理；
 *   - 若 ripgrep 的 Grep/Glob 命中孤立版本目录中的文件，
 *     Claude 可能会使用过时的插件代码，导致行为异常；
 *   - 本模块通过单次 ripgrep 调用找出所有 .orphaned_at 标记，
 *     生成 --glob '!<dir>/**' 排除模式，供 Grep/Glob 工具传入 ripgrep；
 *   - 排除列表在 main.tsx 的孤立版本 GC 完成后预热，会话期间冻结（
 *     除非 /reload-plugins 显式清除）。
 *
 * 主要导出：
 *   - getGlobExclusionsForPluginCache(searchPath?)：获取孤立目录的 ripgrep 排除模式列表
 *   - clearPluginCacheExclusions()：清除会话级缓存（由 /reload-plugins 调用）
 */

import { dirname, isAbsolute, join, normalize, relative, sep } from 'path'
import { ripGrep } from '../ripgrep.js'
import { getPluginsDirectory } from './pluginDirectories.js'

// 孤立标记文件名（与 cacheUtils.ts 保持一致，内联以避免循环依赖）
const ORPHANED_AT_FILENAME = '.orphaned_at'

/** 会话级排除缓存：一旦计算完成即冻结，只有显式 /reload-plugins 才会清除。 */
let cachedExclusions: string[] | null = null

/**
 * 获取孤立插件版本目录对应的 ripgrep glob 排除模式列表。
 *
 * 执行流程：
 *   1. 计算插件缓存目录（<pluginsDir>/cache）的规范化路径；
 *   2. 若提供了 searchPath，检查其是否与缓存目录存在路径重叠：
 *      若完全不重叠，直接返回空数组（避免为无关搜索添加多余 --glob 参数）；
 *   3. 若会话缓存已存在，直接返回；
 *   4. 调用 ripgrep（--files --hidden --no-ignore --max-depth 4 --glob .orphaned_at）
 *      在缓存目录内查找所有孤立标记文件；
 *   5. 将每个标记文件的父目录（即孤立版本目录）转换为相对路径，
 *      生成 `!**/<relPath>/**` 格式的排除模式；
 *   6. 若 ripgrep 失败，静默返回空数组（尽力而为，不影响核心搜索功能）。
 *
 * @param searchPath 可选的搜索路径，用于判断是否需要返回排除模式
 * @returns ripgrep glob 排除模式数组（如 `['!**/cache/mp/plugin/v1/**']`）
 */
export async function getGlobExclusionsForPluginCache(
  searchPath?: string,
): Promise<string[]> {
  // 插件缓存目录的规范化路径（如 ~/.claude/plugins/cache）
  const cachePath = normalize(join(getPluginsDirectory(), 'cache'))

  // 若搜索路径与插件缓存目录无重叠，排除模式对此次搜索无意义，直接返回空数组
  if (searchPath && !pathsOverlap(searchPath, cachePath)) {
    return []
  }

  // 命中会话级缓存，直接复用（排除列表在会话期间固定不变）
  if (cachedExclusions !== null) {
    return cachedExclusions
  }

  try {
    // 在插件缓存目录内查找所有 .orphaned_at 标记文件。
    // --hidden：标记文件是点文件，需显式包含；
    // --no-ignore：防止 .gitignore 意外隐藏标记文件；
    // --max-depth 4：标记位于 cache/<marketplace>/<plugin>/<version>/.orphaned_at，
    //   不需要递归进入插件内容（node_modules 等）；
    // AbortController 信号：此处不需要取消，使用永不中止的信号。
    const markers = await ripGrep(
      [
        '--files',
        '--hidden',
        '--no-ignore',
        '--max-depth',
        '4',
        '--glob',
        ORPHANED_AT_FILENAME,
      ],
      cachePath,
      new AbortController().signal, // 永不取消的信号
    )

    // 将每个标记文件路径转换为对应版本目录的排除模式
    cachedExclusions = markers.map(markerPath => {
      // ripgrep 可能返回绝对路径或相对路径，统一转换为相对路径
      const versionDir = dirname(markerPath) // 标记文件所在的版本目录
      const rel = isAbsolute(versionDir)
        ? relative(cachePath, versionDir) // 绝对路径：转为相对于缓存目录的路径
        : versionDir // 已是相对路径：直接使用
      // ripgrep 的 glob 模式始终使用正斜杠（即使在 Windows 上）
      const posixRelative = rel.replace(/\\/g, '/')
      // 排除该版本目录下的所有文件和子目录
      return `!**/${posixRelative}/**`
    })
    return cachedExclusions
  } catch {
    // 尽力而为：ripgrep 失败不应破坏核心搜索工具
    // 将缓存设为空数组，避免每次请求都重试失败的 ripgrep 调用
    cachedExclusions = []
    return cachedExclusions
  }
}

/**
 * 清除会话级孤立目录排除缓存。
 *
 * 由 /reload-plugins 命令调用，确保重新加载插件时重新扫描孤立目录。
 */
export function clearPluginCacheExclusions(): void {
  cachedExclusions = null
}

/**
 * 判断两个路径是否存在包含关系（一个是另一个的前缀）。
 *
 * 特殊处理：
 *   - 根路径（normalize('/') + sep = '//'）需特殊处理；
 *   - Windows 上不区分大小写（normalize() 不会将驱动器字母转为小写，
 *     而 CLAUDE_CODE_PLUGIN_CACHE_DIR 中的路径可能与解析后路径大小写不一致）。
 *
 * @param a 第一个路径
 * @param b 第二个路径
 * @returns 两路径相同、互为前缀或任一为根路径时返回 true
 */
function pathsOverlap(a: string, b: string): boolean {
  const na = normalizeForCompare(a) // 规范化路径 a（含平台大小写处理）
  const nb = normalizeForCompare(b) // 规范化路径 b
  return (
    na === nb || // 路径完全相同
    na === sep || // a 是根目录（覆盖所有路径）
    nb === sep || // b 是根目录（覆盖所有路径）
    na.startsWith(nb + sep) || // b 是 a 的父目录
    nb.startsWith(na + sep) // a 是 b 的父目录
  )
}

/**
 * 规范化路径以便进行平台一致的比较。
 * 在 Windows 上转为小写以实现大小写不敏感的比较。
 */
function normalizeForCompare(p: string): string {
  const n = normalize(p)
  // Windows 文件系统不区分大小写，统一转小写避免驱动器字母大小写差异
  return process.platform === 'win32' ? n.toLowerCase() : n
}
