/**
 * Shell 命令输出长度上限配置模块。
 *
 * 在 Claude Code 系统中，该模块位于 Shell 执行管道最上层，
 * 定义 Bash 工具输出字节数的上限常量，并提供从环境变量动态读取
 * 用户自定义上限的函数。
 *
 * 配置优先级：环境变量 BASH_MAX_OUTPUT_LENGTH > 默认值（30,000 字节）
 * 硬上限为 150,000 字节，防止过大输出撑爆 Token 上下文。
 *
 * 主要导出：
 * - `BASH_MAX_OUTPUT_UPPER_LIMIT`：硬性上限（150,000 字节）
 * - `BASH_MAX_OUTPUT_DEFAULT`：默认上限（30,000 字节）
 * - `getMaxOutputLength()`：读取环境变量，返回有效值
 */
import { validateBoundedIntEnvVar } from '../envValidation.js'

/** 输出字节数的硬性上限（150,000 字节），不可被环境变量超越 */
export const BASH_MAX_OUTPUT_UPPER_LIMIT = 150_000

/** 输出字节数的默认上限（30,000 字节） */
export const BASH_MAX_OUTPUT_DEFAULT = 30_000

/**
 * 读取环境变量 BASH_MAX_OUTPUT_LENGTH，返回经过校验的有效输出上限（字节数）。
 *
 * - 若环境变量未设置或无效，则回退到默认值（30,000）
 * - 若环境变量超过硬性上限（150,000），则钳制为上限值
 *
 * @returns 有效的最大输出字节数
 */
export function getMaxOutputLength(): number {
  // 通过通用有界整数校验器读取环境变量，自动处理缺失、非数字、越界情况
  const result = validateBoundedIntEnvVar(
    'BASH_MAX_OUTPUT_LENGTH',
    process.env.BASH_MAX_OUTPUT_LENGTH,
    BASH_MAX_OUTPUT_DEFAULT,
    BASH_MAX_OUTPUT_UPPER_LIMIT,
  )
  // 返回校验后的有效值（effective = 实际生效的数值）
  return result.effective
}
