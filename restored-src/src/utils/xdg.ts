/**
 * XDG 基础目录规范工具模块。
 *
 * 在 Claude Code 系统流程中的位置：
 * 此模块实现 XDG Base Directory Specification，为 Claude Code
 * 原生安装器（native installer）提供跨平台的目录路径解析。
 * 被安装、卸载、配置存储等需要定位系统标准目录的模块调用。
 *
 * 主要功能：
 * - getXDGStateHome：返回状态目录（默认 ~/.local/state）
 * - getXDGCacheHome：返回缓存目录（默认 ~/.cache）
 * - getXDGDataHome：返回数据目录（默认 ~/.local/share）
 * - getUserBinDir：返回用户可执行文件目录（默认 ~/.local/bin）
 * - 所有函数均接受 XDGOptions 以支持测试时覆盖环境变量和 home 目录
 *
 * @see https://specifications.freedesktop.org/basedir-spec/latest/
 */

import { homedir as osHomedir } from 'os'
import { join } from 'path'

// 环境变量字典类型，支持 undefined 值
type EnvLike = Record<string, string | undefined>

// XDG 函数的可选配置项：允许覆盖环境变量和 home 目录（主要用于测试）
type XDGOptions = {
  env?: EnvLike    // 覆盖环境变量来源（默认 process.env）
  homedir?: string // 覆盖 home 目录路径（默认 process.env.HOME 或 os.homedir()）
}

/**
 * 解析 XDGOptions 为标准化的 { env, home } 对象。
 *
 * 流程：
 * 1. 使用传入的 env，否则退回到 process.env
 * 2. 使用传入的 homedir，否则依次尝试 process.env.HOME 和 os.homedir()
 *
 * @param options 可选的环境和目录覆盖配置
 * @returns 标准化的 { env, home } 对象
 */
function resolveOptions(options?: XDGOptions): { env: EnvLike; home: string } {
  return {
    // 优先使用传入的 env，否则使用进程环境变量
    env: options?.env ?? process.env,
    // 优先使用传入的 homedir，否则使用 HOME 环境变量或 os.homedir()
    home: options?.homedir ?? process.env.HOME ?? osHomedir(),
  }
}

/**
 * 获取 XDG 状态目录路径。
 *
 * 流程：
 * 1. 解析 options 获取 env 和 home
 * 2. 若 XDG_STATE_HOME 环境变量已设置，则返回该值
 * 3. 否则返回默认路径 ~/.local/state
 *
 * @param options 可选的环境和目录覆盖配置
 * @returns 状态目录的绝对路径
 */
export function getXDGStateHome(options?: XDGOptions): string {
  const { env, home } = resolveOptions(options)
  // 优先读取环境变量 XDG_STATE_HOME，否则使用规范默认值
  return env.XDG_STATE_HOME ?? join(home, '.local', 'state')
}

/**
 * 获取 XDG 缓存目录路径。
 *
 * 流程：
 * 1. 解析 options 获取 env 和 home
 * 2. 若 XDG_CACHE_HOME 环境变量已设置，则返回该值
 * 3. 否则返回默认路径 ~/.cache
 *
 * @param options 可选的环境和目录覆盖配置
 * @returns 缓存目录的绝对路径
 */
export function getXDGCacheHome(options?: XDGOptions): string {
  const { env, home } = resolveOptions(options)
  // 优先读取环境变量 XDG_CACHE_HOME，否则使用规范默认值
  return env.XDG_CACHE_HOME ?? join(home, '.cache')
}

/**
 * 获取 XDG 数据目录路径。
 *
 * 流程：
 * 1. 解析 options 获取 env 和 home
 * 2. 若 XDG_DATA_HOME 环境变量已设置，则返回该值
 * 3. 否则返回默认路径 ~/.local/share
 *
 * @param options 可选的环境和目录覆盖配置
 * @returns 数据目录的绝对路径
 */
export function getXDGDataHome(options?: XDGOptions): string {
  const { env, home } = resolveOptions(options)
  // 优先读取环境变量 XDG_DATA_HOME，否则使用规范默认值
  return env.XDG_DATA_HOME ?? join(home, '.local', 'share')
}

/**
 * 获取用户可执行文件目录路径。
 * 非标准 XDG 目录，但遵循相同的 ~/.local/ 惯例。
 *
 * 流程：
 * 1. 解析 options 获取 home 目录
 * 2. 返回 ~/.local/bin（不受环境变量影响）
 *
 * @param options 可选的目录覆盖配置
 * @returns 用户 bin 目录的绝对路径
 */
export function getUserBinDir(options?: XDGOptions): string {
  const { home } = resolveOptions(options)
  // 始终使用 ~/.local/bin，无对应 XDG 环境变量
  return join(home, '.local', 'bin')
}
