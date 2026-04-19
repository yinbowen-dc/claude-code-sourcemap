/**
 * @file memoryScan.ts
 * @description 记忆目录模块 — 记忆文件扫描原语
 *
 * 在 Claude Code 记忆系统中，该文件提供底层的记忆目录扫描能力，
 * 被拆分自 findRelevantMemories.ts，以解决循环依赖问题：
 * extractMemories 需要导入扫描逻辑，但不应引入 sideQuery 和 API 客户端链
 * （后者会通过 memdir.ts 形成循环依赖，见 #25372）。
 *
 * 主要提供两个导出：
 * 1. scanMemoryFiles   — 扫描目录中所有 .md 文件，读取 frontmatter，返回元信息列表
 * 2. formatMemoryManifest — 将元信息列表格式化为文本清单（供 Sonnet 或代理使用）
 *
 * 被以下模块使用：
 * - findRelevantMemories（查询时召回，调用 Sonnet 筛选）
 * - extractMemories（对话轮结束时的记忆提取代理，预注入文件列表）
 */

import { readdir } from 'fs/promises'
import { basename, join } from 'path'
import { parseFrontmatter } from '../utils/frontmatterParser.js'
import { readFileInRange } from '../utils/readFileInRange.js'
import { type MemoryType, parseMemoryType } from './memoryTypes.js'

/**
 * 单个记忆文件的元信息（从 frontmatter 提取），用于相关性筛选和清单格式化。
 * 不含文件内容，仅含供选择器判断的轻量元数据。
 */
export type MemoryHeader = {
  filename: string           // 相对于记忆目录的相对路径（如 "user_role.md"）
  filePath: string           // 记忆文件的绝对路径
  mtimeMs: number            // 文件最后修改时间（毫秒时间戳）
  description: string | null // frontmatter 中的 description 字段，缺失时为 null
  type: MemoryType | undefined // frontmatter 中的 type 字段，无效值解析为 undefined
}

/** 单次扫描最多返回的记忆文件数，防止超大目录导致性能下降 */
const MAX_MEMORY_FILES = 200
/** 读取每个文件时的最大行数上限，仅需读取 frontmatter 部分 */
const FRONTMATTER_MAX_LINES = 30

/**
 * 扫描记忆目录中的所有 .md 文件，读取其 frontmatter，返回按修改时间降序排列的元信息列表。
 *
 * 设计要点：
 * - 递归扫描：支持按主题组织的子目录结构（如 feedback/、project/）
 * - 排除 MEMORY.md：入口索引文件已通过系统提示加载，不参与相关性筛选
 * - 单次遍历：readFileInRange 内部 stat 并返回 mtimeMs，避免额外的 stat 轮次
 *   对 N≤200 的常见情况，比"stat-sort-read"两轮次少一半系统调用
 * - 容错：通过 Promise.allSettled 处理单个文件读取失败，不中断整体扫描
 * - 上限裁切：按时间降序后取前 MAX_MEMORY_FILES 个，保留最新的记忆
 *
 * 被 findRelevantMemories（查询时召回）和 extractMemories（代理预注入）共用。
 *
 * @param memoryDir 记忆目录绝对路径
 * @param signal    取消信号，用于中断长时间的文件读取
 * @returns         按修改时间降序排列的记忆元信息列表（最多 MAX_MEMORY_FILES 个）
 */
export async function scanMemoryFiles(
  memoryDir: string,
  signal: AbortSignal,
): Promise<MemoryHeader[]> {
  try {
    // 递归读取目录，获取所有条目的相对路径
    const entries = await readdir(memoryDir, { recursive: true })
    // 过滤出 .md 文件，并排除 MEMORY.md（入口索引文件，已另行加载）
    const mdFiles = entries.filter(
      f => f.endsWith('.md') && basename(f) !== 'MEMORY.md',
    )

    // 并发读取所有文件的 frontmatter（使用 allSettled 确保单个失败不中断整体）
    const headerResults = await Promise.allSettled(
      mdFiles.map(async (relativePath): Promise<MemoryHeader> => {
        const filePath = join(memoryDir, relativePath)
        // 仅读取前 FRONTMATTER_MAX_LINES 行，获取 frontmatter 元数据和 mtimeMs
        const { content, mtimeMs } = await readFileInRange(
          filePath,
          0,
          FRONTMATTER_MAX_LINES,
          undefined,
          signal,
        )
        // 解析 frontmatter，提取 description 和 type 字段
        const { frontmatter } = parseFrontmatter(content, filePath)
        return {
          filename: relativePath,                          // 相对路径作为文件名标识符
          filePath,                                        // 绝对路径供调用方直接使用
          mtimeMs,                                         // 修改时间供排序和新鲜度计算
          description: frontmatter.description || null,   // 描述字段，供 Sonnet 判断相关性
          type: parseMemoryType(frontmatter.type),         // 类型字段，无效值退化为 undefined
        }
      }),
    )

    return headerResults
      .filter(
        // 过滤失败的条目（如文件权限错误、被删除的文件等）
        (r): r is PromiseFulfilledResult<MemoryHeader> =>
          r.status === 'fulfilled',
      )
      .map(r => r.value)
      .sort((a, b) => b.mtimeMs - a.mtimeMs) // 按修改时间降序排列，最新记忆优先
      .slice(0, MAX_MEMORY_FILES)             // 裁切至上限，保留最新的 200 个
  } catch {
    // 目录不存在或不可读时，静默返回空列表（记忆系统尚未初始化的正常状态）
    return []
  }
}

/**
 * 将记忆元信息列表格式化为多行文本清单，每行一条记忆。
 *
 * 格式：`- [type] filename (ISO时间戳): description`
 * - type 字段有值时以 [type] 前缀标注，无值时省略
 * - description 有值时追加在时间戳后，无值时省略
 *
 * 被以下场景使用：
 * - findRelevantMemories 的 Sonnet 选择器提示（查询时召回）
 * - extractMemories 的代理提示（预注入文件列表，避免代理执行 `ls`）
 *
 * @param memories 记忆元信息列表
 * @returns        多行格式化文本，每行对应一个记忆文件
 */
export function formatMemoryManifest(memories: MemoryHeader[]): string {
  return memories
    .map(m => {
      const tag = m.type ? `[${m.type}] ` : '' // 有类型时附加类型标签
      const ts = new Date(m.mtimeMs).toISOString() // 修改时间转 ISO 字符串
      return m.description
        ? `- ${tag}${m.filename} (${ts}): ${m.description}` // 带描述的格式
        : `- ${tag}${m.filename} (${ts})`                   // 无描述的格式
    })
    .join('\n')
}
