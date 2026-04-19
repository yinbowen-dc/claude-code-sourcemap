/**
 * taggedId.ts — Tagged ID 编码工具模块
 *
 * 在 Claude Code 系统流程中的位置：
 *   基础工具层。将 UUID 字符串编码为与后端 API 兼容的 Tagged ID 格式，
 *   用于账号 ID、组织 ID 等需要与服务端 tagged_id.py 互通的场景。
 *
 * 主要职责：
 *   1. 实现与 api/api/common/utils/tagged_id.py 兼容的编码逻辑；
 *   2. 将 128 位 UUID 转换为 Base58 编码字符串；
 *   3. 生成格式为 "{tag}_{version}{base58(uuid)}" 的 Tagged ID。
 *
 * 输出示例："user_01PaGUP2rbg1XDh7Z9W1CEpd"
 */

/** Base58 编码使用的字符集（去除易混淆字符 0、O、I、l） */
const BASE_58_CHARS =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Tagged ID 的版本前缀（与后端保持同步） */
const VERSION = '01'

/**
 * Base58 编码后的固定长度：ceil(128 / log2(58)) = 22 位
 * 保证任意 128 位整数编码结果长度一致，无需填充
 */
const ENCODED_LENGTH = 22

/**
 * 将 128 位无符号整数编码为固定长度的 Base58 字符串。
 *
 * 执行流程：
 *   1. 初始化长度为 ENCODED_LENGTH 的结果数组，默认填充 Base58 字符集的第一个字符；
 *   2. 从右向左依次计算 n 对 58 取模的余数，映射到 BASE_58_CHARS 对应字符；
 *   3. 循环直至 n 归零，剩余位置保持首字符（相当于左补零）；
 *   4. 返回拼接后的固定长度字符串。
 *
 * @param n - 128 位无符号整数（以 BigInt 表示）
 * @returns 长度恰好为 ENCODED_LENGTH 的 Base58 字符串
 */
function base58Encode(n: bigint): string {
  const base = BigInt(BASE_58_CHARS.length)
  // 初始化为全首字符（相当于数字意义上的"前导零"）
  const result = new Array<string>(ENCODED_LENGTH).fill(BASE_58_CHARS[0]!)
  let i = ENCODED_LENGTH - 1
  let value = n
  while (value > 0n) {
    // 取余数作为当前最低位的 Base58 数字
    const rem = Number(value % base)
    result[i] = BASE_58_CHARS[rem]!
    value = value / base
    i--
  }
  return result.join('')
}

/**
 * 将 UUID 字符串（有无连字符均可）解析为 128 位 BigInt。
 *
 * 执行流程：
 *   1. 去除 UUID 中的所有连字符，得到 32 位十六进制字符串；
 *   2. 验证长度恰好为 32（128 位）；
 *   3. 以 "0x" 前缀将十六进制字符串转换为 BigInt。
 *
 * @param uuid - UUID 字符串（含或不含连字符）
 * @returns 对应的 128 位 BigInt
 * @throws 若 UUID 格式不正确则抛出错误
 */
function uuidToBigInt(uuid: string): bigint {
  // 去除 UUID 中的所有连字符（兼容 "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" 格式）
  const hex = uuid.replace(/-/g, '')
  if (hex.length !== 32) {
    throw new Error(`Invalid UUID hex length: ${hex.length}`)
  }
  return BigInt('0x' + hex)
}

/**
 * 将账号 UUID 转换为 API 格式的 Tagged ID。
 *
 * 执行流程：
 *   1. 调用 uuidToBigInt() 将 UUID 解析为 128 位整数；
 *   2. 调用 base58Encode() 将整数编码为 Base58 字符串；
 *   3. 拼接 "{tag}_{VERSION}{base58}" 并返回。
 *
 * @param tag  - 标签前缀（例如 "user"、"org"）
 * @param uuid - UUID 字符串（含或不含连字符）
 * @returns 格式为 "user_01PaGUP2rbg1XDh7Z9W1CEpd" 的 Tagged ID 字符串
 */
export function toTaggedId(tag: string, uuid: string): string {
  const n = uuidToBigInt(uuid)
  return `${tag}_${VERSION}${base58Encode(n)}`
}
