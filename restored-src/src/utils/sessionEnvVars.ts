/**
 * 会话级自定义环境变量存储模块
 *
 * 在 Claude Code 系统中的位置：
 * /env 命令处理层 → 子进程环境变量注入 → sessionEnvVars
 *
 * 主要功能：
 * 维护一个会话范围内的环境变量 Map，通过 /env 命令设置的变量
 * 仅在 Bash 工具启动子进程时注入，不影响 Claude Code 进程本身的 process.env。
 *
 * 注意：此模块与 sessionEnvironment.ts（Shell 脚本合并）是不同机制，
 * sessionEnvVars 是用户通过 /env 手动设置的键值对，
 * sessionEnvironment 是 Hook 脚本中 export 的变量。
 */

// 会话范围的环境变量存储（键值对形式，仅用于子进程注入）
const sessionEnvVars = new Map<string, string>()

/**
 * 获取只读的会话环境变量 Map
 *
 * 返回类型为 ReadonlyMap，防止外部代码直接修改 Map，
 * 所有修改必须通过 setSessionEnvVar / deleteSessionEnvVar / clearSessionEnvVars 进行。
 *
 * @returns 只读的会话环境变量映射
 */
export function getSessionEnvVars(): ReadonlyMap<string, string> {
  return sessionEnvVars
}

/**
 * 设置（或更新）会话环境变量
 *
 * @param name  - 环境变量名称（如 "MY_API_KEY"）
 * @param value - 环境变量值
 */
export function setSessionEnvVar(name: string, value: string): void {
  sessionEnvVars.set(name, value)
}

/**
 * 删除指定的会话环境变量
 *
 * @param name - 要删除的环境变量名称
 */
export function deleteSessionEnvVar(name: string): void {
  sessionEnvVars.delete(name)
}

/**
 * 清空所有会话环境变量
 *
 * 通常在会话重置或 /env --clear 命令时调用。
 */
export function clearSessionEnvVars(): void {
  sessionEnvVars.clear()
}
