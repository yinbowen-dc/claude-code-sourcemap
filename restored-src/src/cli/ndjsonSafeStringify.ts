/**
 * NDJSON 安全序列化工具 — 处理 JSON 输出中的 JavaScript 行终止符转义。
 *
 * 在整个 Claude Code 系统中的位置：
 * 本文件被 StructuredIO、RemoteIO 等所有通过 stdin/stdout 或远程传输
 * 发送 SDK 消息的代码路径使用。NDJSON（换行分隔 JSON）要求每条消息必须
 * 严格占一行；若消息内容含有 U+2028/U+2029 字符，部分接收方会将其
 * 视为换行符，导致 JSON 被截断并丢失，本文件负责在序列化阶段消除该风险。
 */
import { jsonStringify } from '../utils/slowOperations.js'

// JSON.stringify emits U+2028/U+2029 raw (valid per ECMA-404). When the
// output is a single NDJSON line, any receiver that uses JavaScript
// line-terminator semantics (ECMA-262 §11.3 — \n \r U+2028 U+2029) to
// split the stream will cut the JSON mid-string. ProcessTransport now
// silently skips non-JSON lines rather than crashing (gh-28405), but
// the truncated fragment is still lost — the message is silently dropped.
//
// The \uXXXX form is equivalent JSON (parses to the same string) but
// can never be mistaken for a line terminator by ANY receiver. This is
// what ES2019's "Subsume JSON" proposal and Node's util.inspect do.
//
// Single regex with alternation: the callback's one dispatch per match
// is cheaper than two full-string scans.
// 使用单一正则匹配两种行终止符，一次遍历完成替换，比两次 replace 效率更高
const JS_LINE_TERMINATORS = /\u2028|\u2029/g

/**
 * 将 JSON 字符串中的 JavaScript 行终止符转义为 \uXXXX 形式。
 *
 * 流程：对已序列化的 JSON 字符串执行正则替换，
 * U+2028 → `\u2028`，U+2029 → `\u2029`。
 * 转义后的字符串与原始字符串在 JSON 语义上等价，但不会被任何接收方误判为换行。
 */
function escapeJsLineTerminators(json: string): string {
  return json.replace(JS_LINE_TERMINATORS, c =>
    // 根据匹配到的字符决定输出对应的 Unicode 转义序列
    c === '\u2028' ? '\\u2028' : '\\u2029',
  )
}

/**
 * 适用于"每行一条消息"传输格式的 JSON 序列化函数。
 *
 * 流程：先调用 jsonStringify 将值序列化为标准 JSON 字符串，
 * 再通过 escapeJsLineTerminators 转义 U+2028 LINE SEPARATOR 和
 * U+2029 PARAGRAPH SEPARATOR，确保序列化结果不会被行分割型接收方截断。
 * 输出仍是合法 JSON，解析结果与原始值完全相同。
 */
export function ndjsonSafeStringify(value: unknown): string {
  // 先序列化再转义，保证 NDJSON 流的单行完整性
  return escapeJsLineTerminators(jsonStringify(value))
}
