/**
 * 【文件定位】通用工具层 — 临时文件路径生成器
 *
 * 在 Claude Code 系统流程中的位置：
 *   各工具（BashTool、GitBundleTool 等）在需要写入临时数据时调用本模块，
 *   生成一个位于操作系统临时目录的唯一路径字符串（只生成路径，不创建文件）。
 *
 * 主要职责：
 *   generateTempFilePath() — 生成临时文件路径，支持两种 ID 生成策略：
 *     1. 随机 UUID（默认）：每次调用都产生不同的路径，适合普通临时文件
 *     2. 内容哈希（contentHash 选项）：对给定内容取 SHA-256 前 16 位十六进制
 *        作为 ID，从而使路径在进程间保持稳定——相同内容永远得到相同路径。
 *        这对于写入 Anthropic API 请求（如工具描述中的沙箱拒绝列表）非常重要：
 *        若使用随机 UUID，每次子进程启动都会生成不同路径，导致 prompt cache 前缀失效。
 */

import { createHash, randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * 生成一个临时文件路径（不创建实际文件）。
 *
 * 路径格式：<系统临时目录>/<prefix>-<id><extension>
 * 例如：/tmp/claude-prompt-550e8400-e29b-41d4-a716-446655440000.md
 *
 * @param prefix       文件名前缀，默认为 'claude-prompt'
 * @param extension    文件扩展名（含点号），默认为 '.md'
 * @param options.contentHash
 *   若提供此字符串，则使用其 SHA-256 哈希的前 16 位十六进制字符作为 ID。
 *   这可使路径在拥有相同内容的不同进程间保持稳定，
 *   防止因路径随机变化而破坏 Anthropic API 的 prompt cache 前缀匹配。
 * @returns 拼接好的临时文件绝对路径字符串
 */
export function generateTempFilePath(
  prefix: string = 'claude-prompt',
  extension: string = '.md',
  options?: { contentHash?: string },
): string {
  // 根据是否提供 contentHash 选择 ID 生成策略
  const id = options?.contentHash
    ? createHash('sha256')          // 使用 SHA-256 哈希算法
        .update(options.contentHash) // 对传入内容进行哈希
        .digest('hex')               // 输出十六进制字符串（64 字符）
        .slice(0, 16)                // 仅取前 16 字符，足够唯一且路径较短
    : randomUUID()                   // 无 contentHash 时使用随机 UUID（v4）

  // 将系统临时目录、前缀、ID 和扩展名拼成完整路径
  return join(tmpdir(), `${prefix}-${id}${extension}`)
}
