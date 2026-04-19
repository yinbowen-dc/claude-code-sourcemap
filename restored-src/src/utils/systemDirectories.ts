/**
 * 跨平台系统目录解析模块（systemDirectories.ts）
 *
 * 【在 Claude Code 系统流程中的位置】
 * 本模块属于 Claude Code 的平台适配层，为上层工具（文件浏览、路径补全等）
 * 提供当前用户的标准系统目录（HOME、Desktop、Documents、Downloads）的
 * 规范化路径。它对 Windows、macOS、Linux 和 WSL（Windows Subsystem for Linux）
 * 的目录约定差异进行了统一抽象。
 *
 * 【主要职责】
 * 1. 根据当前平台选择正确的目录解析策略；
 * 2. Windows：优先使用 USERPROFILE 环境变量（适应本地化路径名）；
 * 3. Linux / WSL：优先遵循 XDG Base Directory 规范（尊重用户自定义路径）；
 * 4. macOS 及未知平台：使用标准 ~/Desktop、~/Documents、~/Downloads 路径。
 */

import { homedir } from 'os'
import { join } from 'path'
import { logForDebugging } from './debug.js'
import { getPlatform, type Platform } from './platform.js'

/** 标准系统目录的键值对类型。索引签名用于与 Record<string, string> 兼容。 */
export type SystemDirectories = {
  HOME: string
  DESKTOP: string
  DOCUMENTS: string
  DOWNLOADS: string
  [key: string]: string // 索引签名，兼容 Record<string, string> 的泛型使用场景
}

/** 环境变量字典类型，供测试注入使用 */
type EnvLike = Record<string, string | undefined>

/** 可选的覆盖选项，主要供单元测试注入虚拟环境 */
type SystemDirectoriesOptions = {
  env?: EnvLike      // 覆盖 process.env
  homedir?: string   // 覆盖 os.homedir()
  platform?: Platform // 覆盖 getPlatform()
}

/**
 * 获取当前用户的跨平台标准系统目录。
 *
 * 【执行流程】
 * 1. 读取平台类型、用户主目录和环境变量（优先使用传入的覆盖值）；
 * 2. 构建适用于大多数平台的默认路径（~/Desktop 等）；
 * 3. 按平台分支处理：
 *    - windows：读取 USERPROFILE 环境变量，适应本地化目录名（如"桌面"）；
 *    - linux / wsl：读取 XDG_DESKTOP_DIR 等 XDG 变量，回退到默认路径；
 *    - macos / unknown：直接使用默认路径，unknown 平台额外打印调试日志。
 *
 * @param options - 可选覆盖参数，方便测试不同平台/环境场景
 * @returns 包含 HOME、DESKTOP、DOCUMENTS、DOWNLOADS 的目录对象
 */
export function getSystemDirectories(
  options?: SystemDirectoriesOptions,
): SystemDirectories {
  // 优先使用传入覆盖值，否则使用真实运行时值
  const platform = options?.platform ?? getPlatform()
  const homeDir = options?.homedir ?? homedir()
  const env = options?.env ?? process.env

  // 大多数平台适用的默认路径（使用 Node.js path.join 保证分隔符正确）
  const defaults: SystemDirectories = {
    HOME: homeDir,
    DESKTOP: join(homeDir, 'Desktop'),
    DOCUMENTS: join(homeDir, 'Documents'),
    DOWNLOADS: join(homeDir, 'Downloads'),
  }

  switch (platform) {
    case 'windows': {
      // Windows 系统：USERPROFILE 通常与 homedir() 相同，但对于域账户或
      // 本地化系统（如中文 Windows）可能有路径差异，优先使用 USERPROFILE
      const userProfile = env.USERPROFILE || homeDir
      return {
        HOME: homeDir,
        DESKTOP: join(userProfile, 'Desktop'),
        DOCUMENTS: join(userProfile, 'Documents'),
        DOWNLOADS: join(userProfile, 'Downloads'),
      }
    }

    case 'linux':
    case 'wsl': {
      // Linux / WSL：遵循 XDG Base Directory 规范
      // 用户可通过 ~/.config/user-dirs.dirs 自定义这些目录
      // 若未设置 XDG 变量，回退到默认的 ~/Desktop 等路径
      return {
        HOME: homeDir,
        DESKTOP: env.XDG_DESKTOP_DIR || defaults.DESKTOP,
        DOCUMENTS: env.XDG_DOCUMENTS_DIR || defaults.DOCUMENTS,
        DOWNLOADS: env.XDG_DOWNLOAD_DIR || defaults.DOWNLOADS,
      }
    }

    case 'macos':
    default: {
      // macOS 使用标准英文目录名，不受系统语言影响
      // 未知平台打印调试信息但仍提供默认路径（graceful degradation）
      if (platform === 'unknown') {
        logForDebugging(`Unknown platform detected, using default paths`)
      }
      return defaults
    }
  }
}
