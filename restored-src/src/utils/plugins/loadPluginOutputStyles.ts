/**
 * 插件输出样式加载模块。
 *
 * 在 Claude Code 插件系统流程中，本文件处于"插件功能扩展"层：
 *   - 插件可以在 manifest.json 中声明 outputStylesPath / outputStylesPaths 字段，
 *     指向包含 .md 文件的目录（或单个 .md 文件），每个文件对应一种输出样式配置；
 *   - 本模块遍历所有已启用插件，读取并解析其输出样式文件（支持 YAML frontmatter），
 *     将样式名称命名空间化为 "pluginName:styleName" 格式；
 *   - 使用 lodash memoize 缓存加载结果，避免重复 I/O；
 *   - clearPluginOutputStyleCache() 在 /reload-plugins 时清除缓存。
 *
 * 主要导出：
 *   - loadPluginOutputStyles()：（memoized）加载所有已启用插件的输出样式
 *   - clearPluginOutputStyleCache()：清除 memoize 缓存
 */

import memoize from 'lodash-es/memoize.js'
import { basename } from 'path'
import type { OutputStyleConfig } from '../../constants/outputStyles.js'
import { getPluginErrorMessage } from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import {
  coerceDescriptionToString,
  parseFrontmatter,
} from '../frontmatterParser.js'
import { getFsImplementation, isDuplicatePath } from '../fsOperations.js'
import { extractDescriptionFromMarkdown } from '../markdownConfigLoader.js'
import { loadAllPluginsCacheOnly } from './pluginLoader.js'
import { walkPluginMarkdown } from './walkPluginMarkdown.js'

/**
 * 从指定目录加载所有输出样式配置。
 *
 * 使用 walkPluginMarkdown 递归遍历目录下的所有 .md 文件，
 * 对每个文件调用 loadOutputStyleFromFile 解析样式配置。
 * 通过 loadedPaths Set 跟踪已处理的文件路径，防止重复加载。
 *
 * @param outputStylesPath 输出样式目录的绝对路径
 * @param pluginName 插件名称，用于命名空间化样式名
 * @param loadedPaths 已加载路径集合，用于去重
 * @returns 该目录下所有解析成功的 OutputStyleConfig 数组
 */
async function loadOutputStylesFromDirectory(
  outputStylesPath: string,
  pluginName: string,
  loadedPaths: Set<string>,
): Promise<OutputStyleConfig[]> {
  const styles: OutputStyleConfig[] = []
  // walkPluginMarkdown 递归遍历目录，对每个 .md 文件回调
  await walkPluginMarkdown(
    outputStylesPath,
    async fullPath => {
      // 解析单个 .md 文件为输出样式配置
      const style = await loadOutputStyleFromFile(
        fullPath,
        pluginName,
        loadedPaths,
      )
      // 仅收集解析成功的样式（null 表示重复路径或解析失败）
      if (style) styles.push(style)
    },
    { logLabel: 'output-styles' },
  )
  return styles
}

/**
 * 解析单个 .md 文件为输出样式配置对象。
 *
 * 执行流程：
 *   1. 检查路径是否已处理（通过 isDuplicatePath 去重）；
 *   2. 读取文件内容，解析 YAML frontmatter；
 *   3. 从 frontmatter 提取样式名（name 字段，默认文件名）；
 *   4. 将样式名命名空间化为 "pluginName:styleName"；
 *   5. 提取描述（frontmatter.description > Markdown 首段 > 默认描述）；
 *   6. 解析 force-for-plugin 标志（支持布尔值和字符串两种形式）；
 *   7. 返回完整的 OutputStyleConfig 对象。
 *
 * @param filePath .md 文件的绝对路径
 * @param pluginName 插件名称，用于命名空间化
 * @param loadedPaths 已加载路径集合，用于去重
 * @returns 解析成功的 OutputStyleConfig，或 null（重复/失败）
 */
async function loadOutputStyleFromFile(
  filePath: string,
  pluginName: string,
  loadedPaths: Set<string>,
): Promise<OutputStyleConfig | null> {
  const fs = getFsImplementation()
  // 检测重复路径（如符号链接指向同一文件），避免同一样式被加载两次
  if (isDuplicatePath(fs, filePath, loadedPaths)) {
    return null
  }
  try {
    // 读取 .md 文件全文内容
    const content = await fs.readFile(filePath, { encoding: 'utf-8' })
    // 解析 YAML frontmatter，返回 { frontmatter, content: markdownContent }
    const { frontmatter, content: markdownContent } = parseFrontmatter(
      content,
      filePath,
    )

    // 样式基础名：优先使用 frontmatter.name，其次使用文件名（不含 .md 后缀）
    const fileName = basename(filePath, '.md')
    const baseStyleName = (frontmatter.name as string) || fileName
    // 命名空间化：与插件命令和 Agent 保持一致，格式为 "pluginName:styleName"
    const name = `${pluginName}:${baseStyleName}`

    // 提取描述：frontmatter.description > Markdown 首段 > 默认占位描述
    const description =
      coerceDescriptionToString(frontmatter.description, name) ??
      extractDescriptionFromMarkdown(
        markdownContent,
        `Output style from ${pluginName} plugin`,
      )

    // 解析 force-for-plugin 标志（控制是否强制将此样式应用于所有插件输出）
    // 支持布尔值（true/false）和字符串（"true"/"false"）两种 YAML 值形式
    const forceRaw = frontmatter['force-for-plugin']
    const forceForPlugin =
      forceRaw === true || forceRaw === 'true'
        ? true
        : forceRaw === false || forceRaw === 'false'
          ? false
          : undefined // 未设置时为 undefined（不强制）

    return {
      name,
      description,
      prompt: markdownContent.trim(), // 样式指令内容（去除首尾空白）
      source: 'plugin', // 标记来源为插件（区别于内置样式）
      forceForPlugin,
    }
  } catch (error) {
    // 解析失败：记录错误日志并返回 null（不影响其他样式的加载）
    logForDebugging(`Failed to load output style from ${filePath}: ${error}`, {
      level: 'error',
    })
    return null
  }
}

/**
 * 加载所有已启用插件的输出样式配置。（memoized，会话期间只执行一次）
 *
 * 执行流程：
 *   1. 通过 loadAllPluginsCacheOnly() 获取已启用插件列表（含加载错误）；
 *   2. 记录加载错误（不中断流程）；
 *   3. 对每个插件：
 *      a. 使用 loadedPaths Set 跟踪已处理路径（防止跨路径重复）；
 *      b. 加载默认输出样式目录（plugin.outputStylesPath）；
 *      c. 加载 manifest 中额外声明的路径（plugin.outputStylesPaths），
 *         支持目录（批量加载）和单个 .md 文件；
 *   4. 返回所有插件的全部输出样式配置数组。
 */
export const loadPluginOutputStyles = memoize(
  async (): Promise<OutputStyleConfig[]> => {
    // 获取已启用插件列表（仅读取缓存，不触发新的插件加载）
    const { enabled, errors } = await loadAllPluginsCacheOnly()
    const allStyles: OutputStyleConfig[] = []

    // 记录插件加载错误，但不中断输出样式加载流程
    if (errors.length > 0) {
      logForDebugging(
        `Plugin loading errors: ${errors.map(e => getPluginErrorMessage(e)).join(', ')}`,
      )
    }

    for (const plugin of enabled) {
      // 每个插件维护独立的已加载路径集合，防止同一插件内的重复加载
      const loadedPaths = new Set<string>()

      // ── 加载默认输出样式目录 ──
      if (plugin.outputStylesPath) {
        try {
          const styles = await loadOutputStylesFromDirectory(
            plugin.outputStylesPath,
            plugin.name,
            loadedPaths,
          )
          allStyles.push(...styles)

          // 记录成功加载的样式数量（用于调试）
          if (styles.length > 0) {
            logForDebugging(
              `Loaded ${styles.length} output styles from plugin ${plugin.name} default directory`,
            )
          }
        } catch (error) {
          // 目录加载失败：记录错误，继续处理其他路径
          logForDebugging(
            `Failed to load output styles from plugin ${plugin.name} default directory: ${error}`,
            { level: 'error' },
          )
        }
      }

      // ── 加载 manifest 中额外声明的自定义路径 ──
      if (plugin.outputStylesPaths) {
        for (const stylePath of plugin.outputStylesPaths) {
          try {
            const fs = getFsImplementation()
            // stat 以判断路径类型（目录或单文件）
            const stats = await fs.stat(stylePath)

            if (stats.isDirectory()) {
              // 目录：批量加载目录下所有 .md 文件
              const styles = await loadOutputStylesFromDirectory(
                stylePath,
                plugin.name,
                loadedPaths,
              )
              allStyles.push(...styles)

              if (styles.length > 0) {
                logForDebugging(
                  `Loaded ${styles.length} output styles from plugin ${plugin.name} custom path: ${stylePath}`,
                )
              }
            } else if (stats.isFile() && stylePath.endsWith('.md')) {
              // 单个 .md 文件：直接加载
              const style = await loadOutputStyleFromFile(
                stylePath,
                plugin.name,
                loadedPaths,
              )
              if (style) {
                allStyles.push(style)
                logForDebugging(
                  `Loaded output style from plugin ${plugin.name} custom file: ${stylePath}`,
                )
              }
            }
            // 非 .md 文件且非目录：忽略（静默跳过）
          } catch (error) {
            // 单个自定义路径失败：记录错误，继续处理其他路径
            logForDebugging(
              `Failed to load output styles from plugin ${plugin.name} custom path ${stylePath}: ${error}`,
              { level: 'error' },
            )
          }
        }
      }
    }

    logForDebugging(`Total plugin output styles loaded: ${allStyles.length}`)
    return allStyles
  },
)

/**
 * 清除输出样式加载的 memoize 缓存。
 *
 * 在 /reload-plugins 执行时调用，确保下次访问会重新从磁盘加载样式。
 */
export function clearPluginOutputStyleCache(): void {
  // memoize 缓存对象提供 clear() 方法
  loadPluginOutputStyles.cache?.clear?.()
}
