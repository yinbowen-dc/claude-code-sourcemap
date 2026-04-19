/**
 * 插件 Markdown 文件递归遍历工具 — Claude Code 插件加载管道的文件发现层
 *
 * 在 Claude Code 插件加载流程中，此文件负责发现插件目录下所有 Markdown 组件文件：
 *   插件目录扫描 → 发现 .md 文件（命令/技能/代理）→ 传递给上层加载器处理
 *
 * 职责：
 *   - 递归遍历插件根目录下的所有子目录
 *   - 对每个 .md 文件调用 onFile 回调，并传递其相对命名空间路径
 *   - 支持 stopAtSkillDir 模式：当目录中存在 SKILL.md 时，收集该目录所有 .md 文件
 *     但不再向下递归（技能目录是叶子容器）
 *   - 吞掉单个目录的读取错误，避免一个损坏目录导致整个插件加载中断
 *
 * 被 validatePlugin.ts（校验用）和 pluginLoader.ts（加载用）共同调用。
 */

import { join } from 'path'
import { logForDebugging } from '../debug.js'
import { getFsImplementation } from '../fsOperations.js'

// 匹配 skill.md 文件名的正则表达式（不区分大小写），用于识别技能目录
const SKILL_MD_RE = /^skill\.md$/i

/**
 * 递归遍历插件目录，对每个 .md 文件调用 onFile 回调。
 *
 * 遍历逻辑：
 *   1. 读取当前目录的所有条目（文件和子目录）
 *   2. 若 stopAtSkillDir 为 true 且当前目录包含 SKILL.md：
 *      - 对该目录所有 .md 文件调用 onFile（并发）
 *      - 不再向下递归（技能目录是叶子容器）
 *   3. 否则：对 .md 文件调用 onFile，对子目录递归扫描
 *   4. 任何 readdir 错误被吞掉并记录调试日志，不影响其他目录的处理
 *
 * namespace 数组追踪相对于根目录的子目录路径
 * （例如 ['foo', 'bar'] 对应 root/foo/bar/file.md）。
 *
 * @param rootDir - 插件根目录的绝对路径
 * @param onFile - 对每个发现的 .md 文件调用的回调，接收完整路径和命名空间
 * @param opts.stopAtSkillDir - 是否在技能目录停止递归（默认 false）
 * @param opts.logLabel - 日志标签前缀（默认 'plugin'）
 */
export async function walkPluginMarkdown(
  rootDir: string,
  onFile: (fullPath: string, namespace: string[]) => Promise<void>,
  opts: { stopAtSkillDir?: boolean; logLabel?: string } = {},
): Promise<void> {
  // 获取文件系统实现（支持测试中注入 mock）
  const fs = getFsImplementation()
  // 日志标签，用于错误调试信息中标识来源
  const label = opts.logLabel ?? 'plugin'

  /**
   * 内部递归扫描函数。
   * @param dirPath - 当前扫描的目录绝对路径
   * @param namespace - 当前目录相对于根目录的路径段数组
   */
  async function scan(dirPath: string, namespace: string[]): Promise<void> {
    try {
      // 读取目录条目（包含 isFile/isDirectory 类型信息）
      const entries = await fs.readdir(dirPath)

      // 检查是否为技能目录：包含 SKILL.md 文件
      if (
        opts.stopAtSkillDir &&
        entries.some(e => e.isFile() && SKILL_MD_RE.test(e.name))
      ) {
        // 技能目录模式：并发处理所有 .md 文件，不再递归子目录
        await Promise.all(
          entries.map(entry =>
            entry.isFile() && entry.name.toLowerCase().endsWith('.md')
              ? onFile(join(dirPath, entry.name), namespace)
              : undefined,
          ),
        )
        return
      }

      // 普通目录模式：并发处理所有条目
      await Promise.all(
        entries.map(entry => {
          const fullPath = join(dirPath, entry.name)
          if (entry.isDirectory()) {
            // 子目录：递归扫描，命名空间追加目录名
            return scan(fullPath, [...namespace, entry.name])
          }
          if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
            // .md 文件：调用 onFile 回调
            return onFile(fullPath, namespace)
          }
          return undefined
        }),
      )
    } catch (error) {
      // 吞掉单个目录的读取错误，记录调试日志后继续
      logForDebugging(
        `Failed to scan ${label} directory ${dirPath}: ${error}`,
        { level: 'error' },
      )
    }
  }

  // 从根目录开始扫描，初始命名空间为空
  await scan(rootDir, [])
}
