/**
 * json.ts — JSON/JSONL/JSONC 解析与处理工具模块
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本文件位于工具层（utils），是系统中所有 JSON 相关操作的核心工具库。
 * Claude Code 大量依赖 JSON 格式存储配置、会话记录（JSONL）、VS Code 快捷键配置（JSONC）等。
 *
 * 主要功能：
 *   1. safeParseJSON   — 带 LRU 缓存的安全 JSON 解析（防止重复解析相同字符串）；
 *   2. safeParseJSONC  — 解析支持注释的 JSONC 格式（VS Code 配置文件）；
 *   3. parseJSONL      — 解析 JSONL（JSON Lines）格式，跳过损坏行；
 *   4. readJSONLFile   — 从磁盘读取并解析 JSONL 文件，支持超大文件（读取最后 100MB）；
 *   5. addItemToJSONCArray — 向 JSONC 数组追加条目，保留注释和格式。
 *
 * 性能优化：
 *   - safeParseJSON 使用 LRU 缓存（50 条目），避免对相同 JSON 字符串重复解析；
 *   - 超过 8KB 的字符串不缓存（大文件每次读取内容都不同，缓存命中率极低）；
 *   - JSONL 解析在 Bun 运行时使用原生 Bun.JSONL.parseChunk 提升性能。
 *
 * 循环依赖说明：
 *   stripBOM 被提取到 jsonRead.ts 以打破 settings → json → log → types/logs → settings 循环。
 */

import { open, readFile, stat } from 'fs/promises'
import {
  applyEdits,
  modify,
  parse as parseJsonc,
} from 'jsonc-parser/lib/esm/main.js'
import { stripBOM } from './jsonRead.js'
import { logError } from './log.js'
import { memoizeWithLRU } from './memoize.js'
import { jsonStringify } from './slowOperations.js'

/** 解析缓存条目的判别联合类型，用于区分成功（ok:true）和失败（ok:false）的解析结果 */
type CachedParse = { ok: true; value: unknown } | { ok: false }

// 使用判别联合而非直接缓存 unknown 的原因：
//   1. memoizeWithLRU 要求 NonNullable<unknown>，但 JSON.parse("null") 返回 null；
//   2. 无效 JSON 也需要缓存——否则对同一错误 JSON 的重复调用会重复解析并重复记录日志
//      （这是相对于旧版 lodash memoize 的行为回归）。
// 限制 50 条目防止内存无限增长——旧版 lodash memoize 会永久缓存所有唯一 JSON 字符串
//（设置文件、.mcp.json、笔记本、工具结果），导致严重内存泄漏。
// 注意：shouldLogError 故意不纳入缓存键（与 lodash memoize 默认行为一致：仅用第一个参数）。
//
// 超过此大小的字符串不缓存——LRU 将字符串本身作为键存储，
// 200KB 的配置文件会在 50 个槽位中占用 ~10MB。
// 另外，~/.claude.json 每次启动都会变化（numStartups 递增），缓存命中率为零。
const PARSE_CACHE_MAX_KEY_BYTES = 8 * 1024 // 8KB 阈值

/**
 * 不带缓存的基础 JSON 解析函数。
 * 处理 BOM 并可选择记录解析错误。
 *
 * @param json           - 待解析的 JSON 字符串
 * @param shouldLogError - true 时将解析错误记录到错误日志
 * @returns CachedParse 判别联合（成功时包含解析值，失败时仅 ok:false）
 */
function parseJSONUncached(json: string, shouldLogError: boolean): CachedParse {
  try {
    // 先剥离 UTF-8 BOM（PowerShell 5.x 默认写入带 BOM 的 UTF-8 文件）
    return { ok: true, value: JSON.parse(stripBOM(json)) }
  } catch (e) {
    if (shouldLogError) {
      logError(e) // 记录错误但不抛出，实现"安全"解析
    }
    return { ok: false }
  }
}

// LRU 缓存版本：以 JSON 字符串本身为键，最多缓存 50 条目
const parseJSONCached = memoizeWithLRU(parseJSONUncached, json => json, 50)

/**
 * 带 LRU 缓存的安全 JSON 解析函数。
 *
 * 优化策略：
 *   - 字符串长度 ≤ 8KB 时使用 LRU 缓存，避免重复解析；
 *   - 字符串长度 > 8KB 时直接解析（大文件内容频繁变化，缓存无效）；
 *   - 返回 null（而非抛出异常）以实现"安全"解析。
 *
 * 暴露 .cache 属性（来自 parseJSONCached），供测试检查缓存状态。
 *
 * @param json           - 待解析的 JSON 字符串（可以为 null 或 undefined）
 * @param shouldLogError - 是否记录解析错误，默认 true
 * @returns 解析结果，解析失败或输入为空时返回 null
 */
export const safeParseJSON = Object.assign(
  function safeParseJSON(
    json: string | null | undefined,
    shouldLogError: boolean = true,
  ): unknown {
    if (!json) return null // 空输入直接返回 null
    const result =
      json.length > PARSE_CACHE_MAX_KEY_BYTES
        ? parseJSONUncached(json, shouldLogError)  // 大字符串：不缓存
        : parseJSONCached(json, shouldLogError)    // 小字符串：使用 LRU 缓存
    return result.ok ? result.value : null
  },
  { cache: parseJSONCached.cache }, // 暴露缓存对象供外部访问
)

/**
 * 安全解析 JSONC（支持注释的 JSON）格式字符串。
 * 主要用于 VS Code 配置文件（如 keybindings.json），这类文件允许注释和尾随逗号。
 *
 * 特点：
 *   - 剥离 BOM（PowerShell 5.x 写入的文件可能包含 BOM）；
 *   - 捕获所有解析错误并返回 null（不抛出异常）；
 *   - 不使用缓存（配置文件内容频繁变化）。
 *
 * @param json - 待解析的 JSONC 字符串（可以为 null 或 undefined）
 * @returns 解析结果，失败时返回 null
 */
export function safeParseJSONC(json: string | null | undefined): unknown {
  if (!json) {
    return null
  }
  try {
    // 剥离 BOM 后再解析 JSONC
    return parseJsonc(stripBOM(json))
  } catch (e) {
    logError(e)
    return null
  }
}

/**
 * 向 JSONC 数组字符串追加新元素，保留注释和缩进格式。
 * @param content - 原始 JSONC 字符串
 * @param newItem - 要追加的新元素
 * @returns 修改后的 JSONC 字符串
 */
/**
 * Bun.JSONL.parseChunk 的类型签名（若可用则为函数，否则为 false）。
 * 支持字符串和 Buffer 输入，最小化内存使用和数据复制，内部处理 BOM 剥离。
 */
type BunJSONLParseChunk = (
  data: string | Buffer,
  offset?: number,
) => { values: unknown[]; error: null | Error; read: number; done: boolean }

/**
 * 检测 Bun 运行时的原生 JSONL 解析器是否可用。
 * 仅在 Bun 环境中且 Bun.JSONL.parseChunk 存在时返回函数，否则返回 false。
 * 通过立即调用表达式（IIFE）在模块加载时一次性检测，避免每次调用重复检查。
 */
const bunJSONLParse: BunJSONLParseChunk | false = (() => {
  if (typeof Bun === 'undefined') return false // 非 Bun 运行时
  const b = Bun as Record<string, unknown>
  const jsonl = b.JSONL as Record<string, unknown> | undefined
  if (!jsonl?.parseChunk) return false // Bun 版本过旧，不支持 JSONL
  return jsonl.parseChunk as BunJSONLParseChunk
})()

/**
 * 使用 Bun.JSONL.parseChunk 解析 JSONL 数据。
 * 处理流式解析中途出错的情况：跳过错误行，继续解析剩余内容。
 *
 * @param data - JSONL 字符串或 Buffer
 * @returns 成功解析的条目数组
 */
function parseJSONLBun<T>(data: string | Buffer): T[] {
  const parse = bunJSONLParse as BunJSONLParseChunk
  const len = data.length
  const result = parse(data)
  if (!result.error || result.done || result.read >= len) {
    // 无错误或已处理完所有数据，直接返回
    return result.values as T[]
  }
  // 流中途遇到错误——保留已解析的部分，跳过错误行，继续处理
  let values = result.values as T[]
  let offset = result.read
  while (offset < len) {
    // 查找下一个换行符（跳过当前错误行）
    const newlineIndex =
      typeof data === 'string'
        ? data.indexOf('\n', offset)
        : data.indexOf(0x0a, offset)
    if (newlineIndex === -1) break // 无更多行
    offset = newlineIndex + 1
    const next = parse(data, offset)
    if (next.values.length > 0) {
      values = values.concat(next.values as T[])
    }
    if (!next.error || next.done || next.read >= len) break
    offset = next.read
  }
  return values
}

/**
 * 使用 Buffer 的 indexOf 方法逐行解析 JSONL（非 Bun 环境的 Buffer 版本）。
 * 处理 UTF-8 BOM（字节序列：EF BB BF）。
 * 跳过空行和格式错误的行，不抛出异常。
 *
 * @param buf - 包含 JSONL 内容的 Buffer
 * @returns 成功解析的条目数组
 */
function parseJSONLBuffer<T>(buf: Buffer): T[] {
  const bufLen = buf.length
  let start = 0

  // 剥离 UTF-8 BOM（字节序列：EF BB BF）
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    start = 3
  }

  const results: T[] = []
  while (start < bufLen) {
    // 找到换行符位置作为行尾（若无则读到文件末尾）
    let end = buf.indexOf(0x0a, start)
    if (end === -1) end = bufLen

    // 将字节范围转为 UTF-8 字符串并去除首尾空白
    const line = buf.toString('utf8', start, end).trim()
    start = end + 1
    if (!line) continue // 跳过空行
    try {
      results.push(JSON.parse(line) as T)
    } catch {
      // 跳过格式错误的行（不记录日志，避免大文件产生大量噪音）
    }
  }
  return results
}

/**
 * 使用字符串 indexOf 逐行解析 JSONL（非 Bun 环境的字符串版本）。
 * 先剥离 BOM，再逐行查找 '\n' 边界解析。
 * 跳过空行和格式错误的行。
 *
 * @param data - JSONL 字符串
 * @returns 成功解析的条目数组
 */
function parseJSONLString<T>(data: string): T[] {
  const stripped = stripBOM(data)
  const len = stripped.length
  let start = 0

  const results: T[] = []
  while (start < len) {
    let end = stripped.indexOf('\n', start)
    if (end === -1) end = len

    const line = stripped.substring(start, end).trim()
    start = end + 1
    if (!line) continue
    try {
      results.push(JSON.parse(line) as T)
    } catch {
      // 跳过格式错误的行
    }
  }
  return results
}

/**
 * 解析 JSONL（JSON Lines）格式数据，跳过格式错误的行。
 *
 * 运行时自适应优化：
 *   - Bun 环境：使用 Bun.JSONL.parseChunk 原生解析器（更快，原生支持 Buffer）；
 *   - Node.js + Buffer：使用 indexOf-based Buffer 扫描；
 *   - Node.js + String：使用 indexOf-based 字符串扫描。
 *
 * @param data - JSONL 内容（字符串或 Buffer）
 * @returns 成功解析的条目数组，每行对应一个元素
 */
export function parseJSONL<T>(data: string | Buffer): T[] {
  if (bunJSONLParse) {
    return parseJSONLBun<T>(data) // Bun 原生解析器
  }
  if (typeof data === 'string') {
    return parseJSONLString<T>(data) // 字符串版本
  }
  return parseJSONLBuffer<T>(data) // Buffer 版本
}

// JSONL 文件最大读取字节数：100MB
// 100MB 足以容纳约 200 万 token 的会话记录（最大上下文窗口），无需读取整个文件
const MAX_JSONL_READ_BYTES = 100 * 1024 * 1024

/**
 * 从磁盘读取并解析 JSONL 文件。
 *
 * 大文件处理策略（超过 100MB 时）：
 *   仅读取文件末尾的 100MB，跳过第一个不完整行（因为读取点可能在行中间），
 *   从第一个换行符后开始解析，确保不处理截断的 JSON 行。
 *
 * 原理：JSONL 文件是追加写入的，最新的会话记录在文件末尾，
 * 历史久远的记录即使被截断也不影响近期数据的可用性。
 *
 * @param filePath - JSONL 文件的绝对路径
 * @returns 解析成功的条目数组
 */
export async function readJSONLFile<T>(filePath: string): Promise<T[]> {
  const { size } = await stat(filePath) // 获取文件大小
  if (size <= MAX_JSONL_READ_BYTES) {
    // 小文件：直接一次性读取全部内容
    return parseJSONL<T>(await readFile(filePath))
  }
  // 大文件：只读取末尾 100MB
  await using fd = await open(filePath, 'r') // 使用 await using 确保文件句柄自动关闭
  const buf = Buffer.allocUnsafe(MAX_JSONL_READ_BYTES) // 预分配缓冲区
  let totalRead = 0
  const fileOffset = size - MAX_JSONL_READ_BYTES // 从文件末尾 100MB 处开始读取
  while (totalRead < MAX_JSONL_READ_BYTES) {
    const { bytesRead } = await fd.read(
      buf,
      totalRead,                         // 缓冲区写入起始位置
      MAX_JSONL_READ_BYTES - totalRead,  // 剩余可读字节数
      fileOffset + totalRead,             // 文件中的读取位置
    )
    if (bytesRead === 0) break // 已到文件末尾
    totalRead += bytesRead
  }
  // 跳过第一个不完整行（因为读取起始点可能在某行中间）
  const newlineIndex = buf.indexOf(0x0a) // 查找第一个换行符
  if (newlineIndex !== -1 && newlineIndex < totalRead - 1) {
    // 从第一个换行符后开始解析（确保从完整行开始）
    return parseJSONL<T>(buf.subarray(newlineIndex + 1, totalRead))
  }
  return parseJSONL<T>(buf.subarray(0, totalRead))
}

/**
 * 向 JSONC 数组字符串中追加一个新元素，保留原有的注释和缩进格式。
 *
 * 处理逻辑：
 *   1. 若内容为空，创建包含新元素的新数组；
 *   2. 剥离 BOM 后解析为 JSONC；
 *   3. 若解析结果为数组，使用 jsonc-parser 的 modify 函数生成最小化编辑补丁；
 *   4. 将补丁应用（applyEdits）到原始字符串，保留注释；
 *   5. 若非数组，创建仅含新元素的新数组；
 *   6. 任何异常均降级为创建新数组。
 *
 * @param content - 原始 JSONC 字符串（通常是 VS Code keybindings.json 内容）
 * @param newItem - 要追加的新元素（任意 JSON 兼容值）
 * @returns 修改后的 JSONC 字符串
 */
export function addItemToJSONCArray(content: string, newItem: unknown): string {
  try {
    // 空内容时创建全新数组
    if (!content || content.trim() === '') {
      return jsonStringify([newItem], null, 4)
    }

    // 剥离 BOM，防止 PowerShell 写入的文件解析失败
    const cleanContent = stripBOM(content)

    // 解析 JSONC（允许注释）
    const parsedContent = parseJsonc(cleanContent)

    // 若解析结果为数组，使用 jsonc-parser 追加元素（保留注释）
    if (Array.isArray(parsedContent)) {
      const arrayLength = parsedContent.length

      // 空数组插入到索引 0，非空数组追加到末尾
      const isEmpty = arrayLength === 0
      const insertPath = isEmpty ? [0] : [arrayLength]

      // 生成最小化编辑描述（不覆盖现有元素，仅插入）
      const edits = modify(cleanContent, insertPath, newItem, {
        formattingOptions: { insertSpaces: true, tabSize: 4 },
        isArrayInsertion: true, // 声明为数组插入模式，防止覆盖
      })

      // 若无法生成编辑，回退为手动字符串操作
      if (!edits || edits.length === 0) {
        const copy = [...parsedContent, newItem]
        return jsonStringify(copy, null, 4)
      }

      // 应用编辑到原始字符串（保留注释和格式）
      return applyEdits(cleanContent, edits)
    }
    else {
      // 内容存在但不是数组，完全替换为包含新元素的新数组
      return jsonStringify([newItem], null, 4)
    }
  } catch (e) {
    // 任何解析或编辑失败，降级为创建新数组（最大兼容性）
    logError(e)
    return jsonStringify([newItem], null, 4)
  }
}
