/**
 * git 配置文件轻量解析模块（Git Config Parser）。
 *
 * 【在 Claude Code 系统中的位置】
 * 该模块位于 git 底层工具层，被需要读取 .git/config 配置的模块（如
 * 远程仓库 URL 获取、默认分支检测等）调用，提供比 `git config` 命令
 * 更轻量的纯 JS 解析实现，无需 fork 子进程。
 *
 * 【主要功能】
 * - parseGitConfigValue(gitDir, section, subsection, key)：读取 .git/config 文件中指定节的键值
 * - parseConfigString(config, section, subsection, key)：从内存中的配置字符串解析键值（可测试）
 * - parseKeyValue(line)：解析单行 `key = value` 格式
 * - parseValue(line, start)：解析值部分，支持引号、转义序列、行内注释
 * - trimTrailingWhitespace(s)：去除字符串末尾的空白
 * - matchesSectionHeader(line, sectionLower, subsection)：判断节头是否匹配
 * - isKeyChar(ch)：判断字符是否为合法的键名字符
 *
 * 【规范说明】（已对照 git 源码 config.c 验证）
 * - 节名（section）：大小写不敏感，允许字母数字和连字符
 * - 子节名（subsection，带引号）：大小写敏感，支持 \\ 和 \" 转义
 * - 键名（key）：大小写不敏感，允许字母数字和连字符
 * - 值（value）：支持可选引号、行内注释（# 或 ;）、反斜杠转义序列
 */

import { readFile } from 'fs/promises'
import { join } from 'path'

/**
 * 从 .git/config 文件中读取单个配置值。
 * 返回指定 section/subsection 下第一个匹配键的值。
 *
 * 【流程】
 * 1. 读取 <gitDir>/config 文件内容；
 * 2. 调用 parseConfigString 进行解析；
 * 3. 任何文件读取错误均返回 null（防御性处理）。
 *
 * @param gitDir - git 目录路径（如 .git 或裸仓库路径）
 * @param section - 节名（大小写不敏感，如 'remote'）
 * @param subsection - 子节名（大小写敏感，如 'origin'；无子节时传 null）
 * @param key - 键名（大小写不敏感，如 'url'）
 * @returns 配置值字符串，未找到或出错时返回 null
 */
export async function parseGitConfigValue(
  gitDir: string,
  section: string,
  subsection: string | null,
  key: string,
): Promise<string | null> {
  try {
    const config = await readFile(join(gitDir, 'config'), 'utf-8') // 读取 config 文件
    return parseConfigString(config, section, subsection, key)
  } catch {
    return null // 文件不存在或读取失败，返回 null
  }
}

/**
 * 从内存中的 git 配置字符串解析指定键值。
 * 该函数导出以便于单元测试。
 *
 * 【解析流程】
 * 1. 将配置字符串按行分割；
 * 2. 跳过空行和注释行（# 或 ;）；
 * 3. 遇到节头（[...]）时判断是否进入目标节；
 * 4. 在目标节内，解析每行的键值对，匹配到目标键时返回值。
 *
 * @param config - git config 文件的完整文本内容
 * @param section - 节名（大小写不敏感）
 * @param subsection - 子节名（大小写敏感）；无子节时传 null
 * @param key - 键名（大小写不敏感）
 * @returns 找到的配置值，未找到时返回 null
 */
export function parseConfigString(
  config: string,
  section: string,
  subsection: string | null,
  key: string,
): string | null {
  const lines = config.split('\n')
  const sectionLower = section.toLowerCase() // 节名转小写，用于大小写不敏感匹配
  const keyLower = key.toLowerCase()         // 键名转小写，用于大小写不敏感匹配

  let inSection = false // 当前是否在目标节内
  for (const line of lines) {
    const trimmed = line.trim()

    // 跳过空行和纯注释行（# 或 ;）
    if (trimmed.length === 0 || trimmed[0] === '#' || trimmed[0] === ';') {
      continue
    }

    // 节头行（以 [ 开头），判断是否进入目标节
    if (trimmed[0] === '[') {
      inSection = matchesSectionHeader(trimmed, sectionLower, subsection)
      continue
    }

    if (!inSection) {
      continue // 不在目标节内，跳过
    }

    // 在目标节内：解析键值对，检查是否匹配目标键
    const parsed = parseKeyValue(trimmed)
    if (parsed && parsed.key.toLowerCase() === keyLower) {
      return parsed.value // 找到目标键，返回其值
    }
  }

  return null // 整个文件扫描完毕，未找到目标键
}

/**
 * 解析单行 `key = value` 格式的配置行。
 * 若该行不是有效的键值对则返回 null。
 *
 * 【解析规则】
 * - 键名：由字母、数字、连字符组成（不能以数字开头？实际 git 允许）
 * - 键名与 = 之间可有空白
 * - 无 = 号的行（布尔键）不在本模块处理范围内，返回 null
 *
 * @param line - 已 trim 的配置行
 * @returns 键值对对象，或 null（非合法键值行）
 */
function parseKeyValue(line: string): { key: string; value: string } | null {
  // 读取键名：允许字母数字和连字符
  let i = 0
  while (i < line.length && isKeyChar(line[i]!)) {
    i++
  }
  if (i === 0) {
    return null // 首字符不是合法键名字符，跳过
  }
  const key = line.slice(0, i) // 提取键名

  // 跳过键名后的空白
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    i++
  }

  // 必须有 '=' 号
  if (i >= line.length || line[i] !== '=') {
    // 无 = 号的布尔键，不在本模块处理范围内
    return null
  }
  i++ // 跳过 '='

  // 跳过 '=' 后的空白
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    i++
  }

  const value = parseValue(line, i) // 解析值部分
  return { key, value }
}

/**
 * 从位置 start 开始解析 git 配置值。
 * 支持引号字符串、转义序列和行内注释。
 *
 * 【解析规则】
 * - 引号外的 # 或 ; 开启行内注释，注释后内容忽略
 * - 引号切换 inQuote 状态
 * - 引号内的反斜杠转义：\n、\t、\b、\"、\\（未知转义：git 静默丢弃反斜杠）
 * - 引号外的 \\ 按字面处理（git 支持行继续符 \，但本模块按行分割后不处理多行）
 * - 非引号结尾时，去除末尾空白
 *
 * @param line - 完整的配置行
 * @param start - 值部分的起始位置（= 号之后）
 * @returns 解析后的配置值字符串
 */
function parseValue(line: string, start: number): string {
  let result = ''
  let inQuote = false // 当前是否在引号字符串内
  let i = start

  while (i < line.length) {
    const ch = line[i]!

    // 引号外的 # 或 ; 表示行内注释开始，结束值解析
    if (!inQuote && (ch === '#' || ch === ';')) {
      break
    }

    if (ch === '"') {
      inQuote = !inQuote // 切换引号状态
      i++
      continue
    }

    if (ch === '\\' && i + 1 < line.length) {
      const next = line[i + 1]!
      if (inQuote) {
        // 引号内：识别 git 支持的转义序列
        switch (next) {
          case 'n':
            result += '\n'  // 换行
            break
          case 't':
            result += '\t'  // 制表
            break
          case 'b':
            result += '\b'  // 退格
            break
          case '"':
            result += '"'   // 双引号
            break
          case '\\':
            result += '\\'  // 反斜杠
            break
          default:
            // git 对未知转义静默丢弃反斜杠，只保留后续字符
            result += next
            break
        }
        i += 2
        continue
      }
      // 引号外：\\ 按字面处理（行继续符的情况按行分割后已不存在）
      if (next === '\\') {
        result += '\\'
        i += 2
        continue
      }
      // 其他情况：反斜杠按字面处理（fall through）
    }

    result += ch
    i++
  }

  // 若不以引号结尾，去除末尾空白
  // git 去除未被引号包裹部分的末尾空白，单行值直接 trim 结果即可
  if (!inQuote) {
    result = trimTrailingWhitespace(result)
  }

  return result
}

/**
 * 去除字符串末尾的空格和制表符。
 * 用于处理 git config 值中引号外部分的末尾空白。
 *
 * @param s - 待处理字符串
 * @returns 去除末尾空白后的字符串
 */
function trimTrailingWhitespace(s: string): string {
  let end = s.length
  while (end > 0 && (s[end - 1] === ' ' || s[end - 1] === '\t')) {
    end--
  }
  return s.slice(0, end)
}

/**
 * 判断配置节头行（如 `[remote "origin"]`）是否匹配目标 section 和 subsection。
 * 节名匹配大小写不敏感；子节名匹配大小写敏感。
 *
 * 【解析流程】
 * 1. 从 [ 之后读取节名，转小写后与目标比较；
 * 2. 若目标 subsection 为 null，节头必须紧跟 ]（简单节）；
 * 3. 若目标 subsection 非 null，跳过空白后读取双引号包裹的子节名，
 *    支持 \\ 和 \" 转义，然后与目标比较（大小写敏感）。
 *
 * @param line - 已 trim 的节头行（以 [ 开头）
 * @param sectionLower - 目标节名（已转小写）
 * @param subsection - 目标子节名（大小写敏感）；无子节时为 null
 * @returns 若节头与目标匹配返回 true
 */
function matchesSectionHeader(
  line: string,
  sectionLower: string,
  subsection: string | null,
): boolean {
  // 从 [ 之后开始读取节名
  let i = 1

  // 读取节名：到 ]、空格、制表符或引号为止
  while (
    i < line.length &&
    line[i] !== ']' &&
    line[i] !== ' ' &&
    line[i] !== '\t' &&
    line[i] !== '"'
  ) {
    i++
  }
  const foundSection = line.slice(1, i).toLowerCase() // 提取节名并转小写

  if (foundSection !== sectionLower) {
    return false // 节名不匹配
  }

  if (subsection === null) {
    // 简单节（无子节）：节名之后必须紧跟 ]
    return i < line.length && line[i] === ']'
  }

  // 跳过节名与子节引号之间的空白
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    i++
  }

  // 子节名必须以双引号开始
  if (i >= line.length || line[i] !== '"') {
    return false
  }
  i++ // 跳过开头双引号

  // 读取子节名：大小写敏感，支持 \\ 和 \" 转义
  let foundSubsection = ''
  while (i < line.length && line[i] !== '"') {
    if (line[i] === '\\' && i + 1 < line.length) {
      const next = line[i + 1]!
      if (next === '\\' || next === '"') {
        foundSubsection += next // 转义字符：保留实际字符
        i += 2
        continue
      }
      // git 对其他转义丢弃反斜杠，保留后续字符
      foundSubsection += next
      i += 2
      continue
    }
    foundSubsection += line[i]
    i++
  }

  // 子节名之后必须有结束双引号，再跟 ]
  if (i >= line.length || line[i] !== '"') {
    return false
  }
  i++ // 跳过结束双引号

  if (i >= line.length || line[i] !== ']') {
    return false
  }

  return foundSubsection === subsection // 大小写敏感比较子节名
}

/**
 * 判断字符是否为 git 配置键名的合法字符。
 * git 规范：键名由字母、数字和连字符组成。
 *
 * @param ch - 单个字符
 * @returns 若为合法键名字符返回 true
 */
function isKeyChar(ch: string): boolean {
  return (
    (ch >= 'a' && ch <= 'z') || // 小写字母
    (ch >= 'A' && ch <= 'Z') || // 大写字母
    (ch >= '0' && ch <= '9') || // 数字
    ch === '-'                   // 连字符
  )
}
