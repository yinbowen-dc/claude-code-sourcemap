/**
 * UUID 验证与 Agent ID 生成工具模块。
 *
 * 在 Claude Code 系统流程中的位置：
 * 此模块是标识符管理层的基础工具，被 Agent 系统、任务跟踪、
 * 以及需要唯一标识符的各类模块调用。
 *
 * 主要功能：
 * - validateUuid：验证字符串是否符合标准 UUID 格式（8-4-4-4-12 十六进制）
 * - createAgentId：生成带前缀的 Agent ID（格式：a{label-}{16 hex 字符}）
 *
 * 安全性：
 * - 使用 crypto.randomBytes 生成密码学安全的随机字节
 */

import { randomBytes, type UUID } from 'crypto'
import type { AgentId } from 'src/types/ids.js'

// UUID 格式正则：8-4-4-4-12 十六进制数字，大小写均可（i 标志）
const uuidRegex =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 验证值是否为有效的 UUID 格式字符串。
 *
 * 流程：
 * 1. 检查输入是否为字符串类型，非字符串直接返回 null
 * 2. 用正则测试是否符合标准 UUID 格式（8-4-4-4-12 十六进制）
 * 3. 匹配则以 UUID 类型返回，否则返回 null
 *
 * @param maybeUUID 待验证的值
 * @returns 有效则返回类型为 UUID 的字符串，无效则返回 null
 */
export function validateUuid(maybeUuid: unknown): UUID | null {
  // UUID 格式：8-4-4-4-12 十六进制数字
  if (typeof maybeUuid !== 'string') return null

  // 正则测试：符合格式则断言为 UUID 类型
  return uuidRegex.test(maybeUuid) ? (maybeUuid as UUID) : null
}

/**
 * 生成带前缀的新 Agent ID，与任务 ID 格式保持一致。
 * 格式：a{label-}{16 hex 字符}
 * 示例：aa3f2c1b4d5e6f7a8，acompact-a3f2c1b4d5e6f7a8
 *
 * 流程：
 * 1. 生成 8 个密码学安全随机字节，转为 16 个十六进制字符
 * 2. 若提供 label，格式为 a{label}-{suffix}
 * 3. 否则格式为 a{suffix}
 *
 * @param label 可选的标签前缀（用于区分不同类型的 Agent）
 * @returns 唯一的 AgentId 字符串
 */
export function createAgentId(label?: string): AgentId {
  // randomBytes(8) 生成 8 字节随机数，hex 编码为 16 个字符
  const suffix = randomBytes(8).toString('hex')
  // 有标签时加入 label- 前缀；无标签时直接附加 suffix
  return (label ? `a${label}-${suffix}` : `a${suffix}`) as AgentId
}
