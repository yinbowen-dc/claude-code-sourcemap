/**
 * 会话环境脚本加载模块
 *
 * 在 Claude Code 系统中的位置：
 * Shell 工具执行层 → 子进程环境变量准备 → sessionEnvironment
 *
 * 主要功能：
 * 汇聚多个来源的 Shell 环境脚本，形成一个合并后的脚本字符串，
 * 在每次 Bash 工具启动子 shell 时被 source，以保持 venv/conda 激活等状态
 * 跨 shell 命令持久化。
 *
 * 脚本来源（按优先级排列）：
 * 1. CLAUDE_ENV_FILE 环境变量指向的文件（来自父进程，如 HFI 轨迹运行器）
 * 2. 各 Hook 事件写入会话目录下的 .sh 文件：
 *    - setup-hook-N.sh（优先级 0，最高）
 *    - sessionstart-hook-N.sh（优先级 1）
 *    - cwdchanged-hook-N.sh（优先级 2）
 *    - filechanged-hook-N.sh（优先级 3）
 *
 * 缓存策略（三态）：
 * - undefined：尚未从磁盘加载（初始状态）
 * - null：已检查磁盘，不存在任何脚本文件（避免重复 I/O）
 * - string：已加载并缓存好的脚本字符串
 */

import { mkdir, readdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getSessionId } from '../bootstrap/state.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { errorMessage, getErrnoCode } from './errors.js'
import { getPlatform } from './platform.js'

// 三态缓存：undefined = 未加载，null = 无脚本，string = 已缓存脚本内容
let sessionEnvScript: string | null | undefined = undefined

/**
 * 获取当前会话的环境脚本存储目录路径
 *
 * 路径格式：{claudeConfigHomeDir}/session-env/{sessionId}/
 * 目录不存在时自动创建（recursive: true）。
 *
 * @returns 会话环境目录的绝对路径
 */
export async function getSessionEnvDirPath(): Promise<string> {
  const sessionEnvDir = join(
    getClaudeConfigHomeDir(),
    'session-env',
    getSessionId(),
  )
  // 确保目录存在，不存在则递归创建
  await mkdir(sessionEnvDir, { recursive: true })
  return sessionEnvDir
}

/**
 * 获取特定 Hook 事件对应的环境脚本文件路径
 *
 * 文件名格式：{hookEvent小写}-hook-{hookIndex}.sh
 * 例如：sessionstart-hook-0.sh、cwdchanged-hook-1.sh
 *
 * @param hookEvent - Hook 事件类型（Setup/SessionStart/CwdChanged/FileChanged）
 * @param hookIndex - 同类 Hook 在配置中的序号（用于多个同类 Hook 的确定性排序）
 * @returns 对应 .sh 文件的绝对路径
 */
export async function getHookEnvFilePath(
  hookEvent: 'Setup' | 'SessionStart' | 'CwdChanged' | 'FileChanged',
  hookIndex: number,
): Promise<string> {
  const prefix = hookEvent.toLowerCase()
  return join(await getSessionEnvDirPath(), `${prefix}-hook-${hookIndex}.sh`)
}

/**
 * 清空 CwdChanged 和 FileChanged 类型的 Hook 环境文件
 *
 * 工作目录切换时调用，将两类"位置相关" Hook 的环境文件清空（写入空字符串），
 * 使其不再影响后续的子进程环境。
 *
 * 函数流程：
 * 1. 获取会话环境目录
 * 2. 读取目录中所有文件
 * 3. 筛选出以 cwdchanged-hook- 或 filechanged-hook- 开头且匹配正则的文件
 * 4. 并发地将它们清空（写入 ''）
 * 5. ENOENT 错误静默忽略（目录不存在时正常）
 */
export async function clearCwdEnvFiles(): Promise<void> {
  try {
    const dir = await getSessionEnvDirPath()
    const files = await readdir(dir)
    await Promise.all(
      files
        .filter(
          f =>
            (f.startsWith('filechanged-hook-') ||
              f.startsWith('cwdchanged-hook-')) &&
            HOOK_ENV_REGEX.test(f),
        )
        .map(f => writeFile(join(dir, f), '')),
    )
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    // 目录不存在时（ENOENT）静默，其他错误才记录日志
    if (code !== 'ENOENT') {
      logForDebugging(`Failed to clear cwd env files: ${errorMessage(e)}`)
    }
  }
}

/**
 * 使环境脚本缓存失效，强制下次调用 getSessionEnvironmentScript 时重新从磁盘加载
 *
 * 在 Hook 执行完毕并写入新的 .sh 文件后调用，确保下次 Bash 执行能获取最新脚本。
 */
export function invalidateSessionEnvCache(): void {
  logForDebugging('Invalidating session environment cache')
  // 重置为 undefined（"未加载"状态），触发下次的磁盘重读
  sessionEnvScript = undefined
}

/**
 * 获取合并后的会话环境脚本字符串
 *
 * 函数流程：
 * 1. Windows 平台直接返回 null（尚不支持）
 * 2. 检查三态缓存：非 undefined 时直接返回缓存值
 * 3. 若有 CLAUDE_ENV_FILE 环境变量，读取对应文件内容加入脚本列表
 * 4. 扫描会话目录下所有符合 HOOK_ENV_REGEX 的 .sh 文件，
 *    按 sortHookEnvFiles 排序后依次读取非空内容加入脚本列表
 * 5. 若脚本列表为空，缓存 null 并返回 null
 * 6. 将所有脚本用换行连接，缓存并返回
 *
 * @returns 合并后的 Shell 脚本字符串，无脚本时返回 null
 */
export async function getSessionEnvironmentScript(): Promise<string | null> {
  // Windows 不支持此功能
  if (getPlatform() === 'windows') {
    logForDebugging('Session environment not yet supported on Windows')
    return null
  }

  // 缓存命中：undefined 表示"未检查过"，null/"string" 表示已有结果
  if (sessionEnvScript !== undefined) {
    return sessionEnvScript
  }

  // 收集所有脚本片段
  const scripts: string[] = []

  // 来源一：CLAUDE_ENV_FILE 指向的文件（父进程传入，如 HFI 轨迹运行器）
  const envFile = process.env.CLAUDE_ENV_FILE
  if (envFile) {
    try {
      const envScript = (await readFile(envFile, 'utf8')).trim()
      if (envScript) {
        scripts.push(envScript)
        logForDebugging(
          `Session environment loaded from CLAUDE_ENV_FILE: ${envFile} (${envScript.length} chars)`,
        )
      }
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      // 文件不存在时静默，其他 I/O 错误记录日志
      if (code !== 'ENOENT') {
        logForDebugging(`Failed to read CLAUDE_ENV_FILE: ${errorMessage(e)}`)
      }
    }
  }

  // 来源二：会话目录下各 Hook 写入的 .sh 文件
  const sessionEnvDir = await getSessionEnvDirPath()
  try {
    const files = await readdir(sessionEnvDir)
    // 筛选出符合命名规范的 Hook 环境文件，并按 Hook 类型优先级 + 序号排序
    const hookFiles = files
      .filter(f => HOOK_ENV_REGEX.test(f))
      .sort(sortHookEnvFiles)

    for (const file of hookFiles) {
      const filePath = join(sessionEnvDir, file)
      try {
        const content = (await readFile(filePath, 'utf8')).trim()
        if (content) {
          scripts.push(content)
        }
      } catch (e: unknown) {
        const code = getErrnoCode(e)
        if (code !== 'ENOENT') {
          logForDebugging(
            `Failed to read hook file ${filePath}: ${errorMessage(e)}`,
          )
        }
      }
    }

    if (hookFiles.length > 0) {
      logForDebugging(
        `Session environment loaded from ${hookFiles.length} hook file(s)`,
      )
    }
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      logForDebugging(
        `Failed to load session environment from hooks: ${errorMessage(e)}`,
      )
    }
  }

  // 没有任何脚本：缓存 null，避免下次重复扫描
  if (scripts.length === 0) {
    logForDebugging('No session environment scripts found')
    sessionEnvScript = null
    return sessionEnvScript
  }

  // 将所有脚本片段用换行连接，形成最终合并脚本并缓存
  sessionEnvScript = scripts.join('\n')
  logForDebugging(
    `Session environment script ready (${sessionEnvScript.length} chars total)`,
  )
  return sessionEnvScript
}

/**
 * Hook 类型排序优先级映射
 * setup < sessionstart < cwdchanged < filechanged
 * 数值越小优先级越高（越先被 source）
 */
const HOOK_ENV_PRIORITY: Record<string, number> = {
  setup: 0,
  sessionstart: 1,
  cwdchanged: 2,
  filechanged: 3,
}

/** 匹配合法 Hook 环境文件名的正则表达式：{类型}-hook-{序号}.sh */
const HOOK_ENV_REGEX =
  /^(setup|sessionstart|cwdchanged|filechanged)-hook-(\d+)\.sh$/

/**
 * Hook 环境文件排序比较函数
 *
 * 排序规则：
 * 1. 优先按 Hook 类型排序（HOOK_ENV_PRIORITY 中的值越小越靠前）
 * 2. 同类型的 Hook 按序号（hookIndex）升序排序
 *
 * 目的：保证合并后的环境脚本顺序确定，setup 的激活环境先于 sessionstart 等。
 */
function sortHookEnvFiles(a: string, b: string): number {
  const aMatch = a.match(HOOK_ENV_REGEX)
  const bMatch = b.match(HOOK_ENV_REGEX)
  const aType = aMatch?.[1] || ''
  const bType = bMatch?.[1] || ''
  // 先按类型优先级排序
  if (aType !== bType) {
    return (HOOK_ENV_PRIORITY[aType] ?? 99) - (HOOK_ENV_PRIORITY[bType] ?? 99)
  }
  // 同类型再按序号排序
  const aIndex = parseInt(aMatch?.[2] || '0', 10)
  const bIndex = parseInt(bMatch?.[2] || '0', 10)
  return aIndex - bIndex
}
