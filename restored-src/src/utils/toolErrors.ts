/**
 * 【文件定位】工具执行层 — 错误格式化与 Zod 验证错误处理
 *
 * 在 Claude Code 系统流程中的位置：
 *   工具执行出错（Bash 命令失败、参数校验不通过）
 *     → 本模块将原始 Error 对象转换为 LLM 友好的字符串消息
 *     → 格式化后的字符串作为工具结果返回给 LLM，引导其修正错误
 *
 * 主要职责：
 *   1. formatError()            — 将任意 error 转为字符串，截断超长内容（上限 10000 字符）
 *   2. getErrorParts()          — 从 ShellError 中提取 exitCode / stderr / stdout 各部分
 *   3. formatZodValidationError() — 将 Zod 校验错误转为分类清晰的 LLM 错误提示：
 *      - 缺少必填参数：`The required parameter \`xxx\` is missing`
 *      - 多余参数：`An unexpected parameter \`xxx\` was provided`
 *      - 类型不匹配：`The parameter \`xxx\` type is expected as \`yyy\` but provided as \`zzz\``
 *   4. formatValidationPath()  — 将 Zod 路径数组（如 ['todos', 0, 'status']）转为点路径字符串
 */

import type { ZodError } from 'zod/v4'
import { AbortError, ShellError } from './errors.js'
import { INTERRUPT_MESSAGE_FOR_TOOL_USE } from './messages.js'

/**
 * 将任意错误值格式化为字符串，适合作为工具结果返回给 LLM。
 *
 * 处理逻辑：
 *   1. AbortError → 返回错误消息或中断提示常量（告知 LLM 操作被用户中断）
 *   2. 非 Error 对象 → String() 转换
 *   3. Error 对象 → getErrorParts() 提取各部分，拼合后截断超长内容
 *      截断策略：保留头 5000 字符 + 尾 5000 字符，中间标注被截断的字符数
 *
 * @param error 任意错误值
 * @returns LLM 可读的错误字符串
 */
export function formatError(error: unknown): string {
  if (error instanceof AbortError) {
    // AbortError 表示用户手动中断，返回专用提示消息
    return error.message || INTERRUPT_MESSAGE_FOR_TOOL_USE
  }
  if (!(error instanceof Error)) {
    // 非标准 Error 类型（如字符串或数字被当作错误抛出）
    return String(error)
  }
  const parts = getErrorParts(error)
  const fullMessage =
    parts.filter(Boolean).join('\n').trim() || 'Command failed with no output'
  if (fullMessage.length <= 10000) {
    return fullMessage
  }
  // 超过 10000 字符时，取头尾各 5000 字符，避免超大错误输出淹没上下文
  const halfLength = 5000
  const start = fullMessage.slice(0, halfLength)
  const end = fullMessage.slice(-halfLength)
  return `${start}\n\n... [${fullMessage.length - 10000} characters truncated] ...\n\n${end}`
}

/**
 * 从 Error 对象中提取各错误组成部分，返回字符串数组。
 *
 * ShellError 包含退出码、中断标志、stderr、stdout 四个字段；
 * 普通 Error 仅有 message，但某些子类（如 spawn 错误）可能额外挂载 stderr/stdout。
 *
 * @param error Error 实例
 * @returns 字符串数组，过滤空值后即可拼合为完整错误信息
 */
export function getErrorParts(error: Error): string[] {
  if (error instanceof ShellError) {
    return [
      `Exit code ${error.code}`,
      // 若操作被中断（超时或用户中止），追加中断提示
      error.interrupted ? INTERRUPT_MESSAGE_FOR_TOOL_USE : '',
      error.stderr,
      error.stdout,
    ]
  }
  const parts = [error.message]
  if ('stderr' in error && typeof error.stderr === 'string') {
    parts.push(error.stderr)
  }
  if ('stdout' in error && typeof error.stdout === 'string') {
    parts.push(error.stdout)
  }
  return parts
}

/**
 * 将 Zod 校验路径数组转换为可读的点路径字符串。
 *
 * 转换规则：
 *   - 首段直接使用（无前缀点）
 *   - 后续字符串段以 '.' 连接
 *   - 数字段（数组索引）以 '[n]' 包裹
 *
 * 示例：['todos', 0, 'activeForm'] → 'todos[0].activeForm'
 */
function formatValidationPath(path: PropertyKey[]): string {
  if (path.length === 0) return ''

  return path.reduce((acc, segment, index) => {
    const segmentStr = String(segment)
    if (typeof segment === 'number') {
      // 数组索引格式：[0]、[1] 等
      return `${String(acc)}[${segmentStr}]`
    }
    // 首段不加前缀点，后续段加点分隔符
    return index === 0 ? segmentStr : `${String(acc)}.${segmentStr}`
  }, '') as string
}

/**
 * 将 Zod 验证错误转换为 LLM 友好的结构化错误消息。
 *
 * 分类策略：
 *   1. 缺少必填参数  — invalid_type 且消息含 "received undefined"
 *   2. 未知/多余参数 — unrecognized_keys
 *   3. 类型不匹配   — invalid_type 但不是 undefined（如传了字符串代替数字）
 *
 * 若无法归类（Zod 原始错误信息即可），直接返回 error.message。
 *
 * @param toolName 工具名称（用于错误消息前缀）
 * @param error    Zod ZodError 对象
 * @returns 格式化后的错误字符串
 */
export function formatZodValidationError(
  toolName: string,
  error: ZodError,
): string {
  // 筛选缺少必填参数的错误（received undefined 表示该字段完全未提供）
  const missingParams = error.issues
    .filter(
      err =>
        err.code === 'invalid_type' &&
        err.message.includes('received undefined'),
    )
    .map(err => formatValidationPath(err.path))

  // 筛选未预期/多余的参数（LLM 传入了 schema 中不存在的字段）
  const unexpectedParams = error.issues
    .filter(err => err.code === 'unrecognized_keys')
    .flatMap(err => err.keys)

  // 筛选类型不匹配的错误（传入了错误类型，如期望 number 但传入了 string）
  const typeMismatchParams = error.issues
    .filter(
      err =>
        err.code === 'invalid_type' &&
        !err.message.includes('received undefined'),
    )
    .map(err => {
      const typeErr = err as { expected: string }
      const receivedMatch = err.message.match(/received (\w+)/)
      const received = receivedMatch ? receivedMatch[1] : 'unknown'
      return {
        param: formatValidationPath(err.path),
        expected: typeErr.expected,
        received,
      }
    })

  // 默认回退：使用原始 Zod 错误消息
  let errorContent = error.message

  // 构建结构化的人类可读错误消息列表
  const errorParts = []

  if (missingParams.length > 0) {
    const missingParamErrors = missingParams.map(
      param => `The required parameter \`${param}\` is missing`,
    )
    errorParts.push(...missingParamErrors)
  }

  if (unexpectedParams.length > 0) {
    const unexpectedParamErrors = unexpectedParams.map(
      param => `An unexpected parameter \`${param}\` was provided`,
    )
    errorParts.push(...unexpectedParamErrors)
  }

  if (typeMismatchParams.length > 0) {
    const typeErrors = typeMismatchParams.map(
      ({ param, expected, received }) =>
        `The parameter \`${param}\` type is expected as \`${expected}\` but provided as \`${received}\``,
    )
    errorParts.push(...typeErrors)
  }

  // 若有具体分类的错误，拼合为带工具名前缀的完整错误消息
  if (errorParts.length > 0) {
    errorContent = `${toolName} failed due to the following ${errorParts.length > 1 ? 'issues' : 'issue'}:\n${errorParts.join('\n')}`
  }

  return errorContent
}
