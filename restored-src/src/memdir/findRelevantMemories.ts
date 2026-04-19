/**
 * @file findRelevantMemories.ts
 * @description 记忆目录模块 — 相关记忆检索
 *
 * 在 Claude Code 系统的记忆管理流程中，该文件负责"查询时记忆召回"：
 * 给定用户查询语句，先扫描记忆目录中所有 .md 文件的 frontmatter，
 * 再将文件清单发送给 Sonnet 模型，由模型选出最多 5 个最相关的记忆文件，
 * 最终返回绝对路径和修改时间（mtimeMs），供主模型注入上下文。
 *
 * 调用时机：每轮对话开始时，由记忆系统协调层调用，用于动态加载相关上下文。
 * 依赖：memoryScan（文件扫描）、sideQuery（Sonnet 侧查询）、memoryShapeTelemetry（遥测）。
 */

import { feature } from 'bun:bundle'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { getDefaultSonnetModel } from '../utils/model/model.js'
import { sideQuery } from '../utils/sideQuery.js'
import { jsonParse } from '../utils/slowOperations.js'
import {
  formatMemoryManifest,
  type MemoryHeader,
  scanMemoryFiles,
} from './memoryScan.js'

/** 相关记忆条目类型：包含文件绝对路径和最后修改时间（毫秒时间戳） */
export type RelevantMemory = {
  path: string    // 记忆文件的绝对路径
  mtimeMs: number // 文件最后修改时间，供调用方判断新鲜度
}

/**
 * 发送给 Sonnet 模型的系统提示：指导模型从记忆文件清单中筛选出
 * 对当前用户查询最有帮助的文件（最多 5 个）。
 * 核心原则：宁缺勿滥，若不确定则不选；
 * 对最近正在使用的工具，跳过其参考文档，但保留警告/已知问题类记忆。
 */
const SELECT_MEMORIES_SYSTEM_PROMPT = `You are selecting memories that will be useful to Claude Code as it processes a user's query. You will be given the user's query and a list of available memory files with their filenames and descriptions.

Return a list of filenames for the memories that will clearly be useful to Claude Code as it processes the user's query (up to 5). Only include memories that you are certain will be helpful based on their name and description.
- If you are unsure if a memory will be useful in processing the user's query, then do not include it in your list. Be selective and discerning.
- If there are no memories in the list that would clearly be useful, feel free to return an empty list.
- If a list of recently-used tools is provided, do not select memories that are usage reference or API documentation for those tools (Claude Code is already exercising them). DO still select memories containing warnings, gotchas, or known issues about those tools — active use is exactly when those matter.
`

/**
 * 根据用户查询，从记忆目录中找出最相关的记忆文件列表。
 *
 * 整体流程：
 * 1. 调用 scanMemoryFiles 扫描记忆目录中所有 .md 文件的元信息（含 frontmatter）
 * 2. 过滤掉 alreadySurfaced 集合中已展示过的文件，节省 Sonnet 的 5 槽预算
 * 3. 将文件清单格式化后发送给 Sonnet，由模型选出最相关的文件名
 * 4. 将选中的文件名映射回完整路径和 mtimeMs，返回给调用方
 * 5. 若启用了 MEMORY_SHAPE_TELEMETRY 特性，异步上报召回形状遥测数据
 *
 * @param query          当前用户查询语句，用于判断记忆相关性
 * @param memoryDir      记忆目录绝对路径（含尾部分隔符）
 * @param signal         取消信号，用于中断长时间的扫描或网络请求
 * @param recentTools    本次对话最近使用的工具名列表，用于过滤工具参考文档
 * @param alreadySurfaced 上轮已展示过的路径集合，避免重复选择
 * @returns 最多 5 个相关记忆的路径和修改时间数组
 */
export async function findRelevantMemories(
  query: string,
  memoryDir: string,
  signal: AbortSignal,
  recentTools: readonly string[] = [],
  alreadySurfaced: ReadonlySet<string> = new Set(),
): Promise<RelevantMemory[]> {
  // 扫描记忆目录，并过滤掉本轮已展示过的文件
  const memories = (await scanMemoryFiles(memoryDir, signal)).filter(
    m => !alreadySurfaced.has(m.filePath),
  )
  // 若无候选记忆，直接返回空列表，避免不必要的 Sonnet 请求
  if (memories.length === 0) {
    return []
  }

  // 将文件清单和查询发送给 Sonnet，由模型返回选中的文件名列表
  const selectedFilenames = await selectRelevantMemories(
    query,
    memories,
    signal,
    recentTools,
  )
  // 建立文件名到元信息的映射，方便后续快速查找
  const byFilename = new Map(memories.map(m => [m.filename, m]))
  // 将 Sonnet 返回的文件名列表映射回完整的 MemoryHeader 对象，过滤无效项
  const selected = selectedFilenames
    .map(filename => byFilename.get(filename))
    .filter((m): m is MemoryHeader => m !== undefined)

  // 即使选中为空也上报遥测：选中率计算需要分母（总候选数），
  // 且 age=-1 可区分"运行过但未选中"与"从未运行"两种状态
  if (feature('MEMORY_SHAPE_TELEMETRY')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { logMemoryRecallShape } =
      require('./memoryShapeTelemetry.js') as typeof import('./memoryShapeTelemetry.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    logMemoryRecallShape(memories, selected)
  }

  // 将选中的记忆映射为 { path, mtimeMs } 格式返回给调用方
  return selected.map(m => ({ path: m.filePath, mtimeMs: m.mtimeMs }))
}

/**
 * 将记忆文件清单发送给 Sonnet 模型，由模型返回最相关的文件名列表。
 *
 * 内部流程：
 * 1. 格式化记忆清单（含文件名、时间戳、描述）为文本 manifest
 * 2. 若有最近使用的工具，附加工具名称段落，引导模型跳过其参考文档
 * 3. 通过 sideQuery 以 JSON Schema 约束输出格式，限制 max_tokens=256
 * 4. 解析返回的 JSON，过滤非法文件名（不在扫描结果中的名称）
 * 5. 请求被取消或发生错误时静默返回空列表
 *
 * @param query       当前用户查询语句
 * @param memories    候选记忆元信息列表
 * @param signal      取消信号
 * @param recentTools 最近使用的工具名列表
 * @returns Sonnet 选中的文件名数组（已过滤非法项）
 */
async function selectRelevantMemories(
  query: string,
  memories: MemoryHeader[],
  signal: AbortSignal,
  recentTools: readonly string[],
): Promise<string[]> {
  // 构建合法文件名集合，用于过滤 Sonnet 可能返回的幻觉文件名
  const validFilenames = new Set(memories.map(m => m.filename))

  // 将记忆元信息格式化为文本清单，供 Sonnet 参考
  const manifest = formatMemoryManifest(memories)

  // 若有最近使用的工具，附加说明段落：
  // 当 Claude Code 正在使用某工具时，其参考文档是噪音；
  // 否则模型会因"工具名 in query + 工具名 in 记忆描述"产生误报
  const toolsSection =
    recentTools.length > 0
      ? `\n\nRecently used tools: ${recentTools.join(', ')}`
      : ''

  try {
    // 以 JSON Schema 约束输出，限制 256 token，避免模型超出预算
    const result = await sideQuery({
      model: getDefaultSonnetModel(),
      system: SELECT_MEMORIES_SYSTEM_PROMPT,
      skipSystemPromptPrefix: true, // 跳过系统提示前缀，保持提示简洁
      messages: [
        {
          role: 'user',
          content: `Query: ${query}\n\nAvailable memories:\n${manifest}${toolsSection}`,
        },
      ],
      max_tokens: 256, // 仅需返回文件名列表，256 token 已充足
      output_format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            selected_memories: { type: 'array', items: { type: 'string' } },
          },
          required: ['selected_memories'],
          additionalProperties: false,
        },
      },
      signal,
      querySource: 'memdir_relevance', // 标记查询来源，用于遥测区分
    })

    // 从响应内容中提取文本块
    const textBlock = result.content.find(block => block.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      return [] // 无文本块时返回空列表
    }

    // 解析 JSON 并过滤非法文件名，防止模型幻觉导致无效引用
    const parsed: { selected_memories: string[] } = jsonParse(textBlock.text)
    return parsed.selected_memories.filter(f => validFilenames.has(f))
  } catch (e) {
    if (signal.aborted) {
      // 请求被主动取消（如用户中断），静默返回空列表
      return []
    }
    // 其他错误（网络超时、解析失败等）记录调试日志后返回空列表，不阻断主流程
    logForDebugging(
      `[memdir] selectRelevantMemories failed: ${errorMessage(e)}`,
      { level: 'warn' },
    )
    return []
  }
}
